/**
 * P5-b review round 1: a backend switch (and a same-backend re-affirm, e.g.
 * main's key-change relay) bumps the summary generation, which supersedes the
 * running summary, judgment and staleness runs. Since P5-b the renderer's
 * refetch after it is served from the raw cache and kicks nothing, so the
 * Graph Service must restart all three itself, over the cached map.
 *
 * Through the real `index.ts` (`scoped-code-map-harness.ts`). The model
 * download never settles here, so a local judgment run that started stays
 * started (awaiting the model) under its generation.
 *
 * Nothing on `index.ts`'s import graph is imported statically here: the
 * harness's module hooks must be registered before it first loads.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { makeFixtureProject, posted, removeHarnessTempDirs, send, startIndexTs, waitFor, type Posted } from './scoped-code-map-harness';

const PROJECT = makeFixtureProject();
const harness = globalThis as { __harnessFetchCount?: number; __harnessLcovCount?: number };
let indexModule: typeof import('./index') | undefined;

const REPLY_TYPES = ['graphService:codeMap', 'graphService:codeMapUnknownSection', 'graphService:codeMapError'];

async function requestMap(section?: string): Promise<Posted> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap', ...(section === undefined ? {} : { section }) });
  const reply = await waitFor(() => posted.slice(from).find((message) => REPLY_TYPES.includes(message.type ?? '')), 'a Code Map reply');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return reply;
}

const io = (): [number, number] => [harness.__harnessFetchCount ?? 0, harness.__harnessLcovCount ?? 0];
const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

after(removeHarnessTempDirs);

before(async () => {
  indexModule = await startIndexTs(PROJECT);
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web', 'api'] });
  assert.equal((await requestMap()).type, 'graphService:codeMap');
  // Let the fetch's own staleness pass finish.
  await settle(100);
});

describe('P5-b review round 1: a backend switch restarts judgment and staleness too', () => {
  it('a re-affirm (key-change relay) restarts both, and its staleness pass runs over the cached map', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    const { getNodeRecord, mergeNodeRecord } = await import('./node-record-store');
    // A summary whose baseline no longer matches its source: only a staleness
    // pass started after this write can mark it stale.
    mergeNodeRecord('s1', {
      summary: {
        text: 'Starts the API server.',
        model: 'fixture-model',
        generatedAt: '2026-10-15T00:00:00.000Z',
        sourceHash: 'not-the-hash',
        sourceMtimeMs: 1,
        sourceSize: 1,
      },
      stale: undefined,
    });
    const before = module.peekGenerationRunsForTests();
    send({ type: 'graphService:backendSwitched', activeBackend: 'local' });
    await settle();
    const after = module.peekGenerationRunsForTests();
    assert.equal(after.generation, before.generation + 1, 'the re-affirm bumped the generation');
    assert.equal(after.judgment, after.generation, 'a judgment run started under the new generation');
    assert.equal(after.staleness, after.generation, 'a staleness pass started under the new generation');
    await waitFor(() => (getNodeRecord('s1')?.stale === true ? true : undefined), 's1 to be marked stale');
    // The renderer's refetch is served from the cache: no fetch, no kick, and
    // the restarted runs are still the current ones.
    const ioBefore = io();
    const reply = await requestMap();
    assert.equal(reply.type, 'graphService:codeMap');
    assert.deepEqual(io(), ioBefore);
    assert.deepEqual(module.peekGenerationRunsForTests(), after);
    const s1 = (reply.nodes as { id: string; stale?: boolean }[]).find((node) => node.id === 's1');
    assert.equal(s1?.stale, true, 'the cache-served reply shows the staleness the restarted pass found');
  });

  it('a genuine switch (local → cloud → local) restarts both after each bump', { timeout: 20_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    for (const activeBackend of ['cloud', 'local']) {
      const before = module.peekGenerationRunsForTests();
      send({ type: 'graphService:backendSwitched', activeBackend });
      await settle();
      const after = module.peekGenerationRunsForTests();
      assert.equal(after.generation, before.generation + 1, `${activeBackend}: bumped`);
      assert.equal(after.judgment, after.generation, `${activeBackend}: judgment restarted`);
      assert.equal(after.staleness, after.generation, `${activeBackend}: staleness restarted`);
      const ioBefore = io();
      assert.equal((await requestMap('api')).type, 'graphService:codeMap');
      assert.deepEqual(io(), ioBefore, `${activeBackend}: the refetch is served from the cache`);
    }
  });
});
