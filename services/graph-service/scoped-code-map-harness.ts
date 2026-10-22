/**
 * P4-4 phase 1a: test-only harness that drives the real `index.ts` over
 * `scoped-code-map-fixture.ts`, shared by `scoped-code-map.golden.test.ts`
 * and `scoped-code-map.cache.test.ts`. Nothing in the app imports it.
 *
 * Same approach as `scope-changed.test.ts`: `index.ts` has load-time side
 * effects, so it is loaded once, after a stub `process.parentPort`, a temp
 * userData dir and module hooks that swap only CBM (`./mcp-client`), the
 * model download (`./model-manager`) and the MCP port bind (`./mcp-server`)
 * for in-memory stubs. Everything else (the pipeline, the handlers, the
 * caches, the Node record store) is real.
 *
 * It depends only on what the baseline `index.ts` already had, so the golden
 * can be (re-)captured on a baseline export.
 *
 * Test hooks on `globalThis`:
 *  - `__harnessIndexGate`: a promise `indexRepository` awaits first;
 *  - `__harnessFetchGate`: a promise `fetchCodeMap` awaits first
 *    (`__harnessFetchCount` counts calls);
 *  - `__harnessModel`: a factory for `ensureLocalModel`'s promise (never
 *    settles when unset); `__harnessModelCount` (P5-c) counts
 *    `ensureLocalModel` calls;
 *  - `__harnessFixtureOverride` (P4-4g review round 1): a raw fetch result
 *    `fetchCodeMap` returns instead of the fixture while set;
 *  - `__harnessLcovCount` (P5-b): counts `index.ts`'s `loadLcovCoverage`
 *    calls. `./lcov` is wrapped, not replaced: the real loader still runs;
 *  - `__harnessSummarize` / `__harnessJudge` (P5-b founder decision 1): when
 *    set, the per-Node function `index.ts`'s `createLocalSummarizer` /
 *    `createLocalJudge` return (the local model must be ready, via
 *    `__harnessModel`). `./summary-generator` and `./judgment-generator` are
 *    wrapped the same way; everything else in them is the real code;
 *  - `__harnessCloudSummarize` / `__harnessCloudJudge` (P5-c): the same for
 *    `createCloudSummarizer` / `createCloudJudge` (`./cloud-summary-generator`
 *    is wrapped too), so a Cloud-with-key test never calls the Anthropic API.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { FIXTURE_GAP_PATHS, FIXTURE_LCOV, FIXTURE_SOURCE_FILES, SCOPED_MAP_FIXTURE } from './scoped-code-map-fixture';

const toDataUrl = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;

const MCP_CLIENT_STUB = toDataUrl(`
const FIXTURE = ${JSON.stringify(SCOPED_MAP_FIXTURE)};
const GAPS = ${JSON.stringify(FIXTURE_GAP_PATHS)};
export function stopCbmDaemon() {}
export async function indexRepository() {
  const gate = globalThis.__harnessIndexGate;
  if (gate) await gate;
  return {
    nodes: FIXTURE.nodes.length,
    edges: FIXTURE.edges.length,
    project: 'stub-project',
    coverage: { skippedCount: 0, parsePartialCount: GAPS.length, gapPaths: GAPS.map((path) => ({ path, reason: 'parse-partial' })) },
  };
}
export async function fetchCodeMap() {
  globalThis.__harnessFetchCount = (globalThis.__harnessFetchCount ?? 0) + 1;
  const gate = globalThis.__harnessFetchGate;
  if (gate) await gate;
  return structuredClone(globalThis.__harnessFixtureOverride ?? FIXTURE);
}
`);
const MODEL_MANAGER_STUB = toDataUrl(
  'export function ensureLocalModel() { globalThis.__harnessModelCount = (globalThis.__harnessModelCount ?? 0) + 1; const make = globalThis.__harnessModel; return make ? make() : new Promise(() => {}); }',
);
const MCP_SERVER_STUB = toDataUrl(
  // P4-4 phase 2b: also keeps the live derivation and the section-build
  // getter (`undefined` on a baseline that has none).
  'export function startMcpServer(getNodes, _post, derive, getFolded, getFoldedTypes, getSectionCodeMap) { globalThis.__harnessGetters = { getNodes, getFolded, getFoldedTypes, derive, getSectionCodeMap }; return async () => {}; }',
);

// P5-b: the real `lcov.ts`, re-exported, with `loadLcovCoverage` counted.
const REAL_LCOV_URL = new URL('./lcov.ts', import.meta.url).href;
const LCOV_STUB = toDataUrl(`
import { loadLcovCoverage as realLoadLcovCoverage } from ${JSON.stringify(REAL_LCOV_URL)};
export * from ${JSON.stringify(REAL_LCOV_URL)};
export function loadLcovCoverage(projectRoot) {
  globalThis.__harnessLcovCount = (globalThis.__harnessLcovCount ?? 0) + 1;
  return realLoadLcovCoverage(projectRoot);
}
`);

// P5-b founder decision 1: the real generators, with the local per-Node step
// overridable. P5-c: the cloud per-Node steps too, so a Cloud-with-key test
// never reaches the network.
const wrapFactory = (file: string, factories: readonly (readonly [name: string, override: string])[]): string => {
  const url = new URL(file, import.meta.url).href;
  const wrappers = factories
    .map(
      ([name, override]) => `
import { ${name} as real_${name} } from ${JSON.stringify(url)};
export function ${name}(arg) {
  return globalThis.${override} ?? real_${name}(arg);
}`,
    )
    .join('\n');
  return toDataUrl(`
export * from ${JSON.stringify(url)};
${wrappers}
`);
};
const SUMMARY_GENERATOR_STUB = wrapFactory('./summary-generator.ts', [['createLocalSummarizer', '__harnessSummarize']]);
const JUDGMENT_GENERATOR_STUB = wrapFactory('./judgment-generator.ts', [
  ['createLocalJudge', '__harnessJudge'],
  ['createCloudJudge', '__harnessCloudJudge'],
]);
const CLOUD_SUMMARY_GENERATOR_STUB = wrapFactory('./cloud-summary-generator.ts', [['createCloudSummarizer', '__harnessCloudSummarize']]);

const HOOKS = toDataUrl(`
const STUBS = ${JSON.stringify({
  './mcp-client': MCP_CLIENT_STUB,
  './model-manager': MODEL_MANAGER_STUB,
  './mcp-server': MCP_SERVER_STUB,
  './lcov': LCOV_STUB,
  './summary-generator': SUMMARY_GENERATOR_STUB,
  './judgment-generator': JUDGMENT_GENERATOR_STUB,
  './cloud-summary-generator': CLOUD_SUMMARY_GENERATOR_STUB,
})};
export function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  const stubbedParent =
    parent.endsWith('/services/graph-service/index.ts') ||
    parent.endsWith('/services/graph-service/production-code-map.ts');
  if (stubbedParent && STUBS[specifier]) {
    return { url: STUBS[specifier], format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);

export interface Posted {
  type?: string;
  state?: string;
  requestId?: number;
  result?: unknown;
  message?: string;
  [key: string]: unknown;
}

const port = new EventEmitter() as EventEmitter & { postMessage: (message: Posted) => void };
export const posted: Posted[] = [];
const postListeners: ((message: Posted) => void)[] = [];
port.postMessage = (message) => {
  posted.push(message);
  for (const listener of postListeners) {
    listener(message);
  }
};

/** Called synchronously with every message `index.ts` posts. */
export function onPost(listener: (message: Posted) => void): void {
  postListeners.push(listener);
}

