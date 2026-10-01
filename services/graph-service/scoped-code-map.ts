/**
 * P4-4 phase 1a: the Code Map pipeline, extracted from `index.ts`'s
 * `handleGetCodeMapRequest` with no behaviour change, so the same steps can
 * run over any file set (the whole indexing scope today; one section later)
 * and be tested. Side-effect free on import, like `project-scope.ts`.
 *
 * `buildScopedCodeMap` runs, in this order (the order the handler always
 * used):
 *  1. `filterCodeMapToScope` — Nodes whose file is kept, edges between them;
 *  2. `scopeFoldedTypes`;
 *  3. `scopeFoldedModules` + `splitModuleTypeUses`;
 *  4. `attachFoldedModuleLinks` → `attachTypeUses` → `attachSimilar` (each
 *     re-derived from the scoped set, so nothing names an out-of-scope id);
 *  5. `annotateNodesWithSummaryState`;
 *  6. `buildBidirectionalAdjacency` (blast radius walks scoped edges only);
 *  7. `attachProjectRiskSignals` — severity cut over THIS file set, plus the
 *     LCOV `testCoverageAvailable` / `testCoverageHit` flags.
 * It never fetches and never awaits: everything it reads is in `RawCodeMap`
 * (plus the Node record store, through the injectable `getRecord`).
 */
import {
  buildBidirectionalAdjacency,
  type FoldedModule,
  type FoldedType,
  type SectionNodeCount,
} from '@driller/graph-contracts';
import type { CodeMapEdge, CodeMapNode } from '@driller/ipc-contracts';

import { attachFoldedModuleLinks, scopeFoldedModules } from './fold-modules';
import { attachTypeUses, scopeFoldedTypes, splitModuleTypeUses } from './fold-types';
import type { LcovReport } from './lcov';
import { getNodeRecord, type NodeRecord } from './node-record-store';
import type { ProductionCodeMapResult } from './production-code-map';
import { toProjectRelativePosixPath } from './project-path';
import { isFileInScope, sectionOfFile } from './project-scope';
import { attachProjectRiskSignals } from './risk-signals';
import { attachSimilar } from './similar';
import { annotateNodesWithSummaryState } from './summary-generator';

/** Whether a project-relative POSIX file is in the file set being mapped. */
export type KeepFile = (posixFile: string) => boolean;

/**
 * The unrestricted file set (an empty indexing scope). Recognised by
 * identity: `filterCodeMapToScope` then returns the fetched Nodes and edges
 * untouched, exactly as an empty allowlist always has — dangling edges (an
 * endpoint that is no map Node) included. Any other predicate filters, and
 * keeps only edges between kept Nodes.
 */
export const KEEP_ALL_FILES: KeepFile = () => true;

/** The `KeepFile` for an indexing-scope allowlist: `KEEP_ALL_FILES` when it is empty. */
export function keepFileForScope(includedPaths: readonly string[]): KeepFile {
  return includedPaths.length === 0 ? KEEP_ALL_FILES : (file) => isFileInScope(file, includedPaths);
}

/**
 * P4-4 phase 1b: the `KeepFile` for one section of `includedPaths` — the
 * files whose nearest allowlist entry (`sectionOfFile`) is `section`. Not
 * `isFileInScope(file, [section])`: with nested entries (`apps`,
 * `apps/web`), the `apps` section never keeps `apps/web/**`.
 */
export function keepFileForSection(section: string, includedPaths: readonly string[]): KeepFile {
  return (file) => sectionOfFile(file, includedPaths) === section;
}

/**
 * P4-4 phase 1b: the Section bar's per-section Node counts — one entry per
 * `includedPaths` path, in its order, counting the whole-scope `nodes` each
 * one owns under the nearest-section rule. Every whole-scope Node has
 * exactly one owner, so the counts sum to `nodes.length`. `[]` for an empty
 * allowlist.
 */
