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
 *  - `'ambiguous'` (Story 1.9, Phase 3): the query matched more than one
 *    Node at the tier that resolves it (see `resolveEntryNode`'s doc
 *    comment for the per-tier resolution rule) — `candidates` is that
 *    tier's full match list, sorted ascending by `id` (Always — the same
 *    deterministic order Phase 1's interim tie-break already used), never
 *    silently narrowed to one. The exact-id tier never produces this state
 *    (AD-19: `id` is unique identity, a match there wins immediately).
 *  - `'no-path-found'`: the query resolved to no Node at all.
 *  - `'error'`: the trace couldn't even be attempted (e.g. no project
 *    indexed yet, or the Graph Service unavailable) — `message` is safe,
 *    user-facing text.
 */
export type PathTraceResult =
  | { status: 'found'; path: string[] }
  | { status: 'ambiguous'; candidates: { id: string; name: string }[] }
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
 * A query matching more than one Node at the tier that resolves it (Story
 * 1.9, Phase 3) returns `{status: 'ambiguous', candidates}` instead of
 * picking one — `candidates` is that tier's full match list, sorted
 * ascending by `id` (Always — the same deterministic order Phase 1's
 * interim tie-break used, generalized from "pick the first" to "return them
 * all"). The exact-id tier is the one exception: a match there wins
 * immediately and unconditionally, never producing `ambiguous` (AD-19 — see
 * `resolveEntryNode`'s doc comment).
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
  const resolution = resolveEntryNode(nodes, query);
  if (resolution.kind === 'not-found') {
    return { status: 'no-path-found' };
  }
  if (resolution.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidates: resolution.candidates.map((node) => ({ id: node.id, name: node.name })),
    };
  }
  const entry = resolution.node;

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
 * The result of resolving a query against `nodes`, in strict tier order —
 * each tier is tried only if the previous one produced zero matches:
 *  1. Exact case-insensitive match on `id` — matches wins immediately and
 *     unconditionally (never `'ambiguous'`, even with >1 match: `id` is
 *     unique identity by construction, AD-19).
 *  2. Exact case-insensitive match on `name`.
 *  3. Case-insensitive substring match on `name`.
 *
 * `id` and `name` exact matches are deliberately NOT pooled together (a
 * prior version did this) — pooling let a Node whose `name` merely happens
 * to equal the query beat the Node whose `id` actually equals it, whenever
 * both existed. Checking `id` as its own priority tier first means an exact
 * `id` match always wins outright, matching `id`'s role as the stable
 * identity field (AD-19) callers are far more likely to pass verbatim.
 *
 * Within tiers 2/3, exactly one match resolves that tier (`'resolved'`);
 * more than one match resolves the *whole* query to `'ambiguous'` for that
 * tier's full candidate list (Story 1.9, Phase 3 — never falls through to
 * the next tier); zero matches falls through to the next tier, or
 * `'not-found'` after the last one.
 */
type EntryResolution =
  | { kind: 'resolved'; node: PathTraceNode }
  | { kind: 'ambiguous'; candidates: PathTraceNode[] }
  | { kind: 'not-found' };

function resolveEntryNode(nodes: PathTraceNode[], query: string): EntryResolution {
  const normalizedQuery = query.toLowerCase();

  const exactIdMatches = nodes.filter((node) => node.id.toLowerCase() === normalizedQuery);
  if (exactIdMatches.length > 0) {
    // Exact-id tier: unconditional immediate win, never ambiguous (see this
    // function's doc comment / AD-19) — even a defensively-unexpected >1
    // match still just resolves via the same sorted-id tie-break as before.
    return { kind: 'resolved', node: sortBySortedId(exactIdMatches)[0]! };
  }

  const exactNameMatches = nodes.filter((node) => node.name.toLowerCase() === normalizedQuery);
  if (exactNameMatches.length > 0) {
    return exactNameMatches.length === 1
      ? { kind: 'resolved', node: exactNameMatches[0]! }
      : { kind: 'ambiguous', candidates: sortBySortedId(exactNameMatches) };
  }

  const substringMatches = nodes.filter((node) => node.name.toLowerCase().includes(normalizedQuery));
  if (substringMatches.length > 0) {
    return substringMatches.length === 1
      ? { kind: 'resolved', node: substringMatches[0]! }
      : { kind: 'ambiguous', candidates: sortBySortedId(substringMatches) };
  }

  return { kind: 'not-found' };
}

