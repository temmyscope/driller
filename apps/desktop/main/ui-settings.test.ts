/**
 * P2-9: the persisted zoom reads back as a valid step; a corrupt value
 * reads as 1, warns once and is repaired; a throwing store never breaks
 * the app.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENTRY_PINS_MAX } from '@driller/ipc-contracts';

import {
  createActiveSectionSetting,
  createEntryPinsSetting,
  createShowFoldedKindsSetting,
  ENTRY_PINS_UNREADABLE_MESSAGE,
  createUiSettings,
  handleGetActiveSection,
  handleGetEntryPins,
  handleGetShowFoldedKinds,
  handleSetActiveSection,
  handleSetEntryPins,
  handleSetShowFoldedKinds,
  type ActiveSectionBackingStore,
  type EntryPinsBackingStore,
  type EntryPinsSetting,
  type ActiveSectionSetting,
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

describe('createActiveSectionSetting (P4-4i)', () => {
  /** A store over one JSON-ish value, like electron-store's key. */
  function fakeRecordStore(initial: unknown): {
    store: ActiveSectionBackingStore;
    data: { value: unknown };
    writes: unknown[];
  } {
    const data = { value: initial };
    const writes: unknown[] = [];
    return {
      data,
      writes,
      store: {
        get: () => data.value,
        set: (value) => {
          writes.push(value);
          data.value = JSON.parse(JSON.stringify(value));
        },
      },
    };
  }

  it('reads as all (null) for a project with nothing saved', () => {
    assert.equal(createActiveSectionSetting(fakeRecordStore(undefined).store, fakeLog().log).get('/p/one'), null);
    assert.equal(createActiveSectionSetting(fakeRecordStore({}).store, fakeLog().log).get('/p/one'), null);
  });

  it('remembers the section per project, across a reopen', () => {
    const { store, data } = fakeRecordStore({});
    const setting = createActiveSectionSetting(store, fakeLog().log);
    assert.equal(setting.set('/p/one', 'api'), 'api');
    assert.equal(setting.get('/p/one'), 'api');
    assert.equal(setting.get('/p/two'), null, 'another project keeps its own (default) section');
    assert.deepEqual(data.value, { '/p/one': 'api' });

    // Relaunch: a fresh setting over the same persisted store.
    const reopened = createActiveSectionSetting(store, fakeLog().log);
    assert.equal(reopened.get('/p/one'), 'api');
    reopened.set('/p/one', 'web');
    assert.deepEqual(data.value, { '/p/one': 'web' });
    assert.equal(createActiveSectionSetting(store, fakeLog().log).get('/p/one'), 'web');
  });

  it('stores all by removing the entry, never as the string "all"; an entry named all is a normal section', () => {
    const { store, data } = fakeRecordStore({ '/p/one': 'api', '/p/two': 'web' });
    const setting = createActiveSectionSetting(store, fakeLog().log);
    assert.equal(setting.set('/p/one', null), null);
    assert.deepEqual(data.value, { '/p/two': 'web' });
    assert.ok(!JSON.stringify(data.value).includes('"all"'));
    assert.equal(createActiveSectionSetting(store, fakeLog().log).get('/p/one'), null);

    // A folder literally named `all` is stored and read back as that section.
    assert.equal(setting.set('/p/three', 'all'), 'all');
    assert.deepEqual(data.value, { '/p/two': 'web', '/p/three': 'all' });
    assert.equal(createActiveSectionSetting(store, fakeLog().log).get('/p/three'), 'all');
  });

  it('reads a corrupt record defensively: only a non-empty string is a section', () => {
    for (const corrupt of ['api', 7, ['/p/one'], null, true]) {
      assert.equal(createActiveSectionSetting(fakeRecordStore(corrupt).store, fakeLog().log).get('/p/one'), null);
    }
    const mixed = createActiveSectionSetting(
      fakeRecordStore({ '/p/one': 3, '/p/two': 'api', '/p/three': '', '/p/four': null, '/p/five': ['api'] }).store,
      fakeLog().log,
    );
    assert.deepEqual(
      ['/p/one', '/p/two', '/p/three', '/p/four', '/p/five', 'toString'].map((p) => mixed.get(p)),
      [null, 'api', null, null, null, null],
    );
  });

  it('treats two spellings of one project folder (case, trailing separator) as the same entry', () => {
    const { store, data } = fakeRecordStore({});
    const setting = createActiveSectionSetting(store, fakeLog().log);
    setting.set('/x/proj', 'api');
    assert.equal(setting.get('/x/proj/'), 'api');
    setting.set('/X/Proj/', 'web');
    assert.deepEqual(data.value, { '/x/proj': 'web' }, 'one entry, not two');
    // A record hand-written with another spelling reads the same way.
    assert.equal(createActiveSectionSetting(fakeRecordStore({ 'C:\\Work\\App\\': 'api' }).store).get('c:\\work\\app'), 'api');
  });

  it('never overwrites the persisted record while it cannot be read; the change waits in memory', () => {
    const { log, errors } = fakeLog();
    let readable = false;
    const data: { value: unknown } = { value: { '/p/other': 'docs', '/p/gone': 'web' } };
    const writes: unknown[] = [];
    const setting = createActiveSectionSetting(
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
    assert.equal(setting.get('/p/one'), null, 'an unreadable store reads as all');
    assert.equal(setting.set('/p/one', 'api'), 'api');
    assert.equal(setting.set('/p/gone', null), null);
    assert.equal(setting.get('/p/one'), 'api', 'kept in memory');
    assert.equal(setting.get('/p/gone'), null, 'a pending removal is in effect too');
    assert.deepEqual(writes, [], "other projects' sections were not erased");
    assert.equal(errors.length, 1, 'the read failure is logged once');

    // Once a read succeeds, the pending changes are merged into the record.
    readable = true;
    setting.set('/p/two', 'web');
    assert.deepEqual(data.value, { '/p/other': 'docs', '/p/one': 'api', '/p/two': 'web' });
  });

  it('keeps a set value in memory when the write throws', () => {
    const { log, errors } = fakeLog();
    const setting = createActiveSectionSetting(
      {
        get: () => ({}),
        set: () => {
          throw new Error('unwritable');
        },
      },
      log,
    );
    assert.equal(setting.set('/p/one', 'api'), 'api');
    assert.equal(setting.get('/p/one'), 'api');
    assert.equal(errors.length, 1);
  });
});

