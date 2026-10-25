/**
 * P4-4 phase 2a: Path Trace, diff scope and Blast Radius expansion with an
 * optional `section`, through the real `index.ts` (`scoped-code-map-harness.ts`)
 * over `scoped-code-map-fixture.ts`. The fixture project is made a git
 * repository with a `feature` branch that changes files on both sides
 * (`web/` and `api/`), plus nested `apps/` and `apps/web/`.
 *
 * Pins, per the spec's I/O matrix and acceptance criteria:
 *  - without a section, each operation's result deep-equals the pre-P4-4e
 *    computation (an oracle written from the baseline code; the Path Trace
 *    golden in `scoped-code-map.golden.test.ts` pins it byte for byte too);
 *  - with section `api`, no returned id has a `file` outside `api`:
 *    a trace never crosses into `web`, diff scope counts only `api`'s Nodes
 *    and contracts, and hop distances are walked over `api` alone (equal to
 *    `computeBlastRadiusHopDistances` over the P4-4c section build's
 *    adjacency); a `web` seed contributes nothing;
 *  - nested entries: the `apps` section excludes `apps/web/**` from all three;
 *  - an unknown section is the explicit `unknown-section` result from each
 *    (Path Trace without a fetch), and a malformed one an explicit error;
 *  - the section reaches each compute function through the IPC dispatch.
 *
 * Nothing on `index.ts`'s import graph is imported statically here (only
 * types and side-effect-free modules): the harness's module hooks must be
 * registered before `production-code-map.ts` first loads.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  buildBidirectionalAdjacency,
  computeBlastRadiusHopDistances,
  findChangedContracts,
  findChangedNodeIds,
  findContractOnlyChangedFiles,
  findTopLevelOnlyChangedFiles,
  traceCallPath,
  type BlastRadiusExpansionResult,
  type DiffScopeResult,
  type FoldedModule,
  type FoldedType,
  type PathTraceResult,
} from '@driller/graph-contracts';
import type { CodeMapEdge, CodeMapNode } from '@driller/ipc-contracts';

import { isFileInScope, sectionOfFile } from './project-scope';
import {
  buildScopedCodeMap,
  filterCodeMapToScope,
  keepFileForSection,
  resolveSectionFilter,
} from './scoped-code-map';
import { getters, index, makeFixtureProject, posted, removeHarnessTempDirs, send, startIndexTs, waitFor, type Posted } from './scoped-code-map-harness';

const PROJECT = makeFixtureProject();
const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;
const harness = globalThis as { __harnessFetchCount?: number; __harnessFetchGate?: Promise<void> };

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let indexModule: typeof import('./index') | undefined;
let computeDiffScope: typeof import('./git-diff-scope').computeDiffScope;

const lines = (count: number): string[] => Array.from({ length: count }, (_, i) => `// line ${i + 1}`);
const write = (file: string, content: string[]): void => {
  mkdirSync(path.join(PROJECT, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(PROJECT, file), `${content.join('\n')}\n`);
};
const edit = (file: string, lineNumbers: number[]): void => {
  const content = lines(20);
  for (const n of lineNumbers) {
    content[n - 1] = `// edited line ${n}`;
  }
  write(file, content);
};

/**
 * `main`: every file below at 20 plain lines. `feature`: one commit that
 * changes, on each side,
 *  - `web/a.ts` (w1, w2) and `api/server.ts` (s1, s2) — map Nodes;
 *  - `web/types.ts` line 5 (inside T, 3–9) and `api/types.ts` lines 4
 *    (inside A, 2–8) and 15 (its top-level code: the file has a folded
 *    Module and no map Node);
 *  - `lib/boot.ts` (top-level code only, in no section);
 *  - `apps/b.ts` (p1) and `apps/web/a.ts` (aw1, aw2) — nested sections.
 */
