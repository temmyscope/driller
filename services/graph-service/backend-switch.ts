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

/** What the Graph Service holds about the active summary backend, and the key when Cloud is active. */
export interface BackendConfigState {
  activeBackend: CloudBackend;
  cloudApiKey?: string;
}

/**
 * P2-10 (AD-4 condition 5): the backend config that replaces the held one on
 * every `graphService:index` and `graphService:backendSwitched`. Built only
 * from the incoming request, never merged with the previous config, so a
 * request without `cloudApiKey` drops any key held before. A key is kept
 * only under Cloud, and only when it's non-blank.
 */
export function nextBackendConfig(request: {
  activeBackend: CloudBackend;
  cloudApiKey?: string;
}): BackendConfigState {
  const { activeBackend, cloudApiKey } = request;
  return activeBackend === 'cloud' && cloudApiKey !== undefined && cloudApiKey.trim() !== ''
    ? { activeBackend, cloudApiKey }
    : { activeBackend };
}
