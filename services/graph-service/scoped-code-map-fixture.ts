/**
 * P4-4 phase 1a: one representative raw backend Code Map, shared by the
 * pre-refactor golden capture (`scoped-code-map.golden.test.ts`, through the
 * real `index.ts` handler) and the pure `buildScopedCodeMap` test
 * (`scoped-code-map.test.ts`). Test data only; nothing in the app imports it.
 *
 * It exercises every step of the scoped-map pipeline:
 *  - sections that share a name prefix (`web` / `webapp`) and nest
 *    (`apps` / `apps/web`), with edges crossing between them;
 *  - test code (by path, and by the backend flag) with test-link evidence;
 *  - folded Modules and folded Type/Interface Nodes, with `IMPLEMENTS` links;
 *  - `SIMILAR_TO` pairs (cross-section, same-file, below threshold, test end);
 *  - raw complexity / cognitive / hotspot numbers on enough Nodes for the
 *    project-relative severity cuts to rate some of them, and LCOV coverage;
 *  - a coverage-gap file.
 */
import type { CodeMapEdge } from '@driller/graph-contracts';

import type { CodeMapFetchResult, CodeMapNodeWithSignalSources } from './mcp-client';
import type { NodeRecord } from './node-record-store';

const fn = (
  id: string,
  file: string,
  startLine: number,
  endLine: number,
  extra: Partial<CodeMapNodeWithSignalSources> = {},
): CodeMapNodeWithSignalSources => ({
  id,
  name: id,
  file,
  startLine,
  endLine,
  kind: 'Function',
  summaryStatus: 'pending',
  riskSignals: [],
  ...extra,
});

const SECTION_FILES = ['web/gen.ts', 'webapp/gen.ts', 'api/gen.ts', 'apps/gen.ts', 'apps/web/gen.ts', 'docs/gen.ts'];

/** 24 generated Nodes, 4 per section, with varied raw signal numbers. */
const generated = Array.from({ length: 24 }, (_, i) =>
  fn(`g${i}`, SECTION_FILES[i % SECTION_FILES.length]!, 1 + Math.floor(i / SECTION_FILES.length) * 5, 4 + Math.floor(i / SECTION_FILES.length) * 5, {
    complexity: ((i * 7) % 23) + 1,
    cognitiveComplexity: (i * 5) % 17,
    ...(i % 3 === 0 ? {} : { hotspotChangeCount: (i * 3) % 11 }),
  }),
);

const NAMED: CodeMapNodeWithSignalSources[] = [
  fn('w1', 'web/a.ts', 1, 5, { complexity: 31, cognitiveComplexity: 40, hotspotChangeCount: 25 }),
  fn('w2', 'web/a.ts', 6, 9, { complexity: 2 }),
  fn('w3', 'web/b.ts', 1, 4, { cognitiveComplexity: 3, hotspotChangeCount: 1 }),
  fn('x1', 'webapp/d.ts', 1, 4, { complexity: 18, hotspotChangeCount: 30 }),
  fn('s1', 'api/server.ts', 1, 4, { complexity: 25, cognitiveComplexity: 22 }),
  fn('s2', 'api/server.ts', 5, 10, { complexity: 4, hotspotChangeCount: 12 }),
  fn('s3', 'api/db.ts', 1, 6, { cognitiveComplexity: 28 }),
  fn('p1', 'apps/b.ts', 1, 4, { complexity: 9, hotspotChangeCount: 4 }),
  fn('aw1', 'apps/web/a.ts', 1, 5, { complexity: 15, cognitiveComplexity: 11, hotspotChangeCount: 19 }),
  fn('aw2', 'apps/web/a.ts', 6, 9),
  fn('d1', 'docs/c.ts', 1, 4, { complexity: 6 }),
  fn('u1', 'lib/util.ts', 1, 4, { hotspotChangeCount: 2 }),
  // Test code: by path (`t1`, `t2`) and by the backend flag alone (`f1`).
  fn('t1', 'web/a.test.ts', 1, 4),
  fn('t2', 'api/server.test.ts', 1, 4),
  fn('f1', 'apps/support.ts', 1, 4, { isTest: true }),
  // Module Nodes (a file's top-level code), folded off the map.
  fn('mod:web/a', 'web/a.ts', 1, 12, { kind: 'Module' }),
  fn('mod:lib/boot', 'lib/boot.ts', 1, 3, { kind: 'Module' }),
  fn('mod:apps/web/a', 'apps/web/a.ts', 1, 12, { kind: 'Module' }),
  fn('mod:api/types', 'api/types.ts', 1, 20, { kind: 'Module' }),
  // Type/Interface Nodes, folded off the map.
  fn('T', 'web/types.ts', 3, 9, { kind: 'Interface' }),
  fn('T2', 'web/types.ts', 10, 14, { kind: 'Interface' }),
  fn('U', 'docs/types.ts', 1, 3, { kind: 'Type' }),
  fn('A', 'api/types.ts', 2, 8, { kind: 'Interface' }),
  fn('AW', 'apps/web/types.ts', 1, 3, { kind: 'Type' }),
  fn('Unused', 'apps/types.ts', 1, 3, { kind: 'Type' }),
];

