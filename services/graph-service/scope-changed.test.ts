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
      // P4-2 phase 3c: web/types.ts's top-level code, beside its types.
      { ...node('mod:web/types', 'web/types.ts'), kind: 'Module', startLine: 1, endLine: 12 },
      // P4-2 phase 3b: Type/Interface Nodes, folded off the map.
      { ...node('T', 'web/types.ts'), kind: 'Interface', startLine: 3, endLine: 9 },
      { ...node('T2', 'web/types.ts'), kind: 'Interface' },
      { ...node('U', 'docs/types.ts'), kind: 'Type' },
      { ...node('Unused', 'app/types.ts'), kind: 'Type' },
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
      // P4-2 phase 3b: w and a use T; d and w use U. A CALLS into a type, a
      // Module's use of one and a test Node's use of one never count as uses.
      { source: 'w', target: 'T', kind: 'USAGE' },
      { source: 'a', target: 'T', kind: 'USAGE' },
      { source: 'd', target: 'U', kind: 'USAGE' },
      { source: 'w', target: 'U', kind: 'USAGE' },
      { source: 'x', target: 'T', kind: 'CALLS' },
      { source: 'mod:web/a', target: 'T', kind: 'USAGE' },
      { source: 't', target: 'T', kind: 'USAGE' },
      // Type → type: T2 refers to U.
      { source: 'T2', target: 'U', kind: 'USAGE' },
    ],
    implementsLinks: [{ source: 'T2', target: 'T' }],
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
  'export function startMcpServer(getNodes, _post, _derive, getFolded, getFoldedTypes) { globalThis.__scopeTestGetNodes = getNodes; globalThis.__scopeTestGetFolded = getFolded; globalThis.__scopeTestGetFoldedTypes = getFoldedTypes; return async () => {}; }',
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
    fileTopLevelTypes?: unknown;
    usesTypes?: unknown;
    riskSignals?: { type?: string; value?: number }[];
  }[];
  edges?: { source: string; target: string }[];
  message?: string;
  hiddenByScope?: number;
  appliedScope?: string[];
  foldedModules?: { file: string; moduleIds: string[] }[];
  foldedTypes?: {
    id: string;
    usedBy: string[];
    usedByTotal: number;
    implements: string[];
    implementedBy: string[];
    refersTo: string[];
    referencedByTypes: string[];
  }[];
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
function capturedGetters(): { getNodes: () => unknown; getFolded: () => unknown; getFoldedTypes: () => unknown } {
  const captured = globalThis as {
    __scopeTestGetNodes?: () => unknown;
    __scopeTestGetFolded?: () => unknown;
    __scopeTestGetFoldedTypes?: () => unknown;
  };
  assert.ok(captured.__scopeTestGetNodes && captured.__scopeTestGetFolded && captured.__scopeTestGetFoldedTypes);
  return {
    getNodes: captured.__scopeTestGetNodes,
    getFolded: captured.__scopeTestGetFolded,
    getFoldedTypes: captured.__scopeTestGetFoldedTypes,
  };
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
    delete (globalThis as { __scopeTestGetFoldedTypes?: unknown }).__scopeTestGetFoldedTypes;
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
      kind: 'Module',
      nodeId: 'mod:lib/boot',
      file: 'lib/boot.ts',
      uses: [{ id: 'a', kind: 'CALLS' }],
      usesTypes: [],
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
      () => [
        {
          id: 'T',
          name: 'T',
          kind: 'Interface',
          file: 'web/types.ts',
          startLine: 1,
          endLine: 2,
          usedBy: [],
          usedByTotal: 0,
          usedByKinds: [],
          implements: [],
          implementedBy: [],
          refersTo: [],
          referencedByTypes: [],
        },
      ],
    );
    assert.ok(handler);
    const result = JSON.parse((await handler({ nodeId: 'mod:web/a' })).content[0]!.text);
    assert.deepEqual(result, {
      status: 'folded',
      folded: true,
      kind: 'Module',
      nodeId: 'mod:web/a',
      file: 'web/a.ts',
      uses: [
        { id: 'a', kind: 'CALLS' },
        { id: 'd', kind: 'USAGE' },
      ],
      // P4-2 phase 3b: its top-level use of T is kept, as a type.
      usesTypes: [{ id: 'T', name: 'T', kind: 'Interface' }],
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
    assert.deepEqual(look('mod:web/a'), {
      status: 'folded',
      folded: true,
      kind: 'Module',
      nodeId: 'mod:web/a',
      file: 'web/a.ts',
      uses: [],
      usesTypes: [{ id: 'T', name: 'T', kind: 'Interface' }],
    });
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

  it('P4-2 phase 3b: Type/Interface Nodes leave the map, its edges and blast radius; each Node lists the types it uses', { timeout: 20_000 }, async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    const map = await fetchMap();
    assert.deepEqual((map.nodes ?? []).map((node) => node.id), ['w', 'a', 'd', 'x']);
    const typeIds = new Set(['T', 'T2', 'U', 'Unused']);
    assert.ok(!(map.edges ?? []).some((edge) => typeIds.has(edge.source) || typeIds.has(edge.target)));
    const mapNode = (id: string) => map.nodes?.find((node) => node.id === id);
    const blast = (id: string) => mapNode(id)?.riskSignals?.find((signal) => signal.type === 'blast-radius')?.value;
    // w reaches a and d (and d via a); T is not counted. x's only edge was a CALLS into T.
    assert.equal(blast('w'), 2);
    assert.equal(blast('x'), 0);
    assert.deepEqual(mapNode('w')?.usesTypes, [
      { id: 'T', name: 'T', kind: 'Interface' },
      { id: 'U', name: 'U', kind: 'Type' },
    ]);
    assert.deepEqual(mapNode('d')?.usesTypes, [{ id: 'U', name: 'U', kind: 'Type' }]);
    // A CALLS into a type is not a use.
    assert.equal(mapNode('x')?.usesTypes, undefined);
    // A Module's use of a type leaves fileTopLevel (map Nodes only) and is
    // kept as the file's top-level type use, on every Node in the file.
    assert.deepEqual(mapNode('w')?.fileTopLevel, [
      { id: 'a', kind: 'CALLS' },
      { id: 'd', kind: 'USAGE' },
    ]);
    assert.deepEqual(mapNode('w')?.fileTopLevelTypes, [{ id: 'T', name: 'T', kind: 'Interface' }]);
    assert.equal(mapNode('a')?.fileTopLevelTypes, undefined);
    assert.deepEqual(
      (map.foldedTypes ?? []).map((type) => [
        type.id,
        type.usedBy,
        type.usedByTotal,
        type.implements,
        type.implementedBy,
        type.refersTo,
        type.referencedByTypes,
      ]),
      [
        ['T', ['a', 'w'], 2, [], ['T2'], [], []],
        ['T2', [], 0, ['T'], [], ['U'], []],
        ['U', ['d', 'w'], 2, [], [], [], ['T2']],
        ['Unused', [], 0, [], [], [], []],
      ],
    );

    const { getNodes, getFolded, getFoldedTypes } = capturedGetters();
    const { lookupNode, registerLookupNodeTool } = await import('./mcp-server');
    type Args = Parameters<typeof lookupNode>;
    assert.deepEqual(lookupNode('T', getNodes() as Args[1], (node) => node, getFolded() as Args[3], getFoldedTypes() as Args[4]), {
      status: 'folded',
      folded: true,
      kind: 'Interface',
      nodeId: 'T',
      name: 'T',
      file: 'web/types.ts',
      startLine: 3,
      endLine: 9,
      usedBy: ['a', 'w'],
      usedByTotal: 2,
      usedByKinds: [{ kind: 'Function', count: 2 }],
      implements: [],
      implementedBy: ['T2'],
      refersTo: [],
      referencedByTypes: [],
    });
    // usedBy is capped at 50, with the full count alongside; a map Node wins over a type with its id.
    const many = Array.from({ length: 60 }, (_, i) => `u${String(i).padStart(2, '0')}`);
    const big = {
      id: 'Big',
      name: 'Big',
      kind: 'Type' as const,
      file: 'b.ts',
      startLine: 1,
      endLine: 2,
      usedBy: many,
      usedByTotal: 60,
      usedByKinds: [{ kind: 'Function' as const, count: 60 }],
      implements: [],
      implementedBy: [],
      refersTo: [],
      referencedByTypes: [],
    };
    const bigResult = lookupNode('Big', [], (node) => node, [], [big]);
    assert.deepEqual(
      bigResult.status === 'folded' && bigResult.kind !== 'Module' ? [bigResult.usedBy, bigResult.usedByTotal] : undefined,
      [many.slice(0, 50), 60],
    );
    assert.equal(lookupNode('w', getNodes() as Args[1], (node) => node, [], [{ ...big, id: 'w' }]).status, 'ok');
    // Through the registered handler, with its live getters.
    let handler: ((args: { nodeId: string }) => Promise<{ content: { type: string; text: string }[] }>) | undefined;
    let description = '';
    registerLookupNodeTool(
      {
        registerTool: (_name: string, config: { description?: string }, cb: typeof handler) => {
          description = config.description ?? '';
          handler = cb;
        },
      } as unknown as Parameters<typeof registerLookupNodeTool>[0],
      getNodes as Parameters<typeof registerLookupNodeTool>[1],
      (node) => node,
      getFolded as Parameters<typeof registerLookupNodeTool>[3],
      getFoldedTypes as Parameters<typeof registerLookupNodeTool>[4],
    );
    assert.ok(handler);
    const viaTool = JSON.parse((await handler({ nodeId: 'T2' })).content[0]!.text);
    assert.equal(viaTool.status, 'folded');
    assert.equal(viaTool.kind, 'Interface');
    assert.deepEqual(viaTool.implements, ['T']);
    assert.deepEqual(viaTool.refersTo, ['U']);
    assert.match(description, /usesTypes/);
    assert.match(description, /never inferred from its signature/);

    // Path Trace is CALLS-only: a type name resolves to no entry.
    const from = posted.length;
    send({ type: 'graphService:pathTrace', query: 'Unused', requestId: 5151 });
    const reply = await waitFor(
      () => posted.slice(from).find((message) => message.type === 'graphService:pathTraceResult' && message.requestId === 5151),
      'a pathTraceResult',
    );
    assert.deepEqual(reply.result, { status: 'no-path-found' });
  });

  it('P4-2 phase 3b: folded types follow the indexing scope, and name only in-scope users', { timeout: 20_000 }, async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web'] });
    const map = await fetchMap();
    // U (docs/) and Unused (app/) are out of scope; T keeps only w, and w no
    // longer lists U among the types it uses.
    assert.deepEqual(map.nodes?.find((node) => node.id === 'w')?.usesTypes, [{ id: 'T', name: 'T', kind: 'Interface' }]);
    // T2's reference to U (docs/) is out of scope too.
    assert.deepEqual(
      (map.foldedTypes ?? []).map((type) => [type.id, type.usedBy, type.refersTo]),
      [
        ['T', ['w'], []],
        ['T2', [], []],
      ],
    );
    const { getNodes, getFolded, getFoldedTypes } = capturedGetters();
    const { lookupNode } = await import('./mcp-server');
    type Args = Parameters<typeof lookupNode>;
    const look = (id: string) =>
      lookupNode(id, getNodes() as Args[1], (node) => node, getFolded() as Args[3], getFoldedTypes() as Args[4]);
    assert.deepEqual(look('U'), { status: 'not-found' });
    const t = look('T');
    assert.deepEqual(t.status === 'folded' && t.kind !== 'Module' ? [t.usedBy, t.usedByTotal] : undefined, [['w'], 1]);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    await fetchMap();
  });

  it('P4-2 phase 3b: a backend switch (and a same-backend re-affirm) keeps the cached folded types and Modules', { timeout: 20_000 }, async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    await fetchMap();
    const { getNodes, getFolded, getFoldedTypes } = capturedGetters();
    const { lookupNode } = await import('./mcp-server');
    type Args = Parameters<typeof lookupNode>;
    const look = (id: string) =>
      lookupNode(id, getNodes() as Args[1], (node) => node, getFolded() as Args[3], getFoldedTypes() as Args[4]);
    const typeIds = () => ((getFoldedTypes() as { id: string }[] | undefined) ?? []).map((type) => type.id);
    const moduleFiles = () => ((getFolded() as { file: string }[] | undefined) ?? []).map((module) => module.file);
    const before = { types: typeIds(), modules: moduleFiles() };
    assert.deepEqual(before.types, ['T', 'T2', 'U', 'Unused']);
    // A genuine switch (local → cloud), then a re-affirm (cloud → cloud), then back.
    for (const activeBackend of ['cloud', 'cloud', 'local']) {
      send({ type: 'graphService:backendSwitched', activeBackend });
      // The handler re-caches synchronously up to its first await; give it a tick or two anyway.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(typeIds(), before.types, `folded types after ${activeBackend}`);
      assert.deepEqual(moduleFiles(), before.modules, `folded Modules after ${activeBackend}`);
      assert.equal(look('T').status, 'folded');
      const t = look('T');
      assert.equal(t.status === 'folded' ? t.kind : undefined, 'Interface');
      const mod = look('mod:web/a');
      assert.equal(mod.status === 'folded' ? mod.kind : undefined, 'Module');
    }
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

  // Also indexes its own temp repo. The stub's T (web/types.ts, lines 3–9)
  // is used by w (web/) and a (app/) through real USAGE edges; its Module and
  // test users never count. web/types.ts also has top-level code: the folded
  // Module mod:web/types (lines 1–12).
  it('P4-2 phase 3c: a diff touching only a type names it as a changed contract with its real dependents', { timeout: 30_000 }, async (t) => {
    if (spawnSync('git', ['--version']).status !== 0) {
      t.skip('git is not installed; the diff-scope check needs a real repository.');
      return;
    }
    const repo = mkdtempSync(path.join(os.tmpdir(), 'driller-contract-git-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
          cwd: repo,
          stdio: 'pipe',
        });
      const lines = Array.from({ length: 12 }, (_, i) => `// line ${i + 1}`);
      const writeTypes = (edit: (copy: string[]) => void) => {
        const copy = [...lines];
        edit(copy);
        mkdirSync(path.join(repo, 'web'), { recursive: true });
        writeFileSync(path.join(repo, 'web/types.ts'), `${copy.join('\n')}\n`);
      };
      /** A branch off main with one edit to web/types.ts, committed. */
      const branch = (name: string, edit: (copy: string[]) => void) => {
        git('checkout', '-q', 'main');
        git('checkout', '-q', '-b', name);
        writeTypes(edit);
        git('commit', '-q', '-am', name);
      };
      const TYPES_MODULE = { file: 'web/types.ts', startLine: 1, endLine: 12 };
      const T_CONTRACT = { id: 'T', name: 'T', kind: 'Interface', file: 'web/types.ts', dependentCount: 2, dependentIds: ['a', 'w'] };
      git('init', '-q', '-b', 'main');
      writeTypes(() => {});
      git('add', '.');
      git('commit', '-q', '-m', 'base');

      await index(repo);
      // The map reply carries the folded Modules too, for the "Show types &
      // modules" canvas toggle.
      const map = await fetchMap();
      assert.deepEqual(
        (map.foldedModules ?? []).map((module) => [module.file, module.moduleIds]),
        [
          ['lib/boot.ts', ['mod:lib/boot']],
          ['web/a.ts', ['mod:web/a']],
          ['web/types.ts', ['mod:web/types']],
        ],
      );
      const { computeDiffScopeResult } = await import('./index');
      const diff = async () => {
        const result = await computeDiffScopeResult(repo, 'main');
        assert.equal(result.status, 'resolved');
        const { resolvedBaseRef: _base, ...rest } = result as Extract<typeof result, { status: 'resolved' }>;
        return rest;
      };

      // Outside every type's lines (T2 is 1–2, T is 3–9): top-level code
      // changed, no contract.
      branch('outside', (copy) => {
        copy[10] = '// edited line 11';
      });
      assert.deepEqual(await diff(), { status: 'resolved', nodeIds: [], topLevelFiles: [TYPES_MODULE] });

      // Wholly inside T: T is a changed contract with dependents w and a only,
      // and the file is not "top-level code changed" although it has a Module.
      branch('inside', (copy) => {
        copy[4] = '  field: number;';
      });
      assert.deepEqual(await diff(), { status: 'resolved', nodeIds: [], changedContracts: [T_CONTRACT] });

      // Spanning T's last line and the top-level line after it: both reported.
      branch('spanning', (copy) => {
        copy[8] = '} // T ends, edited';
        copy[9] = 'boot(); // top-level, edited';
      });
      assert.deepEqual(await diff(), {
        status: 'resolved',
        nodeIds: [],
        topLevelFiles: [TYPES_MODULE],
        changedContracts: [T_CONTRACT],
      });

      // main moves on after the fork with an edit inside T; the feature
      // branch only touched line 11. main's edit is not the PR's: no contract.
      branch('late-base', (copy) => {
        copy[10] = '// feature edit on line 11';
      });
      git('checkout', '-q', 'main');
      writeTypes((copy) => {
        copy[4] = '  mainOnly: string;';
      });
      git('commit', '-q', '-am', 'main edits T after the fork');
      git('checkout', '-q', 'late-base');
      assert.deepEqual(await diff(), { status: 'resolved', nodeIds: [], topLevelFiles: [TYPES_MODULE] });

      // Dependents follow the indexing scope: with only web/ in scope, a (in
      // app/) is gone, and the count says so.
      git('checkout', '-q', 'inside');
      send({ type: 'graphService:scopeChanged', path: repo, includedPaths: ['web'] });
      await fetchMap();
      assert.deepEqual(await diff(), {
        status: 'resolved',
        nodeIds: [],
        changedContracts: [{ ...T_CONTRACT, dependentCount: 1, dependentIds: ['w'] }],
      });
      send({ type: 'graphService:scopeChanged', path: repo, includedPaths: [] });
      await fetchMap();

      // With a function's file changed too: that Node counts as changed, as
      // today, and the contract line stays.
      writeFileSync(path.join(repo, 'web/a.ts'), 'w();\n');
      git('add', '.');
      git('commit', '-q', '-m', 'function change');
      const mixed = await diff();
      assert.deepEqual(
        mixed.status === 'resolved' ? [mixed.nodeIds, mixed.changedContracts?.map((c) => c.id)] : undefined,
        [['w'], ['T']],
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
