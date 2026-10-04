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
  return {
    status: 'found',
    candidates: qualifying.slice(0, 12).map(({ graphNode, reach }) => {
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
  };
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
