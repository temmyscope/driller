/**
 * P2-9: the persisted zoom reads back as a valid step; a corrupt value
 * reads as 1, warns once and is repaired; a throwing store never breaks
 * the app.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createShowFoldedKindsSetting,
  createUiSettings,
  handleGetShowFoldedKinds,
  handleSetShowFoldedKinds,
  type ShowFoldedKindsBackingStore,
  type ShowFoldedKindsSetting,
  type UiSettingsBackingStore,
  type UiSettingsLog,
} from './ui-settings';

/** A store over a plain record, like electron-store's JSON file. */
function fakeStore(initial: unknown): { store: UiSettingsBackingStore; data: Record<string, unknown>; writes: number[] } {
  const data: Record<string, unknown> = { zoomFactor: initial };
  const writes: number[] = [];
  return {
    data,
    writes,
    store: {
      get: () => data.zoomFactor,
      set: (value) => {
        writes.push(value);
        data.zoomFactor = value;
      },
    },
  };
}

function fakeLog(): { log: UiSettingsLog; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    log: {
      warn: (message) => warnings.push(message),
      error: (message) => errors.push(message),
    },
  };
}

describe('createUiSettings', () => {
  for (const corrupt of ['abc', 7]) {
    it(`reads ${JSON.stringify(corrupt)} as 1, warns once, and writes 1 back`, () => {
      const { store, data } = fakeStore(corrupt);
      const { log, warnings } = fakeLog();
      const settings = createUiSettings(store, log);
      assert.equal(settings.getZoomFactor(), 1);
      assert.equal(settings.getZoomFactor(), 1);
      assert.equal(warnings.length, 1);
      assert.equal(data.zoomFactor, 1);

      // The next launch reads the repaired value without warning again.
      const next = fakeLog();
      assert.equal(createUiSettings(store, next.log).getZoomFactor(), 1);
      assert.equal(next.warnings.length, 0);
    });
  }

  it('reads a stored 1.25 back as 1.25 without writing', () => {
    const { store, writes } = fakeStore(1.25);
    assert.equal(createUiSettings(store, fakeLog().log).getZoomFactor(), 1.25);
    assert.deepEqual(writes, []);
  });

  it('snaps float drift at a bound to the bound', () => {
    const { store } = fakeStore(2.0000000001);
    assert.equal(createUiSettings(store, fakeLog().log).getZoomFactor(), 2);
  });

  it('stores and returns the nearest step for an off-step set', () => {
    const { store, data } = fakeStore(1);
    const settings = createUiSettings(store, fakeLog().log);
    assert.equal(settings.setZoomFactor(1.3), 1.25);
    assert.equal(data.zoomFactor, 1.25);
    assert.equal(settings.getZoomFactor(), 1.25);
  });

  it('reads as 1 when the store throws, and keeps a set value in memory', () => {
    const { log, errors } = fakeLog();
    const settings = createUiSettings(
      {
        get: () => {
          throw new Error('unreadable');
        },
        set: () => {
          throw new Error('unwritable');
        },
      },
      log,
    );
    assert.equal(settings.getZoomFactor(), 1);
    assert.equal(settings.setZoomFactor(1.5), 1.5);
    assert.equal(settings.getZoomFactor(), 1.5);
    assert.equal(errors.length, 2);
  });
});

