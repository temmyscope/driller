/**
 * P2-10: the two main → Graph Service requests that make up AD-4's one
 * sanctioned key hop (and, since P4-7c, the `entryCandidates:list` relay at
 * the end of this file), built here as pure, injectable functions so the "no
 * key under Local" and "no blank or undecryptable key" rules are testable
 * without Electron.
 *
 * AD-4 (amended 2026-09-25): plaintext key material may cross main → Graph
 * Service only in `graphService:index` and `graphService:backendSwitched`,
 * only while Cloud is the active backend. `cloudKeyField` is the single
 * place that decides whether the field is present; `index.ts` and the
 * key-change relay (key-change-relay.ts) both build the field through it.
 */

import type {
  CloudBackend,
  DiagnosticLogEntry,
  EntryCandidatesResult,
  GraphServiceBackendSwitchedRequest,
  GraphServiceEntryPinsMissingMessage,
  GraphServiceIndexRequest,
  GraphServiceSetEntryPinsRequest,
  GraphServiceListEntryCandidatesRequest,
  GraphServiceListEntryCandidatesResultMessage,
} from '@driller/ipc-contracts';

import { INVALID_OPERATION_SECTION_RESULT, parseOperationSectionArg } from './section-operations';

/** Returns the stored key, or `undefined` when none is stored. May throw. */
export type DecryptCloudKey = () => string | undefined;

/**
 * The `cloudApiKey` part of a main → Graph Service request. Present only
 * while Cloud is active and a non-blank key is stored; otherwise empty, so
 * the request carries no key field at all (not even `cloudApiKey:
 * undefined`).
 *
 * `decrypt` is called only when Cloud is active, so main never decrypts a
 * key it won't send. A throwing decrypt counts as no key: the field is
 * omitted and a fixed sentence is logged — never the error's own text,
 * which could echo key material.
 */
export function cloudKeyField(
  activeBackend: CloudBackend,
  decrypt: DecryptCloudKey,
): { cloudApiKey?: string } {
  if (activeBackend !== 'cloud') {
    return {};
  }
  let key: string | undefined;
  try {
    key = decrypt();
  } catch {
    console.error('Could not read the stored cloud API key; sending the request without one.');
    return {};
  }
  return key !== undefined && key.trim() !== '' ? { cloudApiKey: key } : {};
}

export interface IndexRequestDeps {
  /** Absolute, OS-native path to the project root. */
  projectPath: string;
  activeBackend: CloudBackend;
  includedPaths: readonly string[];
  decrypt: DecryptCloudKey;
  /** P4-7g: the project's pins (AD-5 "Entry pins"), in pin order. */
  entryPins?: readonly string[];
}

/** The `graphService:index` request; `includedPaths` and `entryPins` are omitted when empty. */
export function buildIndexRequest(deps: IndexRequestDeps): GraphServiceIndexRequest {
  const entryPins = deps.entryPins ?? [];
  return {
    type: 'graphService:index',
    path: deps.projectPath,
    activeBackend: deps.activeBackend,
    ...cloudKeyField(deps.activeBackend, deps.decrypt),
    ...(deps.includedPaths.length > 0 ? { includedPaths: [...deps.includedPaths] } : {}),
    ...(entryPins.length > 0 ? { entryPins: [...entryPins] } : {}),
  };
}

/**
 * P4-7g: the `graphService:setEntryPins` message main posts after the
 * renderer's pins were stored — the stored list, in pin order. The Graph
 * Service applies it only for the project it is indexing or has indexed.
 */
export function buildSetEntryPinsRequest(projectPath: string, pinnedIds: readonly string[]): GraphServiceSetEntryPinsRequest {
  return { type: 'graphService:setEntryPins', projectPath, pinnedIds: [...pinnedIds] };
}

export interface BackendSwitchedRequestDeps {
  activeBackend: CloudBackend;
  decrypt: DecryptCloudKey;
}

/**
 * The `graphService:backendSwitched` request, for both a real backend switch
 * and the key-change relay. With no key field the Graph Service drops any key
 * it held (AD-4 condition 5).
 */
export function buildBackendSwitchedRequest(
  deps: BackendSwitchedRequestDeps,
): GraphServiceBackendSwitchedRequest {
  return {
    type: 'graphService:backendSwitched',
    activeBackend: deps.activeBackend,
    ...cloudKeyField(deps.activeBackend, deps.decrypt),
  };
}

// ---------------------------------------------------------------------------
// P4-7c: `entryCandidates:list` (AD-13 (f), FR-15) — main's relay to the
// Graph Service, as a seam with its dependencies passed in (the
// `diff-scope-carry-relay.ts` pattern) so every path is unit-tested without
// Electron. `index.ts` owns one instance and only delegates to it.
// ---------------------------------------------------------------------------

