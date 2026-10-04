/**
 * P4-4 phase 2b: agent parity — the optional `section` on the MCP tools
 * `lookup_node`, `trace_path`, `expand_blast_radius` and
 * `compute_diff_scope`, through their real registered handlers (captured
 * from `register*Tool`, the listener is never bound) over the real `index.ts`
 * (`scoped-code-map-harness.ts`) and `scoped-code-map-fixture.ts`.
 *
 * Pins, per the spec's I/O matrix and acceptance criteria:
 *  - without `section`, every tool's text is byte-identical to what the
 *    1.6.0 handler produced (the same compute call, unsectioned), and the
 *    section build is never read nor its memo filled;
 *  - `lookup_node` with `section: 'api'` returns the renderer's
 *    `getCodeMap('api')` Node after `deriveLiveNode` — riskSignals and
 *    severities included (s2's hotspot is severe in api, moderate across the
 *    whole scope) — and folded Modules / types scoped the same way;
 *  - an id in another section is `not-in-section` naming its section (nested
 *    entries included), never `not-found`; an unknown section is
 *    `unknown-section` from every tool; `''` is invalid input;
 *  - the section build is memoized per section and raw cache, and dropped
 *    when the raw cache is replaced (refetch) or cleared (re-index);
 *  - `trace_path` in a section never leaves it; `expand_blast_radius` and
 *    `compute_diff_scope` pass the section through (diff scope equals the IPC
 *    result for `api`).
 *
 * Nothing on `index.ts`'s import graph is imported statically here (only
 * types and side-effect-free modules): the harness's module hooks must be
 * registered before `production-code-map.ts` first loads.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { CodeMapNode } from '@driller/ipc-contracts';

import { isFileInScope, sectionOfFile } from './project-scope';
import { FIXTURE_LCOV, FIXTURE_RECORDS } from './scoped-code-map-fixture';
import { getters, index, makeFixtureProject, posted, removeHarnessTempDirs, send, startIndexTs, waitFor, type Posted } from './scoped-code-map-harness';

const PROJECT = makeFixtureProject();
const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;

let indexModule: typeof import('./index') | undefined;
let mcp: typeof import('./mcp-server') | undefined;

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
interface Registered {
  config: { description?: string; inputSchema?: { safeParse: (value: unknown) => { success: boolean } } };
  handler: ToolHandler;
}

const lines = (count: number): string[] => Array.from({ length: count }, (_, i) => `// line ${i + 1}`);
const write = (file: string, content: string[]): void => {
  mkdirSync(path.join(PROJECT, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(PROJECT, file), `${content.join('\n')}\n`);
};

/** `main`, then a `feature` commit changing one map Node file on each side (`web/a.ts`, `api/server.ts`). */
function makeGitRepo(): void {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: PROJECT,
      stdio: 'pipe',
    });
  for (const file of ['web/a.ts', 'api/server.ts']) {
    write(file, lines(20));
  }
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  for (const file of ['web/a.ts', 'api/server.ts']) {
    const content = lines(20);
    content[1] = '// edited line 2';
    write(file, content);
  }
  git('commit', '-q', '-am', 'both sides');
}

function setScope(scope: readonly string[]): void {
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
}

const REPLY_TYPES = ['graphService:codeMap', 'graphService:codeMapUnknownSection', 'graphService:codeMapError'];

/** Posts `getCodeMap` (with `section` when given), waits for the reply and the cache kicks. */
async function requestMap(section?: string): Promise<Posted> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap', ...(section === undefined ? {} : { section }) });
  const reply = await waitFor(() => posted.slice(from).find((m) => REPLY_TYPES.includes(m.type ?? '')), 'a Code Map reply');
  assert.equal(reply.type, 'graphService:codeMap', reply.message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return reply;
}

let sectionReads: string[] = [];

/**
 * The four tools' real registered handlers, wired to `index.ts`'s live
 * getters exactly as `startMcpServer` wires them. Every read of the section
 * build is recorded in `sectionReads`.
 */
