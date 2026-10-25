/**
 * The Full map's layout: community blocks, each laid out by call depth.
 *
 * What this replaces. Full laid every card out at `layoutPosition(index,
 * count)` — a roughly square grid in the order the Nodes arrived, and
 * `CODE_MAP_NODES_QUERY` has no `ORDER BY`, so that order is whatever the
 * graph database returns. Position therefore carried no meaning: a Node's
 * callers and callees sat at unrelated coordinates, and because the canvas
 * draws an edge only when both its ends are un-clustered cards
 * (`assembleRenderedEdges`), the call structure the map exists to show was
 * mostly invisible. The level-of-detail module had the same problem by
 * construction — it buckets cards by on-screen proximity, so over an
 * index-ordered grid a collapsed cluster stood for "cards 1200–1250" and
 * meant nothing.
 *
 * What it does instead: `detectCommunities` partitions the Nodes by the call
 * graph, and each community is laid out as its own block of columns by hop
 * depth (`layeredPositions`, shared with the Revealed view). Cards that call
 * each other end up near each other, so the edges between them are drawn,
 * and a collapsed LOD cluster now covers a group that really is a group.
 *
 * Two kinds of card have no call structure to show, and are laid out in a
 * plain measured grid (`measuredGridLayout`) rather than being given a
 * structural position they have not earned: the Nodes in the unreferenced
 * community, and the render-only folded Type/Module cards.
 *
 * Split in two on purpose. `communityStructure` depends only on the Nodes
 * and edges; `communityPositions` adds React Flow's measured card sizes.
 * The canvas re-measures cards a `ResizeObserver` batch at a time, and only
 * the placement may be redone for that — re-running the partition per batch
 * would run Louvain over the whole map on every scroll.
 *
 * Boundaries. This is layout only. It never feeds a risk signal, a blast
 * radius, adjacency, Path Trace, a diff-scoped set or Health Audit — those
 * all read the full fetched map (`CanvasPopulation.riskNodes`/`riskEdges`),
 * exactly as the Revealed view leaves them alone. A community id is
 * renderer-local and never reaches a Graph Service call (AD-2).
 *
 * Pure and deterministic: the same Nodes, edges and measured sizes always
 * give the same positions, whatever order they arrive in.
 */
import {
  detectCommunities,
  EMPTY_COMMUNITY_PARTITION,
  UNREFERENCED_COMMUNITY_ID,
  type CommunityInputEdge,
  type CommunityInputNode,
  type CommunityPartition,
  type CommunityLink,
} from './communities';
import { layeredPositions, NODE_COLUMN_GAP, NODE_ROW_GAP, type LayeredCardSize } from './layered';
import { measuredGridLayout, measuredGridPosition } from './measuredGrid';

/** The clear space between one community block and the next. Wider than a column gap, so blocks read as blocks. */
export const COMMUNITY_GAP_X = 2 * NODE_COLUMN_GAP;
export const COMMUNITY_GAP_Y = 2 * NODE_ROW_GAP;

/** The block holding the render-only folded Type/Module cards — not a community. */
export const FOLDED_BLOCK_ID = 'block:folded';
export const FOLDED_BLOCK_LABEL = 'types & modules';

export interface Point {
  x: number;
  y: number;
}

