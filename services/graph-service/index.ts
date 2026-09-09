/**
 * Graph Service subprocess entry point (AD-1).
 *
 * This is the process-boundary adapter the rest of driller talks to instead
 * of ever touching the underlying MCP-based graph backend directly. Per
 * AD-1, it MUST be spawned by main via Electron's `utilityProcess.fork` —
 * never `child_process.fork`, and never run inline in main.
 *
 * Story 1.1 scope: start up, report an "alive" status to main over
 * `process.parentPort`, and exit cleanly when main asks it to shut down.
 *
 * Story 1.2 (Phase 1) adds the real connection: on a `graphService:index`
 * request from main, this module drives `mcp-client.ts`'s `indexRepository`
 * against the real `codebase-memory-mcp` backend, reporting `indexing` then
 * `indexed`/`error` back over the same `parentPort` handshake. A
 * backend-unavailable failure (spawn fails, or the MCP call errors) reuses
 * this same `error` status — there is no separate failure shape.
 *
 * Every indexing-attempt status is correlated to the project path it's
 * about (review round 1): a `graphService:index` request for a different
 * project while one is still in flight makes the new one authoritative —
 * the old attempt's eventual result (MCP tool calls aren't cleanly
 * cancelable mid-flight) is discarded rather than posted once superseded.
 *
 * Story 1.2 (Phase 2) adds coverage/scale transparency on top of that same
 * handshake: `elapsedMs` (timed here, around the whole `indexRepository`
 * call) on both `indexed` and index-attempt `error` posts, and an optional
 * `coverage` summary (sourced entirely from `mcp-client.ts`'s parsing of the
 * backend's own responses) on `indexed`.
 *
 * Story 1.3 (Phase 1) adds the Code Map data fetch: on a
 * `graphService:getCodeMap` request, this module drives `mcp-client.ts`'s
 * `fetchCodeMap` against the project this Graph Service most recently
 * finished indexing (`activeProject`, captured off the same `indexed`
 * result Phase 2 already parses `coverage` from — see `handleIndexRequest`),
 * and posts back a `graphService:codeMap`/`graphService:codeMapError`
 * message on the same `parentPort` channel. Fetched once per successful
 * `indexed` (main calls this after receiving `indexed`, not on every
 * render) — this module itself does not cache/re-fetch on a timer.
 *
 * Story 1.5 (Phase 1) adds two independent pieces of foundation work,
 * neither of which blocks or is blocked by the indexing flow above (AD-18):
 *
 *  - The Node record store (`node-record-store.ts`) is initialized here
 *    (using the userData path main passed as this subprocess's first fork
 *    argument — this subprocess has no runtime `app.getPath` of its own)
 *    and its active project is switched alongside every `graphService:index`
 *    request, so a later signal-family write (Phase 2's summaries) always
 *    lands against the right project's persisted file.
 *  - The local-model download/verify (`model-manager.ts`'s
 *    `ensureLocalModel`) is kicked off alongside `indexRepository`, not
 *    sequentially after it (the pre-mortem finding driving the Intent's
 *    "one bounded first-run wait" framing) — its progress/result is turned
 *    into `graphService:modelStatus` posts on this same `parentPort`
 *    channel, a stream kept separate from `graphService:status` (Design
 *    Notes: distinguished by `type`, since both unions use `state: 'error'`).
 *    Memoized module-wide: only the first `graphService:index` request in
 *    this process's lifetime actually starts a download attempt; later
 *    requests (e.g. opening a second project without restarting) share the
 *    same in-flight/settled attempt rather than re-downloading. A failed
 *    attempt is not silently auto-retried — the renderer's retry affordance
 *    reuses `restartGraphService`, which respawns this subprocess (fresh
 *    module state) and re-sends the index request.
 *
 * Story 1.5 (Phase 2) adds the actual generation pipeline on top of both
 * pieces of Phase 1 foundation: once a `graphService:getCodeMap` response is
 * ready (never before — the Code Map must stay browsable while generation
 * runs, AD-8), this module annotates every Node with its current
 * `summaryStatus`/`summary` (`summary-generator.ts`'s
 * `annotateNodesWithSummaryState`, sourced from the coverage-gap set
 * captured off the same successful `indexRepository` call Phase 2 already
 * parses `coverage` from, and the Node record store) and kicks off
 * `generateSummaries` in the background, relaying its batched progress as
 * `graphService:summaryProgress` posts. `activeSummaryGenerationId` gives a
 * later `graphService:index` request (a different project, or a re-index)
 * a way to invalidate a still-running generation tied to a now-stale
 * project/index state — without it, a slow generation run's eventual
 * `mergeNodeRecord` writes could land against `node-record-store.ts`'s
 * `records` after `setActiveProject` has already swapped it to a different
 * project (the same concurrency/correlation bug class that module's own doc
 * comment flags as already fixed twice elsewhere in this build).
 *
 * Story 1.6 (Phase 2) makes which summarizer `startSummaryGenerationForProject`
 * builds pluggable: every `graphService:index` request now carries
 * `{activeBackend, cloudApiKey?}` (main resolves this from the persisted
 * backend settings and, for cloud, a freshly-`safeStorage`-decrypted key —
 * the only process with `safeStorage` access), cached here as
 * `activeBackendConfig` and used to build either `summary-generator.ts`'s
 * `createLocalSummarizer` or `cloud-summary-generator.ts`'s
 * `createCloudSummarizer`. A new `graphService:backendSwitched` message
 * (sent when Settings' backend choice changes while a project is already
 * open) clears every persisted summary for the current project — via
 * `node-record-store.ts`'s existing per-Node merge-write API, never a new
 * store method — and re-kicks generation through the same job pool against
 * the same cached `activeCodeMapNodes` (never a fresh `fetchCodeMap`/graph
 * re-index, AD-18). Generation is simply skipped (no summarizer built at
 * all) when the active backend can't actually produce anything this run —
 * cloud with no decrypted key, or local while its own download/verify
 * attempt has failed — and the renderer derives its own "no summary backend
 * available"/"cloud selected, no key" Actionable Notices entirely from
 * `BackendConfig`/`ModelStatusMessage`, so no additional message needs to be
 * posted from here for either case.
 */

