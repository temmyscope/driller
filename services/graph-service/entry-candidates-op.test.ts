/**
 * P4-7c: `computeEntryCandidatesResult` — the entry-candidate listing as a
 * Graph Service operation (AD-13 (f)) — through the real `index.ts`
 * (`scoped-code-map-harness.ts`) over this file's own raw fetch
 * (`__harnessFixtureOverride`), reached three ways: the exported compute
 * function, the `graphService:listEntryCandidates` message (the IPC path
 * main relays), and the `list_entry_candidates` MCP tool's real registered
 * handler (captured from `registerListEntryCandidatesTool`; the listener is
 * never bound).
 *
 * Pins, per the spec's I/O matrix and the founder's section decision:
 *  - the guards (nothing indexed, another project, a generation change
 *    mid-compute, a throw) are explicit `error` results, never a throw;
 *  - the listing equals `listEntryCandidates` over the Code Map reply's own
 *    Nodes and edges (whole scope, and each section's reply), test code never
 *    among the candidates;
 *  - it is memoized per map (and per section and raw cache): a repeat call
 *    does no walk, a refetch or a re-index recomputes;
 *  - with a section: computed from the section's own Nodes and edges, a Node
 *    whose only caller is in another section is a candidate there, and
 *    `reason.loadedBy` never names another section's file; `unknown-section`
 *    and the refreshing window as for the other operations;
 *  - the IPC reply and the MCP tool result are deep-equal for the same state.
 *
 * Nothing on `index.ts`'s import graph is imported statically here (only
 * types and side-effect-free modules): the harness's module hooks must be
 * registered before `production-code-map.ts` first loads.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { listEntryCandidates, type EntryCandidatesResult } from '@driller/graph-contracts';
import type { CodeMapEdge, CodeMapNode } from '@driller/ipc-contracts';

import type { CodeMapFetchResult, CodeMapNodeWithSignalSources } from './mcp-client';
import { index, makeFixtureProject, makeTempDir, posted, removeHarnessTempDirs, send, startIndexTs, waitFor, type Posted } from './scoped-code-map-harness';

const fn = (id: string, file: string, extra: Partial<CodeMapNodeWithSignalSources> = {}): CodeMapNodeWithSignalSources => ({
  id,
  name: id.slice(id.lastIndexOf('.') + 1),
  file,
  startLine: 1,
  endLine: 4,
  kind: 'Function',
  summaryStatus: 'pending',
  riskSignals: [],
  ...extra,
});
const calls = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });
const usage = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'USAGE' });

/**
 * Two sections, `api` and `web`, plus `lib/` outside the scope:
 *  - api: the `path-trace-basic` shape (`handleRequest` → `serviceA`,
 *    `serviceB` → `repository` ↔ `cacheLookup`; two lone helpers), and
 *    `cron` → `serviceA` (reach 3), whose only caller is `web.render`;
 *  - web: `render` → `header`, `body` (USAGE, a JSX render) → `footer`, and
 *    `render` → `api.cron` across sections;
 *  - top-level code: `web/main.ts` calls `api.handleRequest` and `api.cron`
 *    at load, `api/start.ts` calls `api.handleRequest`;
 *  - test code (by path, and by the backend flag) that would be the top
 *    candidate and would take `handleRequest`'s place if it leaked through;
 *  - `lib.tool`, outside the scope, calling into api (a candidate only on
 *    the unscoped fetch).
 */
const FIXTURE: CodeMapFetchResult = {
  nodes: [
    fn('api.handleRequest', 'api/entry.ts'),
    fn('api.serviceA', 'api/services.ts'),
    fn('api.serviceB', 'api/services.ts'),
    fn('api.repository', 'api/repo.ts'),
    fn('api.cacheLookup', 'api/repo.ts'),
    fn('api.helper1', 'api/util.ts'),
    fn('api.helper2', 'api/util.ts'),
    fn('api.cron', 'api/cron.ts'),
    fn('web.render', 'web/app.ts'),
    fn('web.header', 'web/app.ts'),
    fn('web.body', 'web/app.ts'),
    fn('web.footer', 'web/app.ts'),
    fn('lib.tool', 'lib/tool.ts'),
    fn('api.entrySpec', 'api/entry.test.ts'),
    fn('web.flagged', 'web/support.ts', { isTest: true }),
    fn('mod:web/main', 'web/main.ts', { kind: 'Module', endLine: 10 }),
    fn('mod:api/start', 'api/start.ts', { kind: 'Module', endLine: 10 }),
  ],
  edges: [
    calls('api.handleRequest', 'api.serviceA'),
    calls('api.handleRequest', 'api.serviceB'),
    calls('api.serviceA', 'api.repository'),
    calls('api.serviceB', 'api.repository'),
    calls('api.repository', 'api.cacheLookup'),
    calls('api.cacheLookup', 'api.repository'),
    calls('api.cron', 'api.serviceA'),
    calls('web.render', 'web.header'),
    usage('web.render', 'web.body'),
    calls('web.body', 'web.footer'),
    calls('web.render', 'api.cron'),
    calls('lib.tool', 'api.serviceB'),
    calls('lib.tool', 'api.helper1'),
    calls('lib.tool', 'api.helper2'),
    // Test code: dropped with its Nodes.
    calls('api.entrySpec', 'api.handleRequest'),
    calls('api.entrySpec', 'api.helper1'),
    calls('api.entrySpec', 'api.helper2'),
    calls('web.flagged', 'web.render'),
    calls('web.flagged', 'api.helper1'),
    // Top-level (load-time) calls.
    calls('mod:web/main', 'api.handleRequest'),
    calls('mod:web/main', 'api.cron'),
    calls('mod:api/start', 'api.handleRequest'),
  ],
  implementsLinks: [],
  similarPairs: [],
  testEvidence: { calls: [], testFiles: [] },
};

