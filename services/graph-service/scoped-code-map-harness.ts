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
 *    settles when unset).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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
  return structuredClone(FIXTURE);
}
`);
const MODEL_MANAGER_STUB = toDataUrl(
  'export function ensureLocalModel() { const make = globalThis.__harnessModel; return make ? make() : new Promise(() => {}); }',
);
const MCP_SERVER_STUB = toDataUrl(
  'export function startMcpServer(getNodes, _post, _derive, getFolded, getFoldedTypes) { globalThis.__harnessGetters = { getNodes, getFolded, getFoldedTypes }; return async () => {}; }',
);

const HOOKS = toDataUrl(`
const STUBS = ${JSON.stringify({
  './mcp-client': MCP_CLIENT_STUB,
  './model-manager': MODEL_MANAGER_STUB,
  './mcp-server': MCP_SERVER_STUB,
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
export function getters(): { getNodes: () => unknown; getFolded: () => unknown; getFoldedTypes: () => unknown } {
  const captured = (globalThis as { __harnessGetters?: ReturnType<typeof getters> }).__harnessGetters;
  assert.ok(captured);
  return captured;
}

/**
 * Posts an index request for `projectPath` and resolves once it is
 * `indexing`; with `wait`, once it is `indexed` (or `error`).
 */
export async function index(projectPath: string, wait = true): Promise<void> {
  const from = posted.length;
  send({ type: 'graphService:index', path: projectPath, activeBackend: 'local' });
  await waitFor(() => statusSince(from, ['indexing', 'error']), 'indexing to start');
  if (wait) {
    await waitFor(() => statusSince(from, ['indexed', 'error']), 'the index to finish');
  }
}

/** A temp project holding the fixture's source files (older than its LCOV report) and `coverage/lcov.info`. */
export function makeFixtureProject(): string {
  const project = mkdtempSync(path.join(os.tmpdir(), 'driller-scoped-harness-'));
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
 * `project`, and returns the loaded module.
 */
export async function startIndexTs(project: string): Promise<typeof import('./index')> {
  register(HOOKS, import.meta.url);
  (process as unknown as { parentPort: typeof port }).parentPort = port;
  process.argv[2] = mkdtempSync(path.join(os.tmpdir(), 'driller-scoped-harness-userdata-'));
  const indexModule = await import('./index');
  await index(project);
  return indexModule;
}
