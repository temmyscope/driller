/**
 * P4-8c: the fake `window.driller` itself — rejecting by default, recording,
 * per-fake stubs and controllable subscriptions. No DOM needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_PINS_MAX, type ModelStatusMessage } from '@driller/ipc-contracts';
import { createFakeDrillerApi, deferred, entryPinsStore, INSTALL_NEEDS_DOM_ENV } from './fakeDrillerApi';
import { pathTraceBasicMap } from './mapFixture';

describe('createFakeDrillerApi', () => {
  it('rejects an unstubbed request, naming it, and records it', async () => {
    const fake = createFakeDrillerApi();
    await assert.rejects(fake.api.getCodeMap(), { message: 'fake window.driller.getCodeMap not stubbed' });
    await assert.rejects(fake.api.tracePath('handleRequest'), { message: 'fake window.driller.tracePath not stubbed' });
    assert.deepEqual(fake.unstubbedCalls, ['getCodeMap', 'tracePath']);
    assert.throws(() => fake.assertNoUnstubbedCalls(), /getCodeMap, tracePath/);
  });

  it('resolves a stubbed request with its stub, and records every call with its arguments', async () => {
    const fake = createFakeDrillerApi({ getCodeMap: async () => pathTraceBasicMap() });
    const result = await fake.api.getCodeMap('api');
    assert.equal(result.status, 'ok');
    await fake.api.getCodeMap();
    assert.deepEqual(fake.calls.getCodeMap, [['api'], []]);
    assert.deepEqual(fake.calls.tracePath, []);
    fake.assertNoUnstubbedCalls();
  });

  it('turns a stub that throws into a rejection', async () => {
    const fake = createFakeDrillerApi({
      getEntryPins: () => {
        throw new Error('store unreadable');
      },
    });
    await assert.rejects(fake.api.getEntryPins('/p'), { message: 'store unreadable' });
  });

  it('keeps stubs per fake, and stub() replaces one later', async () => {
    const first = createFakeDrillerApi({ getShowFoldedKinds: async () => true });
    const second = createFakeDrillerApi();
    assert.equal(await first.api.getShowFoldedKinds('/p'), true);
    await assert.rejects(second.api.getShowFoldedKinds('/p'), /not stubbed/);

    second.stub('getShowFoldedKinds', async () => false);
    assert.equal(await second.api.getShowFoldedKinds('/p'), false);
    assert.equal(await first.api.getShowFoldedKinds('/p'), true);
  });

  it('emits to every live subscriber, and an unsubscribe stops one', () => {
    const fake = createFakeDrillerApi();
    const seenA: ModelStatusMessage[] = [];
    const seenB: ModelStatusMessage[] = [];
    const offA = fake.api.onModelStatus((status) => seenA.push(status));
    fake.api.onModelStatus((status) => seenB.push(status));
    assert.equal(fake.subscriberCount('onModelStatus'), 2);
    assert.equal(fake.calls.onModelStatus.length, 2);

    const ready: ModelStatusMessage = {
      type: 'graphService:modelStatus',
      state: 'ready',
      at: '2026-10-06T09:00:00.000Z',
      model: 'qwen2.5-coder-1.5b.gguf',
    };
    fake.emit.onModelStatus(ready);
    offA();
    fake.emit.onModelStatus(ready);

    assert.deepEqual(seenA, [ready]);
    assert.deepEqual(seenB, [ready, ready]);
    assert.equal(fake.subscriberCount('onModelStatus'), 1);
    // A subscription is not a request: it never counts as unstubbed.
    fake.assertNoUnstubbedCalls();
  });

  it('a calls snapshot cannot be used to rewrite the record', async () => {
    const fake = createFakeDrillerApi({ getEntryPins: async () => [] });
    await fake.api.getEntryPins('/p');
    (fake.calls.getEntryPins as unknown[][]).length = 0;
    assert.equal(fake.calls.getEntryPins.length, 1);
  });

  it('expectUnstubbed excuses a declared call, and fails when the declared call never came', async () => {
    const fake = createFakeDrillerApi();
    fake.expectUnstubbed('tracePath');
    assert.throws(() => fake.assertNoUnstubbedCalls(), /expectUnstubbed\('tracePath'\), but window\.driller\.tracePath was never called/);
    await fake.api.tracePath('x').catch(() => {});
    fake.assertNoUnstubbedCalls();
    await fake.api.getCodeMap().catch(() => {});
    assert.throws(() => fake.assertNoUnstubbedCalls(), /unstubbed window\.driller calls: getCodeMap \(/);
  });

  it('install() refuses to run without the DOM environment', () => {
    assert.throws(() => createFakeDrillerApi().install(), { message: INSTALL_NEEDS_DOM_ENV });
  });
});

describe('deferred (P4-8d)', () => {
  it('settles only when the test says so, in the order it says', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fake = createFakeDrillerApi({ getActiveSection: (path) => (path === '/a' ? first.promise : second.promise) });
    const settled: string[] = [];
    const a = fake.api.getActiveSection('/a').then((value) => settled.push(`a:${value}`));
    const b = fake.api.getActiveSection('/b').then((value) => settled.push(`b:${value}`));
    await Promise.resolve();
    assert.deepEqual(settled, []);
    second.resolve('web');
    await b;
    first.resolve('api');
    await a;
    assert.deepEqual(settled, ['b:web', 'a:api']);
  });

  it('rejects with the given error', async () => {
    const pending = deferred<string>();
    pending.reject(new Error('read failed'));
    await assert.rejects(pending.promise, { message: 'read failed' });
  });
});

describe('entryPinsStore (P4-8g)', () => {
  it('keeps pins per project, in pin order, as main does: a repeat changes nothing, past the limit is refused', async () => {
    const store = entryPinsStore({ '/a': ['x'] });
    const { getEntryPins, setEntryPins } = store.stubs;
    assert.deepEqual(await getEntryPins('/a'), ['x']);
    assert.deepEqual(await getEntryPins('/b'), []);
    assert.deepEqual(await setEntryPins('/a', 'y', true), { status: 'stored', pins: ['x', 'y'] });
    assert.deepEqual(await setEntryPins('/a', 'x', true), { status: 'stored', pins: ['x', 'y'] });
    assert.deepEqual(await setEntryPins('/a', 'x', false), { status: 'stored', pins: ['y'] });
    assert.deepEqual(store.pinsOf('/b'), []);
    const full = entryPinsStore({ '/a': Array.from({ length: ENTRY_PINS_MAX }, (_, index) => `p${index}`) });
    const refused = await full.stubs.setEntryPins('/a', 'z', true);
    assert.equal(refused.status, 'limit');
    assert.equal(full.pinsOf('/a').length, ENTRY_PINS_MAX);
  });
});
