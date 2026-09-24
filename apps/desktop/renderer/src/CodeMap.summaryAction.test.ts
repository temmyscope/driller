/**
 * P1-2: the Node Detail panel's summary action — "Regenerate" for a `ready`
 * Node, "Generate summary" for a `pending` one (a failed generation leaves a
 * Node `pending` all session, so this is its only retry), and nothing for a
 * `coverage-gap` Node, which the service rejects outright.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SummaryStatus } from '@driller/ipc-contracts';

import { nodeDetailSummaryAction } from './CodeMap';

describe('nodeDetailSummaryAction', () => {
  it('offers Regenerate for a ready Node', () => {
    assert.deepEqual(nodeDetailSummaryAction('ready'), {
      label: 'Regenerate',
      busyLabel: 'Regenerating…',
    });
  });

  it('offers Generate summary for a pending Node', () => {
    assert.deepEqual(nodeDetailSummaryAction('pending'), {
      label: 'Generate summary',
      busyLabel: 'Generating…',
    });
  });

  it('offers no action for a coverage-gap Node', () => {
    assert.equal(nodeDetailSummaryAction('coverage-gap'), null);
  });

  it('offers no action for an unknown status arriving over IPC', () => {
    assert.equal(nodeDetailSummaryAction('generation-failed' as unknown as SummaryStatus), null);
  });
});