describe('createShowFoldedKindsSetting (P4-2 phase 3c)', () => {
  /** A store over one JSON-ish value, like electron-store's key. */
  function fakeRecordStore(initial: unknown): { store: ShowFoldedKindsBackingStore; data: { value: unknown } } {
    const data = { value: initial };
    return {
      data,
      store: {
        get: () => data.value,
        set: (value) => {
          data.value = JSON.parse(JSON.stringify(value));
        },
      },
    };
  }

  it('is off by default for every project', () => {
    const setting = createShowFoldedKindsSetting(fakeRecordStore(undefined).store, fakeLog().log);
    assert.equal(setting.get('/p/one'), false);
  });

  it('remembers the toggle per project, across a reopen', () => {
    const { store, data } = fakeRecordStore({});
    const setting = createShowFoldedKindsSetting(store, fakeLog().log);
    assert.equal(setting.set('/p/one', true), true);
    assert.equal(setting.get('/p/one'), true);
    assert.equal(setting.get('/p/two'), false, 'another project keeps its own (default) state');
    assert.deepEqual(data.value, { '/p/one': true });

    // Reopening the app: a fresh setting over the same persisted store.
    const reopened = createShowFoldedKindsSetting(store, fakeLog().log);
    assert.equal(reopened.get('/p/one'), true);
    assert.equal(reopened.get('/p/two'), false);

    // Turning it off is remembered too (the entry is removed).
    reopened.set('/p/one', false);
    assert.deepEqual(data.value, {});
    assert.equal(createShowFoldedKindsSetting(store, fakeLog().log).get('/p/one'), false);
  });

  it('reads a corrupt record defensively: only a true value turns a project on', () => {
    for (const corrupt of ['on', 7, ['/p/one'], null]) {
      assert.equal(createShowFoldedKindsSetting(fakeRecordStore(corrupt).store, fakeLog().log).get('/p/one'), false);
    }
    const mixed = createShowFoldedKindsSetting(
      fakeRecordStore({ '/p/one': 'yes', '/p/two': true, '/p/three': 1 }).store,
      fakeLog().log,
    );
    assert.deepEqual(['/p/one', '/p/two', '/p/three', 'toString'].map((p) => mixed.get(p)), [false, true, false, false]);
  });

  it('treats two spellings of one project folder (case, trailing separator) as the same project', () => {
    const { store, data } = fakeRecordStore({});
    const setting = createShowFoldedKindsSetting(store, fakeLog().log);
    setting.set('/Users/Me/Proj/', true);
    assert.equal(setting.get('/users/me/proj'), true);
    assert.deepEqual(data.value, { '/users/me/proj': true });
    // A record hand-written with another spelling reads the same way.
    assert.equal(createShowFoldedKindsSetting(fakeRecordStore({ 'C:\\Work\\App\\': true }).store).get('c:\\work\\app'), true);
  });

  it('never overwrites the persisted record while it cannot be read; the change waits in memory', () => {
    const { log, errors } = fakeLog();
    let readable = false;
    const data: { value: unknown } = { value: { '/p/other': true } };
    const writes: unknown[] = [];
    const setting = createShowFoldedKindsSetting(
      {
        get: () => {
          if (!readable) {
            throw new Error('unreadable');
          }
          return data.value;
        },
        set: (value) => {
          writes.push(value);
          data.value = value;
        },
      },
      log,
    );
    assert.equal(setting.get('/p/one'), false);
    assert.equal(setting.set('/p/one', true), true);
    assert.equal(setting.get('/p/one'), true, 'kept in memory');
    assert.deepEqual(writes, [], "the other project's value was not erased");
    assert.equal(errors.length, 1, 'the read failure is logged once');

    // Once a read succeeds, the pending change is merged into the record.
    readable = true;
    setting.set('/p/two', true);
    assert.deepEqual(data.value, { '/p/other': true, '/p/one': true, '/p/two': true });
  });

  it('keeps a set value in memory when the write throws', () => {
    const { log, errors } = fakeLog();
    const setting = createShowFoldedKindsSetting(
      {
        get: () => ({}),
        set: () => {
          throw new Error('unwritable');
        },
      },
      log,
    );
    assert.equal(setting.set('/p/one', true), true);
    assert.equal(setting.get('/p/one'), true);
    assert.equal(errors.length, 1);
  });
});

describe('the Show types & modules IPC handlers (P4-2 phase 3c)', () => {
  function recordingSetting(initial: Record<string, boolean> = {}) {
    const calls: unknown[][] = [];
    const values = new Map(Object.entries(initial));
    const setting: ShowFoldedKindsSetting = {
      get: (projectPath) => {
        calls.push(['get', projectPath]);
        return values.get(projectPath) ?? false;
      },
      set: (projectPath, value) => {
        calls.push(['set', projectPath, value]);
        values.set(projectPath, value);
        return value;
      },
    };
    return { setting, calls };
  }

  it('get: an invalid project path reads as off without touching the store', () => {
    const { setting, calls } = recordingSetting({ '/p': true });
    for (const bad of [undefined, null, '', 7, { path: '/p' }]) {
      assert.equal(handleGetShowFoldedKinds(setting, bad), false);
    }
    assert.deepEqual(calls, []);
    assert.equal(handleGetShowFoldedKinds(setting, '/p'), true);
  });

  it('set: an invalid project path stores nothing; a non-boolean value stores nothing and returns what is stored', () => {
    const { setting, calls } = recordingSetting({ '/p': true });
    for (const bad of [undefined, '', 3]) {
      assert.equal(handleSetShowFoldedKinds(setting, bad, true), false);
    }
    for (const bad of ['true', 1, undefined, null]) {
      assert.equal(handleSetShowFoldedKinds(setting, '/p', bad), true);
    }
    assert.ok(calls.every((call) => call[0] === 'get'), 'nothing was set');
    assert.equal(handleSetShowFoldedKinds(setting, '/p', false), false);
    assert.deepEqual(calls.at(-1), ['set', '/p', false]);
  });
});
