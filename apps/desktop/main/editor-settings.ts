/**
 * External editor preference persistence (Story 1.10, Phase 1).
 *
 * Phase 2's external-editor hand-off needs a Settings-configured preference
 * to read — this file is only the storage foundation; it has no consumer
 * yet (Never, this story's Boundaries & Constraints).
 *
 * Mirrors backend-settings.ts's exact shape (Always, this story's
 * Boundaries & Constraints): a `Schema` interface + `defaults` object
 * passed to `new Store<Schema>({name, defaults})`, a narrow `Store*`
 * interface exposing only the methods used, `createStore()` wrapped in
 * try/catch with an in-memory fallback for a corrupted store file or an
 * unwritable `userData` directory. Persisted via its own `electron-store`
 * file under the same established `userData` convention (AD-5) — a
 * separate store from backend-settings.ts's `activeBackend`/cloud-key
 * fields, never touching that existing store (Never).
 *
 * AD-23: `editorPreference` is required and always-populated — never
 * `undefined`/unset. Any unrecognized persisted value (hand-edited store
 * file, or a future format change) coerces to `'system-default'` rather
 * than propagating invalid state, mirroring backend-settings.ts's own
 * `coerceBackend`-with-safe-fallback pattern exactly.
 */

import Store from 'electron-store';
import type { EditorPreference } from '@driller/ipc-contracts';

interface EditorSettingsSchema {
  editorPreference: EditorPreference;
}

const DEFAULT_EDITOR_PREFERENCE: EditorPreference = 'system-default';

/**
 * Coerces a value read back from disk to a known `EditorPreference` (same
 * reasoning as backend-settings.ts's `coerceBackend`): the persisted file is
 * hand-editable JSON, so a syntactically-valid-but-unrecognized
 * `editorPreference` (manual editing, or a future format change) must not
 * silently propagate as an invalid value — it falls back to
 * `'system-default'`, the same safe default `createStore` already uses when
 * the key is entirely absent.
 */
function coerceEditorPreference(value: unknown): EditorPreference {
  return value === 'vscode' || value === 'jetbrains' || value === 'system-default'
    ? value
    : DEFAULT_EDITOR_PREFERENCE;
}

/** The subset of electron-store's API this module actually uses. */
interface EditorSettingsStore {
  getEditorPreferenceValue(): EditorPreference;
  setEditorPreferenceValue(value: EditorPreference): void;
}

/**
 * Constructs the persisted editor settings store. A corrupted settings file
 * (hand-edited into invalid JSON) or an unwritable `userData` directory must
 * not crash the app — fall back to an in-memory store for the session
 * instead (mirrors backend-settings.ts's `createStore`).
 */
function createStore(): EditorSettingsStore {
  try {
    const store = new Store<EditorSettingsSchema>({
      name: 'driller-editor-settings',
      defaults: {
        editorPreference: DEFAULT_EDITOR_PREFERENCE,
      },
    });
    return {
      // Coerced through coerceEditorPreference, not returned raw — see its
      // doc comment: the persisted file is hand-editable JSON, so a
      // corrupted-but-syntactically-valid value here must not silently
      // propagate as an invalid EditorPreference (AD-23).
      getEditorPreferenceValue: () =>
        coerceEditorPreference(store.get('editorPreference', DEFAULT_EDITOR_PREFERENCE)),
      // Guarded independently of the constructor's own try/catch above
      // (review finding): a write can fail at runtime even after
      // construction succeeded (disk fills up mid-session, permissions
      // revoked, `userData` removed while the app is running) — without its
      // own guard, that throw would propagate uncaught through
      // setEditorPreference() and the IPC handler instead of failing
      // gracefully like a construction-time failure already does.
      setEditorPreferenceValue: (value) => {
        try {
          store.set('editorPreference', value);
        } catch (error) {
          console.error(
            'Failed to persist the editor preference.',
            error instanceof Error ? error.message : 'Unknown error',
          );
        }
      },
    };
  } catch (error) {
    console.error(
      'Failed to initialize persisted editor settings store; falling back to an in-memory store for this session.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    let inMemoryEditorPreference: EditorPreference = DEFAULT_EDITOR_PREFERENCE;
    return {
      getEditorPreferenceValue: () => inMemoryEditorPreference,
      setEditorPreferenceValue: (value) => {
        inMemoryEditorPreference = value;
      },
    };
  }
}

const store = createStore();

/**
 * Returns the current editor preference for the Settings panel. Always a
 * known `EditorPreference` — never `undefined`/unset (AD-23), whether this
 * is the very first launch (the persisted `'system-default'` default) or a
 * read-back of a previously coerced/saved value.
 */
export function getEditorPreference(): EditorPreference {
  return store.getEditorPreferenceValue();
}

/** Sets the external editor preference choice. */
export function setEditorPreference(value: EditorPreference): void {
  if (value !== 'vscode' && value !== 'jetbrains' && value !== 'system-default') {
    // Defensive: a renderer-supplied value crosses the contextBridge
    // boundary as an untyped value at runtime (same precedent as
    // backend-settings.ts's setActiveBackend) — silently ignored rather
    // than persisting a malformed preference.
    return;
  }
  store.setEditorPreferenceValue(value);
}
