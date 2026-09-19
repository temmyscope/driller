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
 *
 * Story 1.8 (Phase 4) adds `handleRegenerateNodeRequest`, dispatched off a
 * `graphService:regenerateNode` request — this app's first id-keyed mutating
 * IPC round-trip. It resolves a summarizer the same way
 * `startSummaryGenerationForProject` does (reading `activeBackendConfig`/
 * `modelAttempt`/`localModelReady` fresh), but drives exactly one Node
 * through `summary-generator.ts`'s new `regenerateNodeSummary` instead of
 * the whole-project `generateSummaries` batch — bypassing that function's
 * `'pending'`-only eligibility filter and the `activeGenerationRunId`/
 * `activeSummaryGenerationId` supersession gates entirely, since this is a
 * single explicit action scoped to one Node ID, never a broader run. Both
 * paths' `summarize()` calls still funnel through the same
 * `sharedSummaryQueue` (summary-generator.ts), so a regenerate call can
 * never run a local-model generation concurrently with another regenerate
 * call or an in-progress whole-project batch.
 */

import os from 'node:os';
import path from 'node:path';
import {
  buildBidirectionalAdjacency,
  computeBlastRadiusFromAdjacency,
  traceCallPath,
  type BidirectionalAdjacency,
} from '@driller/graph-contracts';
import type {
  CloudBackend,
  CodeMapNode,
  GraphServiceBackendSwitchedRequest,
  GraphServiceCodeMapMessage,
  GraphServiceGetCodeMapRequest,
  GraphServiceIndexRequest,
  GraphServicePathTraceRequest,
  GraphServicePathTraceResultMessage,
  GraphServiceRegenerateNodeRequest,
  GraphServiceRegenerateNodeResultMessage,
  GraphServiceRunIngestionRequest,
  GraphServiceRunIngestionResultMessage,
  GraphServiceShutdownRequest,
  GraphServiceStatusMessage,
  HardwareAdvisoryMessage,
  HardwareAdvisoryReason,
  LlmJudgmentProgressMessage,
  ModelStatusMessage,
  PrBotIngestionResult,
  RegenerateNodeResult,
  RiskSignal,
  SummaryProgressMessage,
} from '@driller/ipc-contracts';
// Type-only import: pulls in Electron's ambient `process.parentPort`
// augmentation (real, present only when forked via `utilityProcess.fork`)
// without adding a runtime dependency on the `electron` package.
import type {} from 'electron';
import { CLOUD_SUMMARY_MODEL, createCloudSummarizer } from './cloud-summary-generator';
import { CODERABBIT_SOURCE_TOOL, runCodeRabbitIngestion } from './coderabbit-adapter';
import { CLOUD_JUDGMENT_MODEL, createCloudJudge, createLocalJudge, generateJudgments } from './judgment-generator';
import { ensureLocalModel, type LocalModelReady } from './model-manager';
import { hasCoverageGap, loadLcovCoverage, type LcovCoverage } from './lcov';
import { fetchCodeMap, indexRepository, type CodeMapNodeWithSignalSources } from './mcp-client';
import {
  flushNodeRecordStore,
  getAllNodeRecords,
  getNodeRecord,
  initNodeRecordStore,
  mergeNodeRecord,
  setActiveProject,
} from './node-record-store';
import {
  annotateNodesWithSummaryState,
  classifyNode,
  createLocalSummarizer,
  detectStaleness,
  disposeModelContext,
  generateSummaries,
  regenerateNodeSummary,
  type RegenerateRevalidationResult,
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

// The `activeSummaryGenerationId` a `generateJudgments` run is currently in
// flight for, or `null` when none is (Story 2.2, Phase 2) — the exact same
// overlapping-call guard shape as `activeGenerationRunId` above, for the same
// reason: two overlapping `graphService:getCodeMap` requests for the same
// project must never both reach `generateJudgments`, since both would drive
// the same shared, memoized model sequence (`sharedSummaryQueue`) at once.
// Deliberately keyed off the same `activeSummaryGenerationId` counter
// `activeGenerationRunId` uses, not a separate one — a project switch or
// re-index must invalidate an in-flight judgment run exactly as readily as
// an in-flight summary run, and reusing the one counter both already bump on
// guarantees the two can never disagree about what counts as "superseded."
let activeJudgmentGenerationRunId: number | null = null;

// The `activeSummaryGenerationId` a `detectStaleness` pass is currently in
// flight for, or `null` when none is (Story 1.8 Phase 2 review finding,
// Medium) — the exact same guard shape as `activeGenerationRunId` above,
// for the same reason: two overlapping `graphService:getCodeMap` requests
// for the same, unchanged index generation (two renderer refetches with no
// intervening re-index) would otherwise both pass `isSuperseded()` (nothing
// bumped `activeSummaryGenerationId` between them) and each run a full,
// redundant `detectStaleness` pass over the same Nodes concurrently — not
// unsafe (unlike the generation case, there's no shared native resource),
// but wasted duplicate stat/hash I/O and duplicate `mergeNodeRecord` calls.
// Set synchronously in `handleGetCodeMapRequest` right before kicking off
// `detectStaleness`, before that call's first `await` — Node is
// single-threaded, so a second overlapping request's own synchronous
// prologue can only run after the first one yields, guaranteeing it
// observes this flag already set.
let activeStalenessRunId: number | null = null;

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

/**
 * Posts a `graphService:regenerateNodeResult` reply (Story 1.8, Phase 4) —
 * own `type`/channel, same disambiguation convention as `postCodeMapMessage`.
 */
function postRegenerateNodeResultMessage(message: GraphServiceRegenerateNodeResultMessage): void {
  process.parentPort?.postMessage(message);
}

/**
 * Posts a `graphService:pathTraceResult` reply (Story 1.9, Phase 1) — own
 * `type`/channel, same disambiguation convention as
 * `postRegenerateNodeResultMessage`/`postCodeMapMessage`.
 */
function postPathTraceResultMessage(message: GraphServicePathTraceResultMessage): void {
  process.parentPort?.postMessage(message);
}

/**
 * Posts a `graphService:runIngestionResult` reply (Story 2.3, Phase 2) —
 * own `type`/channel, same disambiguation convention as
 * `postRegenerateNodeResultMessage`/`postPathTraceResultMessage`.
 */
function postRunIngestionResultMessage(message: GraphServiceRunIngestionResultMessage): void {
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
 * Relays batched LLM-judgment generation progress (Story 2.2, Phase 2, AD-8)
 * — own `type`/channel, same disambiguation convention as
 * `postSummaryProgress`; never repurposes `SummaryProgressMessage`'s own
 * `summary`-shaped field (Always).
 */
function postLlmJudgmentProgress(message: LlmJudgmentProgressMessage): void {
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

/**
 * True for a `graphService:pathTrace` request (Story 1.9, Phase 1) — mirrors
 * `isGetCodeMapRequest`'s shape, plus defensive checks that `query` is
 * actually a non-whitespace-only string and `requestId` is actually a
 * number, the same untrusted-shape treatment `isRegenerateNodeRequest`
 * already applies to `nodeId` for values crossing this `parentPort` boundary
 * from main (main's own `ipcMain.handle` already validates `query` before
 * sending, but this process trusts nothing crossing its own boundary
 * either). `query.trim().length > 0` (not just `query.length > 0`) rejects a
 * whitespace-only query the same way main's own IPC handler does — see that
 * handler's doc comment for why (a whitespace-only query is otherwise easy
 * to produce calling `window.driller.tracePath(...)` by hand, this phase's
 * documented entry point, and would otherwise silently fall through to
 * `traceCallPath`'s substring-match tier and match every Node).
 */
function isPathTraceRequest(data: unknown): data is GraphServicePathTraceRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, query, requestId } = data as { type?: unknown; query?: unknown; requestId?: unknown };
  return (
    type === 'graphService:pathTrace' &&
    typeof query === 'string' &&
    query.trim().length > 0 &&
    typeof requestId === 'number'
  );
}

/**
 * True for a `graphService:regenerateNode` request (Story 1.8, Phase 4) —
 * mirrors `isGetCodeMapRequest`'s shape, plus a defensive check that
 * `nodeId` is actually a non-empty string, the same untrusted-shape
 * treatment `isIndexRequest` already applies to values crossing this
 * `parentPort` boundary from main.
 */
function isRegenerateNodeRequest(data: unknown): data is GraphServiceRegenerateNodeRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, nodeId } = data as { type?: unknown; nodeId?: unknown };
  return type === 'graphService:regenerateNode' && typeof nodeId === 'string' && nodeId.length > 0;
}

