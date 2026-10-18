/**
 * P5-b founder decision 1 (2026-10-15): a Code Map request served from the
 * raw cache re-kicks summary and judgment generation over the cached arrays,
 * so a Node a finished run left pending retries on the next switch — with no
 * fetch, no memo or identity change, and never a second concurrent run.
 *
 * Through the real `index.ts` (`scoped-code-map-harness.ts`), with the local
 * model ready and the per-Node summarize / judge steps replaced
 * (`__harnessSummarize` / `__harnessJudge`).
 *
 * Nothing on `index.ts`'s import graph is imported statically here: the
 * harness's module hooks must be registered before it first loads.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { getters, makeFixtureProject, posted, removeHarnessTempDirs, send, startIndexTs, waitFor, type Posted } from './scoped-code-map-harness';

type Step = (node: { id: string }) => Promise<{ kind: 'success'; text: string }>;
const harness = globalThis as {
  __harnessModel?: () => Promise<unknown>;
  __harnessSummarize?: Step;
  __harnessJudge?: Step;
  __harnessFetchCount?: number;
  __harnessLcovCount?: number;
};

const PROJECT = makeFixtureProject();
const FLAKY = 'w3';
const calls = { summarize: new Map<string, number>(), judge: new Map<string, number>() };
let failing = true;
let flakyGate: Promise<void> | undefined;

const step =
  (kind: 'summarize' | 'judge'): Step =>
  async (node) => {
    calls[kind].set(node.id, (calls[kind].get(node.id) ?? 0) + 1);
    if (node.id === FLAKY) {
      if (failing) {
        throw new Error(`${kind} failed (test)`);
      }
      await flakyGate;
    }
    return { kind: 'success', text: `${kind} of ${node.id}` };
  };

harness.__harnessModel = () => Promise.resolve({ model: 'fixture.gguf', path: path.join(PROJECT, 'fixture.gguf'), tier: 'primary' });
harness.__harnessSummarize = step('summarize');
harness.__harnessJudge = step('judge');

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

async function runsIdle(): Promise<void> {
  assert.ok(indexModule);
  const module = indexModule;
  await waitFor(() => {
    const active = module.peekActiveGenerationRunsForTests();
    return active.summary || active.judgment ? undefined : true;
  }, 'the summary and judgment runs to finish');
}

after(async () => {
  harness.__harnessSummarize = undefined;
  harness.__harnessJudge = undefined;
  harness.__harnessModel = undefined;
  await removeHarnessTempDirs();
});

before(async () => {
  indexModule = await startIndexTs(PROJECT);
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: ['web', 'api'] });
  assert.equal((await requestMap()).type, 'graphService:codeMap');
  // Wait for the runs to start (the model resolves first), then to finish.
  await waitFor(() => ((calls.summarize.get(FLAKY) ?? 0) > 0 && (calls.judge.get(FLAKY) ?? 0) > 0 ? true : undefined), 'both runs to reach w3');
  await runsIdle();
});

describe('P5-b founder decision 1: a cache-served request retries what a finished run left pending', () => {
  it('a later switch retries the failed Node once, fills it in, and keeps every cache and memo; a run in flight makes a second switch a no-op', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const module = indexModule;
    const { getNodeRecord } = await import('./node-record-store');
    assert.equal(getNodeRecord(FLAKY)?.summary, undefined, 'the first run left w3 without a summary');
    assert.equal(getNodeRecord(FLAKY)?.llmJudgment, undefined, 'and without a judgment');
    assert.equal(getNodeRecord('w1')?.summary?.text, 'summarize of w1');
    const summarizedOnce = new Map(calls.summarize);
    const judgedOnce = new Map(calls.judge);

    module.computeEntryCandidatesResult(PROJECT);
    module.computeEntryCandidatesResult(PROJECT, 'api');
    module.getSectionCodeMap('api');
    const snapshot = () => ({
      nodes: getters().getNodes(),
      edges: module.peekActiveCodeMapEdgesForTests(),
      raw: module.getActiveRawCodeMap(),
      entryWhole: module.peekEntryCandidatesMemoForTests().whole,
      entryApi: module.peekEntryCandidatesMemoForTests().sections?.get('api'),
      sectionBuildApi: module.peekSectionCodeMapMemoForTests()?.get('api'),
    });
    const before = snapshot();
    const ioBefore = io();

    // The retry succeeds, but holds at w3 so a second switch lands mid-run.
    failing = false;
    let release!: () => void;
    flakyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await requestMap('api');
      await waitFor(() => (module.peekActiveGenerationRunsForTests().summary ? true : undefined), 'the retry run to start');
      await requestMap('web');
      await requestMap();
    } finally {
      release();
    }
    await waitFor(
      () => (getNodeRecord(FLAKY)?.summary !== undefined && getNodeRecord(FLAKY)?.llmJudgment !== undefined ? true : undefined),
      'w3 to be filled in',
    );
    await runsIdle();
    flakyGate = undefined;

    assert.equal(getNodeRecord(FLAKY)?.summary?.text, 'summarize of w3');
    assert.equal(getNodeRecord(FLAKY)?.llmJudgment?.text, 'judge of w3');
    assert.equal(calls.summarize.get(FLAKY), 2, 'w3 summarized once more — never by a second concurrent run');
    assert.equal(calls.judge.get(FLAKY), 2, 'w3 judged once more');
    for (const [id, count] of summarizedOnce) {
      if (id !== FLAKY) {
        assert.equal(calls.summarize.get(id), count, `${id} is not summarized again`);
      }
    }
    for (const [id, count] of judgedOnce) {
      if (id !== FLAKY) {
        assert.equal(calls.judge.get(id), count, `${id} is not judged again`);
      }
    }
    assert.deepEqual(io(), ioBefore, 'no fetch and no LCOV load');
    const after = snapshot();
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      assert.ok(before[key] !== undefined && before[key] !== null, `${key} was set`);
      assert.equal(after[key], before[key], `${key} is the same object`);
    }
    // The next cache-served reply shows the retried summary.
    const reply = await requestMap();
    const w3 = (reply.nodes as { id: string; summary?: string }[]).find((node) => node.id === FLAKY);
    assert.equal(w3?.summary, 'summarize of w3');
  });
});
