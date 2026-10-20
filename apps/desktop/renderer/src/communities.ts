/**
 * Communities on the Code Map: which Nodes actually belong together,
 * computed from the call graph rather than read off the folder layout.
 *
 * Why this is computed and not fetched. The indexing backend
 * (`codebase-memory-mcp`) does run Leiden community detection, but only
 * inside its `get_architecture` tool, and what that returns cannot
 * partition a map: there is no `cluster`/`community` property on any node in
 * the graph schema, each cluster carries only five representative
 * `top_nodes`, the list is capped (12 clusters covering about 4% of the
 * nodes on a 27,000-node repository), and the labels are top-level folder
 * names that collide — four separate clusters named `api` on that same
 * repository. Grouping by folder is what Health Audit already does. Driller
 * also calls the backend only through `query_graph`, never a named tool, so
 * reading that output would be a new transport and a new parser for data
 * that still would not cover the map.
 *
 * Computing it here costs nothing extra: the renderer is already handed
 * every Node and every CALLS/USAGE edge, so this is a pure function over
 * data in hand, with no backend capability to depend on and nothing new to
 * degrade when a backend lacks it.
 *
 * A community is NOT an LOD cluster and NOT a Health Audit cluster. AD-2's
 * rule still holds and is why this lives in the renderer: a community id is
 * renderer-local and must never flow into a Graph Service call. It is a
 * layout fact only — it never feeds a risk signal, a blast radius, Path
 * Trace or a diff-scoped set, exactly as the Revealed view never does.
 *
 * Deterministic: nodes are visited in sorted-id order and every tie breaks
 * on id, so the same graph always gives the same partition whatever order it
 * arrives in. That is what makes a golden test possible.
 */

/** The least a Node needs for the partition: its id, and a name to label a community with. */
export interface CommunityInputNode {
  id: string;
  name: string;
}

/** A directed edge. Direction is kept for fan-in (labelling) and dropped for the partition itself. */
export interface CommunityInputEdge {
  source: string;
  target: string;
}

/**
 * The community holding every Node with no call edge at all. Named for what
 * is true of its members and qualified the way every other reach claim in
 * the app is: driller can only speak for the code it indexed.
 */
export const UNREFERENCED_COMMUNITY_ID = 'community:unreferenced';
export const UNREFERENCED_COMMUNITY_LABEL = 'unreferenced in indexed code';

/**
 * Below this many Nodes with call edges, the map is not partitioned at all:
 * every connected Node forms one community, laid out by call depth.
 *
 * Grouping only earns its place when a map is too big to take in at once. A
 * map of a few dozen cards already fits one screen at a readable zoom, and
 * modularity — what Louvain maximizes — is a poor objective at that size: on
 * the seven-Node `path-trace-basic` fixture it splits a single connected
 * call graph of five into {serviceB, repository, cacheLookup} and
 * {handleRequest, serviceA}, which puts a caller in a different block from
 * the callees it calls. One block of columns is both truer and more useful
 * there. Nodes with no call edge at all are still held out separately
 * whatever the size — that is a statement about them, not a grouping choice.
 */
export const MIN_NODES_TO_PARTITION = 40;

/**
 * A community below this many members is merged into whichever community it
 * calls, or is called by, most.
 *
 * Real call graphs are sparse and leaf-heavy: on driller's own repository the
 * commonest Function-to-Function degree is 1 (565 of them), then 2 (399).
 * Maximizing modularity over a graph like that — and modularity's resolution
 * limit works against small groups — leaves a long tail of two- and
 * three-member communities, and a canvas of several hundred two-card blocks
 * is no more readable than the grid it replaced.
 *
 * Merging is not a fudge: a leaf with one caller genuinely belongs with that
 * caller, which is the call relationship the map exists to show. A small
 * community with no neighbour at all is left alone — it really is an island,
 * and saying so is honest.
 */
export const MIN_COMMUNITY_MEMBERS = 4;

export interface GraphCommunity {
  /** Renderer-local, derived from the community's own representative Node — never sent to the Graph Service. */
  id: string;
  /**
   * The community's own highest-fan-in member's real identifier, never an
   * invented name and never a folder name (EXPERIENCE.md's voice rule: real
   * identifiers, real module paths).
   */
  label: string;
  /** Sorted, so the layout that consumes it never depends on input order. */
  memberIds: readonly string[];
  /** Edges with both ends inside this community. */
  internalEdges: number;
  /** Edges with exactly one end inside it. */
  externalEdges: number;
  /** `internalEdges / (internalEdges + externalEdges)`, or 0 when it has no edges. */
  cohesion: number;
}

