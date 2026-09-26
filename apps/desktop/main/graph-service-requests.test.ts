/**
 * P2-10: AD-4's one sanctioned key hop, at the two send sites. Under Local
 * neither request carries a key field and main never decrypts; under Cloud
 * the key rides along only when a non-blank key could be read.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CloudBackend } from '@driller/ipc-contracts';

import {
  buildBackendSwitchedRequest,
  buildIndexRequest,
  cloudKeyField,
  type DecryptCloudKey,
} from './graph-service-requests';

/** A decrypt that counts its calls. */
function countingDecrypt(result: string | undefined | Error): { decrypt: DecryptCloudKey; calls: () => number } {
  let calls = 0;
  return {
    decrypt: () => {
      calls += 1;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    calls: () => calls,
  };
}

/** Runs `fn` with `console.error` captured. */
function captureErrors<T>(fn: () => T): { value: T; logged: unknown[][] } {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    return { value: fn(), logged };
  } finally {
    console.error = original;
  }
}

function indexRequest(activeBackend: CloudBackend, decrypt: DecryptCloudKey, includedPaths: string[] = []) {
  return buildIndexRequest({ projectPath: '/repo/a', activeBackend, includedPaths, decrypt });
}

describe('buildIndexRequest', () => {
  it('sends no key field and never decrypts while Local is active', () => {
    const { decrypt, calls } = countingDecrypt('sk-secret');
    const request = indexRequest('local', decrypt);
    assert.deepEqual(request, { type: 'graphService:index', path: '/repo/a', activeBackend: 'local' });
    assert.equal('cloudApiKey' in request, false);
    assert.equal(calls(), 0);
  });

  it('carries the key while Cloud is active and a key is stored', () => {
    const { decrypt, calls } = countingDecrypt('sk-secret');
    assert.deepEqual(indexRequest('cloud', decrypt, ['src']), {
      type: 'graphService:index',
      path: '/repo/a',
      activeBackend: 'cloud',
      cloudApiKey: 'sk-secret',
      includedPaths: ['src'],
    });
    assert.equal(calls(), 1);
  });

  it('omits the key field under Cloud with no key stored', () => {
    const request = indexRequest('cloud', () => undefined);
    assert.equal('cloudApiKey' in request, false);
  });
});

describe('buildBackendSwitchedRequest', () => {
  it('sends no key field and never decrypts when switching to Local', () => {
    const { decrypt, calls } = countingDecrypt('sk-secret');
    const request = buildBackendSwitchedRequest({ activeBackend: 'local', decrypt });
    assert.deepEqual(request, { type: 'graphService:backendSwitched', activeBackend: 'local' });
    assert.equal(calls(), 0);
  });

  it('carries the key when switching to Cloud with a key stored', () => {
    assert.deepEqual(buildBackendSwitchedRequest({ activeBackend: 'cloud', decrypt: () => 'sk-secret' }), {
      type: 'graphService:backendSwitched',
      activeBackend: 'cloud',
      cloudApiKey: 'sk-secret',
    });
  });
});

describe('cloudKeyField', () => {
  it('treats a throwing decrypt as no key, logging a fixed sentence without the error text', () => {
    const { value, logged } = captureErrors(() =>
      cloudKeyField('cloud', () => {
        throw new Error('bad padding near sk-secret');
      }),
    );
    assert.deepEqual(value, {});
    assert.equal(logged.length, 1);
    assert.ok(!JSON.stringify(logged).includes('sk-secret'));
    assert.ok(!JSON.stringify(logged).includes('bad padding'));
  });

  it('treats a whitespace-only key as no key', () => {
    assert.deepEqual(cloudKeyField('cloud', () => '  \t\n'), {});
    assert.deepEqual(cloudKeyField('cloud', () => ''), {});
  });
});
