/**
 * P5-a (founder decision 6.1, 2026-10-15): main's side of "re-index when the
 * checkout moves" — pure, so every branch is unit-tested without Electron
 * (`head-drift.test.ts`). `index.ts` routes a `graphService:headChanged`
 * through `headChangedAction` and re-sends the index request
 * (`sendIndexRequest`, the same backend, key, scope and pins as a reopen) on
 * `'reindex'`; it posts `buildCheckHeadRequest`'s message
 * (`graph-service-requests.ts`) when a window regains focus.
 */
import type { GraphServiceHeadChangedMessage, GraphServiceStatusMessage } from '@driller/ipc-contracts';

/** A full commit SHA (SHA-1 or SHA-256), as `git rev-parse` prints it. */
const COMMIT_SHA = /^[0-9a-f]{40,64}$/;

/** True for a well-formed `graphService:headChanged`: a non-empty path and two commit SHAs. */
export function isHeadChangedMessage(message: unknown): message is GraphServiceHeadChangedMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const { type, path, indexedHead, currentHead } = message as Record<string, unknown>;
  return (
    type === 'graphService:headChanged' &&
    typeof path === 'string' &&
    path.length > 0 &&
    typeof indexedHead === 'string' &&
    COMMIT_SHA.test(indexedHead) &&
    typeof currentHead === 'string' &&
    COMMIT_SHA.test(currentHead)
  );
}

/**
 * What main does with a `graphService:headChanged`: `'reindex'` only when it
 * is for the project open now and the Graph Service is running; anything else
 * (a project since closed or switched, no running service) is `'ignore'`,
 * which the caller logs.
 */
export function headChangedAction(
  message: GraphServiceHeadChangedMessage,
  currentProjectPath: string | null,
  running: boolean,
): 'reindex' | 'ignore' {
  return running && currentProjectPath !== null && message.path === currentProjectPath ? 'reindex' : 'ignore';
}

/**
 * Review round 1: the e2e hook that lets the `p5-a` journey fire the real
 * `browser-window-focus` path deterministically (SIGUSR2 to main). Only in
 * an unpackaged (dev) app started with `DRILLER_E2E_HOOKS=1`, which only the
 * e2e harness sets — never in a packaged build.
 */
export function e2eHooksEnabled(isPackaged: boolean, env: Readonly<Record<string, string | undefined>>): boolean {
  return !isPackaged && env.DRILLER_E2E_HOOKS === '1';
}

/** Review round 1: the HEAD move behind the re-index main just requested for `path`. */
export interface PendingHeadMove {
  path: string;
  indexedHead: string;
  currentHead: string;
}

/**
 * Review round 1 (never a silent reset): adds `headMoved` to the statuses of
 * the re-index main started for a HEAD change — its `indexing`, then its
 * `indexed` or index-attempt `error` for that path, after which the move is
 * no longer pending. A move for a project no longer open, or a Graph Service
 * exit, drops it untagged. Every other status passes through unchanged.
 */
export function tagHeadMove(
  status: GraphServiceStatusMessage,
  pending: PendingHeadMove | undefined,
  currentProjectPath: string | null,
): { status: GraphServiceStatusMessage; pending: PendingHeadMove | undefined } {
  if (pending === undefined) {
    return { status, pending };
  }
  if (pending.path !== currentProjectPath || status.state === 'exited') {
    return { status, pending: undefined };
  }
  const headMoved = { indexedHead: pending.indexedHead, currentHead: pending.currentHead };
  if ((status.state === 'indexing' || status.state === 'indexed' || status.state === 'error') && status.path === pending.path) {
    return { status: { ...status, headMoved }, pending: status.state === 'indexing' ? pending : undefined };
  }
  return { status, pending };
}
