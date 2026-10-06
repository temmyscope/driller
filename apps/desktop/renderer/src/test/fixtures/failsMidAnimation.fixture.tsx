/**
 * P4-8d fixture (not a test file: no `*.test.*` pattern picks it up). One
 * test that fails while React Flow is still animating a move to a Node. Run
 * by `domEnv.animationExit.test.ts`, which checks the file still exits
 * promptly: `cleanupAfterEach` must finish or stop the animation, or d3
 * would wait forever on a frame from the closed window.
 */
import '../domEnv';
import { animatingElements, cleanupAfterEach } from '../domEnv';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, waitFor } from '@testing-library/react';
import { CodeMap } from '../../CodeMap';
import { createFakeDrillerApi } from '../fakeDrillerApi';
import { FIXTURE_NODES, FIXTURE_PROJECT_PATH, pathTraceBasicMap } from '../mapFixture';

afterEach(cleanupAfterEach);

export const MID_ANIMATION_FAILURE = 'deliberate failure while the viewport is animating';

it('fails while React Flow is still animating a move', async () => {
  createFakeDrillerApi({
    getCodeMap: async () => pathTraceBasicMap(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
  }).install();
  const noop = () => {};
  render(
    <CodeMap
      projectPath={FIXTURE_PROJECT_PATH}
      noSummaryBackendAvailable={false}
      cloudSelectedNoKey={false}
      mode="codeMap"
      onRequestCodeMapMode={noop}
      graphServiceAvailable
      dataVersion={0}
      onMapState={noop}
      onDiffScopeSynced={noop}
      onOpenSettings={noop}
      onReindex={async () => true}
      onSwitchSection={noop}
      // Moving to a Node once the map is drawn starts a 300 ms animated move.
      pendingFocusNodeId={FIXTURE_NODES.cacheLookup.id}
    />,
  );
  await waitFor(() => assert.ok(animatingElements().length > 0, 'the move started'), { timeout: 2_000 });
  throw new Error(MID_ANIMATION_FAILURE);
});