/** One community's call traffic into another — what the canvas draws between two community cards. */
export interface CommunityLink {
  sourceCommunityId: string;
  targetCommunityId: string;
  count: number;
}

export interface CommunityPartition {
  /** Largest first, then by id. The unreferenced community, when it exists, is always last. */
  communities: readonly GraphCommunity[];
  communityOfNode: ReadonlyMap<string, string>;
  links: readonly CommunityLink[];
}

export const EMPTY_COMMUNITY_PARTITION: CommunityPartition = {
  communities: [],
  communityOfNode: new Map(),
  links: [],
};

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One level of the Louvain graph: symmetric weights between distinct nodes, plus each node's own self-weight. */
interface Level {
  size: number;
  adjacency: Map<number, number>[];
  selfWeight: number[];
}

function levelDegrees(level: Level): { degree: number[]; totalWeight2: number } {
  const degree = new Array<number>(level.size).fill(0);
  let totalWeight2 = 0;
  for (let node = 0; node < level.size; node += 1) {
    let sum = 2 * level.selfWeight[node]!;
    for (const weight of level.adjacency[node]!.values()) {
      sum += weight;
    }
    degree[node] = sum;
    totalWeight2 += sum;
  }
  return { degree, totalWeight2 };
}

/**
 * Louvain local moving: each node starts alone, then every node in index
 * order moves to whichever neighbouring community gives the largest
 * modularity gain, until a full pass moves nothing. Ties go to the lowest
 * community index, and index order is sorted-id order, so this is
 * deterministic.
 */
function localMoving(level: Level): number[] {
  const { degree, totalWeight2 } = levelDegrees(level);
  const community = Array.from({ length: level.size }, (_unused, index) => index);
  if (totalWeight2 === 0) {
    return community;
  }
  const communityDegree = [...degree];
  let moved = true;
  let passes = 0;
  // Louvain converges in a handful of passes; the bound only stops a
  // pathological oscillation from hanging the renderer.
  const maxPasses = 32;
  while (moved && passes < maxPasses) {
    moved = false;
    passes += 1;
    for (let node = 0; node < level.size; node += 1) {
      const own = community[node]!;
      const nodeDegree = degree[node]!;
      communityDegree[own] = communityDegree[own]! - nodeDegree;
      const weightTo = new Map<number, number>();
      weightTo.set(own, 0);
      for (const [neighbour, weight] of level.adjacency[node]!) {
        const neighbourCommunity = community[neighbour]!;
        weightTo.set(neighbourCommunity, (weightTo.get(neighbourCommunity) ?? 0) + weight);
      }
      let best = own;
      let bestGain = -Infinity;
      for (const candidate of [...weightTo.keys()].sort((a, b) => a - b)) {
        const gain = weightTo.get(candidate)! - (communityDegree[candidate]! * nodeDegree) / totalWeight2;
        if (gain > bestGain) {
          bestGain = gain;
          best = candidate;
        }
      }
      communityDegree[best] = communityDegree[best]! + nodeDegree;
      if (best !== own) {
        community[node] = best;
        moved = true;
      }
    }
  }
  return community;
}

/** Renumbers communities by their lowest member index, so the numbering never depends on iteration order. */
function renumber(community: readonly number[]): { mapped: number[]; count: number } {
  const order = new Map<number, number>();
  for (const label of community) {
    if (!order.has(label)) {
      order.set(label, order.size);
    }
  }
  return { mapped: community.map((label) => order.get(label)!), count: order.size };
}

/** Collapses each community of `level` into a single node, summing the weights between them. */
function aggregate(level: Level, community: readonly number[], count: number): Level {
  const adjacency = Array.from({ length: count }, () => new Map<number, number>());
  const selfWeight = new Array<number>(count).fill(0);
  for (let node = 0; node < level.size; node += 1) {
    const from = community[node]!;
    selfWeight[from] = selfWeight[from]! + level.selfWeight[node]!;
    for (const [neighbour, weight] of level.adjacency[node]!) {
      const to = community[neighbour]!;
      if (from === to) {
        // Each undirected pair is seen twice; a self-loop carries half the summed weight.
        selfWeight[from] = selfWeight[from]! + weight / 2;
      } else {
        adjacency[from]!.set(to, (adjacency[from]!.get(to) ?? 0) + weight);
      }
    }
  }
  return { size: count, adjacency, selfWeight };
}

