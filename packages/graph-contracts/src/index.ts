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
 * own Node/Edge shapes below, which are deliberately minimal, not the full
 * `CodeMapNode`/`CodeMapEdge` (both declared in this file since P4-6), so any
 * caller with compatible `{id, name}`/`{source, target, kind}` arrays can use
 * it, including a future
 * agent-facing surface (Technical Decisions: "Node lookup and Path Trace are
 * defined once, transport-agnostically, in a shared contracts package reused
 * by IPC now and a future agent-facing surface"). `@driller/ipc-contracts`
 * imports `PathTraceResult` from here for its own IPC envelope rather than
 * redefining it (Always).
 *
 * P4-6: every other Graph Service operation's result shape now lives here
 * too (see the "P4-6" section at the end of this file), so AD-13's
 * "defined once" rule holds for all six, enforced by `contractHome.test.ts`.
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
   * The same `CodeMapEdgeKind` a `CodeMapEdge` carries, rather than bare
   * `string` — so a typo'd edge kind at a call site is caught at compile time
   * instead of silently producing an empty trace. The rest of the shape stays
   * deliberately minimal, not the full `CodeMapEdge`.
   */
  kind: CodeMapEdgeKind;
}

/**
 * Result of a Path Trace attempt — an explicit result state (AD-13's broader
 * pattern), never null/undefined/an ambiguous empty list standing in for
 * "no match":
 *  - `'found'`: `path` is every Node id the BFS reached, in visit order,
 *    entry first — the call-reachable set, not a single chain. `parents`
 *    and `depths` (FIX-2) carry the BFS tree: the caller each Node was
 *    first reached from, and its hop distance from the entry. A Node with
 *    zero outgoing `CALLS` edges still produces a valid single-element
 *    `found` result (Always) — `'no-path-found'` is reserved exclusively
 *    for zero query matches (Always).
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
  | {
      status: 'found';
      /**
       * Every reached Node id in BFS visit order, entry first. It is NOT a
       * chain: consecutive entries are often sibling callees, never
       * caller→callee by construction. The name `path` predates FIX-2 and
       * stays for backward compatibility with the IPC renderer and the
       * `trace_path` agent consumers; read `parents` for who calls whom, and
       * never build edges from consecutive `path` pairs.
       */
      path: string[];
      /**
       * FIX-2: the BFS tree behind `path` — each reached Node's id maps to
       * the Node it was FIRST discovered from (the entry maps to `null`).
       * Null-prototype object, so a Node id can never collide with an
       * `Object.prototype` key.
       */
      parents: Record<string, string | null>;
      /** FIX-2: each reached Node's hop distance from the entry in the BFS tree (entry = 0). Null-prototype, like `parents`. */
      depths: Record<string, number>;
    }
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
  // FIX-2: the BFS tree, recorded at first discovery (the same moment a Node
  // joins `path`), so it's exactly as deterministic as `path` itself.
  // Null-prototype (no `__proto__`/`constructor` collisions with a Node id).
  const parents: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const depths: Record<string, number> = Object.create(null) as Record<string, number>;
  parents[entry.id] = null;
  depths[entry.id] = 0;

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
      parents[target] = current;
      // Non-null: `current` was dequeued, so its depth was recorded when it
      // was discovered (or it's the entry, recorded above).
      depths[target] = depths[current]! + 1;
    }
  }

  return { status: 'found', path, parents, depths };
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
// extraction"). Its Node shape is deliberately minimal, not the full
// `CodeMapNode` (the same stance `PathTraceNode`/`PathTraceEdge` take
// above) — any caller with compatible `{id, file, startLine, endLine}`
// values can use it.
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
// Surface." Its Node shape is deliberately minimal, not the full
// `CodeMapNode` (the same stance the other operation inputs in this file
// take) — any caller with compatible `{id, file}` values can use it.
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

/**
 * P4-2 phase 3a: the changed files that touch only folded top-level code —
 * a file with a `FoldedModule` but no Node in `nodes` — in `changedFiles`
 * order, each once, with the folded Module's range (so the file can be
 * opened). Same exact-string, already-normalized path contract as
 * `findChangedNodeIds`. A changed file with map Nodes is not listed: its
 * Nodes already count as changed — diff scope is file-based, so a
 * top-level-only edit in such a file still marks its Nodes changed.
 */
export function findTopLevelOnlyChangedFiles(
  nodes: ChangedFileNodeCandidate[],
  foldedModules: readonly TopLevelChangedFile[],
  changedFiles: string[],
): TopLevelChangedFile[] {
  const filesWithNodes = new Set(nodes.map((node) => node.file));
  const foldedByFile = new Map(foldedModules.map((module) => [module.file, module]));
  const result: TopLevelChangedFile[] = [];
  const seen = new Set<string>();
  for (const file of changedFiles) {
    const folded = foldedByFile.get(file);
    if (!seen.has(file) && folded !== undefined && !filesWithNodes.has(file)) {
      result.push({ file, startLine: folded.startLine, endLine: folded.endLine });
    }
    seen.add(file);
  }
  return result;
}

/**
 * P4-2 phase 3c: one changed line range in a diff's post-change ("new")
 * file, 1-based and inclusive. A hunk that only deletes lines has no new
 * lines: it sits between new lines `n` and `n + 1`, and is recorded as the
 * empty range `{start: n + 1, end: n}`. `changedRangeTouches`' one overlap
 * test (`start <= rangeEnd && rangeStart <= end`) then reads it correctly:
 * the deletion touches a range only when that range spans both `n` and
 * `n + 1`, i.e. the lines were deleted from inside it.
 */
export interface ChangedLineRange {
  start: number;
  end: number;
}

/**
 * P4-2 phase 3c: changed line ranges per changed file (POSIX,
 * project-relative), as `git diff -U0` reports them. A file listed with
 * `[]` was read and has no changed lines (a pure rename, a mode change, a
 * binary file); a changed file with no entry at all could not be read.
 */
