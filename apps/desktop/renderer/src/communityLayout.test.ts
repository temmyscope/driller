/**
 * The Full map's community layout (`communityLayout.ts`): that cards which
 * call each other end up near each other, that every card is placed exactly
 * once, that blocks never overlap, that cards with no call structure are not
 * given a structural position, and that the result is deterministic and
 * settles once React Flow's measurements come back.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_NODES_TO_PARTITION,
  UNREFERENCED_COMMUNITY_ID,
  type CommunityInputEdge,
  type CommunityInputNode,
} from './communities';
import {
  communityLayout,
  communityPositions,
  communityStructure,
  EMPTY_COMMUNITY_LAYOUT,
  FOLDED_BLOCK_ID,
  samePositions,
  type CommunityBlock,
} from './communityLayout';
import type { LayeredCardSize } from './layered';

const id = (name: string) => `src/${name}.ts::${name}`;
const nodesOf = (...names: string[]): CommunityInputNode[] => names.map((name) => ({ id: id(name), name }));
const edgesOf = (...pairs: [string, string][]): CommunityInputEdge[] =>
  pairs.map(([source, target]) => ({ source: id(source), target: id(target) }));

/** One short call chain, below `MIN_NODES_TO_PARTITION`: one block, so depth reads straight off x. */
const SMALL_CHAIN = {
  nodes: nodesOf('a1', 'a2', 'a3'),
  edges: edgesOf(['a1', 'a2'], ['a2', 'a3']),
};

/** Two cliques joined by one edge, at the partition floor — two unambiguous communities. */
function twoCliques(size = MIN_NODES_TO_PARTITION / 2) {
  const name = (group: string, index: number) => `${group}${index}`;
  const nodes: CommunityInputNode[] = [];
  const edges: CommunityInputEdge[] = [];
  for (const group of ['a', 'b']) {
    for (let index = 0; index < size; index += 1) {
      nodes.push(...nodesOf(name(group, index)));
    }
    for (let from = 0; from < size; from += 1) {
      for (let to = from + 1; to < size; to += 1) {
        edges.push(...edgesOf([name(group, from), name(group, to)]));
      }
    }
  }
  edges.push(...edgesOf(['a0', 'b0']));
  return { nodes, edges };
}

const blockOf = (blocks: readonly CommunityBlock[], cardId: string): CommunityBlock =>
  blocks.find((block) => block.cardIds.includes(cardId))!;

