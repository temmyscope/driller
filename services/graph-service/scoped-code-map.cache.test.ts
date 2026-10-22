/**
 * P4-4 phase 1a: when `activeRawCodeMap` (the raw fetch behind the current
 * map, read through `getActiveRawCodeMap`) is set, kept and cleared, through
 * the real `index.ts` (`scoped-code-map-harness.ts`).
 *
 * It has exactly `activeCodeMapNodes`'s lifecycle:
 *  - set by every Code Map fetch, in the same synchronous tick as the Nodes;
 *  - cleared when any index starts (a re-index, or a switch to another project);
 *  - NOT cleared by a scope change or an LCOV change: each is picked up by the
 *    next fetch, which replaces the cache (P5-b: a scope save makes the next
 *    request a fetch; an LCOV change waits for the first fetch after a
 *    re-index or a scope save — a same-scope request is served from the cache);
 *  - kept as-is by a backend switch / re-affirm and the model-retry re-kick.
 * Review round 1: a fetch still in flight when an index starts is never
 * cached as it (the reader returns `null`), and the cached object is frozen.
 */
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { listEntryCandidates } from '@driller/graph-contracts';

import { FIXTURE_LCOV, goldenStringify } from './scoped-code-map-fixture';
import {
  fetchMap,
  getters,
  index,
  makeFixtureProject,
  makeTempDir,
  onPost,
  posted,
  removeHarnessTempDirs,
  send,
  startIndexTs,
  waitFor,
  type Posted,
} from './scoped-code-map-harness';
import { buildScopedCodeMap, keepFileForScope, type ActiveRawCodeMap } from './scoped-code-map';

const PROJECT = makeFixtureProject();
const harness = globalThis as {
  __harnessIndexGate?: Promise<void>;
  __harnessFetchGate?: Promise<void>;
  __harnessFetchCount?: number;
  __harnessLcovCount?: number;
  __harnessModel?: () => Promise<unknown>;
};

let indexModule: typeof import('./index') | undefined;
const activeRaw = (): Readonly<ActiveRawCodeMap> | null => {
  assert.ok(indexModule);
  return indexModule.getActiveRawCodeMap();
};
/** The stored cache, without the reader's stamp check. */
const storedRaw = (): Readonly<ActiveRawCodeMap> | undefined => {
  assert.ok(indexModule);
  return indexModule.peekActiveRawCodeMapForTests();
};

