/**
 * P2-9: Cmd/Ctrl+O opens the folder picker once, ignores repeats while an
 * open is in flight or the shortcut is blocked, and recovers after a
 * rejected open.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMenuOpenFolderHandler } from './menuOpenFolder';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createMenuOpenFolderHandler', () => {
  it('calls open once when idle', async () => {
    let calls = 0;
    const handler = createMenuOpenFolderHandler({
      isBlocked: () => false,
      open: async () => {
        calls += 1;
      },
    });
    await handler();
    assert.equal(calls, 1);
  });

  it('ignores a second call while the first is pending, then accepts one after it settles', async () => {
    let calls = 0;
    const pending = deferred();
    const handler = createMenuOpenFolderHandler({
      isBlocked: () => false,
      open: () => {
        calls += 1;
        return calls === 1 ? pending.promise : Promise.resolve();
      },
    });
    const first = handler();
    await handler();
    assert.equal(calls, 1);
    pending.resolve();
    await first;
    await handler();
    assert.equal(calls, 2);
  });

  it('ignores a call while blocked', async () => {
    let calls = 0;
    const handler = createMenuOpenFolderHandler({
      isBlocked: () => true,
      open: async () => {
        calls += 1;
      },
    });
    await handler();
    assert.equal(calls, 0);
  });

  it('clears the in-flight flag when open rejects', async () => {
    let calls = 0;
    const handler = createMenuOpenFolderHandler({
      isBlocked: () => false,
      open: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('boom');
        }
      },
    });
    await assert.rejects(handler(), /boom/);
    await handler();
    assert.equal(calls, 2);
  });
});
