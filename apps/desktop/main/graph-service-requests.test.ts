/**
 * P2-10: AD-4's one sanctioned key hop, at the two send sites. Under Local
 * neither request carries a key field and main never decrypts; under Cloud
 * the key rides along only when a non-blank key could be read.
 *
 * P4-7c: main's `entryCandidates:list` relay — argument validation (a
 * non-string `projectPath` is an `error`, never a throw), the request, the
 * reply's pass-through and validation, and the failure paths it shares with
 * `blastRadius:expand` — through injected dependencies (no Electron, no real
 * timers).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { CloudBackend, EntryCandidatesResult, GraphServiceListEntryCandidatesRequest } from '@driller/ipc-contracts';

import {
  buildBackendSwitchedRequest,
  buildIndexRequest,
  buildListEntryCandidatesRequest,
  cloudKeyField,
  createEntryCandidatesRelay,
  isListEntryCandidatesResultMessage,
  parseListEntryCandidatesArgs,
  toValidatedEntryCandidatesResult,
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

/** Every awaiting test fails fast (never hangs the file) if a promise is left unsettled. */
const FAST = { timeout: 2_000 };

const FOUND: EntryCandidatesResult = {
  status: 'found',
  candidates: [
    {
      id: 'api.handleRequest',
      name: 'handleRequest',
      file: 'api/entry.ts',
      startLine: 1,
      endLine: 4,
      reach: 4,
      reason: { kind: 'no-callers', loadedBy: ['api/start.ts'], loadedByTotal: 1 },
    },
  ],
  totalQualifying: 1,
};

function okArgs(projectPath: unknown, section?: unknown) {
  const args = parseListEntryCandidatesArgs(projectPath, section);
  assert.ok(args.ok);
  return args;
}

function relayHarness({ project = '/p', throwOnPost = false, running = true } = {}) {
  const sent: GraphServiceListEntryCandidatesRequest[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const relay = createEntryCandidatesRelay({
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
      timers.delete(timer as number);
    },
  });
  return { relay, sent, timers };
}

describe('P4-7c: parseListEntryCandidatesArgs (the ipcMain.handle validation)', () => {
  it('a non-string or empty projectPath is an explicit error result, never a throw', () => {
    for (const projectPath of [undefined, null, 42, {}, ['/p'], '']) {
      assert.deepEqual(parseListEntryCandidatesArgs(projectPath, undefined), {
        ok: false,
        result: { status: 'error', message: 'Invalid project path.' },
      });
    }
  });

  it('a section is absent or a non-empty string; anything else is "Invalid section."', () => {
    assert.deepEqual(parseListEntryCandidatesArgs('/p', undefined), { ok: true, projectPath: '/p' });
    assert.deepEqual(parseListEntryCandidatesArgs('/p', 'api'), { ok: true, projectPath: '/p', section: 'api' });
    for (const section of ['', 42, null, {}]) {
      assert.deepEqual(parseListEntryCandidatesArgs('/p', section), {
        ok: false,
        result: { status: 'error', message: 'Invalid section.' },
      });
    }
  });

  it('the request carries section only when given', () => {
    assert.deepEqual(buildListEntryCandidatesRequest('/p', 3), { type: 'graphService:listEntryCandidates', projectPath: '/p', requestId: 3 });
    assert.equal('section' in buildListEntryCandidatesRequest('/p', 3), false);
    assert.deepEqual(buildListEntryCandidatesRequest('/p', 4, 'web'), {
      type: 'graphService:listEntryCandidates',
      projectPath: '/p',
      requestId: 4,
      section: 'web',
    });
  });
});

