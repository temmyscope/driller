/**
 * App-wide UI settings (P2-9) — currently just the app zoom factor.
 *
 * Free of Electron imports so it runs under `npm test` with an injected
 * store (same split as cloud-key-store.ts / backend-settings.ts):
 * ui-settings-store.ts owns the real `electron-store` file under `userData`
 * (AD-5) and the process-wide instance.
 *
 * The value is cached in memory after the first read. A store read or
 * write that throws never propagates: the zoom falls back to 1 (reads) or
 * stays in memory for the session (writes). An invalid stored value is
 * validated by app-menu.ts's `parseStoredZoomFactor`, reads as 1, is
 * warned about once, and 1 is written back so the warning doesn't repeat
 * on every launch.
 */

import { DEFAULT_ZOOM_FACTOR, parseStoredZoomFactor } from './app-menu';

/** The raw persisted value, as stored — untrusted. */
export interface UiSettingsBackingStore {
  get(): unknown;
  set(value: number): void;
}

export interface UiSettingsLog {
  warn(message: string): void;
  error(message: string, detail: string): void;
}

export interface UiSettings {
  /** The zoom factor — always a valid step, 1 when unset, invalid or unreadable. */
  getZoomFactor(): number;
  /** Stores `value` snapped to a step (invalid → 1) and returns what was stored. */
  setZoomFactor(value: number): number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function createUiSettings(store: UiSettingsBackingStore, log: UiSettingsLog = console): UiSettings {
  let cached: number | undefined;

  const write = (value: number): void => {
    try {
      store.set(value);
    } catch (error) {
      log.error('Failed to persist UI settings.', errorMessage(error));
    }
  };

  return {
    getZoomFactor: () => {
      if (cached !== undefined) {
        return cached;
      }
      let raw: unknown;
      try {
        raw = store.get();
      } catch (error) {
        log.error('Failed to read UI settings; using 100% zoom.', errorMessage(error));
        cached = DEFAULT_ZOOM_FACTOR;
        return cached;
      }
      const parsed = parseStoredZoomFactor(raw);
      if (parsed === null) {
        log.warn('Ignoring an invalid persisted zoom factor; using 100%.');
        cached = DEFAULT_ZOOM_FACTOR;
        write(cached);
        return cached;
      }
      cached = parsed;
      return cached;
    },
    setZoomFactor: (value) => {
      cached = parseStoredZoomFactor(value) ?? DEFAULT_ZOOM_FACTOR;
      write(cached);
      return cached;
    },
  };
}
