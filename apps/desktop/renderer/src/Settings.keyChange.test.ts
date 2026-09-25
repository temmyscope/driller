/**
 * P2-6: what a successful key removal shows, and whether it re-kicks the
 * map — only when main actually relayed the change.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BackendConfig, CloudBackend } from '@driller/ipc-contracts';

import { keyRemovedOutcome } from './Settings';

function config(activeBackend: CloudBackend): BackendConfig {
  return { activeBackend, hasCloudKey: false, isLinuxInsecureBackend: false };
}

describe('keyRemovedOutcome', () => {
  it('says cloud summaries are paused and notifies when Cloud is active and main relayed', () => {
    assert.deepEqual(keyRemovedOutcome({ config: config('cloud'), relayed: true }), {
      notice: 'Key removed. Cloud summaries are paused until you add a key.',
      notify: true,
    });
  });

  it('keeps the paused wording but does not notify when Cloud is active and nothing was relayed', () => {
    assert.deepEqual(keyRemovedOutcome({ config: config('cloud'), relayed: false }), {
      notice: 'Key removed. Cloud summaries are paused until you add a key.',
      notify: false,
    });
  });

  it('says only "Key removed." and does not notify while Local is active', () => {
    assert.deepEqual(keyRemovedOutcome({ config: config('local'), relayed: false }), {
      notice: 'Key removed.',
      notify: false,
    });
  });
});