describe('the remembered-section IPC handlers (P4-4i)', () => {
  function recordingSetting(initial: Record<string, string> = {}) {
    const calls: unknown[][] = [];
    const values = new Map(Object.entries(initial));
    const setting: ActiveSectionSetting = {
      get: (projectPath) => {
        calls.push(['get', projectPath]);
        return values.get(projectPath) ?? null;
      },
      set: (projectPath, section) => {
        calls.push(['set', projectPath, section]);
        if (section === null) {
          values.delete(projectPath);
        } else {
          values.set(projectPath, section);
        }
        return section;
      },
    };
    return { setting, calls };
  }

  it('get: a malformed project path reads as null without touching the store', () => {
    const { setting, calls } = recordingSetting({ '/p': 'api' });
    for (const bad of [undefined, null, '', 42, { path: '/p' }]) {
      assert.equal(handleGetActiveSection(setting, bad), null);
    }
    assert.deepEqual(calls, []);
    assert.equal(handleGetActiveSection(setting, '/p'), 'api');
  });

  it('set: a malformed project path stores nothing and returns null', () => {
    const { setting, calls } = recordingSetting({ '/p': 'api' });
    for (const bad of [42, undefined, '', null, ['/p']]) {
      assert.equal(handleSetActiveSection(setting, bad, 'api'), null);
    }
    assert.deepEqual(calls, []);
  });

  it('set: a non-string, non-null value is a no-op returning what is stored; null and a section are stored', () => {
    const { setting, calls } = recordingSetting({ '/p': 'api' });
    for (const bad of [42, undefined, true, '', ['web'], { section: 'web' }]) {
      assert.equal(handleSetActiveSection(setting, '/p', bad), 'api');
    }
    assert.ok(calls.every((call) => call[0] === 'get'), 'nothing was set');
    assert.equal(handleSetActiveSection(setting, '/p', 'web'), 'web');
    assert.deepEqual(calls.at(-1), ['set', '/p', 'web']);
    assert.equal(handleSetActiveSection(setting, '/p', null), null);
    assert.deepEqual(calls.at(-1), ['set', '/p', null]);
    assert.equal(handleGetActiveSection(setting, '/p'), null);
  });
});

