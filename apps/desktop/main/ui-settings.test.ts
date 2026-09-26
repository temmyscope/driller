/**
 * P2-9: the persisted zoom reads back as a valid step; a corrupt value
 * reads as 1, warns once and is repaired; a throwing store never breaks
 * the app.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createUiSettings, type UiSettingsBackingStore, type UiSettingsLog } from './ui-settings';

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
