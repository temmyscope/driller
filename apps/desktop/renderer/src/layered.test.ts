/**
 * The shared layered layout (`layered.ts`): the ordering and pitch rules
 * both the Revealed view (`layeredLayout`) and the Full map's community
 * blocks (`communityLayout`) are built on. `revealView.test.ts` pins what
 * Revealed makes of them; this pins the core itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cardPitch,
  layeredPositions,
  NODE_COLUMN_GAP,
  NODE_ROW_GAP,
  type LayeredCard,
} from './layered';

const card = (cardId: string, depth: number, parentId: string | null = null, ...ranks: number[]): LayeredCard => ({
  cardId,
  depth,
  parentId,
  ranks,
});

describe('cardPitch', () => {
  it('never goes below the grid pitch, and grows with the card', () => {
    assert.deepEqual(cardPitch(undefined), { row: NODE_ROW_GAP, column: NODE_COLUMN_GAP });
    assert.deepEqual(cardPitch({ width: 200, height: 80 }), { row: NODE_ROW_GAP, column: NODE_COLUMN_GAP });
    assert.deepEqual(cardPitch({ width: 320, height: 300 }), { row: 324, column: 380 });
  });
});

describe('layeredPositions puts depth in columns', () => {
  it('lays each depth out in its own column, left to right', () => {
    const { positions } = layeredPositions([card('a', 0), card('b', 1, 'a'), card('c', 2, 'b')]);
    assert.deepEqual(positions.get('a'), { x: 0, y: 0 });
    assert.deepEqual(positions.get('b'), { x: NODE_COLUMN_GAP, y: 0 });
    assert.deepEqual(positions.get('c'), { x: NODE_COLUMN_GAP * 2, y: 0 });
  });

  it('stacks a column’s cards by the row pitch', () => {
    const { positions } = layeredPositions([card('a', 0), card('b', 0), card('c', 0)]);
    assert.deepEqual(
      ['a', 'b', 'c'].map((id) => positions.get(id)!.y),
      [0, NODE_ROW_GAP, NODE_ROW_GAP * 2],
    );
  });

  it('advances one pitch per missing depth, so a gap is visible', () => {
    const { positions } = layeredPositions([card('a', 0), card('c', 2, 'a')]);
    assert.equal(positions.get('c')!.x, NODE_COLUMN_GAP * 2);
  });

  it('offsets everything from the origin it is given', () => {
    const cards = [card('a', 0), card('b', 1, 'a')];
    const base = layeredPositions(cards);
    const moved = layeredPositions(cards, () => undefined, { x: 1000, y: 500 });
    for (const id of ['a', 'b']) {
      assert.deepEqual(moved.positions.get(id), {
        x: base.positions.get(id)!.x + 1000,
        y: base.positions.get(id)!.y + 500,
      });
    }
  });
});

describe('layeredPositions orders a column predictably', () => {
  it('puts a root before a card with a parent, then follows the parent’s row', () => {
    // Column 1 holds b (child of a, row 0) and d (child of c, row 1), so b
    // must come first — children sit beside their parents.
    const { positions, rowOf } = layeredPositions([
      card('a', 0),
      card('c', 0),
      card('d', 1, 'c'),
      card('b', 1, 'a'),
    ]);
    assert.equal(rowOf.get('a'), 0);
    assert.equal(rowOf.get('c'), 1);
    assert.ok(positions.get('b')!.y < positions.get('d')!.y, 'b sits beside a, above d');
  });

  it('breaks a tie on ranks, in order, ascending', () => {
    const { rowOf } = layeredPositions([
      card('x', 0, null, 2, 0),
      card('y', 0, null, 1, 9),
      card('z', 0, null, 1, 3),
    ]);
    assert.deepEqual([rowOf.get('z'), rowOf.get('y'), rowOf.get('x')], [0, 1, 2]);
  });

  it('breaks every remaining tie on id, so input order never shows through', () => {
    const cards = [card('c', 0), card('a', 0), card('b', 0)];
    const forward = layeredPositions(cards).rowOf;
    const reversed = layeredPositions([...cards].reverse()).rowOf;
    assert.deepEqual([forward.get('a'), forward.get('b'), forward.get('c')], [0, 1, 2]);
    assert.deepEqual([...reversed.entries()].sort(), [...forward.entries()].sort());
  });

  it('treats a shorter ranks array as trailing zeroes rather than ignoring it', () => {
    const { rowOf } = layeredPositions([card('x', 0, null, 1), card('y', 0, null, 1, -1)]);
    assert.deepEqual([rowOf.get('y'), rowOf.get('x')], [0, 1]);
  });
});

describe('layeredPositions handles what a caller may hand it', () => {
  it('places a repeated card id once, on its first entry', () => {
    const { positions } = layeredPositions([card('a', 0), card('a', 5, 'b')]);
    assert.equal(positions.size, 1);
    assert.deepEqual(positions.get('a'), { x: 0, y: 0 });
  });

  it('treats an unknown parent as a root rather than dropping the card', () => {
    const { positions } = layeredPositions([card('orphan', 1, 'missing')]);
    assert.deepEqual(positions.get('orphan'), { x: NODE_COLUMN_GAP, y: 0 });
  });

  it('lays nothing out for no cards, and reports no extent', () => {
    const result = layeredPositions([]);
    assert.equal(result.positions.size, 0);
    assert.deepEqual([result.width, result.height], [0, 0]);
  });
});

describe('layeredPositions spaces by what was measured', () => {
  it('widens a column for its widest card and heightens a row for its tallest', () => {
    const sizes = new Map([['a', { width: 320, height: 300 }]]);
    const { positions } = layeredPositions(
      [card('a', 0), card('b', 0), card('c', 1, 'a')],
      (cardId) => sizes.get(cardId),
    );
    assert.equal(positions.get('b')!.y, 324, 'the tall card pushes the next row down');
    assert.equal(positions.get('c')!.x, 380, 'the wide card pushes the next column right');
  });

  it('reports the extent it laid out, for a caller tiling several layouts', () => {
    const { width, height } = layeredPositions([card('a', 0), card('b', 0), card('c', 1, 'a')]);
    assert.equal(width, NODE_COLUMN_GAP * 2);
    assert.equal(height, NODE_ROW_GAP * 2);
  });

  it('is deterministic: the same cards and sizes give the same positions', () => {
    const cards = [card('a', 0), card('b', 1, 'a'), card('c', 1, 'a')];
    const sizeOf = () => ({ width: 260, height: 120 });
    assert.deepEqual(
      [...layeredPositions(cards, sizeOf).positions.entries()],
      [...layeredPositions(cards, sizeOf).positions.entries()],
    );
  });
});

/**
 * `[2026-10-25]` Found by dogfooding driller on its own repository. Each hop
 * layer is laid out as ONE unbounded column, so a community with many members
 * at the same depth becomes a ribbon: the 213-Node community measured
 * 1,800 x 22,412 — 12.5:1 tall, and 72% of the whole map's height on its own.
 * That, not the shelf packer, is why the Full map came out 2.62:1 taller than
 * wide when the packer aims for roughly square.
 *
 * `wrapToSquare` wraps a long layer into side-by-side sub-columns at the same
 * depth. It is opt-in because Revealed's layout is pinned by a frozen snapshot
 * marked do-not-regenerate, and Revealed's columns are short enough that it
 * never needed this.
 */
