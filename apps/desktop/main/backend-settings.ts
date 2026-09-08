/**
 * Backend config + cloud API key persistence (Story 1.6, Phase 1).
 *
 * driller's first Settings UI surface and its first `safeStorage`
 * integration. Persisted separately from Recent Projects (settings.ts) but
 * via the same established `electron-store`-under-`userData` pattern
 * (AD-5), including the same corrupted-store-falls-back-to-in-memory
 * resilience.
 *
 * Security invariants (Always, per the spec's Boundaries & Constraints):
 *  - The cloud API key is stored only as `safeStorage.encryptString()`
 *    ciphertext, base64-encoded for JSON persistence — never raw key
 *    material, anywhere, beyond the transient scope of a single
 *    encrypt call.
 *  - On Linux with no confirmed-secure OS keystore — `safeStorage` reports
 *    anything other than a known-secure backend (see
 *    `LINUX_SECURE_STORAGE_BACKENDS`), including `basic_text`, an absent
 *    API, or an unrecognized value — storing requires an explicit
 *    acknowledgment first. Deliberately an allowlist of known-good values,
 *    not a denylist of known-bad ones: never a silent insecure store.
 *  - Every catch path below logs only `error.message` (or a fixed string)
 *    — never the raw `key` argument, and never the full `error` object
 *    (which could itself embed key material via some future encryption
 *    library's error text).
 */

import Store from 'electron-store';
import { safeStorage } from 'electron';
import type { BackendConfig, CloudBackend, SetCloudApiKeyResult } from '@driller/ipc-contracts';

interface BackendSettingsSchema {
  activeBackend: CloudBackend;
  cloudKeyCiphertextBase64?: string;
}

/**
 * Coerces a value read back from disk to a known `CloudBackend` (review
 * finding, Low): the persisted file is hand-editable JSON, so a
 * syntactically-valid-but-unrecognized `activeBackend` (manual editing, or a
 * future format change) must not silently propagate as an invalid value —
 * it falls back to `'local'`, the same safe default `createStore` already
 * uses when the key is entirely absent.
 */
function coerceBackend(value: unknown): CloudBackend {
  return value === 'local' || value === 'cloud' ? value : 'local';
}

/** The subset of electron-store's API this module actually uses. */
interface BackendSettingsStore {
  getActiveBackend(): CloudBackend;
  setActiveBackendValue(value: CloudBackend): void;
  getCloudKeyCiphertextBase64(): string | undefined;
  setCloudKeyCiphertextBase64(value: string): void;
}

/**
 * Constructs the persisted backend settings store. A corrupted settings
 * file (hand-edited into invalid JSON) or an unwritable `userData`
 * directory must not crash the app — fall back to an in-memory store for
 * the session instead (mirrors settings.ts's `createStore`).
 */
