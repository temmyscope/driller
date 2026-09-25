/**
 * P2-6: removing the cloud key deletes the stored entry (never blanks it),
 * turns `hasCloudKey` false, and reports nothing removed when no key is
 * stored.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CloudBackend } from '@driller/ipc-contracts';

import { backendConfigFrom, removeCloudKey, type CloudKeyStore } from './cloud-key-store';

/** A store over a plain record, like electron-store's JSON file. */
function fakeStore(initial: { activeBackend: CloudBackend; cloudKeyCiphertextBase64?: string }): {
  store: CloudKeyStore;
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    store: {
      getActiveBackend: () => data.activeBackend as CloudBackend,
      getCloudKeyCiphertextBase64: () => data.cloudKeyCiphertextBase64 as string | undefined,
      deleteCloudKeyCiphertextBase64: () => {
        delete data.cloudKeyCiphertextBase64;
      },
    },
  };
}

describe('removeCloudKey', () => {
  it('deletes the stored entry rather than blanking it', () => {
    const { store, data } = fakeStore({ activeBackend: 'cloud', cloudKeyCiphertextBase64: 'Y2lwaGVy' });
    assert.equal(removeCloudKey(store), true);
    assert.equal('cloudKeyCiphertextBase64' in data, false);
  });

  it('turns hasCloudKey false and leaves the active backend alone', () => {
    const { store } = fakeStore({ activeBackend: 'cloud', cloudKeyCiphertextBase64: 'Y2lwaGVy' });
    assert.equal(backendConfigFrom(store, false).hasCloudKey, true);
    removeCloudKey(store);
    assert.deepEqual(backendConfigFrom(store, false), {
      activeBackend: 'cloud',
      hasCloudKey: false,
      isLinuxInsecureBackend: false,
    });
  });

  it('reports nothing removed when no key is stored', () => {
    const { store, data } = fakeStore({ activeBackend: 'local' });
    assert.equal(removeCloudKey(store), false);
    assert.deepEqual(data, { activeBackend: 'local' });
  });

  it('propagates a store write failure', () => {
    const { store } = fakeStore({ activeBackend: 'local', cloudKeyCiphertextBase64: 'Y2lwaGVy' });
    store.deleteCloudKeyCiphertextBase64 = () => {
      throw new Error('EACCES');
    };
    assert.throws(() => removeCloudKey(store), /EACCES/);
  });
});