// The caches as they stand once the code that posted a Code Map reply has run
// to its first `await` — a microtask queued at post time runs before any
// continuation that code queues after it, so a cache assigned after an
// `await` is caught here still holding the previous map.
const snapshotsAtReply: { nodes: unknown; raw: Readonly<ActiveRawCodeMap> | null }[] = [];
onPost((message) => {
  if (message.type === 'graphService:codeMap') {
    queueMicrotask(() => {
      snapshotsAtReply.push({ nodes: getters().getNodes(), raw: indexModule?.getActiveRawCodeMap() ?? null });
    });
  }
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// P4-4e review round 1: no temp dirs left behind.
after(removeHarnessTempDirs);

before(async () => {
  // The first model download fails, so a later retry can succeed and
  // re-kick generation over the cached map (last test).
  harness.__harnessModel = () => Promise.reject(new Error('offline (test)'));
  indexModule = await startIndexTs(PROJECT);
});

// P5-b (founder decision 2.1): a request whose raw cache is current and was
// built under the live scope is served from it — no CBM fetch, no LCOV load,
// no re-cache and no summary / judgment / staleness kick — with exactly the
// reply the fetch path posts for the same raw fetch.
const REPLY_TYPES = ['graphService:codeMap', 'graphService:codeMapUnknownSection', 'graphService:codeMapError'];

/** Posts `getCodeMap` (with `section` when given) and resolves with its reply, once the synchronous kicks after it have run. */
async function requestMap(section?: string, force = false): Promise<Posted> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap', ...(section === undefined ? {} : { section }), ...(force ? { force: true } : {}) });
  const reply = await waitFor(() => posted.slice(from).find((message) => REPLY_TYPES.includes(message.type ?? '')), 'a Code Map reply');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return reply;
}

const setScope = (scope: readonly string[]): void => {
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
};

/** CBM fetches and LCOV loads so far (`scoped-code-map-harness.ts`'s counters). */
const io = (): { fetches: number; lcovLoads: number } => ({
  fetches: harness.__harnessFetchCount ?? 0,
  lcovLoads: harness.__harnessLcovCount ?? 0,
});
const plus = (base: { fetches: number; lcovLoads: number }, n: number) => ({ fetches: base.fetches + n, lcovLoads: base.lcovLoads + n });

const SWITCH_SCOPE = ['web', 'api', 'apps', 'apps/web'];
const SWITCH_SECTIONS = [undefined, 'web', 'api', 'apps', 'apps/web'] as const;

describe('P5-b: a section switch is served from the raw cache', () => {
  it('a switch after a fetch makes no fetch and no LCOV load, and posts exactly the fetch path’s reply', { timeout: 30_000 }, async () => {
    // The fetch path's reply for each section: each right after a re-index
    // (which clears the cache), so each is a real fetch and LCOV load.
    const viaFetch = new Map<string | undefined, string>();
    for (const section of SWITCH_SECTIONS) {
      await index(PROJECT);
      setScope(SWITCH_SCOPE);
      const before = io();
      const reply = await requestMap(section);
      assert.equal(reply.type, 'graphService:codeMap', reply.message);
      assert.deepEqual(io(), plus(before, 1), `section ${section}: one fetch, one LCOV load`);
      viaFetch.set(section, goldenStringify(reply));
    }
    // Now switch through every section and back (apps → services → all style).
    const before = io();
    for (const section of [...SWITCH_SECTIONS, ...[...SWITCH_SECTIONS].reverse()]) {
      const reply = await requestMap(section);
      assert.equal(goldenStringify(reply), viaFetch.get(section), `section ${section}: the cache-served reply equals the fetch path's`);
    }
    assert.deepEqual(io(), before, 'no fetch and no LCOV load on any switch');
    // The pinned parts of the reply, so a missing whole-scope build can't hide.
    const all = await requestMap();
    const api = await requestMap('api');
    assert.deepEqual(api.sections, all.sections);
    assert.equal(api.hiddenByScope, all.hiddenByScope);
    assert.deepEqual(api.appliedScope, SWITCH_SCOPE);
    assert.ok(Array.isArray(api.sections) && api.sections.length === SWITCH_SCOPE.length);
  });

  it('the caches and every memo keyed on them survive a switch (no re-cache; any kick reuses the cached arrays); Revealed is a memo hit', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    await index(PROJECT);
    setScope(['web', 'api']);
    await requestMap();
    // Fill the memos a switch must keep: entry candidates (whole and per
    // section) and the per-section build behind `lookup_node`.
    module.computeEntryCandidatesResult(PROJECT);
    module.computeEntryCandidatesResult(PROJECT, 'api');
    module.getSectionCodeMap('api');
    const snapshot = () => ({
      nodes: getters().getNodes(),
      edges: module.peekActiveCodeMapEdgesForTests(),
      foldedModules: getters().getFolded(),
      foldedTypes: getters().getFoldedTypes(),
      raw: module.getActiveRawCodeMap(),
      entryWhole: module.peekEntryCandidatesMemoForTests().whole,
      entryApi: module.peekEntryCandidatesMemoForTests().sections?.get('api'),
      sectionBuildApi: module.peekSectionCodeMapMemoForTests()?.get('api'),
    });
    const before = snapshot();
    for (const [key, value] of Object.entries(before)) {
      assert.ok(value !== undefined && value !== null, `${key} is set before the switch`);
    }
    const ioBefore = io();
    for (const section of ['api', 'web', undefined, 'api']) {
      await requestMap(section);
    }
    const after = snapshot();
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      assert.equal(after[key], before[key], `${key} is the same object after the switches`);
    }
    assert.deepEqual(io(), ioBefore);
    // Revealed after a switch: the section's candidates come from the memo, with no re-list.
    let listings = 0;
    module.setEntryCandidatesListerForTests((nodes, edges) => {
      listings += 1;
      return listEntryCandidates(nodes, edges);
    });
    try {
      assert.equal(module.computeEntryCandidatesResult(PROJECT, 'api'), before.entryApi);
      assert.equal(module.computeEntryCandidatesResult(PROJECT), before.entryWhole);
      assert.equal(listings, 0, 'no re-list after a switch');
    } finally {
      module.setEntryCandidatesListerForTests(undefined);
    }
  });

  it('a scope save re-fetches (with its LCOV load); the next same-scope request does not', { timeout: 30_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    let base = io();
    await requestMap('api');
    assert.deepEqual(io(), base, 'same scope: served from the cache');
    for (const scope of [['web', 'api', 'apps'], ['api', 'web', 'apps'], ['api', 'web'], []]) {
      setScope(scope);
      base = io();
      const reply = await requestMap(scope.includes('api') ? 'api' : undefined);
      assert.equal(reply.type, 'graphService:codeMap', reply.message);
      assert.deepEqual(io(), plus(base, 1), `scope ${JSON.stringify(scope)}: a real fetch`);
      assert.deepEqual(reply.appliedScope, scope);
      const again = io();
      await requestMap();
      assert.deepEqual(io(), again, `scope ${JSON.stringify(scope)}: the next request is served from the cache`);
    }
  });

  it('the first request after indexed re-fetches, even when a fetch made during the index is cached', { timeout: 30_000 }, async () => {
    // Scope `[]` throughout: an index without a scope ends with `[]`, so only
    // the generation and the during-index rule can force the fetch.
    setScope([]);
    await requestMap();
    const cachedBase = io();
    await requestMap();
    assert.deepEqual(io(), cachedBase, 'current cache: no fetch');
    const gate = deferred();
    harness.__harnessIndexGate = gate.promise;
    const from = posted.length;
    try {
      await index(PROJECT, false);
      // While the index runs the cache is cleared, so this is a real fetch —
      // cached under the new generation's stamp.
      let base = io();
      assert.equal((await requestMap()).type, 'graphService:codeMap');
      assert.deepEqual(io(), plus(base, 1));
      assert.ok(activeRaw(), 'the during-index fetch is the current raw cache');
      base = io();
      await requestMap();
      assert.deepEqual(io(), plus(base, 1), 'a fetch made during an index never serves');
    } finally {
      gate.release();
      harness.__harnessIndexGate = undefined;
    }
    await waitFor(() => posted.slice(from).find((message) => message.type === undefined && message.state === 'indexed'), 'indexed');
    let base = io();
    await requestMap();
    assert.deepEqual(io(), plus(base, 1), 'the first request after indexed fetches');
    base = io();
    await requestMap();
    assert.deepEqual(io(), base, 'and the next one is served from its cache');
  });

  it('founder decision 2: a forced request (the map\u2019s Retry) bypasses a servable cache, re-caches, and posts the same reply', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const servedBase = io();
    const cachedReply = await requestMap('api');
    assert.deepEqual(io(), servedBase, 'unforced: served from the cache');
    const before = activeRaw();
    assert.ok(before);
    for (const section of ['api', undefined]) {
      const base = io();
      const previous = activeRaw();
      const forced = await requestMap(section, true);
      assert.equal(forced.type, 'graphService:codeMap', forced.message);
      assert.deepEqual(io(), plus(base, 1), `${section ?? 'all'}: a real fetch and LCOV load`);
      assert.notEqual(activeRaw(), previous, 'the fresh fetch is the new raw cache');
      if (section === 'api') {
        assert.equal(goldenStringify(forced), goldenStringify(cachedReply), 'the same reply for the same data');
      }
    }
    // The next unforced request is served from the re-cached fetch.
    const base = io();
    await requestMap('web');
    assert.deepEqual(io(), base);
  });

  it('a getCodeMap whose force is not a boolean is an explicit error, never a map', { timeout: 20_000 }, async () => {
    const from = posted.length;
    send({ type: 'graphService:getCodeMap', force: 'yes' });
    const reply = await waitFor(() => posted.slice(from).find((message) => REPLY_TYPES.includes(message.type ?? '')), 'a reply');
    assert.equal(reply.type, 'graphService:codeMapError');
  });

  it('founder decision 1: a cache-served request never re-checks staleness (a fetch does)', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { getNodeRecord, mergeNodeRecord } = await import('./node-record-store');
    const original = getNodeRecord('s1');
    try {
      // A baseline that no longer matches s1's source: any staleness pass marks it.
      mergeNodeRecord('s1', {
        summary: { text: 'Old.', model: 'fixture-model', generatedAt: '2026-10-15T00:00:00.000Z', sourceHash: 'x', sourceMtimeMs: 1, sourceSize: 1 },
        stale: undefined,
      });
      const base = io();
      for (const section of ['api', undefined, 'web']) {
        await requestMap(section);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(io(), base, 'all served from the cache');
      assert.equal(getNodeRecord('s1')?.stale, undefined, 'no staleness pass ran');
      // A forced request is a fetch, and re-checks it.
      await requestMap(undefined, true);
      await waitFor(() => (getNodeRecord('s1')?.stale === true ? true : undefined), 'the fetch to mark s1 stale');
    } finally {
      mergeNodeRecord('s1', { summary: original?.summary, stale: original?.stale });
    }
  });

  it('a summary written since the cache was made shows in a cache-served reply', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const { getNodeRecord, mergeNodeRecord } = await import('./node-record-store');
    const original = getNodeRecord('s1');
    const base = io();
    try {
      mergeNodeRecord('s1', { summary: { text: 'Written after the fetch.', model: 'fixture-model', generatedAt: '2026-10-15T00:00:00.000Z' } });
      for (const section of ['api', undefined]) {
        const reply = await requestMap(section);
        const s1 = (reply.nodes as { id: string; summaryStatus: string; summary?: string }[]).find((node) => node.id === 's1');
        assert.deepEqual([s1?.summaryStatus, s1?.summary], ['ready', 'Written after the fetch.'], `section ${section}`);
      }
    } finally {
      mergeNodeRecord('s1', { summary: original?.summary });
    }
    assert.deepEqual(io(), base, 'both were served from the cache');
  });

  it('an unknown section is answered first, before either path', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    for (const cleared of [false, true]) {
      if (cleared) {
        await index(PROJECT);
        setScope(['web', 'api']);
      }
      const base = io();
      const reply = await requestMap('docs');
      assert.deepEqual(
        { type: reply.type, section: reply.section, knownSections: reply.knownSections },
        { type: 'graphService:codeMapUnknownSection', section: 'docs', knownSections: ['web', 'api'] },
      );
      assert.deepEqual(io(), base, cleared ? 'no fetch with no cache' : 'no fetch with a current cache');
    }
    await requestMap();
  });

  for (const section of ['api', undefined]) {
    it(`a build that throws on the cached raw fetch is a codeMapError echoing the section (${section ?? 'all'}); the next request re-fetches`, { timeout: 20_000 }, async () => {
      setScope(['web', 'api']);
      await requestMap();
      const cached = activeRaw();
      assert.ok(cached);
      // A bug path: a malformed Node inside the (shallowly frozen) cached fetch.
      const nodes = cached.raw.fetched.nodes as unknown[];
      nodes.push(null);
      try {
        const base = io();
        const reply = await requestMap(section);
        assert.equal(reply.type, 'graphService:codeMapError');
        assert.equal(reply.section, section ?? null);
        assert.equal(typeof reply.message, 'string');
        assert.deepEqual(io(), base, 'the error came from the cache path');
        assert.equal(activeRaw(), cached, 'the cache itself is untouched');
        // Review round 1: that cache no longer serves — a Retry re-fetches.
        const retry = await requestMap(section);
        assert.equal(retry.type, 'graphService:codeMap', retry.message);
        assert.deepEqual(io(), plus(base, 1), 'the retry is a real fetch');
        assert.notEqual(activeRaw(), cached);
      } finally {
        nodes.pop();
      }
      const base = io();
      assert.equal((await requestMap('api')).type, 'graphService:codeMap');
      assert.deepEqual(io(), base, 'the new cache serves');
    });
  }
});

