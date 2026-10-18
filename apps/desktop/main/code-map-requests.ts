/**
 * P4-4 phase 1b: main's Code Map request queue, as a pure, injectable module
 * so its serialization is testable without Electron.
 *
 * `utilityProcess.postMessage` has no request/response correlation and the
 * Graph Service's Code Map replies carry no `requestId`, so at most one
 * `graphService:getCodeMap` is ever outstanding:
 *  - a call for the section already in flight (or already waiting) shares
 *    that request's promise (e.g. a fast double-click on Retry);
 *  - a call for any other section waits for the in-flight request to
 *    settle, then sends its own — two in flight could cross;
 *  - the reply's echoed `section` is checked against the in-flight request
 *    by the caller (`replySection` names it) before it settles that request.
 *
 * P4-4c review round 1: `routeCodeMapReply` is main's whole reply routing
 * (the type guard, the echoed-section check, per-field validation and its
 * warnings), so `index.ts` only delegates and every branch is tested here.
 * A reply whose echoed section is not the in-flight request's is stale (a
 * reply to a request that already timed out): it is logged and dropped,
 * and the in-flight request keeps waiting for its own.
 *
 * P5-b founder decision 2: a request may be `force`d (the map's Retry): the
 * Graph Service then re-reads the map instead of serving its raw cache. A
 * forced request never shares an unforced one already sent (that one may be
 * cache-served); it waits and is sent with `force`. A waiting request for the
 * same section is shared and upgraded to `force`, and an unforced call may
 * share a forced one.
 *
 * Every request resolves, never rejects: no Graph Service, a throwing
 * `send`, its own timeout, or the caller settling it with an error all give
 * an explicit `{status: 'error'}` (the matrix's "explicit error state").
 */
import type { CodeMapResult, GraphServiceCodeMapMessage } from '@driller/ipc-contracts';

import { joinNaturally, toOkCodeMapResult, toUnknownSectionResult } from './code-map-reply';

/** The section key of a request: the allowlist entry, or `null` for the whole scope. */
export type CodeMapRequestKey = string | null;

export interface CodeMapRequesterDeps {
  /** Whether a Graph Service is running to send to. */
  isRunning: () => boolean;
  /**
   * Posts `graphService:getCodeMap` for `section` (omitted for `null`), with
   * `force: true` only when `force` (P5-b founder decision 2). May throw.
   */
  send: (section: CodeMapRequestKey, force: boolean) => void;
  /** The backstop for a request with no reply and no exit, armed when it is sent. */
  timeoutMs: number;
}

export interface CodeMapRequester {
  /**
   * Queues (or shares) a Code Map request for `section`; omitted means the
   * whole scope. `force` (P5-b founder decision 2): bypass the Graph
   * Service's raw map cache.
   */
  request: (section?: string, force?: boolean) => Promise<CodeMapResult>;
  /** The section of the request awaiting a reply; `undefined` when none is. */
  inFlightSection: () => CodeMapRequestKey | undefined;
  /**
   * Settles the request awaiting a reply with `result` (a no-op when none
   * is), then sends the next waiting one.
   */
  settleInFlight: (result: CodeMapResult) => void;
  /**
   * P4-4c review round 1: settles every request still waiting (not yet
   * sent) with `result`; the one in flight is untouched. Called when an
   * index request is sent, so a queued request never runs against a
   * project (or index) it was not asked for.
   */
  failWaiting: (result: CodeMapResult) => void;
}

interface PendingCodeMapRequest {
  key: CodeMapRequestKey;
  force: boolean;
  promise: Promise<CodeMapResult>;
  resolve: (result: CodeMapResult) => void;
}

const NOT_RUNNING: CodeMapResult = { status: 'error', message: 'Graph Service is not running.' };
const TIMED_OUT: CodeMapResult = {
  status: 'error',
  message: 'Timed out waiting for the Graph Service to respond with the Code Map.',
};