describe('createEntryPinsSetting (P4-7g)', () => {
  function fakePinsStore(initial: unknown): { store: EntryPinsBackingStore; data: { value: unknown }; writes: unknown[] } {
    const data = { value: initial };
    const writes: unknown[] = [];
    return {
      data,
      writes,
      store: {
        get: () => data.value,
        set: (value) => {
          writes.push(value);
          data.value = JSON.parse(JSON.stringify(value));
        },
      },
    };
  }

  it('reads as no pins for a project with nothing saved, without a warning', () => {
    const { log, warnings } = fakeLog();
    assert.deepEqual(createEntryPinsSetting(fakePinsStore(undefined).store, log).get('/p/one'), []);
    assert.deepEqual(createEntryPinsSetting(fakePinsStore({}).store, log).get('/p/one'), []);
    assert.deepEqual(warnings, []);
  });

  it('remembers the pins per project, in pin order, across a reopen (a relaunch)', () => {
    const { store, data } = fakePinsStore({});
    const setting = createEntryPinsSetting(store, fakeLog().log);
    assert.deepEqual(setting.set('/p/one', ['z.b', 'a.a', 'm.c']), ['z.b', 'a.a', 'm.c']);
    assert.deepEqual(setting.get('/p/one'), ['z.b', 'a.a', 'm.c'], 'pin order, never sorted');
    assert.deepEqual(setting.get('/p/two'), []);
    assert.deepEqual(data.value, { '/p/one': ['z.b', 'a.a', 'm.c'] });
    const reopened = createEntryPinsSetting(store, fakeLog().log);
    assert.deepEqual(reopened.get('/p/one'), ['z.b', 'a.a', 'm.c']);
    // Unpinning everything removes the entry.
    assert.deepEqual(reopened.set('/p/one', []), []);
    assert.deepEqual(data.value, {});
  });

  it('a repeated id is kept once, at its first place', () => {
    const { store, data } = fakePinsStore({});
    assert.deepEqual(createEntryPinsSetting(store, fakeLog().log).set('/p', ['a', 'b', 'a']), ['a', 'b']);
    assert.deepEqual(data.value, { '/p': ['a', 'b'] });
  });

  it('a corrupt record reads defensively and warns once: {"/p": 5} is no pins', () => {
    const { log, warnings } = fakeLog();
    const setting = createEntryPinsSetting(fakePinsStore({ '/p': 5 }).store, log);
    assert.deepEqual(setting.get('/p'), []);
    assert.deepEqual(setting.get('/p'), []);
    assert.equal(warnings.length, 1, 'warned once');
    for (const corrupt of ['x', 7, [['a']], null, true]) {
      assert.deepEqual(createEntryPinsSetting(fakePinsStore(corrupt).store, fakeLog().log).get('/p'), []);
    }
    const mixed = createEntryPinsSetting(
      fakePinsStore({ '/p/one': ['a', 3, '', 'b', 'a', null], '/p/two': 'a', '/p/three': { 0: 'a' } }).store,
      fakeLog().log,
    );
    assert.deepEqual(
      ['/p/one', '/p/two', '/p/three', 'toString'].map((p) => mixed.get(p)),
      [['a', 'b'], [], [], []],
    );
  });

  it(`a hand-edited list past ${ENTRY_PINS_MAX} reads back as its first ${ENTRY_PINS_MAX}`, () => {
    const many = Array.from({ length: ENTRY_PINS_MAX + 5 }, (_, i) => `n${i}`);
    const { log, warnings } = fakeLog();
    const setting = createEntryPinsSetting(fakePinsStore({ '/p': many }).store, log);
    assert.deepEqual(setting.get('/p'), many.slice(0, ENTRY_PINS_MAX));
    assert.equal(warnings.length, 1);
  });

  it(`refuses a pin past ${ENTRY_PINS_MAX}: nothing stored, the current pins returned`, () => {
    const full = Array.from({ length: ENTRY_PINS_MAX }, (_, i) => `n${i}`);
    const { store, data, writes } = fakePinsStore({ '/p': full });
    const setting = createEntryPinsSetting(store, fakeLog().log);
    assert.deepEqual(setting.set('/p', [...full, 'one-more']), full);
    assert.deepEqual(writes, []);
    assert.deepEqual(data.value, { '/p': full });
    assert.deepEqual(setting.get('/p'), full);
  });

  it('treats two spellings of one project folder as the same entry', () => {
    const { store, data } = fakePinsStore({});
    const setting = createEntryPinsSetting(store, fakeLog().log);
    setting.set('/x/proj', ['a']);
    assert.deepEqual(setting.get('/x/proj/'), ['a']);
    setting.set('/X/Proj/', ['b']);
    assert.deepEqual(data.value, { '/x/proj': ['b'] }, 'one entry, not two');
    assert.deepEqual(createEntryPinsSetting(fakePinsStore({ 'C:\\Work\\App\\': ['a'] }).store).get('c:\\work\\app'), ['a']);
  });

  it("never overwrites the persisted record while it cannot be read (no cross-project erase); the change waits in memory", () => {
    const { log, errors } = fakeLog();
    let readable = false;
    const data: { value: unknown } = { value: { '/p/other': ['x', 'y'], '/p/gone': ['g'] } };
    const writes: unknown[] = [];
    const setting = createEntryPinsSetting(
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
    assert.deepEqual(setting.get('/p/one'), []);
    assert.deepEqual(setting.set('/p/one', ['a']), ['a']);
    assert.deepEqual(setting.set('/p/gone', []), []);
    assert.deepEqual(setting.get('/p/one'), ['a'], 'kept in memory');
    assert.deepEqual(setting.get('/p/gone'), [], 'a pending removal is in effect too');
    assert.deepEqual(writes, [], "other projects' pins were not erased");
    assert.equal(errors.length, 1, 'the read failure is logged once');
    readable = true;
    setting.set('/p/two', ['b']);
    assert.deepEqual(data.value, { '/p/other': ['x', 'y'], '/p/one': ['a'], '/p/two': ['b'] });
  });

  it('keeps a set value in memory when the write throws', () => {
    const { log, errors } = fakeLog();
    const setting = createEntryPinsSetting(
      {
        get: () => ({}),
        set: () => {
          throw new Error('unwritable');
        },
      },
      log,
    );
    assert.deepEqual(setting.set('/p', ['a']), ['a']);
    assert.deepEqual(setting.get('/p'), ['a']);
    assert.equal(errors.length, 1);
  });

  it('get returns a copy: editing it never changes what is stored', () => {
    const setting = createEntryPinsSetting(fakePinsStore({ '/p': ['a'] }).store, fakeLog().log);
    setting.get('/p').push('b');
    assert.deepEqual(setting.get('/p'), ['a']);
  });
});

describe('createEntryPinsSetting.update (P4-7g review round 1)', () => {
  function fakePinsStore(initial: unknown): { store: EntryPinsBackingStore; data: { value: unknown }; writes: unknown[] } {
    const data = { value: initial };
    const writes: unknown[] = [];
    return {
      data,
      writes,
      store: {
        get: () => data.value,
        set: (value) => {
          writes.push(value);
          data.value = JSON.parse(JSON.stringify(value));
        },
      },
    };
  }

  it('applies one id to the stored list: pin appends, unpin removes, repeats are no-ops', () => {
    const { store, data } = fakePinsStore({ '/p': ['a', 'b'], '/q': ['x'] });
    const setting = createEntryPinsSetting(store, fakeLog().log);
    assert.deepEqual(setting.update('/p', 'c', true), { status: 'stored', pins: ['a', 'b', 'c'] });
    assert.deepEqual(setting.update('/p', 'a', false), { status: 'stored', pins: ['b', 'c'] });
    assert.deepEqual(setting.update('/p', 'b', true), { status: 'stored', pins: ['b', 'c'] });
    assert.deepEqual(setting.update('/p', 'zz', false), { status: 'stored', pins: ['b', 'c'] });
    assert.deepEqual(data.value, { '/p': ['b', 'c'], '/q': ['x'] });
  });

  it(`a pin past ${ENTRY_PINS_MAX} is limit, nothing stored`, () => {
    const full = Array.from({ length: ENTRY_PINS_MAX }, (_, i) => `n${i}`);
    const { store, writes } = fakePinsStore({ '/p': full });
    const setting = createEntryPinsSetting(store, fakeLog().log);
    assert.deepEqual(setting.update('/p', 'more', true), { status: 'limit', pins: full });
    assert.deepEqual(writes, []);
    assert.equal(setting.update('/p', 'n0', false).status, 'stored');
  });

  it('while the store cannot be read: an explicit error, nothing written — an unread list is never overwritten', () => {
    let readable = false;
    const data: { value: unknown } = { value: { '/p': ['kept1', 'kept2'] } };
    const writes: unknown[] = [];
    const setting = createEntryPinsSetting(
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
      fakeLog().log,
    );
    assert.deepEqual(setting.update('/p', 'new', true), { status: 'error', message: ENTRY_PINS_UNREADABLE_MESSAGE });
    assert.deepEqual(writes, []);
    readable = true;
    assert.deepEqual(setting.update('/p', 'new', true), { status: 'stored', pins: ['kept1', 'kept2', 'new'] });
    assert.deepEqual(data.value, { '/p': ['kept1', 'kept2', 'new'] });
  });

  it(`saving a hand-edited list cut to ${ENTRY_PINS_MAX} on read warns that the rest is dropped`, () => {
    const many = Array.from({ length: ENTRY_PINS_MAX + 2 }, (_, i) => `n${i}`);
    const { log, warnings } = fakeLog();
    const setting = createEntryPinsSetting(fakePinsStore({ '/p': many, '/q': ['x'] }).store, log);
    assert.equal(setting.update('/p', 'n0', false).status, 'stored');
    assert.equal(warnings.length, 2, 'the read and the cut on write');
    assert.match(warnings[1] ?? '', /drops those past the first 50/);
    setting.update('/q', 'y', true);
    assert.equal(warnings.length, 2, 'once');
  });
});

describe('the entry-pin IPC handlers (P4-7g)', () => {
  function recordingSetting(initial: Record<string, string[]> = {}) {
    const calls: unknown[][] = [];
    const real = createEntryPinsSetting(
      {
        get: () => JSON.parse(JSON.stringify(initial)) as unknown,
        set: () => {},
      },
      fakeLog().log,
    );
    const setting: EntryPinsSetting = {
      get: (projectPath) => {
        calls.push(['get', projectPath]);
        return real.get(projectPath);
      },
      set: (projectPath, ids) => {
        calls.push(['set', projectPath, [...ids]]);
        return real.set(projectPath, ids);
      },
      update: (projectPath, nodeId, pinned) => {
        calls.push(['update', projectPath, nodeId, pinned]);
        return real.update(projectPath, nodeId, pinned);
      },
    };
    return { setting, calls };
  }

  it('get: a malformed project path reads as no pins without touching the store', () => {
    const { setting, calls } = recordingSetting({ '/p': ['a'] });
    for (const bad of [undefined, null, '', 42, { path: '/p' }]) {
      assert.deepEqual(handleGetEntryPins(setting, bad), []);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(handleGetEntryPins(setting, '/p'), ['a']);
  });

  it('set: a malformed path, id or flag is an explicit error; nothing stored or handed on', () => {
    const { setting, calls } = recordingSetting({ '/p': ['a'] });
    const stored: unknown[] = [];
    const onStored = (path: string, ids: string[]) => stored.push([path, ids]);
    const invalid = { status: 'error', message: 'Invalid entry pin request.' };
    for (const bad of [42, undefined, '', null, ['/p']]) {
      assert.deepEqual(handleSetEntryPins(setting, bad, 'b', true, onStored), invalid);
    }
    for (const bad of [42, undefined, '', null, ['b']]) {
      assert.deepEqual(handleSetEntryPins(setting, '/p', bad, true, onStored), invalid);
    }
    for (const bad of [undefined, 'true', 1, null]) {
      assert.deepEqual(handleSetEntryPins(setting, '/p', 'b', bad, onStored), invalid);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(stored, []);
  });

  it('set: one id applied by main to its stored list and handed on; a refused pin is not handed on', () => {
    const { setting } = recordingSetting({ '/p': ['a'] });
    const stored: unknown[] = [];
    const onStored = (path: string, ids: string[]) => stored.push([path, ids]);
    assert.deepEqual(handleSetEntryPins(setting, '/p', 'c', true, onStored), { status: 'stored', pins: ['a', 'c'] });
    assert.deepEqual(handleSetEntryPins(setting, '/p', 'a', false, onStored), { status: 'stored', pins: ['c'] });
    assert.deepEqual(stored, [
      ['/p', ['a', 'c']],
      ['/p', ['c']],
    ]);
    const full = Array.from({ length: ENTRY_PINS_MAX }, (_, i) => `n${i}`);
    const { setting: atCap } = recordingSetting({ '/p': full });
    const before = stored.length;
    assert.deepEqual(handleSetEntryPins(atCap, '/p', 'one-more', true, onStored), { status: 'limit', pins: full });
    assert.equal(stored.length, before);
  });
});
