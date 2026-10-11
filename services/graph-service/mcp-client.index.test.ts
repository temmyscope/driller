/**
 * FIX-6: `indexRepository` against stub backends — small Node scripts
 * standing in for `codebase-memory-mcp`, never the real one. A backend that
 * refuses to start, never answers its handshake, or stalls on
 * `index_repository` must end in a rejection (which the Graph Service posts
 * as the `error` status) that says why, never an endless "Indexing…".
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { captureBackendStderr, indexRepository, runCodeMapQueries, withBackendExplanation, type QueryGraphClient } from './mcp-client';

/** Real timers, kept before any test mocks them. */
const realSetTimeout = globalThis.setTimeout;

const REFUSAL =
  'CBM could not start because the active account daemon uses a different cache directory (active cache aaa; requested cache bbb). ' +
  'Close all CBM sessions and commands, then retry with one consistent CBM_CACHE_DIR.';

/** Every stub exits when its stdin ends, as the real backend does when the client closes. */
const EXIT_ON_STDIN_END = "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();";

const stub = (code: string) => ({ command: process.execPath, args: ['-e', `${EXIT_ON_STDIN_END}\n${code}`] });

/** CBM's refusal: one routine log line, its explanation on stderr, exit 1. */
const REFUSING = stub(`process.stderr.write('level=info msg=version_cohort.claimed_unheld\\ncodebase-memory-mcp: ${REFUSAL}\\n'); process.exit(1);`);

/** A wedged backend: alive, reads its stdin, never answers `initialize`. */
const SILENT = stub("process.stderr.write('level=info pid=' + process.pid + '\\n'); setInterval(() => {}, 1000);");

/** Answers `initialize`, then never answers anything else (a stalled `index_repository`). */
const STALLS_AFTER_HANDSHAKE = stub(`
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } } }) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stderr.write('codebase-memory-mcp: waiting for the account daemon\\n');
  }
});
setInterval(() => {}, 1000);
`);

/** Races `promise` against `ms`, so a regression fails fast instead of hanging the suite. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<PromiseSettledResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms (the hang)`)), ms);
  });
  try {
    return await Promise.race([Promise.allSettled([promise]).then(([result]) => result!), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `run` with this process's stderr captured (the stubs' echoed output). */
async function withStderrCaptured<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('indexRepository against a stub backend (FIX-6)', () => {
  it('a backend that refuses to start: rejects at once, quoting its explanation', async () => {
    const { result: outcome, stderr } = await withStderrCaptured(() =>
      settlesWithin(indexRepository('/repo', 30_000, { backend: REFUSING }), 10_000),
    );
    assert.match(stderr, /could not start/, 'still echoed to this process’s stderr');
    assert.equal(outcome.status, 'rejected');
    const message = (outcome as PromiseRejectedResult).reason.message as string;
    assert.match(message, /Connection closed/);
    assert.ok(message.endsWith(`— codebase-memory-mcp said: ${REFUSAL}`), message);
  });

  it('a backend that never answers its handshake: rejects within the connect bound, says what to do, and is torn down', async () => {
    const { result: outcome, stderr } = await withStderrCaptured(() =>
      settlesWithin(indexRepository('/repo', 30_000, { backend: SILENT, connectTimeoutMs: 500 }), 10_000),
    );
    assert.equal(outcome.status, 'rejected');
    assert.equal(
      (outcome as PromiseRejectedResult).reason.message,
      "the code-graph backend (codebase-memory-mcp) didn't answer within 1 s of starting. Close other codebase-memory-mcp sessions, then retry.",
    );
    const pid = Number(/pid=(\d+)/.exec(stderr)?.[1]);
    assert.ok(pid > 0, `the stub's stderr was echoed: ${JSON.stringify(stderr)}`);
    const deadline = Date.now() + 5_000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isAlive(pid), false, 'the stub backend is gone');
  });

  it('a backend that stalls on index_repository: the index budget ends it, with the backend’s last word', async () => {
    const outcome = await withStderrCaptured(() =>
      settlesWithin(indexRepository('/repo', 1_500, { backend: STALLS_AFTER_HANDSHAKE, connectTimeoutMs: 5_000 }), 10_000),
    );
    assert.equal(outcome.result.status, 'rejected');
    const message = (outcome.result as PromiseRejectedResult).reason.message as string;
    assert.match(message, /^index_repository \(\/repo\) timed out after 1500ms/);
    assert.match(message, /— codebase-memory-mcp said: waiting for the account daemon$/);
  });
});