export function countSectionNodes(
  projectRoot: string,
  nodes: readonly { file: string }[],
  includedPaths: readonly string[],
): SectionNodeCount[] {
  const counts = new Map(includedPaths.map((entry) => [entry, 0]));
  for (const node of nodes) {
    const owner = sectionOfFile(toProjectRelativePosixPath(projectRoot, node.file, 'section count'), includedPaths);
    if (owner !== undefined) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  return [...counts].map(([path, nodeCount]) => ({ path, nodeCount }));
}

/**
 * Everything one Code Map build reads, captured once per fetch: the
 * production fetch (`fetchProductionCodeMap`, unscoped), the LCOV report
 * loaded for it, and the coverage-gap files of the index it came from.
 */
export interface RawCodeMap {
  projectRoot: string;
  fetched: ProductionCodeMapResult;
  coverage: LcovReport | undefined;
  coverageGapFiles: ReadonlySet<string>;
}

/**
 * The raw fetch behind the current map (`index.ts`'s `activeRawCodeMap`),
 * with the indexing scope that map was built with. Later P4-4 phases
 * re-filter it per section instead of re-fetching.
 */
export interface ActiveRawCodeMap {
  readonly raw: RawCodeMap;
  readonly appliedScope: readonly string[];
  /**
   * The `index.ts` index generation the fetch started under (bumped when any
   * index starts). With `raw.projectRoot`, the stamp that decides whether
   * this is still the active project's current fetch.
   */
  readonly indexGeneration: number;
}

/** `buildScopedCodeMap`'s result. */
export interface ScopedCodeMap {
  /** The map's Nodes: annotated, with risk signals rated over this file set. */
  nodes: CodeMapNode[];
  /** Edges with both endpoints in `nodes`. */
  edges: CodeMapEdge[];
  /**
   * The same Nodes before annotation and signals (raw complexity/hotspot
   * fields still on them) — what staleness detection reads.
   */
  preSignalNodes: ProductionCodeMapResult['nodes'];
  /** Folded types in the file set, naming only kept Nodes and types (uncapped `usedBy`). */
  foldedTypes: FoldedType[];
  /** Folded Modules in the file set, naming only kept Nodes. */
  foldedModules: FoldedModule[];
  /** How many fetched Nodes the file set excluded. */
  hiddenByScope: number;
}

/**
 * Filters `nodes`/`edges` to only those under one of `includedPaths`'
 * project-root-relative POSIX subfolder prefixes (Bug fix, 2026-09-23) — see
 * `ProjectScopeConfig`'s own doc comment in ipc-contracts for why this is a
 * query-time filter over an already-fully-fetched Node/edge set, rather than
 * a narrower `index_repository` call (CBM has no such parameter). A no-op
 * (returns `nodes`/`edges` unchanged, same array references) when
 * `includedPaths` is empty — the pre-existing, unrestricted default every
 * project without a persisted scope setting gets.
 *
 * P4-4 phase 1a: moved here from `index.ts` unchanged; `scope` may also be a
 * `KeepFile` predicate (`buildScopedCodeMap`'s). `KEEP_ALL_FILES` is the
 * same no-op as an empty allowlist; any other predicate is always applied.
 *
 * `node.file` is normalized for the match test only, via the same
 * `toProjectRelativePosixPath` every other consumer of a backend-returned
 * `file` field already normalizes through — never mutates the returned
 * node's own `file` field, so this works identically whether the caller has
 * already normalized `nodes` itself (idempotent on an already-POSIX-relative
 * string) or hasn't.
 *
 * A prefix match respects path boundaries (`"web"` matches `"web/x.ts"` and
 * a Node whose file IS exactly `"web"`, never `"webapp/x.ts"`) — a plain
 * `String.startsWith` would false-positive on a sibling folder sharing a
 * name prefix.
 *
 * Edges are filtered to require BOTH endpoints survive the node filter —
 * same "no dangling edges to entities outside the fetched node set"
 * reasoning `mcp-client.ts`'s `CODE_MAP_EDGES_QUERY` comment already
 * establishes for its own label filtering (a dangling edge is harmless —
 * React Flow silently drops it — but `buildBidirectionalAdjacency`'s blast-
 * radius BFS has no reason to walk through a Node this filter just
 * excluded, and `traceCallPath` has no reason to trace through one either).
 */
export function filterCodeMapToScope<
  TNode extends { id: string; file: string },
  TEdge extends { source: string; target: string },
>(
  projectRoot: string,
  nodes: TNode[],
  edges: TEdge[],
  scope: readonly string[] | KeepFile,
): { nodes: TNode[]; edges: TEdge[] } {
  if (scope === KEEP_ALL_FILES || (typeof scope !== 'function' && scope.length === 0)) {
    return { nodes, edges };
  }
  const keepFile: KeepFile = typeof scope === 'function' ? scope : (file) => isFileInScope(file, scope);
  const isIncludedFile = (file: string): boolean =>
    keepFile(toProjectRelativePosixPath(projectRoot, file, 'indexing scope filter'));
  const filteredNodes = nodes.filter((node) => isIncludedFile(node.file));
  const includedIds = new Set(filteredNodes.map((node) => node.id));
  const filteredEdges = edges.filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target));
  return { nodes: filteredNodes, edges: filteredEdges };
}