// ---------------------------------------------------------------------------
// Story 2.1 (Phase 1): blast radius (FR7, AD-9 corrected).
//
// `computeBlastRadius` mirrors `traceCallPath`'s BFS shape (same `visited`
// Set keyed by Node id, same dangling-edge exclusion via a `validNodeIds`
// check) but differs in exactly the ways the PRD's "reachable from, or
// dependent on" framing requires: it searches both edge directions, every
// edge kind counts (never filtered to `CALLS` only), and the result is a
// plain Node count rather than an ordered id path — the UI only needs a
// magnitude, never the route.
//
// P0-5 (founder decisions, 2026-09-25): the search is bounded at
// `BLAST_RADIUS_DEFAULT_HOPS`, and each direction is searched SEPARATELY —
// a forward search (source -> target: what this Node reaches) and a backward
// search (target -> source: what depends on it), unioned. A path never mixes
// directions, so two "siblings" that merely share a caller or a callee
// (H -> S1, H -> S3) never count each other: a change to S1 cannot affect
// S3. The previous unbounded, direction-mixing BFS returned the whole
// connected component — the same number for every Node.
// ---------------------------------------------------------------------------

/**
 * P0-5: the one hop bound shared by the Blast Radius badge
 * (`computeBlastRadiusFromAdjacency`'s default `maxHops`) and PR Review
 * Mode's initial highlight depth, so the badge and FR-12's default highlight
 * always cover the same Node set for a one-Node diff.
 */
export const BLAST_RADIUS_DEFAULT_HOPS = 2;

/**
 * Reusable adjacency built once by `buildBidirectionalAdjacency`, consumed by
 * `blastRadiusNodeIds`/`computeBlastRadiusFromAdjacency` and
 * `computeBlastRadiusHopDistances`. Both directions are kept as separate maps
 * (never unioned) so each search follows exactly one direction.
 */
export interface BidirectionalAdjacency {
  validNodeIds: Set<string>;
  /** source -> targets: the Nodes each Node reaches in one hop. */
  forward: Map<string, string[]>;
  /** target -> sources: the Nodes that depend on each Node in one hop. */
  backward: Map<string, string[]>;
}

/**
 * Builds the directional adjacency the blast-radius searches walk — one
 * forward and one backward neighbour map from a single pass over `edges`,
 * unlike `traceCallPath`'s single-direction outgoing-`CALLS`-only walk.
 * Dangling-edge-safe: an edge endpoint with no corresponding entry in
 * `nodes` is never added. Parallel edges (same pair, different kinds) and
 * self-loops are kept as-is; the searches' `visited` dedup makes both
 * harmless.
 *
 * Review round (patch): extracted out of what was `computeBlastRadius` so a
 * caller computing blast radius for every Node in a Code Map builds this
 * once — O(V+E) — and reuses it across every per-Node call, instead of the
 * O(N·(V+E)) that rebuilding it inside a per-Node call produced.
 */
export function buildBidirectionalAdjacency(nodes: PathTraceNode[], edges: PathTraceEdge[]): BidirectionalAdjacency {
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const addNeighbor = (map: Map<string, string[]>, from: string, to: string): void => {
    const existing = map.get(from);
    if (existing) {
      existing.push(to);
    } else {
      map.set(from, [to]);
    }
  };
  for (const edge of edges) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) {
      continue;
    }
    addNeighbor(forward, edge.source, edge.target);
    addNeighbor(backward, edge.target, edge.source);
  }
  return { validNodeIds, forward, backward };
}

/**
 * `true` only for a usable hop bound: a finite integer >= 1. `NaN`,
 * `Infinity`, fractions, zero and negatives are all rejected, and every
 * bounded operation below treats a rejected bound as "count nothing".
 */