export type ChangedLinesByFile = Readonly<Record<string, readonly ChangedLineRange[]>>;

/** P4-2 phase 3c: whether any of `ranges` touches lines `startLine`–`endLine` (see `ChangedLineRange`). */
export function changedRangeTouches(ranges: readonly ChangedLineRange[], startLine: number, endLine: number): boolean {
  return ranges.some((range) => range.start <= endLine && startLine <= range.end);
}

/**
 * P4-2 phase 3c: whether `range` lies wholly inside lines
 * `startLine`–`endLine`. A pure deletion (`{start: n + 1, end: n}`) lies
 * inside when the range spans both `n` and `n + 1`, the same as touching.
 */
export function changedRangeInside(range: ChangedLineRange, startLine: number, endLine: number): boolean {
  const low = Math.min(range.start, range.end);
  const high = Math.max(range.start, range.end);
  return startLine <= low && high <= endLine;
}

/**
 * P4-2 phase 3c: a folded Type/Interface (`FoldedType`) whose own lines a
 * diff changed — a changed contract. Types are not map Nodes, so a PR that
 * edits only a type would otherwise show no change; this names it with the
 * map Nodes that depend on it.
 */
export interface ChangedContract {
  /** The folded type's id; resolves via `lookup_node` and the Code Map's `foldedTypes`. */
  id: string;
  name: string;
  kind: FoldedTypeKind;
  /** POSIX-relative path of its file. */
  file: string;
  /** How many map Nodes use it — the full count, whatever `dependentIds` carries. */
  dependentCount: number;
  /**
   * The map Nodes with a real `USAGE` edge into it (`FoldedType.usedBy`),
   * sorted by id, unique, capped at `CHANGED_CONTRACT_MAX_DEPENDENT_IDS`.
   * Never inferred from a name or a signature.
   */
  dependentIds: string[];
}

/**
 * P4-2 phase 3c: the most `ChangedContract.dependentIds` carried per
 * contract (IPC and MCP); `dependentCount` is always exact.
 */
export const CHANGED_CONTRACT_MAX_DEPENDENT_IDS = 200;

/** P4-2 phase 3c: `findChangedContracts`' result. */
export interface ChangedContractsResult {
  contracts: ChangedContract[];
  /**
   * True when some changed file that holds folded types had no line ranges
   * (`changedLines` undefined, or no entry for the file), so every type in
   * it was counted: the list may over-report, never hide, a contract.
   */
  approximate: boolean;
}

/** Sorted ranges plus each prefix's greatest `end`, for `touchesSorted`. */
interface SortedRanges {
  ranges: ChangedLineRange[];
  maxEnd: number[];
}

function sortRanges(ranges: readonly ChangedLineRange[]): SortedRanges {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const maxEnd: number[] = [];
  let max = Number.NEGATIVE_INFINITY;
  for (const range of sorted) {
    max = Math.max(max, range.end);
    maxEnd.push(max);
  }
  return { ranges: sorted, maxEnd };
}

/**
 * `changedRangeTouches` over pre-sorted ranges: binary-searches the first
 * range whose prefix could reach `startLine`, then scans only ranges that
 * start at or before `endLine`.
 */
function touchesSorted({ ranges, maxEnd }: SortedRanges, startLine: number, endLine: number): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((maxEnd[mid] ?? Number.NEGATIVE_INFINITY) < startLine) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  for (let index = low; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (range.start > endLine) {
      return false;
    }
    if (startLine <= range.end) {
      return true;
    }
  }
  return false;
}

/** Options for `findChangedContracts`. */
export interface FindChangedContractsOptions {
  /** When given, dependents are kept only if in this set (the map Nodes in scope), and counted after that. */
  mapNodeIds?: ReadonlySet<string>;
  /** Cap on each contract's `dependentIds` (default `CHANGED_CONTRACT_MAX_DEPENDENT_IDS`). */
  maxDependentIds?: number;
}

/**
 * P4-2 phase 3c: the folded types a diff changed — each type whose own line
 * range (`startLine`–`endLine`) a changed range in its file touches.
 * `changedLines` must come from the same merge-base diff as `changedFiles`.
 * A changed file listed in `changedLines` with `[]` changed no lines and
 * contributes nothing. A changed file with no entry (or `changedLines`
 * undefined: the ranges could not be read) counts every type in it and
 * sets `approximate` — over-reporting a contract, never hiding one. The
 * dependents are real `USAGE` users either way.
 *
 * `foldedTypes`' `usedBy` must be uncapped. Sorted by most dependents, then
 * name, then id. Pure.
 */
export function findChangedContracts(
  foldedTypes: readonly FoldedType[],
  changedFiles: readonly string[],
  changedLines: ChangedLinesByFile | undefined,
  { mapNodeIds, maxDependentIds = CHANGED_CONTRACT_MAX_DEPENDENT_IDS }: FindChangedContractsOptions = {},
): ChangedContractsResult {
  const changedFileSet = new Set(changedFiles);
  const sortedByFile = new Map<string, SortedRanges | null>();
  const rangesFor = (file: string): SortedRanges | null => {
    let sorted = sortedByFile.get(file);
    if (sorted === undefined) {
      const ranges = changedLines !== undefined && Object.hasOwn(changedLines, file) ? changedLines[file] : undefined;
      sorted = ranges === undefined ? null : sortRanges(ranges);
      sortedByFile.set(file, sorted);
    }
    return sorted;
  };
  const contracts: ChangedContract[] = [];
  const seen = new Set<string>();
  let approximate = false;
  for (const type of foldedTypes) {
    if (seen.has(type.id) || !changedFileSet.has(type.file)) {
      continue;
    }
    const sorted = rangesFor(type.file);
    if (sorted === null) {
      approximate = true;
    } else if (!touchesSorted(sorted, type.startLine, type.endLine)) {
      continue;
    }
    seen.add(type.id);
    const users = [...new Set(type.usedBy)].filter((id) => mapNodeIds === undefined || mapNodeIds.has(id));
    users.sort(compareStrings);
    contracts.push({
      id: type.id,
      name: type.name,
      kind: type.kind,
      file: type.file,
      dependentCount: users.length,
      dependentIds: users.slice(0, Math.max(0, maxDependentIds)),
    });
  }
  contracts.sort(
    (a, b) => b.dependentCount - a.dependentCount || compareStrings(a.name, b.name) || compareStrings(a.id, b.id),
  );
  return { contracts, approximate };
}

