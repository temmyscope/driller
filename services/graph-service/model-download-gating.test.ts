/**
 * P5-c (founder decision 4.7): the local model downloads only when Local is
 * selected or first needed. Under Cloud, nothing calls `ensureLocalModel`
 * and nothing posts `graphService:modelStatus`. Under Local, the download
 * starts right after the `indexing` post, as before. A genuine switch to
 * Local, the model Retry and a user Regenerate start (or join) the memoized
 * download; the implicit summary / judgment kicks only join one in flight
 * (review round 1: no download storm after a failure).
 *
 * Through the real `index.ts` (`scoped-code-map-harness.ts`). One module
 * instance per process, so the memo carries across the steps: the tests run
 * in order, each building on the state the previous one left. Every model
 * attempt is a deferred the test settles (`__harnessModel`), and
 * `__harnessModelCount` counts `ensureLocalModel` calls. The local and cloud
 * per-Node steps are stubbed, so nothing reaches a model or the network.
 *
 * Nothing on `index.ts`'s import graph is imported statically here: the
 * harness's module hooks must be registered before it first loads.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  index,
  makeFixtureProject,
  posted,
  removeHarnessTempDirs,
  send,
  startIndexTs,
  waitFor,
  type Posted,
} from './scoped-code-map-harness';

type Step = (node: { id: string }) => Promise<{ kind: 'success'; text: string }>;
interface Deferred {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** `posted.length` when `ensureLocalModel` was called. */
  postedAt: number;
}
const harness = globalThis as {
  __harnessModel?: () => Promise<unknown>;
  __harnessModelCount?: number;
  __harnessSummarize?: Step;
  __harnessJudge?: Step;
  __harnessCloudSummarize?: Step;
  __harnessCloudJudge?: Step;
};

const PROJECT = makeFixtureProject();
const SECOND_PROJECT = makeFixtureProject();
const KEY = 'sk-test-not-a-real-key';

const attempts: Deferred[] = [];
harness.__harnessModel = () =>
  new Promise((resolve, reject) => {
    attempts.push({ resolve, reject, postedAt: posted.length });
  });

const calls = { localSummarize: 0, localJudge: 0, cloudSummarize: 0, cloudJudge: 0 };
const step =
  (kind: keyof typeof calls): Step =>
  async (node) => {
    calls[kind] += 1;
    return { kind: 'success', text: `${kind} of ${node.id}` };
  };
harness.__harnessSummarize = step('localSummarize');
harness.__harnessJudge = step('localJudge');
harness.__harnessCloudSummarize = step('cloudSummarize');
harness.__harnessCloudJudge = step('cloudJudge');

const FALLBACK_MODEL = { model: 'fixture-fallback.gguf', path: path.join(PROJECT, 'fixture-fallback.gguf'), tier: 'fallback' };

let indexModule: typeof import('./index') | undefined;
const REPLY_TYPES = ['graphService:codeMap', 'graphService:codeMapUnknownSection', 'graphService:codeMapError'];

const downloads = (): number => harness.__harnessModelCount ?? 0;
const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const postedSince = (from: number, type: string): Posted[] => posted.slice(from).filter((message) => message.type === type);

/** The first request after an index fetches; later ones are served from the cache (and re-kick generation, P5-b). */
async function requestMap(): Promise<Posted> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap' });
  const reply = await waitFor(() => posted.slice(from).find((message) => REPLY_TYPES.includes(message.type ?? '')), 'a Code Map reply');
  assert.equal(reply.type, 'graphService:codeMap', reply.message);
  await settle(0);
  return reply;
}

async function regenerate(nodeId: string, whileWaiting?: () => void): Promise<{ status: string; message?: string }> {
  const from = posted.length;
  send({ type: 'graphService:regenerateNode', nodeId });
  whileWaiting?.();
  const reply = await waitFor(
    () => posted.slice(from).find((message) => message.type === 'graphService:regenerateNodeResult' && message.nodeId === nodeId),
    'a regenerateNodeResult',
  );
  return reply.result as { status: string; message?: string };
}

async function runsIdle(): Promise<void> {
  assert.ok(indexModule);
  const module = indexModule;
  await waitFor(() => {
    const active = module.peekActiveGenerationRunsForTests();
    return active.summary || active.judgment ? undefined : true;
  }, 'the summary and judgment runs to finish');
}