describe('captureBackendStderr / withBackendExplanation', () => {
  it('keeps the last line that is not a routine log line', async () => {
    const { PassThrough } = await import('node:stream');
    const stream = new PassThrough();
    const { result: tail } = await withStderrCaptured(async () => {
      const captured = captureBackendStderr(stream);
      stream.write('codebase-memory-mcp: first\nlevel=info msg=a\n');
      stream.write('codebase-memory-mcp: second\nlevel=debug msg=b\n\n');
      await new Promise((resolve) => setImmediate(resolve));
      return captured;
    });
    assert.equal(tail.lastLine(), 'codebase-memory-mcp: second');
    assert.equal(captureBackendStderr(null).lastLine(), undefined);
  });

  it('appends the backend’s line once, and leaves the error alone when there is none', () => {
    const error = new Error('Connection closed');
    assert.equal(withBackendExplanation(error, undefined), error);
    const explained = withBackendExplanation(error, 'codebase-memory-mcp: CBM could not start');
    assert.equal(explained.message, 'Connection closed — codebase-memory-mcp said: CBM could not start');
    assert.equal(withBackendExplanation(explained, 'CBM could not start'), explained);
    assert.equal(withBackendExplanation('boom', undefined).message, 'boom');
  });
});

/**
 * Answers `initialize` at once. On `tools/call` it says so on stderr and
 * then answers after `REPLY_MS` of real time, or never when `REPLY_MS` is
 * negative.
 */
const slowIndexer = (replyMs: number) =>
  stub(`
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } } }) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stderr.write('level=info got tools/call\\n');
    if (${replyMs} >= 0) setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: JSON.stringify({ nodes: 3, edges: 2 }) }] } }) + '\\n'), ${replyMs});
  }
});
setInterval(() => {}, 1000);
`);

const realSleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

/**
 * Starts `indexRepository` against `backend` with mocked `setTimeout` (the
 * SDK's request timers and ours), waits in real time until the stub has the
 * `tools/call`, and hands back the call plus a way to read its state.
 */
async function startWithMockedTimers(backend: { command: string; args: string[] }, budgetMs: number) {
  let stderr = '';
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  const warn = mock.method(console, 'warn', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  const restore = () => {
    mock.timers.reset();
    warn.mock.restore();
    process.stderr.write = original;
  };
  const state: { outcome?: PromiseSettledResult<unknown> } = {};
  const call = indexRepository('/repo', budgetMs, { backend, connectTimeoutMs: 600_000 });
  void Promise.allSettled([call]).then(([result]) => (state.outcome = result));
  for (let waited = 0; !stderr.includes('got tools/call'); waited += 20) {
    if (waited > 10_000 || state.outcome !== undefined) {
      restore();
      throw new Error(`the stub never got the call: ${JSON.stringify(state.outcome)} ${stderr}`);
    }
    await realSleep(20);
  }
  return { outcome: (): PromiseSettledResult<unknown> | undefined => state.outcome, restore };
}

describe('MCP requests get their own budget, not the SDK’s 60 s default (FIX-6)', () => {
  it('index_repository answering after 61 s of (mocked) time is NOT cut at 60 s', async () => {
    const { outcome, restore } = await startWithMockedTimers(slowIndexer(300), 120_000);
    try {
      mock.timers.tick(61_000);
      await realSleep(100);
      assert.equal(outcome(), undefined, `cut at the SDK default: ${JSON.stringify(outcome())}`);
      for (let waited = 0; outcome() === undefined && waited < 10_000; waited += 20) await realSleep(20);
      assert.equal(outcome()?.status, 'fulfilled', JSON.stringify(outcome()));
      assert.deepEqual((outcome() as PromiseFulfilledResult<unknown>).value, { nodes: 3, edges: 2, coverage: undefined, project: undefined });
    } finally {
      restore();
    }
  });

  it('a request that never answers IS cut at the intended budget, with its own message', async () => {
    const { outcome, restore } = await startWithMockedTimers(slowIndexer(-1), 90_000);
    try {
      mock.timers.tick(61_000);
      await realSleep(100);
      assert.equal(outcome(), undefined, `cut before the budget: ${JSON.stringify(outcome())}`);
      mock.timers.tick(29_000);
      for (let waited = 0; outcome() === undefined && waited < 10_000; waited += 20) await realSleep(20);
      assert.equal(outcome()?.status, 'rejected');
      assert.equal(
        ((outcome() as PromiseRejectedResult).reason as Error).message,
        'index_repository (/repo) timed out after 90000ms',
      );
    } finally {
      restore();
    }
  });

  it('runCodeMapQueries gives the map queries the fetch budget and each evidence query the evidence budget', async () => {
    const seen: { query: string; options: unknown }[] = [];
    const client = {
      callTool: async (params: { arguments?: Record<string, unknown> }, options?: unknown) => {
        seen.push({ query: String(params.arguments?.query).slice(0, 40), options });
        return { content: [{ type: 'text', text: 'rows: 0  (cols: id)\ntotal: 0\n' }] };
      },
    } as unknown as QueryGraphClient;
    await runCodeMapQueries(client, 'p', { includeTestEvidence: true, includeImplements: true, includeSimilar: true }, 7_000, 180_000);
    assert.equal(seen.length, 7);
    assert.deepEqual(seen.slice(0, 3).map((call) => call.options), [{ timeout: 181_000 }, { timeout: 181_000 }, { timeout: 181_000 }]);
    assert.deepEqual(seen.slice(3).map((call) => call.options), [{ timeout: 8_000 }, { timeout: 8_000 }, { timeout: 8_000 }, { timeout: 8_000 }]);
  });
});

