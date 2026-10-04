/**
 * P4-4h carry review: main's relay for `diffScope:carry` (founder decision
 * 2026-10-04) — the pending map, the timeout and the settle-on-exit, as a
 * seam with its dependencies passed in, so every path is unit-tested without
 * Electron (`diff-scope-carry-relay.test.ts`). `index.ts` owns one instance.
 *
 * Rejects nothing: no service (or one shutting down), another project, a
 * `postMessage` throw, the timeout and the service exiting all resolve to
 * `{status: 'error'}`, which the renderer treats as "not carried". Each
 * request has its own id (several checks may overlap); a reply for an id no
 * longer pending (timed out, settled) is ignored.
 */
import type {
  DiffScopeCarryResult,
  GraphServiceDiffScopeCarryRequest,
  GraphServiceDiffScopeCarryResultMessage,
} from '@driller/ipc-contracts';

import {
  buildDiffScopeCarryRequest,
  toValidatedDiffScopeCarryResult,
  type ParsedDiffScopeCarryArgs,
} from './section-operations';

/** At most two git calls in a row in the Graph Service, each with its 20 s timeout, plus slack. */
export const DIFF_SCOPE_CARRY_REQUEST_TIMEOUT_MS = 2 * 20 * 1000 + 10_000;

export interface DiffScopeCarryRelayDeps {
  /** The live Graph Service, or `null` when none is running or it is shutting down. */
  service: () => { postMessage: (message: GraphServiceDiffScopeCarryRequest) => void } | null;
  currentProjectPath: () => string | null;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  timeoutMs?: number;
}

export interface DiffScopeCarryRelay {
  request: (args: Extract<ParsedDiffScopeCarryArgs, { ok: true }>) => Promise<DiffScopeCarryResult>;
  /** A `graphService:diffScopeCarryResult` reply: validated, then settles its request (if still pending). */
  settleReply: (requestId: number, result: unknown) => void;
  /** The Graph Service exited: every pending check settles with `message`. */
  settleAll: (message: string) => void;
  pendingCount: () => number;
}

export function createDiffScopeCarryRelay(deps: DiffScopeCarryRelayDeps): DiffScopeCarryRelay {
  const pending = new Map<number, { resolve: (result: DiffScopeCarryResult) => void; timer: unknown }>();
  let nextRequestId = 0;

  const settle = (requestId: number, result: DiffScopeCarryResult): void => {
    const entry = pending.get(requestId);
    if (entry === undefined) {
      return;
    }
    pending.delete(requestId);
    deps.clearTimer(entry.timer);
    entry.resolve(result);
  };

  return {
    request(args) {
      const service = deps.service();
      if (service === null) {
        return Promise.resolve({ status: 'error', message: 'Graph Service is not running.' });
      }
      if (args.projectPath !== deps.currentProjectPath()) {
        return Promise.resolve({
          status: 'error',
          message: 'The requested project is not the currently open project.',
        });
      }
      const requestId = ++nextRequestId;
      const promise = new Promise<DiffScopeCarryResult>((resolve) => {
        const timer = deps.setTimer(
          () =>
            settle(requestId, {
              status: 'error',
              message: 'Timed out waiting for the Graph Service to check the base ref.',
            }),
          deps.timeoutMs ?? DIFF_SCOPE_CARRY_REQUEST_TIMEOUT_MS,
        );
        pending.set(requestId, { resolve, timer });
      });
      try {
        service.postMessage(buildDiffScopeCarryRequest(args, requestId));
      } catch (error) {
        settle(requestId, {
          status: 'error',
          message: `Failed to send the base-ref check to the Graph Service: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      return promise;
    },
    settleReply(requestId, result) {
      settle(requestId, toValidatedDiffScopeCarryResult(result));
    },
    settleAll(message) {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { status: 'error', message });
      }
    },
    pendingCount: () => pending.size,
  };
}

/** True for a `graphService:diffScopeCarryResult` reply (its `result` is validated by `settleReply`). */
export function isDiffScopeCarryResultMessage(message: unknown): message is GraphServiceDiffScopeCarryResultMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'graphService:diffScopeCarryResult' &&
    typeof (message as { requestId?: unknown }).requestId === 'number'
  );
}
