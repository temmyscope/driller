/**
 * @driller/graph-contracts
 *
 * Reserved per ARCHITECTURE-SPINE.md's Structural Seed and AD-13: this
 * package holds the transport-agnostic Graph Service operation contracts —
 * Node lookup, Path Trace, Blast Radius, diff-scoped Node-set, and
 * coverage-check — each with an explicit, enumerated result-state field.
 *
 * Story 1.1 only scaffolded the monorepo and the folder-open / Recent
 * Projects / Graph Service alive-handshake flow (see @driller/ipc-contracts).
 *
 * Story 1.9 (Phase 1) adds this package's first real content: `traceCallPath`
 * (FR10, AD-13). It is a pure, transport-agnostic function typed against its
 * own minimal structural Node/Edge shapes below — deliberately NOT the
 * `CodeMapNode`/`CodeMapEdge` shapes from `@driller/ipc-contracts` (Always:
 * "no dependency on @driller/ipc-contracts"), so any caller with compatible
 * `{id, name}`/`{source, target, kind}` arrays can use it, including a future
 * agent-facing surface (Technical Decisions: "Node lookup and Path Trace are
 * defined once, transport-agnostically, in a shared contracts package reused
 * by IPC now and a future agent-facing surface"). `@driller/ipc-contracts`
 * imports `PathTraceResult` from here for its own IPC envelope rather than
 * redefining it (Always).
 */

/** Minimal structural Node shape `traceCallPath` needs — see this file's module doc comment. */
export interface PathTraceNode {
  id: string;
  name: string;
}

/** Minimal structural Edge shape `traceCallPath` needs — see this file's module doc comment. */
export interface PathTraceEdge {
  source: string;
  target: string;
  /**
   * Narrowed to the same literal values `CodeMapEdge.kind` carries
   * (`@driller/ipc-contracts`) rather than bare `string` — `PathTraceEdge`
   * still stays structurally independent of that package (Always: "no
   * dependency on @driller/ipc-contracts"), but a typo'd edge kind at a call
   * site is now caught at compile time instead of silently producing an
   * empty trace.
   */
  kind: 'CALLS' | 'IMPORTS' | 'USAGE';
}

/**
 * Result of a Path Trace attempt — an explicit result state (AD-13's broader
 * pattern), never null/undefined/an ambiguous empty list standing in for
 * "no match":
 *  - `'found'`: `path` is the ordered list of Node ids the BFS visited,
 *    entry first. A Node with zero outgoing `CALLS` edges still produces a
 *    valid single-element `found` path (Always) — `'no-path-found'` is
 *    reserved exclusively for zero query matches (Always).
 *  - `'no-path-found'`: the query resolved to no Node at all.
 *  - `'error'`: the trace couldn't even be attempted (e.g. no project
 *    indexed yet, or the Graph Service unavailable) — `message` is safe,
 *    user-facing text.
 */
export type PathTraceResult =
  | { status: 'found'; path: string[] }
  | { status: 'no-path-found' }
  | { status: 'error'; message: string };

/**
 * Resolves `query` against `nodes`' `id`/`name` (exact `id` match first, then
 * exact `name` match, then a substring match on `name` — see
 * `resolveEntryNode`'s own doc comment for the full tier order), then walks
 * the call-reachable subgraph from that entry via BFS over `CALLS` edges only
 * (Always: never `IMPORTS`/`USAGE`), visiting each Node at most once
 * regardless of cycles (Always — mirrors AD-9's blast-radius rule: never
 * loops or double-counts).
 *
 * A `target` id with no corresponding Node in `nodes` (a dangling edge) is
 * never added to `path`/the traversal queue — the same dangling-edge
 * exclusion the renderer's own `NodeAdjacency` builder already applies to
 * this same underlying data (`apps/desktop/renderer/src/CodeMap.tsx`).
 *
 * A source Node's outgoing `CALLS` targets are visited in ascending target-`id`
 * order, not raw `edges` array order — `fetchCodeMap`/the real backend makes
 * no ordering guarantee, so sibling visit order must be deterministic and
 * backend-independent on its own rather than an unverified assumption about
 * edge order (see `fixtures/path-trace-basic/README.md`, whose hand-verified
 * sibling order this sort makes actually true by construction).
 *
 * A query matching more than one Node at any resolution tier deterministically
 * resolves to the first match by sorted `id` (Always — interim disambiguation
 * ahead of Phase 3's real UI; never silently arbitrary, e.g. array order).
 *
 * Pure and transport-agnostic (Always): no I/O, no dependency on
 * `@driller/ipc-contracts` or any other package — `nodes`/`edges` are plain
 * data the caller already has in hand.
 */
