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
  // P3-6: the "paused until you add a key" clause moved to the backend
  // group's "Cloud selected, no key" notice, so it isn't said twice.
  it('says only "Key removed." and notifies when Cloud is active and main relayed', () => {
    assert.deepEqual(keyRemovedOutcome({ config: config('cloud'), relayed: true }), {
      notice: 'Key removed.',
      notify: true,
    });
  });

  it('says only "Key removed." and does not notify when Cloud is active and nothing was relayed', () => {
    assert.deepEqual(keyRemovedOutcome({ config: config('cloud'), relayed: false }), {
      notice: 'Key removed.',
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
