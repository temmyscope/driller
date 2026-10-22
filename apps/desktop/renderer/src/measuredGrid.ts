/**
 * P5-f founder decision (2026-10-19): the Full map's measured grid.
 *
 * Full lays its cards out in the same roughly-square grid as ever (card
 * `index` at column `index % columns`, row `index / columns`,
 * `ceil(sqrt(gridSize))` columns), but each row is as tall, and each column as
 * wide, as the largest card in it — the pitch Revealed's `layeredLayout` uses
 * since FIX-7 (`revealCardPitch`: the size plus a gap, never less than the
 * 110 × 260 grid pitch). Capped, wrapping cards (P5-f's 320 px cap) are
 * taller than 110 px, so on the fixed grid each card's bottom row was hidden
 * under the card below.
 *
 * A card React Flow has not measured (folded into an LOD cluster, or culled
 * off screen) is taken to be as large as the largest card measured so far, so
 * rows that come into view, or into a cluster's place, already have the room
 * their cards most likely need and the cards around them don't jump. With
 * nothing measured every card sits exactly at `layoutPosition` — a map whose
 * cards fit the grid pitch looks as before.
 *
 * Pure and deterministic: the same ids, grid size and sizes always give the
 * same positions; order is never changed.
 */
import { cardPitch as revealCardPitch, type LayeredCardSize as RevealCardSize } from './layered';

export interface MeasuredGrid {
  /** Columns per row: `ceil(sqrt(gridSize))`, at least 1 — `layoutPosition`'s. */
  columns: number;
  /** Each column's left edge. */
  columnX: readonly number[];
  /** Each row's top edge. */
  rowY: readonly number[];
  /** Each row's pitch (its height plus the gap, ≥ `NODE_ROW_GAP`). */
  rowPitch: readonly number[];
  /** Each column's pitch (its width plus the gap, ≥ `NODE_COLUMN_GAP`). */
  columnPitch: readonly number[];
}

/**
 * The measured grid for `ids` (in layout order). `gridSize` sets the column
 * count (`canvasGridSize`: the map Nodes alone, so folded cards fill rows
 * below). `sizeOf` gives a card's measured size, `undefined` when unmeasured.
 */
export function measuredGridLayout(
  ids: readonly string[],
  gridSize: number,
  sizeOf: (id: string) => RevealCardSize | undefined,
): MeasuredGrid {
  const columns = Math.max(1, Math.ceil(Math.sqrt(gridSize)));
  const rows = Math.ceil(ids.length / columns);
  const sizes: (RevealCardSize | undefined)[] = new Array(ids.length);
  let largestWidth = 0;
  let largestHeight = 0;
  let anyMeasured = false;
  for (let index = 0; index < ids.length; index += 1) {
    const size = sizeOf(ids[index]!);
    sizes[index] = size;
    if (size !== undefined) {
      anyMeasured = true;
      largestWidth = Math.max(largestWidth, size.width);
      largestHeight = Math.max(largestHeight, size.height);
    }
  }
  const estimate = anyMeasured ? { width: largestWidth, height: largestHeight } : undefined;
  const rowPitch: number[] = new Array(rows);
  const columnPitch: number[] = new Array(Math.min(columns, ids.length));
  const grid = revealCardPitch(undefined);
  rowPitch.fill(grid.row);
  columnPitch.fill(grid.column);
  for (let index = 0; index < ids.length; index += 1) {
    const pitch = revealCardPitch(sizes[index] ?? estimate);
    const row = Math.floor(index / columns);
    const column = index % columns;
    if (pitch.row > rowPitch[row]!) rowPitch[row] = pitch.row;
    if (pitch.column > columnPitch[column]!) columnPitch[column] = pitch.column;
  }
  const rowY: number[] = new Array(rows);
  let y = 0;
  for (let row = 0; row < rows; row += 1) {
    rowY[row] = y;
    y += rowPitch[row]!;
  }
  const columnX: number[] = new Array(columnPitch.length);
  let x = 0;
  for (let column = 0; column < columnPitch.length; column += 1) {
    columnX[column] = x;
    x += columnPitch[column]!;
  }
  return { columns, columnX, rowY, rowPitch, columnPitch };
}

/** The top-left of card `index` in `grid`. */
export function measuredGridPosition(grid: MeasuredGrid, index: number): { x: number; y: number } {
  return { x: grid.columnX[index % grid.columns] ?? 0, y: grid.rowY[Math.floor(index / grid.columns)] ?? 0 };
}

/** Whether two grids space their rows and columns alike — a re-layout is owed only when they don't. */
export function sameGridSpacing(a: MeasuredGrid, b: MeasuredGrid): boolean {
  return a.columns === b.columns && sameNumbers(a.rowPitch, b.rowPitch) && sameNumbers(a.columnPitch, b.columnPitch);
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index]! - b[index]!) >= 1) return false;
  }
  return true;
}
