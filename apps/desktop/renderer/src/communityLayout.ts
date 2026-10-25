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
 * Which slot each block should occupy, given the slots the shelf packer
 * produced. Blocks that call each other end up near each other; the packing
 * itself is untouched.
 *
 * `[2026-10-25]` Measured while dogfooding driller on its own repository: 33
 * community cards and 56 links drew **425 edge crossings**, about fifteen per
 * link, so no single relation could be followed through the middle of the map.
 * The cards were not badly placed — they were badly ordered. Reassigning which
 * community sits in which already-packed slot, changing no geometry at all,
 * took the same map to 71 crossings and cut total link length by 48%.
 *
 * Only blocks of identical size are ever exchanged, which is what makes this
 * safe: the packer treats them as interchangeable, so swapping two leaves the
 * shelves bit-for-bit as they were and nothing can overlap or move off the
 * map. It is why the measured figure is 71 rather than the 44 an unrestricted
 * optimiser reaches — a bound worth keeping for a guarantee worth having.
 *
 * Pairwise hill-climbing on the summed call-weighted distance between linked
 * blocks, scored only over the two blocks a swap touches rather than the whole
 * map, so a pass costs O(blocks² × degree) and not O(blocks² × links). Bounded
 * at `maxPasses` and scanned in a fixed order, so it is deterministic and its
 * worst case is predictable; four passes already reached the optimum this
 * heuristic can find on the real map.
 */
export function relaxBlockSlots(
  blocks: readonly { communityId: string; width: number; height: number }[],
  slots: readonly Point[],
  links: readonly CommunityLink[],
  maxPasses = 4,
): number[] {
  const slotOf = blocks.map((_block, index) => index);
  if (blocks.length < 2 || links.length === 0) {
    return slotOf;
  }
  const indexOf = new Map(blocks.map((block, index) => [block.communityId, index]));
  /** Call-weighted neighbours, by block index. A link to a community off this map is ignored. */
  const neighbours = blocks.map((): { index: number; weight: number }[] => []);
  for (const { sourceCommunityId, targetCommunityId, count } of links) {
    const from = indexOf.get(sourceCommunityId);
    const to = indexOf.get(targetCommunityId);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    neighbours[from]!.push({ index: to, weight: count });
    neighbours[to]!.push({ index: from, weight: count });
  }
  const sameSize = (a: number, b: number) =>
    blocks[a]!.width === blocks[b]!.width && blocks[a]!.height === blocks[b]!.height;
  const pull = (block: number) => {
    const here = slots[slotOf[block]!]!;
    return neighbours[block]!.reduce((total, { index, weight }) => {
      const there = slots[slotOf[index]!]!;
      return total + Math.hypot(here.x - there.x, here.y - there.y) * weight;
    }, 0);
  };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let moved = false;
    for (let a = 0; a < blocks.length; a += 1) {
      for (let b = a + 1; b < blocks.length; b += 1) {
        if (!sameSize(a, b)) {
          continue;
        }
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
  // The shelves, walked once for their slots alone. `relaxBlockSlots` then
  // decides which block sits in which of them, so blocks that call each other
  // are near each other; every slot keeps the x/y this walk gave it.
  const slots: Point[] = [];
  let left = 0;
  let rowTop = 0;
  let rowHeight = 0;
  for (const { block } of laidOut) {
    if (left > 0 && left + block.width > targetWidth) {
      left = 0;
      rowTop += rowHeight + COMMUNITY_GAP_Y;
      rowHeight = 0;
    }
    slots.push({ x: left, y: rowTop });
    left += block.width + COMMUNITY_GAP_X;
    rowHeight = Math.max(rowHeight, block.height);
  }
  const slotOf = relaxBlockSlots(
    laidOut.map(({ block }) => block),
    slots,
    partition.links,
  );

  const positions = new Map<string, Point>();
  const blocks: CommunityBlock[] = [];
  laidOut.forEach(({ block, positions: blockPositions }, index) => {
    const { x, y } = slots[slotOf[index]!]!;
    for (const [cardId, at] of blockPositions) {
      positions.set(cardId, { x: x + at.x, y: y + at.y });
    }
    blocks.push({ ...block, x, y });
  });
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