/** Every Node, folded or not, in a cycle: no Node qualifies. */
const CYCLIC: CodeMapFetchResult = {
  ...FIXTURE,
  nodes: ['a', 'b', 'c', 'd'].map((id) => fn(`api.${id}`, 'api/cycle.ts')),
  edges: [calls('api.a', 'api.b'), calls('api.b', 'api.c'), calls('api.c', 'api.d'), calls('api.d', 'api.a')],
};

const TEST_IDS = new Set(['api.entrySpec', 'web.flagged']);

const harness = globalThis as { __harnessFixtureOverride?: unknown; __harnessFetchGate?: Promise<void>; __harnessFetchCount?: number };

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
harness.__harnessFixtureOverride = FIXTURE;

const PROJECT = makeFixtureProject();
let indexModule: typeof import('./index') | undefined;
let mcp: typeof import('./mcp-server') | undefined;

const REPLY_TYPES = ['graphService:codeMap', 'graphService:codeMapUnknownSection', 'graphService:codeMapError'];

/** Posts `getCodeMap` (with `section` when given), waits for the reply and the cache kicks. */
async function requestMap(section?: string): Promise<Posted & { nodes: CodeMapNode[]; edges: CodeMapEdge[] }> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap', ...(section === undefined ? {} : { section }) });
  const reply = await waitFor(() => posted.slice(from).find((m) => REPLY_TYPES.includes(m.type ?? '')), 'a Code Map reply');
  assert.equal(reply.type, 'graphService:codeMap', reply.message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return reply as Posted & { nodes: CodeMapNode[]; edges: CodeMapEdge[] };
}

function setScope(scope: readonly string[]): void {
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
}