/** One community's laid-out extent — what a collapsed community card stands over. */
export interface CommunityBlock {
  communityId: string;
  label: string;
  /** The cards this block lays out: its member Nodes, or just its own community card when collapsed. */
  cardIds: readonly string[];
  /** Whether this block is drawn as one community card instead of its members. */
  collapsed: boolean;
  /** How many Nodes the community holds, whether or not they are drawn. */
  memberCount: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything about the layout that does not depend on a measured card size. */
export interface CommunityStructure {
  partition: CommunityPartition;
  /** In-community callees per Node, deduped and sorted. */
  callees: ReadonlyMap<string, readonly string[]>;
  /** In-community in-degree per Node — roots, and the order within a column. */
  inDegree: ReadonlyMap<string, number>;
}

export interface CommunityPlacement {
  positions: ReadonlyMap<string, Point>;
  blocks: readonly CommunityBlock[];
}

export interface CommunityLayout extends CommunityPlacement {
  structure: CommunityStructure;
}

export const EMPTY_COMMUNITY_STRUCTURE: CommunityStructure = {
  partition: EMPTY_COMMUNITY_PARTITION,
  callees: new Map(),
  inDegree: new Map(),
};

export const EMPTY_COMMUNITY_LAYOUT: CommunityLayout = {
  structure: EMPTY_COMMUNITY_STRUCTURE,
  positions: new Map(),
  blocks: [],
};

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The partition, plus the in-community call structure the placement reads.
 * Depends on nothing measured, so the canvas memoizes it on the fetched map
 * alone.
 */
export function communityStructure(
  nodes: readonly CommunityInputNode[],
  edges: readonly CommunityInputEdge[],
): CommunityStructure {
  if (nodes.length === 0) {
    return EMPTY_COMMUNITY_STRUCTURE;
  }
  const partition = detectCommunities(nodes, edges);
  const communityOf = partition.communityOfNode;
  const callees = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const edge of edges) {
    const from = communityOf.get(edge.source);
    if (from === undefined || from !== communityOf.get(edge.target) || edge.source === edge.target) {
      continue;
    }
    const existing = callees.get(edge.source);
    if (existing === undefined) {
      callees.set(edge.source, [edge.target]);
    } else if (!existing.includes(edge.target)) {
      existing.push(edge.target);
    } else {
      continue;
    }
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  for (const list of callees.values()) {
    list.sort(compareIds);
  }
  return { partition, callees, inDegree };
}

/** Hop depth and the Node each was first reached from, within one community. */
interface Depths {
  depthOf: Map<string, number>;
  parentOf: Map<string, string | null>;
}

/**
 * Breadth-first depth within a community. Roots are the members nothing in
 * the community calls; a community whose every member has a caller (fully
 * cyclic code) starts from its most-called member instead, so it still gets
 * columns rather than collapsing into one. Any member the walk does not
 * reach starts a walk of its own, so every member is placed.
 */
function communityDepths(
  members: readonly string[],
  callees: ReadonlyMap<string, readonly string[]>,
  inDegree: ReadonlyMap<string, number>,
): Depths {
  const depthOf = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  const remaining = new Set(members);

  const walkFrom = (start: string) => {
    depthOf.set(start, 0);
    parentOf.set(start, null);
    remaining.delete(start);
    let frontier = [start];
    let depth = 0;
    while (frontier.length > 0) {
      depth += 1;
      const next: string[] = [];
      for (const node of frontier) {
        for (const callee of callees.get(node) ?? []) {
          if (!remaining.has(callee)) {
            continue;
          }
          remaining.delete(callee);
          depthOf.set(callee, depth);
          parentOf.set(callee, node);
          next.push(callee);
        }
      }
      frontier = next;
    }
  };

  const roots = members.filter((member) => (inDegree.get(member) ?? 0) === 0).sort(compareIds);
  const starts =
    roots.length > 0
      ? roots
      : // Fully cyclic: the most-called member, id breaking the tie.
        [...members].sort((a, b) => (inDegree.get(b) ?? 0) - (inDegree.get(a) ?? 0) || compareIds(a, b)).slice(0, 1);
  for (const start of starts) {
    if (remaining.has(start)) {
      walkFrom(start);
    }
  }
  // Anything the walks missed (a member reachable from nothing they covered).
  while (remaining.size > 0) {
    walkFrom([...remaining].sort(compareIds)[0]!);
  }
  return { depthOf, parentOf };
}

/** Lays `cardIds` out in a measured, roughly square grid — for cards with no call structure. */
function gridBlock(
  cardIds: readonly string[],
  cardSizeOf: (cardId: string) => LayeredCardSize | undefined,
): { positions: Map<string, Point>; width: number; height: number } {
  const grid = measuredGridLayout(cardIds, cardIds.length, cardSizeOf);
  const positions = new Map<string, Point>();
  let width = 0;
  let height = 0;
  cardIds.forEach((cardId, index) => {
    const at = measuredGridPosition(grid, index);
    positions.set(cardId, at);
    width = Math.max(width, at.x + NODE_COLUMN_GAP);
    height = Math.max(height, at.y + NODE_ROW_GAP);
  });
  return { positions, width, height };
}

/**
 * Where every card goes. Community blocks come first, largest community
 * first, then the unreferenced community, then the render-only folded cards
 * — each block tiled left to right and wrapped into rows, so the whole map
 * stays roughly square and `fitView` can frame it.
 *
 * `extraCardIds` are the folded Type/Module cards, in the order the canvas
 * lays them out. `cardSizeOf` gives React Flow's measurement for a card, or
 * `undefined` before it has one — in which case the block falls back to the
 * grid pitch, exactly as `layoutPosition` did.
 *
 * `collapsed` names the communities drawn as a single community card instead
 * of their members (`communityView.ts`): such a block lays out one card,
 * under the community's own id, so the collapsed view is compact and the
 * expanded one is unchanged. Empty by default — every community laid out by
 * its members, which is what Full did before the collapsed view existed.
 */
/**
 * The order to shelve communities in, so ones that call each other sit near
 * each other. Decided from the partition and its links ALONE — never from a
 * measured size or a packed position.
 *
 * `[2026-10-25]` That restriction is the point. Deciding it from the packed
 * slots made the seating a function of React Flow's card measurements: a
 * re-measure could flip a swap, move a community across the map, and change
 * every `cluster:<cellX>:<cellY>` id derived from card positions — the map
 * rearranging itself in front of the engineer for no visible reason. Sizes may
 * decide where the shelves break, as they always have; they may not decide who
 * sits where.
 *
 * Pairwise hill-climbing over a nominal square grid of one cell per community,
 * standing in for shelves this cannot know yet. Shape alone seats neighbours
 * together, and shape here depends on nothing but how many communities there
 * are. Scored only over the two communities a swap touches, so a pass costs
 * O(communities^2 x degree) rather than O(communities^2 x links); a fixed scan
 * order and a bounded pass count keep it deterministic with a predictable
 * worst case.
 */
export function relaxBlockOrder(
  communities: readonly { id: string }[],
  links: readonly CommunityLink[],
  maxPasses = 4,
): number[] {
  const slotOf = communities.map((_community, index) => index);
  if (communities.length < 2 || links.length === 0) {
    return slotOf;
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(communities.length)));
  const cell = (slot: number) => ({ x: slot % columns, y: Math.floor(slot / columns) });
  const indexOf = new Map(communities.map((community, index) => [community.id, index]));
  const neighbours = communities.map((): { index: number; weight: number }[] => []);
  for (const { sourceCommunityId, targetCommunityId, count } of links) {
    const from = indexOf.get(sourceCommunityId);
    const to = indexOf.get(targetCommunityId);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    neighbours[from]!.push({ index: to, weight: count });
    neighbours[to]!.push({ index: from, weight: count });
  }
  const pull = (community: number) => {
    const here = cell(slotOf[community]!);
    return neighbours[community]!.reduce((total, { index, weight }) => {
      const there = cell(slotOf[index]!);
      return total + Math.hypot(here.x - there.x, here.y - there.y) * weight;
    }, 0);
  };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let moved = false;
    for (let a = 0; a < communities.length; a += 1) {
      for (let b = a + 1; b < communities.length; b += 1) {
        const before = pull(a) + pull(b);
        [slotOf[a], slotOf[b]] = [slotOf[b]!, slotOf[a]!];
        if (pull(a) + pull(b) < before - 1e-9) {
          moved = true;
        } else {
          [slotOf[a], slotOf[b]] = [slotOf[b]!, slotOf[a]!];
        }
      }
    }
    if (!moved) {
      break;
    }
  }
  return slotOf;
}

