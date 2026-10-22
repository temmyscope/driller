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
  CROSS_SECTION_CALLS_MAX,
  findChangedContracts,
  findChangedNodeIds,
  findContractOnlyChangedFiles,
  findTopLevelOnlyChangedFiles,
  type ChangedContract,
  type ChangedLinesByFile,
  type CrossSectionCall,
  type CrossSectionEdgeCount,
  type FoldedModule,
  type FoldedType,
  type SectionChangeCount,
  type SectionNodeCount,
  type TopLevelChangedFile,
  type UnknownSectionResult,
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
import { attachCoChanges } from './co-change';
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
 * P4-4 phase 2a (AD-13 "Section scope"): the one place a request's optional
 * `section` is checked against the allowlist and turned into a file set.
 *  - omitted → the whole scope (`keepFileForScope`, so an empty allowlist
 *    stays the identity-recognised unrestricted `KEEP_ALL_FILES`);
 *  - an exact allowlist entry → `keepFileForSection` (nearest-section rule);
 *  - anything else (including any section while the allowlist is empty) →
 *    the explicit `UnknownSectionResult`, with the allowlist as
 *    `knownSections`.
 * Used by the Code Map fetch, Path Trace, diff scope and Blast Radius
 * expansion, so all four validate a section the same way.
 */
export function resolveSectionFilter(
  section: string | undefined,
  includedPaths: readonly string[],
): KeepFile | UnknownSectionResult {
  if (section === undefined) {
    return keepFileForScope(includedPaths);
  }
  if (!includedPaths.includes(section)) {
    return { status: 'unknown-section', section, knownSections: [...includedPaths] };
  }
  return keepFileForSection(section, includedPaths);
}

/**
 * P4-4 phase 2a: narrows already-built whole-scope Nodes and edges (the
 * caches diff scope and Blast Radius expansion read) to one section's file
 * set, BEFORE anything is computed from them: Nodes whose file `keepFile`
 * keeps, and only the edges whose both endpoints survive — exactly
 * `filterCodeMapToScope`'s rule (it does the work; `keepFile` here is never
 * `KEEP_ALL_FILES`, so it always filters). Since a section is a subset of
 * the whole scope, this equals the section build's own Nodes and edges.
 */
export function filterToSection<
  TNode extends { id: string; file: string },
  TEdge extends { source: string; target: string },
