/**
 * P4-7b review round 1: the `listEntryCandidates` benchmark (AD-14's
 * ~150 ms budget). Not part of `npm test` — timings are machine-dependent.
 * Run from `app/`:
 *
 *   node --import ./scripts/register-ts-test-loader.mjs packages/graph-contracts/bench/entryCandidates.bench.ts
 *
 * Seeded 50k-Node graphs shaped like the dev fixture (`devFixture.ts`): each
 * Node after the first gets `fanout` edges to random earlier Nodes. Three
 * shapes: the dev fixture's CALLS/IMPORTS/USAGE mix at fan-out 3 (a third
 * of the edges don't count), and all-caller-edge (CALLS + USAGE) graphs at
 * fan-out 3 and 4 — the realistic worst case.
 */
import { listEntryCandidatesWithWork, type PathTraceEdge } from '../src/index';

const NODE_COUNT = 50_000;
const RUNS = 5;
const SEED = 0xc0de_1a3;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(fanout: number, kinds: readonly PathTraceEdge['kind'][]) {
  const random = mulberry32(SEED);
  const nodes = Array.from({ length: NODE_COUNT }, (_, index) => ({
    id: `bench://node-${index}`,
    name: `node${index}`,
    file: `bench/module-${Math.floor(index / 50)}.ts`,
    startLine: 1,
    endLine: 5,
  }));
  const edges: PathTraceEdge[] = [];
  for (let index = 1; index < NODE_COUNT; index += 1) {
    for (let fan = 0; fan < fanout; fan += 1) {
      const target = Math.floor(random() * index);
      const kind = kinds[Math.floor(random() * kinds.length)]!;
      edges.push({ source: nodes[index]!.id, target: nodes[target]!.id, kind });
    }
  }
  return { nodes, edges };
}

// P4-7h: `pins` pins that many Nodes (spread over the graph) — with 50, the
// most candidates `relations` can pair (50 + 12).
const SHAPES = [
  { label: 'dev-fixture mix (CALLS/IMPORTS/USAGE), fan-out 3', fanout: 3, kinds: ['CALLS', 'IMPORTS', 'USAGE'] as const, pins: 0 },
  { label: 'CALLS+USAGE only, fan-out 3', fanout: 3, kinds: ['CALLS', 'USAGE'] as const, pins: 0 },
  { label: 'CALLS+USAGE only, fan-out 4', fanout: 4, kinds: ['CALLS', 'USAGE'] as const, pins: 0 },
  { label: 'CALLS+USAGE only, fan-out 4, 50 pins', fanout: 4, kinds: ['CALLS', 'USAGE'] as const, pins: 50 },
];

for (const shape of SHAPES) {
  const { nodes, edges } = generate(shape.fanout, shape.kinds);
  const pinnedIds = Array.from({ length: shape.pins }, (_, index) => nodes[NODE_COUNT - 1 - index * 997]!.id);
  const timings: number[] = [];
  let summary = '';
  for (let run = 0; run < RUNS; run += 1) {
    const start = performance.now();
    const { result, exactReachWalks, roots } = listEntryCandidatesWithWork(nodes, edges, { pinnedIds });
    timings.push(performance.now() - start);
    summary =
      result.status === 'found'
        ? `roots ${roots}, qualifying ${result.totalQualifying}, top reach ${result.candidates[0]!.reach}, exact walks ${exactReachWalks.length}` +
          // P4-7h: absent on code before relations (a baseline run).
          ('relations' in result ? `, relations ${(result as { relations: unknown[] }).relations.length}` : '')
        : result.status;
  }
  const sorted = [...timings].sort((a, b) => a - b);
  console.log(
    `${shape.label}: ${edges.length} edges; ${summary}; ms min ${sorted[0]!.toFixed(0)} median ${sorted[Math.floor(RUNS / 2)]!.toFixed(0)} max ${sorted[RUNS - 1]!.toFixed(0)}`,
  );
}