const distanceIn = (positions: ReadonlyMap<string, { x: number; y: number }>, from: string, to: string) => {
  const a = positions.get(id(from))!;
  const b = positions.get(id(to))!;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

describe('communityLayout places every card exactly once', () => {
  it('positions every Node and every folded card', () => {
    const extraCardIds = ['folded:Request', 'folded:Response'];
    const { positions } = communityLayout({ ...SMALL_CHAIN, extraCardIds });
    for (const node of SMALL_CHAIN.nodes) {
      assert.ok(positions.has(node.id), `${node.id} is placed`);
    }
    for (const cardId of extraCardIds) {
      assert.ok(positions.has(cardId), `${cardId} is placed`);
    }
    assert.equal(positions.size, SMALL_CHAIN.nodes.length + extraCardIds.length);
  });

  it('no two cards share a position, at either side of the partition floor', () => {
    for (const [label, input] of [
      ['small', { ...SMALL_CHAIN, extraCardIds: ['folded:Request'] }],
      ['partitioned', { ...twoCliques(), extraCardIds: ['folded:Request'] }],
    ] as const) {
      const { positions } = communityLayout(input);
      const seen = new Set([...positions.values()].map((at) => `${at.x},${at.y}`));
      assert.equal(seen.size, positions.size, `${label}: every card has its own place`);
    }
  });

  it('an empty map lays nothing out', () => {
    assert.equal(communityLayout({ nodes: [], edges: [] }), EMPTY_COMMUNITY_LAYOUT);
  });
});

describe('communityLayout makes position mean something', () => {
  it('lays a call chain out in columns, depth increasing left to right', () => {
    const { positions, blocks } = communityLayout(SMALL_CHAIN);
    assert.equal(blocks.length, 1, 'a small map is one block');
    const xs = [id('a1'), id('a2'), id('a3')].map((cardId) => positions.get(cardId)!.x);
    assert.ok(xs[0]! < xs[1]! && xs[1]! < xs[2]!, `depth increases left to right: ${xs.join(' < ')}`);
  });

  it('separates two groups that barely call each other into different blocks', () => {
    const { blocks } = communityLayout(twoCliques());
    assert.notEqual(blockOf(blocks, id('a0')).communityId, blockOf(blocks, id('b1')).communityId);
  });

  it('keeps a Node nearer its own group than the other one', () => {
    const { positions } = communityLayout(twoCliques());
    assert.ok(
      distanceIn(positions, 'a1', 'a2') < distanceIn(positions, 'a1', 'b1'),
      'a1 sits nearer its own group than the other',
    );
  });

  it('lays blocks out without overlapping each other', () => {
    const { blocks } = communityLayout({ ...twoCliques(), extraCardIds: ['folded:Request', 'folded:Response'] });
    assert.ok(blocks.length >= 3, `expected community blocks plus the folded one, got ${blocks.length}`);
    for (const left of blocks) {
      for (const right of blocks) {
        if (left === right) {
          continue;
        }
        const disjoint =
          left.x + left.width <= right.x ||
          right.x + right.width <= left.x ||
          left.y + left.height <= right.y ||
          right.y + right.height <= left.y;
        assert.ok(disjoint, `${left.communityId} and ${right.communityId} overlap`);
      }
    }
  });
});

describe('communityLayout gives a structural position only to cards that earned one', () => {
  it('lays unreferenced Nodes out in their own block', () => {
    const nodes = [...SMALL_CHAIN.nodes, ...nodesOf('lonely', 'alsoLonely')];
    const { blocks, structure } = communityLayout({ nodes, edges: SMALL_CHAIN.edges });
    const block = blockOf(blocks, id('lonely'));
    assert.equal(block.communityId, UNREFERENCED_COMMUNITY_ID);
    assert.deepEqual([...block.cardIds], [...structure.partition.communities.at(-1)!.memberIds]);
  });

  it('lays the folded Type/Module cards out in their own block, labelled as such', () => {
    const { blocks } = communityLayout({ ...SMALL_CHAIN, extraCardIds: ['folded:Request'] });
    assert.equal(blockOf(blocks, 'folded:Request').communityId, FOLDED_BLOCK_ID);
  });

  it('a fully cyclic community still gets columns rather than one', () => {
    const nodes = nodesOf('c1', 'c2', 'c3');
    const edges = edgesOf(['c1', 'c2'], ['c2', 'c3'], ['c3', 'c1']);
    const { positions } = communityLayout({ nodes, edges });
    const xs = new Set([...positions.values()].map((at) => at.x));
    assert.ok(xs.size > 1, 'a cycle is not collapsed into a single column');
  });
});

describe('communityLayout is deterministic and settles', () => {
  const serialize = (layout: ReturnType<typeof communityLayout>) =>
    JSON.stringify({ positions: [...layout.positions.entries()].sort(), blocks: layout.blocks });

  it('gives the same positions however the nodes and edges are ordered', () => {
    const { nodes, edges } = twoCliques();
    const baseline = serialize(communityLayout({ nodes, edges }));
    const reversed = { nodes: [...nodes].reverse(), edges: [...edges].reverse() };
    assert.equal(serialize(communityLayout(reversed)), baseline);
  });

  it('feeding the same measurements back changes nothing — the re-layout loop terminates', () => {
    const cardSizeOf = () => ({ width: 320, height: 180 });
    const once = communityLayout({ ...SMALL_CHAIN, cardSizeOf });
    const twice = communityLayout({ ...SMALL_CHAIN, cardSizeOf });
    assert.equal(serialize(twice), serialize(once));
  });

  it('a card measured at the fallback size sits exactly where an unmeasured one would', () => {
    const unmeasured = communityLayout(SMALL_CHAIN);
    const atFallback = communityLayout({ ...SMALL_CHAIN, cardSizeOf: () => ({ width: 200, height: 80 }) });
    assert.equal(serialize(atFallback), serialize(unmeasured), 'the 200×80 card fits the grid pitch');
  });

  it('a larger measured card moves cards apart rather than overlapping them', () => {
    const gapOf = (sizes: LayeredCardSize | undefined) => {
      const { positions } = communityLayout({ ...SMALL_CHAIN, cardSizeOf: () => sizes });
      return Math.abs(positions.get(id('a2'))!.x - positions.get(id('a1'))!.x);
    };
    assert.ok(gapOf({ width: 320, height: 300 }) > gapOf(undefined), 'a wider card widens the column pitch');
  });
});

describe('samePositions is the re-layout guard', () => {
  it('a placement equals itself, and differs when a card moves a pixel or more', () => {
    const { positions } = communityLayout(SMALL_CHAIN);
    assert.ok(samePositions(positions, positions));
    const nudgedUnderAPixel = new Map(
      [...positions].map(([cardId, at]) => [cardId, { x: at.x + 0.4, y: at.y }] as const),
    );
    assert.ok(samePositions(positions, nudgedUnderAPixel), 'sub-pixel drift owes no re-layout');
    const moved = new Map([...positions].map(([cardId, at]) => [cardId, { x: at.x + 1, y: at.y }] as const));
    assert.ok(!samePositions(positions, moved));
  });

  it('differs when a card appears or disappears', () => {
    const { positions } = communityLayout(SMALL_CHAIN);
    const withExtra = new Map(positions).set('folded:Request', { x: 0, y: 0 });
    assert.ok(!samePositions(positions, withExtra));
    const renamed = new Map([...positions].slice(1)).set('other', { x: 0, y: 0 });
    assert.ok(!samePositions(positions, renamed));
  });
});

describe('communityStructure and communityPositions compose to the same layout', () => {
  it('the split path equals the one-call path', () => {
    const extraCardIds = ['folded:Request'];
    const cardSizeOf = () => ({ width: 300, height: 140 });
    const { nodes, edges } = twoCliques();
    const composed = communityLayout({ nodes, edges, extraCardIds, cardSizeOf });
    const structure = communityStructure(nodes, edges);
    const placed = communityPositions(structure, extraCardIds, cardSizeOf);
    assert.deepEqual([...placed.positions.entries()].sort(), [...composed.positions.entries()].sort());
    assert.deepEqual(placed.blocks, composed.blocks);
  });

  it('a structure reused across measurements keeps the same partition', () => {
    const { nodes, edges } = twoCliques();
    const structure = communityStructure(nodes, edges);
    const small = communityPositions(structure, [], () => ({ width: 200, height: 80 }));
    const large = communityPositions(structure, [], () => ({ width: 320, height: 300 }));
    assert.deepEqual(
      small.blocks.map((block) => [block.communityId, [...block.cardIds]]),
      large.blocks.map((block) => [block.communityId, [...block.cardIds]]),
      'measuring cards never repartitions the map',
    );
  });
});