>(projectRoot: string, nodes: TNode[], edges: TEdge[], keepFile: KeepFile): { nodes: TNode[]; edges: TEdge[] } {
  return filterCodeMapToScope(projectRoot, nodes, edges, keepFile);
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
 * P4-4 phase 3a: each Node id's section under the nearest-section rule
 * (`sectionOfFile` over `includedPaths`). A Node outside the allowlist has
 * no entry, so it is never counted as "another section": scope hides it,
 * not the section.
 */
function sectionsById(
  projectRoot: string,
  nodes: readonly { id: string; file: string }[],
  includedPaths: readonly string[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const node of nodes) {
    const owner = sectionOfFile(toProjectRelativePosixPath(projectRoot, node.file, 'cross-section count'), includedPaths);
    if (owner !== undefined) {
      owners.set(node.id, owner);
    }
  }
  return owners;
}

/** Section entries sorted by `total` (highest first), then section. */
function sortBySizeThenSection<T extends { section: string }>(entries: T[], total: (entry: T) => number): T[] {
  return entries.sort(
    (a, b) => total(b) - total(a) || (a.section < b.section ? -1 : a.section > b.section ? 1 : 0),
  );
}

/**
 * P4-4 phase 3a: the whole-scope edges a section's map drops because their
 * other end is in another section — one entry per other section, counting
 * every edge (any `CodeMapEdgeKind`) with exactly one end in `section` and
 * the other in that section, split by direction (founder decision
 * 2026-10-03): `outgoing` = `section` → other, `incoming` = other →
 * `section`. Counted over `nodes`/`edges` as they are BEFORE the section's
 * both-endpoints filter (the whole-scope build's), never as "whole scope
 * minus section".
 *
 * An end that is no Node in `nodes` (a dangling edge), or whose file is in
 * no allowlist entry, has no section, so the edge is never counted. That is
 * consistent with the unrestricted map's dangling-edge pass-through
 * (`KEEP_ALL_FILES`): a section exists only with a non-empty allowlist,
 * whose whole-scope filter has already dropped dangling edges.
 * Sorted by `outgoing + incoming` (highest first), then section; `[]` when
 * there is none.
 */
export function countCrossSectionEdges(
  projectRoot: string,
  nodes: readonly { id: string; file: string }[],
  edges: readonly { source: string; target: string }[],
  section: string,
  includedPaths: readonly string[],
): CrossSectionEdgeCount[] {
  const owners = sectionsById(projectRoot, nodes, includedPaths);
  const counts = new Map<string, CrossSectionEdgeCount>();
  const entryFor = (other: string): CrossSectionEdgeCount => {
    let entry = counts.get(other);
    if (entry === undefined) {
      entry = { section: other, outgoing: 0, incoming: 0 };
      counts.set(other, entry);
    }
    return entry;
  };
  for (const edge of edges) {
    const from = owners.get(edge.source);
    const to = owners.get(edge.target);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    if (from === section) {
      entryFor(to).outgoing += 1;
    } else if (to === section) {
      entryFor(from).incoming += 1;
    }
  }
  return sortBySizeThenSection([...counts.values()], (entry) => entry.outgoing + entry.incoming);
}

/**
 * P4-4 phase 3a: `sectionNodes` (a section build's Nodes) with each Node's
 * `crossSectionCalls` — its outgoing whole-scope `CALLS` edges whose callee
 * is in another allowlist section — and `crossSectionCallsTotal`. One entry
 * per callee (a repeated edge never doubles a row), sorted by section, then
 * name, then id, capped at `CROSS_SECTION_CALLS_MAX`. A Node with none is
 * returned as the same object, with neither field. Incoming callers are not
 * counted (Ask First).
 */
export function attachCrossSectionCalls<TNode extends { id: string }>(
  projectRoot: string,
  sectionNodes: TNode[],
  wholeScopeNodes: readonly { id: string; name: string; file: string }[],
  wholeScopeEdges: readonly { source: string; target: string; kind: string }[],
  section: string,
  includedPaths: readonly string[],
): (TNode & { crossSectionCalls?: CrossSectionCall[]; crossSectionCallsTotal?: number })[] {
  const owners = sectionsById(projectRoot, wholeScopeNodes, includedPaths);
  const names = new Map(wholeScopeNodes.map((node) => [node.id, node.name]));
  const callees = new Map<string, Map<string, CrossSectionCall>>();
  for (const edge of wholeScopeEdges) {
    if (edge.kind !== 'CALLS' || owners.get(edge.source) !== section) {
      continue;
    }
    const calleeSection = owners.get(edge.target);
    const name = names.get(edge.target);
    if (calleeSection === undefined || calleeSection === section || name === undefined) {
      continue;
    }
    const byId = callees.get(edge.source) ?? new Map<string, CrossSectionCall>();
    byId.set(edge.target, { id: edge.target, name, section: calleeSection });
    callees.set(edge.source, byId);
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return sectionNodes.map((node) => {
    const byId = callees.get(node.id);
    if (byId === undefined) {
      return node;
    }
    const all = [...byId.values()].sort(
      (a, b) => compare(a.section, b.section) || compare(a.name, b.name) || compare(a.id, b.id),
    );
    return { ...node, crossSectionCalls: all.slice(0, CROSS_SECTION_CALLS_MAX), crossSectionCallsTotal: all.length };
  });
}

/** P4-4 phase 3a: one resolved diff, as `summarizeDiffChanges` reads it (`git-diff-scope.ts`'s resolved result). */
export interface ResolvedDiff {
  changedFiles: string[];
  changedLines?: ChangedLinesByFile;
}

/** The whole-scope caches a diff is matched against. */
export interface DiffMatchInputs<TNode extends { id: string; file: string }> {
  nodes: readonly TNode[];
  foldedTypes: readonly FoldedType[];
  foldedModules: readonly FoldedModule[];
}

/**
 * P4-4 phase 3a: what one diff changed among `nodes` / `foldedTypes` /
 * `foldedModules` — moved here from `index.ts`'s `computeDiffScopeResult`
 * unchanged, so a section's own result and the per-section counts of
 * `changedInOtherSections` come from the same finders:
 *  - `nodeIds`: `findChangedNodeIds`;
 *  - `changedContracts` / `approximate`: `findChangedContracts`, dependents
 *    kept among `nodes`;
 *  - `topLevelFiles`: `findTopLevelOnlyChangedFiles`, leaving out a file
 *    whose every change lies inside a type (`findContractOnlyChangedFiles`).
 */
export function summarizeDiffChanges(
  inputs: DiffMatchInputs<{ id: string; file: string }>,
  diff: ResolvedDiff,
): { nodeIds: string[]; changedContracts: ChangedContract[]; approximate: boolean; topLevelFiles: TopLevelChangedFile[] } {
  const nodes = [...inputs.nodes];
  const nodeIds = findChangedNodeIds(nodes, diff.changedFiles);
  const { contracts: changedContracts, approximate } = findChangedContracts(
    inputs.foldedTypes,
    diff.changedFiles,
    diff.changedLines,
    { mapNodeIds: new Set(nodes.map((node) => node.id)) },
  );
  const contractOnlyFiles =
    diff.changedLines === undefined ? new Set<string>() : findContractOnlyChangedFiles(inputs.foldedTypes, diff.changedLines);
  const topLevelFiles = findTopLevelOnlyChangedFiles(
    nodes,
    inputs.foldedModules,
    diff.changedFiles.filter((file) => !contractOnlyFiles.has(file)),
  );
  return { nodeIds, changedContracts, approximate, topLevelFiles };
}

/**
 * P4-4 phase 3a: `inputs` narrowed to one section's files (`keepFile`) —
 * Nodes through `filterToSection`, folded types and Modules by their
 * `file`, exactly as `computeDiffScopeResult` narrows them for a section.
 */
export function narrowDiffInputs<TNode extends { id: string; file: string }>(
  projectRoot: string,
  inputs: DiffMatchInputs<TNode>,
  keepFile: KeepFile,
): DiffMatchInputs<TNode> {
  return {
    nodes: filterToSection(projectRoot, [...inputs.nodes], [], keepFile).nodes,
    foldedTypes: inputs.foldedTypes.filter((type) => keepFile(type.file)),
    foldedModules: inputs.foldedModules.filter((module) => keepFile(module.file)),
  };
}

/**
 * P4-4 phase 3a (founder decision 2026-10-03): what one diff changed in
 * each OTHER section of `includedPaths` that `sameRepo` says shares the
 * requested section's git repository — per section, the counts its own
 * diff-scope result would hold (`summarizeDiffChanges` over the whole-scope
 * `inputs` narrowed to that section, never "whole scope minus section"):
 * changed Nodes, changed contracts and top-level-only files. The current
 * section, a section `sameRepo` rejects (another repository, or none) and
 * anything outside the allowlist are never counted. One entry per section
 * with any count above 0, sorted by the sum (highest first), then section;
 * `[]` when there is none.
 */
export function countChangedInOtherSections(
  projectRoot: string,
  inputs: DiffMatchInputs<{ id: string; file: string }>,
  diff: ResolvedDiff,
  section: string,
  includedPaths: readonly string[],
  sameRepo: (otherSection: string) => boolean,
): SectionChangeCount[] {
  const entries: SectionChangeCount[] = [];
  for (const other of new Set(includedPaths)) {
    if (other === section || !sameRepo(other)) {
      continue;
    }
    const changes = summarizeDiffChanges(narrowDiffInputs(projectRoot, inputs, keepFileForSection(other, includedPaths)), diff);
    const entry: SectionChangeCount = {
      section: other,
      changedNodes: changes.nodeIds.length,
      changedContracts: changes.changedContracts.length,
      topLevelFiles: changes.topLevelFiles.length,
    };
    if (entry.changedNodes + entry.changedContracts + entry.topLevelFiles > 0) {
      entries.push(entry);
    }
  }
  return sortBySizeThenSection(entries, (entry) => entry.changedNodes + entry.changedContracts + entry.topLevelFiles);
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
 * Steps 1–4a of the pipeline (see this module's doc comment), shared by
 * `buildScopedCodeMap` and `buildSectionCallGraph` (P4-7c review round 1) so
 * the two can never drift:
 *  1. `filterCodeMapToScope` — Nodes in the file set, and the edges between them;
 *  2–3. a folded type / Module is kept exactly when its file is, and names
 *     only kept Nodes (and kept types); a folded Module's top-level type uses
 *     keep only kept types;
 *  4a. each Node's folded-Module links (`fileTopLevel`, `calledAtLoadBy`,
 *     `fileTopLevelTypes`) re-derived from the scoped Modules.
 */
function scopeRawCodeMap(raw: RawCodeMap, keepFile: KeepFile) {
  const { nodes: fetchedNodes, edges: fetchedEdges, foldedModules: fetchedModules, foldedTypes: fetchedTypes } = raw.fetched;
  const { nodes: scopedNodes, edges } = filterCodeMapToScope(raw.projectRoot, fetchedNodes, fetchedEdges, keepFile);
  const scopedNodeIds = new Set(scopedNodes.map((node) => node.id));
  const foldedTypes = scopeFoldedTypes(fetchedTypes, new Map(scopedNodes.map((node) => [node.id, node.kind])), keepFile);
  const foldedModules = splitModuleTypeUses(scopeFoldedModules(fetchedModules, scopedNodeIds, keepFile), foldedTypes);
  return { linkedNodes: attachFoldedModuleLinks(scopedNodes, foldedModules), edges, foldedTypes, foldedModules };
}

/**
 * P4-7c (AD-13 "(f) per section", founder decision 2026-10-04): the Nodes
 * and edges entry candidates are listed from in one section — exactly
 * `buildScopedCodeMap(raw, keepFile)`'s steps 1–4a (`scopeRawCodeMap`, the
 * same code), nothing else: the section's own Nodes and the edges between
 * them (never the whole-scope result filtered), each Node's `calledAtLoadBy`
 * re-scoped to the section exactly as the section's Code Map reply has it —
 * a file of another section whose top-level code calls a Node never appears
 * in it, so never in a candidate's `reason.loadedBy`. Type uses, similar
 * implementations, summary state and signals are skipped:
 * `listEntryCandidates` reads only ids, names, locations, `calledAtLoadBy`
 * and edges. Pure.
 */
export function buildSectionCallGraph(
  raw: RawCodeMap,
  keepFile: KeepFile,
): { nodes: ProductionCodeMapResult['nodes']; edges: CodeMapEdge[] } {
  const { linkedNodes, edges } = scopeRawCodeMap(raw, keepFile);
  return { nodes: linkedNodes, edges };
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
  const { nodes: fetchedNodes, similarPairs, coChangePairs } = raw.fetched;
  // 1–4a. The scope filter, folded type / Module scoping and folded-Module
  // links (`scopeRawCodeMap`, shared with `buildSectionCallGraph`).
  const { linkedNodes, edges, foldedTypes, foldedModules } = scopeRawCodeMap(raw, keepFile);
  // 4. Each Node's type uses, similar implementations and co-changing files
  // are re-derived from the scoped set, so none of them names a Node or file
  // the scope dropped.
  const preSignalNodes = attachCoChanges(
    attachSimilar(attachTypeUses(linkedNodes, foldedTypes), similarPairs),
    coChangePairs,
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