export const send = (data: unknown): void => {
  port.emit('message', { data });
};

export async function waitFor<T>(find: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = find();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const statusSince = (from: number, states: readonly string[]) =>
  posted.slice(from).find((message) => message.type === undefined && states.includes(message.state ?? ''));

/** Posts `getCodeMap` and resolves with its reply. */
export async function fetchMap(): Promise<Posted> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap' });
  const reply = await waitFor(
    () =>
      posted
        .slice(from)
        .find((message) => message.type === 'graphService:codeMap' || message.type === 'graphService:codeMapError'),
    'a Code Map reply',
  );
  assert.equal(reply.type, 'graphService:codeMap', reply.message);
  return reply;
}

let traceRequestId = 9000;
/** Posts `pathTrace` and resolves with its result. */
export async function trace(query: string): Promise<unknown> {
  traceRequestId += 1;
  const requestId = traceRequestId;
  const from = posted.length;
  send({ type: 'graphService:pathTrace', query, requestId });
  const reply = await waitFor(
    () => posted.slice(from).find((message) => message.type === 'graphService:pathTraceResult' && message.requestId === requestId),
    'a pathTraceResult',
  );
  return reply.result;
}

/** The live cache getters `index.ts` handed the (stubbed) agent surface. */
export function getters(): {
  getNodes: () => unknown;
  getFolded: () => unknown;
  getFoldedTypes: () => unknown;
  /** P4-4 phase 2b: `index.ts`'s live `deriveLiveNode` closure. */
  derive: (node: unknown) => unknown;
  /** P4-4 phase 2b: `index.ts`'s memoized `getSectionCodeMap`. */
  getSectionCodeMap: (section: string) => unknown;
} {
  const captured = (globalThis as { __harnessGetters?: ReturnType<typeof getters> }).__harnessGetters;
  assert.ok(captured);
  return captured;
}

