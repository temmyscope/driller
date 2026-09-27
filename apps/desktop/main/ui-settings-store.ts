/**
 * The persisted UI settings instance (P2-9): its own `electron-store` file,
 * `driller-ui-settings`, under `userData` (AD-5), defaulted to
 * `{zoomFactor: 1, showFoldedKindsByProject: {}}` (P4-2 phase 3c: the
 * per-project "Show types & modules" canvas toggle). A corrupted file or
 * an unwritable `userData` directory falls back to an in-memory store for
 * the session (same discipline as project-scope-settings.ts). All
 * validation and caching live in ui-settings.ts.
 */

import Store from 'electron-store';

import { DEFAULT_ZOOM_FACTOR } from './app-menu';
import {
  createShowFoldedKindsSetting,
  createUiSettings,
  type ShowFoldedKindsBackingStore,
  type UiSettingsBackingStore,
} from './ui-settings';

interface UiSettingsSchema {
  zoomFactor: number;
  /** P4-2 phase 3c: projects whose canvas shows folded types & modules (only `true` entries). */
  showFoldedKindsByProject: Record<string, boolean>;
}

function openStore(): Store<UiSettingsSchema> {
  return new Store<UiSettingsSchema>({
    name: 'driller-ui-settings',
    defaults: { zoomFactor: DEFAULT_ZOOM_FACTOR, showFoldedKindsByProject: {} },
  });
}

let sharedStore: Store<UiSettingsSchema> | null | undefined;

/** One `electron-store` instance for both settings; `null` when it can't be opened. */
function getSharedStore(): Store<UiSettingsSchema> | null {
  if (sharedStore === undefined) {
    try {
      sharedStore = openStore();
    } catch (error) {
      console.error(
        'Failed to initialize persisted UI settings store; falling back to an in-memory store for this session.',
        error instanceof Error ? error.message : 'Unknown error',
      );
      sharedStore = null;
    }
  }
  return sharedStore;
}

function createBackingStore(): UiSettingsBackingStore {
  const store = getSharedStore();
  if (store !== null) {
    return {
      get: () => store.get('zoomFactor'),
      set: (value) => store.set('zoomFactor', value),
    };
  }
  let inMemory: unknown = DEFAULT_ZOOM_FACTOR;
  return {
    get: () => inMemory,
    set: (value) => {
      inMemory = value;
    },
  };
}

function createShowFoldedKindsBackingStore(): ShowFoldedKindsBackingStore {
  const store = getSharedStore();
  if (store !== null) {
    return {
      get: () => store.get('showFoldedKindsByProject'),
      set: (value) => store.set('showFoldedKindsByProject', value),
    };
  }
  let inMemory: unknown = {};
  return {
    get: () => inMemory,
    set: (value) => {
      inMemory = value;
    },
  };
}

export const uiSettings = createUiSettings(createBackingStore());

/** P4-2 phase 3c: the per-project "Show types & modules" canvas toggle. */
export const showFoldedKindsSetting = createShowFoldedKindsSetting(createShowFoldedKindsBackingStore());