function registerTools(): Map<string, Registered> {
  assert.ok(mcp);
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: ToolHandler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as Parameters<typeof mcp.registerTracePathTool>[0];
  const captured = getters();
  assert.equal(typeof captured.getSectionCodeMap, 'function', 'index.ts hands startMcpServer its section-build getter');
  type LookupParams = Parameters<typeof mcp.registerLookupNodeTool>;
  mcp.registerLookupNodeTool(
    server,
    captured.getNodes as LookupParams[1],
    captured.derive as LookupParams[2],
    captured.getFolded as LookupParams[3],
    captured.getFoldedTypes as LookupParams[4],
    (section) => {
      sectionReads.push(section);
      return (captured.getSectionCodeMap as LookupParams[5])(section);
    },
  );
  mcp.registerTracePathTool(server);
  mcp.registerExpandBlastRadiusTool(server);
  mcp.registerComputeDiffScopeTool(server);
  return tools;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = registerTools().get(name);
  assert.ok(tool, name);
  const result = await tool.handler(args);
  assert.equal(result.content.length, 1);
  return result.content[0]!.text;
}

const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  JSON.parse(await callText(name, args)) as Record<string, unknown>;

/** The 1.6.0 `lookup_node` handler body, verbatim, over the same live getters. */
function lookupAsOf160(nodeId: string): string {
  assert.ok(mcp);
  const captured = getters();
  return JSON.stringify(
    mcp.lookupNode(
      nodeId,
      captured.getNodes() as CodeMapNode[] | undefined,
      captured.derive as (node: CodeMapNode) => CodeMapNode,
      (captured.getFolded() as never) ?? [],
      (captured.getFoldedTypes() as never) ?? [],
    ),
  );
}

const severityOf = (node: { riskSignals: { family: string; type?: string; severity?: string }[] }, type: string) =>
  node.riskSignals.find((signal) => signal.family === 'deterministic' && signal.type === type)?.severity;

/** Every fetched id's file (map Nodes, folded types and Modules). */
function fileById(): Map<string, string> {
  assert.ok(indexModule);
  const active = indexModule.getActiveRawCodeMap();
  assert.ok(active);
  return new Map([...active.raw.fetched.nodes, ...active.raw.fetched.foldedTypes].map((node) => [node.id, node.file]));
}

const IDS = ['w1', 'w3', 's1', 's2', 'aw1', 'p1', 'A', 'T', 'AW', 'mod:web/a', 'mod:lib/boot', 'mod:api/types', 't1', 'nope'];

after(removeHarnessTempDirs);

before(async () => {
  if (GIT_AVAILABLE) {
    makeGitRepo();
  }
  indexModule = await startIndexTs(PROJECT);
  mcp = await import('./mcp-server');
  // The record store is the real one, switched to PROJECT by the index:
  // summaries, a stale one, an LLM judgment and an ingested finding.
  const { mergeNodeRecord } = await import('./node-record-store');
  for (const [id, record] of Object.entries(FIXTURE_RECORDS)) {
    mergeNodeRecord(id, record);
  }
});

