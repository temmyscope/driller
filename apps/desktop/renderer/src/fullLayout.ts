/**
 * The Full map's position pipeline, as a pure function.
 *
 * `CodeMap.tsx` holds the React wiring — the memos, the card-size ref and
 * the re-fit effect — but what those compute lives here, so it can be tested
 * without mounting a canvas. The layout itself is `communityLayout.ts`; this
 * is the small adapter between it and the component: which card ids Full
 * lays out, in what order, and the placement for them.
 *
 * Pure and deterministic, like `measuredGrid.ts` before it: the same
 * population and measured sizes always give the same `FullGrid`.
 */
import {
  communityPositions,
  communityStructure,
  type CommunityBlock,
  type CommunityStructure,
  type Point,
} from './communityLayout';
import type { LayeredCardSize } from './layered';

/** The least `fullGridOf` needs of a Node or a folded card: its id, and a name to label a community with. */
export interface FullLayoutNode {
  id: string;
  name: string;
}

/**
 * Full's layout and the cards it places.
 *
 * Was P5-f's measured grid — a roughly square grid in the order the Nodes
 * arrived — now the community blocks of `communityLayout.ts`, so a card's
 * position says which group it belongs to and how deep in that group's call
 * chains it sits.
 */
export interface FullGrid {
  /** Every card Full lays out: the map Nodes, then the folded cards. */
  ids: readonly string[];
  idSet: ReadonlySet<string>;
  /** The folded Type/Module card ids, in the order the canvas lays them out. */
  extraCardIds: readonly string[];
  /** Depends on the fetched map alone, so re-measuring never repartitions it. */
  structure: CommunityStructure;
  positions: ReadonlyMap<string, Point>;
  blocks: readonly CommunityBlock[];
  /** Only for `layoutPosition`'s fallback, for a card the layout somehow did not place. */
  gridSize: number;
}

/**
 * The partition and in-community call structure for a fetched map. Memoize
 * this on the map alone: it costs a community detection pass, and a batch of
 * card measurements must never trigger one.
 */
export function fullStructureOf(
  nodes: readonly FullLayoutNode[],
  edges: readonly { source: string; target: string }[],
): CommunityStructure {
  return communityStructure(nodes, edges);
}

/**
 * Where every Full card goes, for a `structure` already computed and the
 * card sizes React Flow has measured so far. `gridSize` mirrors
 * `canvasGridSize`: the map Nodes alone when there are any, so the folded
 * cards do not change the fallback grid the Nodes would use.
 */
export function fullGridOf(
  structure: CommunityStructure,
  nodes: readonly FullLayoutNode[],
  extraCardIds: readonly string[],
  cardSizeOf: (cardId: string) => LayeredCardSize | undefined,
): FullGrid {
  const ids = [...nodes.map((node) => node.id), ...extraCardIds];
  const placed = communityPositions(structure, extraCardIds, cardSizeOf);
  return {
    ids,
    idSet: new Set(ids),
    extraCardIds,
    structure,
    positions: placed.positions,
    blocks: placed.blocks,
    gridSize: nodes.length > 0 ? nodes.length : extraCardIds.length,
  };
}