function isValidMaxHops(maxHops: number): boolean {
  return Number.isInteger(maxHops) && maxHops >= 1;
}

/**
 * Multi-source single-direction BFS over `neighbors` (one of the adjacency's
 * `forward`/`backward` maps). Returns each reached Node's minimum hop count
 * from the nearest seed; seeds themselves get no entry. `maxHops`, when
 * given, stops expansion at that depth: a Node exactly at the bound is
 * recorded but its own neighbours are never enqueued.
 *
 * Cycle-safe: a `visited` Set (seeded with every seed) means each Node is
 * enqueued at most once, so a cycle or self-loop terminates. Because BFS
 * processes Nodes in non-decreasing distance order (all seeds at 0, FIFO
 * queue), the first distance a Node is reached at is its minimum.
 *
 * O(V+E): dequeues through an incrementing `head` cursor, never
 * `Array.prototype.shift()` (itself O(n), which would make the walk O(n²)).
 */
function directionalHopDistances(
  neighbors: Map<string, string[]>,
  seedIds: readonly string[],
  maxHops?: number,
): Map<string, number> {
  const visited = new Set<string>(seedIds);
  const hopDistances = new Map<string, number>();
  const queue: Array<{ id: string; distance: number }> = seedIds.map((id) => ({ id, distance: 0 }));
  let head = 0;
  while (head < queue.length) {
    // Non-null: `head < queue.length` just guarded this index.
    const { id: current, distance } = queue[head]!;
    head += 1;
    if (maxHops !== undefined && distance >= maxHops) {
      // At the bound: already recorded, never expanded further.
      continue;
    }
    const next = neighbors.get(current);
    if (!next) {
      continue;
    }
    for (const neighbor of next) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      hopDistances.set(neighbor, distance + 1);
      queue.push({ id: neighbor, distance: distance + 1 });
    }
  }
  return hopDistances;
}

/**
 * The bounded Blast Radius Node set for `nodeId`: the union of Nodes it
 * reaches following edges forward within `maxHops` hops and Nodes that reach
 * it (following edges backward) within `maxHops` hops — never a path that
 * mixes directions. Origin excluded; distinct. Empty for an isolated Node, a
 * `nodeId` not in `adjacency.validNodeIds`, or an invalid `maxHops` (see
 * `isValidMaxHops`).
 *
 * Pure (Always, mirrors `traceCallPath`): no I/O, no dependency on
 * `@driller/ipc-contracts` or any other package.
 */
export function blastRadiusNodeIds(
  adjacency: BidirectionalAdjacency,
  nodeId: string,
  maxHops: number = BLAST_RADIUS_DEFAULT_HOPS,
): Set<string> {
  if (!adjacency.validNodeIds.has(nodeId) || !isValidMaxHops(maxHops)) {
    return new Set();
  }
  const reached = new Set<string>(directionalHopDistances(adjacency.forward, [nodeId], maxHops).keys());
  for (const id of directionalHopDistances(adjacency.backward, [nodeId], maxHops).keys()) {
    reached.add(id);
  }
  // A cycle can lead either search back to the origin only through
  // `visited`, which is seeded with it — so it is never in either map; this
  // delete just states the Always explicitly.
  reached.delete(nodeId);
  return reached;
}

/**
 * The Blast Radius badge value: the size of `blastRadiusNodeIds` — Nodes
 * reachable from, or dependent on, `nodeId` within `maxHops` hops (default
 * `BLAST_RADIUS_DEFAULT_HOPS`), each direction searched separately. `0` for
 * an isolated or unknown Node and for an invalid `maxHops` (anything but a
 * finite integer >= 1).
 *
 * Pure (Always, mirrors `traceCallPath`): no I/O, no dependency on
 * `@driller/ipc-contracts` or any other package.
 */
export function computeBlastRadiusFromAdjacency(
  adjacency: BidirectionalAdjacency,
  nodeId: string,
  maxHops: number = BLAST_RADIUS_DEFAULT_HOPS,
): number {
  return blastRadiusNodeIds(adjacency, nodeId, maxHops).size;
}

