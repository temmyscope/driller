/**
 * Classifies a `graphService:backendSwitched` message (P2-6).
 *
 * `'switch'` is a genuine local<->cloud change: it clears the project's
 * persisted summaries and regenerates every Node. `'reaffirm'` is the same
 * backend sent again — main's key-change relay after a key save or removal
 * while Cloud is active — and must never clear summaries: it only swaps the
 * backend config (the new or absent key) and re-kicks still-pending Nodes.
 */

import type { CloudBackend } from '@driller/ipc-contracts';

export type BackendSwitchKind = 'reaffirm' | 'switch';

export function backendSwitchKind(previous: CloudBackend, next: CloudBackend): BackendSwitchKind {
  return previous === next ? 'reaffirm' : 'switch';
}