describe('P4-4 phase 1a: activeRawCodeMap', () => {
  it('is set with the map in the same tick, frozen, and rebuilds exactly the cached Nodes', { timeout: 20_000 }, async () => {
    for (const scope of [['web'], ['apps', 'apps/web'], []]) {
      send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
      const fromSnapshot = snapshotsAtReply.length;
      await fetchMap();
      const atReply = await waitFor(() => snapshotsAtReply[fromSnapshot], 'the post-reply cache snapshot');
      assert.ok(atReply.raw, `raw cache set with the Nodes (scope ${JSON.stringify(scope)})`);
      assert.deepEqual(atReply.raw.appliedScope, scope);
      const rebuilt = buildScopedCodeMap(atReply.raw.raw, keepFileForScope(atReply.raw.appliedScope));
      assert.equal(goldenStringify(rebuilt.nodes), goldenStringify(atReply.nodes));
      assert.equal(atReply.raw.raw.projectRoot, PROJECT);
      assert.equal(atReply.raw.raw.fetched.nodes.length, 36);
      assert.ok(atReply.raw.raw.coverage);
      assert.deepEqual([...atReply.raw.raw.coverageGapFiles], ['docs/c.ts']);
      assert.equal(activeRaw(), atReply.raw);
      // Review round 1: read-only.
      assert.ok(Object.isFrozen(atReply.raw) && Object.isFrozen(atReply.raw.raw) && Object.isFrozen(atReply.raw.appliedScope));
      assert.throws(() => {
        (atReply.raw as { appliedScope: unknown }).appliedScope = ['x'];
      }, TypeError);
    }
  });

  it('a scope change keeps it until the next fetch replaces it', { timeout: 20_000 }, async () => {
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web'] });
    await fetchMap();
    const before = activeRaw();
    assert.deepEqual(before?.appliedScope, ['web']);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['api'] });
    assert.equal(activeRaw(), before, 'a scope change alone does not touch the cache');
    await fetchMap();
    assert.notEqual(activeRaw(), before);
    assert.deepEqual(activeRaw()?.appliedScope, ['api']);
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    await fetchMap();
  });

  it('an LCOV change is picked up by the next real fetch (P5-b: after a re-index), never by a same-scope request', { timeout: 20_000 }, async () => {
    const lcovPath = path.join(PROJECT, 'coverage', 'lcov.info');
    send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: [] });
    await fetchMap();
    const before = activeRaw();
    assert.ok(before?.raw.coverage);
    rmSync(lcovPath);
    try {
      assert.equal(activeRaw(), before);
      await fetchMap();
      assert.equal(activeRaw(), before, 'a same-scope request is served from the cache');
      assert.ok(activeRaw()?.raw.coverage, 'and never re-reads LCOV');
      await index(PROJECT);
      await fetchMap();
      assert.equal(activeRaw()?.raw.coverage, undefined);
    } finally {
      writeFileSync(lcovPath, FIXTURE_LCOV);
    }
    await index(PROJECT);
    await fetchMap();
    assert.ok(activeRaw()?.raw.coverage);
  });

  it('a backend switch (and a same-backend re-affirm) keeps the same raw cache', { timeout: 20_000 }, async () => {
    await fetchMap();
    const before = activeRaw();
    assert.ok(before);
    for (const activeBackend of ['cloud', 'cloud', 'local']) {
      send({ type: 'graphService:backendSwitched', activeBackend });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(activeRaw(), before, `after switching to ${activeBackend}`);
    }
  });

  it('is cleared with the Nodes when a re-index starts, and stays cleared until the next fetch', { timeout: 20_000 }, async () => {
    await fetchMap();
    assert.ok(activeRaw());
    const gate = deferred();
    harness.__harnessIndexGate = gate.promise;
    await index(PROJECT, false);
    // In flight: both caches are gone (cleared, not just hidden by the stamp).
    assert.equal(storedRaw(), undefined);
    assert.equal(activeRaw(), null);
    assert.equal(getters().getNodes(), undefined);
    const from = posted.length;
    gate.release();
    await waitFor(() => posted.slice(from).find((message) => message.type === undefined && message.state === 'indexed'), 'indexed');
    harness.__harnessIndexGate = undefined;
    assert.equal(activeRaw(), null, 'an index finishing does not re-populate it; the next fetch does');
    await fetchMap();
    assert.ok(activeRaw());
  });

  it('is cleared by a switch to another project', { timeout: 20_000 }, async () => {
    await fetchMap();
    assert.ok(activeRaw());
    const other = makeTempDir('driller-raw-cache-other-');
    await index(other);
    assert.equal(storedRaw(), undefined);
    assert.equal(activeRaw(), null);
    assert.equal(getters().getNodes(), undefined);
    await fetchMap();
    assert.equal(activeRaw()?.raw.projectRoot, other);
    await index(PROJECT);
    await fetchMap();
    assert.equal(activeRaw()?.raw.projectRoot, PROJECT);
  });

  // Review round 1: a fetch that started before an index and lands after it
  // must never become the raw map — for a re-index of the same project, and
  // for a switch to another one.
  for (const target of ['the same project', 'another project'] as const) {
    it(`a fetch still in flight when an index of ${target} starts is never cached as the raw map`, { timeout: 20_000 }, async () => {
      await fetchMap();
      assert.ok(activeRaw());
      // P5-b: a scope save, so the request below is a real fetch (a
      // same-scope request would be served from the current cache).
      send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web'] });
      const gate = deferred();
      harness.__harnessFetchGate = gate.promise;
      const fetchesBefore = harness.__harnessFetchCount ?? 0;
      const from = posted.length;
      send({ type: 'graphService:getCodeMap' });
      try {
        await waitFor(() => ((harness.__harnessFetchCount ?? 0) > fetchesBefore ? true : undefined), 'the fetch to start');
        harness.__harnessFetchGate = undefined;
        const indexed = target === 'the same project' ? PROJECT : makeTempDir('driller-raw-race-');
        await index(indexed);
      } finally {
        gate.release();
      }
      await waitFor(() => posted.slice(from).find((message) => message.type === 'graphService:codeMap'), 'the stale fetch to land');
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(storedRaw(), undefined, 'the stale fetch is never stored');
      assert.equal(activeRaw(), null, 'the stale fetch is not the raw map');
      // The next fetch is.
      await index(PROJECT);
      await fetchMap();
      assert.equal(activeRaw()?.raw.projectRoot, PROJECT);
    });
  }

  // Last: the model becomes ready, so generation runs from here on.
  it('the model-retry re-kick keeps the same raw cache', { timeout: 20_000 }, async () => {
    await fetchMap();
    const before = activeRaw();
    assert.ok(before);
    harness.__harnessModel = () =>
      Promise.resolve({ model: 'fixture.gguf', path: path.join(PROJECT, 'missing.gguf'), tier: 'primary' });
    const from = posted.length;
    send({ type: 'graphService:retryModel' });
    await waitFor(
      () => posted.slice(from).find((message) => message.type === 'graphService:modelStatus' && message.state === 'ready'),
      'the model to be ready',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(activeRaw(), before);
  });
});
