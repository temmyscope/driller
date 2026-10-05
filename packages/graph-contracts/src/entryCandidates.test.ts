/**
 * P4-7 phase 1a: `listEntryCandidates` — one case per row of the spec's
 * I/O & Edge-Case Matrix, plus the hand-built `fixtures/path-trace-basic`
 * call graph (as `pathTrace.test.ts` builds it) and the reach-3 boundary.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type BidirectionalAdjacency,
  blastRadiusNodeIds,
  ENTRY_CALLER_EDGE_KINDS,
  ENTRY_CANDIDATE_LOADED_BY_MAX,
  ENTRY_CANDIDATE_MAX,
  ENTRY_CANDIDATE_MIN_REACH,
  ENTRY_PINS_MAX,
  type EntryCandidateInputNode,
  type EntryCandidatesResult,
  entryReachAdjacency,
  listEntryCandidates,
  listEntryCandidatesWithWork,
  type PathTraceEdge,
} from './index';

function node(id: string, calledAtLoadBy?: string[]): EntryCandidateInputNode {
  return { id, name: id, file: `src/${id}.ts`, startLine: 1, endLine: 2, ...(calledAtLoadBy ? { calledAtLoadBy } : {}) };
}

function nodes(...ids: string[]): EntryCandidateInputNode[] {
  return ids.map((id) => node(id));
}

function edge(source: string, target: string, kind: PathTraceEdge['kind'] = 'CALLS'): PathTraceEdge {
  return { source, target, kind };
}

/** A chain `root -> root.1 -> … -> root.length`: `root` reaches `length` Nodes. */
function chain(root: string, length: number): { nodes: EntryCandidateInputNode[]; edges: PathTraceEdge[] } {
  const ids = [root, ...Array.from({ length }, (_, index) => `${root}.${index + 1}`)];
  return { nodes: nodes(...ids), edges: ids.slice(1).map((id, index) => edge(ids[index]!, id)) };
}

function merge(...graphs: { nodes: EntryCandidateInputNode[]; edges: PathTraceEdge[] }[]) {
  return { nodes: graphs.flatMap((graph) => graph.nodes), edges: graphs.flatMap((graph) => graph.edges) };
}

function candidateIds(result: EntryCandidatesResult): string[] {
  assert.equal(result.status, 'found');
  return result.status === 'found' ? result.candidates.map((candidate) => candidate.id) : [];
}

