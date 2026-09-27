/**
 * P2-1: `graphService:scopeChanged` end to end through the real `index.ts`
 * message handler — a `getCodeMap` posted right after it is filtered with the
 * new scope, no status is posted (no re-index), and an index in flight when
 * the scope is saved finishes with the saved scope.
 *
 * `index.ts` has load-time side effects, so this file loads it once, after:
 *  - a stub `process.parentPort` (an EventEmitter recording `postMessage`) —
 *    the Electron `utilityProcess` channel it listens and posts on;
 *  - a temp userData dir as `process.argv[2]`, for the Node record store;
 *  - module hooks, registered at runtime with `module.register` (no
 *    experimental mocking flag), that swap `index.ts`'s imports of
 *    `./mcp-client` (CBM), `./model-manager` (the GGUF download) and
 *    `./mcp-server` (the port bind) for in-memory stubs. Nothing else is
 *    stubbed: the filter, the handlers and the state are the real ones.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';

const toDataUrl = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;

const MCP_CLIENT_STUB = toDataUrl(`
export function stopCbmDaemon() {}
export async function indexRepository() {
  const gate = globalThis.__scopeTestIndexGate;
  if (gate) await gate;
  return { nodes: 4, edges: 3, project: 'stub-project' };
}
const node = (id, file) => ({ id, name: id, file, startLine: 1, endLine: 2, kind: 'Function', summaryStatus: 'pending', riskSignals: [] });
export async function fetchCodeMap() {
  return {
    nodes: [
      node('w', 'web/a.ts'),
      node('a', 'app/b.ts'),
      node('d', 'docs/c.ts'),
      node('x', 'webapp/d.ts'),
      // P4-2 phase 1: test code the fetch path must drop — by path rule
      // (\`t\`), and by the backend flag alone (\`f\`).
      node('t', 'web/a.test.ts'),
      { ...node('f', 'app/fixtures.ts'), isTest: true },
    ],
    // FIX-2: w calls a AND d, and a calls d too — so BFS reaches d first
    // from w (a sibling of a, not a's callee in the tree).
    // P4-2 phase 1: w's first edge goes to the test Node \`t\` (and \`t\` on to
    // \`f\`), so a trace that didn't exclude test code would include them.
    edges: [
      { source: 'w', target: 't', kind: 'CALLS' },
      { source: 't', target: 'f', kind: 'CALLS' },
      { source: 'f', target: 'a', kind: 'CALLS' },
      { source: 'w', target: 'a', kind: 'CALLS' },
      { source: 'a', target: 'd', kind: 'CALLS' },
      { source: 'w', target: 'd', kind: 'CALLS' },
    ],
  };
}
`);
const MODEL_MANAGER_STUB = toDataUrl('export function ensureLocalModel() { return new Promise(() => {}); }');
// Keeps the live `activeCodeMapNodes` getter `index.ts` hands the agent
// surface, so a test can run the real `lookupNode` against it.
const MCP_SERVER_STUB = toDataUrl(
  'export function startMcpServer(getNodes) { globalThis.__scopeTestGetNodes = getNodes; return async () => {}; }',
);

const HOOKS = toDataUrl(`
const STUBS = ${JSON.stringify({
  './mcp-client': MCP_CLIENT_STUB,
  './model-manager': MODEL_MANAGER_STUB,
  './mcp-server': MCP_SERVER_STUB,
})};
export function resolve(specifier, context, nextResolve) {
  // P4-2: \`production-code-map.ts\` is where \`index.ts\`'s Code Map fetch
  // now imports \`./mcp-client\` from, so it gets the same stub.
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

interface Posted {
  type?: string;
  requestId?: number;
  result?: unknown;
  state?: string;
  nodes?: { id: string; file: string }[];
  edges?: { source: string; target: string }[];
  message?: string;
  hiddenByScope?: number;
  appliedScope?: string[];
}

const port = new EventEmitter() as EventEmitter & { postMessage: (message: Posted) => void };
const posted: Posted[] = [];
port.postMessage = (message) => {
  posted.push(message);
};

const PROJECT = mkdtempSync(path.join(os.tmpdir(), 'driller-scope-project-'));
const OTHER_PROJECT = mkdtempSync(path.join(os.tmpdir(), 'driller-scope-other-'));

const send = (data: unknown): void => {
  port.emit('message', { data });
};

async function waitFor<T>(find: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = find();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every Graph Service status posted since `from` (status messages carry `state` and no `type`). */
const statusesSince = (from: number): string[] =>
  posted.slice(from).flatMap((message) => (message.type === undefined && message.state ? [message.state] : []));