/** The listing is one synchronous pass over cached data in the Graph Service; sized like Blast Radius expansion's backstop. */
export const ENTRY_CANDIDATES_REQUEST_TIMEOUT_MS = 30 * 1000 + 10_000;

/** The validated `entryCandidates:list` arguments, or the reply a malformed call gets (nothing is sent then). */
export type ParsedListEntryCandidatesArgs =
  | { ok: true; projectPath: string; section?: string }
  | { ok: false; result: EntryCandidatesResult };

/**
 * The renderer's untyped `entryCandidates:list` arguments: `projectPath` a
 * non-empty string (anything else is an explicit `error`, never a throw), and
 * `section` absent or a non-empty string (`parseOperationSectionArg`).
 */
export function parseListEntryCandidatesArgs(projectPath: unknown, section: unknown): ParsedListEntryCandidatesArgs {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return { ok: false, result: { status: 'error', message: 'Invalid project path.' } };
  }
  const parsedSection = parseOperationSectionArg(section);
  if (!parsedSection.ok) {
    return { ok: false, result: INVALID_OPERATION_SECTION_RESULT };
  }
  return parsedSection.section === undefined
    ? { ok: true, projectPath }
    : { ok: true, projectPath, section: parsedSection.section };
}

/** The `graphService:listEntryCandidates` request (`section` only when given). */
export function buildListEntryCandidatesRequest(
  projectPath: string,
  requestId: number,
  section?: string,
): GraphServiceListEntryCandidatesRequest {
  return {
    type: 'graphService:listEntryCandidates',
    projectPath,
    requestId,
    ...(section === undefined ? {} : { section }),
  };
}

const ENTRY_CANDIDATES_STATUSES = new Set(['found', 'none', 'error', 'unknown-section']);

/**
 * The Graph Service's reply, checked at the process boundary: a result whose
 * `status` is not one of `EntryCandidatesResult`'s (or an `error` without a
 * message) becomes an explicit `error`; a well-formed one passes through
 * unchanged, so the renderer gets exactly what the MCP tool returns.
 */
export function toValidatedEntryCandidatesResult(result: unknown): EntryCandidatesResult {
  const status = (result as { status?: unknown } | null)?.status;
  const malformed: EntryCandidatesResult = { status: 'error', message: 'Malformed entry-candidates reply.' };
  if (typeof status !== 'string' || !ENTRY_CANDIDATES_STATUSES.has(status)) {
    return malformed;
  }
  if (status === 'error' && typeof (result as { message?: unknown }).message !== 'string') {
    return malformed;
  }
  if (
    status === 'found' &&
    (!Array.isArray((result as { candidates?: unknown }).candidates) ||
      typeof (result as { totalQualifying?: unknown }).totalQualifying !== 'number')
  ) {
    return malformed;
  }
  // P4-7g: a listing's hidden pins, when present, are ids (main logs them).
  const { hiddenPinIds } = result as { hiddenPinIds?: unknown };
  if (
    (status === 'found' || status === 'none') &&
    hiddenPinIds !== undefined &&
    (!Array.isArray(hiddenPinIds) || !hiddenPinIds.every((id) => typeof id === 'string'))
  ) {
    return malformed;
  }
  if (status === 'unknown-section') {
    const { section, knownSections } = result as { section?: unknown; knownSections?: unknown };
    if (
      typeof section !== 'string' ||
      !Array.isArray(knownSections) ||
      !knownSections.every((known) => typeof known === 'string')
    ) {
      return malformed;
    }
  }
  return result as EntryCandidatesResult;
}

export interface EntryCandidatesRelayDeps {
  /** The live Graph Service, or `null` when none is running or it is shutting down. */
  service: () => { postMessage: (message: GraphServiceListEntryCandidatesRequest) => void } | null;
  currentProjectPath: () => string | null;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  timeoutMs?: number;
}

export interface EntryCandidatesRelay {
  /** `requestListEntryCandidates`: never rejects; every failure is an explicit `error`. */
  request: (args: Extract<ParsedListEntryCandidatesArgs, { ok: true }>) => Promise<EntryCandidatesResult>;
  /**
   * A `graphService:listEntryCandidatesResult` reply: validated, then settles
   * its request (if still pending). Review round 1: `section` is the reply's
   * echo — it must be the request's section (`null` for the whole scope),
   * else the request settles with an explicit mismatch error.
   */
  settleReply: (requestId: number, result: unknown, section: unknown) => void;
  /** The Graph Service exited: every pending request settles with `message`. */
  settleAll: (message: string) => void;
  pendingCount: () => number;
}