/** A deterministic shuffle (seeded LCG), so a failure reproduces. */
function shuffled<T>(values: readonly T[], seed: number): T[] {
  const copy = [...values];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const other = state % (index + 1);
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

// fixtures/path-trace-basic: handleRequest -> serviceA, serviceB; both ->
// repository; repository <-> cacheLookup; utilA/utilB each export a
// standalone `helper`. Plus an IMPORTS edge and a dangling edge, which count
// for nothing.
const PATH_TRACE_BASIC = {
  nodes: [
    ...nodes('handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup'),
    { id: 'utilA.helper', name: 'helper', file: 'utilA.ts', startLine: 12, endLine: 15 },
    { id: 'utilB.helper', name: 'helper', file: 'utilB.ts', startLine: 5, endLine: 8 },
  ],
  edges: [
    edge('handleRequest', 'serviceA'),
    edge('handleRequest', 'serviceB'),
    edge('serviceA', 'repository'),
    edge('serviceB', 'repository'),
    edge('repository', 'cacheLookup'),
    edge('cacheLookup', 'repository'),
    edge('handleRequest', 'utilA.helper', 'IMPORTS'),
    edge('handleRequest', 'ghost'),
    edge('ghost', 'serviceA'),
  ],
};

describe('listEntryCandidates (P4-7 phase 1a)', () => {
  it('path-trace-basic: handleRequest is the one candidate, reach 4, no callers; the helpers are dropped', () => {
    assert.deepEqual(listEntryCandidates(PATH_TRACE_BASIC.nodes, PATH_TRACE_BASIC.edges), {
      status: 'found',
      candidates: [
        {
          id: 'handleRequest',
          name: 'handleRequest',
          file: 'src/handleRequest.ts',
          startLine: 1,
          endLine: 2,
          reach: 4,
          reason: { kind: 'no-callers' },
        },
      ],
      totalQualifying: 1,
      relations: [],
    });
  });

  it('a Node whose only in-edge is USAGE (rendered via JSX) is never a candidate', () => {
    const graph = merge(chain('Panel', 3), { nodes: nodes('App'), edges: [edge('App', 'Panel', 'USAGE')] });
    // App reaches Panel and Panel's chain through the USAGE edge.
    assert.deepEqual(candidateIds(listEntryCandidates(graph.nodes, graph.edges)), ['App']);
    assert.ok(ENTRY_CALLER_EDGE_KINDS.includes('USAGE'));
  });

  it('a Node called only at load is a candidate, and its reason names the loading file', () => {
    const graph = chain('createWindow', 3);
    graph.nodes[0] = node('createWindow', ['main/index.ts']);
    assert.deepEqual(listEntryCandidates(graph.nodes, graph.edges), {
      status: 'found',
      candidates: [
        {
          id: 'createWindow',
          name: 'createWindow',
          file: 'src/createWindow.ts',
          startLine: 1,
          endLine: 2,
          reach: 3,
          reason: { kind: 'no-callers', loadedBy: ['main/index.ts'], loadedByTotal: 1 },
        },
      ],
      totalQualifying: 1,
      relations: [],
    });
  });

  it('loadedBy is sorted, deduplicated and capped, with the full count beside it', () => {
    const graph = chain('init', 3);
    graph.nodes[0] = node('init', ['z.ts', 'b.ts', 'a.ts', 'b.ts', 'c.ts']);
    const result = listEntryCandidates(graph.nodes, graph.edges);
    assert.equal(ENTRY_CANDIDATE_LOADED_BY_MAX, 3);
    assert.ok(result.status === 'found');
    assert.deepEqual(result.candidates[0]!.reason, { kind: 'no-callers', loadedBy: ['a.ts', 'b.ts', 'c.ts'], loadedByTotal: 4 });
  });

  it('a fully cyclic graph has no candidate', () => {
    const graph = { nodes: nodes('a', 'b', 'c', 'd'), edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'a')] };
    assert.deepEqual(listEntryCandidates(graph.nodes, graph.edges), { status: 'none' });
  });

  it('an empty graph has no candidate', () => {
    assert.deepEqual(listEntryCandidates([], []), { status: 'none' });
  });

  it(`20 qualifying roots give ${ENTRY_CANDIDATE_MAX} candidates and totalQualifying 20`, () => {
    // Root rN reaches 3 + N Nodes, so the top 12 are r19 … r8.
    const graph = merge(...Array.from({ length: 20 }, (_, index) => chain(`r${String(index).padStart(2, '0')}`, 3 + index)));
    const result = listEntryCandidates(graph.nodes, graph.edges);
    assert.equal(ENTRY_CANDIDATE_MAX, 12);
    assert.ok(result.status === 'found');
    assert.equal(result.totalQualifying, 20);
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.reach]),
      Array.from({ length: 12 }, (_, index) => [`r${String(19 - index).padStart(2, '0')}`, 22 - index]),
    );
  });

  it('a tie on reach is ordered by id ascending', () => {
    const graph = merge(chain('zeta', 5), chain('alpha', 5), chain('mid', 5));
    assert.deepEqual(candidateIds(listEntryCandidates(graph.nodes, graph.edges)), ['alpha', 'mid', 'zeta']);
  });

  it('shuffled input arrays give an identical result', () => {
    const graph = merge(
      PATH_TRACE_BASIC,
      chain('zeta', 5),
      chain('alpha', 5),
      chain('big', 9),
      chain('omega', 7),
      chain('beta', 7),
      { nodes: [node('boot', ['b.ts', 'a.ts'])], edges: [edge('boot', 'alpha'), edge('boot', 'zeta')] },
    );
    const expected = listEntryCandidates(graph.nodes, graph.edges);
    assert.deepEqual(candidateIds(expected), ['boot', 'big', 'beta', 'omega', 'handleRequest']);
    for (let seed = 1; seed <= 25; seed += 1) {
      assert.deepEqual(listEntryCandidates(shuffled(graph.nodes, seed), shuffled(graph.edges, seed * 7 + 3)), expected);
    }
  });

  it('an IMPORTS-only in-edge is not a caller, and IMPORTS adds no reach', () => {
    const graph = merge(chain('lib', 3), chain('app', 3), { nodes: [], edges: [edge('app', 'lib', 'IMPORTS')] });
    const result = listEntryCandidates(graph.nodes, graph.edges);
    assert.ok(result.status === 'found');
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.reach]),
      [
        ['app', 3],
        ['lib', 3],
      ],
    );
  });

  it(`reach exactly ${ENTRY_CANDIDATE_MIN_REACH} qualifies; one less does not`, () => {
    assert.equal(ENTRY_CANDIDATE_MIN_REACH, 3);
    const graph = merge(chain('three', 3), chain('two', 2));
    assert.deepEqual(candidateIds(listEntryCandidates(graph.nodes, graph.edges)), ['three']);
  });

  it('a self-loop is not a caller, and a dangling edge is not one either', () => {
    const graph = merge(chain('root', 3), { nodes: [], edges: [edge('root', 'root'), edge('ghost', 'root'), edge('root', 'ghost')] });
    const result = listEntryCandidates(graph.nodes, graph.edges);
    assert.ok(result.status === 'found');
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.reach]),
      [['root', 3]],
    );
  });

  it('reach counts each Node once through fan-in and cycles', () => {
    // root -> a, b; a, b -> c; c <-> d: reach 4, not 5.
    const graph = {
      nodes: nodes('root', 'a', 'b', 'c', 'd'),
      edges: [edge('root', 'a'), edge('root', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'd'), edge('d', 'c')],
    };
    const result = listEntryCandidates(graph.nodes, graph.edges);
    assert.ok(result.status === 'found');
    assert.equal(result.candidates[0]!.reach, 4);
  });

  it("a candidate's reach is the size of the full forward walk over entryReachAdjacency", () => {
    const graph = merge(PATH_TRACE_BASIC, { nodes: nodes('x'), edges: [edge('repository', 'x', 'USAGE'), edge('serviceA', 'x', 'IMPORTS')] });
    const adjacency = entryReachAdjacency(graph.nodes, graph.edges);
    const seen = new Set<string>(['handleRequest']);
    const queue = ['handleRequest'];
    while (queue.length > 0) {
      for (const next of adjacency.forward.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const result = listEntryCandidates(graph.nodes, graph.edges);
    assert.ok(result.status === 'found');
    assert.equal(result.candidates[0]!.reach, seen.size - 1);
    assert.equal(result.candidates[0]!.reach, 5);
    // entryReachAdjacency keeps only CALLS and USAGE edges.
    assert.deepEqual(adjacency.forward.get('serviceA'), ['repository']);
  });

  it('a repeated Node id is listed once', () => {
    const graph = chain('root', 3);
    const result = listEntryCandidates([...graph.nodes, node('root')], graph.edges);
    assert.deepEqual(candidateIds(result), ['root']);
  });
});