function switchBackend(activeBackend: 'local' | 'cloud', cloudApiKey?: string): void {
  send({ type: 'graphService:backendSwitched', activeBackend, ...(cloudApiKey === undefined ? {} : { cloudApiKey }) });
}

after(async () => {
  harness.__harnessModel = undefined;
  harness.__harnessSummarize = undefined;
  harness.__harnessJudge = undefined;
  harness.__harnessCloudSummarize = undefined;
  harness.__harnessCloudJudge = undefined;
  // Settle any attempt still pending so nothing is left awaiting it.
  for (const attempt of attempts) {
    attempt.reject(new Error('test teardown'));
  }
  await removeHarnessTempDirs();
});

before(async () => {
  indexModule = await startIndexTs(PROJECT, { activeBackend: 'local' });
});

describe('P5-c: the local model downloads only when Local is selected or first needed', () => {
  it('Local: the download starts alongside indexing, right after the indexing post', () => {
    assert.equal(downloads(), 1, 'one ensureLocalModel call for the Local index');
    const indexingAt = posted.findIndex((message) => message.type === undefined && message.state === 'indexing');
    assert.ok(indexingAt >= 0);
    assert.ok(attempts[0]!.postedAt > indexingAt, 'started after the indexing post');
    const indexedAt = posted.findIndex((message) => message.type === undefined && message.state === 'indexed');
    // `postedAt` is `posted.length` at the call: nothing after `indexing` had been posted yet.
    assert.ok(attempts[0]!.postedAt <= indexedAt, 'started before indexing finished');
    assert.equal(posted[indexedAt]?.state, 'indexed', 'the index finished with the download still pending (never awaited)');
  });

  it('Local: a regenerate joins the download in flight; a failed download is "The local model failed to load…"', async () => {
    await requestMap();
    const from = posted.length;
    const result = await regenerate('w1', () => {
      setTimeout(() => attempts[0]!.reject(new Error('network down (test)')), 20);
    });
    assert.equal(downloads(), 1, 'joined the in-flight download; no second one');
    assert.deepEqual(result, { status: 'error', message: 'The local model failed to load — no summary backend is available.' });
    assert.equal(postedSince(from, 'graphService:modelStatus').at(-1)?.state, 'error');
    await runsIdle();
    assert.equal(calls.localSummarize + calls.localJudge, 0);
  });

  it('Local: a regenerate with nothing downloaded starts the download, then fails as today', async () => {
    const result = await regenerate('w1', () => {
      setTimeout(() => attempts[1]?.reject(new Error('still down (test)')), 20);
    });
    assert.equal(downloads(), 2, 'the regenerate started a fresh attempt');
    assert.equal(result.status, 'error');
  });

  it('review round 1: after a failed download, implicit re-kicks never start another; the model Retry does', { timeout: 20_000 }, async () => {
    const from = posted.length;
    for (let i = 0; i < 3; i += 1) {
      await requestMap();
    }
    switchBackend('local');
    await settle();
    await runsIdle();
    assert.equal(downloads(), 2, 'cache-served re-kicks and a re-affirm only join; nothing in flight, so no attempt');
    assert.deepEqual(postedSince(from, 'graphService:modelStatus'), [], 'no Downloading flash either');
    send({ type: 'graphService:retryModel' });
    await settle();
    assert.equal(downloads(), 3, 'the explicit Retry starts one');
    attempts[2]!.reject(new Error('down again (test)'));
    await waitFor(() => postedSince(from, 'graphService:modelStatus').find((message) => message.state === 'error'), 'the retry to fail');
    await runsIdle();
  });

  it('Cloud with a key: no download, no model status; cloud summaries generate; no Cloud consumer reaches the local branch', { timeout: 20_000 }, async () => {
    const from = posted.length;
    await index(SECOND_PROJECT, true, { activeBackend: 'cloud', cloudApiKey: KEY });
    await requestMap();
    await runsIdle();
    assert.ok(calls.cloudSummarize > 0, 'cloud summaries generated');
    assert.ok(calls.cloudJudge > 0, 'cloud judgments generated');
    // Every other Cloud trigger: a cache-served switch (re-kick), a key
    // re-affirm, and a regenerate.
    await requestMap();
    switchBackend('cloud', KEY);
    await settle();
    await runsIdle();
    const result = await regenerate('w1');
    assert.equal(result.status, 'ok');
    // Review round 1: the model Retry is a no-op under Cloud (the last
    // attempt failed, so without the gate it would start one).
    send({ type: 'graphService:retryModel' });
    await settle();
    assert.equal(downloads(), 3, 'no ensureLocalModel call under Cloud');
    assert.deepEqual(postedSince(from, 'graphService:modelStatus'), [], 'no model status under Cloud');
    assert.equal(calls.localSummarize + calls.localJudge, 0);
  });

  it('Cloud without a key: no download, no model status, no generation', { timeout: 20_000 }, async () => {
    const from = posted.length;
    const cloudCalls = calls.cloudSummarize + calls.cloudJudge;
    await index(SECOND_PROJECT, true, { activeBackend: 'cloud' });
    await requestMap();
    await requestMap();
    await runsIdle();
    const result = await regenerate('w2');
    assert.deepEqual(result, { status: 'error', message: 'Cloud is selected but no API key is set — add one in Settings.' });
    assert.equal(downloads(), 3);
    assert.deepEqual(postedSince(from, 'graphService:modelStatus'), []);
    assert.equal(calls.cloudSummarize + calls.cloudJudge, cloudCalls, 'blocked, never a silent fallback');
    assert.equal(calls.localSummarize + calls.localJudge, 0);
  });

  it('Cloud → Local mid-session starts one download (concurrent kicks join it); Local → Cloud mid-download runs no local generation', { timeout: 20_000 }, async () => {
    switchBackend('local');
    await settle();
    assert.equal(downloads(), 4, 'the genuine switch to Local started the download');
    // More kicks while it is in flight: cache-served switches re-kick summary
    // and judgment; a re-affirm restarts all runs. None downloads again.
    await requestMap();
    await requestMap();
    switchBackend('local');
    await settle();
    assert.equal(downloads(), 4, 'every concurrent kick joined the one in flight');
    // Review round 1: a regenerate waiting on the same download.
    const regenerateFrom = posted.length;
    send({ type: 'graphService:regenerateNode', nodeId: 'w1' });
    await settle();
    // Back to Cloud before the download finishes.
    switchBackend('cloud');
    await settle();
    const from = posted.length;
    attempts[3]!.resolve(FALLBACK_MODEL);
    await waitFor(() => postedSince(from, 'graphService:modelStatus').find((message) => message.state === 'ready'), 'the download to finish');
    const regenerated = await waitFor(
      () => postedSince(regenerateFrom, 'graphService:regenerateNodeResult').find((message) => message.nodeId === 'w1'),
      'the regenerate reply',
    );
    assert.deepEqual(regenerated.result, {
      status: 'error',
      message: 'The summary backend or project changed while the local model was loading — nothing was regenerated.',
    });
    await settle();
    await runsIdle();
    assert.equal(calls.localSummarize + calls.localJudge, 0, 'no local step under Cloud: the superseded runs and the regenerate stopped');
    assert.deepEqual(postedSince(from, 'graphService:hardwareAdvisory'), [], 'no advisory for a download finishing under Cloud');
  });

  it('Cloud → Local after the download: no second download; summaries then generate', { timeout: 20_000 }, async () => {
    switchBackend('local');
    await settle();
    await runsIdle();
    assert.equal(downloads(), 4, 'the memo: no second download');
    // A genuine switch clears summaries (not judgments: the Cloud phase's
    // judgments stay), so the summary run is the one that must generate.
    assert.ok(calls.localSummarize > 0, 'local summaries generated');
    const result = await regenerate('w1');
    assert.equal(result.status, 'ok');
    assert.equal(downloads(), 4);
  });

  it('constrained hardware under Cloud: no advisory check; under Local the advisory posts and the memo holds', { timeout: 20_000 }, async () => {
    let from = posted.length;
    await index(PROJECT, true, { activeBackend: 'cloud', cloudApiKey: KEY });
    await settle(100);
    assert.deepEqual(postedSince(from, 'graphService:hardwareAdvisory'), [], 'no constrained-tier advisory under Cloud');
    assert.deepEqual(postedSince(from, 'graphService:modelStatus'), []);
    assert.equal(downloads(), 4);
    // Positive control: the same fallback-tier model under Local.
    from = posted.length;
    await index(SECOND_PROJECT, true, { activeBackend: 'local' });
    await waitFor(() => postedSince(from, 'graphService:hardwareAdvisory')[0], 'the constrained-tier advisory');
    assert.equal(postedSince(from, 'graphService:hardwareAdvisory')[0]?.reason, 'constrained-tier');
    assert.equal(downloads(), 4, 'second project under Local: the memo, no second download');
  });
});
