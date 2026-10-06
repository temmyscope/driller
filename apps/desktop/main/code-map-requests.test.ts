/**
 * P4-4 phase 1b: main's Code Map request queue (`code-map-requests.ts`) —
 * one request outstanding at a time, shared only per section, and the
 * `codeMap:get` argument check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapResult, GraphServiceCodeMapMessage } from '@driller/ipc-contracts';

import {
  createCodeMapRequester,
  INVALID_SECTION_RESULT,
  isCodeMapMessage,
  MALFORMED_REPLY_RESULT,
  parseCodeMapSectionArg,
  PROJECT_CHANGED_RESULT,
  routeCodeMapReply,
  type CodeMapRequestKey,
  type CodeMapRequesterDeps,
} from './code-map-requests';

const okFor = (section: string | null): CodeMapResult => ({
  status: 'ok',
  nodes: [],
  edges: [],
  hiddenByScope: 0,
  appliedScope: ['web', 'api'],
  foldedTypes: [],
  foldedModules: [],
  section,
  sections: [],
});

function setup(overrides: Partial<CodeMapRequesterDeps> = {}) {
  const sent: CodeMapRequestKey[] = [];
  let running = true;
  const requester = createCodeMapRequester({
    isRunning: () => running,
    send: (section) => {
      sent.push(section);
    },
    timeoutMs: 60_000,
    ...overrides,
  });
  return {
    requester,
    sent,
    stop: () => {
      running = false;
    },
  };
}

/** Whether `promise` has settled, after letting pending microtasks run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

/**
 * Awaits a request that only its timeout will settle. The requester's timer
 * is `unref`'d (it must never hold main open), so nothing else keeps the
 * event loop alive meanwhile; Node 22's test runner then sees a drained loop
 * and cancels the rest of the file (found by P4-8b's Node 22 run).
 */
async function awaitTimeout<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

describe('createCodeMapRequester', () => {
  it('sends the whole scope as null and a section as itself', () => {
    const { requester, sent } = setup();
    void requester.request();
    assert.deepEqual(sent, [null]);
    assert.equal(requester.inFlightSection(), null);
    requester.settleInFlight(okFor(null));
    void requester.request('api');
    assert.deepEqual(sent, [null, 'api']);
    assert.equal(requester.inFlightSection(), 'api');
  });

  it('shares the in-flight promise only for the same section', { timeout: 5_000 }, async () => {
    const { requester, sent } = setup();
    const first = requester.request('api');
    const again = requester.request('api');
    assert.equal(again, first, 'same section: one shared promise');
    assert.deepEqual(sent, ['api'], 'and one request sent');
    const whole = requester.request();
    assert.notEqual(whole, first, 'another section never shares it');
    requester.settleInFlight(okFor('api'));
    assert.deepEqual(await first, okFor('api'));
    requester.settleInFlight(okFor(null));
    assert.deepEqual(await whole, okFor(null));
  });

  it('overlap: web waits for api to settle, then is sent; each caller gets its own section', { timeout: 5_000 }, async () => {
    const { requester, sent } = setup();
    const api = requester.request('api');
    const web = requester.request('web');
    assert.deepEqual(sent, ['api'], 'web is not sent while api is in flight');
    assert.equal(requester.inFlightSection(), 'api');
    assert.equal(await isSettled(web), false);

    requester.settleInFlight(okFor('api'));
    assert.deepEqual(sent, ['api', 'web'], 'web is sent once api settles');
    assert.equal(requester.inFlightSection(), 'web');
    assert.deepEqual(await api, okFor('api'));
    assert.equal(await isSettled(web), false, 'api’s reply never settles web');

    requester.settleInFlight(okFor('web'));
    assert.deepEqual(await web, okFor('web'));
    assert.equal(requester.inFlightSection(), undefined);
  });

  it('a waiting request for the same section is shared too, and order is kept', { timeout: 5_000 }, async () => {
    const { requester, sent } = setup();
    void requester.request('api');
    const web = requester.request('web');
    const whole = requester.request();
    assert.equal(requester.request('web'), web);
    requester.settleInFlight(okFor('api'));
    requester.settleInFlight(okFor('web'));
    assert.deepEqual(sent, ['api', 'web', null]);
    requester.settleInFlight(okFor(null));
    assert.deepEqual(await whole, okFor(null));
  });

  it('a settle with nothing in flight is a no-op', () => {
    const { requester, sent } = setup();
    requester.settleInFlight(okFor(null));
    assert.deepEqual(sent, []);
    assert.equal(requester.inFlightSection(), undefined);
  });

  it('no Graph Service: an explicit error, now or when a waiting request comes up', { timeout: 5_000 }, async () => {
    const { requester, sent, stop } = setup();
    const api = requester.request('api');
    const web = requester.request('web');
    stop();
    requester.settleInFlight({ status: 'error', message: 'Graph Service exited before the Code Map could be fetched.' });
    assert.deepEqual(await api, { status: 'error', message: 'Graph Service exited before the Code Map could be fetched.' });
    assert.deepEqual(await web, { status: 'error', message: 'Graph Service is not running.' });
    assert.deepEqual(await requester.request(), { status: 'error', message: 'Graph Service is not running.' });
    assert.deepEqual(sent, ['api']);
  });

  it('a throwing send settles that request and moves on to the next', { timeout: 5_000 }, async () => {
    let calls = 0;
    const { requester } = setup({
      send: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('port closed');
        }
      },
    });
    const first = requester.request('api');
    assert.deepEqual(await first, {
      status: 'error',
      message: 'Failed to send the Code Map request to the Graph Service: port closed',
    });
    void requester.request('web');
    assert.equal(requester.inFlightSection(), 'web');
  });

  it('times out a request with no reply, then sends the next', { timeout: 5_000 }, async () => {
    const { requester, sent } = setup({ timeoutMs: 10 });
    const api = requester.request('api');
    const web = requester.request('web');
    assert.deepEqual(await awaitTimeout(api), {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to respond with the Code Map.',
    });
    assert.deepEqual(sent, ['api', 'web']);
    requester.settleInFlight(okFor('web'));
    assert.deepEqual(await web, okFor('web'));
  });
});