/**
 * The reference `listEntryCandidates` must equal, built independently of
 * its code: the caller edges are filtered from the raw edges here, callers
 * come straight from them, the forward map is built here, reach is the
 * string-keyed `directionalHopDistances` walk of every root in full
 * (through the exported `blastRadiusNodeIds`, given that forward-only map
 * and an effectively unbounded hop count), and `reason` is rebuilt from
 * `calledAtLoadBy`. No pruning: every root is walked and ranked.
 */
function referenceEntryCandidates(graphNodes: EntryCandidateInputNode[], graphEdges: PathTraceEdge[]): EntryCandidatesResult {
  const byId = new Map<string, EntryCandidateInputNode>();
  for (const graphNode of graphNodes) {
    if (!byId.has(graphNode.id)) {
      byId.set(graphNode.id, graphNode);
    }
  }
  const callerEdges = graphEdges.filter(
    (graphEdge) =>
      (graphEdge.kind === 'CALLS' || graphEdge.kind === 'USAGE') && byId.has(graphEdge.source) && byId.has(graphEdge.target),
  );
  const called = new Set(callerEdges.filter((graphEdge) => graphEdge.source !== graphEdge.target).map((graphEdge) => graphEdge.target));
  const forward = new Map<string, string[]>();
  for (const graphEdge of callerEdges) {
    forward.set(graphEdge.source, [...(forward.get(graphEdge.source) ?? []), graphEdge.target]);
  }
  const forwardOnly: BidirectionalAdjacency = { validNodeIds: new Set(byId.keys()), forward, backward: new Map() };
  const qualifying = [...byId.values()]
    .filter((graphNode) => !called.has(graphNode.id))
    .map((graphNode) => ({ graphNode, reach: blastRadiusNodeIds(forwardOnly, graphNode.id, Number.MAX_SAFE_INTEGER).size }))
    .filter((root) => root.reach >= 3)
    .sort((a, b) => b.reach - a.reach || (a.graphNode.id < b.graphNode.id ? -1 : 1));
  if (qualifying.length === 0) {
    return { status: 'none' };
  }
  const listed = qualifying.slice(0, 12);
  return {
    status: 'found',
    candidates: listed.map(({ graphNode, reach }) => {
      const loadedBy = [...new Set(graphNode.calledAtLoadBy ?? [])].sort();
      return {
        id: graphNode.id,
        name: graphNode.name,
        file: graphNode.file,
        startLine: graphNode.startLine,
        endLine: graphNode.endLine,
        reach,
        reason: loadedBy.length === 0 ? { kind: 'no-callers' } : { kind: 'no-callers', loadedBy: loadedBy.slice(0, 3), loadedByTotal: loadedBy.length },
      };
    }),
    totalQualifying: qualifying.length,
    relations: referenceRelations(
      forwardOnly,
      listed.map(({ graphNode }) => graphNode.id),
    ),
  };
}

/**
 * P4-7h: the reference relations, built independently: every unordered pair
 * of `ids`, each candidate's reach set walked again here with the
 * string-keyed `blastRadiusNodeIds`, intersected as plain `Set`s with both
 * candidates removed, zero overlaps dropped, sorted by count then ids.
 */
function referenceRelations(forwardOnly: BidirectionalAdjacency, ids: readonly string[]) {
  const reachOf = new Map(ids.map((id) => [id, blastRadiusNodeIds(forwardOnly, id, Number.MAX_SAFE_INTEGER)]));
  const relations: { a: string; b: string; sharedReach: number }[] = [];
  for (const first of ids) {
    for (const second of ids) {
      if (!(first < second)) {
        continue;
      }
      const sharedReach = [...reachOf.get(first)!].filter(
        (id) => id !== first && id !== second && reachOf.get(second)!.has(id),
      ).length;
      if (sharedReach > 0) {
        relations.push({ a: first, b: second, sharedReach });
      }
    }
  }
  return relations.sort((x, y) => y.sharedReach - x.sharedReach || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
}

/** P4-7h: the forward-only CALLS/USAGE map `referenceRelations` walks, built from the raw edges. */
function referenceForward(graphNodes: EntryCandidateInputNode[], graphEdges: PathTraceEdge[]): BidirectionalAdjacency {
  const ids = new Set(graphNodes.map((graphNode) => graphNode.id));
  const forward = new Map<string, string[]>();
  for (const graphEdge of graphEdges) {
    if ((graphEdge.kind === 'CALLS' || graphEdge.kind === 'USAGE') && ids.has(graphEdge.source) && ids.has(graphEdge.target)) {
      forward.set(graphEdge.source, [...(forward.get(graphEdge.source) ?? []), graphEdge.target]);
    }
  }
  return { validNodeIds: ids, forward, backward: new Map() };
}

/** A seeded pseudo-random source (LCG), so a failure reproduces. */
function seeded(seed: number): (bound: number) => number {
  let state = seed;
  return (bound) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };
}