let nextRequestId = 70_000;
/** The IPC path: a `graphService:listEntryCandidates` message and its reply. */
async function viaIpc(projectPath: unknown, section?: unknown): Promise<Posted> {
  nextRequestId += 1;
  const requestId = nextRequestId;
  const from = posted.length;
  send({ type: 'graphService:listEntryCandidates', projectPath, requestId, ...(section === undefined ? {} : { section }) });
  return waitFor(
    () => posted.slice(from).find((m) => m.type === 'graphService:listEntryCandidatesResult' && m.requestId === requestId),
    'a listEntryCandidatesResult',
  );
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
interface Registered {
  config: { description?: string; inputSchema?: { safeParse: (value: unknown) => { success: boolean } } };
  handler: ToolHandler;
}

/** The `list_entry_candidates` tool's real registration (name, config, handler). */
function registerTool(): { name: string } & Registered {
  assert.ok(mcp);
  let registered: ({ name: string } & Registered) | undefined;
  mcp.registerListEntryCandidatesTool({
    registerTool: (name: string, config: Registered['config'], handler: ToolHandler) => {
      registered = { name, config, handler };
    },
  } as unknown as Parameters<typeof mcp.registerListEntryCandidatesTool>[0]);
  assert.ok(registered);
  return registered;
}

/** The MCP path: the registered handler's single text block. */
async function viaMcp(args: Record<string, unknown>): Promise<string> {
  const result = await registerTool().handler(args);
  assert.equal(result.content.length, 1);
  return result.content[0]!.text;
}

/** Counts the walks `computeEntryCandidatesResult` runs (the real ranking underneath). */
function countListings(): { count: () => number; restore: () => void } {
  assert.ok(indexModule);
  const module = indexModule;
  let count = 0;
  module.setEntryCandidatesListerForTests((nodes, edges) => {
    count += 1;
    return listEntryCandidates(nodes, edges);
  });
  return { count: () => count, restore: () => module.setEntryCandidatesListerForTests(undefined) };
}

const ids = (result: EntryCandidatesResult): string[] =>
  result.status === 'found' ? result.candidates.map((candidate) => candidate.id) : [];

const candidate = (result: EntryCandidatesResult, id: string) =>
  result.status === 'found' ? result.candidates.find((c) => c.id === id) : undefined;

after(async () => {
  harness.__harnessFixtureOverride = undefined;
  indexModule?.setEntryCandidatesListerForTests(undefined);
  await removeHarnessTempDirs();
});

before(async () => {
  indexModule = await startIndexTs(PROJECT);
  mcp = await import('./mcp-server');
});

describe('P4-7c: guards', () => {
  it('before the first map: the explicit "nothing indexed" error, from every path', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    const expected = { status: 'error', message: 'No project has finished indexing yet.' };
    assert.deepEqual(indexModule.computeEntryCandidatesResult(PROJECT), expected);
    assert.deepEqual(indexModule.computeEntryCandidatesResult(PROJECT, 'api'), expected);
    assert.deepEqual((await viaIpc(PROJECT)).result, expected);
    assert.deepEqual(JSON.parse(await viaMcp({ projectPath: PROJECT })), expected);
  });

  it('another project: the not-the-active-project error, never this project’s candidates', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    setScope([]);
    await requestMap();
    const expected = { status: 'error', message: 'The requested project is not the currently active project.' };
    assert.deepEqual(indexModule.computeEntryCandidatesResult('/somewhere/else'), expected);
    assert.deepEqual((await viaIpc('/somewhere/else')).result, expected);
    assert.deepEqual(JSON.parse(await viaMcp({ projectPath: '/somewhere/else' })), expected);
    assert.equal(indexModule.computeEntryCandidatesResult(PROJECT).status, 'found');
  });

  it('a generation change mid-compute discards the result and memoizes nothing', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    setScope([]);
    await requestMap();
    module.setEntryCandidatesListerForTests((nodes, edges) => {
      // A re-index starts while the listing runs (its first statements are synchronous).
      send({ type: 'graphService:index', path: PROJECT, activeBackend: 'local' });
      return listEntryCandidates(nodes, edges);
    });
    const from = posted.length;
    try {
      assert.deepEqual(module.computeEntryCandidatesResult(PROJECT), {
        status: 'error',
        message: 'The project changed while the entry candidates were being listed; discarding its results.',
      });
    } finally {
      module.setEntryCandidatesListerForTests(undefined);
    }
    assert.equal(module.peekEntryCandidatesMemoForTests().whole, undefined, 'never memoized');
    await waitFor(
      () => posted.slice(from).find((m) => m.type === undefined && (m.state === 'indexed' || m.state === 'error')),
      'the re-index to finish',
    );
    await requestMap();
    assert.equal(module.computeEntryCandidatesResult(PROJECT).status, 'found');
  });

  it('never throws: a failing listing is an explicit error, from every path, and is not memoized', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    setScope(['api', 'web']);
    await requestMap();
    module.setEntryCandidatesListerForTests(() => {
      throw new Error('boom');
    });
    try {
      assert.deepEqual(module.computeEntryCandidatesResult(PROJECT), { status: 'error', message: 'boom' });
      assert.deepEqual(module.computeEntryCandidatesResult(PROJECT, 'api'), { status: 'error', message: 'boom' });
      assert.deepEqual((await viaIpc(PROJECT)).result, { status: 'error', message: 'boom' });
      assert.deepEqual(JSON.parse(await viaMcp({ projectPath: PROJECT, section: 'web' })), { status: 'error', message: 'boom' });
    } finally {
      module.setEntryCandidatesListerForTests(undefined);
    }
    assert.equal(module.peekEntryCandidatesMemoForTests().whole, undefined);
    assert.equal(module.peekEntryCandidatesMemoForTests().sections?.size ?? 0, 0);
    assert.equal(module.computeEntryCandidatesResult(PROJECT).status, 'found');
  });

  it('a malformed section over IPC is the explicit "Invalid section." error', { timeout: 20_000 }, async () => {
    setScope(['api', 'web']);
    await requestMap();
    const reply = await viaIpc(PROJECT, 42);
    assert.deepEqual(reply.result, { status: 'error', message: 'Invalid section.' });
    assert.equal(reply.section, null, 'a malformed section is echoed as null');
  });
});

