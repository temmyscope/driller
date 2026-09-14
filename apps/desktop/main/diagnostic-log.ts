/**
 * Local-only diagnostic event log (Story 1.9, Phase 4, AD-21).
 *
 * driller's first diagnostic log sink, and its first departure from the
 * `electron-store`-under-`userData` pattern used everywhere else persistence
 * happens in this directory (settings.ts, backend-settings.ts): those model
 * one JSON blob, requiring a full read-modify-write per entry, which gets
 * slower as it grows. An append-only event log must never do that instead
 * `fs.promises.appendFile` writes one JSON object per line, deliberately.
 *
 * Never transmitted anywhere — no network call exists in this module, and
 * none should ever be added (AD-21, AD-16). `DiagnosticLogEntry` is a
 * discriminated union on `eventType`; this phase implements exactly one
 * member, `'path-trace-dismissed'`, designed so a future Epic 2 Risk
 * Overlay event type can extend the union and reuse this same sink without
 * redefining this one (Boundaries & Constraints).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { DiagnosticLogEntry } from '@driller/ipc-contracts';

// Resolved once, at module load — mirrors settings.ts's own module-level
// store resolution under `app.getPath('userData')` (AD-5's established
// userData-root convention), just for a plain appended file instead of an
// electron-store-backed blob.
const diagnosticLogPath = path.join(app.getPath('userData'), 'diagnostic.log');

/**
 * Appends one `DiagnosticLogEntry` to the local diagnostic log, one JSON
 * object per line. Best-effort by design (AD-21, Boundaries & Constraints):
 * a write failure (disk full, permissions) is caught and `console.error`ed
 * here only — this function never rejects/throws to its caller, so a log
 * write can never block or surface an error for whatever action triggered
 * it (Dismiss resetting the Path Trace panel to `idle`).
 */
export async function appendDiagnosticLogEntry(entry: DiagnosticLogEntry): Promise<void> {
  try {
    await fs.appendFile(diagnosticLogPath, JSON.stringify(entry) + '\n');
  } catch (error) {
    console.error(
      'Failed to append diagnostic log entry.',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