const LOAD_FILES = ['main/index.ts', 'a.ts', 'b.ts', 'c.ts', 'z.ts'];

/** Random `calledAtLoadBy` on about a third of the Nodes, with repeats. */
function withLoadCallers(ids: string[], next: (bound: number) => number): EntryCandidateInputNode[] {
  return ids.map((id) =>
    next(3) === 0 ? node(id, Array.from({ length: 1 + next(5) }, () => LOAD_FILES[next(LOAD_FILES.length)]!)) : node(id),
  );
}

/** A seeded random graph with cycles, self-loops, dangling and duplicate edges, and every edge kind. */
function randomGraph(seed: number, nodeCount: number, edgeCount: number): { nodes: EntryCandidateInputNode[]; edges: PathTraceEdge[] } {
  const next = seeded(seed);
  const kinds: PathTraceEdge['kind'][] = ['CALLS', 'USAGE', 'IMPORTS'];
  const ids = Array.from({ length: nodeCount }, (_, index) => `n${index}`);
  const graphEdges: PathTraceEdge[] = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const roll = next(20);
    const source = roll === 0 ? 'ghost' : ids[next(nodeCount)]!;
    const target = roll === 1 ? 'ghost' : roll === 2 ? source : ids[next(nodeCount)]!;
    const graphEdge = edge(source, target, kinds[next(kinds.length)]);
    graphEdges.push(graphEdge);
    if (roll === 3) {
      graphEdges.push({ ...graphEdge });
    }
  }
  return { nodes: withLoadCallers(ids, next), edges: graphEdges };
}

/**
 * A seeded random forest of many roots over a shared pool, built to take
 * the pruned path: more than `ENTRY_CANDIDATE_MAX` qualifying roots, many
 * tied reaches, and mostly tree-shaped reach (tight bounds), with some
 * sharing, cycles and IMPORTS so the bounds are sometimes loose.
 */
function rootForest(seed: number): { nodes: EntryCandidateInputNode[]; edges: PathTraceEdge[] } {
  const next = seeded(seed);
  const ids: string[] = [];
  const graphEdges: PathTraceEdge[] = [];
  const pool = Array.from({ length: 40 }, (_, index) => `p${index}`);
  ids.push(...pool);
  for (let index = 0; index < 39; index += 1) {
    if (next(2) === 0) {
      graphEdges.push(edge(pool[index]!, pool[index + 1 + next(39 - index)]!, next(4) === 0 ? 'USAGE' : 'CALLS'));
    }
  }
  if (next(2) === 0) {
    graphEdges.push(edge('p39', 'p30'));
  }
  const rootCount = 14 + next(20);
  for (let root = 0; root < rootCount; root += 1) {
    const id = `r${next(1000)}-${root}`;
    ids.push(id);
    // A private chain of 2–6 Nodes, so many roots tie on reach.
    let previous = id;
    for (let link = 0; link < 2 + next(5); link += 1) {
      const linkId = `${id}.${link}`;
      ids.push(linkId);
      graphEdges.push(edge(previous, linkId, next(5) === 0 ? 'USAGE' : 'CALLS'));
      previous = linkId;
    }
    // Sometimes into the shared pool (sharing loosens the bound), sometimes only an import.
    const roll = next(4);
    if (roll === 0) {
      graphEdges.push(edge(previous, pool[next(pool.length)]!));
    } else if (roll === 1) {
      graphEdges.push(edge(id, pool[next(pool.length)]!, 'IMPORTS'));
    }
  }
  return { nodes: withLoadCallers(ids, next), edges: graphEdges };
}