describe('P4-7c review round 1: a stale fetch landing after an index', () => {
  for (const target of ['another project', 'the same project'] as const) {
    it(`after an index of ${target}, the stale map is never listed (refreshing), nor memoized`, { timeout: 30_000 }, async () => {
      assert.ok(indexModule);
      const module = indexModule;
      setScope(['api', 'web']);
      await requestMap();
      const gate = deferred();
      harness.__harnessFetchGate = gate.promise;
      const fetchesBefore = harness.__harnessFetchCount ?? 0;
      const from = posted.length;
      send({ type: 'graphService:getCodeMap' });
      const indexed = target === 'the same project' ? PROJECT : makeTempDir('driller-entry-race-');
      try {
        await waitFor(() => ((harness.__harnessFetchCount ?? 0) > fetchesBefore ? true : undefined), 'the fetch to start');
        harness.__harnessFetchGate = undefined;
        await index(indexed);
      } finally {
        gate.release();
      }
      await waitFor(() => posted.slice(from).find((m) => m.type === 'graphService:codeMap'), 'the stale fetch to land');
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The stale fetch's Nodes are cached, but no current raw cache stamps them.
      assert.equal(module.getActiveRawCodeMap(), null);
      for (const section of [undefined, 'api']) {
        assert.deepEqual(module.computeEntryCandidatesResult(indexed, section), { ...module.MAP_REFRESHING_RESULT }, `${target} / ${section}`);
      }
      assert.deepEqual((await viaIpc(indexed)).result, { ...module.MAP_REFRESHING_RESULT });
      assert.deepEqual(JSON.parse(await viaMcp({ projectPath: indexed })), { ...module.MAP_REFRESHING_RESULT });
      assert.equal(module.peekEntryCandidatesMemoForTests().whole, undefined, 'never memoized');
      // The next index and fetch of the project are listed again.
      await index(PROJECT);
      setScope(['api', 'web']);
      await requestMap();
      assert.deepEqual(ids(module.computeEntryCandidatesResult(PROJECT)), ['web.render', 'api.handleRequest']);
    });
  }
});

describe('P4-7c: the whole scope', () => {
  it('equals listEntryCandidates over the Code Map reply; no test Node; path-trace-basic ranked', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    for (const scope of [[], ['api', 'web']]) {
      setScope(scope);
      const reply = await requestMap();
      const result = indexModule.computeEntryCandidatesResult(PROJECT);
      assert.deepEqual(result, listEntryCandidates(reply.nodes, reply.edges), scope.join(','));
      for (const id of ids(result)) {
        assert.ok(!TEST_IDS.has(id), `${id} is test code`);
        assert.doesNotMatch(candidate(result, id)!.file, /\.test\.ts$/);
      }
      // `cron`'s only caller is `web.render`; `handleRequest`'s load-time callers are a reason.
      assert.ok(!ids(result).includes('api.cron'));
      assert.deepEqual(candidate(result, 'api.handleRequest'), {
        id: 'api.handleRequest',
        name: 'handleRequest',
        file: 'api/entry.ts',
        startLine: 1,
        endLine: 4,
        reach: 4,
        reason: { kind: 'no-callers', loadedBy: ['api/start.ts', 'web/main.ts'], loadedByTotal: 2 },
      });
    }
    // Unscoped, `lib.tool` (reach 5) is in the map; scoped, it is not.
    setScope([]);
    await requestMap();
    assert.deepEqual(ids(indexModule.computeEntryCandidatesResult(PROJECT)), ['web.render', 'lib.tool', 'api.handleRequest']);
    setScope(['api', 'web']);
    await requestMap();
    assert.deepEqual(ids(indexModule.computeEntryCandidatesResult(PROJECT)), ['web.render', 'api.handleRequest']);
  });

  it('memoized per map: a repeat call does no walk; a refetch or a re-index recomputes on the new map', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    setScope(['api', 'web']);
    await requestMap();
    const counter = countListings();
    try {
      const first = module.computeEntryCandidatesResult(PROJECT);
      assert.equal(module.computeEntryCandidatesResult(PROJECT), first, 'the second call is the memo');
      await viaIpc(PROJECT);
      await viaMcp({ projectPath: PROJECT });
      assert.equal(counter.count(), 1, 'one walk for four calls');
      assert.equal(module.peekEntryCandidatesMemoForTests().whole, first);

      // A refetch over a different graph: recomputed, never the stale memo.
      harness.__harnessFixtureOverride = CYCLIC;
      await requestMap();
      assert.equal(module.peekEntryCandidatesMemoForTests().whole, undefined, 'dropped with the replaced map');
      assert.deepEqual(module.computeEntryCandidatesResult(PROJECT), { status: 'none' }, 'a cyclic project has no candidate');
      assert.deepEqual((await viaIpc(PROJECT)).result, { status: 'none' });
      assert.equal(counter.count(), 2);

      // A re-index between two calls: recomputed on the new map.
      harness.__harnessFixtureOverride = FIXTURE;
      await index(PROJECT);
      assert.equal(module.peekEntryCandidatesMemoForTests().whole, undefined, 'dropped by the re-index');
      assert.deepEqual(module.computeEntryCandidatesResult(PROJECT), { status: 'error', message: 'No project has finished indexing yet.' });
      setScope(['api', 'web']);
      await requestMap();
      assert.deepEqual(ids(module.computeEntryCandidatesResult(PROJECT)), ['web.render', 'api.handleRequest']);
      assert.equal(counter.count(), 3);
    } finally {
      harness.__harnessFixtureOverride = FIXTURE;
      counter.restore();
    }
  });

  it('a backend switch re-caching the same map keeps the memo', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    setScope(['api', 'web']);
    await requestMap();
    const first = indexModule.computeEntryCandidatesResult(PROJECT);
    send({ type: 'graphService:backendSwitched', activeBackend: 'local' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(indexModule.computeEntryCandidatesResult(PROJECT), first);
  });
});

