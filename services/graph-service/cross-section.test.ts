/**
 * P4-4 phase 3a: the cross-section counts a section drops —
 * `crossSectionEdges` on a section Code Map reply, `crossSectionCalls` on
 * each section Node, `changedInOtherSections` on a section diff-scope result.
 *
 * Pure counters first (`scoped-code-map.ts`), against the spec's I/O matrix;
 * then through the real `index.ts` (`scoped-code-map-harness.ts`) over
 * `scoped-code-map-fixture.ts`, with the fixture project made a git
 * repository whose `feature` branch changes Nodes in several sections:
 *  - Σ `crossSectionEdges` (outgoing + incoming) equals a brute-force count of whole-scope
 *    edges with exactly one end in the section and the other in another
 *    allowlisted section, for every fixture scope and section;
 *  - every field is absent (never `[]`) when empty, and on every whole-scope
 *    reply and result;
 *  - `changedInOtherSections` is counted over the whole-scope Nodes, owned by
 *    the scope the caches were built under (the P4-4e drift window);
 *  - MCP `lookup_node` / `compute_diff_scope` with a `section` carry the same
 *    fields; without one, neither does.
 *
 * Nothing on `index.ts`'s import graph is imported statically here (only
 * types and side-effect-free modules): the harness's module hooks must be
 * registered before `production-code-map.ts` first loads.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  CROSS_SECTION_CALLS_MAX,
  type CodeMapEdge,
  type CodeMapNode,
  type DiffScopeResult,
  type FoldedModule,
  type FoldedType,
} from '@driller/graph-contracts';

import {
  attachCrossSectionCalls,
  countChangedInOtherSections,
  countCrossSectionEdges,
  filterCodeMapToScope,
  keepFileForScope,
  keepFileForSection,
  narrowDiffInputs,
  summarizeDiffChanges,
} from './scoped-code-map';
import { FIXTURE_SCOPES, SCOPED_MAP_FIXTURE } from './scoped-code-map-fixture';
import {
  getters,
  index,
  makeFixtureProject,
  makeTempDir,
  posted,
  removeHarnessTempDirs,
  send,
  startIndexTs,
  waitFor,
  type Posted,
} from './scoped-code-map-harness';

const ROOT = '/project';

const node = (id: string, file: string, name = id): { id: string; name: string; file: string } => ({ id, name, file });
const edge = (source: string, target: string, kind: CodeMapEdge['kind'] = 'CALLS'): CodeMapEdge => ({ source, target, kind });

/** The nearest allowlist entry holding `file`, written independently of `sectionOfFile` (brute force). */
function bruteOwner(file: string, scope: readonly string[]): string | undefined {
  return [...scope]
    .filter((entry) => file === entry || file.startsWith(`${entry}/`))
    .sort((a, b) => b.length - a.length)[0];
}

describe('P4-4 phase 3a: countCrossSectionEdges (pure)', () => {
  const nodes = [
    ...Array.from({ length: 9 }, (_, i) => node(`a${i}`, `api/a${i}.ts`)),
    ...Array.from({ length: 3 }, (_, i) => node(`w${i}`, `web/w${i}.ts`)),
    node('docx', 'docs/x.ts'),
  ];

  it('9 api→web + 3 web→api edges: outgoing 9, incoming 3 (any kind), mirrored from web', () => {
    const edges = [
      ...Array.from({ length: 9 }, (_, i) => edge(`a${i}`, `w${i % 3}`, i % 3 === 0 ? 'IMPORTS' : 'CALLS')),
      ...Array.from({ length: 3 }, (_, i) => edge(`w${i}`, `a${i}`, 'USAGE')),
      edge('a0', 'a1'),
      edge('w0', 'w1'),
    ];
    assert.deepEqual(countCrossSectionEdges(ROOT, nodes, edges, 'api', ['api', 'web']), [{ section: 'web', outgoing: 9, incoming: 3 }]);
    assert.deepEqual(countCrossSectionEdges(ROOT, nodes, edges, 'web', ['api', 'web']), [{ section: 'api', outgoing: 3, incoming: 9 }]);
  });

  it('an edge to a Node outside the allowlist, or to no Node (dangling), is never counted', () => {
    const edges = [edge('a0', 'docx'), edge('docx', 'a1'), edge('a0', 'ghost'), edge('ghost', 'w0'), edge('a0', 'w0')];
    assert.deepEqual(countCrossSectionEdges(ROOT, nodes, edges, 'api', ['api', 'web']), [{ section: 'web', outgoing: 1, incoming: 0 }]);
  });

  it('no cross edges: [] (the caller leaves the field out)', () => {
    assert.deepEqual(countCrossSectionEdges(ROOT, nodes, [edge('a0', 'a1'), edge('w0', 'docx')], 'api', ['api', 'web']), []);
  });

  it('edges between two other sections are not this section\'s', () => {
    assert.deepEqual(countCrossSectionEdges(ROOT, nodes, [edge('w0', 'docx')], 'api', ['api', 'web', 'docs']), []);
  });

  it('nested: apps/a → apps/web/b is cross-section between apps and apps/web', () => {
    const nested = [node('a', 'apps/a.ts'), node('b', 'apps/web/b.ts')];
    assert.deepEqual(countCrossSectionEdges(ROOT, nested, [edge('a', 'b')], 'apps', ['apps', 'apps/web']), [
      { section: 'apps/web', outgoing: 1, incoming: 0 },
    ]);
    assert.deepEqual(countCrossSectionEdges(ROOT, nested, [edge('a', 'b')], 'apps/web', ['apps', 'apps/web']), [
      { section: 'apps', outgoing: 0, incoming: 1 },
    ]);
  });

  it('sorted by outgoing + incoming (highest first), then section', () => {
    const many = [node('a', 'api/a.ts'), node('z', 'zeta/z.ts'), node('b', 'beta/b.ts'), node('c', 'core/c.ts')];
    const edges = [edge('a', 'b'), edge('a', 'z'), edge('z', 'a'), edge('a', 'c')];
    assert.deepEqual(countCrossSectionEdges(ROOT, many, edges, 'api', ['api', 'zeta', 'beta', 'core']), [
      { section: 'zeta', outgoing: 1, incoming: 1 },
      { section: 'beta', outgoing: 1, incoming: 0 },
      { section: 'core', outgoing: 1, incoming: 0 },
    ]);
  });
});