describe('listEntryCandidates equals an independent full-walk reference (P4-7 indexed BFS and pruning)', () => {
  it('on 200 seeded random graphs, sparse to dense', () => {
    let found = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const nodeCount = 1 + (seed % 60);
      const graph = randomGraph(seed, nodeCount, Math.floor(nodeCount * (0.5 + (seed % 7) * 0.4)));
      const expected = referenceEntryCandidates(graph.nodes, graph.edges);
      assert.deepEqual(listEntryCandidates(graph.nodes, graph.edges), expected, `seed ${seed}`);
      found += expected.status === 'found' ? 1 : 0;
    }
    // The generator must exercise both outcomes, or the comparison proves little.
    assert.ok(found > 50 && found < 200, `found in ${found} of 200`);
  });

  it('on 200 seeded root forests that take the pruned path, with ties at the cutoff', () => {
    let pruned = 0;
    let tiedAtCutoff = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const graph = rootForest(seed);
      const expected = referenceEntryCandidates(graph.nodes, graph.edges);
      const { result, exactReachWalks } = listEntryCandidatesWithWork(graph.nodes, graph.edges);
      assert.deepEqual(result, expected, `seed ${seed}`);
      assert.ok(expected.status === 'found' && expected.totalQualifying > ENTRY_CANDIDATE_MAX, `seed ${seed}`);
      if (expected.status !== 'found') {
        continue;
      }
      pruned += exactReachWalks.length < expected.totalQualifying ? 1 : 0;
      // A root left out at the cutoff with the same reach as the last one ranked.
      const lastReach = expected.candidates[ENTRY_CANDIDATE_MAX - 1]!.reach;
      const adjacency = entryReachAdjacency(graph.nodes, graph.edges);
      const leftOutTied = graph.nodes.some(
        (graphNode) =>
          /^r\d+-\d+$/.test(graphNode.id) &&
          !expected.candidates.some((candidate) => candidate.id === graphNode.id) &&
          blastRadiusNodeIds(adjacency, graphNode.id, Number.MAX_SAFE_INTEGER).size === lastReach,
      );
      tiedAtCutoff += leftOutTied ? 1 : 0;
    }
    // Both the pruned path and ties at the cutoff must actually be exercised.
    assert.ok(pruned > 100, `pruned in ${pruned} of 200`);
    assert.ok(tiedAtCutoff > 50, `tied at the cutoff in ${tiedAtCutoff} of 200`);
  });

  it('on the hand-built fixtures and matrix graphs', () => {
    const graphs = [
      PATH_TRACE_BASIC,
      merge(PATH_TRACE_BASIC, chain('zeta', 5), chain('alpha', 5), chain('big', 9)),
      merge(...Array.from({ length: 20 }, (_, index) => chain(`r${String(index).padStart(2, '0')}`, 3 + index))),
      { nodes: nodes('a', 'b', 'c', 'd'), edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'a')] },
    ];
    for (const graph of graphs) {
      assert.deepEqual(listEntryCandidates(graph.nodes, graph.edges), referenceEntryCandidates(graph.nodes, graph.edges));
    }
  });
});

describe('listEntryCandidates pruning skips work it can prove unnecessary (P4-7)', () => {
  it('walks in full only the roots that can still rank; the rest only to the qualifying bar, or not at all', () => {
    // 12 big roots (reach 20–31), 50 small ones (reach 4), 5 tiny ones (reach 1).
    const big = Array.from({ length: 12 }, (_, index) => chain(`big${String(index).padStart(2, '0')}`, 20 + index));
    const small = Array.from({ length: 50 }, (_, index) => chain(`small${String(index).padStart(2, '0')}`, 4));
    const tiny = Array.from({ length: 5 }, (_, index) => chain(`tiny${index}`, 1));
    const graph = merge(...shuffled([...big, ...small, ...tiny], 11));
    const { result, roots, exactReachWalks } = listEntryCandidatesWithWork(graph.nodes, graph.edges);
    assert.equal(roots, 67);
    assert.deepEqual(exactReachWalks, Array.from({ length: 12 }, (_, index) => `big${String(11 - index).padStart(2, '0')}`));
    assert.ok(result.status === 'found');
    assert.equal(result.totalQualifying, 62);
    assert.deepEqual(result, referenceEntryCandidates(graph.nodes, graph.edges));
  });

  it('a tie at the cutoff stops after the 12 lowest ids, and still counts every qualifying root', () => {
    const ids = shuffled(
      Array.from({ length: 20 }, (_, index) => `t${String(index).padStart(2, '0')}`),
      5,
    );
    const graph = merge(...ids.map((id) => chain(id, 5)));
    const { result, exactReachWalks } = listEntryCandidatesWithWork(graph.nodes, graph.edges);
    const lowest = Array.from({ length: 12 }, (_, index) => `t${String(index).padStart(2, '0')}`);
    assert.deepEqual(exactReachWalks, lowest);
    assert.ok(result.status === 'found');
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id),
      lowest,
    );
    assert.equal(result.totalQualifying, 20);
  });

  it('a loose bound walks a root in full that then fails to rank, and an equal bound with a lower id still ranks', () => {
    // zz: a diamond onto an 8-Node tail — reach 10, but its bound counts the
    // shared tail twice (18). lo: lo -> lo.a -> lo.s and lo -> lo.s — reach 2,
    // bound 3.
    const zzTail = chain('zz.s', 7);
    const graph = merge(
      ...Array.from({ length: 11 }, (_, index) => chain(`a${String(index).padStart(2, '0')}`, 20)),
      zzTail,
      {
        nodes: nodes('zz', 'zz.a', 'zz.b', 'lo', 'lo.a', 'lo.s'),
        edges: [
          edge('zz', 'zz.a'),
          edge('zz', 'zz.b'),
          edge('zz.a', 'zz.s'),
          edge('zz.b', 'zz.s'),
          edge('lo', 'lo.a'),
          edge('lo', 'lo.s'),
          edge('lo.a', 'lo.s'),
        ],
      },
      chain('mm', 10),
      ...Array.from({ length: 5 }, (_, index) => chain(`b${index}`, 5)),
    );
    const { result, exactReachWalks } = listEntryCandidatesWithWork(graph.nodes, graph.edges);
    const elevens = Array.from({ length: 11 }, (_, index) => `a${String(index).padStart(2, '0')}`);
    // zz is walked (bound 18) and ranks 12th at reach 10, until mm (bound and
    // reach 10, a lower id) takes its place; the b roots and lo are only
    // checked against the qualifying bar.
    assert.deepEqual(exactReachWalks, [...elevens, 'zz', 'mm']);
    assert.ok(result.status === 'found');
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.reach]),
      [...elevens.map((id) => [id, 20]), ['mm', 10]],
    );
    // 11 a, zz, mm and 5 b qualify; lo (reach 2) does not.
    assert.equal(result.totalQualifying, 18);
    assert.deepEqual(result, referenceEntryCandidates(graph.nodes, graph.edges));
  });
});

