/**
 * The shared layered layout: cards in columns by depth, rows ordered so a
 * parent's children sit beside it.
 *
 * Extracted from `revealView.ts`'s `layeredLayout` (P4-7d, measured by
 * FIX-7) so the Code Map's own Full-map layout can reuse the same
 * placement inside a community (`communityLayout.ts`) instead of growing a
 * second, drifting copy. `layeredLayout` is now a thin adapter over
 * `layeredPositions` and its ordering is unchanged — `revealView`'s tests
 * pin that.
 *
 * This module also owns the card-pitch primitives the layout needs
 * (`NODE_COLUMN_GAP`, `NODE_ROW_GAP`, `cardPitch`), which `revealView.ts`
 * held before. They moved here because the dependency has to run one way:
 * `revealView` and `measuredGrid` import this module, never the reverse, so
 * there is no value cycle. `revealView` re-exports them under their old
 * names, so every existing importer is untouched.
 *
 * Pure and deterministic: the same cards, sizes and origin always give the
 * same positions. Ordering never depends on the order of `cards` — only on
 * each card's `depth`, its parent's row, its `ranks` and, last, its id.
 */

/** A card's drawn size, as React Flow measured it. */
export interface LayeredCardSize {
  width: number;
  height: number;
}

/** The grid pitch every layout falls back to: a row is 110 px, a column 260 px. */
export const NODE_COLUMN_GAP = 260;
export const NODE_ROW_GAP = 110;

/** The least space between a card and the one below it (the grid's own: 110 − an 80 px card is 30). */
export const CARD_GAP_Y = 24;

/** The least space between a column's widest card and the next column (the grid's own: 260 − 200 is 60). */
export const CARD_GAP_X = 60;

/**
 * The room a card takes: its row's height and its share of its column's
 * width — its size plus the gaps, never less than the grid pitch. Positions
 * depend on sizes only through this, so a new measurement that leaves it
 * unchanged needs no re-layout.
 */
export function cardPitch(size: LayeredCardSize | undefined): { row: number; column: number } {
  return {
    row: Math.max(NODE_ROW_GAP, (size?.height ?? 0) + CARD_GAP_Y),
    column: Math.max(NODE_COLUMN_GAP, (size?.width ?? 0) + CARD_GAP_X),
  };
}

/**
 * One card to place. `depth` is its column; `parentId` the card it hangs
 * off (`null` for a root, which sorts first). `ranks` are the caller's own
 * tie-breaks, compared in order, ascending — so a caller that wants a
 * value descending passes its negation. Id breaks every remaining tie, so
 * the result never depends on input order.
 */
export interface LayeredCard {
  cardId: string;
  depth: number;
  parentId: string | null;
  ranks: readonly number[];
}

/** Optional shaping for `layeredPositions`. */
export interface LayeredOptions {
  /**
   * Wrap a long hop layer into side-by-side columns so the block comes out
   * roughly square instead of a tall ribbon. Opt-in: Revealed's own layout is
   * pinned by a frozen snapshot and its columns are short enough never to have
   * needed it.
   */
  wrapToSquare?: boolean;
}

/** Where the layout's first column and row begin. */
export interface LayeredOrigin {
  x: number;
  y: number;
}

export interface LayeredLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  /** The laid-out extent, from `origin` — what a caller tiling several layouts needs. */
  width: number;
  height: number;
  /** Each card's row within its column, for a caller that orders a second pass by it. */
  rowOf: Map<string, number>;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Element by element, ascending; a missing element counts as 0, so ranks of different lengths still order. */
