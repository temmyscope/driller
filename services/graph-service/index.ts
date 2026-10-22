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
 *    `ensureLocalModel`) is kicked off alongside `indexRepository` under
 *    Local (P5-c: under Cloud, only when a local consumer first needs it),
 *    not sequentially after it (the pre-mortem finding driving the Intent's
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
  computeBlastRadiusHopDistances,
  FOLDED_TYPE_IPC_MAX_USED_BY,
  listEntryCandidates,
  traceCallPath,
  type BlastRadiusExpansionResult,
  type EntryCandidatesResult,
  type CoverageSummaryResult,
  type DiffScopeResult,
  type FoldedModule,
  type FoldedType,
  type IndexCoverageSummary,
  type PathTraceResult,
  type UnknownSectionResult,
} from '@driller/graph-contracts';
import type {
  CloudBackend,
  CodeMapEdge,
  CodeMapNode,
  GraphServiceBackendSwitchedRequest,
  GraphServiceCheckHeadRequest,
  GraphServiceCodeMapMessage,
  GraphServiceComputeDiffScopeRequest,
  GraphServiceComputeDiffScopeResultMessage,
  GraphServiceDiffScopeCarryRequest,
  GraphServiceDiffScopeCarryResultMessage,
  DiffScopeCarryResult,
  GraphServiceExpandBlastRadiusRequest,
  GraphServiceExpandBlastRadiusResultMessage,
  GraphServiceGetCodeMapRequest,
  GraphServiceHeadChangedMessage,
  GraphServiceIndexRequest,
  GraphServiceListEntryCandidatesRequest,
  GraphServiceListEntryCandidatesResultMessage,
  GraphServicePathTraceRequest,
  GraphServicePathTraceResultMessage,
  GraphServiceRegenerateNodeRequest,
  GraphServiceRegenerateNodeResultMessage,
  GraphServiceRetryModelRequest,
  GraphServiceRunIngestionRequest,
  GraphServiceSetEntryPinsRequest,
  GraphServiceEntryPinsMissingMessage,
  GraphServiceRunIngestionResultMessage,
  GraphServiceShutdownRequest,
  GraphServiceStatusMessage,
  HardwareAdvisoryMessage,
  HardwareAdvisoryReason,
  LlmJudgmentProgressMessage,
  McpServerStatusMessage,
  ModelStatusMessage,
  PrBotId,
  PrBotIngestionResult,
  RegenerateNodeResult,
  SummaryProgressMessage,
} from '@driller/ipc-contracts';
// Type-only import: pulls in Electron's ambient `process.parentPort`
// augmentation (real, present only when forked via `utilityProcess.fork`)
// without adding a runtime dependency on the `electron` package.
import type {} from 'electron';
import { backendSwitchKind, nextBackendConfig, type BackendConfigState } from './backend-switch';
import { CLOUD_SUMMARY_MODEL, createCloudSummarizer } from './cloud-summary-generator';
import { CODERABBIT_SOURCE_TOOL, runCodeRabbitIngestion } from './coderabbit-adapter';
import { computeDiffScope, decideDiffScopeCarry, readHeadCommit, resolveGitToplevel } from './git-diff-scope';
import { assessHeadDrift, autoReindexHeadAfterSuccess, headDriftErrorMessage, REINDEX_REQUEST_GRACE_MS } from './head-drift';
import { CLOUD_JUDGMENT_MODEL, createCloudJudge, createLocalJudge, generateJudgments } from './judgment-generator';
import { ensureLocalModel, type LocalModelReady } from './model-manager';
import { loadLcovCoverage } from './lcov';
import { indexRepository, stopCbmDaemon } from './mcp-client';
import { deriveLiveNode } from './live-node';
import {
  applyScopeChanged,
  isScopeChangedRequest,
  resolveIncludedPathsOnIndexSuccess,
  sameScope,
  type PendingScopeOverride,
} from './project-scope';
import { capFoldedTypeUsedBy } from './fold-types';
import { fetchProductionCodeMap } from './production-code-map';
import {
  attachCrossSectionCalls,
  buildScopedCodeMap,
  buildSectionCallGraph,
  countChangedInOtherSections,
  narrowDiffInputs,
  summarizeDiffChanges,
  type DiffMatchInputs,
  countCrossSectionEdges,
  countSectionNodes,
  filterCodeMapToScope,
  filterToSection,
  keepFileForScope,
  resolveSectionFilter,
  type ActiveRawCodeMap,
  type RawCodeMap,
} from './scoped-code-map';
import { toProjectRelativePosixPath } from './project-path';
import { isTestPath } from './test-code';
import { startMcpServer, type SectionCodeMapLookup } from './mcp-server';
import { QODO_SOURCE_TOOL, runQodoIngestion } from './qodo-adapter';
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
// Bug fix (2026-09-23): `activeIndexPath` alone means "the last project an
// index was *requested* for," not "an index is *currently running* for
// this project" — it's set once at the top of `handleIndexRequest` and,
// deliberately, never reset (both the success and failure branches leave it
// as-is, so a later `getCodeMap`/coverage-check racing a *different*
// project's index still knows what the last *requested* path was). The
// `graphService:index` message-handler guard below used to compare only
// against `activeIndexPath`, which meant a Retry click after a FAILED index
// attempt for the same project was silently ignored forever — the guard's
// own comment says "already indexing," but nothing was actually indexing
// anymore, the flag just never got cleared on failure. This flag is the
// missing "genuinely still running" half of that check, set alongside
// `activeIndexPath` and reset unconditionally (success or failure) in
// `handleIndexRequest`'s own `finally` — the same shape this file already
// uses for `activeDiffScopeComputationInFlight`/
// `activeBlastRadiusExpansionInFlight`.
let activeIndexInFlight = false;
let isShuttingDown = false;

// P5-a (founder decision 6.1): the commit HEAD pointed at when the index now
// served (`activeProjectPath`'s) STARTED — read before `indexRepository`, and
// committed only on that index's success branch, with `activeProjectPath`.
// A checkout during indexing is therefore caught by the next check.
// `undefined` when there was no HEAD to read (not a repository, unborn HEAD,
// git missing or timed out): never compared, so never a re-index.
let indexedHead: string | undefined;
// P5-a: the current HEAD an automatic re-index was already requested for
// (`graphService:headChanged`) — at most one per distinct HEAD, so a re-index
// that fails is never retried automatically. See `autoReindexHeadAfterSuccess`.
let autoReindexHead: string | undefined;
// P5-a: at most one focus-time `graphService:checkHead` in flight.
let headCheckInFlight = false;
// P5-a review round 1: when the last `headChanged` was posted (cleared when
// any index starts), so a diff in the moment before main's index request
// arrives still says "Re-indexing now" (`REINDEX_REQUEST_GRACE_MS`).
let reindexRequestedAt: number | undefined;
let reindexRequestGraceMs = REINDEX_REQUEST_GRACE_MS;

/** Tests only: shortens (or, with `undefined`, restores) the grace after a `headChanged` post. */
export function setReindexRequestGraceMsForTests(ms: number | undefined): void {
  reindexRequestGraceMs = ms ?? REINDEX_REQUEST_GRACE_MS;
}

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

// This project's indexing-scope allowlist (Bug fix, 2026-09-23; see
// `ProjectScopeConfig`'s own doc comment in ipc-contracts) — set alongside
// `activeProjectPath`, same never-cleared-on-failure reasoning. Empty means
// no restriction. Applied by `filterCodeMapToScope` at every `fetchCodeMap`
// call site (both `handleGetCodeMapRequest` and the staleness-detection
// fetch), never inside `mcp-client.ts` itself — CBM's `index_repository`
// has no subfolder scope parameter of its own to push this into (see
// `GraphServiceIndexRequest.includedPaths`'s doc comment in ipc-contracts),
// so this is a query-time filter over the already-fetched, already-full
// Node/edge set.
let activeIncludedPaths: readonly string[] = [];

// P2-1: a scope saved (`graphService:scopeChanged`) for the most recently
// requested index's project. `handleIndexRequest`'s success branch adopts it
// instead of the scope its own request carried, so a save made mid-index
// isn't overwritten when that index finishes. Cleared when a new index
// starts, on success once adopted, and on failure. See project-scope.ts.
let pendingScopeOverride: PendingScopeOverride | undefined;

// The current index's coverage-gap files (FR5), as POSIX-relative paths
// matching `CodeMapNode.file`'s own format — the backend's `index_status`
// reports `GapFile.path` as an absolute path (see its doc comment in
// `@driller/graph-contracts`), so `handleIndexRequest`'s success branch below converts
// each one via `toProjectRelativePosixPath` before storing it here. Set
// alongside `activeProject`/`activeProjectPath`, same never-cleared-on-
// failure reasoning.
let coverageGapFileSet: ReadonlySet<string> = new Set();

// The current index's full coverage summary (Story 5.1, Phase 2) — unlike
// `coverageGapFileSet` above (which retains only the derived POSIX-relative
// gap paths), this caches the whole `IndexCoverageSummary` object
// (`expectedNodes`/`expectedEdges`/`skippedCount`/`parsePartialCount`/
// `gapPaths`) exactly as `indexRepository` returned it, so a later on-demand
// `get_coverage_summary` MCP query can return it in full rather than just the
// gap-path projection the renderer's own coverage badges need. Same lifecycle
// as `activeCodeMapEdges` (Code Map): reset to `undefined` at the same point
// `activeCodeMapEdges` itself resets, at the very start of every new index
// attempt in `handleIndexRequest` (so a re-index in flight never serves a
// stale coverage summary from the project's previous index), then set in
// that same function's success branch alongside `coverageGapFileSet`'s own
// derivation from `coverage` — left `undefined` on a superseded/failed
// attempt, same as `coverageGapFileSet` itself.
let activeCoverageSummary: IndexCoverageSummary | undefined;

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

// P5-b review round 1 (tests only, via `peekGenerationRunsForTests`): the
// `activeSummaryGenerationId` the latest judgment and staleness runs started
// under (after their redundant-trigger checks).
const lastStartedGenerationRuns: { judgment: number | undefined; staleness: number | undefined } = {
  judgment: undefined,
  staleness: undefined,
};

/**
 * Tests only: the current summary generation id and the generation the
 * latest judgment and staleness runs started under — a run whose generation
 * is behind the current one was superseded and is not running.
 */
export function peekGenerationRunsForTests(): { generation: number; judgment: number | undefined; staleness: number | undefined } {
  return { generation: activeSummaryGenerationId, ...lastStartedGenerationRuns };
}

/** Tests only (P5-b founder decision 1): whether a summary / judgment run is in flight. */
export function peekActiveGenerationRunsForTests(): { summary: boolean; judgment: boolean } {
  return { summary: activeGenerationRunId !== null, judgment: activeJudgmentGenerationRunId !== null };
}

// Story 2.3 (Phase 3, review finding — Edge Case Hunter, major): which
// PR-bots currently have an ingestion pass actually running in THIS process.
// main's own `pendingIngestionResolvers` guard (apps/desktop/main/index.ts)
// is cleared by its own timeout, which can fire well before a real, slow
// `runCodeRabbitIngestion`/`runQodoIngestion` call actually finishes (the
// margin between `INGESTION_REQUEST_TIMEOUT_MS` and this module's own
// `SUBPROCESS_TIMEOUT_MS`+`SIGKILL_GRACE_MS` is only ~5s) — once that
// happens, a user retry for the SAME bot is accepted by main and reaches
// `handleRunIngestionRequest` again while the first pass is still mid-flight
// (this handler is invoked fire-and-forget; nothing here previously stopped
// it running to completion in the background). Two concurrent passes for
// the same bot would both read/write the same `review.md` (Qodo) or race
// each other's clear-then-write persistence — this guard, independent of
// main's own Map and never cleared by any timeout, refuses a second
// concurrent request for a bot that's already running here, closing that
// window at its actual source rather than trying to fix it in main.
const activeIngestionBots = new Set<PrBotId>();

// Story 3.1 (Phase 1): whether a `graphService:computeDiffScope` request is
// currently running in THIS process — a plain boolean, not a `Set` like
// `activeIngestionBots`, since there's no per-key dimension here analogous
// to `PrBotId` (only one diff-scope computation is ever meaningful at a
// time, against this process's single `activeProjectPath`). Mirrors
// `activeIngestionBots`'s own reasoning: refuses a second concurrent request
// outright rather than letting two overlapping git subprocess sequences race
// each other.
let activeDiffScopeComputationInFlight = false;

