/**
 * P4-4h carry review: main's `diffScope:carry` relay — project mismatch, no
 * service, a `postMessage` throw, the timeout, settle-on-exit, the reply's
 * validation, and a late reply for a settled request — through injected
 * dependencies (no Electron, no real timers).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { GraphServiceDiffScopeCarryRequest } from '@driller/ipc-contracts';

import { createDiffScopeCarryRelay, isDiffScopeCarryResultMessage } from './diff-scope-carry-relay';
import { parseDiffScopeCarryArgs } from './section-operations';

/** Every awaiting test fails fast (never hangs the file) if a promise is left unsettled. */
const FAST = { timeout: 2_000 };

const ARGS = (() => {
  const args = parseDiffScopeCarryArgs('/p', 'web', 'api', 'main');
  assert.ok(args.ok);
  return args;
})();

function harness({ project = '/p', throwOnPost = false, running = true } = {}) {
  const sent: GraphServiceDiffScopeCarryRequest[] = [];
  const timers = new Map<number, () => void>();
  const cleared: unknown[] = [];
  let nextTimer = 0;
  const relay = createDiffScopeCarryRelay({
    service: () =>
      running
        ? {
            postMessage: (message) => {
              if (throwOnPost) {
                throw new Error('port closed');
              }
              sent.push(message);
            },
          }
        : null,
    currentProjectPath: () => project,
    setTimer: (callback) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimer: (timer) => {
      cleared.push(timer);
      timers.delete(timer as number);
    },
  });
  return { relay, sent, timers, cleared };
}

describe('createDiffScopeCarryRelay', () => {
  it('sends the request and settles it by its reply (validated), clearing the timer', FAST, async () => {
    const { relay, sent, timers, cleared } = harness();
    const promise = relay.request(ARGS);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.type, 'graphService:diffScopeCarry');
    assert.equal(relay.pendingCount(), 1);
    relay.settleReply(sent[0]!.requestId, { status: 'ref-exists', junk: 1 });
    assert.deepEqual(await promise, { status: 'ref-exists' });
    assert.equal(relay.pendingCount(), 0);
    assert.equal(timers.size, 0);
    assert.equal(cleared.length, 1);
  });

  it('a malformed reply settles as an error', FAST, async () => {
    const { relay, sent } = harness();
    const promise = relay.request(ARGS);
    relay.settleReply(sent[0]!.requestId, { status: 'perhaps' });
    assert.equal((await promise).status, 'error');
  });

  it('another project, or no running service, answers at once and sends nothing', FAST, async () => {
    const other = harness({ project: '/other' });
    assert.deepEqual(await other.relay.request(ARGS), {
      status: 'error',
      message: 'The requested project is not the currently open project.',
    });
    assert.equal(other.sent.length, 0);
    assert.equal(other.relay.pendingCount(), 0);
    const stopped = harness({ running: false });
    assert.deepEqual(await stopped.relay.request(ARGS), { status: 'error', message: 'Graph Service is not running.' });
    assert.equal(stopped.timers.size, 0);
  });

  it('a postMessage throw settles as an error and leaves nothing pending', FAST, async () => {
    const { relay, timers } = harness({ throwOnPost: true });
    const result = await relay.request(ARGS);
    assert.equal(result.status, 'error');
    assert.match(result.status === 'error' ? result.message : '', /port closed/);
    assert.equal(relay.pendingCount(), 0);
    assert.equal(timers.size, 0);
  });

  it('the timeout settles as an error; a late reply is then ignored', FAST, async () => {
    const { relay, sent, timers } = harness();
    const promise = relay.request(ARGS);
    const [fire] = [...timers.values()];
    fire?.();
    assert.deepEqual(await promise, {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to check the base ref.',
    });
    relay.settleReply(sent[0]!.requestId, { status: 'same-repository' });
    assert.equal(relay.pendingCount(), 0);
  });

  it('overlapping checks each settle by their own id; settle-on-exit settles the rest', FAST, async () => {
    const { relay, sent, timers } = harness();
    const first = relay.request(ARGS);
    const second = relay.request(ARGS);
    const third = relay.request(ARGS);
    assert.notEqual(sent[0]!.requestId, sent[1]!.requestId);
    relay.settleReply(sent[1]!.requestId, { status: 'not-carried' });
    assert.deepEqual(await second, { status: 'not-carried' });
    relay.settleAll('Graph Service exited before the base ref could be checked.');
    for (const result of await Promise.all([first, third])) {
      assert.deepEqual(result, { status: 'error', message: 'Graph Service exited before the base ref could be checked.' });
    }
    assert.equal(relay.pendingCount(), 0);
    assert.equal(timers.size, 0);
  });
});

describe('isDiffScopeCarryResultMessage', () => {
  it('only the carry reply with a numeric request id', () => {
    assert.equal(isDiffScopeCarryResultMessage({ type: 'graphService:diffScopeCarryResult', requestId: 1, result: {} }), true);
    assert.equal(isDiffScopeCarryResultMessage({ type: 'graphService:diffScopeCarryResult', requestId: '1' }), false);
    assert.equal(isDiffScopeCarryResultMessage({ type: 'graphService:computeDiffScopeResult', requestId: 1 }), false);
    assert.equal(isDiffScopeCarryResultMessage(null), false);
  });
});

describe('index.ts uses the relay (source)', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('for requests, replies and exit', () => {
    assert.match(src, /service: \(\) => \(graphService && !isGraphServiceShuttingDown \? graphService : null\),/);
    assert.match(src, /return args\.ok \? diffScopeCarryRelay\.request\(args\) : Promise\.resolve\(args\.result\);/);
    assert.match(src, /if \(isDiffScopeCarryResultMessage\(message\)\) \{\s*diffScopeCarryRelay\.settleReply\(message\.requestId, message\.result\);/);
    assert.match(src, /diffScopeCarryRelay\.settleAll\('Graph Service exited before the base ref could be checked\.'\);/);
  });
});