describe('P4-4 phase 2b: MCP without section is unchanged', () => {
  it('lookup_node: byte-identical to the 1.6.0 handler, and never reads the section build', { timeout: 20_000 }, async () => {
    for (const scope of [[], ['web', 'api'], ['apps', 'apps/web']]) {
      setScope(scope);
      await requestMap();
      sectionReads = [];
      for (const id of IDS) {
        assert.equal(await callText('lookup_node', { nodeId: id }), lookupAsOf160(id), `${id} in ${scope.join(',')}`);
      }
      assert.deepEqual(sectionReads, [], 'no section build read without section');
      assert.ok(indexModule);
      assert.equal(indexModule.peekSectionCodeMapMemoForTests(), undefined, 'the memo is never filled without section');
    }
  });

  it('trace_path and expand_blast_radius: byte-identical to the unsectioned compute call', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    for (const scope of [[], ['web', 'api']]) {
      setScope(scope);
      await requestMap();
      for (const query of ['w1', 's1', 'aw1', 'Unused', 'nope']) {
        assert.equal(
          await callText('trace_path', { query }),
          JSON.stringify(await indexModule.computePathTraceResult(query)),
          `${query} in ${scope.join(',')}`,
        );
      }
      for (const nodeIds of [['s1', 'w1'], ['p1'], []]) {
        assert.equal(
          await callText('expand_blast_radius', { projectPath: PROJECT, nodeIds }),
          JSON.stringify(indexModule.computeBlastRadiusExpansionResult(PROJECT, nodeIds)),
        );
      }
    }
  });

  it('compute_diff_scope: byte-identical to the unsectioned compute call', { skip: !GIT_AVAILABLE && 'git is not installed', timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    // Review round 1: every scope the other tools are pinned on.
    for (const [scope, changed] of [
      [[], ['s1', 's2', 'w1', 'w2']],
      [['web', 'api'], ['s1', 's2', 'w1', 'w2']],
      [['apps', 'apps/web'], []],
    ] as const) {
      setScope(scope);
      await requestMap();
      for (const baseRef of ['main', '  main  ']) {
        const text = await callText('compute_diff_scope', { projectPath: PROJECT, baseRef });
        assert.equal(text, JSON.stringify(await indexModule.computeDiffScopeResult(PROJECT, 'main')), scope.join(','));
        assert.deepEqual((JSON.parse(text) as { nodeIds: string[] }).nodeIds.sort(), [...changed], scope.join(','));
      }
    }
  });

  it('the version is 1.9.0 (P4-7c), and the descriptions state the section rules', () => {
    assert.ok(mcp);
    assert.equal(mcp.MCP_SERVER_VERSION, '1.9.0');
    const tools = registerTools();
    for (const name of ['lookup_node', 'trace_path', 'expand_blast_radius', 'compute_diff_scope']) {
      const description = tools.get(name)?.config.description ?? '';
      assert.match(description, /nearest \(longest\) allowlist entry/, name);
      assert.match(description, /'apps' section never holds apps\/web\/\*\*/, name);
      assert.match(description, /unknown-section/, name);
    }
    assert.match(tools.get('lookup_node')!.config.description!, /every deterministic signal's severity and the blast-radius count are computed over that section alone/);
    assert.match(tools.get('lookup_node')!.config.description!, /'llm-judgment' and 'ingested' signals and the summary come from driller's stored records and are the same with or without a section/);
    assert.match(tools.get('lookup_node')!.config.description!, /not-in-section/);
    assert.match(tools.get('trace_path')!.config.description!, /it never crosses into another section/);
    assert.match(tools.get('expand_blast_radius')!.config.description!, /walked over that section's Nodes and the edges between them alone/);
    // P4-4 phase 3a: the cross-section fields.
    assert.match(tools.get('lookup_node')!.config.description!, /'crossSectionCalls'.*capped at 20 with 'crossSectionCallsTotal'/);
    assert.match(tools.get('lookup_node')!.config.description!, /always absent without 'section'/);
    assert.match(tools.get('compute_diff_scope')!.config.description!, /'changedInOtherSections' counts them: \[\{section, changedNodes, changedContracts, topLevelFiles\}\]/);
    assert.match(tools.get('compute_diff_scope')!.config.description!, /always absent without 'section'/);
    assert.doesNotMatch(tools.get('compute_diff_scope')!.config.description!, /changes in other sections are not reported/);
    assert.match(tools.get('compute_diff_scope')!.config.description!, /SAME git repository/);
  });
});

describe('P4-4 phase 2b: lookup_node with a section', () => {
  it("section api: the renderer's getCodeMap('api') Node, after deriveLiveNode, with the section's own severities", { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const reply = await requestMap('api');
    const replyNodes = reply.nodes as CodeMapNode[];
    assert.ok(replyNodes.length > 0);
    const derive = getters().derive as (node: CodeMapNode) => CodeMapNode;
    for (const node of replyNodes) {
      const viaTool = await call('lookup_node', { nodeId: node.id, section: 'api' });
      assert.equal(viaTool.status, 'ok', node.id);
      assert.deepEqual(viaTool.node, JSON.parse(JSON.stringify(derive(node))), node.id);
    }
    // s2's hotspot is severe within api, moderate across web + api.
    const inApi = (await call('lookup_node', { nodeId: 's2', section: 'api' })).node as CodeMapNode;
    const whole = (await call('lookup_node', { nodeId: 's2' })).node as CodeMapNode;
    assert.equal(severityOf(inApi, 'hotspot'), 'severe');
    assert.equal(severityOf(whole, 'hotspot'), 'moderate');
    // The summary state is the record store's (s2's summary is stale).
    assert.deepEqual([inApi.summaryStatus, inApi.stale], ['ready', true]);
  });

  it('review round 1: a memoized build still serves live records (summary and judgment)', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api']);
    await requestMap();
    const before = (await call('lookup_node', { nodeId: 's1', section: 'api' })).node as CodeMapNode;
    assert.ok(indexModule.peekSectionCodeMapMemoForTests()?.has('api'), 'the build is memoized');
    assert.equal(before.summary, 'Starts the API server.');
    assert.ok(!before.riskSignals.some((signal) => signal.family === 'llm-judgment'));
    const { getNodeRecord, mergeNodeRecord } = await import('./node-record-store');
    const original = getNodeRecord('s1');
    const at = '2026-10-03T00:00:00.000Z';
    try {
      mergeNodeRecord('s1', {
        summary: { text: 'Serves the API (regenerated).', model: 'fixture-model', generatedAt: at },
        llmJudgment: { text: 'Mixes routing and startup.', model: 'fixture-model', generatedAt: at },
      });
      const memo = indexModule.peekSectionCodeMapMemoForTests()?.get('api');
      const after = (await call('lookup_node', { nodeId: 's1', section: 'api' })).node as CodeMapNode;
      assert.equal(indexModule.peekSectionCodeMapMemoForTests()?.get('api'), memo, 'answered from the same memoized build');
      assert.equal(after.summary, 'Serves the API (regenerated).');
      assert.ok(
        after.riskSignals.some((signal) => signal.family === 'llm-judgment' && JSON.stringify(signal).includes('Mixes routing and startup.')),
        JSON.stringify(after.riskSignals),
      );
    } finally {
      mergeNodeRecord('s1', { summary: original?.summary, llmJudgment: undefined });
    }
  });

  it('review round 1: an owner equal to the requested section is not-found, never a self-contradicting not-in-section', () => {
    assert.ok(mcp);
    const node = { id: 'n', name: 'n', file: 'api/x.ts', startLine: 1, endLine: 2, kind: 'Function', summaryStatus: 'pending', riskSignals: [] } as CodeMapNode;
    const inconsistent: import('./mcp-server').SectionCodeMapLookup = {
      status: 'section',
      nodes: [],
      foldedModules: [],
      foldedTypes: [],
      appliedScope: ['web', 'api'],
    };
    const whole = { nodes: [node], foldedModules: [], foldedTypes: [] };
    assert.deepEqual(mcp.lookupNodeInSection('n', 'api', { ...inconsistent }, (n) => n, whole), { status: 'not-found' });
    assert.deepEqual(mcp.lookupNodeInSection('n', 'web', { ...inconsistent }, (n) => n, whole), {
      status: 'not-in-section',
      nodeId: 'n',
      section: 'web',
      nodeSection: 'api',
    });
  });

  it('folded Modules and types are the section build’s: links name only ids inside the section', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    // T (web/types.ts) is used by w1 (web) and s2 (api).
    const wholeT = await call('lookup_node', { nodeId: 'T' });
    const webT = await call('lookup_node', { nodeId: 'T', section: 'web' });
    assert.deepEqual(wholeT.usedBy, ['s2', 'w1']);
    assert.deepEqual({ status: webT.status, usedBy: webT.usedBy, usedByTotal: webT.usedByTotal }, { status: 'folded', usedBy: ['w1'], usedByTotal: 1 });
    // mod:web/a calls w3 (web) and uses s1 (api).
    const wholeMod = await call('lookup_node', { nodeId: 'mod:web/a' });
    const webMod = await call('lookup_node', { nodeId: 'mod:web/a', section: 'web' });
    assert.deepEqual((wholeMod.uses as { id: string }[]).map((use) => use.id).sort(), ['s1', 'w3']);
    assert.deepEqual((webMod.uses as { id: string }[]).map((use) => use.id), ['w3']);
    // A (api/types.ts) in its own section.
    assert.equal((await call('lookup_node', { nodeId: 'A', section: 'api' })).status, 'folded');
  });

  it('an id in another section is not-in-section naming its section, never not-found', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    for (const [id, nodeSection] of [
      ['w1', 'web'],
      ['T', 'web'],
      ['mod:web/a', 'web'],
    ] as const) {
      assert.deepEqual(await call('lookup_node', { nodeId: id, section: 'api' }), {
        status: 'not-in-section',
        nodeId: id,
        section: 'api',
        nodeSection,
      });
    }
    assert.deepEqual(await call('lookup_node', { nodeId: 's1', section: 'web' }), {
      status: 'not-in-section',
      nodeId: 's1',
      section: 'web',
      nodeSection: 'api',
    });
    // Not in the whole scope at all: still not-found.
    for (const id of ['nope', 'mod:lib/boot', 't1', 'x1']) {
      assert.deepEqual(await call('lookup_node', { nodeId: id, section: 'api' }), { status: 'not-found' }, id);
    }
  });

  it('nested: an apps/web Node looked up in apps is not-in-section, nodeSection apps/web', { timeout: 20_000 }, async () => {
    setScope(['apps', 'apps/web']);
    await requestMap();
    for (const id of ['aw1', 'AW', 'mod:apps/web/a']) {
      assert.deepEqual(await call('lookup_node', { nodeId: id, section: 'apps' }), {
        status: 'not-in-section',
        nodeId: id,
        section: 'apps',
        nodeSection: 'apps/web',
      });
    }
    assert.equal((await call('lookup_node', { nodeId: 'p1', section: 'apps' })).status, 'ok');
    assert.equal((await call('lookup_node', { nodeId: 'aw1', section: 'apps/web' })).status, 'ok');
  });

  it('unknown section, the refreshing window, and an empty section', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    for (const section of ['docs', 'all', 'api/']) {
      assert.deepEqual(await call('lookup_node', { nodeId: 's1', section }), {
        status: 'unknown-section',
        section,
        knownSections: ['web', 'api'],
      });
    }
    // A nested entry is saved; no refetch yet. Ownership still follows the
    // cached map; the new entry is the explicit "refreshing" error.
    setScope(['web', 'api', 'api/server.ts']);
    assert.equal((await call('lookup_node', { nodeId: 's1', section: 'api' })).status, 'ok');
    assert.ok(indexModule);
    assert.deepEqual(await call('lookup_node', { nodeId: 's1', section: 'api/server.ts' }), { ...indexModule.MAP_REFRESHING_RESULT });
    await requestMap();
    assert.deepEqual(await call('lookup_node', { nodeId: 's1', section: 'api' }), {
      status: 'not-in-section',
      nodeId: 's1',
      section: 'api',
      nodeSection: 'api/server.ts',
    });
    setScope(['web', 'api']);
    await requestMap();
    // '' is invalid input on every tool (main's rule), never unknown-section.
    const tools = registerTools();
    for (const [name, base] of [
      ['lookup_node', { nodeId: 's1' }],
      ['trace_path', { query: 's1' }],
      ['expand_blast_radius', { projectPath: PROJECT, nodeIds: ['s1'] }],
      ['compute_diff_scope', { projectPath: PROJECT }],
    ] as const) {
      const schema = tools.get(name)?.config.inputSchema;
      assert.ok(schema, name);
      assert.equal(schema.safeParse({ ...base, section: '' }).success, false, `${name}: '' is rejected`);
      assert.equal(schema.safeParse({ ...base, section: 'api' }).success, true, name);
      assert.equal(schema.safeParse(base).success, true, `${name}: section is optional`);
    }
  });
});

