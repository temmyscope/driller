/**
 * P5-g (founder approval 2026-10-15, from the P3-5 live run): saving a
 * backend switch. A store failure (the live run forced a rename EPERM) is
 * written to the local diagnostic log with its raw message — which can name
 * the full userData file path — and the IPC rejection carries only the
 * actionable `BACKEND_SETTING_SAVE_FAILED_MESSAGE`. The renderer's switch
 * notice ("Couldn't switch to …: <message>", P3-5) then never shows a path.
 *
 * No `electron` import here, so this module (and its
 * test) load under plain `node --test`.
 */

import { BACKEND_SETTING_SAVE_FAILED_MESSAGE, type CloudBackend, type DiagnosticLogEntry } from '@driller/ipc-contracts';

export interface SaveActiveBackendDeps {
  /** Persists the choice (`backend-settings.ts`'s `setActiveBackend`); throws on a store failure. */
  save: (backend: CloudBackend) => void;
  /** The local diagnostic log (`appendDiagnosticLogEntry`, best-effort, never rejects). */
  log: (entry: DiagnosticLogEntry) => unknown;
  now?: () => Date;
}

/** Saves `backend`; on failure logs the raw error and throws the actionable message instead. */
export function saveActiveBackend(backend: CloudBackend, deps: SaveActiveBackendDeps): void {
  try {
    deps.save(backend);
  } catch (error) {
    void deps.log({
      eventType: 'backend-setting-save-failed',
      timestamp: (deps.now?.() ?? new Date()).toISOString(),
      backend,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(BACKEND_SETTING_SAVE_FAILED_MESSAGE);
  }
}
