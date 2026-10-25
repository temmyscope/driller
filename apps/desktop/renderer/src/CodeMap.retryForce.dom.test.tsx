/**
 * P5-b founder decision 2 (2026-10-15): the map's Retry buttons — a failed
 * load's, and a failed refresh's — always ask main for a fresh read
 * (`getCodeMap(section, {force: true})`); the first load and a `dataVersion`
 * refresh keep today's arguments, so the Graph Service may serve them from
 * its raw cache. `domEnv` must stay the first import (see its header).
 */
import './test/domEnv';
import { cleanupAfterEach } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CodeMapResult } from '@driller/ipc-contracts';
import { CodeMap } from './CodeMap';
import { createFakeDrillerApi, type FakeDrillerApi } from './test/fakeDrillerApi';
import { FIXTURE_NODES, FIXTURE_PROJECT_PATH, pathTraceBasicMap } from './test/mapFixture';

afterEach(cleanupAfterEach);

// `[2026-10-25]` Scaled for CI like the test budget beside it. A flat inner
// budget gave every `waitFor` half the allowance, relative to machine speed,
// that the test around it got — see `4a1c48b` and status.md's row on it.
const FIND = { timeout: 1_000 * (env.CI === 'true' ? 2 : 1) };

/** A fake whose `getCodeMap` answers from `replies` in order (the last one repeats). */
function sequenceFake(replies: (() => CodeMapResult)[]): FakeDrillerApi {
  let call = 0;
  const fake = createFakeDrillerApi({
    getCodeMap: async () => replies[Math.min(call++, replies.length - 1)]!(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
  });
  fake.install();
  return fake;
}

const failed = (): CodeMapResult => ({ status: 'error', message: 'backend down (test)' });

function codeMap(dataVersion: number) {
  const noop = () => {};
  return (
    <CodeMap
      projectPath={FIXTURE_PROJECT_PATH}
      noSummaryBackendAvailable={false}
      cloudSelectedNoKey={false}
      mode="codeMap"
      onRequestCodeMapMode={noop}
      graphServiceAvailable
      dataVersion={dataVersion}
      onMapState={noop}
      onDiffScopeSynced={noop}
      onOpenSettings={noop}
      onReindex={async () => true}
      onSwitchSection={noop}
    />
  );
}

/** The options argument of every `getCodeMap` call so far (`undefined` = none). */
const optionsOf = (fake: FakeDrillerApi): unknown[] => fake.calls.getCodeMap.map((args) => args[1]);

describe('P5-b founder decision 2: the map’s Retry forces a fresh read', () => {
  it('a failed load’s Retry sends {force: true}; the first load sends no options', { timeout: 10_000 }, async () => {
    const fake = sequenceFake([failed, pathTraceBasicMap]);
    render(codeMap(0));
    const retry = await screen.findByRole('button', { name: 'Retry' }, FIND);
    assert.deepEqual(optionsOf(fake), [undefined], 'the first load is unforced');
    await act(async () => {
      fireEvent.click(retry);
    });
    await screen.findByText(FIXTURE_NODES.handleRequest.name, { selector: '.react-flow__node *' }, FIND);
    assert.deepEqual(optionsOf(fake), [undefined, { force: true }]);
    assert.equal(fake.calls.getCodeMap.length, 2);
    assert.equal(fake.calls.getCodeMap[1]!.length, 2, 'section and options');
  });

  it('a failed refresh’s Retry sends {force: true}; the dataVersion refresh itself sends no options', { timeout: 10_000 }, async () => {
    const fake = sequenceFake([pathTraceBasicMap, failed, pathTraceBasicMap]);
    const { rerender } = render(codeMap(0));
    await screen.findByText(FIXTURE_NODES.handleRequest.name, { selector: '.react-flow__node *' }, FIND);
    rerender(codeMap(1));
    const retry = await screen.findByRole('button', { name: 'Retry the map refresh' }, FIND);
    assert.deepEqual(optionsOf(fake), [undefined, undefined], 'the load and the refresh are unforced');
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 3), FIND);
    await waitFor(() => assert.equal(screen.queryByRole('button', { name: 'Retry the map refresh' }), null), FIND);
    assert.deepEqual(optionsOf(fake), [undefined, undefined, { force: true }]);
  });
});