/** The backend an index request carries (P5-c); `cloudApiKey` only with `cloud`. */
export interface HarnessBackend {
  activeBackend: 'local' | 'cloud';
  cloudApiKey?: string;
}

/**
 * Posts an index request for `projectPath` and resolves once it is
 * `indexing`; with `wait`, once it is `indexed` (or `error`). Local unless
 * `backend` says otherwise (P5-c).
 */
export async function index(projectPath: string, wait = true, backend: HarnessBackend = { activeBackend: 'local' }): Promise<void> {
  const from = posted.length;
  send({ type: 'graphService:index', path: projectPath, ...backend });
  await waitFor(() => statusSince(from, ['indexing', 'error']), 'indexing to start');
  if (wait) {
    await waitFor(() => statusSince(from, ['indexed', 'error']), 'the index to finish');
  }
}

const tempDirs: string[] = [];

/**
 * P4-4e review round 1: a temp dir under the OS temp dir, removed by
 * `removeHarnessTempDirs` (each harness test file calls it in `after`).
 */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Removes every dir `makeTempDir` made (the fixture projects and the userData
 * dir), after flushing the Node record store's debounced write — which would
 * otherwise re-create the userData dir once it fires.
 */
export async function removeHarnessTempDirs(): Promise<void> {
  const { flushNodeRecordStore } = await import('./node-record-store');
  await flushNodeRecordStore();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A temp project holding the fixture's source files (older than its LCOV report) and `coverage/lcov.info`. */
export function makeFixtureProject(): string {
  const project = makeTempDir('driller-scoped-harness-');
  const past = new Date(Date.now() - 60_000);
  for (const file of FIXTURE_SOURCE_FILES) {
    mkdirSync(path.join(project, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(project, file), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n'));
    utimesSync(path.join(project, file), past, past);
  }
  mkdirSync(path.join(project, 'coverage'), { recursive: true });
  writeFileSync(path.join(project, 'coverage', 'lcov.info'), FIXTURE_LCOV);
  return project;
}

/**
 * Loads the real `index.ts` behind the stubs (once per process), indexes
 * `project` (under `backend`, Local by default), and returns the loaded module.
 */
export async function startIndexTs(project: string, backend?: HarnessBackend): Promise<typeof import('./index')> {
  register(HOOKS, import.meta.url);
  (process as unknown as { parentPort: typeof port }).parentPort = port;
  process.argv[2] = makeTempDir('driller-scoped-harness-userdata-');
  const indexModule = await import('./index');
  await index(project, true, backend);
  return indexModule;
}