export function communityPositions(
  structure: CommunityStructure,
  extraCardIds: readonly string[] = [],
  cardSizeOf: (cardId: string) => LayeredCardSize | undefined = () => undefined,
  collapsed: ReadonlySet<string> = new Set(),
): CommunityPlacement {
  const { partition, callees, inDegree } = structure;
  if (partition.communities.length === 0 && extraCardIds.length === 0) {
    return { positions: new Map(), blocks: [] };
  }

  // Each block laid out from its own origin; tiled once every size is known.
  const laidOut: { block: Omit<CommunityBlock, 'x' | 'y'>; positions: Map<string, Point> }[] = [];
  for (const community of partition.communities) {
    const common = {
      communityId: community.id,
      label: community.label,
      memberCount: community.memberIds.length,
    };
    if (collapsed.has(community.id)) {
      // One card, under the community's own id, at the block's origin.
      const { positions, width, height } = gridBlock([community.id], cardSizeOf);
      laidOut.push({
        block: { ...common, cardIds: [community.id], collapsed: true, width, height },
        positions,
      });
      continue;
    }
    if (community.id === UNREFERENCED_COMMUNITY_ID) {
      const { positions, width, height } = gridBlock(community.memberIds, cardSizeOf);
      laidOut.push({
        block: { ...common, cardIds: community.memberIds, collapsed: false, width, height },
        positions,
      });
      continue;
    }
    const { depthOf, parentOf } = communityDepths(community.memberIds, callees, inDegree);
    const result = layeredPositions(
      community.memberIds.map((cardId) => ({
        cardId,
        depth: depthOf.get(cardId) ?? 0,
        parentId: parentOf.get(cardId) ?? null,
        // Most-called first within a column; the core breaks the rest on id.
        ranks: [-(inDegree.get(cardId) ?? 0)],
      })),
      cardSizeOf,
      undefined,
      // A community is a block on a tiled map, so its shape matters: an
      // unwrapped layer made driller's own 213-member community a 12.5:1
      // ribbon that was 72% of the whole map's height. Revealed does not pass
      // this — its columns are short, and its layout is a frozen snapshot.
      { wrapToSquare: true },
    );
    laidOut.push({
      block: {
        ...common,
        cardIds: community.memberIds,
        collapsed: false,
        width: result.width,
        height: result.height,
      },
      positions: result.positions,
    });
  }
  if (extraCardIds.length > 0) {
    const { positions, width, height } = gridBlock(extraCardIds, cardSizeOf);
    laidOut.push({
      block: {
        communityId: FOLDED_BLOCK_ID,
        label: FOLDED_BLOCK_LABEL,
        cardIds: extraCardIds,
        // Not a community: it has no card of its own and never collapses.
        collapsed: false,
        memberCount: extraCardIds.length,
        width,
        height,
      },
      positions,
    });
  }

  // Shelf-pack the blocks into rows, wrapping at a width chosen to keep the
  // whole map roughly square. A fixed column count will not do: blocks differ
  // enormously in size, and with two of them it would lay both in one row —
  // on the seven-Node `path-trace-basic` fixture that made the map three
  // times wider than tall, so the first fit zoomed out to 0.54 where the old
  // grid reached 1.52. Cards the engineer cannot read are not an improvement
  // on cards in the wrong place.
  const targetWidth = Math.max(
    ...laidOut.map(({ block }) => block.width),
    Math.sqrt(
      laidOut.reduce(
        (area, { block }) => area + (block.width + COMMUNITY_GAP_X) * (block.height + COMMUNITY_GAP_Y),
        0,
      ),
    ),
  );
  // `[2026-10-25]` Packed in the order `relaxBlockOrder` gives, which it
  // decides from the partition and its links ALONE. It used to be decided from
  // the packed slot positions — measured geometry — so a re-measure could flip
  // a swap and move a community across the map, taking every
  // `cluster:<cellX>:<cellY>` id the canvas derives from card positions with
  // it. Block sizes still decide where the shelves break, as they always have;
  // what must not move when a card is re-measured is who sits where.
  const order = relaxBlockOrder(partition.communities, partition.links);
  const seated = laidOut
    .map((entry, index) => ({ entry, slot: order[index] ?? index }))
    .sort((a, b) => a.slot - b.slot);

  const positions = new Map<string, Point>();
  const blocks: CommunityBlock[] = [];
  let left = 0;
  let rowTop = 0;
  let rowHeight = 0;
  for (const { entry } of seated) {
    const { block, positions: blockPositions } = entry;
    if (left > 0 && left + block.width > targetWidth) {
      left = 0;
      rowTop += rowHeight + COMMUNITY_GAP_Y;
      rowHeight = 0;
    }
    for (const [cardId, at] of blockPositions) {
      positions.set(cardId, { x: left + at.x, y: rowTop + at.y });
    }
    blocks.push({ ...block, x: left, y: rowTop });
    left += block.width + COMMUNITY_GAP_X;
    rowHeight = Math.max(rowHeight, block.height);
  }
  return { positions, blocks };
}