describe('P4-7c: with a section (founder decision 2026-10-04)', () => {
  it("equals listEntryCandidates over the section's own Code Map reply, never the whole scope filtered", { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    setScope(['api', 'web']);
    await requestMap();
    for (const section of ['api', 'web']) {
      const result = indexModule.computeEntryCandidatesResult(PROJECT, section);
      const reply = await requestMap(section);
      assert.deepEqual(result, listEntryCandidates(reply.nodes, reply.edges), section);
      assert.ok(ids(result).every((id) => id.startsWith(`${section}.`)), `${section}: ${ids(result).join(',')}`);
    }
    // `web.render` reaches 3 in web (header, body, footer), 7 across the whole scope.
    assert.equal(candidate(indexModule.computeEntryCandidatesResult(PROJECT, 'web'), 'web.render')?.reach, 3);
    assert.equal(candidate(indexModule.computeEntryCandidatesResult(PROJECT), 'web.render')?.reach, 7);
  });

  it("a Node whose only callers are in another section is a candidate in its own; loadedBy never names another section's file", { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    setScope(['api', 'web']);
    await requestMap();
    const api = indexModule.computeEntryCandidatesResult(PROJECT, 'api');
    assert.deepEqual(ids(api), ['api.handleRequest', 'api.cron']);
    // Called by web.render and loaded by web/main.ts only: a candidate in api, with no loadedBy at all.
    assert.deepEqual(candidate(api, 'api.cron')?.reason, { kind: 'no-callers' });
    assert.equal(candidate(api, 'api.cron')?.reach, 3);
    // Loaded by api/start.ts and web/main.ts: only api's own file is named.
    assert.deepEqual(candidate(api, 'api.handleRequest')?.reason, {
      kind: 'no-callers',
      loadedBy: ['api/start.ts'],
      loadedByTotal: 1,
    });
    // The section's own reply re-scopes `calledAtLoadBy` the same way.
    const reply = await requestMap('api');
    assert.deepEqual(reply.nodes.find((n) => n.id === 'api.cron')?.calledAtLoadBy, undefined);
    assert.deepEqual(reply.nodes.find((n) => n.id === 'api.handleRequest')?.calledAtLoadBy, ['api/start.ts']);
  });

  it('unknown-section, the refreshing window, and per-section memo dropped with the raw cache', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    setScope(['api', 'web']);
    await requestMap();
    assert.deepEqual(module.computeEntryCandidatesResult(PROJECT, 'docs'), {
      status: 'unknown-section',
      section: 'docs',
      knownSections: ['api', 'web'],
    });
    assert.deepEqual(JSON.parse(await viaMcp({ projectPath: PROJECT, section: 'all' })), {
      status: 'unknown-section',
      section: 'all',
      knownSections: ['api', 'web'],
    });
    // A new entry is saved; no refetch yet: the explicit refreshing error.
    setScope(['api', 'web', 'lib']);
    assert.deepEqual(module.computeEntryCandidatesResult(PROJECT, 'lib'), { ...module.MAP_REFRESHING_RESULT });
    await requestMap();
    // Its own Nodes and edges only: `lib.tool`'s callees are in api, so lib has no candidate.
    assert.deepEqual(module.computeEntryCandidatesResult(PROJECT, 'lib'), { status: 'none' });
    setScope(['api', 'web']);
    await requestMap();

    const counter = countListings();
    try {
      const api = module.computeEntryCandidatesResult(PROJECT, 'api');
      assert.equal(module.computeEntryCandidatesResult(PROJECT, 'api'), api, 'the second call is the memo');
      module.computeEntryCandidatesResult(PROJECT, 'web');
      assert.deepEqual([...(module.peekEntryCandidatesMemoForTests().sections?.keys() ?? [])], ['api', 'web']);
      assert.equal(counter.count(), 2, 'one walk per section');
      assert.equal(module.peekEntryCandidatesMemoForTests().whole, undefined, 'a section call never fills the whole-scope memo');
      await requestMap();
      assert.equal(module.peekEntryCandidatesMemoForTests().sections, undefined, 'dropped with the replaced raw cache');
      assert.deepEqual(module.computeEntryCandidatesResult(PROJECT, 'api'), api);
      assert.equal(counter.count(), 3);
      await index(PROJECT);
      assert.equal(module.peekEntryCandidatesMemoForTests().sections, undefined, 'dropped with the cleared raw cache');
    } finally {
      counter.restore();
    }
    setScope(['api', 'web']);
    await requestMap();
  });
});