function makeGitRepo(): void {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: PROJECT,
      stdio: 'pipe',
    });
  const files = ['web/a.ts', 'api/server.ts', 'web/types.ts', 'api/types.ts', 'lib/boot.ts', 'apps/b.ts', 'apps/web/a.ts'];
  for (const file of files) {
    write(file, lines(20));
  }
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  edit('web/a.ts', [2]);
  edit('api/server.ts', [2]);
  edit('web/types.ts', [5]);
  edit('api/types.ts', [4, 15]);
  edit('lib/boot.ts', [1]);
  edit('apps/b.ts', [2]);
  edit('apps/web/a.ts', [2]);
  git('commit', '-q', '-am', 'both sides');
}

function setScope(scope: readonly string[]): void {
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
}

/** Posts `getCodeMap` (whole scope) and waits for the reply and the cache kicks. */
async function fetchWholeMap(): Promise<void> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap' });
  const reply = await waitFor(
    () => posted.slice(from).find((m) => m.type === 'graphService:codeMap' || m.type === 'graphService:codeMapError'),
    'a Code Map reply',
  );
  assert.equal(reply.type, 'graphService:codeMap', reply.message);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let nextRequestId = 70_000;
/** Posts one operation request and resolves with its reply's `result`. */
async function viaIpc(type: string, replyType: string, fields: Record<string, unknown>): Promise<unknown> {
  nextRequestId += 1;
  const requestId = nextRequestId;
  const from = posted.length;
  send({ type, requestId, ...fields });
  const reply = await waitFor(
    () => posted.slice(from).find((m: Posted) => m.type === replyType && m.requestId === requestId),
    replyType,
  );
  return reply.result;
}

const traceIpc = (query: string, section?: unknown) =>
  viaIpc('graphService:pathTrace', 'graphService:pathTraceResult', {
    query,
    ...(section === undefined ? {} : { section }),
  }) as Promise<PathTraceResult>;

function active() {
  assert.ok(indexModule);
  const raw = indexModule.getActiveRawCodeMap();
  assert.ok(raw, 'a fetch is cached');
  return raw;
}

/** Every fetched Node's file (including folded types and Modules), by id. */
function fileById(): Map<string, string> {
  const { raw } = active();
  return new Map([...raw.fetched.nodes, ...raw.fetched.foldedTypes].map((node) => [node.id, node.file]));
}

/** The whole-scope caches diff scope and Blast Radius read. */
function caches(): { nodes: CodeMapNode[]; edges: CodeMapEdge[]; folded: FoldedModule[]; types: FoldedType[] } {
  const { getNodes, getFolded, getFoldedTypes } = getters();
  assert.ok(indexModule);
  const edges = indexModule.peekActiveCodeMapEdgesForTests();
  assert.ok(edges, 'the edges are cached');
  return {
    nodes: getNodes() as CodeMapNode[],
    // The real cache (review round 1), not a rebuild.
    edges: [...edges],
    folded: getFolded() as FoldedModule[],
    types: getFoldedTypes() as FoldedType[],
  };
}

/** The pre-P4-4e `computeDiffScopeResult` body (baseline dd8235a), over the same caches. */
async function baselineDiffScope(baseRef: string): Promise<DiffScopeResult> {
  const { nodes, folded, types } = caches();
  const diffScope = await computeDiffScope(PROJECT, baseRef);
  if (diffScope.status !== 'resolved') {
    return diffScope;
  }
  const nodeIds = findChangedNodeIds(nodes, diffScope.changedFiles);
  const { contracts: changedContracts, approximate } = findChangedContracts(
    types,
    diffScope.changedFiles,
    diffScope.changedLines,
    { mapNodeIds: new Set(nodes.map((node) => node.id)) },
  );
  const contractOnlyFiles =
    diffScope.changedLines === undefined ? new Set<string>() : findContractOnlyChangedFiles(types, diffScope.changedLines);
  const topLevelFiles = findTopLevelOnlyChangedFiles(
    nodes,
    folded,
    diffScope.changedFiles.filter((file) => !contractOnlyFiles.has(file)),
  );
  return {
    status: 'resolved',
    resolvedBaseRef: diffScope.resolvedBaseRef,
    nodeIds,
    ...(topLevelFiles.length > 0 ? { topLevelFiles } : {}),
    ...(changedContracts.length > 0 ? { changedContracts } : {}),
    ...(changedContracts.length > 0 && approximate ? { changedContractsApproximate: true as const } : {}),
  };
}

