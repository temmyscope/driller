/**
 * P5-g (founder approval 2026-10-15): a failed backend save rejects with the
 * actionable message only; the raw store error (with its userData path)
 * goes to the local diagnostic log.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKEND_SETTING_SAVE_FAILED_MESSAGE, type CloudBackend, type DiagnosticLogEntry } from '@driller/ipc-contracts';

import { saveActiveBackend } from './backend-switch-save';

const RAW =
  "EPERM: operation not permitted, rename '/Users/someone/Library/Application Support/driller/driller-backend-settings.json.tmp' -> '/Users/someone/Library/Application Support/driller/driller-backend-settings.json'";

describe('saveActiveBackend', () => {
  it('saves and logs nothing on success', () => {
    const saved: CloudBackend[] = [];
    const logged: DiagnosticLogEntry[] = [];
    saveActiveBackend('cloud', { save: (b) => saved.push(b), log: (e) => logged.push(e) });
    assert.deepEqual(saved, ['cloud']);
    assert.deepEqual(logged, []);
  });

  it('a store failure rejects with the actionable message, never the raw error or a path', () => {
    const logged: DiagnosticLogEntry[] = [];
    assert.throws(
      () =>
        saveActiveBackend('cloud', {
          save: () => {
            throw new Error(RAW);
          },
          log: (e) => logged.push(e),
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, BACKEND_SETTING_SAVE_FAILED_MESSAGE);
        assert.ok(!error.message.includes('EPERM') && !error.message.includes('/Users/'));
        return true;
      },
    );
    assert.equal(BACKEND_SETTING_SAVE_FAILED_MESSAGE, "the backend setting couldn't be saved — check that the app's data folder is writable");
  });

  it('the raw error goes to the local diagnostic log only', () => {
    const logged: DiagnosticLogEntry[] = [];
    assert.throws(() =>
      saveActiveBackend('local', {
        save: () => {
          throw new Error(RAW);
        },
        log: (e) => logged.push(e),
        now: () => new Date('2026-10-18T10:00:00.000Z'),
      }),
    );
    assert.deepEqual(logged, [
      { eventType: 'backend-setting-save-failed', timestamp: '2026-10-18T10:00:00.000Z', backend: 'local', error: RAW },
    ]);
    // A non-Error throw is logged as its string.
    const more: DiagnosticLogEntry[] = [];
    assert.throws(() =>
      saveActiveBackend('cloud', {
        save: () => {
          throw 'disk full';
        },
        log: (e) => more.push(e),
      }),
    );
    assert.equal((more[0] as { error: string }).error, 'disk full');
  });
});
