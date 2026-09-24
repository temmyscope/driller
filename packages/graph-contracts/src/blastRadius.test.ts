/**
 * P0-5: unit tests for the bounded, per-direction Blast Radius — one case per
 * row of the spec's I/O & Edge-Case Matrix, the review-round edge cases
 * (self-loop, parallel edges, the exact bound, invalid `maxHops`), and FR-7's
 * determinism (same input, same value).
 *
 * The PR Review parity row compares SETS: the badge's `blastRadiusNodeIds`
 * against `computeBlastRadiusHopDistances` for the same single seed, filtered
 * to distances 1..`BLAST_RADIUS_DEFAULT_HOPS` — what the stepper highlights
 * by default.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLAST_RADIUS_DEFAULT_HOPS,
  type PathTraceEdge,
  type PathTraceNode,
  blastRadiusNodeIds,
  buildBidirectionalAdjacency,
  computeBlastRadius,
  computeBlastRadiusFromAdjacency,
  computeBlastRadiusHopDistances,
} from './index';

function nodes(...ids: string[]): PathTraceNode[] {
  return ids.map((id) => ({ id, name: id }));
}

function edge(source: string, target: string, kind: PathTraceEdge['kind'] = 'CALLS'): PathTraceEdge {
  return { source, target, kind };
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

// A -> B -> C -> D -> E
const CHAIN_NODES = nodes('A', 'B', 'C', 'D', 'E');
const CHAIN_EDGES = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D'), edge('D', 'E')];

// Hub H calling five spokes, mixed edge kinds.
const SPOKES = ['S1', 'S2', 'S3', 'S4', 'S5'];
const HUB_NODES = nodes('H', ...SPOKES);
const HUB_EDGES = [
  edge('H', 'S1'),
  edge('H', 'S2'),
  edge('H', 'S3', 'IMPORTS'),
  edge('H', 'S4', 'USAGE'),
  edge('H', 'S5'),
];

// Cycle A -> B -> C -> A
const CYCLE_NODES = nodes('A', 'B', 'C');
const CYCLE_EDGES = [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')];

describe('BLAST_RADIUS_DEFAULT_HOPS', () => {
  it('is 2 (founder decision, 2026-09-25)', () => {
    assert.equal(BLAST_RADIUS_DEFAULT_HOPS, 2);
  });
});

describe('blast radius — spec matrix', () => {
  it('chain A->B->C->D->E, Node C: 4 (D, E forward; B, A backward)', () => {
    const adjacency = buildBidirectionalAdjacency(CHAIN_NODES, CHAIN_EDGES);
    assert.deepEqual(sorted(blastRadiusNodeIds(adjacency, 'C')), ['A', 'B', 'D', 'E']);
    assert.equal(computeBlastRadius(CHAIN_NODES, CHAIN_EDGES, 'C'), 4);
  });

  it('chain, Node A: 2 (B, C) — differs from C', () => {
    const adjacency = buildBidirectionalAdjacency(CHAIN_NODES, CHAIN_EDGES);
    assert.deepEqual(sorted(blastRadiusNodeIds(adjacency, 'A')), ['B', 'C']);
    assert.deepEqual(
      CHAIN_NODES.map((node) => computeBlastRadiusFromAdjacency(adjacency, node.id)),
      [2, 3, 4, 3, 2],
    );
  });

  it('hub calling 5 spokes: hub 5, each spoke 1 (only H depends on it)', () => {
    const adjacency = buildBidirectionalAdjacency(HUB_NODES, HUB_EDGES);
    assert.equal(computeBlastRadiusFromAdjacency(adjacency, 'H'), 5);
    for (const spoke of SPOKES) {
      assert.deepEqual(sorted(blastRadiusNodeIds(adjacency, spoke)), ['H'], spoke);
    }
  });

  it('siblings S1, S3 both called by H: S1 does not count S3', () => {
    const adjacency = buildBidirectionalAdjacency(HUB_NODES, HUB_EDGES);
    assert.equal(blastRadiusNodeIds(adjacency, 'S1').has('S3'), false);
    // Same for a shared callee: X -> T <- Y, X does not count Y.
    const shared = buildBidirectionalAdjacency(nodes('X', 'Y', 'T'), [edge('X', 'T'), edge('Y', 'T')]);
    assert.deepEqual(sorted(blastRadiusNodeIds(shared, 'X')), ['T']);
  });

  it('cycle A->B->C->A, Node A: 2, terminates', () => {
    assert.equal(computeBlastRadius(CYCLE_NODES, CYCLE_EDGES, 'A'), 2);
  });

  it('isolated Node: 0', () => {
    assert.equal(computeBlastRadius(nodes('A', 'B', 'X'), [edge('A', 'B')], 'X'), 0);
  });

  it('unknown Node: 0', () => {
    assert.equal(computeBlastRadius(CHAIN_NODES, CHAIN_EDGES, 'missing'), 0);
  });
});

describe('blast radius — edge cases', () => {
  it('self-loop: never counts the origin', () => {
    assert.equal(computeBlastRadius(nodes('A'), [edge('A', 'A')], 'A'), 0);
    assert.equal(computeBlastRadius(nodes('A', 'B'), [edge('A', 'A'), edge('A', 'B')], 'A'), 1);
  });

  it('parallel edges of different kinds between one pair count the Node once', () => {
    const edges = [edge('A', 'B', 'CALLS'), edge('A', 'B', 'IMPORTS'), edge('A', 'B', 'USAGE')];
    assert.equal(computeBlastRadius(nodes('A', 'B'), edges, 'A'), 1);
    assert.equal(computeBlastRadius(nodes('A', 'B'), edges, 'B'), 1);
  });

  it('a Node exactly at the bound is counted but not expanded', () => {
    // A -> B -> C -> D: C is at 2 hops from A and has a further neighbour D.
    const adjacency = buildBidirectionalAdjacency(nodes('A', 'B', 'C', 'D'), [
      edge('A', 'B'),
      edge('B', 'C'),
      edge('C', 'D'),
    ]);
    assert.deepEqual(sorted(blastRadiusNodeIds(adjacency, 'A')), ['B', 'C']);
  });

  it('dangling edge endpoints are not counted', () => {
    assert.equal(computeBlastRadius(nodes('A', 'B'), [edge('A', 'B'), edge('B', 'ghost')], 'A'), 1);
  });

  it('explicit valid maxHops overrides the default', () => {
    assert.equal(computeBlastRadius(CHAIN_NODES, CHAIN_EDGES, 'A', 1), 1);
    assert.equal(computeBlastRadius(CHAIN_NODES, CHAIN_EDGES, 'A', 4), 4);
  });

  it('invalid maxHops (0, negative, NaN, fractional, Infinity) counts nothing', () => {
    for (const maxHops of [0, -1, -3, Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(computeBlastRadius(CHAIN_NODES, CHAIN_EDGES, 'C', maxHops), 0, String(maxHops));
    }
  });

  it('is deterministic under node and edge reordering, parallel edges included (FR-7)', () => {
    const graphNodes = nodes('A', 'B', 'C', 'D', 'E', 'H', 'S1', 'S2');
    const graphEdges = [
      ...CHAIN_EDGES,
      edge('A', 'B', 'IMPORTS'),
      edge('C', 'D', 'USAGE'),
      edge('H', 'S1'),
      edge('H', 'S2'),
      edge('S1', 'C'),
      edge('E', 'A'),
    ];
    const snapshot = (ns: PathTraceNode[], es: PathTraceEdge[]) => {
      const adjacency = buildBidirectionalAdjacency(ns, es);
      return Object.fromEntries(
        graphNodes.map((node) => [node.id, sorted(blastRadiusNodeIds(adjacency, node.id))] as const),
      );
    };
    const baseline = snapshot(graphNodes, graphEdges);
    // Deterministic permutations (seeded LCG), so a failure is reproducible.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const shuffled = <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    };
    for (let round = 0; round < 10; round += 1) {
      const again = snapshot(shuffled(graphNodes), shuffled(graphEdges));
      assert.deepEqual(again, baseline, `round ${round}`);
      for (const node of graphNodes) {
        assert.equal(
          computeBlastRadius(shuffled(graphNodes), shuffled(graphEdges), node.id),
          baseline[node.id]!.length,
          `${node.id}, round ${round}`,
        );
      }
    }
  });
});

describe('computeBlastRadiusHopDistances (directional)', () => {
  it('keeps the smaller of forward and backward distance, seeds excluded', () => {
    const adjacency = buildBidirectionalAdjacency(CHAIN_NODES, CHAIN_EDGES);
    assert.deepEqual(
      Object.fromEntries(computeBlastRadiusHopDistances(adjacency, ['C'])),
      { D: 1, E: 2, B: 1, A: 2 },
    );
  });

  it('is unbounded: distances run past the badge cap', () => {
    const adjacency = buildBidirectionalAdjacency(CHAIN_NODES, CHAIN_EDGES);
    assert.deepEqual(
      Object.fromEntries(computeBlastRadiusHopDistances(adjacency, ['A'])),
      { B: 1, C: 2, D: 3, E: 4 },
    );
  });

  it('never reaches a sibling through a shared caller', () => {
    const adjacency = buildBidirectionalAdjacency(HUB_NODES, HUB_EDGES);
    assert.deepEqual(Object.fromEntries(computeBlastRadiusHopDistances(adjacency, ['S1'])), { H: 1 });
  });

  it('multi-source: minimum over seeds; unknown and duplicate seeds are harmless', () => {
    const adjacency = buildBidirectionalAdjacency(CHAIN_NODES, CHAIN_EDGES);
    assert.deepEqual(
      Object.fromEntries(computeBlastRadiusHopDistances(adjacency, ['A', 'E', 'A', 'missing'])),
      { B: 1, C: 2, D: 1 },
    );
  });

  it('cycle terminates', () => {
    const adjacency = buildBidirectionalAdjacency(CYCLE_NODES, CYCLE_EDGES);
    assert.deepEqual(Object.fromEntries(computeBlastRadiusHopDistances(adjacency, ['A'])), { B: 1, C: 1 });
  });
});

describe('PR Review default highlight parity', () => {
  it('one changed Node: highlight at the default depth is exactly the badge set', () => {
    const graphs: Array<[PathTraceNode[], PathTraceEdge[]]> = [
      [CHAIN_NODES, CHAIN_EDGES],
      [HUB_NODES, HUB_EDGES],
      [CYCLE_NODES, CYCLE_EDGES],
      [nodes('X', 'Y', 'T', 'U'), [edge('X', 'T'), edge('Y', 'T'), edge('T', 'U'), edge('U', 'U')]],
    ];
    for (const [graphNodes, graphEdges] of graphs) {
      const adjacency = buildBidirectionalAdjacency(graphNodes, graphEdges);
      for (const node of graphNodes) {
        const highlighted = [...computeBlastRadiusHopDistances(adjacency, [node.id])]
          .filter(([, distance]) => distance >= 1 && distance <= BLAST_RADIUS_DEFAULT_HOPS)
          .map(([id]) => id);
        assert.deepEqual(sorted(highlighted), sorted(blastRadiusNodeIds(adjacency, node.id)), node.id);
      }
    }
  });
});

describe('PR Review multi-seed parity', () => {
  it('default-depth highlight equals the union of each seed\'s badge set, minus the seeds', () => {
    // M is reached forward from S (S -> M) and backward from T (M -> T):
    // one Node found from two seeds in opposite directions.
    const graphNodes = nodes('P', 'S', 'M', 'T', 'Q', 'R', 'Z');
    const graphEdges = [
      edge('P', 'S'),
      edge('S', 'M'),
      edge('M', 'T'),
      edge('T', 'Q'),
      edge('Q', 'R'),
      edge('R', 'Z'),
      edge('S', 'T', 'IMPORTS'),
    ];
    const adjacency = buildBidirectionalAdjacency(graphNodes, graphEdges);
    for (const seeds of [['S', 'T'], ['S', 'R'], ['P', 'Z', 'M'], ['T']]) {
      const highlighted = [...computeBlastRadiusHopDistances(adjacency, seeds)]
        .filter(([, distance]) => distance >= 1 && distance <= BLAST_RADIUS_DEFAULT_HOPS)
        .map(([id]) => id);
      const union = new Set<string>();
      for (const seed of seeds) {
        for (const id of blastRadiusNodeIds(adjacency, seed)) {
          union.add(id);
        }
      }
      for (const seed of seeds) {
        union.delete(seed);
      }
      assert.deepEqual(sorted(highlighted), sorted(union), seeds.join(','));
    }
    // The opposite-direction case, pinned explicitly: M is 1 hop from both.
    const both = computeBlastRadiusHopDistances(adjacency, ['S', 'T']);
    assert.equal(both.get('M'), 1);
    assert.equal(blastRadiusNodeIds(adjacency, 'S').has('M'), true);
    assert.equal(blastRadiusNodeIds(adjacency, 'T').has('M'), true);
  });
});