/** `MAP_REFRESHING_RESULT`: the caches are a generation or a scope behind the live map. */
const REFRESHING = { status: 'error', message: 'The map is refreshing for the new scope — try again.' };

const resolvedDiff = (result: DiffScopeResult): Extract<DiffScopeResult, { status: 'resolved' }> => {
  assert.equal(result.status, 'resolved', JSON.stringify(result));
  return result as Extract<DiffScopeResult, { status: 'resolved' }>;
};
const hopsOf = (result: BlastRadiusExpansionResult): Record<string, number> => {
  assert.equal(result.status, 'resolved', JSON.stringify(result));
  return (result as Extract<BlastRadiusExpansionResult, { status: 'resolved' }>).hopDistances;
};
const tracedIds = (result: PathTraceResult): string[] => {
  assert.equal(result.status, 'found', JSON.stringify(result));
  return (result as Extract<PathTraceResult, { status: 'found' }>).path;
};

// P4-4e review round 1: no temp dirs left behind.
after(removeHarnessTempDirs);

before(async () => {
  if (GIT_AVAILABLE) {
    makeGitRepo();
  }
  indexModule = await startIndexTs(PROJECT);
  ({ computeDiffScope } = await import('./git-diff-scope'));
});

describe('P4-4 phase 2a: resolveSectionFilter', () => {
  it('omitted is the whole scope, an entry its nearest-section set, anything else unknown-section', () => {
    const scope = ['apps', 'apps/web'];
    const whole = resolveSectionFilter(undefined, scope);
    assert.equal(typeof whole, 'function');
    const apps = resolveSectionFilter('apps', scope);
    assert.ok(typeof apps === 'function');
    assert.equal(apps('apps/b.ts'), true);
    assert.equal(apps('apps/web/a.ts'), false, 'the nearest entry owns apps/web/**');
    assert.deepEqual(resolveSectionFilter('docs', scope), {
      status: 'unknown-section',
      section: 'docs',
      knownSections: ['apps', 'apps/web'],
    });
    assert.deepEqual(resolveSectionFilter('web', []), { status: 'unknown-section', section: 'web', knownSections: [] });
  });
});