import os from 'node:os';
import path from 'node:path';
import type {
  CloudBackend,
  CodeMapNode,
  GraphServiceBackendSwitchedRequest,
  GraphServiceCodeMapMessage,
  GraphServiceGetCodeMapRequest,
  GraphServiceIndexRequest,
  GraphServiceShutdownRequest,
  GraphServiceStatusMessage,
  HardwareAdvisoryMessage,
  HardwareAdvisoryReason,
  ModelStatusMessage,
  SummaryProgressMessage,
} from '@driller/ipc-contracts';
// Type-only import: pulls in Electron's ambient `process.parentPort`
// augmentation (real, present only when forked via `utilityProcess.fork`)
// without adding a runtime dependency on the `electron` package.
import type {} from 'electron';
import { CLOUD_SUMMARY_MODEL, createCloudSummarizer } from './cloud-summary-generator';
import { ensureLocalModel, type LocalModelReady } from './model-manager';
import { fetchCodeMap, indexRepository } from './mcp-client';
import {
  flushNodeRecordStore,
  getAllNodeRecords,
  initNodeRecordStore,
  mergeNodeRecord,
  setActiveProject,
} from './node-record-store';
import {
  annotateNodesWithSummaryState,
  createLocalSummarizer,
  disposeModelContext,
  generateSummaries,
  type SummarizeFn,
} from './summary-generator';

// Stays comfortably under main's 2s forced-kill fallback for the Graph
// Service subprocess (apps/desktop/main/index.ts's teardownGraphService) —
// this is a best-effort grace period for a fast-settling in-flight index
// attempt, not a way to wait out a genuinely long-running one. A call still
// running past this window (well inside its own ~4min timeout in
// mcp-client.ts) is left to die with the process; that inherent limitation
// (MCP calls aren't cancelable, and the 2s fallback belongs to Story 1.1)
// isn't solved further here.
const SHUTDOWN_GRACE_MS = 1500;

// The project path this Graph Service is currently (or most recently)
// indexing, and the in-flight promise for it — used both to identify a
// superseded index attempt (see module doc) and to give shutdown a brief
// chance to let one settle cleanly (mcp-client.ts's `finally` tears down
// the spawned backend subprocess).
let activeIndexPath: string | null = null;
let activeIndexRequest: Promise<void> | null = null;
let isShuttingDown = false;

// The backend's own project identifier for the most recently *successfully*
// `indexed` project (Story 1.3) — set only once `handleIndexRequest`'s
// `indexRepository` call resolves, never speculatively. `fetchCodeMap`
// (mcp-client.ts) needs this exact identifier, not `activeIndexPath`'s
// filesystem path — see `IndexRepositoryResult.project`'s doc comment.
// Deliberately not cleared on a superseded/failed re-index of a different
// project: a `getCodeMap` request racing a fresh `graphService:index` for
// project B still resolves against the last project that actually finished
// (project A) rather than erroring outright, since main only ever calls
// `getCodeMap` after its own `indexed` status for the project on screen.
let activeProject: string | undefined;

// The filesystem path paired with `activeProject` (Story 1.5 Phase 2) — set
// together, on the same successful-index branch, for the same reason
// `activeProject` itself is never cleared on a superseded/failed re-index.
// `summary-generator.ts` needs the real absolute path to read source off
// disk (AD-16); `activeProject` is the backend's own opaque identifier, not
// a filesystem path.
let activeProjectPath: string | undefined;

// The current index's coverage-gap files (FR5), as POSIX-relative paths
// matching `CodeMapNode.file`'s own format — the backend's `index_status`
// reports `GapFile.path` as an absolute path (see ipc-contracts's doc
// comment on it), so `handleIndexRequest`'s success branch below converts
// each one via `toProjectRelativePosixPath` before storing it here. Set
// alongside `activeProject`/`activeProjectPath`, same never-cleared-on-
// failure reasoning.
let coverageGapFileSet: ReadonlySet<string> = new Set();

// The verified local model (Story 1.5 Phase 1's `ensureLocalModel` result),
// captured once `modelAttempt` (below) resolves — `summary-generator.ts`
// needs the model's file path/name, not just the fact that it's "ready"
// (which is all `postModelStatus`'s posted message carries).
let localModelReady: LocalModelReady | undefined;

// Invalidates a still-running `generateSummaries` call tied to a now-stale
// project/index state (Story 1.5 Phase 2) — bumped at the very start of
// `handleIndexRequest`, the same point `activeIndexPath` itself is
// reassigned, so a new index attempt (a different project, or a re-index of
// the same one) immediately supersedes any in-flight generation from
// before it. Without this, a slow generation run's eventual
// `mergeNodeRecord`/progress-post could land after `setActiveProject` has
// already swapped `node-record-store.ts`'s module state to a different
// project (see that module's own doc comment on this exact bug class).
let activeSummaryGenerationId = 0;

// The `activeSummaryGenerationId` a `generateSummaries` run is currently in
// flight for, or `null` when none is (review finding, High). Unlike
// `graphService:index`'s own sibling handler (which explicitly ignores a
// repeat request for an already-`activeIndexPath` project),
// `graphService:getCodeMap` had no equivalent guard: two overlapping
// requests for the same project (a fast double Retry click, or the
// renderer's mount effect re-firing) both pass `isSuperseded()` (nothing
// bumped `activeSummaryGenerationId` between them) and would each call
// `startSummaryGenerationForProject`, each spinning up its own
// `generateSummaries()` run against the exact same shared, memoized model
// sequence/`LlamaChatSession` concurrently — not just doubled work, but
// concurrent access to the underlying native llama.cpp binding the
// concurrency-1 `p-queue` design specifically exists to prevent. Set
// synchronously at the very top of `startSummaryGenerationForProject`,
// before that function's first `await` — Node is single-threaded, so a
// second overlapping call's own synchronous prologue can only run after
// the first one yields at its first await point, guaranteeing it observes
// this flag already set.
let activeGenerationRunId: number | null = null;