describe('P4-4 phase 2b: the section build memo', () => {
  it('memoized per section and raw cache; dropped on a refetch and on a re-index', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const compute = indexModule;
    setScope(['web', 'api']);
    await requestMap();
    assert.equal(compute.peekSectionCodeMapMemoForTests(), undefined);
    const first = compute.getSectionCodeMap('api');
    assert.equal(compute.getSectionCodeMap('api'), first, 'the second read is the memo');
    assert.notEqual(compute.getSectionCodeMap('web'), first);
    assert.deepEqual([...(compute.peekSectionCodeMapMemoForTests()?.keys() ?? [])], ['api', 'web']);
    const coverageOf = async () =>
      ((await call('lookup_node', { nodeId: 's1', section: 'api' })).node as CodeMapNode).testCoverageAvailable;
    assert.equal(await coverageOf(), true, 'LCOV lists api/server.ts');

    // The raw cache is replaced by a refetch without the LCOV report: the
    // memo goes with it, and the next section lookup rebuilds.
    const lcov = path.join(PROJECT, 'coverage', 'lcov.info');
    rmSync(lcov);
    try {
      await requestMap();
      assert.equal(compute.peekSectionCodeMapMemoForTests(), undefined, 'dropped with the replaced raw cache');
      assert.notEqual(compute.getSectionCodeMap('api'), first);
      assert.equal(await coverageOf(), undefined, 'never a stale memo');
    } finally {
      writeFileSync(lcov, FIXTURE_LCOV);
    }
    await requestMap();
    assert.equal(await coverageOf(), true);

    // A re-index clears the raw cache, and the memo with it.
    assert.ok(compute.peekSectionCodeMapMemoForTests()?.has('api'));
    await index(PROJECT);
    assert.equal(compute.peekSectionCodeMapMemoForTests(), undefined, 'dropped with the cleared raw cache');
    assert.deepEqual(compute.getSectionCodeMap('api'), { status: 'error', message: 'No project has finished indexing yet.' });
    // An index without a scope resets the allowlist; restore it and refetch.
    setScope(['web', 'api']);
    await requestMap();
    assert.equal(await coverageOf(), true);
  });
});

