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
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

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
      // P4-2 phase 3a: Module Nodes (a file's top-level code), folded off
      // the map — one in a file with map Nodes, one in a file with none.
      { ...node('mod:web/a', 'web/a.ts'), kind: 'Module' },
      { ...node('mod:lib/boot', 'lib/boot.ts'), kind: 'Module' },
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
      // P4-2 phase 3a: top-level calls; kept only as the files' top-level uses.
      { source: 'mod:web/a', target: 'a', kind: 'CALLS' },
      { source: 'mod:web/a', target: 'd', kind: 'USAGE' },
      { source: 'mod:lib/boot', target: 'a', kind: 'CALLS' },
    ],
    // P4-2 phase 2: \`t\` calls \`w\` through an import; \`f\` reaches \`a\` only
    // by a name-only match, which must never count.
    testEvidence: {
      calls: [
        { source: 't', sourceName: 't', sourceFile: 'web/a.test.ts', sourceStartLine: 1, sourceEndLine: 2, sourceKind: 'Function', target: 'w', strategy: 'import_map', confidence: 0.95 },
        { source: 'f', sourceName: 'f', sourceFile: 'app/fixtures.ts', sourceStartLine: 1, sourceEndLine: 2, sourceKind: 'Function', sourceIsTest: true, target: 'a', strategy: 'unique_name', confidence: 0.75 },
      ],
      testFiles: [],
    },
  };
}
`);
const MODEL_MANAGER_STUB = toDataUrl('export function ensureLocalModel() { return new Promise(() => {}); }');
// Keeps the live `activeCodeMapNodes` getter `index.ts` hands the agent
// surface, so a test can run the real `lookupNode` against it.
const MCP_SERVER_STUB = toDataUrl(
  'export function startMcpServer(getNodes, _post, _derive, getFolded) { globalThis.__scopeTestGetNodes = getNodes; globalThis.__scopeTestGetFolded = getFolded; return async () => {}; }',
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
  nodes?: {
    id: string;
    file: string;
    testedBy?: unknown;
    fileTopLevel?: unknown;
    calledAtLoadBy?: unknown;
    riskSignals?: { type?: string; value?: number }[];
  }[];
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

/** P4-2 phase 3a: the live `activeCodeMapNodes` / `activeFoldedModules` getters the stubbed `startMcpServer` captured. */
function capturedGetters(): { getNodes: () => unknown; getFolded: () => unknown } {
  const captured = globalThis as { __scopeTestGetNodes?: () => unknown; __scopeTestGetFolded?: () => unknown };
  assert.ok(captured.__scopeTestGetNodes && captured.__scopeTestGetFolded);
  return { getNodes: captured.__scopeTestGetNodes, getFolded: captured.__scopeTestGetFolded };
}

describe('graphService:scopeChanged through index.ts', () => {
  before(async () => {
    register(HOOKS, import.meta.url);
    (process as unknown as { parentPort: typeof port }).parentPort = port;
    process.argv[2] = mkdtempSync(path.join(os.tmpdir(), 'driller-scope-userdata-'));
    await import('./index');
    await index(PROJECT);
  });

  // The stubbed `startMcpServer` parks `index.ts`'s live getters on
  // `globalThis`; nothing outside this file reads them, so don't leak them.
  after(() => {
    delete (globalThis as { __scopeTestGetNodes?: unknown }).__scopeTestGetNodes;
    delete (globalThis as { __scopeTestGetFolded?: unknown }).__scopeTestGetFolded;
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
    // P4-2 phase 2: the map reply and lookup_node carry the same testedBy.
    const expectedTestedBy = {
      tests: [{ id: 't', name: 't', file: 'web/a.test.ts', startLine: 1, endLine: 2 }],
      totalTests: 1,
      files: [],
    };
    assert.deepEqual(map.nodes?.find((node) => node.id === 'w')?.testedBy, expectedTestedBy);
    assert.equal(map.nodes?.find((node) => node.id === 'a')?.testedBy, undefined);
    const lookedUp = lookupNode('w', cached, (node) => node);
    assert.equal(lookedUp.status, 'ok');
    assert.deepEqual(lookedUp.status === 'ok' ? lookedUp.node.testedBy : undefined, expectedTestedBy);
  });

  it('P4-2 phase 3a: Module Nodes leave the map, its edges and blast radius; lookup_node resolves them as folded', { timeout: 20_000 }, async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    const map = await fetchMap();
    assert.deepEqual((map.nodes ?? []).map((node) => node.id), ['w', 'a', 'd', 'x']);
    assert.ok(!(map.edges ?? []).some((edge) => edge.source.startsWith('mod:') || edge.target.startsWith('mod:')));
    // a: called by w, calls d. Both Modules' calls into it no longer count.
    const mapNode = (id: string) => map.nodes?.find((node) => node.id === id);
    const blast = (id: string) => mapNode(id)?.riskSignals?.find((signal) => signal.type === 'blast-radius')?.value;
    assert.equal(blast('a'), 2);
    // Every Node in web/a.ts carries web/a.ts's top-level uses; others none.
    assert.deepEqual(mapNode('w')?.fileTopLevel, [
      { id: 'a', kind: 'CALLS' },
      { id: 'd', kind: 'USAGE' },
    ]);
    assert.equal(mapNode('a')?.fileTopLevel, undefined);
    // The reverse link: a is called only by top-level code (and w).
    assert.deepEqual(mapNode('a')?.calledAtLoadBy, ['lib/boot.ts', 'web/a.ts']);
    assert.deepEqual(mapNode('d')?.calledAtLoadBy, ['web/a.ts']);
    assert.equal(mapNode('w')?.calledAtLoadBy, undefined);

    const { getNodes, getFolded } = capturedGetters();
    const { lookupNode } = await import('./mcp-server');
    type Args = Parameters<typeof lookupNode>;
    const cached = getNodes() as Args[1];
    const folded = getFolded() as Args[3];
    assert.deepEqual(lookupNode('mod:lib/boot', cached, (node) => node, folded), {
      status: 'folded',
      folded: true,
      nodeId: 'mod:lib/boot',
      file: 'lib/boot.ts',
      uses: [{ id: 'a', kind: 'CALLS' }],
    });
    assert.deepEqual(lookupNode('mod:nope', cached, (node) => node, folded), { status: 'not-found' });
    const a = lookupNode('a', cached, (node) => node, folded);
    assert.deepEqual(a.status === 'ok' ? a.node.calledAtLoadBy : undefined, ['lib/boot.ts', 'web/a.ts']);
  });

  it('P4-2 phase 3a: the registered lookup_node handler resolves a Module id as folded', { timeout: 20_000 }, async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    await fetchMap();
    const { registerLookupNodeTool } = await import('./mcp-server');
    const { getNodes, getFolded } = capturedGetters();
    let handler: ((args: { nodeId: string }) => Promise<{ content: { type: string; text: string }[] }>) | undefined;
    let description = '';
    registerLookupNodeTool(
      {
        registerTool: (name: string, config: { description?: string }, cb: typeof handler) => {
          assert.equal(name, 'lookup_node');
          description = config.description ?? '';
          handler = cb;
        },
      } as unknown as Parameters<typeof registerLookupNodeTool>[0],
      getNodes as Parameters<typeof registerLookupNodeTool>[1],
      (node) => node,
      getFolded as Parameters<typeof registerLookupNodeTool>[3],
    );
    assert.ok(handler);
    const result = JSON.parse((await handler({ nodeId: 'mod:web/a' })).content[0]!.text);
    assert.deepEqual(result, {
      status: 'folded',
      folded: true,
      nodeId: 'mod:web/a',
      file: 'web/a.ts',
      uses: [
        { id: 'a', kind: 'CALLS' },
        { id: 'd', kind: 'USAGE' },
      ],
    });
    assert.match(description, /check status === 'folded'; folded: true is also set/);
    assert.match(description, /calledAtLoadBy/);
  });

  it('P4-2 phase 3a: folded links name only Nodes inside the indexing scope', { timeout: 20_000 }, async () => {
    // web/a.ts's top level uses a (app/) and d (docs/): both out of scope.
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web'] });
    const map = await fetchMap();
    assert.deepEqual((map.nodes ?? []).map((node) => node.id), ['w']);
    assert.equal(map.nodes?.[0]?.fileTopLevel, undefined, 'no out-of-scope id in fileTopLevel');
    const { getNodes, getFolded } = capturedGetters();
    const { lookupNode } = await import('./mcp-server');
    type Args = Parameters<typeof lookupNode>;
    const look = (id: string) => lookupNode(id, getNodes() as Args[1], (node) => node, getFolded() as Args[3]);
    assert.deepEqual(look('mod:web/a'), { status: 'folded', folded: true, nodeId: 'mod:web/a', file: 'web/a.ts', uses: [] });
    // lib/boot.ts is out of scope: its Module is gone too.
    assert.deepEqual(look('mod:lib/boot'), { status: 'not-found' });

    // In scope ['web', 'app']: a survives, so it's named; d (docs/) is not.
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web', 'app'] });
    const wider = await fetchMap();
    assert.deepEqual(wider.nodes?.find((node) => node.id === 'w')?.fileTopLevel, [{ id: 'a', kind: 'CALLS' }]);
    // a's load-time caller in lib/boot.ts is out of scope; web/a.ts is not.
    assert.deepEqual(wider.nodes?.find((node) => node.id === 'a')?.calledAtLoadBy, ['web/a.ts']);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    await fetchMap();
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

  // Last: it indexes its own temp repo, which becomes the active project.
  it('P4-2 phase 3a: a diff touching only top-level code is named, not counted as a changed Node', { timeout: 30_000 }, async (t) => {
    if (spawnSync('git', ['--version']).status !== 0) {
      t.skip('git is not installed; the diff-scope check needs a real repository.');
      return;
    }
    const repo = mkdtempSync(path.join(os.tmpdir(), 'driller-scope-git-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
          cwd: repo,
          stdio: 'pipe',
        });
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(repo, 'README.md'), 'x\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'feature');
      mkdirSync(path.join(repo, 'lib'), { recursive: true });
      writeFileSync(path.join(repo, 'lib/boot.ts'), 'a();\n');
      git('add', '.');
      git('commit', '-q', '-m', 'top-level only');

      await index(repo);
      await fetchMap();
      const { computeDiffScopeResult } = await import('./index');
      const onlyTopLevel = await computeDiffScopeResult(repo, 'main');
      assert.equal(onlyTopLevel.status, 'resolved');
      assert.deepEqual(onlyTopLevel.status === 'resolved' ? onlyTopLevel.nodeIds : undefined, []);
      assert.deepEqual(onlyTopLevel.status === 'resolved' ? onlyTopLevel.topLevelFiles : undefined, [
        { file: 'lib/boot.ts', startLine: 1, endLine: 2 },
      ]);

      // With a map Node's file changed too, that Node counts; its file's
      // Module does not, and web/a.ts is not "top-level only".
      mkdirSync(path.join(repo, 'web'), { recursive: true });
      writeFileSync(path.join(repo, 'web/a.ts'), 'w();\n');
      git('add', '.');
      git('commit', '-q', '-m', 'function change');
      const mixed = await computeDiffScopeResult(repo, 'main');
      assert.deepEqual(mixed, {
        status: 'resolved',
        resolvedBaseRef: mixed.status === 'resolved' ? mixed.resolvedBaseRef : '',
        nodeIds: ['w'],
        topLevelFiles: [{ file: 'lib/boot.ts', startLine: 1, endLine: 2 }],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