export interface CommunityLayoutInput {
  /** The map's own Nodes, in any order — `CanvasPopulation.riskNodes`. */
  nodes: readonly CommunityInputNode[];
  /** Every fetched edge — `CanvasPopulation.riskEdges`. */
  edges: readonly CommunityInputEdge[];
  /** The render-only folded Type/Module cards, in the order the canvas lays them out. */
  extraCardIds?: readonly string[];
  cardSizeOf?: (cardId: string) => LayeredCardSize | undefined;
  /** Communities drawn as one community card instead of their members; none by default. */
  collapsed?: ReadonlySet<string>;
}

/** `communityStructure` and `communityPositions` in one call, for a caller with nothing to memoize. */
export function communityLayout(input: CommunityLayoutInput): CommunityLayout {
  const extraCardIds = input.extraCardIds ?? [];
  if (input.nodes.length === 0 && extraCardIds.length === 0) {
    return EMPTY_COMMUNITY_LAYOUT;
  }
  const structure = communityStructure(input.nodes, input.edges);
  return { structure, ...communityPositions(structure, extraCardIds, input.cardSizeOf, input.collapsed) };
}

/**
 * Whether two placements put every card within a pixel of the same place.
 * This is the Full map's re-layout guard: React Flow measures the cards it
 * drew, the placement is redone with those sizes, and a re-render is owed
 * only when a card actually moved — which is what stops the
 * measure/re-layout loop. It replaces `sameGridSpacing`, whose row/column
 * pitch arrays a block layout has no equivalent of.
 */
export function samePositions(a: ReadonlyMap<string, Point>, b: ReadonlyMap<string, Point>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [cardId, at] of a) {
    const other = b.get(cardId);
    if (other === undefined || Math.abs(at.x - other.x) >= 1 || Math.abs(at.y - other.y) >= 1) {
      return false;
    }
  }
  return true;
}
