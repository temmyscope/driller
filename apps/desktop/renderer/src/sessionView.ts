/**
 * P0-3: the session's map lifetime and "is this live?" logic, as pure
 * functions so every transition is unit-tested (`sessionView.test.ts`) and
 * `App.tsx`/`CodeMap.tsx` only wire them up.
 *
 * `loadedProjectPath` (set once an `indexed` status for the current project
 * arrives) is what keeps the map mounted; the Graph Service status only
 * decides how the mounted map is labelled and which of its
 * Graph-Service-backed actions stay enabled. EXPERIENCE.md: never serve stale
 * structural data as if it were current — anything other than `indexed` means
 * the map shows the last completed index.
 */
import type { CodeMapEdge, CodeMapNode, GraphServiceStatusMessage } from '@driller/ipc-contracts';

// ---------------------------------------------------------------------------
// View derivation
// ---------------------------------------------------------------------------

/**
 * - `live`: the map reflects the latest completed index and every action works.
 * - `refreshing`: a normal (re)start or re-index is in progress — informational,
 *   never a failure.
 * - `degraded`: the Graph Service failed or exited — Graph-Service-backed
 *   actions are unavailable until Retry succeeds.
 */
export type SessionAvailability = 'live' | 'refreshing' | 'degraded';

export interface SessionViewInput {
  currentProjectPath: string | null;
  loadedProjectPath: string | null;
  status: GraphServiceStatusMessage | null;
}

export interface SessionView {
  /** True once the current project's map has loaded, whatever the status now. */
  showMap: boolean;
  availability: SessionAvailability;
  /** True whenever the Graph Service can only be recovered by an explicit Retry. */
  showRetry: boolean;
}

