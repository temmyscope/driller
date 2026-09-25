/**
 * P2-6: relays a cloud API key change (a save or a removal) to the running
 * Graph Service, so a replaced or removed key takes effect without a
 * re-index.
 *
 * Before this, only a backend switch relayed the key, so replacing or
 * removing a key while Cloud was active and a project was open left the
 * running service generating with the old key until the next index. The
 * relay reuses `graphService:backendSwitched` with the same, unchanged
 * `activeBackend: 'cloud'` — the Graph Service's same-backend branch
 * (`backendSwitchKind` → `'reaffirm'`) swaps its backend config and re-kicks
 * only still-pending Nodes, never clearing existing summaries.
 *
 * main is the only process that decrypts; the key crosses main → Graph
 * Service only, never back to the renderer.
 */

import type {
  BackendConfig,
  CloudBackend,
  GraphServiceBackendSwitchedRequest,
} from '@driller/ipc-contracts';

export interface KeyChangeRelayInput {
  activeBackend: CloudBackend;
  serviceRunning: boolean;
  projectOpen: boolean;
}

/**
 * Whether a key change must be relayed: only while Cloud is active, a Graph
 * Service is running and a project is open. Otherwise the next
 * `graphService:index` already carries the current key state.
 */
export function shouldRelayKeyChange(input: KeyChangeRelayInput): boolean {
  return input.activeBackend === 'cloud' && input.serviceRunning && input.projectOpen;
}

/** The `backendSwitched` message for a key change; `cloudApiKey` is absent when no key is stored. */
export function keyChangeMessage(key: string | undefined): GraphServiceBackendSwitchedRequest {
  return {
    type: 'graphService:backendSwitched',
    activeBackend: 'cloud',
    ...(key ? { cloudApiKey: key } : {}),
  };
}

export interface KeyChangeRelayDeps {
  getConfig: () => BackendConfig;
  /** Decrypts the stored key — called only once a message will actually be posted. */
  decrypt: () => string | undefined;
  service: { postMessage: (message: GraphServiceBackendSwitchedRequest) => void } | null;
  currentProjectPath: string | null;
}

/**
 * Assembles and posts the key-change relay. Best-effort: the key save or
 * removal has already succeeded when this runs, so any failure here (a
 * decrypt error, `postMessage` on a dying process) is logged — without key
 * material — and reported as not relayed, never thrown.
 *
 * Returns whether a message was posted, which main hands back to the
 * renderer as `relayed` so it re-kicks the map only when generation was.
 */
export function relayKeyChange(deps: KeyChangeRelayDeps): boolean {
  try {
    const { service } = deps;
    const relay = shouldRelayKeyChange({
      activeBackend: deps.getConfig().activeBackend,
      serviceRunning: service !== null,
      projectOpen: Boolean(deps.currentProjectPath),
    });
    if (!relay || service === null) {
      return false;
    }
    service.postMessage(keyChangeMessage(deps.decrypt()));
    return true;
  } catch (error) {
    console.error(
      'Failed to relay the cloud API key change to the Graph Service.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return false;
  }
}