/**
 * Single-shot convenience wrapper (`buildBidirectionalAdjacency` +
 * `computeBlastRadiusFromAdjacency`) for a caller computing blast radius for
 * just one Node — e.g. ad hoc/test use. A caller computing it for many
 * Nodes against the same `nodes`/`edges` (the Code Map fetch path) should
 * call the two underlying functions directly and reuse one adjacency build,
 * not call this once per Node.
 */
export function computeBlastRadius(
  nodes: PathTraceNode[],
  edges: PathTraceEdge[],
  nodeId: string,
  maxHops: number = BLAST_RADIUS_DEFAULT_HOPS,
): number {
  return computeBlastRadiusFromAdjacency(buildBidirectionalAdjacency(nodes, edges), nodeId, maxHops);
}

/**
 * Story 3.2 (Phase 1): multi-source, hop-distance-tracking sibling to
 * `blastRadiusNodeIds` (FR12, AD-13) — instead of a bounded set, computes
 * every reachable Node's minimum hop distance from the nearest of `nodeIds`.
 * PR Review Mode renders a combined Blast Radius highlight across every
 * changed Node in a diff, with an interactive 1-hop/2-hop/further stepper.
 *
 * Directional (P0-5): runs one multi-source forward BFS and one multi-source
 * backward BFS, and keeps each Node's SMALLER of the two distances — the same
 * per-direction rule as the badge, so for a one-Node diff the Nodes at
 * distance 1..d are exactly `blastRadiusNodeIds(adjacency, nodeId, d)`.
 *
 * Multi-source (Always): all seeds start at distance 0 together, so a Node's
 * distance in each direction is its minimum from any seed, never summed or
 * averaged.
 *
 * Unbounded (Always: no `maxHops` parameter) — returns distances for the
 * entire reachable set in one call; the stepper slices this locally per
 * click rather than re-requesting per hop depth.
 *
 * Cycle-safe (Always): each direction's `visited` Set dedup means a circular
 * edge terminates instead of looping.
 *
 * Seed Nodes are excluded from the returned map (Always). A seed absent from
 * `adjacency.validNodeIds` is skipped, never an error; an empty or
 * entirely-stale `nodeIds` produces an empty map. Duplicate ids are
 * deduplicated before seeding.
 *
 * O(V+E): two `head`-cursor BFS passes (see `directionalHopDistances`), which
 * is what `BLAST_RADIUS_REQUEST_TIMEOUT_MS` in the desktop main process
 * assumes when it sizes its timeout for "a very large graph."
 *
 * Pure (Always): no I/O, no dependency on `@driller/ipc-contracts` or any
 * other package.
 */
export function computeBlastRadiusHopDistances(
  adjacency: BidirectionalAdjacency,
  nodeIds: string[],
): Map<string, number> {
  const seedIds = [...new Set(nodeIds)].filter((nodeId) => adjacency.validNodeIds.has(nodeId));
  const hopDistances = directionalHopDistances(adjacency.forward, seedIds);
  for (const [id, distance] of directionalHopDistances(adjacency.backward, seedIds)) {
    const existing = hopDistances.get(id);
    if (existing === undefined || distance < existing) {
      hopDistances.set(id, distance);
    }
  }
  return hopDistances;
}

// ---------------------------------------------------------------------------
// Story 2.3 (Phase 2): file+line-to-enclosing-Node lookup (Design Notes).
//
// Lives here, not `services/graph-service` (Design Notes: "transport-
// agnostic, pure... since Phase 3's Qodo adapter needs the identical
// lookup — same reasoning as Story 2.1's `buildBidirectionalAdjacency`
// extraction"). A minimal structural shape, deliberately not
// `CodeMapNode` (same "no dependency on @driller/ipc-contracts" stance
// `PathTraceNode`/`PathTraceEdge` already take above) — any caller with
// compatible `{id, file, startLine, endLine}` values can use it.
// ---------------------------------------------------------------------------

/** Minimal structural Node shape `findEnclosingNode` needs — see this section's doc comment. */
export interface EnclosingNodeCandidate {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
}

