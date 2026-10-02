/**
 * P4-4 phase 1a: when `activeRawCodeMap` (the raw fetch behind the current
 * map, read through `getActiveRawCodeMap`) is set, kept and cleared, through
 * the real `index.ts` (`scoped-code-map-harness.ts`).
 *
 * It has exactly `activeCodeMapNodes`'s lifecycle:
 *  - set by every Code Map fetch, in the same synchronous tick as the Nodes;
 *  - cleared when any index starts (a re-index, or a switch to another project);
 *  - NOT cleared by a scope change or an LCOV change: each is picked up by the
 *    next fetch, which replaces the cache;
 *  - kept as-is by a backend switch / re-affirm and the model-retry re-kick.
 * Review round 1: a fetch still in flight when an index starts is never
 * cached as it (the reader returns `null`), and the cached object is frozen.
 */
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

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
} from './scoped-code-map-harness';
import { buildScopedCodeMap, keepFileForScope, type ActiveRawCodeMap } from './scoped-code-map';

const PROJECT = makeFixtureProject();
const harness = globalThis as {
  __harnessIndexGate?: Promise<void>;
  __harnessFetchGate?: Promise<void>;
  __harnessFetchCount?: number;
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

  it('an LCOV change is picked up by the next fetch, not before', { timeout: 20_000 }, async () => {
    const lcovPath = path.join(PROJECT, 'coverage', 'lcov.info');
    await fetchMap();
    const before = activeRaw();
    assert.ok(before?.raw.coverage);
    rmSync(lcovPath);
    try {
      assert.equal(activeRaw(), before);
      await fetchMap();
      assert.equal(activeRaw()?.raw.coverage, undefined);
    } finally {
      writeFileSync(lcovPath, FIXTURE_LCOV);
    }
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