// Story 1.5 Phase 3: which hardware-advisory signal source(s) have already
// been posted this project session (Boundaries & Constraints: "sent at most
// once per signal source per project session (no repeat spam)"). Reset at
// the same point `activeSummaryGenerationId` itself is bumped, in
// `handleIndexRequest` — a new index attempt (a different project, or a
// re-index of the same one) is a fresh session, so a machine that was
// advisory-worthy last session gets an honest fresh chance to trigger the
// advisory again this session rather than staying permanently suppressed
// for the rest of this subprocess's lifetime.
let advisoryPostedForConstrainedTier = false;
let advisoryPostedForDegenerateResults = false;

// Story 1.6 (Phase 2): which summary backend to generate with, and the
// freshly-decrypted cloud key if relevant — set from `graphService:index`'s
// payload in `handleIndexRequest`, and updated in place by
// `handleBackendSwitchedRequest` on a `graphService:backendSwitched`
// message. Defaults to `'local'` only so this module has a well-typed value
// before the first `graphService:index` request ever arrives; that first
// request always overwrites it before generation can start.
let activeBackendConfig: { activeBackend: CloudBackend; cloudApiKey?: string } = {
  activeBackend: 'local',
};

// The most recently fetched Code Map's Nodes (Story 1.6, Phase 2) — cached
// here (not just passed straight through from `handleGetCodeMapRequest` to
// `startSummaryGenerationForProject`) so `handleBackendSwitchedRequest` can
// re-kick generation for the same Node set a backend switch happens against
// without re-fetching the Code Map (AD-18: a backend switch never triggers a
// graph re-index). Reset to `undefined` on every new `graphService:index`
// request — a Node set from a since-superseded project must never be reused
// for a later backend switch belonging to a different project.
let activeCodeMapNodes: CodeMapNode[] | undefined;

// main passes `app.getPath('userData')` as this subprocess's first fork
// argument (apps/desktop/main/index.ts's `spawnGraphService`) — mirrors
// Node's own `child_process.fork` argv convention, which `utilityProcess.
// fork` follows: `process.argv` is `[execPath, modulePath, ...args]`, so the
// first passed arg lands at index 2. Falls back to a session-local temp
// directory (never crashes the subprocess) if somehow absent — e.g. run
// directly under plain Node for a manual check — logging so the mismatch is
// never silent.
const userDataPath = process.argv[2] ?? fallbackUserDataPath();

function fallbackUserDataPath(): string {
  console.error(
    '[graph-service] no userData path was passed as a fork argument; falling back to a temp directory. Node records and the local model will not persist across restarts.',
  );
  return path.join(os.tmpdir(), 'driller-graph-service-fallback');
}

initNodeRecordStore(userDataPath);

// Memoizes the local-model download/verify attempt for this subprocess's
// whole lifetime — see the module doc comment above for why this is
// deliberately not re-triggered per `graphService:index` request.
let modelAttempt: Promise<void> | null = null;

function now(): string {
  return new Date().toISOString();
}

function postStatus(status: GraphServiceStatusMessage): void {
  // `process.parentPort` only exists when this script is running inside an
  // Electron `utilityProcess` (never under plain Node or a test runner).
  process.parentPort?.postMessage(status);
}

function postCodeMapMessage(message: GraphServiceCodeMapMessage): void {
  process.parentPort?.postMessage(message);
}

function postModelStatus(status: ModelStatusMessage): void {
  process.parentPort?.postMessage(status);
}

/**
 * Relays batched summary-generation progress (Story 1.5 Phase 2, AD-8) — own
 * `type`/channel, same disambiguation convention as `postCodeMapMessage`/
 * `postModelStatus`.
 */
function postSummaryProgress(message: SummaryProgressMessage): void {
  process.parentPort?.postMessage(message);
}

/**
 * Posts a `graphService:hardwareAdvisory` message, but at most once per
 * `reason` per project session (Boundaries & Constraints: "no repeat spam")
 * — `advisoryPostedForConstrainedTier`/`advisoryPostedForDegenerateResults`
 * (reset alongside `activeSummaryGenerationId` in `handleIndexRequest`) are
 * this function's own idempotency guard, so both call sites
 * (`checkConstrainedTierAdvisory` and `startSummaryGenerationForProject`'s
 * `onHardwareAdvisory` callback) can call this unconditionally without
 * duplicating the once-per-source bookkeeping themselves. Each call site
 * applies its own supersession guard (checking the project this check is
 * about is still the active one) before calling this, so a stale check
 * completing after the user has moved to a different project never reaches
 * here at all.
 */
function postHardwareAdvisory(reason: HardwareAdvisoryReason): void {
  if (reason === 'constrained-tier') {
    if (advisoryPostedForConstrainedTier) {
      return;
    }
    advisoryPostedForConstrainedTier = true;
  } else {
    if (advisoryPostedForDegenerateResults) {
      return;
    }
    advisoryPostedForDegenerateResults = true;
  }
  process.parentPort?.postMessage({
    type: 'graphService:hardwareAdvisory',
    reason,
  } satisfies HardwareAdvisoryMessage);
}

/**
 * Kicks off `ensureLocalModel()`, translating its progress callbacks and
 * eventual resolve/throw into `graphService:modelStatus` posts (mirroring
 * how `handleIndexRequest` turns `indexRepository`'s return/throw into
 * `graphService:status` posts). Fire-and-forget from the caller's
 * perspective — never awaited alongside `indexRepository`, so one's
 * failure/duration never affects the other.
 *
 * Memoized only while an attempt is in flight or has *succeeded* — a
 * `.catch()` clears `modelAttempt` back to `null` (review finding: the
 * earlier version memoized a rejected attempt for the rest of the
 * subprocess's lifetime too, so one transient network blip permanently
 * poisoned the whole session with no recovery short of restarting the
 * entire Graph Service, which also unnecessarily re-triggers indexing).
 * With this fix, a later `graphService:index` request (e.g. opening a
 * second project, or a future explicit retry affordance) can simply
 * re-invoke this function and get a clean new attempt.
 */