/**
 * P4-2 phase 3c: the changed files whose every changed range lies wholly
 * inside a folded type of that file (`changedRangeInside`) — a
 * contract-only change. Such a file's change is already named by
 * `findChangedContracts`, so it must not also read as "top-level code
 * changed" (`findTopLevelOnlyChangedFiles`). A range that spans a type and
 * the code next to it keeps the file out of this set. A file with no
 * ranges is not listed. Pure; each range is checked by binary search over
 * the file's types sorted by start line.
 */
export function findContractOnlyChangedFiles(
  foldedTypes: readonly FoldedType[],
  changedLines: ChangedLinesByFile,
): Set<string> {
  const typesByFile = new Map<string, FoldedType[]>();
  for (const type of foldedTypes) {
    const list = typesByFile.get(type.file) ?? [];
    list.push(type);
    typesByFile.set(type.file, list);
  }
  const result = new Set<string>();
  for (const [file, ranges] of Object.entries(changedLines)) {
    const types = typesByFile.get(file);
    if (types === undefined || ranges.length === 0) {
      continue;
    }
    types.sort((a, b) => a.startLine - b.startLine);
    // maxEnd[i]: the greatest end line among types[0..i].
    const maxEnd: number[] = [];
    let max = Number.NEGATIVE_INFINITY;
    for (const type of types) {
      max = Math.max(max, type.endLine);
      maxEnd.push(max);
    }
    const inside = (range: ChangedLineRange): boolean => {
      const low = Math.min(range.start, range.end);
      const high = Math.max(range.start, range.end);
      // The last type starting at or before `low`; some type up to it
      // contains the range exactly when their greatest end reaches `high`.
      let lo = 0;
      let hi = types.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (types[mid]!.startLine <= low) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      return lo > 0 && (maxEnd[lo - 1] ?? Number.NEGATIVE_INFINITY) >= high;
    };
    if (ranges.every(inside)) {
      result.add(file);
    }
  }
  return result;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// P4-6: Graph Service operation result shapes (AD-13).
//
// AD-13: each Graph Service operation's shape is defined once, here, and
// consumed unchanged by both transports — IPC (`@driller/ipc-contracts`
// re-exports every type below) and MCP (`services/graph-service/
// mcp-server.ts`/`index.ts` import them). The six operation result types are
// `PathTraceResult` (above), `NodeLookupResult`, `CoverageSummaryResult`,
// `IndexCoverageSummary`, `DiffScopeResult` and `BlastRadiusExpansionResult`;
// `contractHome.test.ts` fails if any other non-test source under `apps/`,
// `packages/` or `services/` declares one of them instead of importing or
// re-exporting it.
//
// Structural dependencies moved with them (P4-6's rule: a graph shape moves,
// anything else gets a minimal structural shape here):
//  - `GapFile` (carried by `IndexCoverageSummary`) — a coverage graph shape,
//    moved.
//  - `CodeMapNode` (carried by `NodeLookupResult`) — the Node shape itself,
//    moved, with its own closure: `CodeMapNodeKind`, `SummaryStatus` and the
//    Risk Signal family types. Not a minimal structural stand-in:
//    `lookup_node` returns the full Node, so a narrower shape would change
//    its type.
//  - `CodeMapEdge`/`CodeMapEdgeKind` — no result type references them, but
//    they are graph shapes, so they moved beside `CodeMapNode`.
//
// Still no dependency on `@driller/ipc-contracts` or any other package.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 2: coverage/scale transparency (FR2, NFR1, AD-15).
//
// Sourced entirely from the real backend's own `index_repository`/
// `index_status` reporting — driller never re-derives or infers coverage
// locally. `parse_partial`/`skipped` files are the only genuine coverage
// gaps; `not_indexed` (gitignore/skip-list exclusions) is by-design and MUST
// NOT be surfaced here. The follow-up `index_status` call that supplies
// `gapPaths` is best-effort: if it fails, `coverage` is omitted from the
// `indexed` message entirely rather than posting a partial summary.
//
// `expectedNodes`/`expectedEdges` are optional enrichment, not a gate:
// live testing found the backend's MCP `index_repository` response
// intermittently omits them even on an otherwise-healthy call, while
// `skippedCount`/`parsePartialCount` (the fields that actually determine a
// genuine gap) are always present. Requiring the expected-count fields
// before building `coverage` at all made the summary vanish on healthy
// runs — see mcp-client.ts's `fetchCoverage` and this spec's Design Notes.
// ---------------------------------------------------------------------------

/**
 * One coverage-gap file from the `index_status` follow-up call, tagged with
 * which kind of gap it is. `skipped` (not indexed at all) and `parse_partial`
 * (indexed, but tree-sitter's error recovery may have missed some constructs)
 * are meaningfully different severities — Story 1.3's per-Node rendering is
 * expected to show them differently, so this story preserves the distinction
 * through the wire rather than flattening it into an undifferentiated
 * `string[]`.
 */
export interface GapFile {
  /**
   * The gap file's path exactly as `index_status` reported it. Documented
   * here as "absolute" when this shape was first introduced, but Story 1.5
   * Phase 2's live verification against the real backend found it actually
   * reporting a bare project-relative path (e.g. `"broken.js"`, matching
   * `CodeMapNode.file`'s own format directly) for at least one real
   * build/invocation shape — never trust this field's absoluteness without
   * checking `path.isAbsolute()` first (see `toProjectRelativePosixPath` in
   * `services/graph-service/index.ts`, this contract's one real consumer).
   */
  path: string;
  /** Which kind of coverage gap this file is. */
  kind: 'skipped' | 'parse_partial';
}

export interface IndexCoverageSummary {
  /**
   * Node count the backend expected to produce for a fully-covered index.
   * Optional enrichment — present only when the backend's response happens
   * to include it; never required to produce a `coverage` object at all.
   */
  expectedNodes?: number;
  /**
   * Edge count the backend expected to produce for a fully-covered index.
   * Optional enrichment — same caveat as `expectedNodes`.
   */
  expectedEdges?: number;
  /** Count of files the backend skipped outright (a genuine coverage gap). */
  skippedCount: number;
  /** Count of files the backend could only partially parse (a genuine coverage gap). */
  parsePartialCount: number;
  /**
   * The `parse_partial`/`skipped` gap files from the `index_status`
   * follow-up call, each tagged with its `kind`. Wired through for Story
   * 1.3's Code Map to render per-Node — this story does not render them
   * itself.
   */
  gapPaths: GapFile[];
}

/** The map-eligible Node labels (Design Notes — a judgment call, not fixed by the backend's schema). */
export type CodeMapNodeKind = 'Function' | 'Interface' | 'Type' | 'Module';

/**
 * A Node's summary-generation state (Story 1.5 Phase 2):
 *  - 'pending': eligible for generation (resolvable source, no coverage
 *    gap) but generation hasn't completed for it yet — renders a
 *    lightweight "summary pending" state, never a confident-looking
 *    placeholder.
 *  - 'ready': `summary` carries the generated one-line plain-language text.
 *  - 'coverage-gap': this Node's file is in the current index's coverage
 *    gap set (FR5) — ineligible for generation entirely; renders a real,
 *    distinct coverage-gap indicator (icon+text, never color-only), never a
 *    summary.
 */
export type SummaryStatus = 'pending' | 'ready' | 'coverage-gap';

// ---------------------------------------------------------------------------
// Story 2.1 (Phase 1): deterministic risk signals (FR7, AD-9 corrected).
// Story 2.2 (Phase 1): `RiskSignal` splits into a discriminated union —
// `DeterministicRiskSignal` (renamed from the former single `RiskSignal`
// interface, no field changes) and the new `LlmJudgmentRiskSignal` — so the
// qualitative `'llm-judgment'` family (FR8) has a shape to persist into and
// render, distinct from a deterministic signal's mandatory numeric `value`.
//
// `RiskSignalFamily` is deliberately its own union rather than a bare string
// literal inlined on each signal interface — Epic 2's third family
// (`ingested`, Story 2.3) extends this union as a sibling member later,
// never redefine/compete with it (Consistency Conventions).
// `DeterministicRiskSignalType` is likewise extensible: Phase 2 adds
// `'test-coverage-gap'` as a fifth sibling member.
//
// Every `RiskSignal` carries its own `location` — for this phase, always the
// owning Node's own `{file, startLine, endLine}` range (a duplicate of the
// Node's own fields, degenerate here but required by the Consistency
// Conventions table, since later families may report a narrower location
// than their owning Node's full range).
//
// Complexity/cognitive-complexity and hotspot values are sourced only from
// `codebase-memory-mcp`'s own already-computed per-Node/per-File properties
// (see mcp-client.ts's extended `CODE_MAP_NODES_QUERY`) — never a new
// tree-sitter parsing pass or `git log` shell-out. Blast radius is computed
// live via `@driller/graph-contracts`'s `computeBlastRadius`, a cycle-safe
// BFS over the Code Map's already-fetched edges. All four are recomputed on
// every `getCodeMap` fetch — none persisted to `node-record-store.ts`
// (Boundaries & Constraints), and reproducible: re-fetching against
// unchanged repo state yields byte-identical `riskSignals` (FR7).
// ---------------------------------------------------------------------------

/** The Risk Overlay's three signal families (Epic 2) — Story 2.3 (Phase 1) adds `'ingested'`, the last of the three. */
export type RiskSignalFamily = 'deterministic' | 'llm-judgment' | 'ingested';

/**
 * Review round (patch): factored out of `DeterministicRiskSignal`/
 * `LlmJudgmentRiskSignal` — before this phase there was one `RiskSignal`
 * interface with one `location` field; the union split would otherwise leave
 * two independent inline copies of this same shape to keep in sync by hand.
 */
export interface RiskSignalLocation {
  file: string;
  startLine: number;
  endLine: number;
}

/**
 * Deterministic risk signal types (Story 2.1 Phase 1; Phase 2 adds
 * `'test-coverage-gap'` as a fifth sibling member, never a competing type).
 *
 * `'test-coverage-gap'` (Story 2.1 Phase 2, FR7) — a Node whose `[startLine,
 * endLine]` range has zero covered lines per a hand-parsed
 * `coverage/lcov.info` (see `services/graph-service/lcov.ts`). This is
 * distinct from `SummaryStatus`'s unrelated `'coverage-gap'` member, which
 * means indexing/parse coverage (FR-2/FR-5) — the two are unrelated
 * concepts that happen to share the word "coverage"; never conflate them.
 */
export type DeterministicRiskSignalType =
  | 'complexity'
  | 'cognitive-complexity'
  | 'hotspot'
  | 'blast-radius'
  | 'test-coverage-gap';

/**
 * One deterministic risk signal attached to a `CodeMapNode`. A Node with no
 * data for a given signal (e.g. zero complexity data for an unsupported
 * grammar) simply omits that entry from `riskSignals` — never a signal with
 * an undefined/null `value` standing in for "absent" (AD-13's explicit-
 * result-state pattern applied at the array level: absence is expressed by
 * omission from the array, not by a placeholder entry).
 *
 * Story 2.2 (Phase 1): this was formerly the single `RiskSignal` interface,
 * renamed here as part of `RiskSignal`'s split into a discriminated union —
 * every already-shipped Story 2.1 consumer keeps behaving identically
 * against this renamed shape, though two call sites (`buildRiskSignals`'s
 * return type in `services/graph-service/index.ts`, and the import there)
 * needed a mechanical update to the new name (review round: the original
 * comment overstated this as needing zero consumer changes). The only real
 * field change is `family`'s type narrowing from the old `RiskSignalFamily`
 * union to the literal `'deterministic'`, required for discriminant
 * narrowing — not a new/removed field.
 */
export interface DeterministicRiskSignal {
  family: 'deterministic';
  type: DeterministicRiskSignalType;
  value: number;
  location: RiskSignalLocation;
  /**
   * P1-1: the triage band for `value` — `'severe'` renders red with a `!`
   * glyph and "(severe)" in its label, `'moderate'` renders amber (DESIGN.md:
   * "amber for moderate, red for severe"). `'moderate'` means only "not
   * severe": it is every value below the severe threshold, down to trivial
   * ones, and makes no claim that the value is risky (there is no neutral
   * third tier). Assigned once, in the Graph
   * Service (`risk-signals.ts`'s `assignDeterministicSeverities`), from
   * named default thresholds, so the renderer and `lookup_node` always carry
   * the same judgement (FR15). Deterministic like `value` (FR-7). Unrelated
   * to `IngestedRiskSignal.severity`, which keeps its own mapping.
   */
  severity: DeterministicRiskSeverity;
}

/** P1-1: see `DeterministicRiskSignal.severity`. No neutral third tier. */
export type DeterministicRiskSeverity = 'moderate' | 'severe';

/**
 * Story 2.2 (Phase 1): the qualitative LLM-judgment risk signal (FR8) — a
 * free-text `judgment` in place of a deterministic signal's mandatory
 * numeric `value`, and no `type` (deterministic-only; see
 * `DeterministicRiskSignalType`). No `model`/`generatedAt` provenance here —
 * consistent with `CodeMapNode.summary`'s own wire shape (a bare `string`,
 * its provenance never reaches the renderer either), not an oversight.
 * `judgment` here corresponds to `NodeRecord.llmJudgment.text` on the
 * persisted side (`services/graph-service/node-record-store.ts`) — the two
 * names differ deliberately (this is the wire/render-facing shape, that one
 * follows `summary`'s own provenance-object naming) but describe the same
 * value; whoever bridges the two (Phase 2) reads `record.llmJudgment.text`
 * into this field's `judgment`. This phase only defines the shape — no code
 * yet produces one (Phase 2's job) or renders one (Phase 3's job); nothing
 * in this codebase can construct an `LlmJudgmentRiskSignal` yet.
 */
export interface LlmJudgmentRiskSignal {
  family: 'llm-judgment';
  judgment: string;
  location: RiskSignalLocation;
}

/**
 * Story 2.3 (Phase 1): a finding ingested from an external PR-review bot
 * (CodeRabbit, Qodo) — the Risk Overlay's third and final signal family
 * (FR-per epic-2-context.md). Mirrors `LlmJudgmentRiskSignal`'s shape
 * (`family` discriminant + `location`), with `severity` and `sourceTool`
 * added per the Consistency Conventions ("`ingested` signals additionally
 * carry `severity` and `sourceTool`"): every ingested finding must display
 * its originating tool and a canonical severity mapped from the source
 * tool's native scale — never passed through unmapped.
 *
 * This phase only defines the shape — no code yet produces one (Story 2.3
 * Phase 2/3's job, the actual CodeRabbit/Qodo CLI adapters) or renders one
 * (Phase 4's job). Nothing in this codebase can construct an
 * `IngestedRiskSignal` yet.
 */
export interface IngestedRiskSignal {
  family: 'ingested';
  severity: 'blocker' | 'major' | 'minor' | 'info';
  sourceTool: string;
  finding: string;
  location: RiskSignalLocation;
}

/**
 * The Risk Overlay's per-signal shape (Epic 2) — a discriminated union on
 * `family`, so each family's own fields (a deterministic signal's `value`
 * vs. an LLM-judgment signal's `judgment` vs. an ingested signal's
 * `severity`/`sourceTool`/`finding`) are only ever accessed after narrowing,
 * never assumed present across the whole union. All three families now
 * exist as of Story 2.3 (Phase 1).
 */
export type RiskSignal = DeterministicRiskSignal | LlmJudgmentRiskSignal | IngestedRiskSignal;

export interface CodeMapNode {
  /** `qualified_name` — stable node identity, shown verbatim/monospace (Always: no summary content yet). */
  id: string;
  /** `name` — the bare identifier, verbatim from source. */
  name: string;
  /** POSIX-relative path to the file this Node is defined in (AD-19). */
  file: string;
  startLine: number;
  endLine: number;
  kind: CodeMapNodeKind;
  /**
   * Populated at `getCodeMap` fetch time from the Node record store's
   * current state (Story 1.5 Phase 2) — never null/undefined standing in
   * for "not generated yet" (AD-13's broader explicit-result-state pattern).
   */
  summaryStatus: SummaryStatus;
  /** The generated one-line plain-language summary — present only when `summaryStatus === 'ready'`. */
  summary?: string;
  /**
   * Story 1.8 Phase 3: whether this Node's summary has drifted from its
   * source since generation (the record store's `NodeRecord.stale`,
   * populated at `getCodeMap` fetch time by the same `classifyNode` step
   * that populates `summaryStatus`/`summary` above). Meaningful only when
   * `summaryStatus === 'ready'` — `true` only when the record's `stale`
   * flag is actually set; absent otherwise (never a default `false`
   * standing in for "not evaluated", matching `NodeRecord.stale`'s own
   * tri-state contract).
   */
  stale?: boolean;
  /**
   * FR7's deterministic complexity/cognitive-complexity/hotspot/blast-radius
   * signals (Story 2.1, Phase 1), recomputed live on every `getCodeMap`
   * fetch. Never omitted/undefined (AD-13's explicit-result-state pattern) —
   * a Node with zero risk signals is `riskSignals: []`, not a missing field.
   */
  riskSignals: RiskSignal[];
  /**
   * P4-2 phase 2: the tests that provably exercise this Node, from real
   * backend links only (see `TestedBy`). Absent when no link was found —
   * which never means "untested": the backend's test links are incomplete.
   */
  testedBy?: TestedBy;
  /**
   * P4-2 phase 3a: what this Node's file's top-level code calls or uses —
   * the folded Module Node's own outgoing edges (see `FoldedModule`), shared
   * by every Node in the file. Absent when the file has no folded top-level
   * code, or that code uses nothing on the map.
   */
  fileTopLevel?: FileTopLevelUse[];
  /**
   * P4-2 phase 3a: the files whose top-level code calls or uses this Node —
   * the reverse of `fileTopLevel`, sorted. A Node called only at load time
   * (`main()`, route registration, init hooks) has no map caller, since
   * Module Nodes are folded; this is where that caller is named. Absent when
   * there is none.
   */
  calledAtLoadBy?: string[];
  /**
   * P4-2 phase 3b: the Type and Interface Nodes this Node uses — each from a
   * real `USAGE` edge out of this Node, never inferred from its signature
   * (`param_types`/`return_type`). Types are folded off the map (see
   * `FoldedType`), so this is where the link survives. Sorted by name, then
   * id. Absent when there is none.
   */
  usesTypes?: TypeUse[];
  /**
   * P4-2 phase 3b (review round 1): the Type and Interface Nodes this Node's
   * file's top-level code uses — the folded Module's `usesTypes` (see
   * `FoldedModule.usesTypes`), shared by every Node in the file, shown in
   * Node detail's "File top-level" row. Absent when there is none.
   */
  fileTopLevelTypes?: TypeUse[];
  /**
   * P4-2 phase 4: other production Functions, in other files, that the
   * backend's own `SIMILAR_TO` edge marks as near-duplicates of this one
   * (jaccard at least `SIMILAR_TO_MIN_JACCARD`) — see
   * `SimilarImplementation`. Structural (token overlap), never a claim they
   * behave the same, and never inferred beyond that edge. Sorted by score
   * (highest first), then name, file and id; capped at
   * `SIMILAR_TO_MAX_ENTRIES`. Absent when there is none, including on a
   * backend without `SIMILAR_TO`.
   */
  similarTo?: SimilarImplementation[];
  /** P4-2 phase 4: how many similar implementations exist before the cap. Present exactly when `similarTo` is; never below `similarTo.length`. */
  similarToTotal?: number;
}

/**
 * P4-2 phase 4: one near-duplicate of a Node — the other end of a backend
 * `SIMILAR_TO` edge. Both ends are production Functions on the Code Map, in
 * different files. `id` is a Code Map Node id (navigable, resolvable via
 * `lookup_node`).
 */
export interface SimilarImplementation {
  id: string;
  name: string;
  /** POSIX-relative path of its file — never the Node's own file. */
  file: string;
  /** The backend's `SIMILAR_TO.jaccard` token-overlap score, 0–1; at least `SIMILAR_TO_MIN_JACCARD`. */
  score: number;
}

/** P4-2 phase 4: the lowest `SIMILAR_TO.jaccard` shown as a similar implementation. */
export const SIMILAR_TO_MIN_JACCARD = 0.9;

/** P4-2 phase 4: the most `CodeMapNode.similarTo` entries carried per Node (and returned by `lookup_node`); `similarToTotal` is the full count. */
export const SIMILAR_TO_MAX_ENTRIES = 20;

/** P4-2 phase 3b: the Code Map Node kinds folded off the map as contracts (`FoldedType`). */
export type FoldedTypeKind = Extract<CodeMapNodeKind, 'Type' | 'Interface'>;

/** P4-2 phase 3b: one folded Type/Interface a Node uses (`CodeMapNode.usesTypes`); `id` resolves via `lookup_node`. */
export interface TypeUse {
  id: string;
  name: string;
  kind: FoldedTypeKind;
}

/**
 * P4-2 phase 3b: a Type or Interface Node, folded off the Code Map. Its
 * complexity is always 0 and it is a pure sink (only `USAGE` edges into it),
 * so it is not a map Node: its edges don't count toward adjacency, blast
 * radius, severity, Health Audit or Path Trace. Who depends on it is kept
 * here, keyed by id, for Node detail's "Uses" / type detail's "Used by" and
 * `lookup_node`. Every link comes from a real backend edge; nothing is
 * inferred from a name or a signature.
 */
export interface FoldedType {
  /** `qualified_name`, the same stable id it had as a map Node. */
  id: string;
  name: string;
  kind: FoldedTypeKind;
  /** POSIX-relative path of its file. */
  file: string;
  startLine: number;
  endLine: number;
  /**
   * Map Node ids with a `USAGE` edge into it, sorted by id. May be capped
   * (the Code Map reply carries at most `FOLDED_TYPE_IPC_MAX_USED_BY`);
   * `usedByTotal` is always the full count.
   */
  usedBy: string[];
  /** How many map Nodes use it — the full count, whatever `usedBy` carries. */
  usedByTotal: number;
  /** `usedByTotal` broken down by the users' Node kind, most first, then by kind. */
  usedByKinds: FoldedTypeUserKindCount[];
  /**
   * Folded type ids it extends or implements (backend `IMPLEMENTS` edges),
   * sorted by id. Only Interface/Type ends are fetched: a Class implementing
   * an Interface is not, because Classes are not Code Map Nodes.
   */
  implements: string[];
  /** The reverse of `implements`: folded type ids that extend or implement it, sorted by id. */
  implementedBy: string[];
  /** Folded type ids it refers to (`USAGE` edges out of it into another folded type), sorted by id. */
  refersTo: string[];
  /** The reverse of `refersTo`: folded type ids that refer to it, sorted by id. */
  referencedByTypes: string[];
}

/** P4-2 phase 3b: how many of a folded type's users are of one Node kind. */
export interface FoldedTypeUserKindCount {
  kind: CodeMapNodeKind;
  count: number;
}

/** P4-2 phase 3b: `lookup_node`'s cap on a folded type's `usedBy` ids; `usedByTotal` gives the full count. */
export const FOLDED_TYPE_LOOKUP_MAX_USED_BY = 50;

/** P4-2 phase 3b (review round 1): the Code Map reply's cap on each folded type's `usedBy` ids. */
export const FOLDED_TYPE_IPC_MAX_USED_BY = 200;

/**
 * P4-2 phase 3a: one thing a file's top-level code calls or uses — the
 * target of a real `CALLS`/`USAGE` edge out of the file's Module Node, never
 * a name match. `id` is a Code Map Node id within the indexing scope.
 * `IMPORTS` is in `CodeMapEdgeKind` but the Code Map edge query never
 * returns it today (every backend IMPORTS edge starts at a File node);
 * consumers still handle it ("imported").
 */
export interface FileTopLevelUse {
  id: string;
  kind: CodeMapEdgeKind;
}

/**
 * P4-2 phase 3a: a file's Module Node(s), folded off the Code Map. A Module
 * is the file's top-level code (complexity always 0, a pure edge source), so
 * it is not a map Node: its edges don't count toward adjacency, blast
 * radius, severity or Path Trace, and a changed Module is not a changed
 * Node. What it calls or uses is kept here, keyed by file, for Node detail's
 * "File top-level" section and `lookup_node`.
 */
export interface FoldedModule {
  /** POSIX-relative path of the file. */
  file: string;
  /** The folded Module Node ids (backend `qualified_name`s) for this file, sorted; usually one. */
  moduleIds: string[];
  /** The Modules' combined range: the file's top-level code, for the source viewer. */
  startLine: number;
  endLine: number;
  /** Distinct targets, `CALLS` before `USAGE`/`IMPORTS`, then by id. A target reached both ways is listed once, as `CALLS`. */
  uses: FileTopLevelUse[];
  /**
   * P4-2 phase 3b (review round 1): the folded Type/Interface Nodes this
   * file's top-level code uses, moved out of `uses` when types were folded
   * (so `uses` names only map Nodes). Sorted by name, then id. Absent when
   * there is none.
   */
  usesTypes?: TypeUse[];
}

/** P4-2 phase 3a: a changed file whose only map content is folded top-level code (see `findTopLevelOnlyChangedFiles`). */
export type TopLevelChangedFile = Pick<FoldedModule, 'file' | 'startLine' | 'endLine'>;

/**
 * P4-2 phase 2: one test that directly calls a Node through an
 * import-resolved `CALLS` edge. Tests are not map Nodes (`lookup_node`
 * returns not-found for their ids), so this carries the source range the
 * in-app source viewer opens at, not a map id to navigate to.
 */
export interface TestedByTest {
  /** The test's backend `qualified_name`. */
  id: string;
  /** The test function's name; for a `topLevel` entry, the test file's base name. */
  name: string;
  /** POSIX-relative path of the test file. */
  file: string;
  /** Range to open in the source viewer: the test function's range, or the call's own line for a `topLevel` entry. */
  startLine: number;
  endLine: number;
  /** The call is made at the test file's top level (e.g. inside `test(...)`), not from a named test function. */
  topLevel?: true;
}

/**
 * P4-2 phase 2: a test file linked to a Node's own file by `TESTS_FILE`.
 * The range is the whole test file, taken from its Module Node; absent when
 * the index has no Module for it, in which case the file can't be opened.
 */
export interface TestedByFile {
  /** POSIX-relative path of the test file. */
  file: string;
  startLine?: number;
  endLine?: number;
}

/**
 * P4-2 phase 2: "Tested by" evidence for a production Node. Only two sources
 * count, never a bare name match: test→production `CALLS` edges the backend
 * resolved through an import (`tests`), and `TESTS_FILE` File→File edges
 * into the Node's own file (`files`). The absence of evidence means "no
 * link found", never "untested".
 */
export interface TestedBy {
  /** Direct callers, sorted by file then line, capped at `TESTED_BY_MAX_TESTS`. */
  tests: TestedByTest[];
  /** How many distinct tests directly call this Node, before the cap. Never below `tests.length`. */
  totalTests: number;
  /** Test files linked to this Node's file by `TESTS_FILE`, sorted by path. */
  files: TestedByFile[];
}

/** P4-2 phase 2: the most `TestedBy.tests` entries carried per Node. */
export const TESTED_BY_MAX_TESTS = 20;

/** The call/dependency edge kinds rendered on the Code Map (FR4) — never a containment edge. */
export type CodeMapEdgeKind = 'CALLS' | 'IMPORTS' | 'USAGE';

/**
 * A Code Map edge (Story 1.3, FR4). P4-6: moved here beside `CodeMapNode`
 * as a graph shape; `@driller/ipc-contracts` re-exports it.
 */
export interface CodeMapEdge {
  /** Source Node's `id` (`qualified_name`). */
  source: string;
  /** Target Node's `id` (`qualified_name`). */
  target: string;
  kind: CodeMapEdgeKind;
}

/**
 * Node lookup's explicit result-state union (AD-13: `null`/`undefined` must
 * never stand in for "nothing here"). Returned by `services/graph-service/
 * mcp-server.ts`'s `lookupNode` for the `lookup_node` MCP tool; there is no
 * IPC channel for it yet (a separate parity gap, not part of P4-6). Mirrors
 * `RegenerateNodeResult`'s own `{status: 'ok', node} | {status: 'error',
 * message}` shape, with a third `'not-found'` state for a syntactically valid
 * but unknown `nodeId` — a distinct case from "no project indexed yet" (both
 * would otherwise collapse into the same generic error).
 */
export type NodeLookupResult =
  | { status: 'ok'; node: CodeMapNode }
  /**
   * P4-2 phase 3a: `nodeId` is a Module Node folded into its file (see
   * `FoldedModule`): it resolves (never `'not-found'`), but there is no map
   * Node for it. Its own `status: 'folded'` keeps a client written against
   * `'ok'` (which reads `.node`) from mistaking it for a Node — such a client
   * falls into its default branch instead. `folded: true` is deliberately
   * redundant (the spec's marker); narrow on `status === 'folded'`.
   */
  | {
      status: 'folded';
      folded: true;
      kind: 'Module';
      nodeId: string;
      file: string;
      uses: FileTopLevelUse[];
      /** P4-2 phase 3b: the types its top-level code uses (`FoldedModule.usesTypes`); `[]` when none. */
      usesTypes: TypeUse[];
    }
  /**
   * P4-2 phase 3b: `nodeId` is a Type or Interface folded off the map (see
   * `FoldedType`) — same `status: 'folded'`, told apart from a folded Module
   * by `kind`. `usedBy` is at most `FOLDED_TYPE_LOOKUP_MAX_USED_BY` Node ids
   * (sorted by id); `usedByTotal` is the full count.
   */
  | {
      status: 'folded';
      folded: true;
      kind: FoldedTypeKind;
      nodeId: string;
      name: string;
      file: string;
      startLine: number;
      endLine: number;
      usedBy: string[];
      usedByTotal: number;
      usedByKinds: FoldedTypeUserKindCount[];
      implements: string[];
      implementedBy: string[];
      refersTo: string[];
      referencedByTypes: string[];
    }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * Coverage-check retrieval's explicit result-state union (Story 5.1, Phase 2,
 * AD-13's broader pattern). Returned by `services/graph-service/index.ts`'s
 * `getCoverageSummaryResult` for the `get_coverage_summary` MCP tool; there
 * is no IPC channel for it yet (a separate parity gap, not part of P4-6).
 *
 * `'unavailable'` is deliberately distinct from `'error'` (I/O & Edge-Case
 * Matrix): a successfully indexed project whose best-effort `index_status`
 * follow-up call failed (see `IndexCoverageSummary`'s section comment) is
 * "indexed, but no coverage summary" — a real, different case from "not
 * indexed at all" or "wrong project", never collapsed into the same generic
 * failure.
 */
export type CoverageSummaryResult =
  | { status: 'ok'; coverage: IndexCoverageSummary }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * Story 3.1 (Phase 1): the diff-scoped Node-set operation (FR11).
 *
 * `DiffScopeResult` is an explicit, enumerated result-state union (AD-13's
 * broader pattern), never null/empty standing in for "nothing changed" or
 * "couldn't compute":
 *  - `'resolved'`: `resolvedBaseRef` is always the merge-base COMMIT (never
 *    the branch/ref name that was supplied or resolved) — the exact commit
 *    `git diff --name-only` was actually run against, so what's reported and
 *    what was computed can never silently diverge (Design Notes).
 *    `nodeIds` is the diff-scoped Node set, matched via `findChangedNodeIds`.
 *  - `'no-changes'`: the resolved base ref produced an empty changed-file
 *    list — never an empty-but-unexplained `nodeIds`.
 *  - `'not-a-git-repo'`: `.git` was absent at the project root at call time
 *    (checked fresh, not cached from project-open — Design Notes) — no git
 *    subprocess call was made.
 *  - `'no-base-ref-resolvable'`: `baseRef` was omitted and
 *    `resolveDefaultBranch` found nothing (no upstream, no local
 *    `main`/`master`) — no git diff/merge-base call was made.
 *  - `'error'`: any other failure (a non-`ENOENT` subprocess failure, or an
 *    unexpected `merge-base`/`diff` result) — `message` is safe, user-facing
 *    text.
 */
export type DiffScopeResult =
  | {
      status: 'resolved';
      resolvedBaseRef: string;
      nodeIds: string[];
      /**
       * P4-2 phase 3a: changed files whose only map content is folded
       * top-level code (a `FoldedModule`, no Code Map Node) — see
       * `findTopLevelOnlyChangedFiles`. Absent when there are none. Lets a
       * top-level-only diff say what changed instead of "0 changed Nodes".
       */
      topLevelFiles?: TopLevelChangedFile[];
      /**
       * P4-2 phase 3c: the folded Types/Interfaces whose own lines the diff
       * changed, with the map Nodes that use them (`findChangedContracts`).
       * Absent when there are none. A changed contract is not a changed
       * Node: its dependents are affected, not changed.
       */
      changedContracts?: ChangedContract[];
      /**
       * P4-2 phase 3c: `true` when the diff's line ranges couldn't be read
       * for some changed file holding types, so every type in it counted
       * (`ChangedContractsResult.approximate`). Absent otherwise.
       */
      changedContractsApproximate?: true;
    }
  | { status: 'no-changes' }
  | { status: 'not-a-git-repo' }
  | { status: 'no-base-ref-resolvable' }
  | { status: 'error'; message: string };

/**
 * Story 3.2 (Phase 1): multi-Node blast radius hop distances (FR12).
 *
 * `BlastRadiusExpansionResult` is an explicit, enumerated result-state union
 * (AD-13's broader pattern), never null/empty standing in for "nothing
 * reachable" or "couldn't compute":
 *  - `'resolved'`: `hopDistances` maps every reachable Node's id to its
 *    minimum hop distance from the nearest seed in the request's `nodeIds`
 *    (seed Nodes themselves excluded — Always). A plain
 *    `Record<string, number>`, not a `Map`, to keep this result JSON-shaped
 *    like every other IPC result — the Graph Service converts
 *    `computeBlastRadiusHopDistances`'s `Map` return value to this shape
 *    before posting it back. An empty `nodeIds` request (or one whose every
 *    seed id is stale) resolves with an empty `hopDistances` object, not an
 *    error.
 *  - `'error'`: the expansion couldn't even be attempted (no project indexed
 *    yet, the requested project isn't the currently active one, or it
 *    changed mid-computation) — `message` is safe, user-facing text, mirrors
 *    `DiffScopeResult`'s own `'error'` variant.
 */
export type BlastRadiusExpansionResult =
  | { status: 'resolved'; hopDistances: Record<string, number> }
  | { status: 'error'; message: string };