describe('P4-7c: IPC and MCP parity', () => {
  it('the IPC reply and the MCP tool result are deep-equal, with and without a section', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    for (const scope of [[], ['api', 'web']]) {
      setScope(scope);
      await requestMap();
      for (const section of scope.length === 0 ? [undefined, 'api'] : [undefined, 'api', 'web', 'docs']) {
        const ipc = await viaIpc(PROJECT, section);
        assert.equal(ipc.projectPath, PROJECT);
        // Review round 1: the reply echoes the request's section (null = whole scope).
        assert.equal(ipc.section, section ?? null);
        const text = await viaMcp({ projectPath: PROJECT, ...(section === undefined ? {} : { section }) });
        // The IPC reply crosses a structured-clone boundary; compare it as the renderer gets it.
        assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(ipc.result)), `${scope.join(',')} / ${section}`);
        assert.equal(text, JSON.stringify(indexModule.computeEntryCandidatesResult(PROJECT, section)));
      }
    }
    // The acceptance case: found, handleRequest among the candidates, no test Node.
    setScope(['api', 'web']);
    await requestMap();
    const result = JSON.parse(await viaMcp({ projectPath: PROJECT })) as EntryCandidatesResult;
    assert.equal(result.status, 'found');
    assert.ok(ids(result).includes('api.handleRequest'));
    assert.ok(ids(result).every((id) => !TEST_IDS.has(id)));
  });

  it('review round 1: startMcpServer registers list_entry_candidates (source)', () => {
    const src = readFileSync(fileURLToPath(new URL('./mcp-server.ts', import.meta.url)), 'utf8');
    const start = src.indexOf('export function startMcpServer(');
    const end = src.indexOf('new WebStandardStreamableHTTPServerTransport(', start);
    assert.ok(start >= 0 && end > start);
    assert.match(src.slice(start, end), /\n {2}registerListEntryCandidatesTool\(server\);/);
  });

  it('the tool: name, version 1.10.0, the description’s promises, and its input rules', () => {
    assert.ok(mcp);
    assert.equal(mcp.MCP_SERVER_VERSION, '1.10.0');
    const tool = registerTool();
    assert.equal(tool.name, 'list_entry_candidates');
    const description = tool.config.description ?? '';
    assert.match(description, /heuristic over indexed code/);
    // Review round 1: "indexed code" means the in-scope Code Map.
    assert.match(description, /no caller among the Code Map's in-scope Nodes \(indexed code within the indexing scope\)/);
    assert.match(description, /never a claim that a Node is the program's entry point/);
    assert.match(description, /\{status: 'none', hiddenPinIds\?\} when no Node qualifies and none is pinned .* which means no qualifying Node, NOT that the code has no entry point/);
    assert.match(description, /Reason kinds: 'pinned' \(the engineer pinned it as an entry point\); 'no-callers'/);
    // P4-7g: pins first, in pin order; hidden pins named.
    assert.match(description, /pinned as entry points in the driller app come first, in the order they were pinned/);
    assert.match(description, /'hiddenPinIds' \(present only when not empty\) lists pinned Node ids that are not on the Code Map/);
    assert.match(description, /'loadedBy'/);
    assert.match(description, /USAGE counts as a caller/);
    assert.match(description, /Load-time calls from a file's top level .* do NOT count as callers/);
    assert.match(description, /at most 12/);
    assert.match(description, /fewer than 3/);
    assert.match(description, /nearest \(longest\) allowlist entry/);
    assert.match(description, /'loadedBy' names only files inside the section/);
    const schema = tool.config.inputSchema;
    assert.ok(schema);
    assert.equal(schema.safeParse({ projectPath: PROJECT }).success, true, 'section is optional');
    assert.equal(schema.safeParse({ projectPath: PROJECT, section: 'api' }).success, true);
    assert.equal(schema.safeParse({ projectPath: PROJECT, section: '' }).success, false, "'' is rejected, as on every tool");
    assert.equal(schema.safeParse({ projectPath: 42 }).success, false);
  });
});

describe('P4-7g: pins in the Graph Service', () => {
  /** Posts an index request carrying `entryPins` and waits for it to finish. */
  async function indexWithPins(entryPins: string[]): Promise<void> {
    const from = posted.length;
    send({ type: 'graphService:index', path: PROJECT, activeBackend: 'local', entryPins });
    await waitFor(
      () => posted.slice(from).find((m) => m.type === undefined && (m.state === 'indexed' || m.state === 'error')),
      'the index to finish',
    );
  }
  const setPins = (projectPath: string, pinnedIds: string[]) => send({ type: 'graphService:setEntryPins', projectPath, pinnedIds });
  const reasons = (result: EntryCandidatesResult) =>
    result.status === 'found' ? result.candidates.map((c) => [c.id, c.reason.kind]) : [];

  after(async () => {
    // Leave no pins for the next file's state (the harness is per file, but be tidy).
    setPins(PROJECT, []);
  });

  it('the index request carries the pins: the first listing ranks them first, in pin order', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    await indexWithPins(['api.serviceB', 'api.helper1']);
    assert.deepEqual(indexModule.peekEntryPinsForTests(), { projectPath: PROJECT, pinnedIds: ['api.serviceB', 'api.helper1'] });
    setScope(['api', 'web']);
    await requestMap();
    const result = indexModule.computeEntryCandidatesResult(PROJECT);
    assert.deepEqual(reasons(result), [
      ['api.serviceB', 'pinned'],
      ['api.helper1', 'pinned'],
      ['web.render', 'no-callers'],
      ['api.handleRequest', 'no-callers'],
    ]);
    assert.equal(candidate(result, 'api.serviceB')?.reach, 2);
    assert.equal(candidate(result, 'api.helper1')?.reach, 0);
    const reply = await requestMap();
    assert.deepEqual(
      indexModule.computeEntryCandidatesResult(PROJECT),
      listEntryCandidates(reply.nodes, reply.edges, { pinnedIds: ['api.serviceB', 'api.helper1'] }),
    );
  });

  it('a pin change drops the memo: the next listing ranks the new pins, never the stale ranking', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    await indexWithPins([]);
    setScope(['api', 'web']);
    await requestMap();
    const before = module.computeEntryCandidatesResult(PROJECT);
    module.computeEntryCandidatesResult(PROJECT, 'api');
    assert.deepEqual(ids(before), ['web.render', 'api.handleRequest']);
    assert.equal(module.computeEntryCandidatesResult(PROJECT), before, 'memoized');
    setPins(PROJECT, ['api.cacheLookup']);
    assert.equal(module.peekEntryCandidatesMemoForTests().whole, undefined, 'whole-scope memo dropped');
    assert.equal(module.peekEntryCandidatesMemoForTests().sections, undefined, 'section memo dropped');
    assert.deepEqual(ids(module.computeEntryCandidatesResult(PROJECT)), ['api.cacheLookup', 'web.render', 'api.handleRequest']);
    assert.deepEqual(ids(module.computeEntryCandidatesResult(PROJECT, 'api')), ['api.cacheLookup', 'api.handleRequest', 'api.cron']);
    // Unpinning restores the heuristic ranking.
    setPins(PROJECT, []);
    assert.deepEqual(module.computeEntryCandidatesResult(PROJECT), before);
  });

  it('setEntryPins for another project is ignored: no pins applied, no memo dropped', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    await indexWithPins(['api.serviceA']);
    setScope(['api', 'web']);
    await requestMap();
    const before = module.computeEntryCandidatesResult(PROJECT);
    setPins('/somewhere/else', ['api.serviceB']);
    assert.deepEqual(module.peekEntryPinsForTests(), { projectPath: PROJECT, pinnedIds: ['api.serviceA'] });
    assert.equal(module.computeEntryCandidatesResult(PROJECT), before);
    assert.deepEqual(ids(before), ['api.serviceA', 'web.render', 'api.handleRequest']);
    // Malformed messages are ignored as well.
    send({ type: 'graphService:setEntryPins', projectPath: PROJECT, pinnedIds: [3] });
    send({ type: 'graphService:setEntryPins', projectPath: PROJECT });
    assert.deepEqual(module.peekEntryPinsForTests(), { projectPath: PROJECT, pinnedIds: ['api.serviceA'] });
  });

  it('a missing pin is hidden and reported, never a candidate; in a section, a pin elsewhere on the map is neither', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    await indexWithPins(['api.renamedAway', 'web.header', 'api.serviceB']);
    setScope(['api', 'web']);
    await requestMap();
    const whole = module.computeEntryCandidatesResult(PROJECT);
    assert.deepEqual(ids(whole), ['web.header', 'api.serviceB', 'web.render', 'api.handleRequest']);
    assert.ok(whole.status === 'found');
    assert.deepEqual(whole.hiddenPinIds, ['api.renamedAway']);
    // In api: web.header is on the map but in web — not shown, not missing.
    const api = module.computeEntryCandidatesResult(PROJECT, 'api');
    assert.deepEqual(ids(api), ['api.serviceB', 'api.handleRequest', 'api.cron']);
    assert.ok(api.status === 'found');
    assert.deepEqual(api.hiddenPinIds, ['api.renamedAway']);
    const web = module.computeEntryCandidatesResult(PROJECT, 'web');
    assert.deepEqual(ids(web), ['web.header', 'web.render']);
    assert.ok(web.status === 'found' && web.hiddenPinIds?.join() === 'api.renamedAway');
    // A pin outside the indexing scope (lib) is not on the map: hidden.
    setPins(PROJECT, ['lib.tool']);
    const reply = await requestMap();
    const unpinned = listEntryCandidates(reply.nodes, reply.edges);
    assert.ok(unpinned.status === 'found');
    assert.deepEqual(module.computeEntryCandidatesResult(PROJECT), { ...unpinned, hiddenPinIds: ['lib.tool'] });
    // Pins are never removed by the Graph Service.
    assert.deepEqual(module.peekEntryPinsForTests()?.pinnedIds, ['lib.tool']);
  });

  it('cyclic project + one pin: found with the pin only', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    harness.__harnessFixtureOverride = CYCLIC;
    try {
      await indexWithPins(['api.c']);
      setScope([]);
      await requestMap();
      assert.deepEqual(reasons(indexModule.computeEntryCandidatesResult(PROJECT)), [['api.c', 'pinned']]);
    } finally {
      harness.__harnessFixtureOverride = FIXTURE;
    }
    await indexWithPins([]);
    setScope(['api', 'web']);
    await requestMap();
  });

  it('IPC and MCP rank the pins identically (parity), with and without a section', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    await indexWithPins(['api.repository']);
    setScope(['api', 'web']);
    await requestMap();
    setPins(PROJECT, ['web.footer', 'api.repository', 'api.gone']);
    for (const section of [undefined, 'api', 'web']) {
      const ipc = await viaIpc(PROJECT, section);
      const text = await viaMcp({ projectPath: PROJECT, ...(section === undefined ? {} : { section }) });
      assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(ipc.result)), String(section));
      const result = JSON.parse(text) as EntryCandidatesResult;
      assert.equal(result.status === 'found' ? result.candidates[0]?.reason.kind : undefined, 'pinned', String(section));
    }
    const whole = JSON.parse(await viaMcp({ projectPath: PROJECT })) as EntryCandidatesResult;
    assert.deepEqual(ids(whole).slice(0, 2), ['web.footer', 'api.repository']);
    setPins(PROJECT, []);
  });

  it('review round 1: invalid ids in the index request are dropped, never rejecting the index', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const from = posted.length;
    send({ type: 'graphService:index', path: PROJECT, activeBackend: 'local', entryPins: ['api.serviceB', 3, '', null, 'api.serviceB', 'api.cron'] });
    await waitFor(
      () => posted.slice(from).find((m) => m.type === undefined && (m.state === 'indexed' || m.state === 'error')),
      'the index to finish',
    );
    assert.equal(posted.slice(from).some((m) => m.type === undefined && m.state === 'indexed'), true, 'indexed');
    assert.deepEqual(indexModule.peekEntryPinsForTests(), { projectPath: PROJECT, pinnedIds: ['api.serviceB', 'api.cron'] });
    assert.deepEqual(indexModule.sanitizeEntryPins('api.x'), []);
    // A non-array is no pins, still indexed.
    await indexWithPins('nope' as unknown as string[]);
    assert.deepEqual(indexModule.peekEntryPinsForTests()?.pinnedIds, []);
  });

  it('review round 1: the map fetched after an index reports the pins not on it (once per fetch; main dedupes)', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    await indexWithPins(['api.renamedAway', 'api.serviceB', 'lib.tool']);
    setScope(['api', 'web']);
    const from = posted.length;
    await requestMap();
    const reports = posted.slice(from).filter((m) => m.type === 'graphService:entryPinsMissing');
    assert.deepEqual(
      reports.map((m) => [m.projectPath, (m as unknown as { nodeIds: string[] }).nodeIds]),
      [[PROJECT, ['api.renamedAway', 'lib.tool']]],
    );
    // No pins missing: nothing posted.
    await indexWithPins(['api.serviceB']);
    const quiet = posted.length;
    await requestMap();
    assert.equal(posted.slice(quiet).some((m) => m.type === 'graphService:entryPinsMissing'), false);
    setPins(PROJECT, []);
  });
});