/**
 * True for a `graphService:runIngestion` request (Story 2.3, Phase 2) —
 * mirrors `isRegenerateNodeRequest`'s shape; `bot` is narrowed to the
 * literal `'codeRabbit'` (Never: "The Qodo/PR-Agent adapter (Phase 3)"),
 * same untrusted-shape treatment every other guard in this file applies to
 * values crossing this `parentPort` boundary from main.
 */
function isRunIngestionRequest(data: unknown): data is GraphServiceRunIngestionRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, bot } = data as { type?: unknown; bot?: unknown };
  return type === 'graphService:runIngestion' && bot === 'codeRabbit';
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
 * Story 1.8 Phase 2: `detectStaleness` is likewise kicked off in the
 * background right after, against this same `normalizedNodes` set — this
 * app has no separate incremental-refresh mechanism, so every
 * `graphService:getCodeMap` fetch (today's only "index refresh") is when
 * staleness gets (re-)checked. Fire-and-forget for the same reason
 * `generateSummaries` is; writes only the independent `stale` field
 * (`node-record-store.ts`'s `NodeRecord.stale`), never touching `summary`.
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
    // Story 2.1 (Phase 1): attach FR7's deterministic risk signals, computed
    // live on every fetch — never persisted to `node-record-store.ts`
    // (Boundaries & Constraints; unlike `summary` there's no expensive state
    // here to protect from re-index). Adjacency for blast radius is built
    // once here (review round, patch) and reused across every Node's BFS —
    // `computeBlastRadius` used to be called per-Node, rebuilding it from
    // scratch every time (O(N·(V+E)) instead of O(V+E)).
    const blastRadiusAdjacency = buildBidirectionalAdjacency(normalizedNodes, edges);
    // Story 2.1 (Phase 2): loaded once per fetch (not per-Node) — a
    // wholly independent data source from the backend-query-derived
    // signals above (Intent), read fresh every fetch for the same
    // never-persisted, always-recomputed reasoning as the rest of
    // `riskSignals` (FR7 reproducibility). `undefined` when
    // `coverage/lcov.info` doesn't exist or doesn't parse — never thrown,
    // so it can never fail this fetch (Boundaries & Constraints).
    const coverage = await loadLcovCoverage(projectRoot);
    // Built off `normalizedNodes` (not `annotatedNodes`, whose declared
    // return type is plain `CodeMapNode[]` and has therefore lost the raw
    // complexity/cognitive/hotspot fields `annotateNodesWithSummaryState`'s
    // `{...node, ...}` spread carries through at runtime but not in its
    // static type) — both `.map()` calls preserve order/length 1:1 off the
    // same `nodes`, so a parallel index lookup here is safe and avoids
    // building an id-keyed Map for no reason.
    const nodesWithRiskSignals: CodeMapNode[] = annotatedNodes.map((node, i) => {
      // Review round (patch): `node` is runtime-shaped
      // `CodeMapNodeWithSignalSources` (the spread above preserves the raw
      // complexity/cognitiveComplexity/hotspotChangeCount fields even though
      // `annotateNodesWithSummaryState`'s declared return type doesn't carry
      // them) — destructured out explicitly so they never leak onto the wire
      // `CodeMapNode` alongside the `riskSignals` array that now represents
      // them properly.
      const {
        complexity: _complexity,
        cognitiveComplexity: _cognitiveComplexity,
        hotspotChangeCount: _hotspotChangeCount,
        ...cleanNode
      } = node as CodeMapNodeWithSignalSources;
      return {
        ...cleanNode,
        riskSignals: buildRiskSignals(normalizedNodes[i]!, blastRadiusAdjacency, coverage),
      };
    });
    postCodeMapMessage({ type: 'graphService:codeMap', nodes: nodesWithRiskSignals, edges });
    // Review round (patch): passes `nodesWithRiskSignals`, not
    // `normalizedNodes` — `startSummaryGenerationForProject` caches its
    // argument into the module-level `activeCodeMapNodes` (its own doc
    // comment), which `regenerateNode`'s handler later reads and returns
    // as-is for any Node it doesn't regenerate fields on. Passing the
    // pre-signal `normalizedNodes` left `activeCodeMapNodes` — and therefore
    // every `regenerateNode` response — carrying `riskSignals: []` forever,
    // silently reverting a Node's real signals the moment its summary was
    // regenerated. `nodesWithRiskSignals` is a strict superset of
    // `normalizedNodes`'s fields (via `annotatedNodes`), so this is safe for
    // every existing consumer of `activeCodeMapNodes`.
    void startSummaryGenerationForProject(nodesWithRiskSignals);
    // Story 2.2 Phase 2: judgment generation kicked off the same
    // fire-and-forget way, alongside the summary/staleness kick-offs — never
    // delays this response (AD-8). Same `nodesWithRiskSignals` set (not
    // `normalizedNodes`) for the identical reasoning the comment above
    // documents for `startSummaryGenerationForProject`.
    void startJudgmentGenerationForProject(nodesWithRiskSignals);
    // Story 1.8 Phase 2: staleness detection runs on every Code Map fetch
    // (Design Notes — this app has no separate incremental-refresh
    // mechanism, so this *is* "the next index refresh"), fire-and-forget
    // exactly like `startSummaryGenerationForProject` above so it can never
    // delay this response.
    void startStalenessDetectionForProject(projectRoot, normalizedNodes);
  } catch (error) {
    postCodeMapMessage({
      type: 'graphService:codeMapError',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Story 2.1 (Phase 1): builds one Node's `riskSignals` array (FR7, AD-9
 * corrected). `complexity`/`cognitive-complexity`/`hotspot` are surfaced only
 * when the backend actually reported a value for this Node/File (Boundaries
 * & Constraints — "no complexity data for a Node... not an error", I/O
 * matrix) — each is simply omitted from the array rather than included with
 * a placeholder value. `blast-radius` is the one signal always present, even
 * at value `0` for an isolated Node with no edges at all (I/O matrix),
 * computed via `@driller/graph-contracts`'s cycle-safe
 * `computeBlastRadiusFromAdjacency` against a pre-built `adjacency` — the
 * Code Map's already-fetched edges, never a second graph fetch.
 *
 * `location` duplicates `node`'s own `{file, startLine, endLine}` on every
 * signal (Design Notes) — degenerate here, but required by the Consistency
 * Conventions table since later signal families may report a narrower
 * location than their owning Node's full range.
 *
 * Pushed in a fixed field order (complexity, cognitive-complexity, hotspot,
 * blast-radius) so `riskSignals` is byte-identical across repeated fetches
 * of unchanged repo state (FR7 reproducibility) — no wall-clock, random, or
 * non-deterministic ordering input anywhere in this function. (Live-verified
 * this review round: `query_graph`'s row order is stable across repeated
 * identical calls against an unchanged index, so this ordering claim holds
 * in practice, not just by construction.)
 *
 * `adjacency` is built once per `getCodeMap` fetch by the caller (review
 * round, patch — see `handleGetCodeMapRequest`) and passed in rather than
 * rebuilt per Node.
 *
 * Story 2.1 (Phase 2): `coverage` is likewise loaded once per fetch by the
 * caller and passed in rather than re-read per Node. A `'test-coverage-gap'`
 * signal (distinct from `SummaryStatus`'s unrelated `'coverage-gap'`) is
 * pushed only when `coverage !== undefined` (the LCOV file existed and
 * parsed) `&&` `hasCoverageGap` finds zero covered lines in this Node's
 * range — omitted entirely otherwise, same omission-means-absent convention
 * as the other optional signals above, never a placeholder/zero entry.
 *
 * Story 2.2 (Phase 2): reads `getNodeRecord(node.id)?.llmJudgment` — the
 * Node record store's persisted state, not anything recomputed live — and
 * pushes one `LlmJudgmentRiskSignal` when present (FR8). Unlike the four
 * deterministic signals above, this one is NOT recomputed/reproducible by
 * construction (Epic 2 Context: reproducibility is a deterministic-signal
 * requirement only) — it reflects whatever `generateJudgments` has
 * persisted so far, which can differ fetch-to-fetch while generation is
 * still catching up on a large project. Return type widens from
 * `DeterministicRiskSignal[]` to the full `RiskSignal[]` union to
 * accommodate it.
 */
function buildRiskSignals(
  node: CodeMapNodeWithSignalSources,
  adjacency: BidirectionalAdjacency,
  coverage: LcovCoverage | undefined,
): RiskSignal[] {
  const location = { file: node.file, startLine: node.startLine, endLine: node.endLine };
  const signals: RiskSignal[] = [];

  if (node.complexity !== undefined) {
    signals.push({ family: 'deterministic', type: 'complexity', value: node.complexity, location });
  }
  if (node.cognitiveComplexity !== undefined) {
    signals.push({
      family: 'deterministic',
      type: 'cognitive-complexity',
      value: node.cognitiveComplexity,
      location,
    });
  }
  if (node.hotspotChangeCount !== undefined) {
    signals.push({ family: 'deterministic', type: 'hotspot', value: node.hotspotChangeCount, location });
  }
  signals.push({
    family: 'deterministic',
    type: 'blast-radius',
    value: computeBlastRadiusFromAdjacency(adjacency, node.id),
    location,
  });
  if (coverage !== undefined && hasCoverageGap(coverage, node.file, node.startLine, node.endLine)) {
    signals.push({ family: 'deterministic', type: 'test-coverage-gap', value: 1, location });
  }

  const judgment = getNodeRecord(node.id)?.llmJudgment;
  if (judgment !== undefined) {
    signals.push({ family: 'llm-judgment', judgment: judgment.text, location });
  }

  return signals;
}

/**
 * Handles a `graphService:pathTrace` request (Story 1.9, Phase 1) — computes
 * a deterministic call-path trace from a query-resolved entry Node via
 * `@driller/graph-contracts`'s `traceCallPath`, and posts back exactly one
 * `graphService:pathTraceResult` message. Never throws — every failure path
 * (no successful index yet, or `fetchCodeMap` itself failing) is reported as
 * an explicit `{status: 'error', ...}` `PathTraceResult` so main's pending
 * request always settles, same "never a hung request" framing as
 * `handleGetCodeMapRequest`.
 *
 * Strictly read-only (Always: "never touches the Node record store,
 * `activeCodeMapNodes`, or generation/staleness state"): re-fetches
 * nodes+edges fresh via `fetchCodeMap(activeProject)` on every call —
 * mirroring `handleGetCodeMapRequest`'s own fetch — rather than reusing
 * `activeCodeMapNodes` (which exists only to support the summary-generation/
 * backend-switch paths) or writing anything to `node-record-store.ts`.
 *
 * Guarded on `activeProject` alone (not `activeProjectPath`, unlike
 * `handleGetCodeMapRequest`) — `traceCallPath` only needs `id`/`name` off
 * each Node and `source`/`target`/`kind` off each edge, never `file`, so
 * there's no need to normalize `file` via `toProjectRelativePosixPath` here
 * the way the Code Map response does for its own downstream consumers.
 */
async function handlePathTraceRequest(query: string, requestId: number): Promise<void> {
  if (activeProject === undefined) {
    postPathTraceResultMessage({
      type: 'graphService:pathTraceResult',
      requestId,
      result: { status: 'error', message: 'No project has finished indexing yet.' },
    });
    return;
  }
  try {
    const { nodes, edges } = await fetchCodeMap(activeProject);
    // Defense in depth: main already sends a trimmed query (its own
    // `ipcMain.handle` validation), but this process trusts nothing crossing
    // its own boundary (same stance `isPathTraceRequest`'s own doc comment
    // takes) — trimming again here means incidental whitespace can never
    // affect matching regardless of which boundary it slipped past.
    const result = traceCallPath(nodes, edges, query.trim());
    postPathTraceResultMessage({ type: 'graphService:pathTraceResult', requestId, result });
  } catch (error) {
    postPathTraceResultMessage({
      type: 'graphService:pathTraceResult',
      requestId,
      result: { status: 'error', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Handles a `graphService:regenerateNode` request (Story 1.8, Phase 4) —
 * this app's first id-keyed mutating IPC round-trip. Regenerates exactly one
 * Node's summary, reusing Story 1.5/1.6's existing `summarize`/
 * `captureSourceBaseline`/backend-selection logic as-is (Always: "no new
 * generation orchestration path") via `summary-generator.ts`'s
 * `regenerateNodeSummary` — deliberately bypassing `generateSummaries`'s
 * `'pending'`-only eligibility filter (a stale Node is already `'ready'`)
 * and the whole-project `activeGenerationRunId`/`activeSummaryGenerationId`
 * supersession gates, which belong to the whole-project batch path, not
 * this single-Node one.
 *
 * The whole body is wrapped in one try/catch (Spec Change Log Round 1,
 * mirroring `startSummaryGenerationForProject`'s own try/catch/finally) so
 * an unexpected throw anywhere in here — including inside
 * `regenerateNodeSummary` itself — still posts an explicit
 * `{status: 'error', ...}` reply rather than leaking main's pending
 * `pendingRegenerateResolvers` entry forever (a permanently-stuck
 * "Regenerating…" button with no recovery short of restarting the app).
 *
 * Re-checks `classifyNode(node, coverageGapFileSet).summaryStatus !==
 * 'coverage-gap'` before regenerating (Spec Change Log Round 1) — this
 * handler intentionally bypasses `generateSummaries`'s `'pending'`-only
 * filter, but must still respect Story 1.5 Phase 2's coverage-gap exclusion:
 * a coverage-gap Node must never get a persisted summary.
 *
 * Looks the Node up in `activeCodeMapNodes` (the most recently fetched Code
 * Map's Nodes, cached for the backend-switch re-kick path too) rather than
 * the Node record store — a record doesn't exist at all for a Node that has
 * never been summarized, so the record store alone can't distinguish "Node
 * not found" from "Node exists but has no summary yet."
 *
 * On success, builds the reply's `node` via the already-exported
 * `annotateNodesWithSummaryState([node], coverageGapFileSet)[0]` (KEEP, Spec
 * Change Log) so the renderer gets the exact same shape `getCodeMap`
 * produces — reading the Node record store fresh, which already reflects
 * `regenerateNodeSummary`'s just-completed in-memory merge-write (disk
 * persistence is debounced, but `node-record-store.ts`'s in-memory `records`
 * map is updated synchronously).
 */
async function handleRegenerateNodeRequest(nodeId: string): Promise<void> {
  let result: RegenerateNodeResult;
  try {
    result = await computeRegenerateNodeResult(nodeId);
  } catch (error) {
    result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  postRegenerateNodeResultMessage({ type: 'graphService:regenerateNodeResult', nodeId, result });
}

async function computeRegenerateNodeResult(nodeId: string): Promise<RegenerateNodeResult> {
  const nodes = activeCodeMapNodes;
  const projectRoot = activeProjectPath;
  if (!nodes || !projectRoot) {
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return { status: 'error', message: `Node "${nodeId}" was not found in the current Code Map.` };
  }
  if (classifyNode(node, coverageGapFileSet).summaryStatus === 'coverage-gap') {
    return {
      status: 'error',
      message: `Node "${nodeId}" is in the current index's coverage gap set and cannot be regenerated.`,
    };
  }

  const backendConfig = activeBackendConfig;
  let summarize: SummarizeFn;
  let modelName: string;
  if (backendConfig.activeBackend === 'cloud') {
    if (!backendConfig.cloudApiKey) {
      return {
        status: 'error',
        message: 'Cloud is selected but no API key is set — add one in Settings.',
      };
    }
    summarize = createCloudSummarizer(backendConfig.cloudApiKey);
    modelName = CLOUD_SUMMARY_MODEL;
  } else {
    if (modelAttempt) {
      try {
        await modelAttempt;
      } catch {
        // Already reported via `graphService:modelStatus` 'error' — nothing
        // more to do; there is no model to regenerate with this session.
        return { status: 'error', message: 'The local model failed to load — no summary backend is available.' };
      }
    }
    if (!localModelReady) {
      return { status: 'error', message: 'No summary backend is available yet — check Settings.' };
    }
    summarize = createLocalSummarizer(localModelReady);
    modelName = localModelReady.model;
  }

  // Review round 2: snapshot the project/generation identity this request
  // was validated against — the queue-priority fix on `regenerateNodeSummary`
  // still leaves a real wait window (behind one already-running job, or
  // briefly behind other regenerate calls), during which the open project
  // could switch (or be re-indexed) or this Node could newly enter the
  // coverage-gap set. `revalidate` re-checks both against the LIVE module
  // state at write time, not just this snapshot taken at request entry.
  const requestGenerationId = activeSummaryGenerationId;
  const requestProjectPath = projectRoot;
  const revalidate = (): RegenerateRevalidationResult => {
    if (activeSummaryGenerationId !== requestGenerationId || activeProjectPath !== requestProjectPath) {
      return {
        ok: false,
        message: 'The open project changed while this request was queued — regeneration was cancelled.',
      };
    }
    if (classifyNode(node, coverageGapFileSet).summaryStatus === 'coverage-gap') {
      return {
        ok: false,
        message: `Node "${nodeId}" entered the coverage gap set while this request was queued — regeneration was cancelled.`,
      };
    }
    return { ok: true };
  };

  const outcome = await regenerateNodeSummary(node, projectRoot, summarize, modelName, revalidate);
  if (outcome.status === 'error') {
    return { status: 'error', message: outcome.message };
  }
  const refreshedNode = annotateNodesWithSummaryState([node], coverageGapFileSet)[0];
  if (!refreshedNode) {
    // Unreachable in practice (`annotateNodesWithSummaryState` maps a
    // one-element array to a one-element array) — a defensive explicit
    // error rather than letting `undefined` reach the IPC boundary.
    return { status: 'error', message: 'Regenerated the summary but failed to build the updated Node.' };
  }
  return { status: 'ok', node: refreshedNode };
}

/**
 * Handles a `graphService:runIngestion` request (Story 2.3, Phase 2) — this
 * app's first external-CLI-shelling-out IPC round-trip. Runs exactly one
 * PR-bot's ingestion pass (this phase: CodeRabbit only) against the most
 * recently fetched Code Map's Nodes (`activeCodeMapNodes`, the same cached
 * set `computeRegenerateNodeResult` reads — never a fresh `fetchCodeMap`,
 * mirroring that handler's own reasoning) and posts back exactly one
 * `graphService:runIngestionResult` message. Never throws — every failure
 * path (no project indexed yet, or an unexpected error from
 * `runCodeRabbitIngestion` itself) is reported as an explicit
 * `{status: 'error', ...}` `PrBotIngestionResult`, mirroring
 * `handleRegenerateNodeRequest`'s own top-level try/catch so main's pending
 * `pendingIngestionResolvers` entry always settles.
 */
async function handleRunIngestionRequest(bot: 'codeRabbit'): Promise<void> {
  let result: PrBotIngestionResult;
  try {
    result = await computeIngestionResult();
  } catch (error) {
    result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  postRunIngestionResultMessage({ type: 'graphService:runIngestionResult', bot, result });
}

/**
 * Runs the CodeRabbit ingestion pass and persists the result (Story 2.3,
 * Phase 2), via `coderabbit-adapter.ts`'s `runCodeRabbitIngestion` (Never:
 * "The Qodo/PR-Agent adapter (Phase 3)" — no branch for any other bot
 * exists here; `bot` isn't threaded through as a parameter since this
 * phase's caller, `handleRunIngestionRequest`, already knows it's the only
 * value `isRunIngestionRequest` accepts).
 *
 * On a genuine `'ok'` ingestion, persists via the two-step clear-then-write
 * `mergeNodeRecord` pattern the Always constraint requires: every Node's
 * existing `ingestedFindings` entries for `CODERABBIT_SOURCE_TOOL` are
 * stripped first (across the WHOLE project, not just Nodes this pass found
 * findings for — this is what makes a finding that no longer reproduces
 * actually disappear, I/O matrix: "the stale finding is gone from
 * `NodeRecord.ingestedFindings` after this pass"), then the freshly-grouped
 * findings are appended back per Node. Any entries from a different
 * `sourceTool` (Qodo, once Phase 3 exists) are left untouched by either
 * step — the filter only ever removes `CODERABBIT_SOURCE_TOOL` entries, and
 * the write-back only ever appends onto whatever remains.
 */
async function computeIngestionResult(): Promise<PrBotIngestionResult> {
  const nodes = activeCodeMapNodes;
  const projectRoot = activeProjectPath;
  if (!nodes || !projectRoot) {
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  // Captured before the (possibly minutes-long) `cr` invocation below, for
  // the supersession check after it resolves — see that check's own comment
  // for why `activeSummaryGenerationId` and not a plain `activeProjectPath`
  // comparison is what's actually needed here.
  const generationId = activeSummaryGenerationId;

  const ingestion = await runCodeRabbitIngestion(projectRoot, nodes);
  if (ingestion.status !== 'ok') {
    // `'tool-not-found'` / `'no-base-ref-resolvable'` / `'error'` are
    // structurally identical between `CodeRabbitIngestionResult` and
    // `PrBotIngestionResult` — returned as-is, no reshaping needed.
    return ingestion;
  }

  // Review finding (Edge Case Hunter): `runCodeRabbitIngestion` can run for
  // minutes (a real `cr` invocation), during which the user can switch
  // projects or trigger a re-index — both reset `activeCodeMapNodes` and
  // swap `node-record-store.ts`'s module-level records for the (possibly
  // same) project. `getAllNodeRecords`/`mergeNodeRecord` below operate on
  // whatever project is CURRENTLY active, not `projectRoot` — without this
  // check, a stale ingestion pass would silently clear the current
  // project's own CodeRabbit findings (step 1) and write findings keyed by
  // the OLD Node ids into the current project's persisted record file
  // (step 2).
  //
  // A plain `activeProjectPath !== projectRoot` check would catch a switch
  // to a *different* project but not a re-index of the *same* one —
  // `handleIndexRequest` sets `activeProjectPath = projectPath` on every
  // successful index, including same-project re-indexes (see
  // `startStalenessDetectionForProject`'s own doc comment on this exact
  // bug class, which this reuses rather than re-deriving). `
  // activeSummaryGenerationId`, by contrast, is unconditionally bumped at
  // the top of every `handleIndexRequest` call — a different project OR a
  // re-index of the same one both bump it — so comparing against it catches
  // both supersession shapes. Abort rather than persist anything once
  // either has happened underneath this pass.
  if (activeSummaryGenerationId !== generationId || activeProjectPath !== projectRoot) {
    return {
      status: 'error',
      message: 'The project changed while the ingestion pass was running; discarding its results.',
    };
  }

  // Step 1: clear this sourceTool's prior findings across EVERY Node first
  // (Always) — including Nodes absent from `ingestion.findingsByNodeId`
  // entirely, since those are exactly the Nodes whose finding no longer
  // reproduces this pass.
  const sourceTool = CODERABBIT_SOURCE_TOOL;
  const allRecords = getAllNodeRecords();
  for (const [id, record] of Object.entries(allRecords)) {
    const existing = record.ingestedFindings;
    if (!existing || existing.length === 0) {
      continue;
    }
    const remaining = existing.filter((finding) => finding.sourceTool !== sourceTool);
    if (remaining.length === existing.length) {
      // Nothing from this sourceTool was present — no-op write avoided.
      continue;
    }
    try {
      mergeNodeRecord(id, { ingestedFindings: remaining });
    } catch (error) {
      console.error(
        `[graph-service] failed to clear prior ${sourceTool} findings for ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Step 2: write this pass's freshly-grouped findings back, appended onto
  // whatever remains (another sourceTool's untouched entries) after step 1.
  let findingCount = 0;
  for (const [nodeId, signals] of Object.entries(ingestion.findingsByNodeId)) {
    findingCount += signals.length;
    const remaining = getNodeRecord(nodeId)?.ingestedFindings ?? [];
    try {
      mergeNodeRecord(nodeId, { ingestedFindings: [...remaining, ...signals] });
    } catch (error) {
      console.error(
        `[graph-service] failed to persist ${sourceTool} findings for ${nodeId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { status: 'ok', findingCount };
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
 * Kicks off `generateJudgments` for the Nodes just posted in a
 * `graphService:codeMap` response (Story 2.2, Phase 2), relaying its batched
 * progress as `graphService:llmJudgmentProgress` posts. Fire-and-forget from
 * the caller's perspective (`handleGetCodeMapRequest` never awaits this) —
 * mirrors `startSummaryGenerationForProject` immediately above in every
 * structural respect: the same backend-resolution branches (cloud with no
 * key, or local with a failed/still-loading model attempt, both skip
 * generation outright — never a silent partial/mixed result), the same
 * `activeSummaryGenerationId`-keyed supersession checks, and the same
 * `activeJudgmentGenerationRunId` overlapping-call guard `activeGenerationRunId`
 * provides for summaries.
 *
 * Deliberately does NOT cache `nodes` into `activeCodeMapNodes` itself —
 * `startSummaryGenerationForProject` already does that from the same call
 * site (`handleGetCodeMapRequest`), and caching it twice would be redundant;
 * both are called with the identical `nodesWithRiskSignals` argument.
 *
 * No `onHardwareAdvisory` wiring (Never constraint — that reactive nudge is
 * summary-specific, Story 1.5 Phase 3) and no `detectStaleness` counterpart
 * (Never constraint — no staleness tracking for judgments this phase).
 */
async function startJudgmentGenerationForProject(nodes: CodeMapNode[]): Promise<void> {
  const generationId = activeSummaryGenerationId;
  const projectRoot = activeProjectPath;
  const gapFiles = coverageGapFileSet;
  const backendConfig = activeBackendConfig;

  if (activeJudgmentGenerationRunId === generationId) {
    // Already generating judgments for this exact index generation — see
    // `activeJudgmentGenerationRunId`'s doc comment. Not an error/superseded
    // case, just a redundant second trigger that must not start a second run.
    return;
  }
  activeJudgmentGenerationRunId = generationId;

  try {
    let judge: SummarizeFn;
    let modelName: string;

    if (backendConfig.activeBackend === 'cloud') {
      if (!backendConfig.cloudApiKey) {
        // Blocked, not a silent local fallback — mirrors
        // `startSummaryGenerationForProject`'s own reasoning (this story's
        // Boundaries & Constraints: "a cloud backend with no key blocks
        // judgment generation silently, mirroring summary generation's own
        // established behavior").
        return;
      }
      judge = createCloudJudge(backendConfig.cloudApiKey);
      // Review round (patch): was `CLOUD_SUMMARY_MODEL` — the wrong constant
      // (harmless today, since both name the same model, but `judgment-
      // generator.ts` has its own `CLOUD_JUDGMENT_MODEL` for exactly this
      // purpose; using the summary one risked silently misreporting
      // provenance if the two ever diverge).
      modelName = CLOUD_JUDGMENT_MODEL;
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
      judge = createLocalJudge(localModelReady);
      modelName = localModelReady.model;
    }

    if (generationId !== activeSummaryGenerationId || !projectRoot) {
      return;
    }

    await generateJudgments({
      projectRoot,
      nodes,
      coverageGapFiles: gapFiles,
      judge,
      modelName,
      onProgress: (updated) => {
        if (generationId === activeSummaryGenerationId) {
          // `path` lets the renderer filter stale progress by the currently-
          // open project — same reasoning as `startSummaryGenerationForProject`'s
          // own `postSummaryProgress` call.
          postLlmJudgmentProgress({ type: 'graphService:llmJudgmentProgress', path: projectRoot, updated });
        }
      },
      isSuperseded: () => generationId !== activeSummaryGenerationId,
    });
  } catch (error) {
    console.error(
      `[graph-service] judgment generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // Only clears this run's own slot — same reasoning as
    // `startSummaryGenerationForProject`'s own `finally`.
    if (activeJudgmentGenerationRunId === generationId) {
      activeJudgmentGenerationRunId = null;
    }
  }
}

/**
 * Kicks off `detectStaleness` for the Nodes just posted in a
 * `graphService:codeMap` response (Story 1.8, Phase 2), fire-and-forget from
 * the caller's perspective (`handleGetCodeMapRequest` never awaits this) —
 * mirrors `startSummaryGenerationForProject` immediately above in every
 * structural respect, including its two supersession guards, since
 * `detectStaleness` needs exactly the same protection `generateSummaries`
 * does:
 *
 *  - `isSuperseded` (passed to `detectStaleness` itself) is keyed off
 *    `activeSummaryGenerationId`, the SAME id `startSummaryGenerationForProject`
 *    uses (review finding, High) — not `activeProjectPath`. A naive
 *    `activeProjectPath !== projectRoot` check only catches a switch to a
 *    *different* project: `handleIndexRequest` sets `activeProjectPath =
 *    projectPath` on every successful index, including a re-index of the
 *    *same* already-active project, so that check alone never goes true
 *    across a same-project re-index — a `detectStaleness` pass started
 *    before that re-index would keep running/writing throughout it.
 *    `activeSummaryGenerationId`, by contrast, is unconditionally bumped at
 *    the top of every `handleIndexRequest` call (a different project OR a
 *    re-index of the same one both bump it), so comparing against it catches
 *    both supersession shapes, exactly like `generateSummaries`'s own
 *    `isSuperseded` already does.
 *  - `activeStalenessRunId` (review finding, Medium — see that variable's own
 *    doc comment) guards against two overlapping passes for the same,
 *    unchanged generation — e.g. two renderer refetches with no intervening
 *    re-index — which would otherwise both pass `isSuperseded()` and run a
 *    full, redundant stat/hash sweep concurrently. Set synchronously before
 *    this function's first `await`, same single-threaded guarantee
 *    `activeGenerationRunId` relies on.
 *
 * `generationId` snapshots `activeSummaryGenerationId` at the moment this run
 * starts, same as `startSummaryGenerationForProject`'s own `generationId`.
 */
async function startStalenessDetectionForProject(
  projectRoot: string,
  nodes: CodeMapNode[],
): Promise<void> {
  const generationId = activeSummaryGenerationId;

  if (activeStalenessRunId === generationId) {
    // Already detecting staleness for this exact index generation — not an
    // error/superseded case, just a redundant second trigger that must not
    // start a second, wastefully-duplicate pass.
    return;
  }
  activeStalenessRunId = generationId;

  try {
    await detectStaleness(projectRoot, nodes, () => generationId !== activeSummaryGenerationId);
  } catch (error) {
    console.error(
      `[graph-service] staleness detection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // Only clears this run's own slot — same reasoning as
    // `startSummaryGenerationForProject`'s own `finally`: a later, genuinely
    // new pass (a different `generationId`, already holding its own value
    // here by the time this runs) must never have its slot clobbered by an
    // earlier, now-finishing pass's cleanup.
    if (activeStalenessRunId === generationId) {
      activeStalenessRunId = null;
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
      // Story 1.8 Phase 2 review finding, Medium: `stale` is cleared
      // alongside `summary`, never left behind — `stale` means nothing
      // without the baseline that lived inside the now-cleared `summary`
      // (its own doc comment: "undefined means not evaluated — no baseline
      // recorded, or no summary at all"), so leaving a stray `stale: true`
      // here would report staleness for a Node that no longer has a summary
      // to be stale/fresh relative to at all.
      mergeNodeRecord(id, { summary: undefined, stale: undefined });
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
  if (!isShuttingDown && isPathTraceRequest(event.data)) {
    // Fire-and-forget from the message handler's perspective, same as every
    // other branch here — `handlePathTraceRequest` posts its own
    // `graphService:pathTraceResult` reply asynchronously and never throws.
    void handlePathTraceRequest(event.data.query, event.data.requestId);
    return;
  }
  if (!isShuttingDown && isRegenerateNodeRequest(event.data)) {
    // Fire-and-forget from the message handler's perspective, same as every
    // other branch here — `handleRegenerateNodeRequest` posts its own
    // `graphService:regenerateNodeResult` reply asynchronously and never
    // throws (its own top-level try/catch guarantees that).
    void handleRegenerateNodeRequest(event.data.nodeId);
    return;
  }
  if (!isShuttingDown && isRunIngestionRequest(event.data)) {
    // Fire-and-forget from the message handler's perspective, same as every
    // other branch here — `handleRunIngestionRequest` posts its own
    // `graphService:runIngestionResult` reply asynchronously and never
    // throws (its own top-level try/catch guarantees that).
    void handleRunIngestionRequest(event.data.bot);
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
