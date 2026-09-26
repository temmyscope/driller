/**
 * P2-6: a key save or removal reaches the running Graph Service only while
 * Cloud is active with a service running and a project open; the relay is
 * best-effort and never decrypts a key it won't post.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BackendConfig, CloudBackend, GraphServiceBackendSwitchedRequest } from '@driller/ipc-contracts';

import { keyChangeMessage, relayKeyChange, shouldRelayKeyChange, type KeyChangeRelayDeps } from './key-change-relay';

const OPEN = { serviceRunning: true, projectOpen: true };

describe('shouldRelayKeyChange', () => {
  it('does not relay while Local is active', () => {
    assert.equal(shouldRelayKeyChange({ activeBackend: 'local', ...OPEN }), false);
  });

  it('relays while Cloud is active with a service running and a project open', () => {
    assert.equal(shouldRelayKeyChange({ activeBackend: 'cloud', ...OPEN }), true);
  });

  it('does not relay when no Graph Service is running', () => {
    assert.equal(shouldRelayKeyChange({ activeBackend: 'cloud', serviceRunning: false, projectOpen: true }), false);
  });

  it('does not relay when no project is open', () => {
    assert.equal(shouldRelayKeyChange({ activeBackend: 'cloud', serviceRunning: true, projectOpen: false }), false);
  });
});

function config(activeBackend: CloudBackend, hasCloudKey: boolean): BackendConfig {
  return { activeBackend, hasCloudKey, isLinuxInsecureBackend: false };
}

/** Deps with a recording service and a counting decrypt. */
function fakeDeps(overrides: {
  activeBackend?: CloudBackend;
  key?: string;
  service?: 'running' | 'none' | 'throwing';
  currentProjectPath?: string | null;
}): { deps: KeyChangeRelayDeps; posted: GraphServiceBackendSwitchedRequest[]; decrypts: () => number } {
  const posted: GraphServiceBackendSwitchedRequest[] = [];
  let decryptCalls = 0;
  const serviceKind = overrides.service ?? 'running';
  const deps: KeyChangeRelayDeps = {
    getConfig: () => config(overrides.activeBackend ?? 'cloud', overrides.key !== undefined),
    decrypt: () => {
      decryptCalls += 1;
      return overrides.key;
    },
    service:
      serviceKind === 'none'
        ? null
        : {
            postMessage: (message) => {
              if (serviceKind === 'throwing') {
                throw new Error('process is exiting');
              }
              posted.push(message);
            },
          },
    currentProjectPath: overrides.currentProjectPath === undefined ? '/repo/a' : overrides.currentProjectPath,
  };
  return { deps, posted, decrypts: () => decryptCalls };
}

describe('relayKeyChange', () => {
  it('posts the decrypted new key after a save while Cloud is active with a project open', () => {
    const { deps, posted } = fakeDeps({ key: 'sk-new' });
    assert.equal(relayKeyChange(deps), true);
    assert.deepEqual(posted, [
      { type: 'graphService:backendSwitched', activeBackend: 'cloud', cloudApiKey: 'sk-new' },
    ]);
  });

  it('posts cloud with no key after a removal', () => {
    const { deps, posted } = fakeDeps({ key: undefined });
    assert.equal(relayKeyChange(deps), true);
    assert.deepEqual(posted, [{ type: 'graphService:backendSwitched', activeBackend: 'cloud' }]);
    assert.ok(posted[0] && !('cloudApiKey' in posted[0]));
  });

  it('posts nothing and never decrypts while Local is active', () => {
    const { deps, posted, decrypts } = fakeDeps({ activeBackend: 'local', key: 'sk-new' });
    assert.equal(relayKeyChange(deps), false);
    assert.deepEqual(posted, []);
    assert.equal(decrypts(), 0);
  });

  it('posts nothing and never decrypts with no running service', () => {
    const { deps, decrypts } = fakeDeps({ service: 'none', key: 'sk-new' });
    assert.equal(relayKeyChange(deps), false);
    assert.equal(decrypts(), 0);
  });

  it('posts nothing and never decrypts with no open project', () => {
    const { deps, posted, decrypts } = fakeDeps({ currentProjectPath: null, key: 'sk-new' });
    assert.equal(relayKeyChange(deps), false);
    assert.deepEqual(posted, []);
    assert.equal(decrypts(), 0);
  });

  it('a throwing post does not throw out of it and reports not relayed', () => {
    const { deps } = fakeDeps({ service: 'throwing', key: 'sk-new' });
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      assert.equal(relayKeyChange(deps), false);
    } finally {
      console.error = originalError;
    }
    assert.equal(logged.length, 1);
    assert.ok(!JSON.stringify(logged).includes('sk-new'));
  });

  it('a throwing decrypt does not throw out of it', () => {
    const { deps } = fakeDeps({ key: 'sk-new' });
    deps.decrypt = () => {
      throw new Error('decrypt failed');
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(relayKeyChange(deps), false);
    } finally {
      console.error = originalError;
    }
  });
});

describe('keyChangeMessage', () => {
  it('omits a blank key, like every other send of the key hop', () => {
    assert.deepEqual(keyChangeMessage('   '), { type: 'graphService:backendSwitched', activeBackend: 'cloud' });
  });
});
