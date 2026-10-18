/**
 * P5-c (founder decision 4.7), the acceptance sequence in a fresh process:
 * a project opened under Cloud downloads nothing; a Cloud→Local switch then
 * starts exactly one download, and the summaries generate once it is
 * ready, with no further trigger: the restarted summary run joins the
 * download and waits for it. On a fallback-tier model the constrained-tier
 * advisory follows, once (review round 1).
 *
 * Its own file because `index.ts` is loaded once per process and the model
 * memo, once ready, lasts for it: `model-download-gating.test.ts` needs the
 * download still pending at its own Cloud→Local switch.
 *
 * Nothing on `index.ts`'s import graph is imported statically here: the
 * harness's module hooks must be registered before it first loads.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { posted, makeFixtureProject, removeHarnessTempDirs, send, startIndexTs, waitFor, type Posted } from './scoped-code-map-harness';

type Step = (node: { id: string }) => Promise<{ kind: 'success'; text: string }>;
const harness = globalThis as {
  __harnessModel?: () => Promise<unknown>;
  __harnessModelCount?: number;
  __harnessSummarize?: Step;
  __harnessJudge?: Step;
};

const PROJECT = makeFixtureProject();
let release: ((value: unknown) => void) | undefined;
harness.__harnessModel = () =>
  new Promise((resolve) => {
    release = resolve;
  });
const summarized = new Set<string>();
harness.__harnessSummarize = async (node) => {
  summarized.add(node.id);
  return { kind: 'success', text: `summary of ${node.id}` };
};
harness.__harnessJudge = async (node) => ({ kind: 'success', text: `judgment of ${node.id}` });

const downloads = (): number => harness.__harnessModelCount ?? 0;

after(async () => {
  harness.__harnessModel = undefined;
  harness.__harnessSummarize = undefined;
  harness.__harnessJudge = undefined;
  await removeHarnessTempDirs();
});

describe('P5-c: Cloud, then a switch to Local', () => {
  it('Cloud index: 0 downloads; Cloud→Local: 1, and summaries then generate', { timeout: 20_000 }, async () => {
    const indexModule = await startIndexTs(PROJECT, { activeBackend: 'cloud' });
    const from = posted.length;
    send({ type: 'graphService:getCodeMap' });
    const reply = await waitFor(() => posted.slice(from).find((message: Posted) => message.type === 'graphService:codeMap'), 'the Code Map');
    assert.ok(Array.isArray(reply.nodes));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(downloads(), 0, 'nothing downloaded under Cloud');
    assert.equal(posted.filter((message) => message.type === 'graphService:modelStatus').length, 0, 'no model status under Cloud');

    send({ type: 'graphService:backendSwitched', activeBackend: 'local' });
    await waitFor(() => (release ? true : undefined), 'the switch to start the download');
    assert.equal(downloads(), 1);
    // A fallback-tier model: the constrained-tier nudge must follow the
    // switch's download (review round 1), once.
    release!({ model: 'fixture.gguf', path: path.join(PROJECT, 'fixture.gguf'), tier: 'fallback' });
    await waitFor(() => posted.find((message) => message.type === 'graphService:modelStatus' && message.state === 'ready'), 'model ready');
    // No further trigger: the restarted summary run itself waited for the model.
    await waitFor(() => (summarized.size > 0 ? true : undefined), 'summaries to generate');
    const { getNodeRecord } = await import('./node-record-store');
    const id = [...summarized][0]!;
    // The record write follows the step's return.
    await waitFor(() => getNodeRecord(id)?.summary, `the summary record for ${id}`);
    assert.equal(getNodeRecord(id)?.summary?.text, `summary of ${id}`);
    assert.equal(downloads(), 1, 'exactly one download');
    const advisories = posted.filter((message) => message.type === 'graphService:hardwareAdvisory');
    assert.deepEqual(
      advisories.map((message) => message.reason),
      ['constrained-tier'],
      'the constrained-tier advisory posts once after the Cloud→Local download',
    );
    // Let both runs finish, so no record write lands after the temp dirs go.
    await waitFor(() => {
      const active = indexModule.peekActiveGenerationRunsForTests();
      return active.summary || active.judgment ? undefined : true;
    }, 'the summary and judgment runs to finish');
  });
});