describe('P4-4 phase 2a: Path Trace with a section', () => {
  it('without a section: identical to the whole-scope trace', { timeout: 20_000 }, async () => {
    for (const scope of [[], ['web', 'api'], ['apps', 'apps/web']]) {
      setScope(scope);
      await fetchWholeMap();
      const { raw } = active();
      for (const query of ['w1', 'aw1', 'p1', 'g0', 'nope']) {
        const today = filterCodeMapToScope(PROJECT, raw.fetched.nodes, raw.fetched.edges, scope);
        assert.deepEqual(await traceIpc(query), traceCallPath(today.nodes, today.edges, query), `${query} in ${scope.join(',')}`);
      }
    }
  });

  it('section api: a trace never crosses into web', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await fetchWholeMap();
    const files = fileById();
    // The whole scope walks w1 → s1 → s2 → s3; within web it stops at web's edge.
    assert.ok(tracedIds(await traceIpc('w1')).includes('s1'));
    const inWeb = tracedIds(await traceIpc('w1', 'web'));
    assert.deepEqual(inWeb, ['w1', 'w3']);
    // A web entry is not in api: nothing to trace from.
    assert.deepEqual(await traceIpc('w1', 'api'), { status: 'no-path-found' });
    const inApi = tracedIds(await traceIpc('s1', 'api'));
    assert.deepEqual(inApi, ['s1', 's2', 's3']);
    for (const id of [...inApi, ...inWeb]) {
      assert.ok(files.get(id) !== undefined);
    }
    assert.ok(inApi.every((id) => isFileInScope(files.get(id)!, ['api'])), 'every traced id is in api');
    // The compute function the MCP surface calls takes the same section.
    assert.ok(indexModule);
    assert.deepEqual(await indexModule.computePathTraceResult('s1', 'api'), await traceIpc('s1', 'api'));
  });

  it('nested: the apps section excludes apps/web/**', { timeout: 20_000 }, async () => {
    setScope(['apps', 'apps/web']);
    await fetchWholeMap();
    // p1 (apps/b.ts) calls aw2 (apps/web/a.ts).
    assert.ok(tracedIds(await traceIpc('p1')).includes('aw2'));
    const inApps = tracedIds(await traceIpc('p1', 'apps'));
    const files = fileById();
    assert.ok(inApps.every((id) => sectionOfFile(files.get(id)!, ['apps', 'apps/web']) === 'apps'), inApps.join(','));
    assert.deepEqual(inApps, ['p1']);
    assert.deepEqual(await traceIpc('aw1', 'apps'), { status: 'no-path-found' });
  });

  it('an unknown section is explicit and fetches nothing; a malformed one is an explicit error', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await fetchWholeMap();
    const fetchesBefore = harness.__harnessFetchCount ?? 0;
    for (const section of ['docs', 'all', 'ap', '']) {
      assert.deepEqual(await traceIpc('s1', section), {
        status: 'unknown-section',
        section,
        knownSections: ['web', 'api'],
      });
    }
    assert.equal(harness.__harnessFetchCount ?? 0, fetchesBefore, 'no fetch for an unknown section');
    assert.deepEqual(await traceIpc('s1', 42), { status: 'error', message: 'Invalid section.' });
  });
});

