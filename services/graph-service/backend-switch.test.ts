/**
 * P2-6: a key-change relay (same backend re-sent) is a reaffirm, which keeps
 * summaries; only a genuine local<->cloud change is a switch, which clears
 * them. P2-10 adds `nextBackendConfig`: the held key is replaced or dropped on
 * every request (AD-4 condition 5).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { backendSwitchKind, nextBackendConfig } from './backend-switch';

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

describe('nextBackendConfig (AD-4 condition 5)', () => {
  it('drops a previously held key when backendSwitched arrives without cloudApiKey', () => {
    let held = nextBackendConfig({ activeBackend: 'cloud', cloudApiKey: 'sk-old' });
    assert.equal(held.cloudApiKey, 'sk-old');
    // The key-change relay after a removal: same backend, no key.
    held = nextBackendConfig({ activeBackend: 'cloud' });
    assert.deepEqual(held, { activeBackend: 'cloud' });
    assert.equal('cloudApiKey' in held, false);
  });

  it('replaces the held key with the new one on a key change', () => {
    nextBackendConfig({ activeBackend: 'cloud', cloudApiKey: 'sk-old' });
    assert.deepEqual(nextBackendConfig({ activeBackend: 'cloud', cloudApiKey: 'sk-new' }), {
      activeBackend: 'cloud',
      cloudApiKey: 'sk-new',
    });
  });

  it('never keeps a key under Local, even if one is sent', () => {
    assert.deepEqual(nextBackendConfig({ activeBackend: 'local', cloudApiKey: 'sk-stray' }), { activeBackend: 'local' });
  });

  it('treats a blank key as no key', () => {
    assert.deepEqual(nextBackendConfig({ activeBackend: 'cloud', cloudApiKey: '  ' }), { activeBackend: 'cloud' });
  });
});
