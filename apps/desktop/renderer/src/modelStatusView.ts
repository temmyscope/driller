/**
 * P5-c review round 1: the footer's model badge shows only when the local
 * model can matter. Under Cloud it is hidden — the last status App received
 * is kept (a badge left from an earlier Local session, or late download
 * progress after a Local→Cloud switch), but never shown. Before the backend
 * config has loaded (`undefined`) the badge shows as before.
 */
import type { BackendConfig, ModelStatusMessage } from '@driller/ipc-contracts';

export function visibleModelStatus(
  status: ModelStatusMessage | null,
  activeBackend: BackendConfig['activeBackend'] | undefined,
): ModelStatusMessage | null {
  return activeBackend === 'cloud' ? null : status;
}