describe('P4-4 phase 2a: diff scope with a section', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  it('without a section: identical to the baseline computation', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    for (const scope of [[], ['web', 'api'], ['apps', 'apps/web']]) {
      setScope(scope);
      await fetchWholeMap();
      const actual = await indexModule.computeDiffScopeResult(PROJECT, 'main');
      assert.deepEqual(actual, await baselineDiffScope('main'), scope.join(','));
      assert.equal(actual.status, 'resolved');
    }
  });

  it('section api: only api Nodes, contracts and top-level files are counted', { timeout: 30_000 }, async () => {
    setScope(['web', 'api']);
    await fetchWholeMap();
    assert.ok(indexModule);
    const whole = resolvedDiff(await indexModule.computeDiffScopeResult(PROJECT, 'main'));
    assert.deepEqual(new Set(whole.nodeIds), new Set(['w1', 'w2', 's1', 's2']), 'both sides changed');
    assert.deepEqual(whole.changedContracts?.map((c) => c.id).sort(), ['A', 'T']);

    const api = resolvedDiff(
      (await viaIpc('graphService:computeDiffScope', 'graphService:computeDiffScopeResult', {
        projectPath: PROJECT,
        baseRef: 'main',
        section: 'api',
      })) as DiffScopeResult,
    );
    assert.deepEqual(api.nodeIds, ['s1', 's2'], "web's changed Nodes are not counted");
    // T (web/types.ts) changed in web: not an api contract. A's dependents are api's own.
    assert.deepEqual(
      api.changedContracts?.map((c) => [c.id, c.dependentIds]),
      [['A', ['g2', 's1']]],
    );
    assert.deepEqual(api.topLevelFiles, [{ file: 'api/types.ts', startLine: 1, endLine: 20 }]);
    assert.equal(api.resolvedBaseRef, whole.resolvedBaseRef);

    const files = fileById();
    const returned = [...api.nodeIds, ...(api.changedContracts ?? []).flatMap((c) => [c.id, ...c.dependentIds])];
    assert.ok(returned.every((id) => isFileInScope(files.get(id)!, ['api'])), returned.join(','));
    assert.ok((api.topLevelFiles ?? []).every((file) => isFileInScope(file.file, ['api'])));

    // The other side, for symmetry: T with its web dependent only.
    const web = resolvedDiff(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'web'));
    assert.deepEqual(web.nodeIds, ['w1', 'w2']);
    assert.deepEqual(web.changedContracts?.map((c) => [c.id, c.dependentIds]), [['T', ['w1']]]);
    assert.equal(web.topLevelFiles, undefined);
  });

  it('nested: the apps section excludes apps/web/**', { timeout: 30_000 }, async () => {
    setScope(['apps', 'apps/web']);
    await fetchWholeMap();
    assert.ok(indexModule);
    const whole = resolvedDiff(await indexModule.computeDiffScopeResult(PROJECT, 'main'));
    assert.deepEqual(new Set(whole.nodeIds), new Set(['p1', 'aw1', 'aw2']));
    const apps = resolvedDiff(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'apps'));
    assert.deepEqual(apps.nodeIds, ['p1']);
    const appsWeb = resolvedDiff(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'apps/web'));
    assert.deepEqual(appsWeb.nodeIds, ['aw1', 'aw2']);
  });

  it('an unknown section is explicit; a malformed one an explicit error', { timeout: 30_000 }, async () => {
    setScope(['web', 'api']);
    await fetchWholeMap();
    assert.ok(indexModule);
    assert.deepEqual(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'docs'), {
      status: 'unknown-section',
      section: 'docs',
      knownSections: ['web', 'api'],
    });
    const malformed = await viaIpc('graphService:computeDiffScope', 'graphService:computeDiffScopeResult', {
      projectPath: PROJECT,
      section: ['api'],
    });
    assert.deepEqual(malformed, { status: 'error', message: 'Invalid section.' });
  });
});