describe('P4-7c: createEntryCandidatesRelay', () => {
  it('sends the request and settles it with the reply unchanged (the same result the MCP tool returns)', FAST, async () => {
    const { relay, sent, timers } = relayHarness();
    const promise = relay.request(okArgs('/p', 'api'));
    assert.deepEqual(sent, [{ type: 'graphService:listEntryCandidates', projectPath: '/p', requestId: sent[0]!.requestId, section: 'api' }]);
    assert.equal(relay.pendingCount(), 1);
    relay.settleReply(sent[0]!.requestId, FOUND, 'api');
    assert.equal(await promise, FOUND, 'passed through as-is');
    assert.equal(relay.pendingCount(), 0);
    assert.equal(timers.size, 0);
  });

  it('every well-formed state passes through; a malformed reply is an explicit error', FAST, async () => {
    for (const result of [
      { status: 'none' },
      { status: 'error', message: 'No project has finished indexing yet.' },
      { status: 'unknown-section', section: 'docs', knownSections: ['api'] },
    ]) {
      assert.equal(toValidatedEntryCandidatesResult(result), result);
    }
    const malformed = { status: 'error', message: 'Malformed entry-candidates reply.' };
    for (const result of [null, 42, {}, { status: 'perhaps' }, { status: 'error' }, { status: 'found', candidates: 'x', totalQualifying: 1 }, { status: 'found', candidates: [] }]) {
      assert.deepEqual(toValidatedEntryCandidatesResult(result), malformed, JSON.stringify(result));
    }
    const { relay, sent } = relayHarness();
    const promise = relay.request(okArgs('/p'));
    relay.settleReply(sent[0]!.requestId, { status: 'perhaps' }, null);
    assert.deepEqual(await promise, malformed);
  });

  it('review round 1: the echoed section must be the request’s; anything else settles as an explicit mismatch', FAST, async () => {
    const mismatch = { status: 'error', message: 'Mismatched entry-candidates reply.' };
    for (const [requested, echoed] of [
      ['api', 'web'],
      ['api', null],
      [undefined, 'api'],
      [undefined, undefined],
      ['api', 42],
    ] as const) {
      const { relay, sent } = relayHarness();
      const promise = relay.request(okArgs('/p', requested));
      relay.settleReply(sent[0]!.requestId, FOUND, echoed);
      assert.deepEqual(await promise, mismatch, `${String(requested)} / ${String(echoed)}`);
      assert.equal(relay.pendingCount(), 0);
    }
    const { relay, sent } = relayHarness();
    const promise = relay.request(okArgs('/p'));
    relay.settleReply(sent[0]!.requestId, FOUND, null);
    assert.equal(await promise, FOUND, 'a whole-scope request echoes null');
  });

  it('review round 1: unknown-section needs a string section and a string-array knownSections', () => {
    const malformed = { status: 'error', message: 'Malformed entry-candidates reply.' };
    for (const result of [
      { status: 'unknown-section', knownSections: ['api'] },
      { status: 'unknown-section', section: 'docs' },
      { status: 'unknown-section', section: 'docs', knownSections: 'api' },
      { status: 'unknown-section', section: 'docs', knownSections: ['api', 3] },
    ]) {
      assert.deepEqual(toValidatedEntryCandidatesResult(result), malformed, JSON.stringify(result));
    }
    const ok = { status: 'unknown-section', section: 'docs', knownSections: [] };
    assert.equal(toValidatedEntryCandidatesResult(ok), ok);
  });

  it('another project, or no running service (Graph Service down), answers at once and sends nothing', FAST, async () => {
    const other = relayHarness({ project: '/other' });
    assert.deepEqual(await other.relay.request(okArgs('/p')), {
      status: 'error',
      message: 'The requested project is not the currently open project.',
    });
    assert.equal(other.sent.length, 0);
    const stopped = relayHarness({ running: false });
    assert.deepEqual(await stopped.relay.request(okArgs('/p')), { status: 'error', message: 'Graph Service is not running.' });
    assert.equal(stopped.timers.size, 0);
    assert.equal(stopped.relay.pendingCount(), 0);
  });

  it('a postMessage throw settles as an error and leaves nothing pending', FAST, async () => {
    const { relay, timers } = relayHarness({ throwOnPost: true });
    const result = await relay.request(okArgs('/p'));
    assert.equal(result.status, 'error');
    assert.match(result.status === 'error' ? result.message : '', /port closed/);
    assert.equal(relay.pendingCount(), 0);
    assert.equal(timers.size, 0);
  });

  it('the timeout settles as an error; a late reply is then ignored', FAST, async () => {
    const { relay, sent, timers } = relayHarness();
    const promise = relay.request(okArgs('/p'));
    [...timers.values()][0]?.();
    assert.deepEqual(await promise, {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to list the entry candidates.',
    });
    relay.settleReply(sent[0]!.requestId, FOUND, null);
    assert.equal(relay.pendingCount(), 0);
  });

  it('overlapping requests each settle by their own id; settle-on-exit settles the rest', FAST, async () => {
    const { relay, sent, timers } = relayHarness();
    const first = relay.request(okArgs('/p'));
    const second = relay.request(okArgs('/p', 'web'));
    assert.notEqual(sent[0]!.requestId, sent[1]!.requestId);
    relay.settleReply(sent[1]!.requestId, { status: 'none' }, 'web');
    assert.deepEqual(await second, { status: 'none' });
    relay.settleAll('Graph Service exited before the entry candidates could be listed.');
    assert.deepEqual(await first, { status: 'error', message: 'Graph Service exited before the entry candidates could be listed.' });
    assert.equal(relay.pendingCount(), 0);
    assert.equal(timers.size, 0);
  });

  it('isListEntryCandidatesResultMessage: only the reply with a numeric request id', () => {
    assert.equal(isListEntryCandidatesResultMessage({ type: 'graphService:listEntryCandidatesResult', requestId: 1, result: {} }), true);
    assert.equal(isListEntryCandidatesResultMessage({ type: 'graphService:listEntryCandidatesResult', requestId: '1' }), false);
    assert.equal(isListEntryCandidatesResultMessage({ type: 'graphService:expandBlastRadiusResult', requestId: 1 }), false);
    assert.equal(isListEntryCandidatesResultMessage(null), false);
  });
});

describe('P4-7c: index.ts uses the relay (source)', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('for the IPC handler, replies and exit', () => {
    assert.match(src, /IpcChannels\.entryCandidatesList,\s*\(_event, projectPath: unknown, sectionInput: unknown\): Promise<EntryCandidatesResult> => \{\s*const args = parseListEntryCandidatesArgs\(projectPath, sectionInput\);\s*return args\.ok \? requestListEntryCandidates\(args\) : Promise\.resolve\(args\.result\);/);
    assert.match(src, /return entryCandidatesRelay\.request\(args\);/);
    assert.match(src, /if \(isListEntryCandidatesResultMessage\(message\)\) \{\s*entryCandidatesRelay\.settleReply\(message\.requestId, message\.result, message\.section\);/);
    assert.match(src, /entryCandidatesRelay\.settleAll\('Graph Service exited before the entry candidates could be listed\.'\);/);
  });

  it('preload: listEntryCandidates passes the section only when given', () => {
    const preload = readFileSync(fileURLToPath(new URL('../preload/index.ts', import.meta.url)), 'utf8');
    assert.match(
      preload,
      /listEntryCandidates: \(projectPath: string, section\?: string\)[^=]*=>\s*section === undefined\s*\? ipcRenderer\.invoke\(IpcChannels\.entryCandidatesList, projectPath\)\s*: ipcRenderer\.invoke\(IpcChannels\.entryCandidatesList, projectPath, section\)/,
    );
  });
});
