/**
 * P4-2 phase 1: the one Code Map fetch every consumer uses — fetch,
 * normalize each Node's `file` to project-relative POSIX, then drop test
 * code (`test-code.ts`). `index.ts`'s map handler and Path Trace both call
 * it, so neither can see a test Node, a test edge, or a test file's hotspot.
 * P4-2 phase 3a: then fold Module Nodes into their file (`fold-modules.ts`),
 * so neither sees a Module Node or a Module's edge either.
 * P4-2 phase 3b: then fold Type/Interface Nodes into a side index by id
 * (`fold-types.ts`), so neither sees a type Node or a type edge.
 */
import type { FoldedModule, FoldedType } from '@driller/graph-contracts';

import { attachFoldedModuleLinks, foldModules } from './fold-modules';
import { attachTypeUses, foldTypes, splitModuleTypeUses } from './fold-types';
import { fetchCodeMap, type CodeMapFetchResult, type FetchCodeMapOptions } from './mcp-client';
import { toProjectRelativePosixPath } from './project-path';
import { attachTestedBy } from './tested-by';
import { excludeTestCode, isTestPath } from './test-code';

type FetchCodeMap = (project: string, timeoutMs?: number, options?: FetchCodeMapOptions) => Promise<CodeMapFetchResult>;

// Raw paths already warned about as outside the project root. Bounded so a
// pathological backend can't grow it without limit.
const warnedPaths = new Set<string>();
const MAX_WARNED_PATHS = 1000;

/** Warns about each distinct raw path once per process, not once per Node per fetch. */
function warnOncePerPath(rawPath: string, message: string): void {
  if (warnedPaths.has(rawPath)) {
    return;
  }
  if (warnedPaths.size < MAX_WARNED_PATHS) {
    warnedPaths.add(rawPath);
  }
  console.warn(message);
}

/**
 * Normalizes one backend path. Never throws: a path that can't be
 * normalized is passed through as-is, so one odd path can't fail the fetch.
 * An unnormalized absolute path stays safe to classify, since `isTestPath`
 * ignores directory segments of absolute paths.
 */
function normalizeFile(projectRoot: string, rawPath: string, context: string): string {
  try {
    return toProjectRelativePosixPath(projectRoot, rawPath, context, (message) => warnOncePerPath(rawPath, message));
  } catch (error) {
    warnOncePerPath(
      rawPath,
      `[graph-service] ${context} "${rawPath}" could not be normalized (${
        error instanceof Error ? error.message : String(error)
      }); passing it through as-is.`,
    );
    return rawPath;
  }
}

/** Options for `fetchProductionCodeMap`. */
export interface ProductionCodeMapOptions {
  /** The raw fetch; `fetchCodeMap` unless a test injects one. */
  fetch?: FetchCodeMap;
  /**
   * P4-2 phase 2: fetch test-link evidence and attach `testedBy` to the
   * production Nodes. Only the Code Map handler asks for it (its Nodes feed
   * Node detail and `lookup_node`); Path Trace doesn't need it.
   */
  includeTestedBy?: boolean;
  /**
   * P4-2 phase 3b: fetch `IMPLEMENTS` links for the folded types' "Implements"
   * row. Only the Code Map handler asks for it; Path Trace doesn't need it.
   */
  includeImplements?: boolean;
}

/** `fetchProductionCodeMap`'s result: the production map plus its folded Modules. */
export interface ProductionCodeMapResult extends CodeMapFetchResult {
  /** P4-2 phase 3a: the production files' folded Module Nodes, sorted by file (see `FoldedModule`). */
  foldedModules: FoldedModule[];
  /** P4-2 phase 3b: the production Type/Interface Nodes folded off the map, sorted by id (see `FoldedType`). */
  foldedTypes: FoldedType[];
}

/**
 * Fetches the Code Map for `project` with every Node's `file` project-
 * relative and all test code removed: test Nodes, edges touching them, and
 * test files' hotspot rows. With `includeTestedBy`, production Nodes carry
 * `testedBy`, resolved against the test Nodes before they are removed.
 * P4-2 phase 3a: production Module Nodes are then folded off the map
 * (`foldModules`) into `foldedModules`; Nodes carry the links as
 * `fileTopLevel` / `calledAtLoadBy` (unscoped: the Code Map handler re-scopes
 * them after its scope filter).
 * P4-2 phase 3b: then Type/Interface Nodes are folded off the map
 * (`foldTypes`) into `foldedTypes`, built only from real `USAGE` edges;
 * Nodes carry the types they use as `usesTypes` (unscoped, like above). A
 * folded Module's top-level use of a type moves from `uses` (which then
 * names only map Nodes) to `usesTypes`, and Nodes in that file carry it as
 * `fileTopLevelTypes`.
 * Throws whatever `fetchCodeMap` throws.
 */
export async function fetchProductionCodeMap(
  project: string,
  projectRoot: string,
  context: string,
  options: ProductionCodeMapOptions = {},
): Promise<ProductionCodeMapResult> {
  const fetch = options.fetch ?? fetchCodeMap;
  const includeTestEvidence = options.includeTestedBy === true;
  const includeImplements = options.includeImplements === true;
  const { nodes, edges, testEvidence, implementsLinks } = await fetch(project, undefined, {
    excludeFile: (file) => isTestPath(normalizeFile(projectRoot, file, `${context} hotspot file`)),
    ...(includeTestEvidence ? { includeTestEvidence } : {}),
    ...(includeImplements ? { includeImplements } : {}),
  });
  const normalizedNodes = nodes.map((node) => ({
    ...node,
    file: normalizeFile(projectRoot, node.file, `${context} node file`),
  }));
  const withTestedBy =
    includeTestEvidence && testEvidence !== undefined
      ? attachTestedBy(normalizedNodes, {
          calls: testEvidence.calls.map((call) => ({
            ...call,
            sourceFile: normalizeFile(projectRoot, call.sourceFile, `${context} test caller file`),
          })),
          testFiles: testEvidence.testFiles.map(({ testFile, file }) => ({
            testFile: normalizeFile(projectRoot, testFile, `${context} test file`),
            file: normalizeFile(projectRoot, file, `${context} tested file`),
          })),
        })
      : normalizedNodes;
  const production = excludeTestCode(withTestedBy, edges);
  const folded = foldModules(production.nodes, production.edges);
  const types = foldTypes(folded.nodes, folded.edges, implementsLinks ?? []);
  const foldedTypes = [...types.typesById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const foldedModules = splitModuleTypeUses(
    [...folded.modulesByFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    foldedTypes,
  );
  return {
    nodes: attachTypeUses(attachFoldedModuleLinks(types.nodes, foldedModules), foldedTypes),
    edges: types.edges,
    foldedModules,
    foldedTypes,
  };
}
