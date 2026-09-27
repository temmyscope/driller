/**
 * P4-2 phase 1: the one Code Map fetch every consumer uses — fetch,
 * normalize each Node's `file` to project-relative POSIX, then drop test
 * code (`test-code.ts`). `index.ts`'s map handler and Path Trace both call
 * it, so neither can see a test Node, a test edge, or a test file's hotspot.
 */
import { fetchCodeMap, type CodeMapFetchResult, type FetchCodeMapOptions } from './mcp-client';
import { toProjectRelativePosixPath } from './project-path';
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

/**
 * Fetches the Code Map for `project` with every Node's `file` project-
 * relative and all test code removed: test Nodes, edges touching them, and
 * test files' hotspot rows. Throws whatever `fetchCodeMap` throws.
 */
export async function fetchProductionCodeMap(
  project: string,
  projectRoot: string,
  context: string,
  fetch: FetchCodeMap = fetchCodeMap,
): Promise<CodeMapFetchResult> {
  const { nodes, edges } = await fetch(project, undefined, {
    excludeFile: (file) => isTestPath(normalizeFile(projectRoot, file, `${context} hotspot file`)),
  });
  return excludeTestCode(
    nodes.map((node) => ({ ...node, file: normalizeFile(projectRoot, node.file, `${context} node file`) })),
    edges,
  );
}
