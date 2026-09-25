/**
 * P2-6: a key-change relay (same backend re-sent) is a reaffirm, which keeps
 * summaries; only a genuine local<->cloud change is a switch, which clears
 * them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { backendSwitchKind } from './backend-switch';

describe('backendSwitchKind', () => {
  it('treats the same backend re-sent as a reaffirm, so summaries survive a key-change relay', () => {
    assert.equal(backendSwitchKind('cloud', 'cloud'), 'reaffirm');
    assert.equal(backendSwitchKind('local', 'local'), 'reaffirm');
  });

  it('treats a local<->cloud change as a switch', () => {
    assert.equal(backendSwitchKind('local', 'cloud'), 'switch');
    assert.equal(backendSwitchKind('cloud', 'local'), 'switch');
  });
});