const calls = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });
const usage = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'USAGE' });

const EDGES: CodeMapEdge[] = [
  calls('w1', 'w3'),
  calls('w1', 's1'),
  calls('s1', 's2'),
  calls('s2', 's3'),
  calls('s3', 'u1'),
  calls('aw1', 'p1'),
  calls('p1', 'aw2'),
  calls('aw2', 'w1'),
  calls('d1', 'w1'),
  calls('x1', 'w1'),
  calls('u1', 'd1'),
  calls('w2', 'aw1'),
  // Test code: dropped with its Nodes.
  calls('w1', 't1'),
  calls('t1', 'f1'),
  calls('f1', 'p1'),
  // Generated: a chain, plus a hop into a named Node every fourth Node.
  ...generated.slice(1).map((node, i) => calls(generated[i]!.id, node.id)),
  ...generated.filter((_, i) => i % 4 === 0).map((node, i) => calls(node.id, ['w1', 's2', 'aw1', 'p1', 'x1', 'd1'][i % 6]!)),
  // Type uses (a CALLS into a type, a Module's use and a test's use never count as Node uses).
  usage('w1', 'T'),
  usage('s1', 'A'),
  usage('s2', 'T'),
  usage('aw1', 'AW'),
  usage('d1', 'U'),
  usage('w3', 'U'),
  usage('g2', 'A'),
  calls('x1', 'T'),
  usage('t1', 'T'),
  usage('T2', 'U'),
  // Module top-level uses.
  calls('mod:web/a', 'w3'),
  usage('mod:web/a', 's1'),
  usage('mod:web/a', 'T'),
  calls('mod:lib/boot', 'u1'),
  calls('mod:apps/web/a', 'p1'),
  usage('mod:apps/web/a', 'AW'),
  calls('mod:api/types', 's3'),
  // Dangling edges (an endpoint that is no map Node — the backend can return
  // these): an unrestricted map passes them through untouched; any scope
  // filter drops them.
  calls('w1', 'ghost'),
  calls('ghost2', 's1'),
];

/** The raw `fetchCodeMap` result: what the backend query returns, before any production-map step. */
export const SCOPED_MAP_FIXTURE: CodeMapFetchResult = {
  nodes: [...NAMED, ...generated],
  edges: EDGES,
  implementsLinks: [
    { source: 'T2', target: 'T' },
    { source: 'A', target: 'T' },
  ],
  similarPairs: [
    { source: 'w1', target: 's1', score: 1 },
    { source: 'aw1', target: 'w1', score: 0.95 },
    { source: 's2', target: 's3', score: 0.97 },
    { source: 'p1', target: 'aw2', score: 0.92 },
    { source: 'w2', target: 'w1', score: 1, sameFile: true },
    { source: 'x1', target: 'w1', score: 0.85 },
    { source: 'w1', target: 't1', score: 1 },
  ],
  testEvidence: {
    calls: [
      { source: 't1', sourceName: 't1', sourceFile: 'web/a.test.ts', sourceStartLine: 1, sourceEndLine: 4, sourceKind: 'Function', target: 'w1', strategy: 'import_map', confidence: 0.95 },
      { source: 't2', sourceName: 't2', sourceFile: 'api/server.test.ts', sourceStartLine: 1, sourceEndLine: 4, sourceKind: 'Function', target: 's1', strategy: 'import_map', confidence: 0.95 },
      { source: 'f1', sourceName: 'f1', sourceFile: 'apps/support.ts', sourceStartLine: 1, sourceEndLine: 4, sourceKind: 'Function', sourceIsTest: true, target: 'p1', strategy: 'unique_name', confidence: 0.75 },
    ],
    testFiles: [{ testFile: 'api/server.test.ts', file: 'api/server.ts' }],
  },
};