export function traceCallPath(
  nodes: PathTraceNode[],
  edges: PathTraceEdge[],
  query: string,
): PathTraceResult {
  const entry = resolveEntryNode(nodes, query);
  if (!entry) {
    return { status: 'no-path-found' };
  }

  // Dangling-edge exclusion (mirrors the renderer's own `NodeAdjacency`
  // builder over this same data): a `target` id with no corresponding Node
  // must never be added to `path`/the traversal queue.
  const validNodeIds = new Set(nodes.map((node) => node.id));

  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'CALLS' || !validNodeIds.has(edge.target)) {
      continue;
    }
    const existing = targetsBySource.get(edge.source);
    if (existing) {
      existing.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }
  }
  // Deterministic, backend-independent sibling order — sorted once here
  // rather than at each traversal step below.
  for (const targets of targetsBySource.values()) {
    targets.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const visited = new Set<string>([entry.id]);
  const path: string[] = [entry.id];
  const queue: string[] = [entry.id];

  while (queue.length > 0) {
    // Non-null: `queue.length > 0` just guarded this shift.
    const current = queue.shift()!;
    const targets = targetsBySource.get(current);
    if (!targets) {
      continue;
    }
    for (const target of targets) {
      if (visited.has(target)) {
        // Dedup — the Always constraint: BFS visits each Node at most once
        // regardless of cycles (e.g. A -> B -> A), so a cyclic entry
        // terminates instead of looping or double-counting.
        continue;
      }
      visited.add(target);
      path.push(target);
      queue.push(target);
    }
  }

  return { status: 'found', path };
}

/**
 * Resolves `query` against `nodes`, in strict tier order — each tier is
 * tried only if the previous one produced zero matches:
 *  1. Exact case-insensitive match on `id`.
 *  2. Exact case-insensitive match on `name`.
 *  3. Case-insensitive substring match on `name`.
 *
 * `id` and `name` exact matches are deliberately NOT pooled together before
 * the sorted-`id` tie-break (a prior version did this) — pooling let a Node
 * whose `name` merely happens to equal the query beat the Node whose `id`
 * actually equals it, whenever both existed and sorted differently. Checking
 * `id` as its own priority tier first means an exact `id` match always wins
 * outright, matching `id`'s role as the stable identity field (AD-19)
 * callers are far more likely to pass verbatim.
 *
 * A tier producing more than one match still resolves deterministically via
 * `firstBySortedId` (Always) before falling through to the next tier.
 */
function resolveEntryNode(nodes: PathTraceNode[], query: string): PathTraceNode | undefined {
  const normalizedQuery = query.toLowerCase();

  const exactIdMatches = nodes.filter((node) => node.id.toLowerCase() === normalizedQuery);
  if (exactIdMatches.length > 0) {
    return firstBySortedId(exactIdMatches);
  }

  const exactNameMatches = nodes.filter((node) => node.name.toLowerCase() === normalizedQuery);
  if (exactNameMatches.length > 0) {
    return firstBySortedId(exactNameMatches);
  }

  const substringMatches = nodes.filter((node) => node.name.toLowerCase().includes(normalizedQuery));
  if (substringMatches.length > 0) {
    return firstBySortedId(substringMatches);
  }

  return undefined;
}

/** Deterministic tie-break for a multi-match query — see `traceCallPath`'s doc comment. */
function firstBySortedId(matches: PathTraceNode[]): PathTraceNode {
  return [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]!;
}