/** Posts `getCodeMap` and resolves with the `graphService:codeMap` reply. */
async function fetchMap(): Promise<Posted> {
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

/** Posts `getCodeMap` and resolves with the reply's Node files. */
async function fetchMapFiles(): Promise<string[]> {
  return ((await fetchMap()).nodes ?? []).map((node) => node.file);
}

/** Posts an index request and resolves once its `indexed` (or `error`) status lands. */
async function index(projectPath: string, includedPaths?: string[]): Promise<void> {
  const from = posted.length;
  send({ type: 'graphService:index', path: projectPath, activeBackend: 'local', ...(includedPaths ? { includedPaths } : {}) });
  await waitFor(() => statusesSince(from).find((state) => state === 'indexed' || state === 'error'), 'an index to finish');
}

const ALL = ['web/a.ts', 'app/b.ts', 'docs/c.ts', 'webapp/d.ts'];

describe('graphService:scopeChanged through index.ts', () => {
  before(async () => {
    register(HOOKS, import.meta.url);
    (process as unknown as { parentPort: typeof port }).parentPort = port;
    process.argv[2] = mkdtempSync(path.join(os.tmpdir(), 'driller-scope-userdata-'));
    await import('./index');
    await index(PROJECT);
  });

  it('filters the next Code Map fetch with the saved scope, posting no status', async () => {
    const from = posted.length;
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web'] });
    assert.deepEqual(await fetchMapFiles(), ['web/a.ts']);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web', 'app'] });
    assert.deepEqual(await fetchMapFiles(), ['web/a.ts', 'app/b.ts']);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    assert.deepEqual(await fetchMapFiles(), ALL);
    assert.deepEqual(statusesSince(from), []);
  });

  it('P2-5: reports how many Nodes the scope filter removed, and the scope it used', async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    const unscoped = await fetchMap();
    assert.equal(unscoped.hiddenByScope, 0);
    assert.deepEqual(unscoped.appliedScope, []);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web', 'app'] });
    const scoped = await fetchMap();
    // 2 hidden: `d` (docs/c.ts) and `x` (webapp/d.ts — a sibling folder that
    // only shares the `web` prefix); `w` (web/a.ts) and `a` (app/b.ts) stay.
    assert.equal(scoped.hiddenByScope, 2);
    assert.deepEqual(scoped.appliedScope, ['web', 'app']);
    // A scope that matches nothing (a typo) hides every Node.
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['wbe'] });
    const empty = await fetchMap();
    assert.deepEqual(empty.nodes, []);
    assert.equal(empty.hiddenByScope, ALL.length);
    assert.deepEqual(empty.appliedScope, ['wbe']);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    assert.deepEqual(await fetchMapFiles(), ALL);
  });

  // FIX-2 / AD-13: the renderer's IPC Path Trace and the agent surface's
  // `trace_path` (which JSON-serializes `computePathTraceResult` as-is) get
  // the same BFS tree — siblings are siblings on both surfaces.
  it('FIX-2: IPC pathTrace and the registered trace_path handler return the same call tree', async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    // Settled: the next fetch sees the cleared scope (messages are handled in order).
    assert.deepEqual(await fetchMapFiles(), ALL);
    // w calls a and d; d is a SIBLING of a (reached from w), not a's callee.
    const expected = {
      status: 'found',
      path: ['w', 'a', 'd'],
      parents: { w: null, a: 'w', d: 'w' },
      depths: { w: 0, a: 1, d: 1 },
    };
    const from = posted.length;
    send({ type: 'graphService:pathTrace', query: 'w', requestId: 4242 });
    const reply = await waitFor(
      () => posted.slice(from).find((message) => message.type === 'graphService:pathTraceResult' && message.requestId === 4242),
      'a pathTraceResult',
    );
    // The engine's records are null-prototype; compare their JSON (what
    // crosses both the IPC boundary and the MCP wire).
    assert.deepEqual(JSON.parse(JSON.stringify(reply.result)), expected);

    // The agent surface: capture the handler `registerTracePathTool` really
    // registers and invoke it (no listener is bound).
    const { registerTracePathTool } = await import('./mcp-server');
    let handler: ((args: { query: string }) => Promise<{ content: { type: string; text: string }[] }>) | undefined;
    let description = '';
    registerTracePathTool({
      registerTool: (name: string, config: { description?: string }, cb: typeof handler) => {
        assert.equal(name, 'trace_path');
        description = config.description ?? '';
        handler = cb;
      },
    } as unknown as Parameters<typeof registerTracePathTool>[0]);
    assert.ok(handler);
    const toolResult = await handler({ query: 'w' });
    assert.deepEqual(JSON.parse(toolResult.content[0]!.text), expected);
    assert.match(description, /call tree/);
    assert.match(description, /not a single path/);
  });

  it('P4-2: the map reply, lookup_node and the cached map exclude test Nodes and their edges', async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    const map = await fetchMap();
    assert.deepEqual(
      (map.nodes ?? []).map((node) => node.id),
      ['w', 'a', 'd', 'x'],
    );
    assert.deepEqual(
      (map.edges ?? []).map((edge) => `${edge.source}->${edge.target}`),
      ['w->a', 'a->d', 'w->d'],
    );
    // Test Nodes are not "hidden by scope" — they never reach the scope filter.
    assert.equal(map.hiddenByScope, 0);

    // `lookup_node` (the real handler logic, over the live cache every
    // cache-reading consumer — diff scope, Blast Radius, Health Audit — reads).
    const getNodes = (globalThis as { __scopeTestGetNodes?: () => { id: string }[] | undefined })
      .__scopeTestGetNodes;
    assert.ok(getNodes);
    assert.deepEqual(
      (getNodes() ?? []).map((node) => node.id),
      ['w', 'a', 'd', 'x'],
    );
    // This test file's own import is not redirected (the hook only stubs
    // imports made from `index.ts`/`production-code-map.ts`), so this is the
    // real `lookupNode` — the stub module has no such export at all.
    const mcpServer = await import('./mcp-server');
    assert.equal(typeof mcpServer.lookupNode, 'function');
    assert.equal(typeof mcpServer.registerTracePathTool, 'function');
    const { lookupNode } = mcpServer;
    const cached = getNodes() as Parameters<typeof lookupNode>[1];
    assert.deepEqual(lookupNode('t', cached, (node) => node), { status: 'not-found' });
    assert.deepEqual(lookupNode('f', cached, (node) => node), { status: 'not-found' });
    assert.equal(lookupNode('w', cached, (node) => node).status, 'ok');
    // Nothing else reads the captured getter; don't leak it past this test.
    delete (globalThis as { __scopeTestGetNodes?: unknown }).__scopeTestGetNodes;
  });

  it('ignores a malformed scopeChanged', async () => {
    send({ type: 'graphService:scopeChanged', path: 'relative/path', includedPaths: ['web'] });
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [1] });
    assert.deepEqual(await fetchMapFiles(), ALL);
  });

  it("a scope for a project that isn't active or indexing leaves the map alone", async () => {
    send({ type: 'graphService:scopeChanged', path: OTHER_PROJECT, includedPaths: ['web'] });
    assert.deepEqual(await fetchMapFiles(), ALL);
  });

  it('an index in flight finishes with a scope saved mid-index, not the one it started with', async () => {
    let release!: () => void;
    (globalThis as { __scopeTestIndexGate?: Promise<void> }).__scopeTestIndexGate = new Promise((resolve) => {
      release = resolve;
    });
    const from = posted.length;
    send({ type: 'graphService:index', path: PROJECT, activeBackend: 'local', includedPaths: ['docs'] });
    await waitFor(() => statusesSince(from).find((state) => state === 'indexing'), 'indexing');
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['app'] });
    release();
    await waitFor(() => statusesSince(from).find((state) => state === 'indexed'), 'indexed');
    delete (globalThis as { __scopeTestIndexGate?: Promise<void> }).__scopeTestIndexGate;
    assert.deepEqual(await fetchMapFiles(), ['app/b.ts']);
  });

  it('a stale override is dropped when a new index starts', async () => {
    // Saved while no index runs: adopted now, and also recorded as the
    // override for the last-requested project.
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web'] });
    assert.deepEqual(await fetchMapFiles(), ['web/a.ts']);
    // The next index carries what main persisted since; the earlier override
    // must not win over it.
    await index(PROJECT, ['docs']);
    assert.deepEqual(await fetchMapFiles(), ['docs/c.ts']);
  });
});
