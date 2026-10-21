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
  /** Project-root-relative POSIX path, as `CodeMapNode.file` already carries it. Used to label a community. */
  file: string;
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
 * The community holding every group too small to be a module that had
 * nothing to merge into — islands of two or three Nodes that call each other
 * and nothing else in indexed code.
 *
 * Why they are pooled rather than each given a card. A real call graph's
 * community sizes have a long thin tail: on driller's own repository the
 * fourteen largest communities hold about 98% of the connected Nodes, and
 * the remaining twenty-seven hold twenty-two Nodes between them, fourteen of
 * them bare pairs. Drawing a card per island put most of the map's cards in
 * service of 2% of its code. `mergeSmallCommunities` cannot fold these away
 * — they survive precisely because they have no neighbour — so pooling is
 * what is left, and it is also the honest statement: they are not modules.
 *
 * Their calls are all internal by construction, so this community's cohesion
 * computes to 1. That figure is arithmetically true and says nothing about
 * quality — it is a bag of unrelated pairs, not a tight module — which is
 * why the label leads with what it actually is.
 */
export const ISOLATED_COMMUNITY_ID = 'community:isolated';

/**
 * A community is named after the file holding its members only when that file
 * holds at least this share of them; otherwise it keeps its hub's identifier.
 *
 * Measured, not guessed. On driller's own repository the file holding most of
 * a community's members holds a median 72% of them (up to 100%), so a file
 * names most communities well — `src/CodeMap.tsx` says far more than `get` or
 * `onClick`. On a Go API in the same graph backend the median is 27% (as low
 * as 6%), where a file label would overclaim badly: a 35-member community
 * whose biggest file holds 2 of them is not that file. The threshold is what
 * keeps the label honest on both; above it the file really is where the
 * community lives, below it the identifier is all driller can defend.
 *
 * EXPERIENCE.md's voice rule allows either — "real identifiers, real module
 * paths" — and forbids inventing a name for the group, which is why neither
 * branch ever composes one.
 */
export const COMMUNITY_FILE_LABEL_MIN_SHARE = 0.5;

/** `3 isolated groups` — the count is always stated, never "some". */
export function isolatedCommunityLabel(groupCount: number): string {
  return `${groupCount} isolated group${groupCount === 1 ? '' : 's'}`;
}

/** Fewer than this many sub-floor islands are left as they are: pooling one group into a bag of groups says less than the group did. */
export const MIN_ISOLATED_GROUPS_TO_POOL = 2;

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
 * Where two or more communities ended up with the same name, each gets its
 * hub's file added, so no two cards on the map read alike.
 *
 * This is not hypothetical. Go's constructor convention makes `New` the hub
 * of many unrelated groups: in one service measured here, three of four
 * communities were all called `New`, which tells the engineer nothing and
 * makes two of the three cards unidentifiable. The qualifier is the hub's own
 * file, so both halves are real — EXPERIENCE.md forbids inventing a name for
 * a group, not stating two true things about it.
 */
function qualifyRepeatedLabels(built: readonly GraphCommunity[], hubOf: ReadonlyMap<string, CommunityHub>): void {
  const seen = new Map<string, number>();
  for (const community of built) {
    seen.set(community.label, (seen.get(community.label) ?? 0) + 1);
  }
  for (const community of built) {
    const hub = hubOf.get(community.id);
    if (hub === undefined || (seen.get(community.label) ?? 0) < 2) {
      continue;
    }
    // The qualifier is whichever true fact the name did not already use: a
    // file named by its hub, a hub named by its file. Qualifying a file with
    // another file ("CodeMap.tsx (format.ts)") reads as two places at once.
    const qualifier = hub.usedFile ? hub.name : hub.file;
    if (qualifier !== community.label) {
      community.label = `${community.label} (${qualifier})`;
    }
  }
}

/** A community's hub, and whether its name came from the file or the hub itself. */
interface CommunityHub {
  name: string;
  file: string;
  usedFile: boolean;
}