describe('parseCodeMapSectionArg', () => {
  it('accepts no argument (the whole scope) or a string section', () => {
    assert.deepEqual(parseCodeMapSectionArg(undefined), { ok: true });
    assert.deepEqual(parseCodeMapSectionArg('api'), { ok: true, section: 'api' });
    assert.deepEqual(parseCodeMapSectionArg('all'), { ok: true, section: 'all' }, '"all" is a normal section name');
  });

  for (const bad of [42, null, ['api'], { section: 'api' }, true]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.deepEqual(parseCodeMapSectionArg(bad), { ok: false });
    });
  }

  it('the malformed reply is the explicit error', () => {
    assert.deepEqual(INVALID_SECTION_RESULT, { status: 'error', message: 'Invalid section.' });
  });
});

describe('failWaiting (review round 1: an index request is sent)', () => {
  it('settles every waiting request with the explicit error; the one in flight is untouched', { timeout: 5_000 }, async () => {
    const { requester, sent } = setup();
    const api = requester.request('api');
    const web = requester.request('web');
    const whole = requester.request();
    requester.failWaiting(PROJECT_CHANGED_RESULT);
    assert.deepEqual(await web, PROJECT_CHANGED_RESULT);
    assert.deepEqual(await whole, PROJECT_CHANGED_RESULT);
    assert.equal(requester.inFlightSection(), 'api');
    assert.equal(await isSettled(api), false);
    requester.settleInFlight(okFor('api'));
    assert.deepEqual(await api, okFor('api'));
    assert.deepEqual(sent, ['api'], 'the failed requests are never sent');
    // A new request after the index is sent normally.
    void requester.request('web');
    assert.deepEqual(sent, ['api', 'web']);
  });
});

type Message = GraphServiceCodeMapMessage;
const okReply = (section: unknown, extra: Record<string, unknown> = {}): Message =>
  ({
    type: 'graphService:codeMap',
    nodes: [],
    edges: [],
    hiddenByScope: 0,
    appliedScope: ['web', 'api'],
    foldedTypes: [],
    foldedModules: [],
    section,
    sections: [],
    ...extra,
  }) as unknown as Message;
const unknownReply = (section: unknown, knownSections: unknown = ['web', 'api']): Message =>
  ({ type: 'graphService:codeMapUnknownSection', section, knownSections }) as unknown as Message;
const errorReply = (message: string, section?: unknown): Message =>
  ({ type: 'graphService:codeMapError', message, ...(section === undefined ? {} : { section }) }) as unknown as Message;

function routed() {
  const harness = setup();
  const warnings: string[] = [];
  const route = (message: Message) => routeCodeMapReply(message, harness.requester, (text) => warnings.push(text));
  return { ...harness, warnings, route };
}

