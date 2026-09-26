/**
 * The persisted UI settings instance (P2-9): its own `electron-store` file,
 * `driller-ui-settings`, under `userData` (AD-5), defaulted to
 * `{zoomFactor: 1}`. A corrupted file or an unwritable `userData` directory
 * falls back to an in-memory store for the session (same discipline as
 * project-scope-settings.ts). All validation and caching live in
 * ui-settings.ts.
 */

import Store from 'electron-store';

import { DEFAULT_ZOOM_FACTOR } from './app-menu';
import { createUiSettings, type UiSettingsBackingStore } from './ui-settings';

interface UiSettingsSchema {
  zoomFactor: number;
}

function createBackingStore(): UiSettingsBackingStore {
  try {
    const store = new Store<UiSettingsSchema>({
      name: 'driller-ui-settings',
      defaults: { zoomFactor: DEFAULT_ZOOM_FACTOR },
    });
    return {
      get: () => store.get('zoomFactor'),
      set: (value) => store.set('zoomFactor', value),
    };
  } catch (error) {
    console.error(
      'Failed to initialize persisted UI settings store; falling back to an in-memory store for this session.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    let inMemory: unknown = DEFAULT_ZOOM_FACTOR;
    return {
      get: () => inMemory,
      set: (value) => {
        inMemory = value;
      },
    };
  }
}

export const uiSettings = createUiSettings(createBackingStore());
