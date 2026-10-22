/**
 * P5-b: the section-switch benchmark (founder decision 2.1; AD-14). Not part
 * of `npm test` — timings are machine-dependent. Run from `app/`:
 *
 *   node --import ./scripts/register-ts-test-loader.mjs services/graph-service/section-switch.bench.ts
 *
 * Drives the real `index.ts` through `scoped-code-map-harness.ts` over a
 * seeded synthetic raw map (three sections `apps`, `services`, `packages`,
 * like driller/app's allowlist) and times a `getCodeMap(section)` round trip
 * inside the Graph Service, from the request message to the posted reply:
 *  - "fetch": the first request after `indexed` (the fetch path, with the
 *    harness's in-memory CBM stub, so no backend latency is included — only
 *    the stub's `structuredClone`, the production-map steps, the LCOV load
 *    and the two pipeline builds);
 *  - "switch": a section switch served from the raw cache (P5-b).
 * The live figure on driller/app (with real CBM, IPC and render) is owed in
 * the tracker's P5-b row.
 */
import { performance } from 'node:perf_hooks';

import type { CodeMapEdge } from '@driller/graph-contracts';

import type { CodeMapFetchResult, CodeMapNodeWithSignalSources } from './mcp-client';
import { index, makeFixtureProject, posted, removeHarnessTempDirs, send, startIndexTs, waitFor } from './scoped-code-map-harness';

const SECTIONS = ['apps', 'services', 'packages'] as const;
const SIZES = [2_000, 10_000, 30_000];
const FANOUT = 3;
const SWITCHES = 10;
const SEED = 0x5eed_b5;

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

/** `count` Functions spread over the three sections (20 per file), each calling `FANOUT` random earlier ones. */
function synthetic(count: number): CodeMapFetchResult {
  const random = mulberry32(SEED);
  const nodes: CodeMapNodeWithSignalSources[] = Array.from({ length: count }, (_, i) => {
    const section = SECTIONS[i % SECTIONS.length]!;
    const file = `${section}/module-${Math.floor(i / 60)}/file-${Math.floor(i / 20) % 3}.ts`;
    const line = (i % 20) * 10 + 1;
    return {
      id: `bench-${i}`,
      name: `fn${i}`,
      file,
      startLine: line,
      endLine: line + 8,
      kind: 'Function',
      summaryStatus: 'pending',
      riskSignals: [],
      complexity: 1 + Math.floor(random() * 30),
      cognitiveComplexity: Math.floor(random() * 40),
      ...(random() < 0.5 ? { hotspotChangeCount: Math.floor(random() * 20) } : {}),
    };
  });
  const edges: CodeMapEdge[] = [];
  for (let i = 1; i < count; i += 1) {
    for (let fan = 0; fan < FANOUT; fan += 1) {
      edges.push({ source: nodes[i]!.id, target: nodes[Math.floor(random() * i)]!.id, kind: 'CALLS' });
    }
  }
  return { nodes, edges, implementsLinks: [], similarPairs: [], testEvidence: { calls: [], testFiles: [] } };
}

/** Sends `getCodeMap(section)` and resolves with the ms until its reply is posted. */
async function timeRequest(section: string | undefined): Promise<number> {
  const from = posted.length;
  const start = performance.now();
  send({ type: 'graphService:getCodeMap', ...(section === undefined ? {} : { section }) });
  const reply = await waitFor(
    () => posted.slice(from).find((message) => typeof message.type === 'string' && message.type.startsWith('graphService:codeMap')),
    'a Code Map reply',
  );
  const elapsed = performance.now() - start;
  if (reply.type !== 'graphService:codeMap') {
    throw new Error(`unexpected reply: ${String(reply.type)} ${String(reply.message ?? '')}`);
  }
  return elapsed;
}

const stats = (timings: number[]): string => {
  const sorted = [...timings].sort((a, b) => a - b);
  return `min ${sorted[0]!.toFixed(0)} median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} max ${sorted[sorted.length - 1]!.toFixed(0)}`;
};

const harness = globalThis as { __harnessFixtureOverride?: unknown; __harnessFetchCount?: number; __harnessLcovCount?: number };
const project = makeFixtureProject();
try {
  await startIndexTs(project);
  for (const size of SIZES) {
    harness.__harnessFixtureOverride = synthetic(size);
    const fetchTimes: number[] = [];
    const switchTimes: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      await index(project);
      send({ type: 'graphService:scopeChanged', path: project, includedPaths: [...SECTIONS] });
      fetchTimes.push(await timeRequest('apps'));
      const io = [harness.__harnessFetchCount, harness.__harnessLcovCount];
      // apps → services → all → packages → apps … (the live pass's pattern).
      const order = ['services', undefined, 'packages', 'apps'];
      for (let i = 0; i < SWITCHES; i += 1) {
        switchTimes.push(await timeRequest(order[i % order.length]));
      }
      if (harness.__harnessFetchCount !== io[0] || harness.__harnessLcovCount !== io[1]) {
        throw new Error('a switch fetched or loaded LCOV');
      }
    }
    console.log(
      `${size} Nodes, ${size * FANOUT} edges, sections ${SECTIONS.join('/')}: ` +
        `fetch path ms ${stats(fetchTimes)}; cache-served switch ms ${stats(switchTimes)} (${switchTimes.length} switches)`,
    );
  }
} finally {
  harness.__harnessFixtureOverride = undefined;
  await removeHarnessTempDirs();
}
// `index.ts` keeps its port listener (and model download) alive.
process.exit(0);