export function deriveSessionView({
  currentProjectPath,
  loadedProjectPath,
  status,
}: SessionViewInput): SessionView {
  const showMap =
    currentProjectPath !== null && loadedProjectPath !== null && currentProjectPath === loadedProjectPath;
  if (status === null) {
    // No status yet says nothing has failed: with a map on screen that's a
    // (re)start in progress, not an outage. Without a map it's moot — the
    // pre-load screen shows no availability notice.
    return { showMap, availability: showMap ? 'refreshing' : 'degraded', showRetry: false };
  }
  let availability: SessionAvailability;
  switch (status.state) {
    case 'indexed':
      availability = 'live';
      break;
    case 'starting':
    case 'alive':
    case 'indexing':
      availability = 'refreshing';
      break;
    case 'error':
    case 'exited':
      availability = 'degraded';
      break;
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled Graph Service state: ${JSON.stringify(unreachable)}`);
    }
  }
  return { showMap, availability, showRetry: status.state === 'error' || status.state === 'exited' };
}

// ---------------------------------------------------------------------------
// Status correlation and map lifetime (App.tsx)
// ---------------------------------------------------------------------------

/**
 * A status correlated to a project (it carries `path`) that isn't the one
 * currently open is stale and must change nothing — a superseded project's
 * attempt, or one for a project the user has closed (`currentProjectPath`
 * `null`). Path-less statuses are subprocess-level and always pass.
 */
export function isStatusForCurrentProject(
  status: GraphServiceStatusMessage,
  currentProjectPath: string | null,
): boolean {
  return !('path' in status) || status.path === currentProjectPath;
}

/**
 * P2-2: the header mode switcher is enabled whenever a project is open —
 * including while it is still indexing, before its map has loaded — and
 * disabled on the landing screen, where the first-open mode rule would
 * otherwise overwrite any pick.
 */
export function modeSwitcherEnabled({ currentProjectPath }: Pick<SessionViewInput, 'currentProjectPath'>): boolean {
  return currentProjectPath !== null;
}

export interface SessionMapState {
  /** The project whose map has loaded; `null` means no map is mounted. */
  loadedProjectPath: string | null;
  /** Bumped once per new `indexed` — `CodeMap`'s `dataVersion` prop. */
  dataVersion: number;
  /** Identity (path + `at`) of the last applied `indexed`, so a re-delivered copy is a no-op. */
  lastIndexedKey: string | null;
}

export const INITIAL_SESSION_MAP_STATE: SessionMapState = {
  loadedProjectPath: null,
  dataVersion: 0,
  lastIndexedKey: null,
};

/**
 * Applies a status that already passed `isStatusForCurrentProject`. Only a
 * NEW `indexed` changes anything: it marks its project's map as loaded and
 * bumps `dataVersion` exactly once. Returns the same object otherwise, so a
 * caller can tell "nothing happened" by identity.
 */
export function applyStatusToSessionMap(
  state: SessionMapState,
  status: GraphServiceStatusMessage,
): SessionMapState {
  if (status.state !== 'indexed') {
    return state;
  }
  const key = `${status.path}\u0000${status.at}`;
  if (key === state.lastIndexedKey) {
    return state;
  }
  return { loadedProjectPath: status.path, dataVersion: state.dataVersion + 1, lastIndexedKey: key };
}

/**
 * A successful project open. A map loaded for a different project never
 * survives it — but one already loaded for the opened project does: an
 * `indexed` for it can land before the open result (`handleOpenRecent` sets
 * the correlation ref optimistically), and that one is legitimately loaded.
 */
export function applyProjectOpenedToSessionMap(state: SessionMapState, openedPath: string): SessionMapState {
  if (state.loadedProjectPath === null || state.loadedProjectPath === openedPath) {
    return state;
  }
  return { ...state, loadedProjectPath: null };
}

/**
 * Close project. Forgetting `lastIndexedKey` means reopening the same project
 * waits for — and loads from — its own fresh `indexed`. `dataVersion` stays
 * monotonic; the map remounts on reopen, so its value then is the initial load.
 */
export function applyProjectClosedToSessionMap(state: SessionMapState): SessionMapState {
  return { ...state, loadedProjectPath: null, lastIndexedKey: null };
}

/**
 * P0-4: main relayed a summary-backend switch, so the Graph Service cleared
 * every summary and a loaded map is showing text the record store no longer
 * has — refetch it through the one refresh path (`dataVersion`). One bump per
 * reported switch. A no-op (same object) when no map is loaded: the next
 * load reads the cleared state anyway.
 */
export function applyBackendSwitchedToSessionMap(state: SessionMapState): SessionMapState {
  return refetchLoadedMap(state);
}

/**
 * P2-1: main handed a newly saved indexing scope to the running Graph
 * Service, whose next Code Map fetch is filtered by it — refetch a loaded map
 * through the same `dataVersion` path as a backend switch (map stays mounted,
 * viewport untouched, Node Detail closes if its Node fell out of scope). A
 * no-op (same object) when no map is loaded: the next load is already scoped.
 */
export function applyProjectScopeAppliedToSessionMap(state: SessionMapState): SessionMapState {
  return refetchLoadedMap(state);
}

/** One `dataVersion` bump for a loaded map; the same object when none is loaded. */
function refetchLoadedMap(state: SessionMapState): SessionMapState {
  if (state.loadedProjectPath === null) {
    return state;
  }
  return { ...state, dataVersion: state.dataVersion + 1 };
}

// ---------------------------------------------------------------------------
// Map refresh outcome (CodeMap.tsx)
// ---------------------------------------------------------------------------

export type CodeMapFetchReply =
  | { kind: 'ok'; nodes: CodeMapNode[]; edges: CodeMapEdge[] }
  | { kind: 'failed'; message: string };

export type NodeDetailRefresh =
  | { kind: 'unchanged' }
  | { kind: 'repoint'; node: CodeMapNode }
  | { kind: 'close' };

export type RefreshOutcome =
  /** A newer load/refresh superseded this reply — apply nothing. */
  | { kind: 'ignore' }
  /** Swap in the fresh data (viewport/history untouched) and update Node Detail. */
  | { kind: 'apply'; nodes: CodeMapNode[]; edges: CodeMapEdge[]; nodeDetail: NodeDetailRefresh }
  /** The refresh failed but a completed map is on screen: keep it, and say the refresh failed. */
  | { kind: 'keep-with-error'; message: string }
  /** The refresh failed with no completed map to fall back to: show the full error state. */
  | { kind: 'replace-with-error'; message: string };

export interface RefreshOutcomeInput {
  requestId: number;
  latestRequestId: number;
  reply: CodeMapFetchReply;
  /** Whether a completed (`ready`) map is currently on screen. */
  hasReadyData: boolean;
  /** The Node the Node Detail panel is open on, or `null` when it's closed. */
  openDetailNodeId: string | null;
}

export function resolveRefreshOutcome({
  requestId,
  latestRequestId,
  reply,
  hasReadyData,
  openDetailNodeId,
}: RefreshOutcomeInput): RefreshOutcome {
  if (requestId !== latestRequestId) {
    return { kind: 'ignore' };
  }
  if (reply.kind === 'failed') {
    return hasReadyData
      ? { kind: 'keep-with-error', message: reply.message }
      : { kind: 'replace-with-error', message: reply.message };
  }
  let nodeDetail: NodeDetailRefresh = { kind: 'unchanged' };
  if (openDetailNodeId !== null) {
    const fresh = reply.nodes.find((node) => node.id === openDetailNodeId);
    nodeDetail = fresh === undefined ? { kind: 'close' } : { kind: 'repoint', node: fresh };
  }
  return { kind: 'apply', nodes: reply.nodes, edges: reply.edges, nodeDetail };
}