describe('routeCodeMapReply (review round 1)', () => {
  it('isCodeMapMessage accepts all three reply types and nothing else', () => {
    for (const type of ['graphService:codeMap', 'graphService:codeMapUnknownSection', 'graphService:codeMapError']) {
      assert.equal(isCodeMapMessage({ type }), true, type);
    }
    for (const other of [{ type: 'graphService:status' }, { state: 'indexed' }, null, 'graphService:codeMap']) {
      assert.equal(isCodeMapMessage(other), false, JSON.stringify(other));
    }
  });

  it('ok: settles the in-flight request with the validated map', { timeout: 5_000 }, async () => {
    const { requester, route, warnings } = routed();
    const api = requester.request('api');
    route(okReply('api', { sections: [{ path: 'api', nodeCount: 2 }, { path: 'web' }] }));
    assert.deepEqual(await api, { ...okFor('api'), sections: [{ path: 'api', nodeCount: 2 }] });
    assert.deepEqual(warnings, ['Code Map reply had 1 malformed section count; dropped.']);
  });

  it('ok with cross-section counts (P4-4 phase 3a): kept when well-formed, malformed ones dropped and logged once', { timeout: 5_000 }, async () => {
    const { requester, route, warnings } = routed();
    const api = requester.request('api');
    const edges = [{ section: 'web', outgoing: 9, incoming: 3 }];
    route(okReply('api', { crossSectionEdges: [...edges, { section: 'docs', outgoing: 0, incoming: 0 }, null] }));
    assert.deepEqual(await api, { ...okFor('api'), crossSectionEdges: edges });
    assert.deepEqual(warnings, ['Code Map reply had 2 malformed cross-section counts; dropped.']);
  });

  it('error: settles with its message (echoed, or with no echo at all)', { timeout: 5_000 }, async () => {
    const { requester, route } = routed();
    const api = requester.request('api');
    route(errorReply('No project has finished indexing yet.', 'api'));
    assert.deepEqual(await api, { status: 'error', message: 'No project has finished indexing yet.' });
    const whole = requester.request();
    route(errorReply('Invalid section.'));
    assert.deepEqual(await whole, { status: 'error', message: 'Invalid section.' });
  });

  it('unknown-section: settles the explicit state', { timeout: 5_000 }, async () => {
    const { requester, route } = routed();
    const docs = requester.request('docs');
    route(unknownReply('docs'));
    assert.deepEqual(await docs, { status: 'unknown-section', section: 'docs', knownSections: ['web', 'api'] });
  });

  it('malformed unknown-section or echo: an explicit malformed-reply error', { timeout: 5_000 }, async () => {
    const { requester, route } = routed();
    const docs = requester.request('docs');
    route(unknownReply('docs', 'web'));
    assert.deepEqual(await docs, { status: 'unknown-section', section: 'docs', knownSections: [] });
    const bad = requester.request('x');
    route(unknownReply(42));
    assert.deepEqual(await bad, MALFORMED_REPLY_RESULT);
    const ok = requester.request();
    route(okReply(undefined));
    assert.deepEqual(await ok, MALFORMED_REPLY_RESULT, 'an ok reply with no echo cannot be matched');
  });

  it('no request in flight: logged and ignored', () => {
    const { requester, route, warnings } = routed();
    route(okReply(null));
    route(errorReply('late'));
    assert.equal(requester.inFlightSection(), undefined);
    assert.equal(warnings.length, 2);
  });

  it('echoed-section mismatch: the stale reply is dropped and the request keeps waiting', { timeout: 5_000 }, async () => {
    const { requester, route, warnings } = routed();
    const web = requester.request('web');
    for (const stale of [okReply('api'), okReply(null), unknownReply('docs'), errorReply('boom', 'api')]) {
      route(stale);
    }
    assert.equal(await isSettled(web), false);
    assert.equal(requester.inFlightSection(), 'web');
    assert.equal(warnings.length, 4);
    assert.match(warnings[0]!, /stale Code Map reply for section "api"; still waiting for section "web"/);
    route(okReply('web'));
    assert.deepEqual(await web, okFor('web'));
  });

  it('timeout cascade: api times out, web is sent, api’s late reply never settles web', { timeout: 5_000 }, async () => {
    const harness = setup({ timeoutMs: 200 });
    const warnings: string[] = [];
    const route = (message: Message) => routeCodeMapReply(message, harness.requester, (text) => warnings.push(text));
    const api = harness.requester.request('api');
    const web = harness.requester.request('web');
    assert.equal((await awaitTimeout(api)).status, 'error', 'api timed out');
    assert.deepEqual(harness.sent, ['api', 'web']);
    route(okReply('api'));
    route(errorReply('late api failure', 'api'));
    assert.equal(await isSettled(web), false, 'web still waits for its own reply');
    route(okReply('web'));
    assert.deepEqual(await web, okFor('web'));
  });
});