function compareRanks(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Lays `cards` out in columns by `depth`. Within a column, cards are
 * ordered by their parent's row (a root first), then by `ranks`, then by
 * id — so a parent's children sit together and edges cross as little as the
 * column order allows. Columns are laid out shallowest first, which is what
 * makes a parent's row known before its children are ordered; a gap in the
 * depths still advances one pitch per missing column.
 *
 * A card id appearing twice is placed once, on its first entry.
 */
export function layeredPositions(
  cards: readonly LayeredCard[],
  cardSizeOf: (cardId: string) => LayeredCardSize | undefined = () => undefined,
  origin: LayeredOrigin = { x: 0, y: 0 },
  options: LayeredOptions = {},
): LayeredLayoutResult {
  const byDepth = new Map<number, LayeredCard[]>();
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.cardId)) {
      continue;
    }
    seen.add(card.cardId);
    const column = byDepth.get(card.depth);
    if (column === undefined) {
      byDepth.set(card.depth, [card]);
    } else {
      column.push(card);
    }
  }

  const rowOf = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  const parentRow = (card: LayeredCard): number =>
    card.parentId === null ? -1 : (rowOf.get(card.parentId) ?? -1);

  /**
   * How many cards one column may hold before a layer wraps into another
   * column beside it, or `undefined` to stack a layer however long it is.
   *
   * `[2026-10-25]` A layer laid out as one unbounded column makes a ribbon:
   * driller's own 213-member community measured 1,800 x 22,412, 12.5:1 tall,
   * and was 72% of the Full map's height by itself. Wrapping at `rows` makes a
   * block about as wide as it is tall, because `rows` columns of `rows` cards
   * is square when `rows = sqrt(cards x columnPitch / rowPitch)` — the pitches
   * are what convert a count into a distance, so the ratio has to carry them.
   * Rounded up, and never below one.
   */
  // `[2026-10-25]` The ratio comes from the FALLBACK pitch, never from the
  // measured one. React Flow re-measures cards as they mount, and a wrap point
  // read from those measurements reshapes every block the moment a measurement
  // moves — which moves every card, and with them every `cluster:<cellX>:<cellY>`
  // id the canvas derives from card positions. That is a layout that
  // rearranges itself for no reason the engineer can see, and it broke a test
  // that expected a cluster to still be there after a trip through Revealed.
  // Card count is the stable part of the question, so it is the only part the
  // wrap point is allowed to ask about.
  const nominal = cardPitch(undefined);
  const maxRows =
    options.wrapToSquare === true && seen.size > 0
      ? Math.max(1, Math.ceil(Math.sqrt((seen.size * nominal.column) / nominal.row)))
      : undefined;

  let columnX = origin.x;
  let previousDepth: number | null = null;
  let previousColumnWidth = 0;
  let widest = 0;
  let tallest = 0;

  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    columnX =
      previousDepth === null
        ? origin.x + depth * NODE_COLUMN_GAP
        : columnX + previousColumnWidth + (depth - previousDepth - 1) * NODE_COLUMN_GAP;
    const column = [...(byDepth.get(depth) ?? [])].sort(
      (a, b) =>
        parentRow(a) - parentRow(b) || compareRanks(a.ranks, b.ranks) || compareIds(a.cardId, b.cardId),
    );
    // `rowOf` stays the card's index within its whole LAYER, not within the
    // sub-column it lands in: the next depth sorts its cards by their parent's
    // row, and that ordering is about the layer, not about where it wrapped.
    const perColumn = maxRows ?? column.length;
    let subColumnX = columnX;
    let depthWidth = 0;
    for (let start = 0; start < column.length; start += perColumn) {
      let rowY = origin.y;
      let columnWidth = NODE_COLUMN_GAP;
      for (let offset = 0; offset < perColumn && start + offset < column.length; offset += 1) {
        const card = column[start + offset]!;
        rowOf.set(card.cardId, start + offset);
        positions.set(card.cardId, { x: subColumnX, y: rowY });
        const pitch = cardPitch(cardSizeOf(card.cardId));
        rowY += pitch.row;
        columnWidth = Math.max(columnWidth, pitch.column);
      }
      widest = Math.max(widest, subColumnX + columnWidth - origin.x);
      tallest = Math.max(tallest, rowY - origin.y);
      subColumnX += columnWidth;
      depthWidth = subColumnX - columnX;
    }
    previousDepth = depth;
    previousColumnWidth = depthWidth;
  }

  return { positions, width: widest, height: tallest, rowOf };
}