/**
 * Folds every community under `MIN_COMMUNITY_MEMBERS` into the community it
 * shares most edges with, smallest first, until none is left that has a
 * neighbour to join. Mutates `membersByLabel` and `labelOfIndex`.
 *
 * Deterministic: the merge order is by size then label, and the chosen
 * neighbour is the one with the most shared edges, breaking ties on the
 * larger community and then the lower label.
 */
function mergeSmallCommunities(
  membersByLabel: Map<number, number[]>,
  labelOfIndex: Map<number, number>,
  directed: readonly { from: number; to: number }[],
): void {
  const between = new Map<number, Map<number, number>>();
  const add = (a: number, b: number) => {
    const row = between.get(a);
    if (row === undefined) {
      between.set(a, new Map([[b, 1]]));
    } else {
      row.set(b, (row.get(b) ?? 0) + 1);
    }
  };
  for (const { from, to } of directed) {
    const fromLabel = labelOfIndex.get(from);
    const toLabel = labelOfIndex.get(to);
    if (fromLabel === undefined || toLabel === undefined || fromLabel === toLabel) {
      continue;
    }
    add(fromLabel, toLabel);
    add(toLabel, fromLabel);
  }

  // Each merge can only reduce the community count, so this terminates.
  for (;;) {
    const small = [...membersByLabel.entries()]
      .filter(([label, members]) => members.length < MIN_COMMUNITY_MEMBERS && (between.get(label)?.size ?? 0) > 0)
      .sort((a, b) => a[1].length - b[1].length || a[0] - b[0])[0];
    if (small === undefined) {
      return;
    }
    const [label, members] = small;
    const neighbours = between.get(label)!;
    const target = [...neighbours.entries()].sort(
      (a, b) =>
        b[1] - a[1] ||
        (membersByLabel.get(b[0])?.length ?? 0) - (membersByLabel.get(a[0])?.length ?? 0) ||
        a[0] - b[0],
    )[0]![0];

    membersByLabel.get(target)!.push(...members);
    membersByLabel.delete(label);
    for (const index of members) {
      labelOfIndex.set(index, target);
    }
    // Re-point this community's edge counts at the one it joined.
    const targetRow = between.get(target)!;
    targetRow.delete(label);
    for (const [other, count] of neighbours) {
      if (other === target) {
        continue;
      }
      const otherRow = between.get(other)!;
      otherRow.delete(label);
      otherRow.set(target, (otherRow.get(target) ?? 0) + count);
      targetRow.set(other, (targetRow.get(other) ?? 0) + count);
    }
    between.delete(label);
  }
}

/**
 * The partition of `nodes` by `edges`. Nodes with no edge at all go to
 * `UNREFERENCED_COMMUNITY_ID` rather than becoming singleton communities
 * that would read as modules; every other Node lands in exactly one
 * community. Self-calls and edges naming a Node outside `nodes` are ignored,
 * and a repeated edge counts once — the partition describes which Nodes call
 * each other, not how often.
 */