/**
 * Finds the Node whose `[startLine, endLine]` range on `file` encloses
 * `line`, returning its `id` — or `undefined` when no Node's range contains
 * it (a finding on an import line, a blank line, or a file outside the
 * graph entirely; the I/O matrix: "that finding is dropped, others still
 * persisted").
 *
 * `file` is matched by exact string equality — both `nodes[].file` and the
 * `file` argument are expected to already be in the same normalized,
 * POSIX-relative-to-project-root form (AD-19); this function does no path
 * normalization of its own (pure, no I/O), matching `traceCallPath`'s own
 * "caller already has compatible data in hand" stance.
 *
 * Smallest-range-wins when nested Nodes both contain `line` (Code Map: "a
 * Node id or undefined... smallest-range-wins when nested Nodes both
 * contain line") — e.g. an inner arrow function nested inside its outer
 * function both span the same line; the inner (narrower) one is the more
 * specific/useful attribution. Ties (equal range width) resolve to whichever
 * candidate was encountered first in `nodes` — deterministic given a
 * deterministic input order, though this function applies no ordering
 * guarantee of its own beyond that.
 */
export function findEnclosingNode(
  nodes: EnclosingNodeCandidate[],
  file: string,
  line: number,
): string | undefined {
  let best: EnclosingNodeCandidate | undefined;
  for (const node of nodes) {
    if (node.file !== file || line < node.startLine || line > node.endLine) {
      continue;
    }
    if (!best || node.endLine - node.startLine < best.endLine - best.startLine) {
      best = node;
    }
  }
  return best?.id;
}

/**
 * Deterministic sort order for a multi-match candidate set (Always) —
 * ascending by `id`. Generalized from Phase 1/2's `firstBySortedId`
 * (formerly returned only the first element for its interim tie-break) now
 * that Phase 3 needs the full sorted candidate list for `'ambiguous'`, not
 * just its first entry.
 */
function sortBySortedId(matches: PathTraceNode[]): PathTraceNode[] {
  return [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Story 3.1 (Phase 1): diff-scoped Node-set matching (FR11, AD-13).
//
// Lives here, not `services/graph-service` — same "transport-agnostic,
// pure, reused identically by IPC now and a future agent-facing surface"
// reasoning `findEnclosingNode`'s own section header already states, since
// AD-13 requires the diff-scoped Node-set operation be "defined once...
// exposed identically to the renderer and (later) the Agent-Facing Query
// Surface." A minimal structural shape, deliberately not `CodeMapNode` (same
// "no dependency on @driller/ipc-contracts" stance every other shape in this
// file already takes) — any caller with compatible `{id, file}` values can
// use it.
// ---------------------------------------------------------------------------

/** Minimal structural Node shape `findChangedNodeIds` needs — see this section's doc comment. */
export interface ChangedFileNodeCandidate {
  id: string;
  file: string;
}

/**
 * Matches `changedFiles` (a diff's changed-file list) against `nodes`,
 * returning the `id` of every Node whose `file` appears in that list.
 *
 * `file` is matched by exact string equality — both `nodes[].file` and each
 * entry of `changedFiles` are expected to already be in the same normalized,
 * POSIX-relative-to-project-root form (AD-19); this function does no path
 * normalization of its own (pure, no I/O), mirroring `findEnclosingNode`'s
 * own "caller already has compatible data in hand" contract exactly.
 *
 * A changed file that matches no Node (a config file, a non-source file, a
 * file outside the graph entirely) simply contributes no id to the result —
 * never an error, never a placeholder entry (I/O matrix: "that file
 * contributes no Node to the result set; others still included").
 *
 * Result order follows `nodes`' own input order (not `changedFiles`'
 * order, and not re-sorted) — deterministic given a deterministic `nodes`
 * order, the same "no ordering guarantee beyond the input's own" stance
 * `findEnclosingNode` takes for its own iteration.
 */
export function findChangedNodeIds(nodes: ChangedFileNodeCandidate[], changedFiles: string[]): string[] {
  const changedFileSet = new Set(changedFiles);
  const nodeIds: string[] = [];
  for (const node of nodes) {
    if (changedFileSet.has(node.file)) {
      nodeIds.push(node.id);
    }
  }
  return nodeIds;
}