describe('P4-4 phase 2a: Blast Radius expansion with a section', () => {
  const expandIpc = (nodeIds: string[], section?: unknown) =>
    viaIpc('graphService:expandBlastRadius', 'graphService:expandBlastRadiusResult', {
      projectPath: PROJECT,
      nodeIds,
      ...(section === undefined ? {} : { section }),
    }) as Promise<BlastRadiusExpansionResult>;

  it('without a section: identical to the whole-scope expansion', { timeout: 20_000 }, async () => {
    for (const scope of [[], ['web', 'api'], ['apps', 'apps/web']]) {
      setScope(scope);
      await fetchWholeMap();
      const { nodes, edges } = caches();
      for (const seeds of [['s1', 'w1'], ['p1'], ['aw1', 'ghost'], []]) {
        const expected = Object.fromEntries(computeBlastRadiusHopDistances(buildBidirectionalAdjacency(nodes, edges), seeds));
        assert.deepEqual(await expandIpc(seeds), { status: 'resolved', hopDistances: expected }, `${seeds.join(',')} in ${scope.join(',')}`);
      }
    }
  });

  it('section api: hop distances over api only, equal to the section build; a web seed contributes nothing', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await fetchWholeMap();
    const files = fileById();
    const whole = hopsOf(await expandIpc(['s1', 'w1']));
    assert.ok(Object.keys(whole).some((id) => isFileInScope(files.get(id)!, ['web'])), 'the whole scope reaches web');

    const api = hopsOf(await expandIpc(['s1', 'w1'], 'api'));
    assert.deepEqual(api, { s2: 1, s3: 2 });
    assert.ok(Object.keys(api).every((id) => isFileInScope(files.get(id)!, ['api'])));
    assert.deepEqual(hopsOf(await expandIpc(['s1'], 'api')), api, 'the web seed is ignored');
    assert.deepEqual(hopsOf(await expandIpc(['w1'], 'api')), {}, 'a web seed alone reaches nothing in api');

    // Exactly the P4-4c section build's adjacency.
    const { raw, appliedScope } = active();
    const section = buildScopedCodeMap(raw, keepFileForSection('api', appliedScope));
    const expected = computeBlastRadiusHopDistances(
      buildBidirectionalAdjacency(section.preSignalNodes, section.edges),
      ['s1', 'w1'],
    );
    assert.deepEqual(api, Object.fromEntries(expected));
    assert.ok(indexModule);
    assert.deepEqual(indexModule.computeBlastRadiusExpansionResult(PROJECT, ['s1', 'w1'], 'api'), { status: 'resolved', hopDistances: api });
  });

  it('nested: the apps section excludes apps/web/**', { timeout: 20_000 }, async () => {
    setScope(['apps', 'apps/web']);
    await fetchWholeMap();
    // aw1 → p1 → aw2 cross between apps and apps/web.
    assert.deepEqual(hopsOf(await expandIpc(['p1'])), { aw1: 1, aw2: 1 });
    const apps = hopsOf(await expandIpc(['p1'], 'apps'));
    const files = fileById();
    assert.ok(
      Object.keys(apps).every((id) => sectionOfFile(files.get(id)!, ['apps', 'apps/web']) === 'apps'),
      Object.keys(apps).join(','),
    );
    assert.equal(apps.aw1, undefined);
    assert.equal(apps.aw2, undefined);
    // aw1 reaches aw2 only through p1 (apps), so not within apps/web.
    assert.deepEqual(hopsOf(await expandIpc(['aw1'], 'apps/web')), {});
  });

  it('an unknown section is explicit; a malformed one an explicit error', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await fetchWholeMap();
    assert.deepEqual(await expandIpc(['s1'], 'docs'), { status: 'unknown-section', section: 'docs', knownSections: ['web', 'api'] });
    assert.deepEqual(await expandIpc(['s1'], null), { status: 'error', message: 'Invalid section.' });
  });
});

/**
 * P4-4e review round 1: diff scope and Blast Radius expansion read caches
 * built under the allowlist of the last fetch. Between a scope change and the
 * refetch, a section's existence is decided by the live allowlist and its
 * files by the cached map's scope — so results match the map on screen, and a
 * section the caches don't know yet is the explicit "refreshing" error.
 */
describe('P4-4e review round 1: the scope-change drift window', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  it('ownership follows the cached map until the refetch lands', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const compute = indexModule;
    setScope(['web', 'api']);
    await fetchWholeMap();
    // A nested entry is added; no refetch yet. Live ownership would move s1
    // and s2 (api/server.ts) out of `api`.
    setScope(['web', 'api', 'api/server.ts']);
    assert.deepEqual(resolvedDiff(await compute.computeDiffScopeResult(PROJECT, 'main', 'api')).nodeIds, ['s1', 's2']);
    assert.deepEqual(hopsOf(compute.computeBlastRadiusExpansionResult(PROJECT, ['s1'], 'api')), { s2: 1, s3: 2 });
    // The new entry is live but the caches were built without it.
    assert.deepEqual(await compute.computeDiffScopeResult(PROJECT, 'main', 'api/server.ts'), REFRESHING);
    assert.deepEqual(compute.computeBlastRadiusExpansionResult(PROJECT, ['s1'], 'api/server.ts'), REFRESHING);
    // Without a section, nothing changes.
    assert.equal(resolvedDiff(await compute.computeDiffScopeResult(PROJECT, 'main')).nodeIds.length, 4);

    // The refetch lands: the nested entry now owns api/server.ts.
    await fetchWholeMap();
    assert.deepEqual(resolvedDiff(await compute.computeDiffScopeResult(PROJECT, 'main', 'api')).nodeIds, []);
    assert.deepEqual(resolvedDiff(await compute.computeDiffScopeResult(PROJECT, 'main', 'api/server.ts')).nodeIds, ['s1', 's2']);
    assert.deepEqual(hopsOf(compute.computeBlastRadiusExpansionResult(PROJECT, ['s1'], 'api/server.ts')), { s2: 1 });
  });

  it('a section the live allowlist dropped is unknown-section even while the caches still hold it', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    setScope(['web', 'api']);
    await fetchWholeMap();
    setScope(['web']);
    const unknown = { status: 'unknown-section', section: 'api', knownSections: ['web'] };
    assert.deepEqual(await indexModule.computeDiffScopeResult(PROJECT, 'main', 'api'), unknown);
    assert.deepEqual(indexModule.computeBlastRadiusExpansionResult(PROJECT, ['s1'], 'api'), unknown);
  });
});