/**
 * Node record-store states the map reads: summarized (`s1`), summarized and
 * stale (`s2`), summarized but blocked by a coverage gap (`d1`, in
 * `docs/c.ts`), and record-backed signals (`w1`: an LLM judgment and an
 * ingested finding). No staleness baseline, so detection never rewrites them.
 */
export const FIXTURE_RECORDS: Readonly<Record<string, NodeRecord>> = {
  s1: { summary: { text: 'Starts the API server.', model: 'fixture-model', generatedAt: '2026-09-01T00:00:00.000Z' } },
  s2: { summary: { text: 'Routes requests.', model: 'fixture-model', generatedAt: '2026-09-01T00:00:00.000Z' }, stale: true },
  d1: { summary: { text: 'Never shown: its file has a coverage gap.', model: 'fixture-model', generatedAt: '2026-09-01T00:00:00.000Z' } },
  w1: {
    llmJudgment: { text: 'Does too much in one place.', model: 'fixture-model', generatedAt: '2026-09-01T00:00:00.000Z' },
    ingestedFindings: [
      {
        family: 'ingested',
        severity: 'major',
        sourceTool: 'CodeRabbit',
        finding: 'Unchecked error path.',
        location: { file: 'web/a.ts', startLine: 2, endLine: 3 },
      },
    ],
  },
};

/** The coverage-gap files `indexRepository` reports (made project-relative by `index.ts`). */
export const FIXTURE_GAP_PATHS = ['docs/c.ts'];

/** Source files that must exist (older than the LCOV report) for function-level hits to count. */
export const FIXTURE_SOURCE_FILES = ['web/a.ts', 'web/b.ts', 'api/server.ts', 'apps/web/a.ts', 'webapp/d.ts', 'web/gen.ts'];

/** `coverage/lcov.info`: hits, misses, a file listed with lines only, and one never listed. */
export const FIXTURE_LCOV = [
  'TN:',
  'SF:web/a.ts', 'FN:1,w1', 'FNDA:3,w1', 'FN:6,w2', 'FNDA:0,w2', 'DA:1,3', 'DA:6,0', 'end_of_record',
  'SF:web/b.ts', 'FN:1,w3', 'FNDA:0,w3', 'DA:1,0', 'end_of_record',
  'SF:api/server.ts', 'FN:1,s1', 'FNDA:2,s1', 'FN:5,s2', 'FNDA:0,s2', 'DA:1,2', 'DA:5,0', 'end_of_record',
  'SF:apps/web/a.ts', 'DA:1,1', 'DA:6,0', 'end_of_record',
  'SF:webapp/d.ts', 'FN:1,x1', 'FNDA:0,x1', 'DA:1,1', 'end_of_record',
  'SF:web/gen.ts', 'FN:1,g0', 'FNDA:1,g0', 'DA:1,1', 'DA:6,0', 'end_of_record',
  '',
].join('\n');

/** The indexing scopes the golden covers: none, prefix-sharing, multi, nested, a typo, everything. */
export const FIXTURE_SCOPES: readonly (readonly string[])[] = [
  [],
  ['web'],
  ['web', 'api'],
  ['apps', 'apps/web'],
  ['apps/web'],
  ['wbe'],
  ['web', 'webapp', 'api', 'apps', 'docs', 'lib'],
];

/** Path Trace queries the golden records per scope. */
export const FIXTURE_TRACE_QUERIES = ['w1', 'aw1', 'g0', 'Unused', 'nope'];

const UNDEFINED_SENTINEL = '\u0000undefined';

/** JSON with every own `undefined` property kept as a sentinel, so "set to undefined" ≠ "absent". */
export function goldenStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_SENTINEL : v), 2);
}