describe('listEntryCandidates with pins (P4-7g)', () => {
  const pinsOf = (pinnedIds: readonly string[]) => listEntryCandidates(PATH_TRACE_BASIC.nodes, PATH_TRACE_BASIC.edges, { pinnedIds });

  it('pin serviceB: it comes first, pinned, with its real reach (2), then handleRequest', () => {
    const result = pinsOf(['serviceB']);
    assert.deepEqual(result, {
      status: 'found',
      candidates: [
        { id: 'serviceB', name: 'serviceB', file: 'src/serviceB.ts', startLine: 1, endLine: 2, reach: 2, reason: { kind: 'pinned' } },
        { id: 'handleRequest', name: 'handleRequest', file: 'src/handleRequest.ts', startLine: 1, endLine: 2, reach: 4, reason: { kind: 'no-callers' } },
      ],
      totalQualifying: 2,
      // P4-7h: handleRequest reaches serviceB; the two share repository and cacheLookup.
      relations: [{ a: 'handleRequest', b: 'serviceB', sharedReach: 2 }],
    });
  });

  it('pins come in pin order, never sorted by id or reach', () => {
    // reach: utilB.helper 0, serviceB 2, cacheLookup 1 — pin order wins.
    assert.deepEqual(candidateIds(pinsOf(['utilB.helper', 'serviceB', 'cacheLookup'])), [
      'utilB.helper',
      'serviceB',
      'cacheLookup',
      'handleRequest',
    ]);
    assert.deepEqual(candidateIds(pinsOf(['cacheLookup', 'serviceB'])), ['cacheLookup', 'serviceB', 'handleRequest']);
  });

  it('a pinned heuristic candidate is listed once, as pinned', () => {
    const result = pinsOf(['handleRequest']);
    assert.ok(result.status === 'found');
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.reason.kind]),
      [['handleRequest', 'pinned']],
    );
    assert.equal(result.totalQualifying, 1);
  });

  it('a repeated pin counts once, at its first place', () => {
    assert.deepEqual(candidateIds(pinsOf(['serviceB', 'serviceA', 'serviceB'])), ['serviceB', 'serviceA', 'handleRequest']);
  });

  it('a pin is kept below the reach bar and with callers', () => {
    // utilA.helper reaches 0 and repository has callers: both listed.
    const result = pinsOf(['utilA.helper', 'repository']);
    assert.ok(result.status === 'found');
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.reach]),
      [
        ['utilA.helper', 0],
        ['repository', 1],
        ['handleRequest', 4],
      ],
    );
  });

  it('heuristic candidates still cap at ENTRY_CANDIDATE_MAX after the pins, skipping the pinned ones', () => {
    const roots = merge(...Array.from({ length: 20 }, (_, index) => chain(`r${String(index).padStart(2, '0')}`, 3 + index)));
    // r19 (reach 22) is the top heuristic candidate; pinned, it isn't repeated below.
    const result = listEntryCandidates(roots.nodes, roots.edges, { pinnedIds: ['r19', 'r00.1'] });
    assert.ok(result.status === 'found');
    const ids = result.candidates.map((candidate) => candidate.id);
    assert.deepEqual(ids.slice(0, 2), ['r19', 'r00.1']);
    assert.equal(ids.length, 2 + ENTRY_CANDIDATE_MAX);
    assert.deepEqual(ids.slice(2), Array.from({ length: ENTRY_CANDIDATE_MAX }, (_, i) => `r${String(18 - i).padStart(2, '0')}`));
    assert.equal(ids.filter((id) => id === 'r19').length, 1);
    // 2 pinned + 19 other qualifying roots.
    assert.equal(result.totalQualifying, 21);
  });

  it('pins alone make the result found (a cyclic graph)', () => {
    const cyclic = { nodes: nodes('a', 'b', 'c'), edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')] };
    assert.deepEqual(listEntryCandidates(cyclic.nodes, cyclic.edges), { status: 'none' });
    const result = listEntryCandidates(cyclic.nodes, cyclic.edges, { pinnedIds: ['b'] });
    assert.deepEqual(result, {
      status: 'found',
      candidates: [{ id: 'b', name: 'b', file: 'src/b.ts', startLine: 1, endLine: 2, reach: 2, reason: { kind: 'pinned' } }],
      totalQualifying: 1,
      relations: [],
    });
    // Everything under the reach bar, too.
    const small = { nodes: nodes('x', 'y'), edges: [edge('x', 'y')] };
    assert.deepEqual(candidateIds(listEntryCandidates(small.nodes, small.edges, { pinnedIds: ['y'] })), ['y']);
  });

  it('a pin not among the Nodes is hidden, never a candidate; listed in hiddenPinIds in pin order', () => {
    const result = pinsOf(['gone2', 'serviceB', 'gone1', 'gone2']);
    assert.ok(result.status === 'found');
    assert.deepEqual(candidateIds(result), ['serviceB', 'handleRequest']);
    assert.deepEqual(result.hiddenPinIds, ['gone2', 'gone1']);
    const cyclic = { nodes: nodes('a', 'b'), edges: [edge('a', 'b'), edge('b', 'a')] };
    assert.deepEqual(listEntryCandidates(cyclic.nodes, cyclic.edges, { pinnedIds: ['ghost'] }), {
      status: 'none',
      hiddenPinIds: ['ghost'],
    });
    assert.deepEqual(listEntryCandidates([], [], { pinnedIds: ['ghost'] }), { status: 'none', hiddenPinIds: ['ghost'] });
  });

  it('no pins (absent or empty) is byte-identical to the unpinned result', () => {
    const plain = listEntryCandidates(PATH_TRACE_BASIC.nodes, PATH_TRACE_BASIC.edges);
    assert.equal(JSON.stringify(pinsOf([])), JSON.stringify(plain));
    assert.equal(JSON.stringify(listEntryCandidates(PATH_TRACE_BASIC.nodes, PATH_TRACE_BASIC.edges, {})), JSON.stringify(plain));
  });

  it('the pin order, not the input order, decides; shuffled Nodes and edges give the same result', () => {
    const expected = pinsOf(['cacheLookup', 'serviceA']);
    for (let seed = 1; seed <= 5; seed += 1) {
      assert.deepEqual(
        listEntryCandidates(shuffled(PATH_TRACE_BASIC.nodes, seed), shuffled(PATH_TRACE_BASIC.edges, seed + 7), {
          pinnedIds: ['cacheLookup', 'serviceA'],
        }),
        expected,
      );
    }
  });

  it('ENTRY_PINS_MAX is 50', () => {
    assert.equal(ENTRY_PINS_MAX, 50);
  });
});