/**
 * The open "snapshot ownership across cached arrays" item: a Code Map fetch
 * that was still in flight when an index started still lands in
 * `activeCodeMapNodes`/`activeCodeMapEdges`, describing the generation before
 * it. Entry candidates refuses to answer from those (P4-7c); diff scope and
 * Blast Radius expansion only refused when a `section` was given, because the
 * refusal came from `resolveCachedSectionFilter`. Without one they answered
 * from the previous generation's map with no error at all.
 */
describe('a stale fetch landing after an index', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  it('a re-index mid-fetch: neither diff scope nor Blast Radius answers from the old map, section or not', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const compute = indexModule;
    setScope(['web', 'api']);
    await fetchWholeMap();
    // The engineer has the map open and both operations answer over it.
    assert.equal(resolvedDiff(await compute.computeDiffScopeResult(PROJECT, 'main')).nodeIds.length, 4);
    assert.deepEqual(hopsOf(compute.computeBlastRadiusExpansionResult(PROJECT, ['s1'])), { s2: 1, s3: 2, w1: 1, g0: 2 });

    // A refetch starts; a re-index of the same project (Retry, or a checkout
    // that moved HEAD) begins before it lands, so what lands is a generation old.
    // P5-b: the raw cache is cleared first, or it would serve the request below
    // from cache and there would be no fetch to hold in flight.
    await index(PROJECT);
    setScope(['web', 'api']);
    const gate = deferred();
    harness.__harnessFetchGate = gate.promise;
    const fetchesBefore = harness.__harnessFetchCount ?? 0;
    const from = posted.length;
    send({ type: 'graphService:getCodeMap' });
    try {
      await waitFor(() => ((harness.__harnessFetchCount ?? 0) > fetchesBefore ? true : undefined), 'the fetch to start');
      harness.__harnessFetchGate = undefined;
      await index(PROJECT);
    } finally {
      gate.release();
    }
    await waitFor(() => posted.slice(from).find((m) => m.type === 'graphService:codeMap'), 'the stale fetch to land');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Its Nodes are cached, but no current raw cache stamps them.
    assert.equal(compute.getActiveRawCodeMap(), null);
    for (const section of [undefined, 'api'] as const) {
      assert.deepEqual(await compute.computeDiffScopeResult(PROJECT, 'main', section), REFRESHING, `diff scope / ${section}`);
      assert.deepEqual(compute.computeBlastRadiusExpansionResult(PROJECT, ['s1'], section), REFRESHING, `blast radius / ${section}`);
    }

    // The refetch after the index lands, and both answer over the new map again.
    setScope(['web', 'api']);
    await fetchWholeMap();
    assert.equal(resolvedDiff(await compute.computeDiffScopeResult(PROJECT, 'main')).nodeIds.length, 4);
    assert.deepEqual(hopsOf(compute.computeBlastRadiusExpansionResult(PROJECT, ['s1'])), { s2: 1, s3: 2, w1: 1, g0: 2 });
  });
});