describe('layeredPositions wrapping a long layer', () => {
  const cards = (count: number, depth = 1) =>
    Array.from({ length: count }, (_unused, i) => ({
      cardId: `n${String(i).padStart(3, '0')}`,
      depth,
      parentId: null,
      ranks: [i] as readonly number[],
    }));

  it('lays a 213-member layer out roughly square instead of as a ribbon', () => {
    const many = cards(213);
    const ribbon = layeredPositions(many);
    const wrapped = layeredPositions(many, undefined, undefined, { wrapToSquare: true });
    const ratio = (r: { width: number; height: number }) => r.height / r.width;
    assert.ok(ratio(ribbon) > 8, `precondition: today it is a ribbon (${ratio(ribbon).toFixed(1)}:1)`);
    assert.ok(ratio(wrapped) > 0.4 && ratio(wrapped) < 2.5, `wrapped is ${ratio(wrapped).toFixed(2)}:1`);
    assert.ok(wrapped.height < ribbon.height / 2, 'and much shorter than the ribbon');
  });

  it('places every card exactly once, and none on top of another', () => {
    const wrapped = layeredPositions(cards(213), undefined, undefined, { wrapToSquare: true });
    assert.equal(wrapped.positions.size, 213);
    const seen = new Set([...wrapped.positions.values()].map((p) => `${p.x},${p.y}`));
    assert.equal(seen.size, 213, 'no two cards share a position');
  });

  it('keeps a short layer in one column, so a small community is unchanged', () => {
    const few = cards(4);
    assert.deepEqual(
      [...layeredPositions(few, undefined, undefined, { wrapToSquare: true }).positions],
      [...layeredPositions(few).positions],
    );
  });

  it('never moves a card out of its own hop depth', () => {
    const mixed = [...cards(40, 0), ...cards(40, 1).map((c) => ({ ...c, cardId: `d1${c.cardId}` }))];
    const wrapped = layeredPositions(mixed, undefined, undefined, { wrapToSquare: true });
    const xs = (prefix: string) =>
      [...wrapped.positions].filter(([id]) => id.startsWith(prefix)).map(([, p]) => p.x);
    const depth0 = xs('n');
    const depth1 = xs('d1');
    assert.ok(Math.max(...depth0) < Math.min(...depth1), 'depth 0 stays entirely left of depth 1');
  });

  it('is deterministic', () => {
    const many = cards(213);
    assert.deepEqual(
      [...layeredPositions(many, undefined, undefined, { wrapToSquare: true }).positions],
      [...layeredPositions(many, undefined, undefined, { wrapToSquare: true }).positions],
    );
  });
});