function kickOffModelDownload(): void {
  if (modelAttempt) {
    // Already attempted (in flight, or already succeeded) this process
    // lifetime.
    return;
  }
  modelAttempt = ensureLocalModel({
    userDataPath,
    onProgress: (progress) => {
      postModelStatus({
        type: 'graphService:modelStatus',
        state: 'downloading',
        at: now(),
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
      });
    },
    onVerifying: () => {
      postModelStatus({ type: 'graphService:modelStatus', state: 'verifying', at: now() });
    },
  })
    .then((result) => {
      // Captured for `summary-generator.ts` (Phase 2), which needs the
      // model's real file path/name, not just this posted 'ready' signal.
      localModelReady = result;
      postModelStatus({
        type: 'graphService:modelStatus',
        state: 'ready',
        at: now(),
        model: result.model,
      });
    })
    .catch((error) => {
      postModelStatus({
        type: 'graphService:modelStatus',
        state: 'error',
        at: now(),
        message: error instanceof Error ? error.message : String(error),
      });
      // Allow a future trigger to retry cleanly rather than permanently
      // poisoning this subprocess's model-download capability on one
      // failed attempt.
      modelAttempt = null;
    });
}

/**
 * Checks whether `projectPath`'s session should get the constrained-tier
 * hardware advisory (Story 1.5 Phase 3), once the model attempt this
 * subprocess is currently using has settled. Called once per
 * `handleIndexRequest`, deliberately decoupled from `kickOffModelDownload`'s
 * own one-shot `.then()` (review finding, High) — `kickOffModelDownload` is
 * memoized for the whole subprocess lifetime (Story 1.5 Phase 1's "once per
 * installation" design), so a check that only ran inside its `.then()` could
 * only ever fire for the *first* project a session opened: opening a second
 * project against an already-resolved `modelAttempt` would never re-enter
 * that `.then()` at all, silently losing the advisory for every subsequent
 * project on a genuinely constrained machine even though the condition
 * still holds. This function instead re-checks the already-known (or
 * soon-to-be-known) `localModelReady?.tier` fresh for every project.
 *
 * Guarded by `activeIndexPath !== projectPath` (review finding, Medium —
 * matching the supersession guard `startSummaryGenerationForProject`'s own
 * `onHardwareAdvisory` call site already applies) rather than posting
 * unconditionally once the awaited attempt settles: a slower-resolving
 * check for a project the user has since navigated away from (a fast
 * double open, or opening project C while B's own check is still pending)
 * must never post a stale/wrong-context advisory for a project no longer on
 * screen. `postHardwareAdvisory`'s own per-project-session
 * `advisoryPostedForConstrainedTier` flag (reset in `handleIndexRequest`)
 * still applies underneath this, so the advisory posts at most once per
 * project session even if this function is somehow invoked twice for it.
 */
async function checkConstrainedTierAdvisory(projectPath: string): Promise<void> {
  if (modelAttempt) {
    try {
      await modelAttempt;
    } catch {
      // Already reported via `graphService:modelStatus` 'error' — no tier
      // to check when the model never actually became ready.
      return;
    }
  }
  if (activeIndexPath !== projectPath || !localModelReady) {
    return;
  }
  // Story 1.5 Phase 3: the initial hardware-adequacy signal (Intent) —
  // Phase 1's own tier-selection heuristic already chose the fallback tier,
  // which is itself a live, honest proxy for "this machine is constrained"
  // (Design Notes). Checked fresh per project, per this function's own doc
  // comment above — never gated on generation having started.
  if (localModelReady.tier === 'fallback') {
    postHardwareAdvisory('constrained-tier');
  }
}

function isShutdownRequest(data: unknown): data is GraphServiceShutdownRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'graphService:shutdown'
  );
}

function isGetCodeMapRequest(data: unknown): data is GraphServiceGetCodeMapRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'graphService:getCodeMap'
  );
}

/** True for a recognized `CloudBackend` value — shared by both message-shape guards below. */
function isCloudBackendValue(value: unknown): value is CloudBackend {
  return value === 'local' || value === 'cloud';
}

function isIndexRequest(data: unknown): data is GraphServiceIndexRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, path: projectPath, activeBackend, cloudApiKey } = data as {
    type?: unknown;
    path?: unknown;
    activeBackend?: unknown;
    cloudApiKey?: unknown;
  };
  // Mirrors the validation pattern main/index.ts's projectOpenPath handler
  // already uses for a renderer-supplied path: non-empty and absolute, not
  // merely a string, before it reaches the backend uncaught. Story 1.6
  // (Phase 2) adds the same defensive treatment for `activeBackend`/
  // `cloudApiKey`, which cross the same untrusted-shape boundary (even
  // though this particular sender is main, not the renderer).
  return (
    type === 'graphService:index' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    path.isAbsolute(projectPath) &&
    isCloudBackendValue(activeBackend) &&
    (cloudApiKey === undefined || typeof cloudApiKey === 'string')
  );
}

function isBackendSwitchedRequest(data: unknown): data is GraphServiceBackendSwitchedRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, activeBackend, cloudApiKey } = data as {
    type?: unknown;
    activeBackend?: unknown;
    cloudApiKey?: unknown;
  };
  return (
    type === 'graphService:backendSwitched' &&
    isCloudBackendValue(activeBackend) &&
    (cloudApiKey === undefined || typeof cloudApiKey === 'string')
  );
}

function shutdown(): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  void finishShutdown();
}