export function createCodeMapRequester(deps: CodeMapRequesterDeps): CodeMapRequester {
  let inFlight: PendingCodeMapRequest | null = null;
  let inFlightTimer: ReturnType<typeof setTimeout> | undefined;
  const waiting: PendingCodeMapRequest[] = [];

  const settleInFlight = (result: CodeMapResult): void => {
    const current = inFlight;
    if (!current) {
      return;
    }
    clearTimeout(inFlightTimer);
    inFlightTimer = undefined;
    inFlight = null;
    current.resolve(result);
    startNext();
  };

  function startNext(): void {
    while (!inFlight && waiting.length > 0) {
      const next = waiting.shift()!;
      if (!deps.isRunning()) {
        next.resolve(NOT_RUNNING);
        continue;
      }
      // Set before sending, so a synchronous settle (from `send` or a reply
      // routed while it runs) finds it.
      inFlight = next;
      inFlightTimer = setTimeout(() => {
        if (inFlight === next) {
          settleInFlight(TIMED_OUT);
        }
      }, deps.timeoutMs);
      // A backstop only: it never keeps the process alive on its own.
      inFlightTimer.unref?.();
      try {
        deps.send(next.key, next.force);
      } catch (error) {
        if (inFlight === next) {
          settleInFlight({
            status: 'error',
            message: `Failed to send the Code Map request to the Graph Service: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
  }

  const request = (section?: string, force = false): Promise<CodeMapResult> => {
    const key: CodeMapRequestKey = section ?? null;
    // P5-b founder decision 2: a forced call never shares an unforced
    // request already sent (it may be served from the cache).
    if (inFlight && inFlight.key === key && (inFlight.force || !force)) {
      return inFlight.promise;
    }
    const queued = waiting.find((pending) => pending.key === key);
    if (queued) {
      // Not sent yet: a forced call upgrades it.
      queued.force ||= force;
      return queued.promise;
    }
    if (!inFlight && !deps.isRunning()) {
      return Promise.resolve(NOT_RUNNING);
    }
    let resolve!: (result: CodeMapResult) => void;
    const promise = new Promise<CodeMapResult>((settle) => {
      resolve = settle;
    });
    waiting.push({ key, force, promise, resolve });
    startNext();
    return promise;
  };

  const failWaiting = (result: CodeMapResult): void => {
    for (const pending of waiting.splice(0)) {
      pending.resolve(result);
    }
  };

  return {
    request,
    inFlightSection: () => (inFlight ? inFlight.key : undefined),
    settleInFlight,
    failWaiting,
  };
}

/**
 * The `codeMap:get` IPC argument, validated: `undefined` (the whole scope)
 * or a string section. Anything else — `42`, `null`, an object — is
 * malformed and must never reach the Graph Service.
 */
export function parseCodeMapSectionArg(value: unknown): { ok: true; section?: string } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  return typeof value === 'string' ? { ok: true, section: value } : { ok: false };
}

/**
 * P5-b founder decision 2: the `codeMap:get` options argument, validated:
 * `undefined`, or a plain object whose `force` is absent or a boolean (no
 * other key). Anything else is malformed and nothing is sent.
 */
export function parseCodeMapOptionsArg(value: unknown): { ok: true; force: boolean } | { ok: false } {
  if (value === undefined) {
    return { ok: true, force: false };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'force')) {
    return { ok: false };
  }
  const force = (value as { force?: unknown }).force;
  if (force !== undefined && typeof force !== 'boolean') {
    return { ok: false };
  }
  return { ok: true, force: force === true };
}

/** P5-b founder decision 2: the reply to a malformed `codeMap:get` options argument (nothing is sent). */
export const INVALID_CODE_MAP_OPTIONS_RESULT: CodeMapResult = { status: 'error', message: 'Invalid Code Map request options.' };

/** The reply to a malformed `codeMap:get` argument (nothing is sent). */
export const INVALID_SECTION_RESULT: CodeMapResult = { status: 'error', message: 'Invalid section.' };

/** P4-4c review round 1: what queued Code Map requests get when an index request is sent before them. */
export const PROJECT_CHANGED_RESULT: CodeMapResult = {
  status: 'error',
  message: 'The project changed or was re-indexed before the Code Map request was sent.',
};

/** The reply settled when a Code Map reply's echoed section is malformed (neither a string nor `null`). */
export const MALFORMED_REPLY_RESULT: CodeMapResult = {
  status: 'error',
  message: 'The Code Map reply from the Graph Service was malformed.',
};

const CODE_MAP_MESSAGE_TYPES: readonly string[] = [
  'graphService:codeMap',
  'graphService:codeMapUnknownSection',
  'graphService:codeMapError',
];

/**
 * True for a Code Map reply (`graphService:codeMap`, `…UnknownSection` or
 * `…Error`) — distinguished from a `GraphServiceStatusMessage` by `type`
 * rather than `state`, per `ipc-contracts`'s doc comment on
 * `GraphServiceCodeMapMessage`.
 */
export function isCodeMapMessage(message: unknown): message is GraphServiceCodeMapMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    CODE_MAP_MESSAGE_TYPES.includes((message as { type?: unknown }).type as string)
  );
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Settles the in-flight Code Map request from one Graph Service reply, or
 * drops the reply:
 *  - nothing in flight → logged and ignored;
 *  - an error with no echoed `section` (it cannot echo one) → settles the
 *    request in flight, as before P4-4;
 *  - an echoed `section` that is neither a string nor `null` → an explicit
 *    malformed-reply error;
 *  - an echoed `section` other than the in-flight request's → stale (its
 *    request already timed out): logged and dropped, the request keeps
 *    waiting;
 *  - otherwise the ok map (validated by `toOkCodeMapResult`, one warning per
 *    kind of malformed field), the unknown-section state
 *    (`toUnknownSectionResult`) or the error settles it.
 */
export function routeCodeMapReply(
  message: GraphServiceCodeMapMessage,
  requester: Pick<CodeMapRequester, 'inFlightSection' | 'settleInFlight'>,
  warn: (text: string) => void = console.warn,
): void {
  const expected = requester.inFlightSection();
  if (expected === undefined) {
    warn('Code Map reply arrived with no request in flight; ignored.');
    return;
  }
  const hasEcho = Object.prototype.hasOwnProperty.call(message, 'section');
  const echo: unknown = (message as { section?: unknown }).section;
  if (message.type === 'graphService:codeMapError' && !hasEcho) {
    requester.settleInFlight({ status: 'error', message: errorText(message.message) });
    return;
  }
  if (echo !== null && typeof echo !== 'string') {
    warn('Code Map reply had a malformed section.');
    requester.settleInFlight(MALFORMED_REPLY_RESULT);
    return;
  }
  if (echo !== expected) {
    warn(
      `Dropped a stale Code Map reply for ${describeSection(echo)}; still waiting for ${describeSection(expected)}.`,
    );
    return;
  }
  if (message.type === 'graphService:codeMapError') {
    requester.settleInFlight({ status: 'error', message: errorText(message.message) });
    return;
  }
  if (message.type === 'graphService:codeMapUnknownSection') {
    const validated = toUnknownSectionResult(message);
    if (!validated) {
      requester.settleInFlight(MALFORMED_REPLY_RESULT);
      return;
    }
    if (validated.dropped > 0) {
      warn(`Unknown-section reply had ${plural(validated.dropped, 'malformed known section')}; dropped.`);
    }
    requester.settleInFlight(validated.result);
    return;
  }
  // P2-5: the scope fields are validated here, at the process boundary.
  // P4-2 phase 3b/3c: and each folded type / Module; P4-2 phase 4: each
  // Node's "Similar implementations"; P4-3 phase 5: each Node's
  // test-coverage flags; P4-4 phase 1b: `section` and `sections`; P4-4
  // phase 3a: the cross-section counts.
  const {
    result,
    replaced,
    droppedFoldedTypes,
    droppedFoldedModules,
    droppedSimilarTo,
    droppedTestCoverageAvailable,
    droppedSections,
    droppedCrossSection,
  } = toOkCodeMapResult(message);
  if (replaced.length > 0) {
    warn(`Code Map reply had malformed ${joinNaturally(replaced)}; replaced with the empty default.`);
  }
  const drops: [number, string][] = [
    [droppedFoldedTypes, 'malformed folded type'],
    [droppedFoldedModules, 'malformed folded Module'],
    [droppedSimilarTo, 'malformed similar implementation'],
    [droppedTestCoverageAvailable, 'malformed test-coverage flag'],
    [droppedSections, 'malformed section count'],
    // P4-4 phase 3a.
    [droppedCrossSection, 'malformed cross-section count'],
  ];
  for (const [count, what] of drops) {
    if (count > 0) {
      warn(`Code Map reply had ${plural(count, what)}; dropped.`);
    }
  }
  requester.settleInFlight(result);
}

function describeSection(section: unknown): string {
  return section === null ? 'the whole scope' : `section ${JSON.stringify(section)}`;
}

function errorText(message: unknown): string {
  return typeof message === 'string' ? message : 'The Code Map request to the Graph Service failed.';
}