/**
 * A community's name: the file holding most of its members when that file
 * holds at least `COMMUNITY_FILE_LABEL_MIN_SHARE` of them, otherwise the
 * hub's own identifier. Never a name driller composed itself.
 *
 * The file wins when it earns it because it identifies the group far better
 * than a generic hub does — a community centred on `get` or `onClick` says
 * nothing, where `src/revealView.ts` says where to look. Ties on the modal
 * file go to the lexicographically first path, so the choice is deterministic.
 */
function communityLabel(
  members: readonly number[],
  representative: number,
  sorted: readonly CommunityInputNode[],
): { label: string; hub: CommunityHub } {
  const counts = new Map<string, number>();
  for (const index of members) {
    const file = sorted[index]!.file;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const [file, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]))[0]!;
  const usedFile = count / members.length >= COMMUNITY_FILE_LABEL_MIN_SHARE;
  const hub = sorted[representative]!;
  return { label: usedFile ? file : hub.name, hub: { name: hub.name, file: hub.file, usedFile } };
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

  // Every island still under the floor is pooled into one community
  // (`ISOLATED_COMMUNITY_ID`), so the map's cards go to its modules rather
  // than to its tail. They take part in the edge counting below like any
  // other community, so their internal calls are still counted.
  const isolatedLabels = [...membersByLabel.entries()].filter(
    ([, members]) => members.length < MIN_COMMUNITY_MEMBERS,
  );
  const isolated: number[] = [];
  if (isolatedLabels.length >= MIN_ISOLATED_GROUPS_TO_POOL) {
    for (const [label, members] of isolatedLabels) {
      isolated.push(...members);
      membersByLabel.delete(label);
    }
  }

  // In-community in-degree: a community's hub is what its own members call
  // most, not whatever symbol is most popular across the whole map. Global
  // fan-in picked map-wide accessors (`current`, `get`) over the group's own
  // centre.
  const inCommunityFanIn = new Array<number>(sorted.length).fill(0);
  for (const { from, to } of directed) {
    const fromLabel = labelOfIndex.get(from);
    if (fromLabel !== undefined && fromLabel === labelOfIndex.get(to)) {
      inCommunityFanIn[to] = inCommunityFanIn[to]! + 1;
    }
  }

  const communityOfIndex = new Map<number, string>();
  const built: GraphCommunity[] = [];
  /** Each community's hub, for `qualifyRepeatedLabels`. */
  const hubOf = new Map<string, CommunityHub>();
  if (isolated.length > 0) {
    const memberIds = isolated.map((index) => sorted[index]!.id).sort(compareIds);
    for (const index of isolated) {
      communityOfIndex.set(index, ISOLATED_COMMUNITY_ID);
    }
    built.push({
      id: ISOLATED_COMMUNITY_ID,
      label: isolatedCommunityLabel(isolatedLabels.length),
      memberIds,
      internalEdges: 0,
      externalEdges: 0,
      cohesion: 0,
    });
  }
  for (const members of membersByLabel.values()) {
    // The representative — and so the id — is the member its own community
    // calls most, global fan-in then id breaking the tie.
    const representative = [...members].sort(
      (a, b) =>
        inCommunityFanIn[b]! - inCommunityFanIn[a]! ||
        fanIn[b]! - fanIn[a]! ||
        compareIds(sorted[a]!.id, sorted[b]!.id),
    )[0]!;
    const id = `community:${sorted[representative]!.id}`;
    const memberIds = members.map((index) => sorted[index]!.id).sort(compareIds);
    for (const index of members) {
      communityOfIndex.set(index, id);
    }
    const named = communityLabel(members, representative, sorted);
    built.push({
      id,
      label: named.label,
      memberIds,
      internalEdges: 0,
      externalEdges: 0,
      cohesion: 0,
    });
    hubOf.set(id, named.hub);
  }
  qualifyRepeatedLabels(built, hubOf);

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

  // Largest module first; the pooled islands sit after every real module,
  // whatever their combined size, and the unreferenced community after them.
  const communities = built.sort((a, b) => {
    if (a.id === ISOLATED_COMMUNITY_ID || b.id === ISOLATED_COMMUNITY_ID) {
      return a.id === ISOLATED_COMMUNITY_ID ? 1 : -1;
    }
    return b.memberIds.length - a.memberIds.length || compareIds(a.id, b.id);
  });
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