describe('P4-4 phase 3a: attachCrossSectionCalls (pure)', () => {
  const scope = ['api', 'web'];

  it("handleOrder calling web's render is listed with its section", () => {
    const whole = [node('api.handleOrder', 'api/order.ts', 'handleOrder'), node('web.render', 'web/view.ts', 'render')];
    const [handle] = attachCrossSectionCalls(ROOT, [whole[0]!], whole, [edge('api.handleOrder', 'web.render')], 'api', scope);
    assert.deepEqual(handle, {
      ...whole[0],
      crossSectionCalls: [{ id: 'web.render', name: 'render', section: 'web' }],
      crossSectionCallsTotal: 1,
    });
  });

  it('25 callees: the first 20 by section, then name, then id, and a total of 25', () => {
    const callees = Array.from({ length: 25 }, (_, i) =>
      node(`c${i}`, i % 2 === 0 ? `web/c${i}.ts` : `docs/c${i}.ts`, `n${String(24 - i).padStart(2, '0')}`),
    );
    const source = node('s', 'api/s.ts');
    const whole = [source, ...callees];
    const edges = callees.map((callee) => edge('s', callee.id));
    const [attached] = attachCrossSectionCalls(ROOT, [source], whole, edges, 'api', ['api', 'web', 'docs']);
    assert.equal(attached?.crossSectionCallsTotal, 25);
    assert.equal(attached?.crossSectionCalls?.length, CROSS_SECTION_CALLS_MAX);
    const expected = callees
      .map((callee) => ({ id: callee.id, name: callee.name, section: callee.file.split('/')[0]! }))
      .sort((a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .slice(0, CROSS_SECTION_CALLS_MAX);
    assert.deepEqual(attached?.crossSectionCalls, expected);
    assert.equal(expected[0]!.section, 'docs');
  });

  it('only outgoing CALLS into another allowlisted section, one entry per callee', () => {
    const whole = [
      node('a', 'api/a.ts'),
      node('a2', 'api/a2.ts'),
      node('w', 'web/w.ts'),
      node('w2', 'web/w2.ts'),
      node('d', 'docs/d.ts'),
    ];
    const edges = [
      edge('a', 'w'),
      edge('a', 'w'),
      edge('a', 'w2', 'USAGE'),
      edge('a', 'w2', 'IMPORTS'),
      edge('a', 'a2'),
      edge('a', 'd'),
      edge('w', 'a2'),
      edge('a', 'ghost'),
    ];
    const sectionNodes = [whole[0]!, whole[1]!];
    const [a, a2] = attachCrossSectionCalls(ROOT, sectionNodes, whole, edges, 'api', scope);
    assert.deepEqual(a?.crossSectionCalls, [{ id: 'w', name: 'w', section: 'web' }]);
    assert.equal(a?.crossSectionCallsTotal, 1);
    assert.equal(a2, sectionNodes[1], 'a Node with none is the same object');
    assert.ok(!('crossSectionCalls' in a2!) && !('crossSectionCallsTotal' in a2!), 'absent, never []');
  });
});

describe('P4-4 phase 3a: countChangedInOtherSections (pure, founder decision 2026-10-03)', () => {
  const type = (id: string, file: string, startLine: number, endLine: number, usedBy: string[] = []): FoldedType => ({
    id,
    name: id,
    file,
    kind: 'Interface',
    startLine,
    endLine,
    usedBy,
    usedByTotal: usedBy.length,
    usedByKinds: [],
    implements: [],
    implementedBy: [],
    refersTo: [],
    referencedByTypes: [],
  });
  const module = (file: string): FoldedModule => ({ file, moduleIds: [`mod:${file}`], startLine: 1, endLine: 20, uses: [] });
  const inputs = {
    nodes: [
      node('s1', 'api/server.ts'),
      node('s2', 'api/server.ts'),
      node('s3', 'api/db.ts'),
      node('w1', 'web/a.ts'),
      node('u1', 'lib/util.ts'),
      node('aw', 'apps/web/a.ts'),
      node('p', 'apps/b.ts'),
    ],
    foldedTypes: [type('A', 'api/types.ts', 2, 8, ['s1']), type('T', 'web/types.ts', 3, 9, ['w1']), type('L', 'lib/types.ts', 1, 3)],
    foldedModules: [module('api/types.ts'), module('api/boot.ts'), module('lib/boot.ts')],
  };
  const diff = {
    changedFiles: ['api/server.ts', 'api/db.ts', 'api/types.ts', 'api/boot.ts', 'web/a.ts', 'lib/util.ts', 'lib/types.ts', 'lib/boot.ts', 'apps/web/a.ts', 'apps/b.ts'],
    changedLines: {
      'api/types.ts': [{ start: 4, end: 4 }],
      'api/boot.ts': [{ start: 2, end: 2 }],
      'lib/types.ts': [{ start: 2, end: 2 }],
      'lib/boot.ts': [{ start: 2, end: 2 }],
    },
  };
  const all = (): boolean => true;
  const change = (section: string, changedNodes: number, changedContracts: number, topLevelFiles: number) => ({
    section,
    changedNodes,
    changedContracts,
    topLevelFiles,
  });

  it('per other section: changed Nodes, contracts and top-level-only files; never the current section or outside the allowlist', () => {
    assert.deepEqual(countChangedInOtherSections(ROOT, inputs, diff, 'web', ['web', 'api'], all), [change('api', 3, 1, 1)]);
    assert.deepEqual(countChangedInOtherSections(ROOT, inputs, diff, 'api', ['web', 'api'], all), [change('web', 1, 0, 0)]);
  });

  it("each entry equals that section's own summarizeDiffChanges counts", () => {
    const own = summarizeDiffChanges(narrowDiffInputs(ROOT, inputs, keepFileForSection('api', ['web', 'api'])), diff);
    assert.deepEqual(
      countChangedInOtherSections(ROOT, inputs, diff, 'web', ['web', 'api'], all)[0],
      change('api', own.nodeIds.length, own.changedContracts.length, own.topLevelFiles.length),
    );
  });

  it('a section in another repository is omitted', () => {
    assert.deepEqual(countChangedInOtherSections(ROOT, inputs, diff, 'web', ['web', 'api'], (other) => other !== 'api'), []);
    assert.deepEqual(
      countChangedInOtherSections(ROOT, inputs, diff, 'apps', ['apps', 'apps/web', 'api'], (other) => other === 'apps/web'),
      [change('apps/web', 1, 0, 0)],
    );
  });

  it('nested entries; sorted by the sum, then section; [] when nothing else changed', () => {
    assert.deepEqual(countChangedInOtherSections(ROOT, inputs, diff, 'apps', ['apps', 'apps/web', 'api', 'web'], all), [
      change('api', 3, 1, 1),
      change('apps/web', 1, 0, 0),
      change('web', 1, 0, 0),
    ]);
    assert.deepEqual(countChangedInOtherSections(ROOT, inputs, { changedFiles: ['web/a.ts'] }, 'web', ['web', 'api'], all), []);
    // By the sum, not by name: lib (u1, contract L, lib/boot.ts = 3) before apps (p, aw = 2).
    assert.deepEqual(countChangedInOtherSections(ROOT, inputs, diff, 'web', ['web', 'apps', 'lib'], all), [
      change('lib', 1, 1, 1),
      change('apps', 2, 0, 0),
    ]);
  });
});

describe('P4-4 phase 3a: resolveGitToplevel (two repositories under one folder)', { skip: spawnSync('git', ['--version']).status !== 0 && 'git is not installed' }, () => {
  it('sibling repos differ; a file resolves from its folder; no repo or a missing path is undefined', { timeout: 20_000 }, async () => {
    const { resolveGitToplevel } = await import('./git-diff-scope');
    const root = makeTempDir('driller-cross-repos-');
    for (const repo of ['one', 'two']) {
      mkdirSync(path.join(root, repo, 'src'), { recursive: true });
      writeFileSync(path.join(root, repo, 'src', 'x.ts'), '// x\n');
      execFileSync('git', ['init', '-q'], { cwd: path.join(root, repo), stdio: 'pipe' });
    }
    mkdirSync(path.join(root, 'plain'));
    const one = await resolveGitToplevel(path.join(root, 'one', 'src'));
    const two = await resolveGitToplevel(path.join(root, 'two'));
    assert.ok(one !== undefined && two !== undefined);
    assert.notEqual(one, two);
    assert.equal(await resolveGitToplevel(path.join(root, 'one', 'src', 'x.ts')), one);
    assert.equal(await resolveGitToplevel(path.join(root, 'one')), one);
    assert.equal(await resolveGitToplevel(path.join(root, 'plain')), undefined);
    assert.equal(await resolveGitToplevel(path.join(root, 'missing')), undefined);
  });
});

// ---------------------------------------------------------------------------
// Through the real index.ts.
// ---------------------------------------------------------------------------

const PROJECT = makeFixtureProject();
const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;

let indexModule: typeof import('./index') | undefined;
let mcp: typeof import('./mcp-server') | undefined;

const lines = (count: number): string[] => Array.from({ length: count }, (_, i) => `// line ${i + 1}`);
const write = (file: string, content: string[]): void => {
  mkdirSync(path.join(PROJECT, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(PROJECT, file), `${content.join('\n')}\n`);
};

/** The `feature` commit's edits, by file: the 1-based lines it changes. */
const EDITS: Readonly<Record<string, number[]>> = {
  'web/a.ts': [2], // w1, w2
  'api/server.ts': [2], // s1, s2
  'api/db.ts': [2], // s3
  'api/types.ts': [4, 15], // inside A (2–8), and its top-level code (a folded Module, no map Node)
  'lib/util.ts': [2], // u1, in no fixture section
  'lib/boot.ts': [1], // top-level code, in no fixture section
  'apps/b.ts': [2], // p1
  'apps/web/a.ts': [2], // aw1, aw2
  'docs/c.ts': [2], // d1 — `docs/` then becomes its own, nested git repository
};

/**
 * `main`, then a `feature` commit applying `EDITS`. After both commits,
 * `docs/` gets its own `git init`: a nested repository, so `docs` is a
 * section in ANOTHER repository, although the outer diff (run at the project
 * root) still lists `docs/c.ts`.
 */
function makeGitRepo(): void {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: PROJECT,
      stdio: 'pipe',
    });
  for (const file of Object.keys(EDITS)) {
    write(file, lines(20));
  }
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  for (const [file, edited] of Object.entries(EDITS)) {
    const content = lines(20);
    for (const n of edited) {
      content[n - 1] = `// edited line ${n}`;
    }
    write(file, content);
  }
  git('commit', '-q', '-am', 'several sections');
  execFileSync('git', ['init', '-q'], { cwd: path.join(PROJECT, 'docs'), stdio: 'pipe' });
}

function setScope(scope: readonly string[]): void {
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
}

/** Posts `getCodeMap` (with `section` when given), waits for the reply and the cache kicks. */
async function requestMap(section?: string): Promise<Posted> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap', ...(section === undefined ? {} : { section }) });
  const reply = await waitFor(
    () => posted.slice(from).find((m) => m.type === 'graphService:codeMap' || m.type === 'graphService:codeMapError'),
    'a Code Map reply',
  );
  assert.equal(reply.type, 'graphService:codeMap', reply.message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return reply;
}

const nodesOf = (reply: Posted): CodeMapNode[] => reply.nodes as CodeMapNode[];
const hasCrossCalls = (nodes: readonly CodeMapNode[]): boolean =>
  nodes.some((n) => 'crossSectionCalls' in n || 'crossSectionCallsTotal' in n);

/** The whole-scope Nodes and edges the current raw cache maps (before any section filter). */
function wholeScope(): { nodes: { id: string; name: string; file: string }[]; edges: CodeMapEdge[]; scope: readonly string[] } {
  assert.ok(indexModule);
  const active = indexModule.getActiveRawCodeMap();
  assert.ok(active);
  const { nodes, edges } = filterCodeMapToScope(
    active.raw.projectRoot,
    active.raw.fetched.nodes,
    active.raw.fetched.edges,
    keepFileForScope(active.appliedScope),
  );
  return { nodes, edges, scope: active.appliedScope };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

/** `lookup_node` and `compute_diff_scope`'s real registered handlers, wired as `startMcpServer` wires them. */
function tools(): Map<string, ToolHandler> {
  assert.ok(mcp);
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as Parameters<typeof mcp.registerLookupNodeTool>[0];
  const captured = getters();
  type LookupParams = Parameters<typeof mcp.registerLookupNodeTool>;
  mcp.registerLookupNodeTool(
    server,
    captured.getNodes as LookupParams[1],
    captured.derive as LookupParams[2],
    captured.getFolded as LookupParams[3],
    captured.getFoldedTypes as LookupParams[4],
    captured.getSectionCodeMap as LookupParams[5],
  );
  mcp.registerComputeDiffScopeTool(server);
  return handlers;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = tools().get(name);
  assert.ok(handler, name);
  const result = await handler(args);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const resolved = (result: DiffScopeResult): Extract<DiffScopeResult, { status: 'resolved' }> => {
  assert.equal(result.status, 'resolved', JSON.stringify(result));
  return result as Extract<DiffScopeResult, { status: 'resolved' }>;
};

after(removeHarnessTempDirs);

before(async () => {
  if (GIT_AVAILABLE) {
    makeGitRepo();
  }
  indexModule = await startIndexTs(PROJECT);
  mcp = await import('./mcp-server');
});

describe('P4-4 phase 3a: the section Code Map reply through index.ts', () => {
  it("web/api: the web→api edge and w1's callee s1 are counted; the whole-scope reply carries neither field", { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    const whole = await requestMap();
    assert.ok(!('crossSectionEdges' in whole), 'no field without a section');
    assert.ok(!hasCrossCalls(nodesOf(whole)), 'no Node field without a section');

    const web = await requestMap('web');
    assert.deepEqual(web.crossSectionEdges, [{ section: 'api', outgoing: 1, incoming: 0 }]);
    const w1 = nodesOf(web).find((n) => n.id === 'w1');
    assert.deepEqual(w1?.crossSectionCalls, [{ id: 's1', name: 's1', section: 'api' }]);
    assert.equal(w1?.crossSectionCallsTotal, 1);
    assert.deepEqual(
      nodesOf(web).filter((n) => 'crossSectionCalls' in n).map((n) => n.id),
      ['w1'],
      'only w1 calls into another section',
    );

    const api = await requestMap('api');
    assert.deepEqual(api.crossSectionEdges, [{ section: 'web', outgoing: 0, incoming: 1 }]);
    assert.ok(!hasCrossCalls(nodesOf(api)), 'incoming callers are not listed');
  });

  it('nested apps / apps/web: every edge between them counts, by direction', { timeout: 20_000 }, async () => {
    setScope(['apps', 'apps/web']);
    await requestMap();
    const apps = await requestMap('apps');
    assert.deepEqual(apps.crossSectionEdges, [{ section: 'apps/web', outgoing: 5, incoming: 1 }], 'p1→aw2 and g3/g9/g15/g21 → apps/web; aw1→p1 back');
    const p1 = nodesOf(apps).find((n) => n.id === 'p1');
    assert.deepEqual(p1?.crossSectionCalls, [{ id: 'aw2', name: 'aw2', section: 'apps/web' }]);
  });

  it('no cross items (webapp/docs): all three fields are absent', { timeout: 30_000 }, async () => {
    setScope(['webapp', 'docs']);
    await requestMap();
    const webapp = await requestMap('webapp');
    assert.ok(nodesOf(webapp).length > 0);
    assert.ok(!('crossSectionEdges' in webapp), 'crossSectionEdges absent, never []');
    assert.ok(!hasCrossCalls(nodesOf(webapp)), 'crossSectionCalls absent');
    if (GIT_AVAILABLE) {
      assert.ok(indexModule);
      const diff = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'webapp'));
      assert.ok(!('changedInOtherSections' in diff), 'changedInOtherSections absent');
    }
  });

  it('crossSectionEdges equals a brute-force count by direction, for every fixture scope and section', { timeout: 60_000 }, async () => {
    let checked = 0;
    for (const scope of FIXTURE_SCOPES) {
      setScope(scope);
      await requestMap();
      const { nodes, edges } = wholeScope();
      const fileOf = new Map(nodes.map((n) => [n.id, n.file]));
      for (const section of new Set(scope)) {
        const reply = await requestMap(section);
        const brute = new Map<string, { outgoing: number; incoming: number }>();
        let exactlyOneEnd = 0;
        for (const e of edges) {
          const from = fileOf.has(e.source) ? bruteOwner(fileOf.get(e.source)!, scope) : undefined;
          const to = fileOf.has(e.target) ? bruteOwner(fileOf.get(e.target)!, scope) : undefined;
          if (from === undefined || to === undefined || (from === section) === (to === section)) {
            continue;
          }
          exactlyOneEnd += 1;
          const other = from === section ? to : from;
          const entry = brute.get(other) ?? { outgoing: 0, incoming: 0 };
          if (from === section) {
            entry.outgoing += 1;
          } else {
            entry.incoming += 1;
          }
          brute.set(other, entry);
        }
        const counts = (reply.crossSectionEdges as { section: string; outgoing: number; incoming: number }[] | undefined) ?? [];
        assert.equal(
          counts.reduce((sum, entry) => sum + entry.outgoing + entry.incoming, 0),
          exactlyOneEnd,
          `Σ: ${scope.join(',')} / ${section}`,
        );
        assert.deepEqual(
          Object.fromEntries(counts.map((e) => [e.section, { outgoing: e.outgoing, incoming: e.incoming }])),
          Object.fromEntries(brute),
          section,
        );
        assert.equal('crossSectionEdges' in reply, brute.size > 0, `absent exactly when empty: ${section}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 10, `checked ${checked} sections`);
  });
});

describe('P4-4g review round 1: crossSectionCalls end to end', () => {
  it('every section Node\'s crossSectionCalls equals a brute-force list, for every fixture scope and section', { timeout: 60_000 }, async () => {
    let listed = 0;
    for (const scope of FIXTURE_SCOPES) {
      setScope(scope);
      await requestMap();
      const { nodes, edges } = wholeScope();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const section of new Set(scope)) {
        const reply = await requestMap(section);
        for (const sectionNode of nodesOf(reply)) {
          const callees = new Map<string, { id: string; name: string; section: string }>();
          for (const e of edges) {
            const target = byId.get(e.target);
            const owner = target === undefined ? undefined : bruteOwner(target.file, scope);
            if (e.kind === 'CALLS' && e.source === sectionNode.id && owner !== undefined && owner !== section) {
              callees.set(e.target, { id: e.target, name: target!.name, section: owner });
            }
          }
          const all = [...callees.values()].sort(
            (a, b) => (a.section < b.section ? -1 : a.section > b.section ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1),
          );
          const where = `${scope.join(',')} / ${section} / ${sectionNode.id}`;
          if (all.length === 0) {
            assert.ok(!('crossSectionCalls' in sectionNode) && !('crossSectionCallsTotal' in sectionNode), where);
          } else {
            assert.deepEqual(sectionNode.crossSectionCalls, all.slice(0, CROSS_SECTION_CALLS_MAX), where);
            assert.equal(sectionNode.crossSectionCallsTotal, all.length, where);
            listed += 1;
          }
        }
      }
    }
    assert.ok(listed >= 3, `${listed} Nodes with cross-section calls checked`);
  });

  it('25 cross-section callees: 20 listed with a total of 25, in the reply and in lookup_node(section)', { timeout: 30_000 }, async () => {
    const harness = globalThis as { __harnessFixtureOverride?: unknown };
    const callees = Array.from({ length: 25 }, (_, i) => ({
      id: `web.r${String(i).padStart(2, '0')}`,
      name: `r${String(i).padStart(2, '0')}`,
      file: 'web/many.ts',
      startLine: i + 1,
      endLine: i + 1,
      kind: 'Function' as const,
      summaryStatus: 'pending' as const,
      riskSignals: [],
    }));
    const hub = { ...callees[0]!, id: 'api.hub', name: 'hub', file: 'api/hub.ts', startLine: 1, endLine: 2 };
    harness.__harnessFixtureOverride = {
      ...SCOPED_MAP_FIXTURE,
      nodes: [...SCOPED_MAP_FIXTURE.nodes, hub, ...callees],
      edges: [...SCOPED_MAP_FIXTURE.edges, ...callees.map((c) => ({ source: 'api.hub', target: c.id, kind: 'CALLS' as const }))],
    };
    try {
      setScope(['web', 'api']);
      await requestMap();
      const api = await requestMap('api');
      const inReply = nodesOf(api).find((n) => n.id === 'api.hub');
      const expected = callees.slice(0, CROSS_SECTION_CALLS_MAX).map((c) => ({ id: c.id, name: c.name, section: 'web' }));
      assert.deepEqual(inReply?.crossSectionCalls, expected);
      assert.equal(inReply?.crossSectionCallsTotal, 25);
      const viaTool = (await call('lookup_node', { nodeId: 'api.hub', section: 'api' })).node as CodeMapNode;
      assert.deepEqual(viaTool.crossSectionCalls, expected);
      assert.equal(viaTool.crossSectionCallsTotal, 25);
      assert.ok(api.crossSectionEdges !== undefined);
      assert.deepEqual(api.crossSectionEdges, [{ section: 'web', outgoing: 25, incoming: 1 }], 'the 25 hub calls out, w1→s1 in');
    } finally {
      harness.__harnessFixtureOverride = undefined;
      await requestMap();
    }
  });
});

const change = (section: string, changedNodes: number, changedContracts: number, topLevelFiles: number) => ({
  section,
  changedNodes,
  changedContracts,
  topLevelFiles,
});

describe('P4-4 phase 3a: changedInOtherSections through index.ts', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  it('viewed from web: api\'s 3 Nodes, 1 contract and 1 top-level file; lib/ (outside the allowlist) is never counted', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api']);
    await requestMap();
    const whole = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main'));
    assert.ok(!('changedInOtherSections' in whole), 'never without a section');
    const web = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web'));
    assert.deepEqual(web.nodeIds, ['w1', 'w2']);
    assert.deepEqual(web.changedInOtherSections, [change('api', 3, 1, 1)]);
    const api = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'api'));
    assert.deepEqual(api.changedInOtherSections, [change('web', 2, 0, 0)]);
  });

  it("each entry equals that section's own diff-scope result", { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    for (const scope of [['web', 'api'], ['apps', 'apps/web'], ['web', 'api', 'apps', 'apps/web']]) {
      setScope(scope);
      await requestMap();
      for (const section of scope) {
        const own = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', section));
        for (const entry of own.changedInOtherSections ?? []) {
          const other = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', entry.section));
          assert.deepEqual(
            entry,
            change(entry.section, other.nodeIds.length, other.changedContracts?.length ?? 0, other.topLevelFiles?.length ?? 0),
            `${scope.join(',')}: ${section} → ${entry.section}`,
          );
        }
        // Every other section with a change is listed (all share one repository here).
        const listed = new Set((own.changedInOtherSections ?? []).map((entry) => entry.section));
        for (const other of scope.filter((entry) => entry !== section)) {
          const result = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', other));
          const any = result.nodeIds.length + (result.changedContracts?.length ?? 0) + (result.topLevelFiles?.length ?? 0) > 0;
          assert.equal(listed.has(other), any, `${scope.join(',')}: ${section} lists ${other}`);
        }
      }
    }
  });

  it('nested apps / apps/web', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    setScope(['apps', 'apps/web']);
    await requestMap();
    assert.deepEqual(
      resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'apps')).changedInOtherSections,
      [change('apps/web', 2, 0, 0)],
    );
    assert.deepEqual(
      resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'apps/web')).changedInOtherSections,
      [change('apps', 1, 0, 0)],
    );
  });

  it('ownership follows the scope the caches were built under until the refetch lands', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api']);
    await requestMap();
    // A nested entry is added; no refetch yet: api still owns api/db.ts.
    setScope(['web', 'api', 'api/db.ts']);
    assert.deepEqual(
      resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web')).changedInOtherSections,
      [change('api', 3, 1, 1)],
    );
    await requestMap();
    assert.deepEqual(
      resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web')).changedInOtherSections,
      [change('api', 2, 1, 1), change('api/db.ts', 1, 0, 0)],
    );
  });

  it('a section in another git repository (nested docs/) is never listed, and lists nothing itself', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api', 'docs']);
    await requestMap();
    const web = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web'));
    assert.deepEqual(web.changedInOtherSections, [change('api', 3, 1, 1)], 'docs/c.ts changed in the outer diff, but docs is its own repository');
    // Recorded current behaviour: the diff itself runs at the project root,
    // so docs' own result still lists the outer repository's docs/c.ts change.
    const docs = resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'docs'));
    assert.deepEqual(docs.nodeIds, ['d1']);
    assert.ok(!('changedInOtherSections' in docs), 'no other section shares docs\' repository');
  });

  it('git top-levels are looked up once per index generation', { timeout: 60_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api', 'docs']);
    await requestMap();
    await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web');
    const first = indexModule.peekGitToplevelCacheForTests();
    for (const section of ['api', 'docs', 'web']) {
      assert.ok(first?.sections.includes(section), `${section} looked up`);
    }
    // docs stops being its own repository; the cached lookup still says it is.
    const nestedGit = path.join(PROJECT, 'docs', '.git');
    renameSync(nestedGit, `${nestedGit}-moved`);
    try {
      assert.deepEqual(
        resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web')).changedInOtherSections,
        [change('api', 3, 1, 1)],
        'cached within the generation',
      );
      // A re-index starts a new generation: docs is now in the outer repository.
      await index(PROJECT);
      setScope(['web', 'api', 'docs']);
      await requestMap();
      assert.deepEqual(
        resolved(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web')).changedInOtherSections,
        [change('api', 3, 1, 1), change('docs', 1, 0, 0)],
      );
      assert.ok((indexModule.peekGitToplevelCacheForTests()?.generation ?? 0) > (first?.generation ?? 0));
    } finally {
      renameSync(`${nestedGit}-moved`, nestedGit);
    }
  });
});

describe('P4-4 phase 3a: MCP parity', () => {
  it("lookup_node(section) carries the renderer's crossSectionCalls; without a section it never does", { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const web = await requestMap('web');
    const w1 = nodesOf(web).find((n) => n.id === 'w1');
    const inWeb = (await call('lookup_node', { nodeId: 'w1', section: 'web' })).node as CodeMapNode;
    assert.deepEqual(inWeb.crossSectionCalls, w1?.crossSectionCalls);
    assert.equal(inWeb.crossSectionCallsTotal, 1);
    const unsectioned = (await call('lookup_node', { nodeId: 'w1' })).node as CodeMapNode;
    assert.ok(!('crossSectionCalls' in unsectioned) && !('crossSectionCallsTotal' in unsectioned));
  });

  it("review round 1: every listed callee resolves via lookup_node with its own section (as the description says)", { timeout: 30_000 }, async () => {
    let resolvedCount = 0;
    for (const [scope, section] of [
      [['web', 'api'], 'web'],
      [['apps', 'apps/web'], 'apps'],
      [['apps', 'apps/web'], 'apps/web'],
    ] as const) {
      setScope(scope);
      await requestMap();
      const reply = await requestMap(section);
      for (const listed of nodesOf(reply).flatMap((n) => n.crossSectionCalls ?? [])) {
        const found = await call('lookup_node', { nodeId: listed.id, section: listed.section });
        assert.equal(found.status, 'ok', `${listed.id} in ${listed.section}`);
        assert.equal((found.node as CodeMapNode).id, listed.id);
        assert.equal((found.node as CodeMapNode).name, listed.name);
        const whole = await call('lookup_node', { nodeId: listed.id });
        assert.equal(whole.status, 'ok', `${listed.id} without a section`);
        resolvedCount += 1;
      }
    }
    assert.ok(resolvedCount >= 3, `${resolvedCount} callees resolved`);
  });

  it('compute_diff_scope(section) carries changedInOtherSections; without a section it never does', { timeout: 30_000, skip: !GIT_AVAILABLE && 'git is not installed' }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const inWeb = await call('compute_diff_scope', { projectPath: PROJECT, baseRef: 'main', section: 'web' });
    assert.deepEqual(inWeb.changedInOtherSections, [change('api', 3, 1, 1)]);
    const unsectioned = await call('compute_diff_scope', { projectPath: PROJECT, baseRef: 'main' });
    assert.equal(unsectioned.status, 'resolved');
    assert.ok(!('changedInOtherSections' in unsectioned));
  });
});

// ---------------------------------------------------------------------------
// P4-4h (founder decision 2026-10-04): does PR Review's base ref carry over a
// section switch?
// ---------------------------------------------------------------------------

describe('P4-4h: decideDiffScopeCarry (temp repositories)', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  it('same repository; another repository with or without the ref; no repository; option-like ref', { timeout: 30_000 }, async () => {
    const { decideDiffScopeCarry } = await import('./git-diff-scope');
    const root = makeTempDir('driller-carry-repos-');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        stdio: 'pipe',
      });
    for (const repo of ['one', 'two']) {
      mkdirSync(path.join(root, repo, 'a'), { recursive: true });
      mkdirSync(path.join(root, repo, 'b'), { recursive: true });
      writeFileSync(path.join(root, repo, 'a', 'x.ts'), '// x\n');
      git(path.join(root, repo), 'init', '-q', '-b', 'main');
      git(path.join(root, repo), 'add', '.');
      git(path.join(root, repo), 'commit', '-q', '-m', 'base');
    }
    git(path.join(root, 'one'), 'tag', 'only-in-one');
    mkdirSync(path.join(root, 'plain'));
    const one = path.join(root, 'one');
    const two = path.join(root, 'two');

    assert.equal(await decideDiffScopeCarry(path.join(one, 'a'), path.join(one, 'b'), 'whatever'), 'same-repository');
    assert.equal(await decideDiffScopeCarry(path.join(one, 'a'), two, 'main'), 'ref-exists');
    assert.equal(await decideDiffScopeCarry(path.join(one, 'a'), two, 'only-in-one'), 'not-carried');
    assert.equal(await decideDiffScopeCarry(path.join(root, 'plain'), two, 'main'), 'ref-exists', 'from no repository: the ref decides');
    assert.equal(await decideDiffScopeCarry(one, path.join(root, 'plain'), 'main'), 'not-carried', 'to no repository');
    assert.equal(await decideDiffScopeCarry(one, path.join(root, 'missing'), 'main'), 'not-carried', 'a git call that fails');
    assert.equal(await decideDiffScopeCarry(one, two, '--all'), 'not-carried', 'never an option');
    assert.equal(await decideDiffScopeCarry(one, two, '   '), 'not-carried');
  });
});

describe('P4-4h: the base-ref carry through index.ts', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  it('same repository, another repository with / without the ref, and every guard', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api', 'docs']);
    await requestMap();
    // docs/ is its own repository (makeGitRepo); give it one commit and a tag.
    const docs = path.join(PROJECT, 'docs');
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'docs'],
      { cwd: docs, stdio: 'pipe' },
    );
    execFileSync('git', ['tag', 'docs-release'], { cwd: docs, stdio: 'pipe' });

    assert.deepEqual(await indexModule.computeDiffScopeCarryResult(PROJECT, 'web', 'api', 'feature'), { status: 'same-repository' });
    assert.deepEqual(await indexModule.computeDiffScopeCarryResult(PROJECT, null, 'api', 'main'), { status: 'same-repository' });
    assert.deepEqual(await indexModule.computeDiffScopeCarryResult(PROJECT, 'web', 'docs', 'docs-release'), { status: 'ref-exists' });
    assert.deepEqual(await indexModule.computeDiffScopeCarryResult(PROJECT, 'web', 'docs', 'feature'), { status: 'not-carried' });
    assert.deepEqual(await indexModule.computeDiffScopeCarryResult(PROJECT, 'web', 'gone', 'main'), { status: 'not-carried' });
    assert.deepEqual(await indexModule.computeDiffScopeCarryResult(PROJECT, '../..', 'web', 'main'), { status: 'not-carried' });
    assert.equal((await indexModule.computeDiffScopeCarryResult('/elsewhere', 'web', 'api', 'main')).status, 'error');
  });

  it('answers a parentPort request with its own requestId; a malformed one gets no reply', { timeout: 30_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const from = posted.length;
    send({ type: 'graphService:diffScopeCarry', projectPath: PROJECT, requestId: 41, fromSection: 'web', toSection: 'api', baseRef: 'main' });
    send({ type: 'graphService:diffScopeCarry', projectPath: PROJECT, requestId: 42, fromSection: '', toSection: 'api', baseRef: 'main' });
    const reply = await waitFor(
      () => posted.slice(from).find((m) => m.type === 'graphService:diffScopeCarryResult' && m.requestId === 41),
      'a carry reply',
    );
    assert.deepEqual(reply, {
      type: 'graphService:diffScopeCarryResult',
      projectPath: PROJECT,
      requestId: 41,
      result: { status: 'same-repository' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(posted.slice(from).some((m) => m.requestId === 42), false);
  });
});
