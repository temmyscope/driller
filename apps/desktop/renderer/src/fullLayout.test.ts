/**
 * Full's position pipeline (`fullLayout.ts`): the adapter between the
 * community layout and the canvas — which cards Full lays out, and that
 * re-measuring them re-places them without ever repartitioning the map.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samePositions } from './communityLayout';
import { fullGridOf, fullStructureOf, type FullLayoutNode } from './fullLayout';

const id = (name: string) => `src/${name}.ts::${name}`;
const nodesOf = (...names: string[]): FullLayoutNode[] =>
  names.map((name) => ({ id: id(name), name, file: `src/${name}.ts` }));

const CHAIN = {
  nodes: nodesOf('a1', 'a2', 'a3'),
  edges: [
    { source: id('a1'), target: id('a2') },
    { source: id('a2'), target: id('a3') },
  ],
};

const gridFor = (extraCardIds: readonly string[] = [], cardSizeOf: () => undefined | { width: number; height: number } = () => undefined) =>
  fullGridOf(fullStructureOf(CHAIN.nodes, CHAIN.edges), CHAIN.nodes, extraCardIds, cardSizeOf);

describe('fullGridOf lays out every card Full draws', () => {
  it('lists the map Nodes then the folded cards, and places each one', () => {
    const extraCardIds = ['folded:Request', 'folded:Response'];
    const grid = gridFor(extraCardIds);
    assert.deepEqual(grid.ids, [...CHAIN.nodes.map((node) => node.id), ...extraCardIds]);
    assert.deepEqual(grid.extraCardIds, extraCardIds);
    for (const cardId of grid.ids) {
      assert.ok(grid.idSet.has(cardId), `${cardId} is in the id set`);
      assert.ok(grid.positions.has(cardId), `${cardId} is placed`);
    }
  });

  it('puts the call chain in columns, depth increasing left to right', () => {
    const { positions } = gridFor();
    const xs = [id('a1'), id('a2'), id('a3')].map((cardId) => positions.get(cardId)!.x);
    assert.ok(xs[0]! < xs[1]! && xs[1]! < xs[2]!, `depth increases: ${xs.join(' < ')}`);
  });

  it('reports a block per group, covering the cards it holds', () => {
    const grid = gridFor(['folded:Request']);
    const covered = grid.blocks.flatMap((block) => [...block.cardIds]);
    assert.deepEqual([...covered].sort(), [...grid.ids].sort(), 'every card belongs to exactly one block');
  });

  it('sizes the fallback grid by the map Nodes alone, so folded cards never change it', () => {
    assert.equal(gridFor().gridSize, CHAIN.nodes.length);
    assert.equal(gridFor(['folded:Request', 'folded:Response']).gridSize, CHAIN.nodes.length);
  });

  it('falls back to the folded cards’ own count when there are no map Nodes', () => {
    const extraCardIds = ['folded:Request', 'folded:Response'];
    const grid = fullGridOf(fullStructureOf([], []), [], extraCardIds, () => undefined);
    assert.equal(grid.gridSize, extraCardIds.length);
    for (const cardId of extraCardIds) {
      assert.ok(grid.positions.has(cardId));
    }
  });
});

describe('fullGridOf keeps measuring separate from partitioning', () => {
  it('a structure reused with new sizes re-places the same cards', () => {
    const structure = fullStructureOf(CHAIN.nodes, CHAIN.edges);
    const small = fullGridOf(structure, CHAIN.nodes, [], () => ({ width: 200, height: 80 }));
    const large = fullGridOf(structure, CHAIN.nodes, [], () => ({ width: 320, height: 300 }));
    assert.deepEqual(small.ids, large.ids);
    assert.equal(small.structure, large.structure, 'the same partition object is carried through');
    assert.ok(!samePositions(small.positions, large.positions), 'but the cards moved');
  });

  it('re-placing with unchanged sizes moves nothing — the re-layout loop settles', () => {
    const structure = fullStructureOf(CHAIN.nodes, CHAIN.edges);
    const cardSizeOf = () => ({ width: 260, height: 120 });
    const once = fullGridOf(structure, CHAIN.nodes, [], cardSizeOf);
    const twice = fullGridOf(structure, CHAIN.nodes, [], cardSizeOf);
    assert.ok(samePositions(twice.positions, once.positions));
  });

  it('a card measured at the fallback size sits where an unmeasured one would', () => {
    assert.ok(samePositions(gridFor().positions, gridFor([], () => ({ width: 200, height: 80 })).positions));
  });
});