/**
 * Each request has its own id, so several may overlap (a section switch
 * while the previous listing is in flight); a reply for an id no longer
 * pending (timed out, settled) is ignored. The failure paths match
 * `blastRadius:expand`'s: no service (or one shutting down), another
 * project, a `postMessage` throw, the timeout and the service exiting all
 * resolve to `{status: 'error'}`.
 */
export function createEntryCandidatesRelay(deps: EntryCandidatesRelayDeps): EntryCandidatesRelay {
  const pending = new Map<
    number,
    { resolve: (result: EntryCandidatesResult) => void; timer: unknown; section: string | null }
  >();
  let nextRequestId = 0;

  const settle = (requestId: number, result: EntryCandidatesResult): void => {
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
      const promise = new Promise<EntryCandidatesResult>((resolve) => {
        const timer = deps.setTimer(
          () =>
            settle(requestId, {
              status: 'error',
              message: 'Timed out waiting for the Graph Service to list the entry candidates.',
            }),
          deps.timeoutMs ?? ENTRY_CANDIDATES_REQUEST_TIMEOUT_MS,
        );
        pending.set(requestId, { resolve, timer, section: args.section ?? null });
      });
      try {
        service.postMessage(buildListEntryCandidatesRequest(args.projectPath, requestId, args.section));
      } catch (error) {
        settle(requestId, {
          status: 'error',
          message: `Failed to send the entry-candidates request to the Graph Service: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      return promise;
    },
    settleReply(requestId, result, section) {
      const entry = pending.get(requestId);
      if (entry === undefined) {
        return;
      }
      if (section !== entry.section) {
        settle(requestId, { status: 'error', message: 'Mismatched entry-candidates reply.' });
        return;
      }
      settle(requestId, toValidatedEntryCandidatesResult(result));
    },
    settleAll(message) {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { status: 'error', message });
      }
    },
    pendingCount: () => pending.size,
  };
}

/** True for a `graphService:listEntryCandidatesResult` reply (its `result` is validated by `settleReply`). */
export function isListEntryCandidatesResultMessage(
  message: unknown,
): message is GraphServiceListEntryCandidatesResultMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'graphService:listEntryCandidatesResult' &&
    typeof (message as { requestId?: unknown }).requestId === 'number'
  );
}

// ---------------------------------------------------------------------------
// P4-7g (AD-5 "Entry pins", AD-21): a pinned Node missing from the map.
// ---------------------------------------------------------------------------

/**
 * Main logs each pinned id found missing from the map — a listing's
 * `hiddenPinIds` (relayed `entryCandidates:list` replies) or the Graph
 * Service's `graphService:entryPinsMissing` after it cached a new map (review
 * round 1: so an index alone is enough) — once per session, per project, to
 * the local diagnostic log: `{eventType: 'entry-pin-missing', timestamp,
 * projectPath, nodeId}`. Never transmitted (AD-21, AD-16), and the stored
 * pin is kept: the Node may return. `append` never rejects
 * (`appendDiagnosticLogEntry`); a failed write is not retried.
 */
export function createEntryPinMissingLogger(deps: {
  append: (entry: DiagnosticLogEntry) => unknown;
  now?: () => Date;
}): (projectPath: string, nodeIds: readonly string[]) => void {
  const logged = new Set<string>();
  return (projectPath, nodeIds) => {
    for (const nodeId of nodeIds) {
      if (typeof nodeId !== 'string') {
        continue;
      }
      const key = JSON.stringify([projectPath, nodeId]);
      if (logged.has(key)) {
        continue;
      }
      logged.add(key);
      void deps.append({
        eventType: 'entry-pin-missing',
        timestamp: (deps.now?.() ?? new Date()).toISOString(),
        projectPath,
        nodeId,
      });
    }
  };
}

/** A listing's hidden pins (`[]` for any other state). */
export function hiddenPinIdsOf(result: EntryCandidatesResult): readonly string[] {
  return result.status === 'found' || result.status === 'none' ? (result.hiddenPinIds ?? []) : [];
}

/** True for a well-formed `graphService:entryPinsMissing` message (review round 1). */
export function isEntryPinsMissingMessage(message: unknown): message is GraphServiceEntryPinsMissingMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const { type, projectPath, nodeIds } = message as Record<string, unknown>;
  return (
    type === 'graphService:entryPinsMissing' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    Array.isArray(nodeIds) &&
    nodeIds.every((id) => typeof id === 'string')
  );
}