/**
 * The Code Map for the files `keepFile` keeps, built from `raw` by the
 * pipeline in this module's doc comment. Pure apart from reading Node
 * records through `getRecord` (summary state, record-backed signals).
 */
export function buildScopedCodeMap(
  raw: RawCodeMap,
  keepFile: KeepFile,
  getRecord: (id: string) => NodeRecord | undefined = getNodeRecord,
): ScopedCodeMap {
  const { nodes: fetchedNodes, edges: fetchedEdges, foldedModules: fetchedModules, foldedTypes: fetchedTypes, similarPairs } =
    raw.fetched;
  // 1. Nodes in the file set, and the edges between them.
  const { nodes: scopedNodes, edges } = filterCodeMapToScope(raw.projectRoot, fetchedNodes, fetchedEdges, keepFile);
  // 2–3. A folded type / Module is kept exactly when its file is, and names
  // only kept Nodes (and kept types). A folded Module's top-level type uses
  // keep only kept types.
  const scopedNodeIds = new Set(scopedNodes.map((node) => node.id));
  const foldedTypes = scopeFoldedTypes(fetchedTypes, new Map(scopedNodes.map((node) => [node.id, node.kind])), keepFile);
  const foldedModules = splitModuleTypeUses(scopeFoldedModules(fetchedModules, scopedNodeIds, keepFile), foldedTypes);
  // 4. Each Node's folded links, type uses and similar implementations are
  // re-derived from the scoped set.
  const preSignalNodes = attachSimilar(
    attachTypeUses(attachFoldedModuleLinks(scopedNodes, foldedModules), foldedTypes),
    similarPairs,
  );
  // 5. Summary state from the record store and the index's coverage gaps.
  const annotatedNodes = annotateNodesWithSummaryState(preSignalNodes, raw.coverageGapFiles, getRecord);
  // 6. Blast-radius adjacency over this file set's edges, built once.
  const adjacency = buildBidirectionalAdjacency(preSignalNodes, edges);
  // 7. Signals built off `preSignalNodes` (which still carry the raw
  // complexity/cognitive/hotspot fields), rated across this file set in one
  // pass, and zipped onto `annotatedNodes` (1:1 in order).
  const nodes = attachProjectRiskSignals(annotatedNodes, preSignalNodes, adjacency, raw.coverage, getRecord);
  return {
    nodes,
    edges,
    preSignalNodes,
    foldedTypes,
    foldedModules,
    hiddenByScope: fetchedNodes.length - preSignalNodes.length,
  };
}