async function finishShutdown(): Promise<void> {
  if (activeIndexRequest) {
    // Best-effort only — see SHUTDOWN_GRACE_MS's doc comment.
    await Promise.race([
      activeIndexRequest.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
  }
  // Flushes any debounced-but-not-yet-written Node record merge (AD-20) —
  // without this, a merge that landed just before shutdown could be lost to
  // the debounce window rather than surviving to the next launch. Cheap
  // local JSON I/O; not worth racing against SHUTDOWN_GRACE_MS.
  await flushNodeRecordStore();
  // Disposes the loaded local model/context if generation ever actually ran
  // this session (review finding, Medium — previously never disposed,
  // leaking the native llama.cpp resources rather than releasing them on a
  // clean subprocess shutdown). Best-effort/never throws — see
  // `disposeModelContext`'s own doc comment; not worth racing against
  // SHUTDOWN_GRACE_MS either, same reasoning as the record-store flush.
  await disposeModelContext();
  postStatus({ state: 'exited', pid: process.pid, at: now(), code: 0 });
  process.exit(0);
}

async function handleIndexRequest(
  projectPath: string,
  backendConfig: { activeBackend: CloudBackend; cloudApiKey?: string },
): Promise<void> {
  activeIndexPath = projectPath;
  // Story 1.6 Phase 2: this request's backend choice/decrypted key becomes
  // the one `startSummaryGenerationForProject` resolves a summarizer from,
  // whenever generation for this project actually starts (after the
  // `getCodeMap` round trip below). A fresh Node set is about to be fetched
  // for this (possibly new) project — any Node set cached from a previous
  // project must not be reused by a `graphService:backendSwitched` request
  // that's really about this new project.
  activeBackendConfig = backendConfig;
  activeCodeMapNodes = undefined;
  // Story 1.5 Phase 2: a new index attempt (a different project, or a
  // re-index of the same one) immediately invalidates any summary
  // generation still running from a previous index/getCodeMap cycle — see
  // `activeSummaryGenerationId`'s own doc comment for why this must happen
  // here, not only once a later `getCodeMap` request actually restarts
  // generation.
  activeSummaryGenerationId += 1;
  // Story 1.5 Phase 3: a new index attempt starts a fresh project session
  // for the hardware-advisory once-per-source guard too — see
  // `advisoryPostedForConstrainedTier`/`advisoryPostedForDegenerateResults`'s
  // own doc comment.
  advisoryPostedForConstrainedTier = false;
  advisoryPostedForDegenerateResults = false;
  // Visible within ~5s of folder selection (NFR1, AD-15): posted immediately,
  // before the potentially long-running backend call below.
  postStatus({ state: 'indexing', pid: process.pid, at: now(), path: projectPath });

  // Story 1.5 Phase 1 (AD-18): the local-model download/verify starts here,
  // alongside indexing, not sequentially after it — the pre-mortem finding
  // behind the Intent's "one bounded first-run wait." Fire-and-forget: its
  // own promise settles independently and is never awaited by this
  // function, so neither piece of work can block or be blocked by the
  // other. Memoized (see `kickOffModelDownload`'s doc comment), so this is
  // a no-op after the first `graphService:index` request in this process's
  // lifetime.
  kickOffModelDownload();
  // Story 1.5 Phase 3 (review finding, High): re-checked per project, not
  // just inside `kickOffModelDownload`'s own one-shot `.then()` — see
  // `checkConstrainedTierAdvisory`'s own doc comment for why. Fire-and-
  // forget, same reasoning as `kickOffModelDownload` itself: never awaited
  // here, so it can't delay `indexRepository` below.
  void checkConstrainedTierAdvisory(projectPath);
  // Switches the Node record store to this project (AD-19/AD-20) before
  // indexing proceeds — cheap, local JSON I/O (see node-record-store.ts),
  // and a no-op when this is already the active project (re-index of the
  // same project), so it never meaningfully delays `indexRepository` below.
  await setActiveProject(projectPath);

  // Times the whole indexRepository call (Phase 2, NFR1, AD-15): elapsedMs is
  // always present and honest on both the eventual `indexed` and `error`
  // posts below — never hidden regardless of hardware speed or repo size.
  const startedAt = Date.now();
  try {
    const { nodes, edges, coverage, project } = await indexRepository(projectPath);
    if (activeIndexPath !== projectPath) {
      // A request for a different project superseded this one while it was
      // in flight — this result is stale, discard rather than apply.
      return;
    }
    // Story 1.3: captured only on a genuinely successful index, so a
    // superseded/failed attempt (the early return above, and the catch
    // branch below) never overwrites the last project that actually
    // finished with `undefined` or a not-yet-indexed path.
    activeProject = project;
    // Story 1.5 Phase 2: captured alongside `activeProject`, same
    // never-on-failure reasoning — `activeProjectPath` is what
    // `summary-generator.ts` reads source off disk relative to.
    activeProjectPath = projectPath;
    coverageGapFileSet = new Set(
      (coverage?.gapPaths ?? []).map((gap) =>
        toProjectRelativePosixPath(projectPath, gap.path, 'coverage gap file'),
      ),
    );
    postStatus({
      state: 'indexed',
      pid: process.pid,
      at: now(),
      path: projectPath,
      nodes,
      edges,
      elapsedMs: Date.now() - startedAt,
      ...(coverage ? { coverage } : {}),
    });
  } catch (error) {
    if (activeIndexPath !== projectPath) {
      return;
    }
    // Backend-unavailable (spawn fails, or the MCP call errors/rejects/times
    // out) reuses Story 1.1's error status path — no separate failure UI.
    // This error came from an in-flight index attempt, so elapsedMs (like
    // path) is included per the Always constraint.
    postStatus({
      state: 'error',
      pid: process.pid,
      at: now(),
      path: projectPath,
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Handles a `graphService:getCodeMap` request (Story 1.3): fetches the Code
 * Map for `activeProject` (the project this Graph Service most recently
 * finished indexing) and posts back exactly one `graphService:codeMap` or
 * `graphService:codeMapError` message. Never throws — every failure path
 * (no successful index yet, or `fetchCodeMap` itself failing) is reported
 * as `graphService:codeMapError` so main's pending request always settles
 * (matrix: "Map data fetch fails" — an explicit error/retry state, never a
 * hung request).
 *
 * Story 1.5 Phase 2: on success, every Node is annotated with its current
 * `summaryStatus`/`summary` before the response is posted (Code Map:
 * "populated at `getCodeMap` fetch time"), and `generateSummaries` is kicked
 * off in the background afterward — never awaited here, so it can never
 * delay this response (AD-8: the Code Map stays browsable while generation
 * runs).
 *
 * Story 1.7: every fetched Node's `file` is normalized via
 * `toProjectRelativePosixPath` immediately after `fetchCodeMap` returns —
 * before `annotateNodesWithSummaryState`, `startSummaryGenerationForProject`,
 * or `postCodeMapMessage` — since this is the one point every downstream
 * consumer (the renderer, coverage-gap matching, the Node record store,
 * `readSourceRange`) already converges on. Closes the gap between AC2's
 * invariant ("`CodeMapNode.file` is POSIX-relative, project-root-relative")
 * and what was actually enforced: the backend's `n.file_path` used to reach
 * every one of those consumers verbatim, unlike the sibling `GapFile.path`
 * field, which already got this same defensive treatment after a
 * live-verified backend inconsistency was found there. `activeProjectPath`
 * is always set alongside `activeProject` on the same successful-index
 * branch (see that variable's own doc comment), so it's guaranteed defined
 * here given the `activeProject === undefined` guard above already passed —
 * the combined guard below only makes that existing invariant visible to the
 * type checker, it changes no observable behavior.
 */
async function handleGetCodeMapRequest(): Promise<void> {
  if (activeProject === undefined || activeProjectPath === undefined) {
    postCodeMapMessage({
      type: 'graphService:codeMapError',
      message: 'No project has finished indexing yet.',
    });
    return;
  }
  const projectRoot = activeProjectPath;
  try {
    const { nodes, edges } = await fetchCodeMap(activeProject);
    const normalizedNodes = nodes.map((node) => ({
      ...node,
      file: toProjectRelativePosixPath(projectRoot, node.file, 'Code Map node file'),
    }));
    const annotatedNodes = annotateNodesWithSummaryState(normalizedNodes, coverageGapFileSet);
    postCodeMapMessage({ type: 'graphService:codeMap', nodes: annotatedNodes, edges });
    void startSummaryGenerationForProject(normalizedNodes);
  } catch (error) {
    postCodeMapMessage({
      type: 'graphService:codeMapError',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Kicks off `generateSummaries` for the Nodes just posted in a
 * `graphService:codeMap` response (Story 1.5 Phase 2), relaying its batched
 * progress as `graphService:summaryProgress` posts. Fire-and-forget from the
 * caller's perspective (`handleGetCodeMapRequest` never awaits this).
 * Caches `nodes` into `activeCodeMapNodes` (Story 1.6, Phase 2) so a later
 * `graphService:backendSwitched` request can re-kick generation for the same
 * Node set without a fresh `fetchCodeMap` call (AD-18: never a re-index).
 *
 * Resolves which summarizer to build from `activeBackendConfig` (Story 1.6,
 * Phase 2), read fresh at the moment this function runs rather than a value
 * captured earlier, mirroring how the local branch already re-reads
 * `modelAttempt`/`localModelReady` fresh rather than a stale snapshot:
 *  - `'cloud'` with a decrypted key: `cloud-summary-generator.ts`'s
 *    `createCloudSummarizer`.
 *  - `'cloud'` with no key: generation is skipped outright — Never a silent
 *    local fallback (this story's Never constraint: no partial/mixed-backend
 *    result). The renderer derives its own "cloud selected, no key"
 *    Actionable Notice from `BackendConfig` directly; nothing further needs
 *    to be posted from here.
 *  - `'local'`: waits for the local-model download/verify (kicked off
 *    alongside indexing, Story 1.5 Phase 1) to settle before generation can
 *    start — reads the current `modelAttempt` at the moment this function
 *    runs, not a value captured earlier, so a since-failed-and-reset attempt
 *    (see `kickOffModelDownload`'s doc comment) is correctly treated as "no
 *    model available" rather than awaiting a stale reference forever. If the
 *    attempt failed, generation is likewise skipped — same "no silent
 *    fallback" reasoning, mirrored for the local side.
 *
 * `generationId` snapshots `activeSummaryGenerationId` at the moment this
 * run starts; every check against the live module variable below (both here
 * and inside `generateSummaries` via `isSuperseded`) is what lets a later
 * `graphService:index`/`graphService:backendSwitched` request — for this
 * same project or a different one — cleanly invalidate this run without it
 * corrupting `node-record-store.ts`'s now-switched-away state (see that
 * variable's own doc comment).
 *
 * Guarded by `activeGenerationRunId` (review finding, High — see that
 * variable's own doc comment): two overlapping calls for the same
 * `generationId` (a fast double Retry click, or the renderer's mount effect
 * re-firing a `graphService:getCodeMap` request) must never both reach
 * `generateSummaries`, since both would drive the same shared, memoized
 * model sequence concurrently. The second call returns immediately; only
 * the first proceeds.
 */
async function startSummaryGenerationForProject(nodes: CodeMapNode[]): Promise<void> {
  const generationId = activeSummaryGenerationId;
  const projectRoot = activeProjectPath;
  const gapFiles = coverageGapFileSet;
  const backendConfig = activeBackendConfig;

  activeCodeMapNodes = nodes;

  if (activeGenerationRunId === generationId) {
    // Already generating for this exact index generation — see
    // `activeGenerationRunId`'s doc comment. Not an error/superseded case
    // (this project's generation is legitimately still in flight), just a
    // redundant second trigger that must not start a second run.
    return;
  }
  activeGenerationRunId = generationId;

  try {
    let summarize: SummarizeFn;
    let modelName: string;

    if (backendConfig.activeBackend === 'cloud') {
      if (!backendConfig.cloudApiKey) {
        // Blocked, not a silent local fallback (Never constraint) — see this
        // function's own doc comment for why nothing further is posted here.
        return;
      }
      summarize = createCloudSummarizer(backendConfig.cloudApiKey);
      modelName = CLOUD_SUMMARY_MODEL;
    } else {
      if (modelAttempt) {
        try {
          await modelAttempt;
        } catch {
          // Already reported via `graphService:modelStatus` 'error' — nothing
          // more to do; there is no model to generate with this session.
          return;
        }
      }
      if (generationId !== activeSummaryGenerationId || !localModelReady) {
        return;
      }
      summarize = createLocalSummarizer(localModelReady);
      modelName = localModelReady.model;
    }

    if (generationId !== activeSummaryGenerationId || !projectRoot) {
      return;
    }

    await generateSummaries({
      projectRoot,
      nodes,
      coverageGapFiles: gapFiles,
      summarize,
      modelName,
      onProgress: (updated) => {
        if (generationId === activeSummaryGenerationId) {
          // `path` lets the renderer filter stale progress by the currently-
          // open project (review finding, Medium) — see
          // `SummaryProgressMessage`'s own doc comment in ipc-contracts.
          postSummaryProgress({ type: 'graphService:summaryProgress', path: projectRoot, updated });
        }
      },
      // Story 1.5 Phase 3's reactive hardware-adequacy nudge only makes
      // sense while local generation is what's actually running — it
      // recommends switching to cloud, which would be a nonsensical thing to
      // tell a user whose cloud generation is the very thing degenerating
      // (Story 1.6, Phase 2: never a fabricated/irrelevant action). Wired
      // only for the local branch; the same supersession guard `onProgress`
      // above uses still applies underneath it.
      onHardwareAdvisory:
        backendConfig.activeBackend === 'local'
          ? () => {
              if (generationId === activeSummaryGenerationId) {
                postHardwareAdvisory('degenerate-results');
              }
            }
          : undefined,
      isSuperseded: () => generationId !== activeSummaryGenerationId,
    });
  } catch (error) {
    console.error(
      `[graph-service] summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // Only clears this run's own slot — a later, genuinely new generation
    // (a different `generationId`, already holding its own value here by
    // the time this `finally` runs) must never have its slot clobbered by
    // an earlier, now-finishing run's cleanup.
    if (activeGenerationRunId === generationId) {
      activeGenerationRunId = null;
    }
  }
}

/**
 * Handles a `graphService:backendSwitched` request (Story 1.6, Phase 2) —
 * sent by main when Settings' backend choice changes while a project is
 * already open. Updates `activeBackendConfig` to the new choice, clears
 * every persisted summary for the current project via `node-record-store.
 * ts`'s existing per-Node merge-write API (`mergeNodeRecord(id, {summary:
 * undefined})` for every currently-recorded id — AD-20: a per-signal-family
 * write, never a full-record wipe of any other family), and re-kicks
 * generation for the same cached `activeCodeMapNodes` (never a fresh
 * `fetchCodeMap`/graph re-index, AD-18, Boundaries & Constraints).
 *
 * A no-op if nothing has actually been fetched yet for this project
 * (`activeCodeMapNodes` still `undefined` — e.g. the backend was switched
 * before the first `graphService:getCodeMap` response ever landed): there's
 * nothing to clear or re-queue yet, and the next `getCodeMap`-triggered
 * `startSummaryGenerationForProject` call will already read the up-to-date
 * `activeBackendConfig` this function just set.
 *
 * Bumps `activeSummaryGenerationId` (the same supersession mechanism
 * `handleIndexRequest` uses) so a still-running generation for the old
 * backend is invalidated before the fresh one starts — never a mixed-backend
 * result set (this story's Always constraint).
 */
async function handleBackendSwitchedRequest(backendConfig: {
  activeBackend: CloudBackend;
  cloudApiKey?: string;
}): Promise<void> {
  // Review finding, High: captured before `activeBackendConfig` is
  // overwritten below — this is what distinguishes a GENUINE backend switch
  // (local<->cloud, or between local tiers) from a same-value
  // re-affirmation. Settings.tsx's "resume blocked generation" nudge
  // (`attemptSaveKey` re-invoking `setActiveBackend('cloud')` after a key
  // save while cloud is already active) reuses this exact relay path with
  // `activeBackend` unchanged — without this comparison, that resume nudge
  // would silently wipe every already-successful summary just to retry the
  // Nodes that were genuinely blocked, spending real Anthropic API calls
  // regenerating summaries that already existed.
  const previousBackend = activeBackendConfig.activeBackend;
  activeBackendConfig = backendConfig;
  const nodes = activeCodeMapNodes;
  if (!nodes || nodes.length === 0) {
    return;
  }

  if (backendConfig.activeBackend === previousBackend) {
    // Same backend re-affirmed (the key-save resume case, or any other
    // same-value call) — never clears (Boundaries & Constraints: "A backend
    // switch ... clears the current project's persisted summaries" only
    // applies to an actual switch). Just re-kicks generation:
    // `generateSummaries`'s own eligibility filter (`classifyNode`) already
    // only attempts Nodes still `'pending'` per the record store, so
    // already-successful summaries are left untouched and only
    // genuinely-blocked/pending Nodes (e.g. blocked on a missing key that
    // now exists) are retried.
    activeSummaryGenerationId += 1;
    void startSummaryGenerationForProject(nodes);
    return;
  }

  // Story 1.5 Phase 3 (review finding, Low): a genuine backend switch starts
  // a fresh project session for the hardware-advisory once-per-source guard
  // too, mirroring `handleIndexRequest`'s own reset — without this, an
  // advisory that already fired during an earlier local run would never
  // re-post even if the same degenerate condition recurs after switching
  // away from local and back to it.
  advisoryPostedForConstrainedTier = false;
  advisoryPostedForDegenerateResults = false;

  const allRecords = getAllNodeRecords();
  for (const id of Object.keys(allRecords)) {
    // Wrapped (review finding, Medium — matching every other
    // `mergeNodeRecord` call site in this file/summary-generator.ts): an
    // uncaught write error here would otherwise reject this fire-and-forget
    // `void handleBackendSwitchedRequest(...)` call as an unhandled
    // rejection instead of being logged and skipped, aborting the rest of
    // this clear loop for every remaining id.
    try {
      mergeNodeRecord(id, { summary: undefined });
    } catch (error) {
      console.error(
        `[graph-service] failed to clear summary for ${id} during backend switch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  activeSummaryGenerationId += 1;
  void startSummaryGenerationForProject(nodes);
}

/**
 * Converts a raw path reported by the backend — either a gap-file path
 * (`GapFile.path`, as `index_status` reports it) or a Code Map Node's `file`
 * (`n.file_path`, as `fetchCodeMap`'s `query_graph` reports it) — into the
 * same POSIX-relative-to-project-root format `CodeMapNode.file` is documented
 * to always carry (AD-19), so `coverageGapFileSet` membership can be checked
 * with a plain `Set.has(node.file)` rather than re-resolving paths on every
 * Node.
 *
 * Handles both shapes defensively rather than trusting either caller's raw
 * value at face value: live verification against the real backend (Story
 * 1.7's own verification pass, following the same pattern this helper was
 * originally built for on the gap-path side) found `index_status` actually
 * reporting a bare relative path (e.g. `"broken.js"`, matching
 * `CodeMapNode.file` directly) for at least this backend build/invocation
 * shape — `path.relative(projectRoot, "broken.js")` on an already-relative
 * second argument silently resolves it against `process.cwd()` instead,
 * producing a garbage path that never matches any real Node's `file` and
 * letting an ineligible Node's file slip through the gap filter to generate
 * a confident-looking summary anyway (a real, live-caught bug — see this
 * spec's Verification section for the concrete before/after). Only an
 * actually-absolute `rawPath` is resolved relative to `projectRoot`; an
 * already-relative one is used as-is (after separator normalization), so
 * this is correct regardless of which shape a given backend build/response
 * reports — for either caller.
 *
 * Two review-finding hardenings (Low ×2) on top of that live-verified fix:
 *  - The resolved-absolute branch's result is checked for actually landing
 *    inside `projectRoot` (never starting with `..`, never itself absolute
 *    — the latter possible on Windows when `rawPath` names a different
 *    drive). A path that escapes silently never matches any Node's `file`
 *    either way, but previously left no diagnostic trail explaining why —
 *    logged now so a genuine backend anomaly here is traceable instead of
 *    looking identical to "no coverage gap for this Node" (gap-path caller)
 *    or silently corrupting `readSourceRange`/coverage-gap matching for the
 *    affected Node (Code Map `file` caller, Story 1.7) — best-effort passed
 *    through either way, never thrown, so one bad Node's `file` never blanks
 *    the whole map.
 *  - Separator normalization (`split`+`join` to POSIX `/`) is applied via a
 *    regex matching either `/` or `\`, not `path.sep` — `path.sep` is this
 *    *process's* own OS separator (`/` on macOS/Linux), so splitting on it
 *    alone left a literal `\` untouched on a POSIX host even though it was
 *    already being applied to both branches. A backend reporting a
 *    Windows-style `\`-separated relative path (the already-relative
 *    branch) or a resolved-absolute path that happens to retain a `\`
 *    would otherwise silently fail to match `CodeMapNode.file`'s POSIX
 *    format regardless of which branch produced it.
 *
 * `context` (review finding, Low) names which caller/field is being
 * normalized (e.g. `'coverage gap file'` vs. `'Code Map node file'`) and is
 * folded into the outside-project-root warning below — generalizing this
 * helper to two callers lost that diagnosability when the warning text was
 * genericized to plain "path", leaving no way to tell which caller/field
 * triggered a given warning beyond the raw path string itself.
 */
function toProjectRelativePosixPath(projectRoot: string, rawPath: string, context: string): string {
  let relative: string;
  if (path.isAbsolute(rawPath)) {
    relative = path.relative(projectRoot, rawPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      console.warn(
        `[graph-service] ${context} "${rawPath}" resolved outside the project root "${projectRoot}" (got "${relative}"); it will be passed through best-effort rather than corrected, so it will not match any Node's file for coverage-gap purposes and may fail to resolve for source-reading purposes.`,
      );
    }
  } else {
    relative = rawPath;
  }
  return relative.split(/[\\/]+/).join('/');
}

process.parentPort?.on('message', (event) => {
  if (isShutdownRequest(event.data)) {
    shutdown();
    return;
  }
  if (!isShuttingDown && isGetCodeMapRequest(event.data)) {
    void handleGetCodeMapRequest();
    return;
  }
  if (!isShuttingDown && isIndexRequest(event.data)) {
    if (event.data.path === activeIndexPath) {
      // Already indexing this exact project — e.g. a Retry click while the
      // first attempt is still running. A second concurrent call against
      // the same project is pure waste (and, on this backend, would just
      // collide with the first), so ignore it rather than racing it.
      return;
    }
    // Fire-and-forget from the message handler's perspective: progress is
    // reported asynchronously via postStatus, not this handler's return.
    activeIndexRequest = handleIndexRequest(event.data.path, {
      activeBackend: event.data.activeBackend,
      cloudApiKey: event.data.cloudApiKey,
    });
    return;
  }
  if (!isShuttingDown && isBackendSwitchedRequest(event.data)) {
    // Fire-and-forget, same reasoning as the index/getCodeMap branches above
    // — this message's own effects (cleared summaries, re-queued Nodes,
    // batched progress posts) are all observed asynchronously.
    void handleBackendSwitchedRequest({
      activeBackend: event.data.activeBackend,
      cloudApiKey: event.data.cloudApiKey,
    });
  }
});

process.on('SIGTERM', shutdown);

postStatus({ state: 'alive', pid: process.pid, at: now() });