// Story 3.2 (Phase 1): whether a `graphService:expandBlastRadius` request is
// currently running in THIS process — mirrors
// `activeDiffScopeComputationInFlight`'s exact reasoning (a plain boolean,
// not a `Set`: only one blast-radius expansion is ever meaningful at a time,
// against this process's single `activeProjectPath`). Refuses a second
// concurrent request outright rather than letting two overlapping
// computations race each other.
let activeBlastRadiusExpansionInFlight = false;

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
let activeBackendConfig: BackendConfigState = {
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

// Story 3.2 (Phase 1): the most recently fetched Code Map's Edges, cached
// alongside `activeCodeMapNodes` — same lifecycle (Design Notes), reset to
// `undefined` alongside `activeCodeMapNodes` in `handleIndexRequest`.
// Genuinely new cached state: before this, `edges` lived only inside
// `handleGetCodeMapRequest`'s own local scope and was discarded once the
// `graphService:codeMap` message posted — `buildBidirectionalAdjacency`
// (used per-fetch there) needs both `nodes` and `edges`, but only `nodes`
// was ever cached for a later on-demand call
// (`computeBlastRadiusExpansionResult`) to reuse.
//
// Set exclusively inside `startSummaryGenerationForProject`, in the same
// synchronous statement as `activeCodeMapNodes` (review finding, High —
// see that function's own doc comment) — never assigned at its caller's own
// call site, which is what let a real `await` gap between the two
// assignments open a window where they briefly disagreed about which fetch
// they reflected.
let activeCodeMapEdges: CodeMapEdge[] | undefined;

// P4-2 phase 3a: the most recently fetched Code Map's folded Module Nodes
// (`fold-modules.ts`), scope-filtered like its Nodes. Same lifecycle as
// `activeCodeMapNodes`/`activeCodeMapEdges`: reset alongside them in
// `handleIndexRequest`, and set in the same synchronous statement as them
// inside `startSummaryGenerationForProject`. Read by `lookup_node` (a Module
// id resolves as folded) and by diff scope (a top-level-only change).
let activeFoldedModules: FoldedModule[] | undefined;

// P4-2 phase 3b: the most recently fetched Code Map's folded Type/Interface
// Nodes (`fold-types.ts`), scope-filtered like its Nodes. Same lifecycle as
// `activeFoldedModules`. Read by `lookup_node` (a type id resolves as folded).
let activeFoldedTypes: FoldedType[] | undefined;

// P4-4 phase 1a: the raw fetch the current map was built from — the
// `fetchProductionCodeMap` result, its LCOV report, the index's coverage-gap
// files — and the indexing scope it was built with. Later P4-4 phases build
// a section's map from it (`buildScopedCodeMap`) instead of re-fetching.
// Same lifecycle as `activeCodeMapNodes`/`activeCodeMapEdges`, so it always
// describes the map they hold:
//  - set in the same synchronous statement as them, inside
//    `startSummaryGenerationForProject` (a backend switch or model retry
//    re-caches the same value, unchanged);
//  - replaced by every Code Map fetch (`handleGetCodeMapRequest`), which is
//    also when a new LCOV report or a saved scope change is picked up.
//    P5-b: a request it can serve (current, fetched outside an index, built
//    under the live scope — `resolveRawForRequest`) is no fetch: it is
//    answered from this cache and leaves it, and everything keyed on it, as is;
//  - cleared with them when any index starts (`handleIndexRequest`) — a
//    re-index of this project or a switch to another one.
// A `scopeChanged` alone does not clear it: like the Nodes, it keeps
// describing the last map until the next fetch (its `appliedScope` says
// which scope that was).
// Review round 1: stamped with the project root and the index generation its
// fetch started under. A fetch that was still in flight when an index
// started (a re-index, or a switch to another project) is never cached here,
// and `getActiveRawCodeMap` returns `null` for any stamp that is not the
// active project's current generation. (The Nodes/edges caches keep their
// pre-existing behaviour: such a fetch still lands in them.)
let activeRawCodeMap: ActiveRawCodeMap | undefined;

// Review round 1 (P4-4 phase 1a): bumped when any index starts
// (`handleIndexRequest`), the moment every cached map becomes the previous
// generation's. Stamps `activeRawCodeMap`.
let indexGeneration = 0;

/** Whether `rawCodeMap` came from a fetch for the active project in the current index generation. */
function isCurrentRawCodeMap(rawCodeMap: ActiveRawCodeMap): boolean {
  return rawCodeMap.indexGeneration === indexGeneration && rawCodeMap.raw.projectRoot === activeProjectPath;
}

/**
 * P4-4 phase 1a: the raw fetch behind the current map (see
 * `activeRawCodeMap`), or `null` when there is none for the active project's
 * current index generation. Read-only: the object and its `raw` and
 * `appliedScope` are frozen (shallowly — the fetched Nodes, folded Modules
 * and folded types inside are the same objects the live caches and replies
 * share, so never mutate them). For tests and later P4-4 phases.
 */
export function getActiveRawCodeMap(): Readonly<ActiveRawCodeMap> | null {
  return activeRawCodeMap !== undefined && isCurrentRawCodeMap(activeRawCodeMap) ? activeRawCodeMap : null;
}

/**
 * Tests only: the stored `activeRawCodeMap` without `getActiveRawCodeMap`'s
 * stamp check, so a test can see that it is cleared (and never set to a stale
 * fetch) rather than only that the reader hides it.
 */
export function peekActiveRawCodeMapForTests(): Readonly<ActiveRawCodeMap> | undefined {
  return activeRawCodeMap;
}

/** Tests only: the cached whole-scope edges diff scope and Blast Radius expansion read. */
export function peekActiveCodeMapEdgesForTests(): readonly CodeMapEdge[] | undefined {
  return activeCodeMapEdges;
}

/**
 * P4-4e review round 1: what diff scope and Blast Radius expansion get when
 * the requested section is in the live allowlist but not in the scope the
 * cached map was built under (the allowlist changed and the refetch has not
 * landed yet), or no current raw cache stamps the cached map at all.
 */
export const MAP_REFRESHING_RESULT = {
  status: 'error',
  message: 'The map is refreshing for the new scope — try again.',
} as const;

/**
 * P4-4e review round 1: a section's file set over the whole-scope CACHES
 * (diff scope, Blast Radius expansion). Two allowlists are involved:
 *  - whether the section exists is decided by the live `activeIncludedPaths`
 *    (`unknown-section` otherwise — the renderer then falls back to `all`);
 *  - which files it owns (`sectionOfFile`, nearest entry) is decided by the
 *    scope the caches were built under — the stamp-checked
 *    `activeRawCodeMap.appliedScope`, set in the same tick as the cached
 *    Nodes and edges — so the result always matches the map on screen.
 * When the two disagree about the section (it is live but the caches were
 * built without it), or no current raw cache exists, the result is the
 * explicit `MAP_REFRESHING_RESULT`, never a silently different file set.
 * (Not `unknown-section`: the section is real, so falling back to `all`
 * would be wrong.) Path Trace and the Code Map fetch filter a fresh fetch
 * with the live allowlist instead, so they don't need this.
 */
function resolveCachedSectionFilter(
  section: string,
): ReturnType<typeof resolveSectionFilter> | typeof MAP_REFRESHING_RESULT {
  const live = resolveSectionFilter(section, activeIncludedPaths);
  if (typeof live !== 'function') {
    return live;
  }
  const cached = getActiveRawCodeMap();
  if (cached === null || !cached.appliedScope.includes(section)) {
    return MAP_REFRESHING_RESULT;
  }
  return resolveSectionFilter(section, cached.appliedScope);
}

/**
 * P4-4 phase 2b: the memo behind `getSectionCodeMap` — one section build per
 * section, valid only for the raw cache it was built from (`source`, by
 * identity). Dropped in the same tick `activeRawCodeMap` is replaced or
 * cleared (`handleIndexRequest`, `startSummaryGenerationForProject`); the
 * identity check in `getSectionCodeMap` is defense in depth on top of that.
 * Only `lookup_node` WITH a `section` ever reads or fills it.
 */
let sectionCodeMapMemo: { source: ActiveRawCodeMap; builds: Map<string, SectionCodeMapLookup> } | undefined;

/**
 * P4-4 phase 2b: the section build `lookup_node` answers a `section` lookup
 * from — `buildScopedCodeMap(activeRawCodeMap.raw, sectionPredicate)`, the
 * same build `handleGetCodeMapRequest` sends the renderer for that section,
 * so its Nodes, folded Modules / types and every severity cut are the
 * section's own (never the whole-scope cache filtered afterwards).
 *
 * The section is resolved with the P4-4e machinery
 * (`resolveCachedSectionFilter`): existence against the live allowlist
 * (`unknown-section` otherwise), ownership against the scope the raw cache
 * was built under, and the explicit `MAP_REFRESHING_RESULT` when the two
 * disagree or no current raw cache exists. Memoized per section and raw-cache
 * identity (`sectionCodeMapMemo`). `appliedScope` is the raw cache's, so the
 * caller can name the section that owns an id found only in the whole scope.
 */
export function getSectionCodeMap(
  section: string,
): SectionCodeMapLookup | UnknownSectionResult | { status: 'error'; message: string } {
  if (activeCodeMapNodes === undefined) {
    // The same guard (and message) as the whole-scope `lookupNode`.
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  const keepFile = resolveCachedSectionFilter(section);
  if (typeof keepFile !== 'function') {
    return keepFile;
  }
  // Non-null: `resolveCachedSectionFilter` only returns a predicate when a
  // current raw cache exists.
  const source = getActiveRawCodeMap() as ActiveRawCodeMap;
  if (sectionCodeMapMemo === undefined || sectionCodeMapMemo.source !== source) {
    sectionCodeMapMemo = { source, builds: new Map() };
  }
  const memoized = sectionCodeMapMemo.builds.get(section);
  if (memoized !== undefined) {
    return memoized;
  }
  const { nodes, foldedModules, foldedTypes } = buildScopedCodeMap(source.raw, keepFile);
  // P4-4 phase 3a: each section Node's callees in other sections, from the
  // same raw cache's whole-scope Nodes and edges (the scope filter the
  // whole-scope build runs, before the section's own filter dropped them) —
  // so `lookup_node` with a `section` names them exactly as the renderer's
  // section map does.
  const wholeScope = filterCodeMapToScope(
    source.raw.projectRoot,
    source.raw.fetched.nodes,
    source.raw.fetched.edges,
    keepFileForScope(source.appliedScope),
  );
  const build: SectionCodeMapLookup = Object.freeze({
    status: 'section',
    nodes: attachCrossSectionCalls(
      source.raw.projectRoot,
      nodes,
      wholeScope.nodes,
      wholeScope.edges,
      section,
      source.appliedScope,
    ),
    foldedModules,
    foldedTypes,
    appliedScope: source.appliedScope,
  });
  sectionCodeMapMemo.builds.set(section, build);
  return build;
}

/** Tests only: the section-build memo, to see that it is dropped (not only bypassed) and never filled by a no-section call. */
export function peekSectionCodeMapMemoForTests(): ReadonlyMap<string, SectionCodeMapLookup> | undefined {
  return sectionCodeMapMemo?.builds;
}

/**
 * P4-7c: the whole-scope entry-candidate listing for the cached map
 * (`activeCodeMapNodes`/`activeCodeMapEdges`), computed at most once per map:
 *  - reset to `undefined` alongside them in `handleIndexRequest`;
 *  - reset in `startSummaryGenerationForProject` whenever it caches a
 *    different Nodes or edges array (every Code Map fetch). A re-kick that
 *    re-caches the same arrays (backend switch, model retry) keeps it.
 * Only `computeEntryCandidatesResult` fills it, lazily, on the first request
 * for that map — never on the fetch path.
 */
let activeEntryCandidates: EntryCandidatesResult | undefined;

/**
 * P4-7c (AD-13 "(f) per section"): the per-section listings, valid only for
 * the raw cache their section call graphs were built from (`source`, by
 * identity) — the `sectionCodeMapMemo` lifecycle exactly: dropped in the same
 * tick `activeRawCodeMap` is replaced or cleared, with the identity check in
 * `computeEntryCandidatesResult` as defense in depth.
 */
let entryCandidatesSectionMemo: { source: ActiveRawCodeMap; results: Map<string, EntryCandidatesResult> } | undefined;

/**
 * P4-7g (AD-5 "Entry pins", FR-15): the engineer's pins for one project, in
 * pin order — from the `graphService:index` request (`entryPins`), then from
 * each `graphService:setEntryPins` for that project. Read by
 * `computeEntryCandidatesResult` only when it is for the project listed, so
 * the IPC channel and the MCP tool rank the same pins first. A change drops
 * both entry-candidate memos (`handleSetEntryPinsRequest`).
 */
let activeEntryPins: { projectPath: string; pinnedIds: readonly string[] } | undefined;

/** Tests only: the pins the next listing ranks first. */
export function peekEntryPinsForTests(): { projectPath: string; pinnedIds: readonly string[] } | undefined {
  return activeEntryPins;
}

/**
 * P4-7g: applies a `graphService:setEntryPins` — only for the project being
 * indexed or last indexed (`activeIndexPath`; another project's pins are
 * ignored, never applied), and drops the whole-scope and per-section
 * entry-candidate memos, so the next listing (IPC or MCP) ranks the new pins
 * rather than a stale ranking.
 */
function handleSetEntryPinsRequest(projectPath: string, pinnedIds: readonly string[]): void {
  if (projectPath !== activeIndexPath) {
    return;
  }
  activeEntryPins = { projectPath, pinnedIds: [...pinnedIds] };
  activeEntryCandidates = undefined;
  entryCandidatesSectionMemo = undefined;
}

/**
 * P4-7g review round 1: posts `graphService:entryPinsMissing` with the pins
 * for `projectPath` that are not among `nodes` (the whole-scope map just
 * cached) — nothing when there are none. Main logs each once per session.
 */
function reportMissingEntryPins(projectPath: string, nodes: readonly CodeMapNode[]): void {
  if (activeEntryPins === undefined || activeEntryPins.projectPath !== projectPath || activeEntryPins.pinnedIds.length === 0) {
    return;
  }
  const onMap = new Set(nodes.map((node) => node.id));
  const missing = activeEntryPins.pinnedIds.filter((id) => !onMap.has(id));
  if (missing.length > 0) {
    const message: GraphServiceEntryPinsMissingMessage = { type: 'graphService:entryPinsMissing', projectPath, nodeIds: missing };
    process.parentPort?.postMessage(message);
  }
}

/**
 * P4-7g: the pins a section's listing passes on (AD-5 "Entry pins", founder
 * decision 2026-10-04 — proposed): a pin on a Node in another section of the
 * map is not shown in this one, and is not a missing pin either, so it is
 * left out; a pin in the section is ranked; a pin on no Node of the
 * whole-scope map at all stays in, so the listing reports it in
 * `hiddenPinIds` (logged once by main).
 */
function sectionEntryPins(
  pins: readonly string[],
  sectionNodes: readonly CodeMapNode[],
  wholeScopeNodes: readonly CodeMapNode[],
): string[] {
  if (pins.length === 0) {
    return [];
  }
  const inSection = new Set(sectionNodes.map((node) => node.id));
  const onMap = new Set(wholeScopeNodes.map((node) => node.id));
  return pins.filter((id) => inSection.has(id) || !onMap.has(id));
}

/**
 * Tests only: the ranking `computeEntryCandidatesResult` runs —
 * `listEntryCandidates` unless a test swaps it (to count calls, to throw, or
 * to start a re-index mid-compute). Never reassigned outside tests.
 */
let entryCandidatesLister: typeof listEntryCandidates = listEntryCandidates;

/** Tests only: swap the ranking (`undefined` restores `listEntryCandidates`). */
export function setEntryCandidatesListerForTests(lister: typeof listEntryCandidates | undefined): void {
  entryCandidatesLister = lister ?? listEntryCandidates;
}

/** Tests only: the two memos, to see that they are filled once and dropped (not only bypassed). */
export function peekEntryCandidatesMemoForTests(): {
  whole: EntryCandidatesResult | undefined;
  sections: ReadonlyMap<string, EntryCandidatesResult> | undefined;
} {
  return { whole: activeEntryCandidates, sections: entryCandidatesSectionMemo?.results };
}

/**
 * P4-7c (AD-13 (f), FR-15): the ranked candidate entry points of the active
 * project's map — the ONE compute path both the `entryCandidates:list` IPC
 * channel (through `handleListEntryCandidatesRequest`) and the
 * `list_entry_candidates` MCP tool call, so their answers cannot drift.
 *
 * Reads only cached state, never a fresh fetch:
 *  - without `section`, the cached whole-scope `activeCodeMapNodes`/
 *    `activeCodeMapEdges` — the scoped, test-free, folded map
 *    `computeBlastRadiusExpansionResult` reads;
 *  - with `section`, the section's own Nodes and edges, built from the raw
 *    cache (`buildSectionCallGraph`, the section Code Map build's own first
 *    steps, so `calledAtLoadBy` is re-scoped to the section) — never the
 *    whole-scope result filtered. The section is resolved with the P4-4e
 *    machinery (`resolveCachedSectionFilter`): `unknown-section` against the
 *    live allowlist, ownership by the raw cache's `appliedScope`, and
 *    `MAP_REFRESHING_RESULT` while the refetch hasn't landed.
 *
 * Off the interaction path: the listing is computed lazily, on the first
 * request for a given map (or map + section), and memoized
 * (`activeEntryCandidates`, `entryCandidatesSectionMemo`); a repeat call
 * does no walk. A Code Map fetch, a Blast Radius expansion or a Path Trace
 * never computes it. It is one synchronous pass (~ms on a real project,
 * ~0.1–0.55 s on the 50k-Node synthetic worst case, P4-7b), so the Graph
 * Service handles other requests before and after it, never during.
 *
 * P4-7g: the project's pins (`activeEntryPins`) are ranked first, in pin
 * order; with a section, only the pins in that section (or on no Node of
 * the map at all, which come back as `hiddenPinIds`) — `sectionEntryPins`.
 * A pin change drops both memos.
 *
 * Guards mirror `computeBlastRadiusExpansionResult` (same messages): no
 * indexed map, another project, and a generation change during the compute
 * (results discarded, never memoized). Never throws. Review round 1: and,
 * with or without a section, `MAP_REFRESHING_RESULT` while no current raw
 * cache stamps the cached map (a stale fetch landed after an index started).
 */
export function computeEntryCandidatesResult(projectPath: string, section?: string): EntryCandidatesResult {
  try {
    const nodes = activeCodeMapNodes;
    const edges = activeCodeMapEdges;
    const projectRoot = activeProjectPath;
    if (!nodes || !edges || !projectRoot) {
      return { status: 'error', message: 'No project has finished indexing yet.' };
    }
    if (projectRoot !== projectPath) {
      // Mirrors `computeBlastRadiusExpansionResult`'s own stale-project guard.
      return { status: 'error', message: 'The requested project is not the currently active project.' };
    }
    // P4-7c review round 1: the cached Nodes/edges must be stamped by a
    // current raw cache (this project, this index generation). A fetch that
    // was still in flight when an index started still lands in
    // `activeCodeMapNodes`/`activeCodeMapEdges` (never in the raw cache), so
    // without this check a switch to another project (or a re-index) could
    // list — and memoize — the previous map's candidates under the new
    // project. (Blast Radius expansion has the same inherited race; recorded
    // in deferred-work.md, not fixed here.)
    if (getActiveRawCodeMap() === null) {
      return MAP_REFRESHING_RESULT;
    }
    const generationId = activeSummaryGenerationId;
    // P4-7g: the pins for this project, ranked first (IPC and MCP alike).
    const pins = activeEntryPins !== undefined && activeEntryPins.projectPath === projectRoot ? activeEntryPins.pinnedIds : [];

    let result: EntryCandidatesResult;
    let memoize: (computed: EntryCandidatesResult) => void;
    if (section === undefined) {
      if (activeEntryCandidates !== undefined) {
        return activeEntryCandidates;
      }
      result = entryCandidatesLister(nodes, edges, { pinnedIds: pins });
      memoize = (computed) => {
        activeEntryCandidates = computed;
      };
    } else {
      const keepFile = resolveCachedSectionFilter(section);
      if (typeof keepFile !== 'function') {
        return keepFile;
      }
      // Non-null: `resolveCachedSectionFilter` only returns a predicate when
      // a current raw cache exists.
      const source = getActiveRawCodeMap() as ActiveRawCodeMap;
      if (entryCandidatesSectionMemo === undefined || entryCandidatesSectionMemo.source !== source) {
        entryCandidatesSectionMemo = { source, results: new Map() };
      }
      const memo = entryCandidatesSectionMemo;
      const memoized = memo.results.get(section);
      if (memoized !== undefined) {
        return memoized;
      }
      const graph = buildSectionCallGraph(source.raw, keepFile);
      result = entryCandidatesLister(graph.nodes, graph.edges, {
        pinnedIds: sectionEntryPins(pins, graph.nodes, nodes),
      });
      memoize = (computed) => {
        memo.results.set(section, computed);
      };
    }

    // The compute is synchronous today; kept for structural parity with
    // `computeBlastRadiusExpansionResult`, so a later async or chunked
    // listing can't silently answer for a superseded map.
    if (activeSummaryGenerationId !== generationId || activeProjectPath !== projectRoot) {
      return {
        status: 'error',
        message: 'The project changed while the entry candidates were being listed; discarding its results.',
      };
    }
    memoize(result);
    return result;
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

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

// Story 5.1 (Phase 1): starts the secured Agent-Facing Query Surface as soon
// as this subprocess is ready to accept connections — never gated on a
// project finishing indexing first (Always); a Node-lookup query made before
// that returns its own explicit `{status: 'error', ...}` (mcp-server.ts's
// `lookupNode`), never a hang. `() => activeCodeMapNodes` is a live getter,
// not a value captured once here — `activeCodeMapNodes` is still `undefined`
// at this point in module init and is only ever (re)assigned later, once a
// `graphService:index` request actually completes.
//
// `startMcpServer` can throw synchronously (a malformed tool registration,
// transport construction failure, etc.) — caught here (review round 1, Low)
// so a construction-time failure in the Agent-Facing Query Surface degrades
// to "this surface isn't available" rather than taking down the whole
// subprocess (and with it every other Graph Service capability). Its return
// value is stashed so `finishShutdown` can release the listener on a clean
// shutdown (review round 1, Medium).
let closeMcpServer: (() => Promise<void>) | undefined;
try {
  // P0-4: the found Node is live-derived at query time — summary/staleness
  // and record-backed signals re-read from the Node record store through the
  // same code the fetch path uses — so `lookup_node` never serves the
  // fetch-time snapshot `activeCodeMapNodes` holds (FR15 parity).
  closeMcpServer = startMcpServer(
    () => activeCodeMapNodes,
    postMcpServerStatus,
    (node) => deriveLiveNode(node, { getRecord: getNodeRecord, coverageGapFiles: coverageGapFileSet }),
    () => activeFoldedModules,
    () => activeFoldedTypes,
    // P4-4 phase 2b: `lookup_node` with a `section` (memoized section build).
    getSectionCodeMap,
  );
} catch (error) {
  console.error('[graph-service] failed to start the Agent-Facing Query Surface (mcp-server.ts):', error);
  // Review finding (Medium): a synchronous construction-time throw (a
  // malformed tool registration, transport construction failure) is itself
  // exactly the kind of "listener never came up" failure Story 5.2 exists to
  // make visible — logging alone here would leave it invisible to main/the
  // renderer, defeating the story's own purpose. `mcp-server.ts`'s own
  // `httpServer.on('error', ...)`/`listen(...)` callback posts never run in
  // this case (construction failed before either was reached), so this is
  // the only point that can post an explicit status for it.
  postMcpServerStatus({
    type: 'graphService:mcpServerStatus',
    state: 'unavailable',
    message: `driller's background service failed to start the Agent-Facing Query Surface: ${
      error instanceof Error ? error.message : String(error)
    }. Retry will restart it.`,
    at: new Date().toISOString(),
  });
}

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

/**
 * Posts a `graphService:computeDiffScopeResult` reply (Story 3.1, Phase 1) —
 * own `type`/channel, same disambiguation convention as
 * `postRunIngestionResultMessage`/`postPathTraceResultMessage`.
 */
function postComputeDiffScopeResultMessage(message: GraphServiceComputeDiffScopeResultMessage): void {
  process.parentPort?.postMessage(message);
}

/**
 * Posts a `graphService:expandBlastRadiusResult` reply (Story 3.2, Phase 1)
 * — own `type`/channel, same disambiguation convention as
 * `postComputeDiffScopeResultMessage`.
 */
function postExpandBlastRadiusResultMessage(message: GraphServiceExpandBlastRadiusResultMessage): void {
  process.parentPort?.postMessage(message);
}

/** P4-7c: posts a `graphService:listEntryCandidatesResult` reply — own `type`, same convention as `postExpandBlastRadiusResultMessage`. */
function postListEntryCandidatesResultMessage(message: GraphServiceListEntryCandidatesResultMessage): void {
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
 * Posts a `graphService:mcpServerStatus` message (Story 5.2) — own
 * `type`/channel, same disambiguation convention as `postHardwareAdvisory`/
 * `postModelStatus`. Passed into `startMcpServer` below as a callback (rather
 * than that module posting over `parentPort` directly) so `mcp-server.ts`
 * stays free of any direct `process.parentPort` dependency of its own, the
 * same separation `startMcpServer`'s `getActiveCodeMapNodes` getter parameter
 * already establishes for reading this module's state.
 */
function postMcpServerStatus(message: McpServerStatusMessage): void {
  process.parentPort?.postMessage(message);
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
function kickOffModelDownload(): Promise<void> {
  if (modelAttempt) {
    // Already attempted (in flight, or already succeeded) this process
    // lifetime.
    return modelAttempt;
  }
  const attempt = ensureLocalModel({
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
      // P5-c review round 1: every successful download under Local checks
      // the constrained-tier advisory for the open project — the index-time
      // check alone misses a Cloud→Local switch and a recovery after a
      // failure. Posted at most once per project session (its own flag).
      if (activeBackendConfig.activeBackend === 'local' && activeIndexPath !== null) {
        void checkConstrainedTierAdvisory(activeIndexPath);
      }
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
  modelAttempt = attempt;
  // P1-3: returned so `handleRetryModelRequest` can chain on exactly this
  // attempt. Always resolves (the `.catch` above swallows the failure after
  // posting it) — callers check `localModelReady` to tell ready from error.
  return attempt;
}

/**
 * P5-c review round 1 (no download storm): what the implicit generation
 * kicks wait on — the fetch path, the P5-b cache-served re-kick and the
 * backend re-kicks all run `startSummaryGenerationForProject` /
 * `startJudgmentGenerationForProject`. It joins an attempt in flight and
 * returns at once otherwise (model ready, or no attempt), so after a failed
 * download no section switch or reload starts another. A fresh attempt
 * starts only on an explicit trigger: an index under Local, a genuine
 * switch to Local (`handleBackendSwitchedRequest`), the model Retry, or a
 * user Regenerate (`computeRegenerateNodeResult`).
 */
async function joinModelAttempt(): Promise<void> {
  if (modelAttempt) {
    await modelAttempt;
  }
}

/**
 * Checks whether `projectPath`'s session should get the constrained-tier
 * hardware advisory (Story 1.5 Phase 3), once the model attempt this
 * subprocess is currently using has settled. P5-c: Local only. Called from
 * a Local `handleIndexRequest` (the memo may already be ready, so a second
 * project still gets checked), from every successful download under Local
 * (`kickOffModelDownload`'s success path — so a Cloud→Local switch and a
 * recovery after a failure get the nudge too, review round 1), and from a
 * successful model Retry. The rest of this comment is the original reason
 * the per-index call exists. Called once per
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
  if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== 'graphService:getCodeMap') {
    return false;
  }
  // P4-4 phase 1b: an optional string `section` (absent = the whole scope).
  const section = (data as { section?: unknown }).section;
  // P5-b founder decision 2: an optional boolean `force`.
  const force = (data as { force?: unknown }).force;
  return (section === undefined || typeof section === 'string') && (force === undefined || typeof force === 'boolean');
}

/**
 * P4-4 phase 1b: a `graphService:getCodeMap` whose `section` is not a
 * string. Main validates before sending, so this is defensive: it is
 * answered with an explicit error instead of being dropped, which would
 * leave main's request pending until its backstop timeout.
 */
function isMalformedGetCodeMapRequest(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'graphService:getCodeMap' &&
    !isGetCodeMapRequest(data)
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
  const { type, query, requestId, section } = data as {
    type?: unknown;
    query?: unknown;
    requestId?: unknown;
    section?: unknown;
  };
  return (
    type === 'graphService:pathTrace' &&
    typeof query === 'string' &&
    query.trim().length > 0 &&
    typeof requestId === 'number' &&
    isOptionalSection(section)
  );
}

/**
 * P4-4 phase 2a: a request's optional `section` — absent (the whole scope)
 * or a string. Any string is accepted here; one that is not an allowlist
 * entry gets the explicit `unknown-section` result (`resolveSectionFilter`).
 */
function isOptionalSection(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * P4-4 phase 2a: true when `data` would pass `guard` but for a malformed
 * (non-string) `section`. Main validates before sending, so this is
 * defensive, like `isMalformedGetCodeMapRequest`: such a request is answered
 * with an explicit `Invalid section.` error instead of being dropped (which
 * would leave main's request pending until its backstop timeout).
 */
function isMalformedSectionRequest(data: unknown, guard: (value: unknown) => boolean): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !isOptionalSection((data as { section?: unknown }).section) &&
    guard({ ...data, section: undefined })
  );
}

/** P4-4 phase 2a: the result a malformed `section` gets (`isMalformedSectionRequest`). */
const INVALID_SECTION_RESULT = { status: 'error', message: 'Invalid section.' } as const;

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
 * True for a `graphService:retryModel` request (P1-3) — a payload-free
 * message, so only `type` is checked, same untrusted-shape treatment as
 * every other guard here.
 */
function isRetryModelRequest(data: unknown): data is GraphServiceRetryModelRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'graphService:retryModel'
  );
}

/**
 * Handles a `graphService:retryModel` request (P1-3) — the model-status
 * Retry. Retries ONLY the local-model download + verification: never a
 * re-index, subprocess restart, or summary wipe. A failed attempt already
 * resets `modelAttempt` to `null` (see `kickOffModelDownload`), so this
 * needs no new state — just a trigger:
 *  - model already ready → nothing to retry; re-post `ready`;
 *  - an attempt in flight (e.g. a double click) → no second download;
 *  - otherwise → a fresh `kickOffModelDownload()`, whose own posts drive
 *    the `downloading → verifying → ready|error` status stream.
 * On success, summary and LLM-judgment generation resume for the cached
 * Code Map's Nodes through the existing guarded
 * `startSummaryGenerationForProject`/`startJudgmentGenerationForProject`
 * (whose run guards stop a duplicate run). If the model is already ready,
 * the current `ready` status is re-posted instead. Only on the local
 * backend: a cloud backend never waited on this model, and its own
 * generation is driven by the backend-switch path.
 */
function handleRetryModelRequest(): void {
  if (activeBackendConfig.activeBackend !== 'local') {
    // P5-c review round 1: under Cloud the local model is never needed, so
    // a Retry (e.g. from a badge left over from a Local session) downloads
    // nothing and posts no model status.
    return;
  }
  if (localModelReady) {
    // Nothing to retry — but re-post the current `ready` status so a footer
    // still showing a stale `error` catches up rather than the Retry
    // looking like it silently did nothing (review round 1).
    postModelStatus({
      type: 'graphService:modelStatus',
      state: 'ready',
      at: now(),
      model: localModelReady.model,
    });
    return;
  }
  if (modelAttempt) {
    // In flight (e.g. a double click) — its own progress posts already
    // update the footer; never start a second download.
    return;
  }
  // The generation this retry belongs to — a project switch/re-index while
  // the download runs starts its own generation, which awaits the (same,
  // memoized) attempt itself; this retry must not also kick the old one.
  const generationId = activeSummaryGenerationId;
  const logFailure = (label: string) => (error: unknown) => {
    console.error(
      `[graph-service] ${label} after model retry failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  void kickOffModelDownload()
    .then(() => {
      if (!localModelReady || generationId !== activeSummaryGenerationId) {
        return;
      }
      if (activeIndexPath) {
        checkConstrainedTierAdvisory(activeIndexPath).catch(logFailure('hardware advisory check'));
      }
      const nodes = activeCodeMapNodes;
      const edges = activeCodeMapEdges;
      if (nodes && edges && activeBackendConfig.activeBackend === 'local') {
        // Both runs exited early on the model failure, and each run guard
        // (`activeGenerationRunId`/`activeJudgmentGenerationRunId`) clears
        // itself in its `finally`, so neither blocks this restart — while
        // still stopping a duplicate if one is somehow already running.
        startSummaryGenerationForProject(nodes, edges, activeFoldedModules ?? [], activeFoldedTypes ?? [], activeRawCodeMap).catch(
          logFailure('summary generation'),
        );
        startJudgmentGenerationForProject(nodes).catch(logFailure('judgment generation'));
      }
    })
    .catch(logFailure('model retry follow-up'));
}

/**
 * True for a `graphService:runIngestion` request — mirrors
 * `isRegenerateNodeRequest`'s shape; `bot` widens from the literal
 * `'codeRabbit'` to the full `PrBotId` union as of Story 2.3 (Phase 3), now
 * that the Qodo/PR-Agent adapter exists alongside Phase 2's CodeRabbit one.
 * Same untrusted-shape treatment every other guard in this file applies to
 * values crossing this `parentPort` boundary from main.
 */
function isRunIngestionRequest(data: unknown): data is GraphServiceRunIngestionRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, bot } = data as { type?: unknown; bot?: unknown };
  return type === 'graphService:runIngestion' && (bot === 'codeRabbit' || bot === 'qodo');
}

/**
 * True for a `graphService:computeDiffScope` request (Story 3.1, Phase 1) —
 * mirrors `isRunIngestionRequest`'s shape, plus the same defensive
 * non-empty-string check `isIndexRequest` already applies to `projectPath`.
 * `baseRef`, when present, must be a non-empty string (review finding, Edge
 * Case Hunter: an empty string previously passed this guard and reached
 * `git merge-base` as a literal empty ref, producing an opaque generic
 * subprocess error instead of `resolveDefaultBranch`'s own resolution path)
 * — `undefined` (omitted) is still valid and means "resolve a default".
 * `requestId` must be a `number` — echoed back verbatim in the reply so
 * main can discard a stale reply from an abandoned request (see
 * `GraphServiceComputeDiffScopeRequest`'s own doc comment). Same untrusted-
 * shape treatment every other guard in this file applies to values crossing
 * this `parentPort` boundary from main.
 */
function isComputeDiffScopeRequest(data: unknown): data is GraphServiceComputeDiffScopeRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, projectPath, baseRef, requestId, section } = data as {
    type?: unknown;
    projectPath?: unknown;
    baseRef?: unknown;
    requestId?: unknown;
    section?: unknown;
  };
  return (
    type === 'graphService:computeDiffScope' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    (baseRef === undefined || (typeof baseRef === 'string' && baseRef.length > 0)) &&
    typeof requestId === 'number' &&
    // P4-4 phase 2a.
    isOptionalSection(section)
  );
}

/**
 * True for a `graphService:expandBlastRadius` request (Story 3.2, Phase 1) —
 * mirrors `isComputeDiffScopeRequest`'s shape, plus the same defensive
 * "every element is actually a string" check `isRunIngestionRequest`/
 * `isIndexRequest` already apply to values crossing this `parentPort`
 * boundary from main. `nodeIds` is allowed to be an empty array (the I/O
 * matrix's "empty seed set" scenario) — only a non-array, or an array
 * containing a non-string, is rejected.
 */
function isExpandBlastRadiusRequest(data: unknown): data is GraphServiceExpandBlastRadiusRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, projectPath, nodeIds, requestId, section } = data as {
    type?: unknown;
    projectPath?: unknown;
    nodeIds?: unknown;
    requestId?: unknown;
    section?: unknown;
  };
  return (
    type === 'graphService:expandBlastRadius' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    Array.isArray(nodeIds) &&
    nodeIds.every((nodeId) => typeof nodeId === 'string') &&
    typeof requestId === 'number' &&
    // P4-4 phase 2a.
    isOptionalSection(section)
  );
}

/**
 * P4-7c: true for a `graphService:listEntryCandidates` request — the same
 * untrusted-shape treatment as `isExpandBlastRadiusRequest`: a non-empty
 * `projectPath`, a numeric `requestId` and an optional non-empty `section`.
 */
function isListEntryCandidatesRequest(data: unknown): data is GraphServiceListEntryCandidatesRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, projectPath, requestId, section } = data as Record<string, unknown>;
  return (
    type === 'graphService:listEntryCandidates' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    typeof requestId === 'number' &&
    isOptionalSection(section)
  );
}

/**
 * P4-4 phase 3b: true for a `graphService:diffScopeCarry` request — the same
 * untrusted-shape treatment as the other guards here: a non-empty
 * `projectPath` and `baseRef`, a numeric `requestId`, and each section `null`
 * (`all`) or a non-empty string.
 */
function isDiffScopeCarryRequest(data: unknown): data is GraphServiceDiffScopeCarryRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, projectPath, requestId, fromSection, toSection, baseRef } = data as Record<string, unknown>;
  const isSectionKey = (value: unknown) => value === null || (typeof value === 'string' && value.length > 0);
  return (
    type === 'graphService:diffScopeCarry' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    typeof requestId === 'number' &&
    isSectionKey(fromSection) &&
    isSectionKey(toSection) &&
    typeof baseRef === 'string' &&
    baseRef.trim().length > 0
  );
}

/**
 * P4-4 phase 3b (founder decision 2026-10-04): may PR Review's base ref
 * carry from `fromSection` to `toSection` (`null` = `all`: the project root)?
 * Only for the active project, and only for sections in the live allowlist
 * (any other is `not-carried`, never a folder outside the scope). The
 * repository check is `decideDiffScopeCarry` (git-diff-scope.ts). Never
 * throws.
 */
export async function computeDiffScopeCarryResult(
  projectPath: string,
  fromSection: string | null,
  toSection: string | null,
  baseRef: string,
): Promise<DiffScopeCarryResult> {
  const projectRoot = activeProjectPath;
  if (!projectRoot || projectRoot !== projectPath) {
    return { status: 'error', message: 'The requested project is not the currently active project.' };
  }
  const folderOf = (section: string | null): string | undefined =>
    section === null ? projectRoot : activeIncludedPaths.includes(section) ? path.join(projectRoot, section) : undefined;
  const fromDir = folderOf(fromSection);
  const toDir = folderOf(toSection);
  if (fromDir === undefined || toDir === undefined) {
    return { status: 'not-carried' };
  }
  return { status: await decideDiffScopeCarry(fromDir, toDir, baseRef) };
}

/** P4-4 phase 3b: posts the `graphService:diffScopeCarryResult` reply. */
function postDiffScopeCarryResultMessage(message: GraphServiceDiffScopeCarryResultMessage): void {
  process.parentPort?.postMessage(message);
}

async function handleDiffScopeCarryRequest(request: GraphServiceDiffScopeCarryRequest): Promise<void> {
  let result: DiffScopeCarryResult;
  try {
    result = await computeDiffScopeCarryResult(
      request.projectPath,
      request.fromSection,
      request.toSection,
      request.baseRef,
    );
  } catch (error) {
    result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  postDiffScopeCarryResultMessage({
    type: 'graphService:diffScopeCarryResult',
    projectPath: request.projectPath,
    requestId: request.requestId,
    result,
  });
}

/** True for a recognized `CloudBackend` value — shared by both message-shape guards below. */
function isCloudBackendValue(value: unknown): value is CloudBackend {
  return value === 'local' || value === 'cloud';
}

function isIndexRequest(data: unknown): data is GraphServiceIndexRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, path: projectPath, activeBackend, cloudApiKey, includedPaths } = data as {
    type?: unknown;
    path?: unknown;
    activeBackend?: unknown;
    cloudApiKey?: unknown;
    includedPaths?: unknown;
  };
  // Mirrors the validation pattern main/index.ts's projectOpenPath handler
  // already uses for a renderer-supplied path: non-empty and absolute, not
  // merely a string, before it reaches the backend uncaught. Story 1.6
  // (Phase 2) adds the same defensive treatment for `activeBackend`/
  // `cloudApiKey`, which cross the same untrusted-shape boundary (even
  // though this particular sender is main, not the renderer). Bug fix
  // (2026-09-23) adds the same treatment for `includedPaths`.
  return (
    type === 'graphService:index' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    path.isAbsolute(projectPath) &&
    isCloudBackendValue(activeBackend) &&
    (cloudApiKey === undefined || typeof cloudApiKey === 'string') &&
    (includedPaths === undefined ||
      (Array.isArray(includedPaths) && includedPaths.every((entry) => typeof entry === 'string')))
    // P4-7g review round 1: `entryPins` never rejects the request — invalid
    // ids are dropped (`sanitizeEntryPins`).
  );
}

/**
 * P4-7g review round 1: the index request's `entryPins`, keeping only
 * non-empty string ids (first place of a repeated one) — a malformed pin
 * list never blocks indexing.
 */
export function sanitizeEntryPins(entryPins: unknown): string[] {
  if (!Array.isArray(entryPins)) {
    return [];
  }
  return [...new Set(entryPins.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** P4-7g: an array of non-empty strings (pinned Node ids). */
function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0);
}

/** P4-7g: true for a `graphService:setEntryPins` message — a non-empty `projectPath` and an id list. */
function isSetEntryPinsRequest(data: unknown): data is GraphServiceSetEntryPinsRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, projectPath, pinnedIds } = data as Record<string, unknown>;
  return (
    type === 'graphService:setEntryPins' && typeof projectPath === 'string' && projectPath.length > 0 && isIdList(pinnedIds)
  );
}

/**
 * Handles a `graphService:scopeChanged` (P2-1). Synchronous on receipt, so a
 * `graphService:getCodeMap` main posts after it (the renderer's refetch) is
 * filtered with the new scope. Posts nothing: no status, no reply, no index.
 */
function handleScopeChangedRequest(projectPath: string, includedPaths: readonly string[]): void {
  ({ activeIncludedPaths, pendingScopeOverride } = applyScopeChanged(
    { activeProjectPath, activeIncludedPaths, activeIndexPath, pendingScopeOverride },
    projectPath,
    includedPaths,
  ));
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

function shutdown(stopCbm: boolean): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  void finishShutdown(stopCbm);
}

async function finishShutdown(stopCbm: boolean): Promise<void> {
  if (activeIndexRequest) {
    // Best-effort only — see SHUTDOWN_GRACE_MS's doc comment.
    await Promise.race([
      activeIndexRequest.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
  }
  // Story 5.1 (Phase 1, review round 1): releases the Agent-Facing Query
  // Surface's HTTP listener/MCP transport on a clean subprocess shutdown —
  // the same resource-release discipline `disposeModelContext` below already
  // established for this file (its own doc comment: "previously never
  // disposed, leaking... rather than releasing them on a clean subprocess
  // shutdown"). `closeMcpServer` itself already logs and swallows its own
  // errors, so this is best-effort/never throws; not worth racing against
  // SHUTDOWN_GRACE_MS either, same reasoning as the two steps below.
  if (closeMcpServer) {
    await closeMcpServer();
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
  // Bug fix (2026-09-23): fire-and-forget, only on an actual app quit — see
  // `GraphServiceShutdownRequest.stopCbmDaemon`'s own doc comment for why a
  // mid-session `forceRespawn` restart deliberately skips this. Placed after
  // every awaited step above (not before) so this subprocess's own clean
  // shutdown is never delayed by it — `stopCbmDaemon` doesn't need to be
  // awaited to take effect (see its own doc comment).
  if (stopCbm) {
    stopCbmDaemon();
  }
  postStatus({ state: 'exited', pid: process.pid, at: now(), code: 0 });
  process.exit(0);
}

async function handleIndexRequest(
  projectPath: string,
  backendConfig: { activeBackend: CloudBackend; cloudApiKey?: string },
  includedPaths: readonly string[],
  entryPins: readonly string[] = [],
): Promise<void> {
  activeIndexPath = projectPath;
  // P4-7g: this request carries the project's pins as main read them just
  // now; a later `graphService:setEntryPins` for it replaces them.
  activeEntryPins = { projectPath, pinnedIds: [...entryPins] };
  // P2-1: this request carries the scope main read just now, so any override
  // saved during an earlier attempt is already reflected in it.
  pendingScopeOverride = undefined;
  // Bug fix (2026-09-23): see `activeIndexInFlight`'s own declaration
  // comment — this is the half of the re-entrancy guard that actually means
  // "still running," reset unconditionally in the `finally` below.
  activeIndexInFlight = true;
  // P5-a review round 1: a requested re-index has started (or another index
  // took its place): `activeIndexInFlight` now speaks for it.
  reindexRequestedAt = undefined;
  // Story 1.6 Phase 2: this request's backend choice/decrypted key becomes
  // the one `startSummaryGenerationForProject` resolves a summarizer from,
  // whenever generation for this project actually starts (after the
  // `getCodeMap` round trip below). A fresh Node set is about to be fetched
  // for this (possibly new) project — any Node set cached from a previous
  // project must not be reused by a `graphService:backendSwitched` request
  // that's really about this new project.
  activeBackendConfig = nextBackendConfig(backendConfig);
  activeCodeMapNodes = undefined;
  // Story 3.2 (Phase 1): reset alongside `activeCodeMapNodes` — same
  // never-reuse-a-since-superseded-project's-Edges reasoning (Design Notes).
  activeCodeMapEdges = undefined;
  // P4-2 phase 3a: same lifecycle as the two above.
  activeFoldedModules = undefined;
  activeFoldedTypes = undefined;
  // P4-4 phase 1a: same lifecycle as the four above. Review round 1: and a
  // new generation, so a fetch still in flight from before this point is
  // never cached as the raw map.
  activeRawCodeMap = undefined;
  // P4-4 phase 2b: the section builds go with the raw cache they came from.
  sectionCodeMapMemo = undefined;
  // P4-7c: the entry-candidate listings go with the map they were listed from.
  activeEntryCandidates = undefined;
  entryCandidatesSectionMemo = undefined;
  indexGeneration += 1;
  // Story 5.1 (Phase 2): reset alongside `activeCodeMapEdges` — same
  // never-serve-a-since-superseded-project's-coverage-summary reasoning.
  activeCoverageSummary = undefined;
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

  // Story 1.5 Phase 1 (AD-18): under Local, the local-model download/verify
  // starts here, alongside indexing, not sequentially after it — the
  // pre-mortem finding behind the Intent's "one bounded first-run wait."
  // Fire-and-forget: its own promise settles independently and is never
  // awaited by this function, so neither piece of work can block or be
  // blocked by the other. Memoized (see `kickOffModelDownload`'s doc
  // comment), so this is a no-op once an attempt is in flight or has
  // succeeded in this process's lifetime.
  //
  // P5-c (founder decision 4.7): only when this request's backend is Local.
  // Under Cloud nothing is downloaded (no Hugging Face traffic, no model
  // status); the first local consumer starts it on demand instead (e.g. the
  // generation restart after a Cloud→Local switch).
  if (activeBackendConfig.activeBackend === 'local') {
    void kickOffModelDownload();
    // Story 1.5 Phase 3 (review finding, High): re-checked per project, not
    // just inside `kickOffModelDownload`'s own one-shot `.then()` — see
    // `checkConstrainedTierAdvisory`'s own doc comment for why. Fire-and-
    // forget, same reasoning as `kickOffModelDownload` itself: never awaited
    // here, so it can't delay `indexRepository` below. P5-c: Local only too.
    void checkConstrainedTierAdvisory(projectPath);
  }
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
    // P5-a: HEAD is read BEFORE the index starts, so a checkout while it
    // runs leaves `indexedHead` at the older commit and the next check
    // re-indexes. Never throws (`undefined` on any failure).
    const headAtStart = await readHeadCommit(projectPath);
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
    // P5-a: before `activeProjectPath` is replaced (it tells a re-index of the
    // same project from a project switch).
    autoReindexHead = autoReindexHeadAfterSuccess(autoReindexHead, headAtStart, activeProjectPath === projectPath);
    indexedHead = headAtStart;
    // Story 1.5 Phase 2: captured alongside `activeProject`, same
    // never-on-failure reasoning — `activeProjectPath` is what
    // `summary-generator.ts` reads source off disk relative to.
    activeProjectPath = projectPath;
    // Bug fix (2026-09-23): captured alongside `activeProjectPath`, same
    // never-on-failure reasoning — see `activeIncludedPaths`'s own
    // declaration comment.
    // P2-1: unless a newer scope was saved while this index ran — see
    // `pendingScopeOverride`.
    activeIncludedPaths = resolveIncludedPathsOnIndexSuccess(projectPath, includedPaths, pendingScopeOverride);
    pendingScopeOverride = undefined;
    // P4-2 phase 1: test files are dropped — test code is not on the map,
    // so it has no coverage-gap Nodes to flag.
    coverageGapFileSet = new Set(
      (coverage?.gapPaths ?? [])
        .map((gap) => toProjectRelativePosixPath(projectPath, gap.path, 'coverage gap file'))
        .filter((file) => !isTestPath(file)),
    );
    // Story 5.1 (Phase 2): captured alongside `coverageGapFileSet`'s own
    // derivation from the same `coverage` value — the full summary object,
    // not just its derived gap-path projection, so a later on-demand
    // `get_coverage_summary` MCP query has the whole thing to return.
    // Deliberately `coverage` verbatim (never reshaped) — `coverage` is
    // already `IndexCoverageSummary | undefined` exactly as `indexRepository`
    // returned it, best-effort per that type's own doc comment (omitted, not
    // an error, when the `index_status` follow-up call fails).
    activeCoverageSummary = coverage;
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
    // P2-1: a scope saved while this failed index ran has nothing to apply
    // to; main persisted it, and the next index request carries it.
    pendingScopeOverride = undefined;
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
  } finally {
    // Bug fix (2026-09-23): unconditional, regardless of which branch above
    // ran (success, the "superseded" early return in either branch, or a
    // genuine failure) — see `activeIndexInFlight`'s own declaration
    // comment. Never gated on `activeIndexPath === projectPath` the way the
    // branches above are: even a superseded/discarded attempt for THIS
    // path genuinely stopped running, so the flag must clear regardless of
    // whether its result was applied.
    activeIndexInFlight = false;
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
 * `graphService:getCodeMap` FETCH (today's only "index refresh") is when
 * staleness gets (re-)checked. P5-b: a request served from the raw cache is
 * no fetch, so it neither re-checks staleness nor re-reads the backend; see
 * the P5-b paragraph below. Fire-and-forget for the same reason
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
 *
 * P5-b (founder decision 2.1): a request — a section switch, a switch back
 * to the whole scope, or a plain reload — is served from the raw cache
 * (`activeRawCodeMap`) when it is current (same project and index
 * generation, fetched outside an index) and was built under the live
 * allowlist (`resolveRawForRequest`). Such a reply is built by the same
 * `postCodeMapReply` steps from the cached raw fetch, so it is exactly what a
 * fetch would post for that raw fetch now, including the current summary and
 * judgment state (the build reads the record store). It makes no CBM fetch
 * and no LCOV load, re-caches nothing, and runs no staleness check (summary
 * and judgment: see founder decision 1 below). Consequence: a new `coverage/lcov.info` and edited sources
 * are picked up — and staleness is re-checked — only by the next real fetch:
 * the first after `indexed` (a re-index, including P5-a's re-index on a HEAD
 * move, or a reopen), after a scope save, or a forced request (the map's
 * Retry, founder decision 2). Founder decision 1: a cache-served request
 * still re-kicks summary and judgment generation over the cached arrays (a
 * no-op while a run is going), but never staleness. Likewise, a switch no longer
 * reflects any backend-side refresh (e.g. the backend re-indexing a watched
 * project on its own) until such a fetch. A build that throws on the cached
 * raw fetch posts `codeMapError` and stops that cache from serving, so the
 * next request re-fetches. The unknown-section check runs first, before
 * either path.
 */
async function handleGetCodeMapRequest(section?: string, force = false): Promise<void> {
  if (activeProject === undefined || activeProjectPath === undefined) {
    postCodeMapMessage({
      type: 'graphService:codeMapError',
      message: 'No project has finished indexing yet.',
      // P4-4c review round 1: echoed, so main can drop a stale error.
      section: section ?? null,
    });
    return;
  }
  // P4-4 phase 1b (AD-13 "Section scope"): a section must be an entry of the
  // allowlist at request time (exact match); anything else — including any
  // section while the allowlist is empty — is the explicit `unknown-section`
  // state, never an empty map. Checked before the fetch, so it costs none.
  // P4-4 phase 2a: through `resolveSectionFilter`, shared with Path Trace,
  // diff scope and Blast Radius expansion.
  const requestFilter = section === undefined ? undefined : resolveSectionFilter(section, activeIncludedPaths);
  if (requestFilter !== undefined && typeof requestFilter !== 'function') {
    postCodeMapMessage({
      type: 'graphService:codeMapUnknownSection',
      section: requestFilter.section,
      knownSections: requestFilter.knownSections,
    });
    return;
  }
  // P5-b review round 1: the raw cache this request is served from, if any.
  let servedFrom: Readonly<ActiveRawCodeMap> | undefined;
  try {
    // P5-b (founder decision 2.1): the raw fetch this reply is built from —
    // the raw cache when it is current and was built under the live scope,
    // otherwise a fresh CBM fetch with its LCOV load (today's path).
    const resolved = await resolveRawForRequest(activeProject, activeProjectPath, force);
    servedFrom = resolved.cached ? resolved.source : undefined;
    const whole = postCodeMapReply(resolved.raw, resolved.appliedScope, section);
    if (resolved.cached) {
      // P5-b: served from the raw cache. Nothing is re-cached:
      // `activeCodeMapNodes`/`Edges`, the raw cache's identity and every memo
      // keyed on them (section builds, entry candidates) survive the switch.
      // Founder decision 1 (2026-10-15): summary and judgment generation are
      // re-kicked over those same cached arrays, so Nodes a finished run left
      // pending (a failed summarize, say) retry on the next switch or reload,
      // as they did before P5-b. A run still going makes each kick a no-op
      // (same generation). Staleness is not re-checked here.
      rekickPendingGenerationOverCachedMap();
      return;
    }
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
    //
    // Review finding (High — real race condition): `edges` (and P4-4 phase
    // 1a's `raw`) are passed through here rather than cached separately —
    // `startSummaryGenerationForProject` sets `activeCodeMapNodes`/
    // `activeCodeMapEdges`/`activeRawCodeMap` together, in the same
    // synchronous tick (its own doc comment). An earlier version cached
    // `edges` right after `fetchCodeMap`, while `activeCodeMapNodes` was only
    // (re)assigned later inside `startSummaryGenerationForProject` — with the
    // real `await loadLcovCoverage(...)` in between, an `expandBlastRadius`
    // request landing in that window computed against a mismatched
    // nodes/edges pair (new edges, stale nodes) with no error, since neither
    // the `activeProjectPath` nor the `activeSummaryGenerationId` guard
    // changes on a plain Code Map refetch of the same project.
    // Frozen (shallowly) — read-only to every reader; see `getActiveRawCodeMap`.
    const rawCodeMap: ActiveRawCodeMap = Object.freeze({
      raw: Object.freeze(resolved.raw),
      appliedScope: Object.freeze([...resolved.appliedScope]),
      indexGeneration: resolved.generation,
    });
    // P5-b: a fetch that started while an index was running may hold that
    // index's half-written graph and the previous index's scope and
    // coverage-gap files, yet carries the new generation's stamp. It is
    // cached as today, but never serves a later request: the first fetch
    // after `indexed` always re-fetches.
    if (!resolved.startedDuringIndex) {
      servableRawCodeMaps.add(rawCodeMap);
    }
    void startSummaryGenerationForProject(whole.nodes, whole.edges, whole.foldedModules, whole.foldedTypes, rawCodeMap);
    // Story 2.2 Phase 2: judgment generation kicked off the same
    // fire-and-forget way, alongside the summary/staleness kick-offs — never
    // delays this response (AD-8). Same `nodesWithRiskSignals` set (not
    // `normalizedNodes`) for the identical reasoning the comment above
    // documents for `startSummaryGenerationForProject`.
    void startJudgmentGenerationForProject(whole.nodes);
    // Story 1.8 Phase 2: staleness detection runs on every Code Map FETCH
    // (Design Notes — this app has no separate incremental-refresh
    // mechanism, so this *is* "the next index refresh"), fire-and-forget
    // exactly like `startSummaryGenerationForProject` above so it can never
    // delay this response. P5-b: not on a request served from the raw cache.
    void startStalenessDetectionForProject(resolved.raw.projectRoot, whole.preSignalNodes);
  } catch (error) {
    // P5-b review round 1: a build that throws on the cached raw fetch stops
    // that cache from serving, so the next request (e.g. Retry) re-fetches.
    if (servedFrom !== undefined) {
      servableRawCodeMaps.delete(servedFrom);
    }
    postCodeMapMessage({
      type: 'graphService:codeMapError',
      message: error instanceof Error ? error.message : String(error),
      section: section ?? null,
    });
  }
}

/**
 * P5-b founder decision 1 (2026-10-15): on a cache-served Code Map request,
 * restarts summary and judgment generation over the CACHED arrays and raw
 * cache — the same objects, so `startSummaryGenerationForProject` re-caches
 * them unchanged and drops no memo. No generation bump: a run already in
 * flight for this generation makes each kick a no-op, so there is never a
 * second concurrent run; a finished one is restarted and only attempts what
 * its eligibility filter still finds pending. Never staleness.
 */
function rekickPendingGenerationOverCachedMap(): void {
  const nodes = activeCodeMapNodes;
  const edges = activeCodeMapEdges;
  if (nodes === undefined || edges === undefined) {
    return;
  }
  void startSummaryGenerationForProject(nodes, edges, activeFoldedModules ?? [], activeFoldedTypes ?? [], activeRawCodeMap);
  void startJudgmentGenerationForProject(nodes);
}

/**
 * P5-b: where a Code Map request's raw fetch comes from — the raw cache
 * (`cached: true`), or a fresh fetch (`cached: false`).
 */
type ResolvedRawCodeMap =
  | { cached: true; raw: RawCodeMap; appliedScope: readonly string[]; source: Readonly<ActiveRawCodeMap> }
  | {
      cached: false;
      raw: RawCodeMap;
      appliedScope: readonly string[];
      /** The index generation the fetch started under, stamped on the raw cache. */
      generation: number;
      /** Whether an index was running when the fetch started (see `servableRawCodeMaps`). */
      startedDuringIndex: boolean;
    };

/**
 * P5-b: the raw caches that may serve a later Code Map request — every one
 * a fetch stored, except a fetch that started while an index was running.
 * Such a fetch carries the new generation's stamp (it started after the
 * index's bump) but may read a half-written graph and the previous index's
 * scope and coverage-gap files, so the first request after `indexed` must
 * still re-fetch. Weak, so a replaced raw cache is simply dropped.
 */
const servableRawCodeMaps = new WeakSet<Readonly<ActiveRawCodeMap>>();

/**
 * P5-b (founder decision 2.1): the raw fetch a Code Map request is built
 * from. The raw cache serves when all of these hold:
 *  - it is current (`getActiveRawCodeMap`: the active project, the current
 *    index generation — `handleIndexRequest` bumps it, so the first fetch
 *    after `indexed` and a stale in-flight fetch never serve);
 *  - its fetch did not start during an index (`servableRawCodeMaps`);
 *  - it was built under the live allowlist (`sameScope`), so a saved scope
 *    change re-fetches;
 *  - the request is not `force`d (P5-b founder decision 2: the map's Retry
 *    always re-reads the map).
 * Otherwise this is today's fetch path, unchanged: `fetchProductionCodeMap`,
 * the scope and coverage-gap files read right after it, then the LCOV load.
 */
async function resolveRawForRequest(project: string, projectRoot: string, force: boolean): Promise<ResolvedRawCodeMap> {
  const cached = getActiveRawCodeMap();
  // P5-b founder decision 2: a forced request (the map's Retry) always fetches.
  if (!force && cached !== null && servableRawCodeMaps.has(cached) && sameScope(cached.appliedScope, activeIncludedPaths)) {
    return { cached: true, raw: cached.raw, appliedScope: cached.appliedScope, source: cached };
  }
  // Review round 1 (P4-4 phase 1a): the generation this fetch starts under,
  // stamped on the raw cache (see `activeRawCodeMap`).
  const generation = indexGeneration;
  const startedDuringIndex = activeIndexInFlight;
  // P4-2 phase 1: `fetchProductionCodeMap` normalizes every Node's `file`
  // and drops test code (Nodes, edges touching them, test files' hotspot
  // rows) before the scope filter below — so test Nodes are neither
  // counted in `hiddenByScope` nor seen by adjacency, blast radius, the
  // severity cuts, or anything cached from this map (diff scope,
  // `lookup_node`, Health Audit, staleness). See `test-code.ts`.
  // P4-2 phase 2: this fetch also attaches `testedBy` (Node detail's
  // "Tested by" row, and `lookup_node` via the cached Nodes).
  // P4-2 phase 3a: and folds Module Nodes off the map (`fold-modules.ts`):
  // no Module Node or Module edge reaches anything below; each Node carries
  // its file's top-level uses as `fileTopLevel`.
  // P4-2 phase 3b: and folds Type/Interface Nodes off the map
  // (`fold-types.ts`): no type Node or type edge reaches anything below;
  // each Node carries the types it uses as `usesTypes`.
  // P4-2 phase 4: and attaches `similarTo` (Node detail's "Similar
  // implementations", and `lookup_node`) from the backend's `SIMILAR_TO`.
  const fetched = await fetchProductionCodeMap(project, projectRoot, 'Code Map', {
    includeTestedBy: true,
    includeImplements: true,
    includeSimilar: true,
    includeCoChanges: true,
  });
  // P2-5: captured once, so the scope reported with the map is exactly the
  // one the pipeline's filter used.
  // P4-4 phase 1a: this and the index's coverage-gap files are read right
  // after the fetch, before the LCOV `await` — the same point the inline
  // pipeline read them.
  const appliedScope = [...activeIncludedPaths];
  const coverageGapFiles = coverageGapFileSet;
  // Story 2.1 (Phase 2): loaded once per fetch (not per-Node) — a
  // wholly independent data source from the backend-query-derived
  // signals, read fresh every fetch for the same never-persisted,
  // always-recomputed reasoning as the rest of `riskSignals` (FR7
  // reproducibility). `undefined` when `coverage/lcov.info` doesn't exist
  // or doesn't parse — never thrown, so it can never fail this fetch.
  // P4-3f review round 1: the report also carries the `FN:`/`FNDA:`
  // records and the listed files newer than it, which decide
  // `testCoverageHit` (the table's `covered`); `test-coverage-gap` still
  // reads its `DA:` lines alone.
  // P4-4 phase 1a: loaded before the (now synchronous) pipeline rather
  // than between its scope steps and its risk-signal step; nothing in the
  // pipeline reads it earlier, so the result is the same.
  // P5-b: loaded on a fetch only, never on a request the raw cache serves.
  const coverage = await loadLcovCoverage(projectRoot);
  // P4-4 phase 1a: everything this map is built from, cached with it
  // (`activeRawCodeMap`) so later requests can re-filter without re-fetching.
  const raw: RawCodeMap = { projectRoot, fetched, coverage, coverageGapFiles };
  return { cached: false, raw, appliedScope, generation, startedDuringIndex };
}

/**
 * P5-b: builds a Code Map reply from `raw` and posts it — shared by the fetch
 * path and the raw-cache path, so both post exactly the same reply for the
 * same raw fetch. Synchronous: it reads the Node record store now (summary
 * and judgment state as of this request). Returns the whole-scope build,
 * which the fetch path caches and hands to the generation kicks. Throws only
 * on a pipeline bug; the caller turns that into `codeMapError`.
 */
function postCodeMapReply(
  raw: RawCodeMap,
  scope: readonly string[],
  section: string | undefined,
): ReturnType<typeof buildScopedCodeMap> {
  const { projectRoot } = raw;
  // A fresh (mutable) copy for the reply, as the fetch path always posted.
  const appliedScope = [...scope];
  // P4-4 phase 1a: the whole pipeline — scope filter, folded type/Module
  // re-scoping, folded-link / type-use / similar re-attach, summary state,
  // adjacency, project-relative severity and the LCOV flags — is
  // `buildScopedCodeMap` (`scoped-code-map.ts`, where each step's
  // reasoning now lives). Severity is relative to the in-scope set.
  //
  // P4-4 phase 1b: this whole-scope build is made for every request,
  // sectioned or not — it is what the caches and the summary, judgment and
  // staleness kicks receive, so `lookup_node`, diff scope, Blast Radius
  // expansion and MCP never see a section. P5-b: on the raw-cache path too,
  // for `sections`, `hiddenByScope` and the cross-section counts.
  const whole = buildScopedCodeMap(raw, keepFileForScope(appliedScope));
  const {
    nodes: nodesWithRiskSignals,
    edges,
    preSignalNodes: normalizedNodes,
    foldedTypes,
    foldedModules,
    hiddenByScope,
  } = whole;
  // P4-4 phase 1b: the Section bar's tab counts, over the whole-scope Nodes
  // (nearest-section rule, so they sum to the whole-scope count).
  const sections = countSectionNodes(projectRoot, normalizedNodes, appliedScope);
  // P4-4 phase 2a: the section re-resolved against the scope this map was
  // built with (`undefined` for the whole scope).
  const sectionFilter = section === undefined ? undefined : resolveSectionFilter(section, appliedScope);
  if (sectionFilter === undefined) {
    postCodeMapMessage({
      type: 'graphService:codeMap',
      nodes: nodesWithRiskSignals,
      edges,
      // P2-5: how many Nodes the scope filter removed — reported with the
      // map (and the scope that removed them) so an empty map can say the
      // scope hid everything. Test Nodes never reach the scope filter, so
      // they are never counted here.
      hiddenByScope,
      appliedScope,
      // Capped per type for the reply only (`usedByTotal` stays the full
      // count); the cache keeps every user for `lookup_node`.
      foldedTypes: capFoldedTypeUsedBy(foldedTypes, FOLDED_TYPE_IPC_MAX_USED_BY),
      // P4-2 phase 3c: for the "Show types & modules" canvas toggle only.
      foldedModules,
      section: null,
      sections,
    });
  } else if (typeof sectionFilter !== 'function') {
    // P4-4 phase 1b: the allowlist changed during the fetch and dropped
    // this section. Still explicit, against the scope the map was built
    // with; the whole-scope caches are refreshed as usual.
    postCodeMapMessage({
      type: 'graphService:codeMapUnknownSection',
      section: sectionFilter.section,
      knownSections: sectionFilter.knownSections,
    });
  } else {
    // P4-4 phase 1b: the reply is a second run of the same pipeline over
    // this section's files alone (nearest-section rule), so its edges,
    // folded types/Modules and every severity cut are the section's own —
    // never filtered out of, or subtracted from, the whole-scope build.
    const sectionMap = buildScopedCodeMap(raw, sectionFilter);
    // A string here: `sectionFilter` is only a predicate when `section` was given.
    const sectionName = section as string;
    // P4-4 phase 3a: what the section's both-endpoints filter dropped,
    // counted over the whole-scope build's Nodes and edges (before that
    // filter), never as "whole scope minus section": the edges joining
    // this section to each other section, and each section Node's callees
    // in another section. Absent when there are none.
    const crossSectionEdges = countCrossSectionEdges(projectRoot, normalizedNodes, edges, sectionName, appliedScope);
    postCodeMapMessage({
      type: 'graphService:codeMap',
      nodes: attachCrossSectionCalls(projectRoot, sectionMap.nodes, normalizedNodes, edges, sectionName, appliedScope),
      edges: sectionMap.edges,
      // P2-5's meaning is kept: the Nodes the allowlist removed. Other
      // sections' Nodes are not counted.
      hiddenByScope,
      appliedScope,
      foldedTypes: capFoldedTypeUsedBy(sectionMap.foldedTypes, FOLDED_TYPE_IPC_MAX_USED_BY),
      foldedModules: sectionMap.foldedModules,
      section: section ?? null,
      sections,
      ...(crossSectionEdges.length > 0 ? { crossSectionEdges } : {}),
    });
  }
  return whole;
}

/**
 * Computes a deterministic call-path trace from a query-resolved entry Node
 * via `@driller/graph-contracts`'s `traceCallPath` (Story 1.9, Phase 1;
 * extracted into its own exported function in Story 5.1, Phase 2 so the
 * Agent-Facing Query Surface's `trace_path` MCP tool can call straight into
 * it — AD-13 — rather than duplicating `handlePathTraceRequest`'s own
 * guard/fetch/trace sequence). Never throws — every failure path (no
 * successful index yet, or `fetchCodeMap` itself failing) is reported as an
 * explicit `{status: 'error', ...}` `PathTraceResult`, mirroring
 * `computeDiffScopeResult`/`computeBlastRadiusExpansionResult`'s own
 * never-throws contract.
 *
 * Strictly read-only (Always: "never touches the Node record store,
 * `activeCodeMapNodes`, or generation/staleness state"): re-fetches
 * nodes+edges fresh via `fetchCodeMap(activeProject)` on every call — the
 * renderer's own existing Path Trace behavior, deliberately preserved as-is
 * (Design Notes: "Why `computePathTraceResult` re-fetches instead of using
 * the cache") rather than switched to the cheaper `activeCodeMapNodes`/
 * `activeCodeMapEdges` cache Blast Radius/diff-scope reuse, which would let
 * agent and human Path Trace results diverge.
 *
 * `traceCallPath` only needs `id`/`name` off each Node and `source`/
 * `target`/`kind` off each edge, never `file`. P4-2 phase 1: `file` is
 * nevertheless normalized here (inside `fetchProductionCodeMap`), because
 * the test-code path rules need project-relative paths.
 *
 * Bug fix (2026-09-23): now also guarded on `activeProjectPath` (previously
 * `activeProject` alone) — needed to normalize `file` internally for
 * `filterCodeMapToScope`'s own match test (see its doc comment), even
 * though the normalized value itself is never returned. `activeProjectPath`
 * is always set alongside `activeProject` on the same successful-index
 * branch (see that variable's own doc comment), so this only makes that
 * existing invariant visible to the type checker — it changes no observable
 * behavior for a project scope this call would already have been able to
 * find.
 */
export async function computePathTraceResult(query: string, section?: string): Promise<PathTraceResult> {
  if (activeProject === undefined || activeProjectPath === undefined) {
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  // P4-4 phase 2a (AD-13 "Section scope"): an unknown section is the
  // explicit `unknown-section` result, decided before the fetch so it costs
  // none (the same order as the Code Map fetch).
  if (section !== undefined) {
    const requestFilter = resolveSectionFilter(section, activeIncludedPaths);
    if (typeof requestFilter !== 'function') {
      return requestFilter;
    }
  }
  try {
    const projectRoot = activeProjectPath;
    // P4-2 phase 1: the same fetch `handleGetCodeMapRequest` uses, so a
    // trace never walks through a test Node.
    const { nodes: productionNodes, edges: productionEdges } = await fetchProductionCodeMap(
      activeProject,
      projectRoot,
      'Path Trace',
    );
    // Bug fix (2026-09-23): a Path Trace must never trace into/through a
    // Node this project's indexing-scope allowlist excludes — same filter
    // `handleGetCodeMapRequest` applies to the Code Map itself.
    // P4-4 phase 2a: with a `section`, the fresh fetch is filtered to that
    // section's files alone (nearest-section rule), so a trace never walks
    // out of it; without one, the whole scope exactly as before. Resolved
    // against the allowlist read after the fetch, as the whole-scope filter
    // always was — a section the allowlist dropped meanwhile is
    // `unknown-section`.
    const keepFile = resolveSectionFilter(section, activeIncludedPaths);
    if (typeof keepFile !== 'function') {
      return keepFile;
    }
    const { nodes, edges } = filterCodeMapToScope(projectRoot, productionNodes, productionEdges, keepFile);
    // Defense in depth: main already sends a trimmed query (its own
    // `ipcMain.handle` validation), but this process trusts nothing crossing
    // its own boundary (same stance `isPathTraceRequest`'s own doc comment
    // takes) — trimming again here means incidental whitespace can never
    // affect matching regardless of which boundary it slipped past.
    return traceCallPath(nodes, edges, query.trim());
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Handles a `graphService:pathTrace` request (Story 1.9, Phase 1) — a thin
 * wrapper (Story 5.1, Phase 2) around `computePathTraceResult` that posts its
 * result back as exactly one `graphService:pathTraceResult` message, so
 * main's pending request always settles (same "never a hung request" framing
 * as `handleGetCodeMapRequest`) — mirrors
 * `handleComputeDiffScopeRequest`/`handleExpandBlastRadiusRequest`'s own
 * thin-handler-over-compute-function shape.
 */
async function handlePathTraceRequest(query: string, requestId: number, section?: string): Promise<void> {
  const result = await computePathTraceResult(query, section);
  postPathTraceResultMessage({ type: 'graphService:pathTraceResult', requestId, result });
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
    // P5-c: an explicit user action, so it starts the download if nothing
    // has downloaded yet, or joins the memoized attempt. It never rejects;
    // an attempt that just settled without a model failed (already reported
    // via `graphService:modelStatus` 'error').
    // Review round 1: snapshotted before the wait — a backend switch (or a
    // re-index) during it must never let a local write land under Cloud.
    const generationBeforeModel = activeSummaryGenerationId;
    await kickOffModelDownload();
    if (generationBeforeModel !== activeSummaryGenerationId || activeBackendConfig.activeBackend !== 'local') {
      return {
        status: 'error',
        message: 'The summary backend or project changed while the local model was loading — nothing was regenerated.',
      };
    }
    if (!localModelReady) {
      return { status: 'error', message: 'The local model failed to load — no summary backend is available.' };
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
 * Handles a `graphService:runIngestion` request — this app's first
 * external-CLI-shelling-out IPC round-trip. Runs exactly one PR-bot's
 * ingestion pass (Story 2.3, Phase 2: CodeRabbit; Phase 3 adds Qodo/
 * PR-Agent) against the most recently fetched Code Map's Nodes
 * (`activeCodeMapNodes`, the same cached set `computeRegenerateNodeResult`
 * reads — never a fresh `fetchCodeMap`, mirroring that handler's own
 * reasoning) and posts back exactly one `graphService:runIngestionResult`
 * message. Never throws — every failure path (no project indexed yet, or an
 * unexpected error from either adapter) is reported as an explicit
 * `{status: 'error', ...}` `PrBotIngestionResult`, mirroring
 * `handleRegenerateNodeRequest`'s own top-level try/catch so main's pending
 * `pendingIngestionResolvers` entry always settles.
 */
async function handleRunIngestionRequest(bot: PrBotId): Promise<void> {
  if (activeIngestionBots.has(bot)) {
    // Review finding (Edge Case Hunter, major) — see `activeIngestionBots`'s
    // own doc comment: main's timeout can outrace this process's real
    // subprocess work, letting a retry reach here while the original pass
    // for this bot is still genuinely in flight. Refuse rather than start a
    // second concurrent pass that would race the first over the same
    // `review.md`/persisted records.
    postRunIngestionResultMessage({
      type: 'graphService:runIngestionResult',
      bot,
      result: { status: 'error', message: 'An ingestion pass for this PR-bot is already running.' },
    });
    return;
  }

  activeIngestionBots.add(bot);
  let result: PrBotIngestionResult;
  try {
    result = await computeIngestionResult(bot);
  } catch (error) {
    result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    activeIngestionBots.delete(bot);
  }
  postRunIngestionResultMessage({ type: 'graphService:runIngestionResult', bot, result });
}

/**
 * Runs `bot`'s ingestion pass and persists the result — branches on `bot`
 * (Story 2.3, Phase 3) between `coderabbit-adapter.ts`'s
 * `runCodeRabbitIngestion` and `qodo-adapter.ts`'s `runQodoIngestion`, both
 * of which share the same `{status, findingsByNodeId}`-shaped `'ok'` variant
 * (and identical `'tool-not-found'`/`'no-base-ref-resolvable'`/`'error'`
 * states), so the clear-then-write persistence logic below is written once
 * and reused for either bot rather than duplicated per branch. The two
 * adapter unions are NOT identical to each other: P0-6 (2026-09-24) added
 * `'review-md-present'` to `QodoIngestionResult` only, since it describes
 * PR-Agent's own `review.md` output path and `cr` has no equivalent. Each
 * adapter's non-`'ok'` states are a subset of `PrBotIngestionResult`, which
 * is all this function's pass-through below actually needs.
 *
 * On a genuine `'ok'` ingestion, persists via the two-step clear-then-write
 * `mergeNodeRecord` pattern the Always constraint requires: every Node's
 * existing `ingestedFindings` entries for this pass's own `sourceTool`
 * (`CODERABBIT_SOURCE_TOOL` or `QODO_SOURCE_TOOL`, selected by `bot`) are
 * stripped first (across the WHOLE project, not just Nodes this pass found
 * findings for — this is what makes a finding that no longer reproduces
 * actually disappear, I/O matrix: "the stale finding is gone from
 * `NodeRecord.ingestedFindings` after this pass"), then the freshly-grouped
 * findings are appended back per Node. Entries from the OTHER bot's
 * `sourceTool` are left untouched by either step — the filter only ever
 * removes this pass's own `sourceTool` entries, and the write-back only
 * ever appends onto whatever remains (Always: "CodeRabbit's own entries are
 * never touched by a Qodo pass, and vice versa").
 */
async function computeIngestionResult(bot: PrBotId): Promise<PrBotIngestionResult> {
  const nodes = activeCodeMapNodes;
  const projectRoot = activeProjectPath;
  if (!nodes || !projectRoot) {
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  // Captured before the (possibly minutes-long) `cr`/`python` invocation
  // below, for the supersession check after it resolves — see that check's
  // own comment for why `activeSummaryGenerationId` and not a plain
  // `activeProjectPath` comparison is what's actually needed here.
  const generationId = activeSummaryGenerationId;

  const sourceTool = bot === 'codeRabbit' ? CODERABBIT_SOURCE_TOOL : QODO_SOURCE_TOOL;
  const ingestion =
    bot === 'codeRabbit'
      ? await runCodeRabbitIngestion(projectRoot, nodes)
      : await runQodoIngestion(projectRoot, nodes);
  if (ingestion.status !== 'ok') {
    // Every non-`'ok'` state either adapter can return is also a member of
    // `PrBotIngestionResult`, with the identical shape — returned as-is, no
    // reshaping needed. Note this is a widening, not an identity: both
    // adapters carry `'tool-not-found'`/`'no-base-ref-resolvable'`/
    // `'error'`, but `'review-md-present'` (P0-6, 2026-09-24) exists only on
    // `QodoIngestionResult`; `CodeRabbitIngestionResult` does not declare
    // it, so a CodeRabbit pass simply can never produce it.
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
  // reproduces this pass. `sourceTool` was derived from `bot` above.
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
 * Handles a `graphService:computeDiffScope` request (Story 3.1, Phase 1) —
 * this app's first `git diff`/`git merge-base` subprocess computation. A
 * thin wrapper (Story 5.1, Phase 2 review finding: single-flight guard and
 * never-throws safety net moved into `computeDiffScopeResult` itself, so
 * every caller gets both, not just this IPC path) that posts exactly one
 * `graphService:computeDiffScopeResult` message.
 */
async function handleComputeDiffScopeRequest(
  projectPath: string,
  baseRef: string | undefined,
  requestId: number,
  section?: string,
): Promise<void> {
  const result = await computeDiffScopeResult(projectPath, baseRef, section);
  postComputeDiffScopeResultMessage({ type: 'graphService:computeDiffScopeResult', projectPath, requestId, result });
}

/**
 * P4-4 phase 3a (founder decision 2026-10-03): each section folder's git
 * top-level directory (`resolveGitToplevel`), for "is this section in the
 * same repository". One lookup per section per index generation and project
 * root: the cache is replaced as soon as either changes (any index start
 * bumps the generation). A lookup that fails is cached as `undefined` too.
 */
let gitToplevelCache:
  | { generation: number; projectRoot: string; bySection: Map<string, Promise<string | undefined>> }
  | undefined;

async function sectionGitToplevels(
  projectRoot: string,
  sections: readonly string[],
): Promise<Map<string, string | undefined>> {
  if (
    gitToplevelCache === undefined ||
    gitToplevelCache.generation !== indexGeneration ||
    gitToplevelCache.projectRoot !== projectRoot
  ) {
    gitToplevelCache = { generation: indexGeneration, projectRoot, bySection: new Map() };
  }
  const { bySection } = gitToplevelCache;
  const entries = await Promise.all(
    [...new Set(sections)].map(async (section): Promise<[string, string | undefined]> => {
      let lookup = bySection.get(section);
      if (lookup === undefined) {
        lookup = resolveGitToplevel(path.join(projectRoot, ...section.split('/')));
        bySection.set(section, lookup);
      }
      return [section, await lookup];
    }),
  );
  return new Map(entries);
}

/** Tests only: the git top-level cache's sections, and the generation it is for. */
export function peekGitToplevelCacheForTests(): { generation: number; sections: string[] } | undefined {
  return gitToplevelCache === undefined
    ? undefined
    : { generation: gitToplevelCache.generation, sections: [...gitToplevelCache.bySection.keys()] };
}

/** P5-a: posts `graphService:headChanged` — main re-sends the index request for the open project. */
function postHeadChanged(message: GraphServiceHeadChangedMessage): void {
  process.parentPort?.postMessage(message);
}

/**
 * P5-a (founder decision 6.1): has the checkout of `projectPath` — the
 * project whose index is served — moved since that index started? Reads HEAD
 * now and compares it with `indexedHead` (`assessHeadDrift`: only two known,
 * different HEADs are drift). On drift, posts `graphService:headChanged` at
 * most once per distinct current HEAD and never while an index is in flight,
 * and returns both HEADs; otherwise `undefined`. Read-only git; never throws.
 */
async function checkHeadDrift(
  projectPath: string,
): Promise<{ indexedHead: string; currentHead: string; reindexing: boolean } | undefined> {
  if (activeProjectPath !== projectPath || indexedHead === undefined) {
    return undefined;
  }
  const comparedWith = indexedHead;
  const currentHead = await readHeadCommit(projectPath);
  // The served index changed while HEAD was read (a re-index finished, or
  // another project's did): this comparison no longer describes it.
  if (activeProjectPath !== projectPath || indexedHead !== comparedWith) {
    return undefined;
  }
  const decision = assessHeadDrift({
    indexedHead: comparedWith,
    currentHead,
    autoReindexHead,
    indexInFlight: activeIndexInFlight,
    reindexRequestPending: reindexRequestedAt !== undefined && Date.now() - reindexRequestedAt < reindexRequestGraceMs,
  });
  if (!decision.drift) {
    return undefined;
  }
  if (decision.requestReindex) {
    autoReindexHead = decision.currentHead;
    reindexRequestedAt = Date.now();
    postHeadChanged({
      type: 'graphService:headChanged',
      path: projectPath,
      indexedHead: decision.indexedHead,
      currentHead: decision.currentHead,
    });
  }
  return { indexedHead: decision.indexedHead, currentHead: decision.currentHead, reindexing: decision.reindexing };
}

/** P5-a: a well-formed `graphService:checkHead` (a non-empty absolute `path`). */
function isCheckHeadRequest(data: unknown): data is GraphServiceCheckHeadRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, path: projectPath } = data as Record<string, unknown>;
  return (
    type === 'graphService:checkHead' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    path.isAbsolute(projectPath)
  );
}

/**
 * P5-a: main's focus-time check. Posts nothing unless the checkout drifted
 * (then `headChanged`, via `checkHeadDrift`). Skipped while another focus
 * check is still running, or while an index is in flight (it could not ask
 * for a re-index anyway). Never throws.
 */
async function handleCheckHeadRequest(projectPath: string): Promise<void> {
  if (headCheckInFlight || activeIndexInFlight) {
    return;
  }
  headCheckInFlight = true;
  try {
    await checkHeadDrift(projectPath);
  } catch (error) {
    console.error(`[graph-service] HEAD check failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    headCheckInFlight = false;
  }
}

/**
 * Computes the diff-scoped `DiffScopeResult` for `projectPath` against
 * `baseRef` — branches on `git-diff-scope.ts`'s `computeDiffScope` result:
 * every non-`'resolved'` state (`'no-changes'`/`'not-a-git-repo'`/
 * `'no-base-ref-resolvable'`/`'error'`) is structurally identical to
 * `DiffScopeResult`'s own variants and returned as-is, no reshaping needed
 * (same precedent `computeIngestionResult` already established for
 * `CodeRabbitIngestionResult`'s pass-through states). Only `'resolved'` is
 * reshaped: `changedFiles` is matched against `nodes` via
 * `@driller/graph-contracts`'s `findChangedNodeIds` to produce `nodeIds` —
 * the actual diff-scoped Node set.
 *
 * Exported as-is signature-wise (Story 5.1, Phase 2, Always) — the
 * Agent-Facing Query Surface's `compute_diff_scope` MCP tool calls straight
 * into this same function (AD-13), never a second copy of this logic.
 *
 * Single-flight guard and never-throws contract now owned here (review
 * finding, High — moved from `handleComputeDiffScopeRequest`'s own body):
 * that handler used to be the sole place refusing a second concurrent
 * request outright (`activeDiffScopeComputationInFlight`, "rather than
 * letting two overlapping git subprocess sequences race each other" — same
 * reasoning as `handleRunIngestionRequest`'s own `activeIngestionBots`
 * guard) and catching an unexpected throw into an explicit
 * `{status:'error', ...}`. Once `compute_diff_scope` became a second
 * production caller of this function, either that logic had to be
 * duplicated in every caller or centralized here — centralizing is what
 * actually satisfies AD-13's "exposed identically... never re-implemented"
 * for callers too, not just for the git-diffing logic itself.
 */
export async function computeDiffScopeResult(
  projectPath: string,
  baseRef: string | undefined,
  section?: string,
): Promise<DiffScopeResult> {
  if (activeDiffScopeComputationInFlight) {
    return { status: 'error', message: 'A diff-scope computation is already running.' };
  }
  activeDiffScopeComputationInFlight = true;
  try {
    const projectRoot = activeProjectPath;
    if (!projectRoot) {
      return { status: 'error', message: 'No project has finished indexing yet.' };
    }
    if (projectRoot !== projectPath) {
      // Mirrors `computeIngestionResult`'s own stale-project guard: a request
      // for a project that isn't (or is no longer) this process's active one
      // must never silently compute against the wrong project's Nodes.
      return { status: 'error', message: 'The requested project is not the currently active project.' };
    }
    // P5-a (founder decision 6.1): the checkout moved since this project was
    // indexed — the served line ranges are an older commit's, so no diff is
    // computed against them. The check asks main for a re-index (once per
    // HEAD); every call during the drift, including while that re-index
    // runs or after it fails (when `nodes` is unset), gets this same error.
    const drift = await checkHeadDrift(projectRoot);
    if (drift !== undefined) {
      return { status: 'error', message: headDriftErrorMessage(drift.indexedHead, drift.currentHead, drift.reindexing) };
    }
    // Captured after the HEAD read above (it awaits), so a re-index that
    // started meanwhile is seen here rather than slipping past the
    // supersession check further down.
    const nodes = activeCodeMapNodes;
    // P4-2 phase 3a: captured with `nodes` (same fetch, same tick).
    const foldedModules = activeFoldedModules ?? [];
    // P4-2 phase 3c: captured with them too; `usedBy` here is uncapped.
    const foldedTypes = activeFoldedTypes ?? [];
    if (activeProjectPath !== projectRoot) {
      return { status: 'error', message: 'The requested project is not the currently active project.' };
    }
    if (!nodes) {
      return { status: 'error', message: 'No project has finished indexing yet.' };
    }
    // P4-4 phase 2a (AD-13 "Section scope"): with a `section`, the inputs —
    // the whole-scope cached Nodes, folded types and folded Modules — are
    // narrowed to that section's files (nearest-section rule) BEFORE any
    // matching below, so the changed Nodes, changed contracts (and their
    // dependents) and top-level-only files are all the section's own. Never
    // the whole-scope result filtered afterwards. An unknown section is the
    // explicit `unknown-section` result, before any git call.
    const wholeScope: DiffMatchInputs<CodeMapNode> = { nodes, foldedTypes, foldedModules };
    let scoped = wholeScope;
    // P4-4 phase 3a: the scope the caches were built under (which decides
    // section ownership), for `changedInOtherSections`; only with a section.
    let ownershipScope: readonly string[] | undefined;
    if (section !== undefined) {
      // Review round 1: existence from the live allowlist, ownership from
      // the scope the caches were built under.
      const keepFile = resolveCachedSectionFilter(section);
      if (typeof keepFile !== 'function') {
        return keepFile;
      }
      // Non-null: `resolveCachedSectionFilter` only returns a predicate when
      // a current raw cache exists.
      ownershipScope = (getActiveRawCodeMap() as ActiveRawCodeMap).appliedScope;
      scoped = narrowDiffInputs(projectRoot, wholeScope, keepFile);
    }
    // Captured before the git subprocess calls below, for the supersession
    // check after they resolve — see `computeIngestionResult`'s own identical
    // guard (Story 2.3 Phase 2 review finding) for why `activeSummaryGenerationId`,
    // not a plain `activeProjectPath` comparison, is what's actually needed:
    // a re-index of the SAME project also bumps this counter, unlike
    // `activeProjectPath`, which is reassigned to the same value on every
    // re-index and so can't detect one on its own.
    const generationId = activeSummaryGenerationId;

    const diffScope = await computeDiffScope(projectRoot, baseRef);
    if (diffScope.status !== 'resolved') {
      return diffScope;
    }
    // P4-4 phase 3a (founder decision 2026-10-03): with a section, which
    // other sections share its git repository (`git rev-parse
    // --show-toplevel` per section folder, cached per index generation). A
    // section in another repository — or in none — is not part of this diff.
    let sameRepo: ((other: string) => boolean) | undefined;
    if (section !== undefined && ownershipScope !== undefined) {
      const toplevels = await sectionGitToplevels(projectRoot, ownershipScope);
      const own = toplevels.get(section);
      sameRepo = (other) => own !== undefined && toplevels.get(other) === own;
    }

    // Review finding (Blind Hunter): `nodes` was captured before the
    // (possibly slow) git subprocess calls above — if a re-index or project
    // switch happened during that window, `nodes` no longer reflects this
    // project's current indexed state, and its Node ids may not even be valid
    // anymore. Discard rather than return a `nodeIds` set matched against a
    // now-superseded Node list.
    if (activeSummaryGenerationId !== generationId || activeProjectPath !== projectRoot) {
      return {
        status: 'error',
        message: 'The project changed while the diff-scope computation was running; discarding its results.',
      };
    }

    // P4-2 phase 3a: a changed Module is not a changed Node (it isn't in
    // `nodes`), so a file whose only change-able content is top-level code
    // is reported by name instead — never a silent "0 changed Nodes".
    // P4-2 phase 3c: a changed type is not a changed Node either (types are
    // folded off the map), so it is named as a changed contract, with the map
    // Nodes that use it — and a file whose every change touches a type is a
    // contract change, not a "top-level code" change.
    // Dependents are kept only among `nodes` (the map in scope), so the count
    // is what PR Review can highlight; `dependentIds` is capped for the wire.
    // P4-4 phase 3a: these steps now live in `summarizeDiffChanges`
    // (`scoped-code-map.ts`), unchanged, so `changedInOtherSections` reuses them.
    const { nodeIds, changedContracts, approximate, topLevelFiles } = summarizeDiffChanges(scoped, diffScope);
    // P4-4 phase 3a: with a section, what the diff changed in each OTHER
    // section of the same repository — each section's own counts, from the
    // same finders over the whole-scope caches narrowed to it (never the
    // section's result subtracted from the whole), ownership by the caches'
    // own scope. Absent when there are none, and never computed without a
    // section.
    const changedInOtherSections =
      section === undefined || ownershipScope === undefined || sameRepo === undefined
        ? []
        : countChangedInOtherSections(projectRoot, wholeScope, diffScope, section, ownershipScope, sameRepo);
    return {
      status: 'resolved',
      resolvedBaseRef: diffScope.resolvedBaseRef,
      nodeIds,
      ...(topLevelFiles.length > 0 ? { topLevelFiles } : {}),
      ...(changedContracts.length > 0 ? { changedContracts } : {}),
      ...(changedContracts.length > 0 && approximate ? { changedContractsApproximate: true as const } : {}),
      ...(changedInOtherSections.length > 0 ? { changedInOtherSections } : {}),
    };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    activeDiffScopeComputationInFlight = false;
  }
}

/**
 * Handles a `graphService:expandBlastRadius` request (Story 3.2, Phase 1) —
 * a thin wrapper (Story 5.1, Phase 2 review finding: single-flight guard and
 * never-throws safety net moved into `computeBlastRadiusExpansionResult`
 * itself, so every caller gets both, not just this IPC path) that posts
 * exactly one `graphService:expandBlastRadiusResult` message.
 */
async function handleExpandBlastRadiusRequest(
  projectPath: string,
  nodeIds: string[],
  requestId: number,
  section?: string,
): Promise<void> {
  const result = computeBlastRadiusExpansionResult(projectPath, nodeIds, section);
  postExpandBlastRadiusResultMessage({
    type: 'graphService:expandBlastRadiusResult',
    projectPath,
    requestId,
    result,
  });
}

/**
 * Handles a `graphService:listEntryCandidates` request (P4-7c): posts exactly
 * one `graphService:listEntryCandidatesResult`, echoing `projectPath` and
 * `requestId`, with `computeEntryCandidatesResult`'s result (which never
 * throws) — the same call the `list_entry_candidates` MCP tool makes.
 */
function handleListEntryCandidatesRequest(projectPath: string, requestId: number, section?: string): void {
  postListEntryCandidatesResultMessage({
    type: 'graphService:listEntryCandidatesResult',
    projectPath,
    requestId,
    // Review round 1: echoed, so main can check it against its request.
    section: section ?? null,
    result: computeEntryCandidatesResult(projectPath, section),
  });
}

/**
 * Computes the `BlastRadiusExpansionResult` for `projectPath` against
 * `nodeIds` — against the cached `activeCodeMapNodes`/`activeCodeMapEdges`
 * (the same Code Map state `computeDiffScopeResult` reads its own
 * `activeCodeMapNodes` from), never a fresh fetch.
 *
 * Unlike `computeDiffScopeResult` (which awaits slow git subprocess calls),
 * this is a plain synchronous computation — `buildBidirectionalAdjacency`
 * and `computeBlastRadiusHopDistances` are both pure, no-I/O functions
 * (`@driller/graph-contracts`) over data already cached in this process.
 * Still applies the same `activeSummaryGenerationId`/`activeProjectPath`
 * staleness check `computeDiffScopeResult` does after its own await, for
 * structural parity with that mirrored shape (Always) and so a future
 * change to this function's own timing (e.g. a genuinely async BFS over a
 * very large graph) can't silently reintroduce the same supersession bug
 * class `computeDiffScopeResult`'s own guard was added to close.
 *
 * `hopDistances` converts `computeBlastRadiusHopDistances`'s `Map` return
 * value to a plain `Record<string, number>` — see `BlastRadiusExpansionResult`'s
 * own doc comment (`@driller/ipc-contracts`) for why: this result travels
 * over `parentPort`/IPC and should stay JSON-shaped like every other result
 * in this file, not carry a `Map` across that boundary.
 *
 * Exported as-is signature-wise (Story 5.1, Phase 2, Always) — the
 * Agent-Facing Query Surface's `expand_blast_radius` MCP tool calls straight
 * into this same function (AD-13), never a second copy of this logic.
 *
 * Single-flight guard and never-throws contract now owned here (review
 * finding, High — moved from `handleExpandBlastRadiusRequest`'s own body,
 * same reasoning as `computeDiffScopeResult`'s own identical move): once
 * `expand_blast_radius` became a second production caller, centralizing
 * `activeBlastRadiusExpansionInFlight`'s check/set/reset and the try/catch
 * here is what actually gives every caller the same guarantee, not just
 * whichever one happens to remember to wrap it.
 */
export function computeBlastRadiusExpansionResult(
  projectPath: string,
  nodeIds: string[],
  section?: string,
): BlastRadiusExpansionResult {
  if (activeBlastRadiusExpansionInFlight) {
    return { status: 'error', message: 'A blast radius expansion is already running.' };
  }
  activeBlastRadiusExpansionInFlight = true;
  try {
    const nodes = activeCodeMapNodes;
    const edges = activeCodeMapEdges;
    const projectRoot = activeProjectPath;
    if (!nodes || !edges || !projectRoot) {
      return { status: 'error', message: 'No project has finished indexing yet.' };
    }
    if (projectRoot !== projectPath) {
      // Mirrors `computeDiffScopeResult`'s own stale-project guard: a request
      // for a project that isn't (or is no longer) this process's active one
      // must never silently compute against the wrong project's Nodes/Edges.
      return { status: 'error', message: 'The requested project is not the currently active project.' };
    }
    // Captured before the computation below, for the supersession check after
    // it — see `computeDiffScopeResult`'s own identical guard and this
    // function's own doc comment for why this is kept even though the
    // computation itself has no `await` today.
    const generationId = activeSummaryGenerationId;

    // P4-4 phase 2a (AD-13 "Section scope"): with a `section`, the cached
    // whole-scope Nodes and edges are narrowed to that section (edges with
    // both ends in it) BEFORE the adjacency is built, so hop distances never
    // cross a section — the same adjacency the section's own Code Map build
    // walks. A seed outside the section is not in the adjacency, so it
    // contributes nothing (`computeBlastRadiusHopDistances` skips it). An
    // unknown section is the explicit `unknown-section` result.
    let scopedNodes = nodes;
    let scopedEdges = edges;
    if (section !== undefined) {
      // Review round 1: existence from the live allowlist, ownership from
      // the scope the caches were built under.
      const keepFile = resolveCachedSectionFilter(section);
      if (typeof keepFile !== 'function') {
        return keepFile;
      }
      ({ nodes: scopedNodes, edges: scopedEdges } = filterToSection(projectRoot, nodes, edges, keepFile));
    }
    const adjacency = buildBidirectionalAdjacency(scopedNodes, scopedEdges);
    const hopDistancesById = computeBlastRadiusHopDistances(adjacency, nodeIds);

    if (activeSummaryGenerationId !== generationId || activeProjectPath !== projectRoot) {
      return {
        status: 'error',
        message: 'The project changed while the blast radius expansion was running; discarding its results.',
      };
    }

    const hopDistances: Record<string, number> = {};
    for (const [nodeId, distance] of hopDistancesById) {
      hopDistances[nodeId] = distance;
    }
    return { status: 'resolved', hopDistances };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    activeBlastRadiusExpansionInFlight = false;
  }
}

/**
 * P4-6: `CoverageSummaryResult` is declared once in `@driller/graph-contracts`
 * (AD-13) — imported above and re-exported here so this module's public
 * surface is unchanged.
 */
export type { CoverageSummaryResult };

/**
 * Resolves the currently cached `activeCoverageSummary` for `projectPath`
 * (Story 5.1, Phase 2) — the same guard shape as
 * `computeBlastRadiusExpansionResult`'s own `!projectRoot`/
 * `projectRoot !== projectPath` checks (Code Map), since both read
 * module-level "most recently indexed project" state rather than doing any
 * I/O of their own.
 */
export function getCoverageSummaryResult(projectPath: string): CoverageSummaryResult {
  const projectRoot = activeProjectPath;
  if (!projectRoot) {
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  if (projectRoot !== projectPath) {
    // Mirrors `computeBlastRadiusExpansionResult`'s own stale-project guard:
    // a request for a project that isn't (or is no longer) this process's
    // active one must never silently return a different project's coverage.
    return { status: 'error', message: 'The requested project is not the currently active project.' };
  }
  if (!activeCoverageSummary) {
    // Indexed, but the best-effort `index_status` follow-up call that would
    // have populated `activeCoverageSummary` failed — a real, distinct case
    // from `'error'` (see this function's own `CoverageSummaryResult` doc
    // comment).
    return { status: 'unavailable' };
  }
  return { status: 'ok', coverage: activeCoverageSummary };
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
 * Also caches `edges` into `activeCodeMapEdges` (Story 3.2, Phase 1),
 * assigned in the very same synchronous statement as `activeCodeMapNodes`
 * right below — deliberately, not two separate assignments at two different
 * call sites (review finding, High): `handleGetCodeMapRequest` used to
 * assign `activeCodeMapEdges` synchronously right after its own
 * `fetchCodeMap` call, while `activeCodeMapNodes` was only ever (re)assigned
 * here, after that caller's own `await loadLcovCoverage(...)`. That gap was
 * a real window — same project, so neither the `activeProjectPath` guard nor
 * a plain refetch's unchanged `activeSummaryGenerationId` would catch it —
 * during which `activeCodeMapEdges` reflected a fresh fetch while
 * `activeCodeMapNodes` still reflected the previous one; an
 * `expandBlastRadius` request landing in that window would silently compute
 * against a mismatched nodes/edges pair. Setting both fields in this one
 * function, back to back with no `await` between them, closes that window
 * entirely — see `activeCodeMapEdges`'s own doc comment for the "mirrors
 * `activeCodeMapNodes`'s exact lifecycle" invariant this restores.
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
 *    alongside indexing under Local, Story 1.5 Phase 1) to settle before
 *    generation can start. P5-c review round 1: it joins the attempt in
 *    flight at the moment this function runs (`joinModelAttempt`) and never
 *    starts one; a Cloud→Local switch starts it in
 *    `handleBackendSwitchedRequest`. With no attempt and no model (one
 *    failed), generation is skipped — same "no silent fallback" reasoning,
 *    mirrored for the local side — until an explicit trigger downloads.
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
async function startSummaryGenerationForProject(
  nodes: CodeMapNode[],
  edges: CodeMapEdge[],
  // P4-2 phase 3a: cached with `nodes`/`edges`. A fresh Code Map fetch
  // passes its own; a re-kick of generation over the cached map passes the
  // cached `activeFoldedModules`.
  foldedModules: FoldedModule[],
  // P4-2 phase 3b: cached with them, the same way.
  foldedTypes: FoldedType[],
  // P4-4 phase 1a: the raw fetch these were built from, cached with them the
  // same way (`activeRawCodeMap`).
  rawCodeMap: ActiveRawCodeMap | undefined,
): Promise<void> {
  const generationId = activeSummaryGenerationId;
  const projectRoot = activeProjectPath;
  const gapFiles = coverageGapFileSet;
  const backendConfig = activeBackendConfig;

  // P4-7c: a different map (any fresh fetch) drops the whole-scope listing
  // memoized from the previous one; a re-kick over the same arrays keeps it.
  if (nodes !== activeCodeMapNodes || edges !== activeCodeMapEdges) {
    activeEntryCandidates = undefined;
  }
  // Set together, same synchronous tick, no `await` between them — see this
  // function's own doc comment for the race condition this atomicity fixes.
  activeCodeMapNodes = nodes;
  activeCodeMapEdges = edges;
  activeFoldedModules = foldedModules;
  activeFoldedTypes = foldedTypes;
  // Review round 1: never a fetch from before the latest index started (or
  // for another project) — see `activeRawCodeMap`.
  const nextRawCodeMap = rawCodeMap !== undefined && isCurrentRawCodeMap(rawCodeMap) ? rawCodeMap : undefined;
  // P4-4 phase 2b: a replaced (or cleared) raw cache drops the section
  // builds made from it, in this same tick. A re-kick that re-caches the
  // same object (backend switch, model retry) keeps them: same raw, same builds.
  if (nextRawCodeMap !== activeRawCodeMap) {
    sectionCodeMapMemo = undefined;
    // P4-7c: the section listings go with it, the same way.
    entryCandidatesSectionMemo = undefined;
  }
  activeRawCodeMap = nextRawCodeMap;
  // P4-7g review round 1: a new whole-scope map for the project (the fetch
  // after an index, or a refetch) reports the pins not on it, so main logs a
  // missing pin even when no listing is asked for.
  if (nextRawCodeMap !== undefined && projectRoot !== undefined) {
    reportMissingEntryPins(projectRoot, nodes);
  }

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
      // P5-c review round 1: joins an attempt in flight, never starts one —
      // see `joinModelAttempt`. A failure is already reported via
      // `graphService:modelStatus` 'error' and leaves `localModelReady` unset.
      await joinModelAttempt();
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
  lastStartedGenerationRuns.judgment = generationId;

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
      // P5-c review round 1: joins only — see `joinModelAttempt`.
      await joinModelAttempt();
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
 * the caller's perspective (`handleGetCodeMapRequest` never awaits this; P5-b:
 * only on its fetch path, plus `rekickGenerationOverCachedMap` after a
 * backend switch or re-affirm) —
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
  lastStartedGenerationRuns.staleness = generationId;

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
 * P5-b review round 1: re-kicks every generation run over the cached map
 * after a bump of `activeSummaryGenerationId` that is not an index
 * (`handleBackendSwitchedRequest`'s two branches). The bump supersedes the
 * running summary, judgment AND staleness runs, so all three restart here:
 * since P5-b the renderer's refetch after a backend switch is served from the
 * raw cache and kicks nothing, so a run left superseded here would never
 * restart (e.g. Cloud with no key → key saved → summaries generate, judgments
 * never do). Same cached arrays and raw cache, so no memo is dropped.
 */
function rekickGenerationOverCachedMap(nodes: CodeMapNode[], edges: CodeMapEdge[]): void {
  void startSummaryGenerationForProject(nodes, edges, activeFoldedModules ?? [], activeFoldedTypes ?? [], activeRawCodeMap);
  void startJudgmentGenerationForProject(nodes);
  if (activeProjectPath !== undefined) {
    void startStalenessDetectionForProject(activeProjectPath, nodes);
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
  // (local<->cloud) from a same-value re-affirmation (`backendSwitchKind`,
  // backend-switch.ts). main's P2-6 key-change relay (key-change-relay.ts,
  // posted after a key save or removal while cloud is already active)
  // reuses this exact relay path with `activeBackend` unchanged — without
  // this comparison, that relay would silently wipe every already-successful
  // summary just to retry the Nodes that were genuinely blocked, spending
  // real Anthropic API calls regenerating summaries that already existed.
  const previousBackend = activeBackendConfig.activeBackend;
  activeBackendConfig = nextBackendConfig(backendConfig);
  // P5-c: a genuine switch to Local with a project open is a first need of
  // the local model — start (or join) the download here, before the early
  // return below, so a switch before the first map lands still downloads.
  // The restarted runs then join it (`joinModelAttempt`). With no project
  // open nothing is pre-downloaded (Ask First).
  if (
    backendSwitchKind(previousBackend, activeBackendConfig.activeBackend) === 'switch' &&
    activeBackendConfig.activeBackend === 'local' &&
    activeIndexPath !== null
  ) {
    void kickOffModelDownload();
  }
  const nodes = activeCodeMapNodes;
  // Story 3.2 (Phase 1): `activeCodeMapEdges` is captured alongside
  // `activeCodeMapNodes` here too — the two are always set together (see
  // `startSummaryGenerationForProject`'s own doc comment), so `edges` is
  // guaranteed defined whenever `nodes` is; the explicit `!edges` check
  // below only makes that existing invariant visible to the type checker,
  // same as `handleGetCodeMapRequest`'s own combined-guard precedent.
  const edges = activeCodeMapEdges;
  if (!nodes || nodes.length === 0 || !edges) {
    return;
  }

  if (backendSwitchKind(previousBackend, backendConfig.activeBackend) === 'reaffirm') {
    // Same backend re-affirmed (the key-change relay, or any other
    // same-value call) — never clears (Boundaries & Constraints: "A backend
    // switch ... clears the current project's persisted summaries" only
    // applies to an actual switch). Just re-kicks generation:
    // `generateSummaries`'s own eligibility filter (`classifyNode`) already
    // only attempts Nodes still `'pending'` per the record store, so
    // already-successful summaries are left untouched and only
    // genuinely-blocked/pending Nodes (e.g. blocked on a missing key that
    // now exists) are retried.
    activeSummaryGenerationId += 1;
    // P5-b review round 1: judgment and staleness too (see the helper).
    rekickGenerationOverCachedMap(nodes, edges);
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
  // P5-b review round 1: judgment and staleness too (see the helper).
  rekickGenerationOverCachedMap(nodes, edges);
}

process.parentPort?.on('message', (event) => {
  if (isShutdownRequest(event.data)) {
    shutdown(event.data.stopCbmDaemon === true);
    return;
  }
  if (!isShuttingDown && isGetCodeMapRequest(event.data)) {
    void handleGetCodeMapRequest(event.data.section, event.data.force === true);
    return;
  }
  if (!isShuttingDown && isMalformedGetCodeMapRequest(event.data)) {
    postCodeMapMessage({ type: 'graphService:codeMapError', message: 'Invalid section.' });
    return;
  }
  if (!isShuttingDown && isPathTraceRequest(event.data)) {
    // Fire-and-forget from the message handler's perspective, same as every
    // other branch here — `handlePathTraceRequest` posts its own
    // `graphService:pathTraceResult` reply asynchronously and never throws.
    void handlePathTraceRequest(event.data.query, event.data.requestId, event.data.section);
    return;
  }
  if (!isShuttingDown && isMalformedSectionRequest(event.data, isPathTraceRequest)) {
    const { requestId } = event.data as GraphServicePathTraceRequest;
    postPathTraceResultMessage({ type: 'graphService:pathTraceResult', requestId, result: INVALID_SECTION_RESULT });
    return;
  }
  if (!isShuttingDown && isRetryModelRequest(event.data)) {
    handleRetryModelRequest();
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
  if (!isShuttingDown && isComputeDiffScopeRequest(event.data)) {
    // Fire-and-forget from the message handler's perspective, same as every
    // other branch here — `handleComputeDiffScopeRequest` posts its own
    // `graphService:computeDiffScopeResult` reply asynchronously and never
    // throws (its own top-level try/catch guarantees that).
    void handleComputeDiffScopeRequest(
      event.data.projectPath,
      event.data.baseRef,
      event.data.requestId,
      event.data.section,
    );
    return;
  }
  if (!isShuttingDown && isMalformedSectionRequest(event.data, isComputeDiffScopeRequest)) {
    const { projectPath, requestId } = event.data as GraphServiceComputeDiffScopeRequest;
    postComputeDiffScopeResultMessage({
      type: 'graphService:computeDiffScopeResult',
      projectPath,
      requestId,
      result: INVALID_SECTION_RESULT,
    });
    return;
  }
  if (!isShuttingDown && isDiffScopeCarryRequest(event.data)) {
    // P4-4 phase 3b: posts its own reply; never throws.
    void handleDiffScopeCarryRequest(event.data);
    return;
  }
  if (!isShuttingDown && isExpandBlastRadiusRequest(event.data)) {
    // Fire-and-forget from the message handler's perspective, same as every
    // other branch here — `handleExpandBlastRadiusRequest` posts its own
    // `graphService:expandBlastRadiusResult` reply asynchronously and never
    // throws (its own top-level try/catch guarantees that).
    void handleExpandBlastRadiusRequest(
      event.data.projectPath,
      event.data.nodeIds,
      event.data.requestId,
      event.data.section,
    );
    return;
  }
  if (!isShuttingDown && isMalformedSectionRequest(event.data, isExpandBlastRadiusRequest)) {
    const { projectPath, requestId } = event.data as GraphServiceExpandBlastRadiusRequest;
    postExpandBlastRadiusResultMessage({
      type: 'graphService:expandBlastRadiusResult',
      projectPath,
      requestId,
      result: INVALID_SECTION_RESULT,
    });
    return;
  }
  if (!isShuttingDown && isListEntryCandidatesRequest(event.data)) {
    // P4-7c: answered synchronously from the memo (or one lazy listing).
    handleListEntryCandidatesRequest(event.data.projectPath, event.data.requestId, event.data.section);
    return;
  }
  if (!isShuttingDown && isMalformedSectionRequest(event.data, isListEntryCandidatesRequest)) {
    const { projectPath, requestId } = event.data as GraphServiceListEntryCandidatesRequest;
    postListEntryCandidatesResultMessage({
      type: 'graphService:listEntryCandidatesResult',
      projectPath,
      requestId,
      section: null,
      result: INVALID_SECTION_RESULT,
    });
    return;
  }
  if (!isShuttingDown && isIndexRequest(event.data)) {
    if (event.data.path === activeIndexPath && activeIndexInFlight) {
      // Already indexing this exact project — e.g. a Retry click while the
      // first attempt is still running. A second concurrent call against
      // the same project is pure waste (and, on this backend, would just
      // collide with the first), so ignore it rather than racing it.
      //
      // Bug fix (2026-09-23): `activeIndexInFlight` is the load-bearing half
      // of this check now — `activeIndexPath` alone never resets, so a
      // Retry click after a FAILED attempt for this same project used to be
      // silently dropped forever (this comment's own "still running" premise
      // was false by the time Retry was clicked). See `activeIndexInFlight`'s
      // own declaration comment.
      return;
    }
    // Fire-and-forget from the message handler's perspective: progress is
    // reported asynchronously via postStatus, not this handler's return.
    activeIndexRequest = handleIndexRequest(
      event.data.path,
      {
        activeBackend: event.data.activeBackend,
        cloudApiKey: event.data.cloudApiKey,
      },
      event.data.includedPaths ?? [],
      sanitizeEntryPins((event.data as { entryPins?: unknown }).entryPins),
    );
    return;
  }
  if (!isShuttingDown && isCheckHeadRequest(event.data)) {
    // P5-a: posts `headChanged` only on drift; never throws.
    void handleCheckHeadRequest(event.data.path);
    return;
  }
  if (!isShuttingDown && isSetEntryPinsRequest(event.data)) {
    // P4-7g: synchronous on receipt, so a listing main relays after it
    // ranks the new pins.
    handleSetEntryPinsRequest(event.data.projectPath, event.data.pinnedIds);
    return;
  }
  if (!isShuttingDown && isScopeChangedRequest(event.data)) {
    handleScopeChangedRequest(event.data.path, [...event.data.includedPaths]);
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

// A bare SIGTERM (not the `graphService:shutdown` message above) means this
// subprocess is being killed directly rather than asked to restart — main
// never sends SIGTERM for a mid-session `forceRespawn` (it posts a message
// and waits), so this always corresponds to an app quit/external kill, not
// a same-session restart. `stopCbm: true` accordingly.
process.on('SIGTERM', () => shutdown(true));

postStatus({ state: 'alive', pid: process.pid, at: now() });