export function detectCommunities(
  nodes: readonly CommunityInputNode[],
  edges: readonly CommunityInputEdge[],
): CommunityPartition {
  if (nodes.length === 0) {
    return EMPTY_COMMUNITY_PARTITION;
  }
  const sorted = [...nodes].sort((a, b) => compareIds(a.id, b.id));
  const indexOf = new Map<string, number>();
  sorted.forEach((node, index) => indexOf.set(node.id, index));

  // Deduped undirected pairs for the partition, and directed fan-in for labels.
  const pairs = new Set<string>();
  const fanIn = new Array<number>(sorted.length).fill(0);
  const directed: { from: number; to: number }[] = [];
  for (const edge of edges) {
    const from = indexOf.get(edge.source);
    const to = indexOf.get(edge.target);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    fanIn[to] = fanIn[to]! + 1;
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (pairs.has(key)) {
      continue;
    }
    pairs.add(key);
    directed.push({ from, to });
  }

  const adjacency = Array.from({ length: sorted.length }, () => new Map<number, number>());
  for (const key of pairs) {
    const [left, right] = key.split(':').map(Number) as [number, number];
    adjacency[left]!.set(right, 1);
    adjacency[right]!.set(left, 1);
  }

  const connected: number[] = [];
  const unreferenced: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    (adjacency[index]!.size > 0 ? connected : unreferenced).push(index);
  }

  // Louvain runs over the connected nodes alone, renumbered 0..k-1 in sorted order.
  const localOf = new Map<number, number>();
  connected.forEach((index, local) => localOf.set(index, local));
  let level: Level = {
    size: connected.length,
    adjacency: connected.map(
      (index) =>
        new Map(
          [...adjacency[index]!.entries()]
            .filter(([neighbour]) => localOf.has(neighbour))
            .map(([neighbour, weight]) => [localOf.get(neighbour)!, weight]),
        ),
    ),
    selfWeight: new Array<number>(connected.length).fill(0),
  };

  // Below the floor every connected Node is one community — see
  // `MIN_NODES_TO_PARTITION`. Louvain is skipped rather than overridden, so a
  // small map never pays for it either.
  let assignment = Array.from({ length: connected.length }, (_unused, index) =>
    connected.length < MIN_NODES_TO_PARTITION ? 0 : index,
  );
  if (connected.length >= MIN_NODES_TO_PARTITION) {
    let levels = 0;
    const maxLevels = 16;
    while (level.size > 1 && levels < maxLevels) {
      levels += 1;
      const { mapped, count } = renumber(localMoving(level));
      if (count === level.size) {
        break;
      }
      assignment = assignment.map((label) => mapped[label]!);
      level = aggregate(level, mapped, count);
    }
  }

  // Group the connected nodes, then label and order the communities.
  const membersByLabel = new Map<number, number[]>();
  connected.forEach((index, local) => {
    const label = assignment[local]!;
    const members = membersByLabel.get(label);
    if (members === undefined) {
      membersByLabel.set(label, [index]);
    } else {
      members.push(index);
    }
  });

  const labelOfIndex = new Map<number, number>();
  connected.forEach((index, local) => labelOfIndex.set(index, assignment[local]!));
  mergeSmallCommunities(membersByLabel, labelOfIndex, directed);

  const communityOfIndex = new Map<number, string>();
  const built: GraphCommunity[] = [];
  for (const members of membersByLabel.values()) {
    // The representative — and so the label and the id — is the highest
    // fan-in member, id breaking the tie.
    const representative = [...members].sort(
      (a, b) => fanIn[b]! - fanIn[a]! || compareIds(sorted[a]!.id, sorted[b]!.id),
    )[0]!;
    const id = `community:${sorted[representative]!.id}`;
    const memberIds = members.map((index) => sorted[index]!.id).sort(compareIds);
    for (const index of members) {
      communityOfIndex.set(index, id);
    }
    built.push({
      id,
      label: sorted[representative]!.name,
      memberIds,
      internalEdges: 0,
      externalEdges: 0,
      cohesion: 0,
    });
  }

  const byId = new Map(built.map((community) => [community.id, community]));
  const linkCounts = new Map<string, CommunityLink>();
  for (const { from, to } of directed) {
    const fromId = communityOfIndex.get(from);
    const toId = communityOfIndex.get(to);
    if (fromId === undefined || toId === undefined) {
      continue;
    }
    if (fromId === toId) {
      byId.get(fromId)!.internalEdges += 1;
      continue;
    }
    byId.get(fromId)!.externalEdges += 1;
    byId.get(toId)!.externalEdges += 1;
    const key = `${fromId}\u0000${toId}`;
    const existing = linkCounts.get(key);
    if (existing === undefined) {
      linkCounts.set(key, { sourceCommunityId: fromId, targetCommunityId: toId, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  for (const community of built) {
    const total = community.internalEdges + community.externalEdges;
    community.cohesion = total === 0 ? 0 : community.internalEdges / total;
  }

  const communities = built.sort(
    (a, b) => b.memberIds.length - a.memberIds.length || compareIds(a.id, b.id),
  );
  const communityOfNode = new Map<string, string>();
  for (const [index, id] of communityOfIndex) {
    communityOfNode.set(sorted[index]!.id, id);
  }
  if (unreferenced.length > 0) {
    const memberIds = unreferenced.map((index) => sorted[index]!.id).sort(compareIds);
    for (const id of memberIds) {
      communityOfNode.set(id, UNREFERENCED_COMMUNITY_ID);
    }
    communities.push({
      id: UNREFERENCED_COMMUNITY_ID,
      label: UNREFERENCED_COMMUNITY_LABEL,
      memberIds,
      internalEdges: 0,
      externalEdges: 0,
      cohesion: 0,
    });
  }

  const links = [...linkCounts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      compareIds(a.sourceCommunityId, b.sourceCommunityId) ||
      compareIds(a.targetCommunityId, b.targetCommunityId),
  );
  return { communities, communityOfNode, links };
}