describe('P4-4 phase 2b: the operation tools with a section', () => {
  it('trace_path: every path Node lies in the section; unknown is explicit', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api']);
    await requestMap();
    const files = fileById();
    const whole = await call('trace_path', { query: 'w1' });
    assert.ok((whole.path as string[]).includes('s1'), 'the whole scope crosses into api');
    for (const [query, section] of [
      ['w1', 'web'],
      ['s1', 'api'],
    ] as const) {
      const text = await callText('trace_path', { query, section });
      assert.equal(text, JSON.stringify(await indexModule.computePathTraceResult(query, section)));
      const result = JSON.parse(text) as { status: string; path: string[] };
      assert.equal(result.status, 'found');
      assert.ok(result.path.every((id) => isFileInScope(files.get(id)!, [section])), `${section}: ${result.path.join(',')}`);
    }
    assert.deepEqual(await call('trace_path', { query: 'w1', section: 'api' }), { status: 'no-path-found' });
    assert.deepEqual(await call('trace_path', { query: 's1', section: 'docs' }), {
      status: 'unknown-section',
      section: 'docs',
      knownSections: ['web', 'api'],
    });
    // Nested: a trace in apps never reaches apps/web.
    setScope(['apps', 'apps/web']);
    await requestMap();
    const apps = (await call('trace_path', { query: 'p1', section: 'apps' })) as { path: string[] };
    assert.ok(apps.path.every((id) => sectionOfFile(files.get(id)!, ['apps', 'apps/web']) === 'apps'));
  });

  it('expand_blast_radius: hop distances over the section alone', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    assert.deepEqual(await call('expand_blast_radius', { projectPath: PROJECT, nodeIds: ['s1', 'w1'], section: 'api' }), {
      status: 'resolved',
      hopDistances: { s2: 1, s3: 2 },
    });
    assert.deepEqual(await call('expand_blast_radius', { projectPath: PROJECT, nodeIds: ['s1'], section: 'docs' }), {
      status: 'unknown-section',
      section: 'docs',
      knownSections: ['web', 'api'],
    });
  });

  it("compute_diff_scope: equals the IPC result for api", { skip: !GIT_AVAILABLE && 'git is not installed', timeout: 30_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const viaTool = await call('compute_diff_scope', { projectPath: PROJECT, baseRef: 'main', section: 'api' });
    const from = posted.length;
    send({ type: 'graphService:computeDiffScope', requestId: 81_001, projectPath: PROJECT, baseRef: 'main', section: 'api' });
    const reply = await waitFor(
      () => posted.slice(from).find((m) => m.type === 'graphService:computeDiffScopeResult' && m.requestId === 81_001),
      'a diff-scope reply',
    );
    assert.deepEqual(viaTool, JSON.parse(JSON.stringify(reply.result)));
    assert.deepEqual(viaTool.nodeIds, ['s1', 's2']);
    assert.deepEqual(await call('compute_diff_scope', { projectPath: PROJECT, baseRef: 'main', section: 'docs' }), {
      status: 'unknown-section',
      section: 'docs',
      knownSections: ['web', 'api'],
    });
  });
});