function createStore(): BackendSettingsStore {
  try {
    const store = new Store<BackendSettingsSchema>({
      name: 'driller-backend-settings',
      defaults: {
        activeBackend: 'local',
      },
    });
    return {
      // Coerced through coerceBackend, not returned raw — see its doc
      // comment (review finding, Low): the persisted file is hand-editable
      // JSON, so a corrupted-but-syntactically-valid value here must not
      // silently propagate as an invalid CloudBackend.
      getActiveBackend: () => coerceBackend(store.get('activeBackend', 'local')),
      setActiveBackendValue: (value) => store.set('activeBackend', value),
      getCloudKeyCiphertextBase64: () => store.get('cloudKeyCiphertextBase64'),
      setCloudKeyCiphertextBase64: (value) => store.set('cloudKeyCiphertextBase64', value),
    };
  } catch (error) {
    console.error(
      'Failed to initialize persisted backend settings store; falling back to an in-memory store for this session.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    let inMemoryActiveBackend: CloudBackend = 'local';
    let inMemoryCloudKeyCiphertextBase64: string | undefined;
    return {
      getActiveBackend: () => inMemoryActiveBackend,
      setActiveBackendValue: (value) => {
        inMemoryActiveBackend = value;
      },
      getCloudKeyCiphertextBase64: () => inMemoryCloudKeyCiphertextBase64,
      setCloudKeyCiphertextBase64: (value) => {
        inMemoryCloudKeyCiphertextBase64 = value;
      },
    };
  }
}

const store = createStore();

/**
 * `safeStorage.getSelectedStorageBackend()` values known to mean a real,
 * secure OS-backed keystore is actually in use on Linux. Deliberately an
 * ALLOWLIST, not a denylist against `'basic_text'` (review finding, High):
 * a denylist silently treats anything NOT recognized as insecure — an
 * absent API on some Electron build, an `'unknown'` value, or any future
 * backend value Electron adds — as "secure," skipping the warning exactly
 * when driller has the least idea whether the key is actually protected.
 * An allowlist instead requires a specific, known-good match; every other
 * value (including absent/unrecognized ones) falls through to `true`
 * (insecure) below, matching this module's own "never a silent insecure
 * store" invariant.
 */
const LINUX_SECURE_STORAGE_BACKENDS: ReadonlySet<string> = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

/**
 * True on Linux unless `safeStorage` reports one of the known-secure
 * backends above — `safeStorage` otherwise falls back to storing ciphertext
 * without real OS-backed protection, so driller warns explicitly before
 * storing anything (AD-4).
 */
function isLinuxInsecureBackend(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const backend = safeStorage.getSelectedStorageBackend?.();
  return typeof backend !== 'string' || !LINUX_SECURE_STORAGE_BACKENDS.has(backend);
}

/**
 * Decrypts the stored cloud API key ciphertext for a transient handoff to
 * the Graph Service subprocess (Story 1.6, Phase 2) — the one deliberate,
 * bounded exception to "secrets stay in main" this story's Design Notes
 * describe: `safeStorage` itself is unavailable inside a
 * `utilityProcess`-forked subprocess (only `process.parentPort` is real
 * there — see services/graph-service/index.ts's module doc), so the
 * alternative would be routing every single cloud API call through main,
 * which fights AD-8's "generation lives in the Graph Service" boundary far
 * more than this one-time transient key handoff does. Called only at the
 * two points a generation run can actually start/restart
 * (`sendIndexRequest` and the `settingsSetActiveBackend` handler in
 * main/index.ts) — the decrypted key is never stored in a module-level
 * variable here, so nothing in this process retains it beyond the single
 * call that needed it.
 *
 * Returns `undefined` when no key is stored, when `safeStorage` encryption
 * is unavailable, or when decryption itself fails (e.g. ciphertext written
 * under a different OS keychain/user) — logged as only `error.message`,
 * never the ciphertext or any partial decryption result (this module's own
 * "never log raw key material" invariant), so a corrupt/foreign ciphertext
 * degrades to "no key" for the caller rather than crashing the index/
 * backend-switch flow that called this.
 */
export function getDecryptedCloudApiKey(): string | undefined {
  const ciphertextBase64 = store.getCloudKeyCiphertextBase64();
  if (!ciphertextBase64) {
    return undefined;
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    return safeStorage.decryptString(Buffer.from(ciphertextBase64, 'base64'));
  } catch (error) {
    console.error(
      'Failed to decrypt the stored cloud API key.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return undefined;
  }
}

/** Returns the current backend config for the Settings panel. */
export function getBackendConfig(): BackendConfig {
  return {
    activeBackend: store.getActiveBackend(),
    hasCloudKey: Boolean(store.getCloudKeyCiphertextBase64()),
    isLinuxInsecureBackend: isLinuxInsecureBackend(),
  };
}

/** Sets the active summary backend (local/cloud) choice. */
export function setActiveBackend(backend: CloudBackend): void {
  if (backend !== 'local' && backend !== 'cloud') {
    // Defensive: a renderer-supplied value crosses the contextBridge
    // boundary as an untyped value at runtime (same precedent as
    // main/index.ts's other IPC handlers) — silently ignored rather than
    // persisting a malformed backend choice.
    return;
  }
  store.setActiveBackendValue(backend);
}

/**
 * Attempts to store `key` as `safeStorage` ciphertext.
 *
 * On Linux with no secure keystore, the first call (without
 * `acknowledgeInsecureStorage`) stores nothing and returns an explicit
 * `'warning'` — the caller must resubmit with `acknowledgeInsecureStorage:
 * true` to actually proceed (AD-4: never a silent insecure store).
 *
 * `key` is held only for the duration of this call — never logged, never
 * returned, never retained beyond the `encryptString` call below.
 */
export function setCloudApiKey(
  key: string,
  acknowledgeInsecureStorage?: boolean,
): SetCloudApiKeyResult {
  if (typeof key !== 'string' || key.trim().length === 0) {
    // Primary rejection of an empty key is client-side (Settings.tsx, no
    // IPC call made at all) — this is a defensive backstop, matching the
    // validation main/index.ts already applies to other renderer-supplied
    // IPC arguments.
    return { status: 'error', message: 'API key cannot be empty.' };
  }

  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { status: 'error', message: 'Secure key storage is not available on this machine.' };
    }

    if (isLinuxInsecureBackend() && !acknowledgeInsecureStorage) {
      return {
        status: 'warning',
        message:
          'This machine has no secure OS keystore available, so the key would be stored with weaker protection than usual. Store it anyway?',
      };
    }

    const ciphertext = safeStorage.encryptString(key).toString('base64');
    store.setCloudKeyCiphertextBase64(ciphertext);
    return { status: 'ok' };
  } catch (error) {
    console.error(
      'Failed to store cloud API key.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return { status: 'error', message: 'Failed to store the API key securely.' };
  }
}