describe('listEntryCandidates relations: shared reach between candidates (P4-7h)', () => {
  const relationsOf = (result: EntryCandidatesResult) => {
    assert.ok(result.status === 'found');
    return result.status === 'found' ? result.relations : [];
  };

  it('two candidates reaching {r, c} and {r, x}: one relation, sharedReach 1 (the intersection, not the union)', () => {
    const graph = { nodes: nodes('A', 'B', 'r', 'c', 'x'), edges: [edge('A', 'r'), edge('A', 'c'), edge('B', 'r'), edge('B', 'x')] };
    assert.deepEqual(relationsOf(listEntryCandidates(graph.nodes, graph.edges, { pinnedIds: ['A', 'B'] })), [
      { a: 'A', b: 'B', sharedReach: 1 },
    ]);
  });

  it('disjoint reach: no relation for that pair — never a sharedReach 0 entry', () => {
    const graph = merge(chain('p', 3), chain('q', 4));
    const result = listEntryCandidates(graph.nodes, graph.edges);
    assert.deepEqual(candidateIds(result), ['q', 'p']);
    assert.deepEqual(relationsOf(result), []);
  });

  it('one candidate reaches the other: neither end is counted, only the other common Nodes', () => {
    // A -> m -> B -> {s1, s2}, and A -> s3. B is pinned: reach(A) = {m, B, s1,
    // s2, s3}, reach(B) = {s1, s2} — B itself is not in the intersection.
    const graph = {
      nodes: nodes('A', 'm', 'B', 's1', 's2', 's3'),
      edges: [edge('A', 'm'), edge('m', 'B'), edge('B', 's1'), edge('B', 's2'), edge('A', 's3')],
    };
    const result = listEntryCandidates(graph.nodes, graph.edges, { pinnedIds: ['B'] });
    assert.deepEqual(candidateIds(result), ['B', 'A']);
    assert.deepEqual(relationsOf(result), [{ a: 'A', b: 'B', sharedReach: 2 }]);
  });

  it('two candidates reaching each other (a cycle): a candidate is never in its own reach, so neither counts', () => {
    // a <-> b, both -> c and d: reach(a) = {b, c, d}, reach(b) = {a, c, d}.
    const graph = {
      nodes: nodes('a', 'b', 'c', 'd'),
      edges: [edge('a', 'b'), edge('b', 'a'), edge('a', 'c'), edge('b', 'c'), edge('a', 'd'), edge('b', 'd')],
    };
    assert.deepEqual(relationsOf(listEntryCandidates(graph.nodes, graph.edges, { pinnedIds: ['b', 'a'] })), [
      { a: 'a', b: 'b', sharedReach: 2 },
    ]);
  });

  it('only one candidate: relations []', () => {
    assert.deepEqual(relationsOf(listEntryCandidates(PATH_TRACE_BASIC.nodes, PATH_TRACE_BASIC.edges)), []);
  });

  it('one relation per unordered pair, a < b by id whatever the listing order, sorted by count then a then b', () => {
    // Pins in reverse id order. z, y, x and w all reach s1; z and y also s2, s3.
    const graph = {
      nodes: nodes('z', 'y', 'x', 'w', 's1', 's2', 's3', 'lone'),
      edges: [
        edge('z', 's1'),
        edge('z', 's2'),
        edge('z', 's3'),
        edge('y', 's1'),
        edge('y', 's2'),
        edge('y', 's3'),
        edge('x', 's1'),
        edge('w', 's1'),
      ],
    };
    const result = listEntryCandidates(graph.nodes, graph.edges, { pinnedIds: ['z', 'y', 'x', 'w', 'lone'] });
    assert.deepEqual(relationsOf(result), [
      { a: 'y', b: 'z', sharedReach: 3 },
      { a: 'w', b: 'x', sharedReach: 1 },
      { a: 'w', b: 'y', sharedReach: 1 },
      { a: 'w', b: 'z', sharedReach: 1 },
      { a: 'x', b: 'y', sharedReach: 1 },
      { a: 'x', b: 'z', sharedReach: 1 },
    ]);
  });

  it('shuffled Nodes and edges give identical relations', () => {
    let withRelations = 0;
    for (let graphSeed = 1; graphSeed <= 10; graphSeed += 1) {
      const graph = merge(randomGraph(graphSeed, 70, 160), PATH_TRACE_BASIC);
      const pinnedIds = ['n3', 'n5', 'serviceB'];
      const expected = listEntryCandidates(graph.nodes, graph.edges, { pinnedIds });
      assert.ok(expected.status === 'found');
      withRelations += expected.relations.length > 0 ? 1 : 0;
      for (let seed = 1; seed <= 3; seed += 1) {
        const result = listEntryCandidates(shuffled(graph.nodes, seed), shuffled(graph.edges, seed + 3), { pinnedIds });
        assert.ok(result.status === 'found');
        assert.deepEqual(result.relations, expected.relations);
      }
    }
    assert.equal(withRelations, 10);
  });

  it('pins and the 12 capped candidates are all related, matching the independent reference on random graphs', () => {
    let withRelations = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const graph = randomGraph(seed, 70, 160);
      const pinnedIds = [`n${seed % 70}`, `n${(seed * 7) % 70}`, 'ghost'];
      const result = listEntryCandidates(graph.nodes, graph.edges, { pinnedIds });
      if (result.status !== 'found') {
        continue;
      }
      assert.deepEqual(
        result.relations,
        referenceRelations(
          referenceForward(graph.nodes, graph.edges),
          result.candidates.map((candidate) => candidate.id),
        ),
        `seed ${seed}`,
      );
      withRelations += result.relations.length > 0 ? 1 : 0;
    }
    assert.ok(withRelations >= 30, `${withRelations} graphs had relations`);
  });

  it('relations reuse the ranking walks: the exact walks are the same with or without relations to compute', () => {
    // 14 roots all sharing one tail: 12 listed, 66 relations, and only the
    // ranking's own walks (no second walk per candidate).
    const tail = chain('tail', 5);
    const graph = merge(tail, {
      nodes: nodes(...Array.from({ length: 14 }, (_, index) => `root${String(index).padStart(2, '0')}`)),
      edges: Array.from({ length: 14 }, (_, index) => edge(`root${String(index).padStart(2, '0')}`, 'tail')),
    });
    const { result, exactReachWalks } = listEntryCandidatesWithWork(graph.nodes, graph.edges);
    assert.ok(result.status === 'found');
    assert.equal(result.candidates.length, ENTRY_CANDIDATE_MAX);
    assert.equal(exactReachWalks.length, ENTRY_CANDIDATE_MAX);
    assert.equal(result.relations.length, (ENTRY_CANDIDATE_MAX * (ENTRY_CANDIDATE_MAX - 1)) / 2);
    assert.ok(result.relations.every((relation) => relation.sharedReach === 6));
  });

  it('bit 31 of a word (the sign bit) and the first bits of the next words count like any other', () => {
    // Unshuffled, so each Node's index is its place: p 0, q 1, leafK K + 2.
    const leaves = Array.from({ length: 70 }, (_, index) => `leaf${String(index).padStart(2, '0')}`);
    const at = (index: number) => leaves[index - 2]!;
    const graph = {
      nodes: nodes('p', 'q', ...leaves),
      edges: [
        // Shared: indices 31 (bit 31 of word 0), 63 (bit 31 of word 1) and 64 (bit 0 of word 2).
        ...[31, 63, 64, 2].map((index) => edge('p', at(index))),
        ...[31, 63, 64, 3].map((index) => edge('q', at(index))),
      ],
    };
    assert.deepEqual(relationsOf(listEntryCandidates(graph.nodes, graph.edges)), [{ a: 'p', b: 'q', sharedReach: 3 }]);
    // Only bit 31 shared.
    const signOnly = { nodes: graph.nodes, edges: [...[31, 2, 4].map((i) => edge('p', at(i))), ...[31, 3, 5].map((i) => edge('q', at(i)))] };
    assert.deepEqual(relationsOf(listEntryCandidates(signOnly.nodes, signOnly.edges)), [{ a: 'p', b: 'q', sharedReach: 1 }]);
  });

  it('a Node count past one bitset word, and Nodes at word boundaries, are counted exactly', () => {
    // 100 leaves; p reaches leaves 0–63, q reaches 31–99: 33 shared (31..63).
    const leaves = Array.from({ length: 100 }, (_, index) => `leaf${String(index).padStart(3, '0')}`);
    const graph = {
      nodes: nodes('p', 'q', ...leaves),
      edges: [
        ...leaves.slice(0, 64).map((leaf) => edge('p', leaf)),
        ...leaves.slice(31).map((leaf) => edge('q', leaf)),
      ],
    };
    assert.deepEqual(relationsOf(listEntryCandidates(shuffled(graph.nodes, 4), graph.edges)), [
      { a: 'p', b: 'q', sharedReach: 33 },
    ]);
  });
});
