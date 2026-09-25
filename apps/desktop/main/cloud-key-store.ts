/**
 * P2-6: the cloud-key store logic behind `backend-settings.ts`, free of
 * Electron imports so it can run under `npm test` with an injected store.
 * `backend-settings.ts` stays the thin wrapper that owns the real
 * `electron-store` instance and the `safeStorage` checks.
 */

import type { BackendConfig, CloudBackend } from '@driller/ipc-contracts';

/** The store operations the key logic needs. */
export interface CloudKeyStore {
  getActiveBackend(): CloudBackend;
  getCloudKeyCiphertextBase64(): string | undefined;
  /** Deletes the stored ciphertext entry outright (never an empty-string overwrite). */
  deleteCloudKeyCiphertextBase64(): void;
}

/** The current backend config as Settings sees it. Never includes the key. */
export function backendConfigFrom(store: CloudKeyStore, isLinuxInsecureBackend: boolean): BackendConfig {
  return {
    activeBackend: store.getActiveBackend(),
    hasCloudKey: Boolean(store.getCloudKeyCiphertextBase64()),
    isLinuxInsecureBackend,
  };
}

/**
 * Deletes the stored ciphertext. Returns whether anything was removed, so
 * the caller relays a key change only when one happened. A store write
 * failure propagates.
 */
export function removeCloudKey(store: CloudKeyStore): boolean {
  if (store.getCloudKeyCiphertextBase64() === undefined) {
    return false;
  }
  store.deleteCloudKeyCiphertextBase64();
  return true;
}
