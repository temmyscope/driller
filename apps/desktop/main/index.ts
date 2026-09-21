/**
 * Electron main process entry point.
 *
 * Per ARCHITECTURE-SPINE.md, main is a thin orchestration shell: window
 * lifecycle, IPC routing, settings persistence, and Graph Service
 * subprocess spawn/teardown. It owns no domain logic — indexing lives in
 * services/graph-service (AD-1).
 *
 * Security baseline (AD-11): every BrowserWindow sets
 * contextIsolation: true / nodeIntegration: false, with sandbox enabled;
 * renderer reaches this process only through the contextBridge-exposed
 * preload API.
 */

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import started from 'electron-squirrel-startup';
import {
  IpcChannels,
  type BackendConfig,
  type BlastRadiusExpansionResult,
  type CodeMapResult,
  type DiagnosticLogEntry,
  type DiffScopeResult,
  type EditorPreference,
  type GitDetectionResult,
  type GraphServiceBackendSwitchedRequest,
  type GraphServiceCodeMapMessage,
  type GraphServiceComputeDiffScopeRequest,
  type GraphServiceComputeDiffScopeResultMessage,
  type GraphServiceExpandBlastRadiusRequest,
  type GraphServiceExpandBlastRadiusResultMessage,
  type GraphServiceGetCodeMapRequest,
  type GraphServiceIndexRequest,
  type GraphServicePathTraceRequest,
  type GraphServicePathTraceResultMessage,
  type GraphServiceRegenerateNodeRequest,
  type GraphServiceRegenerateNodeResultMessage,
  type GraphServiceRunIngestionRequest,
  type GraphServiceRunIngestionResultMessage,
  type GraphServiceStatusMessage,
  type HardwareAdvisoryMessage,
  type LlmJudgmentProgressMessage,
  type ModelStatusMessage,
  type OpenInEditorResult,
  type PathTraceResult,
  type PrBotConfig,
  type PrBotId,
  type PrBotIngestionResult,
  type ProjectOpenResult,
  type ReadSourceRangeResult,
  type RegenerateNodeResult,
  type SetCloudApiKeyResult,
  type SummaryProgressMessage,
} from '@driller/ipc-contracts';
import {
  getBackendConfig,
  getDecryptedCloudApiKey,
  setActiveBackend,
  setCloudApiKey,
} from './backend-settings';
import { appendDiagnosticLogEntry } from './diagnostic-log';
import { getEditorPreference, setEditorPreference } from './editor-settings';
import { detectGitRepo } from './git-detect';
import { getPrBotConfig, setPrBotEnabled } from './pr-bot-settings';
import { listRecentProjects, recordProjectOpened } from './settings';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let graphService: UtilityProcess | null = null;
// Set while teardownGraphService is deliberately stopping the subprocess
// (app quit, or a future explicit stop) so its 'exit' handler can tell a
// requested shutdown apart from a real crash.
let isGraphServiceShuttingDown = false;
// The most recently confirmed-opened project's path, so a manual Graph
// Service restart (e.g. after a "codebase-memory-mcp failed to start"
// error) can re-send the index request without requiring the user to
// re-pick the folder.
let currentProjectPath: string | null = null;
// Resolver + shared Promise for an in-flight `codeMap:get` renderer request
// (Story 1.3): `requestCodeMap` posts a fire-and-forget `graphService:
// getCodeMap` message to the subprocess (there is no invoke-style round
// trip over `utilityProcess.postMessage`); `pendingCodeMapResolve` is what
// turns the subprocess's eventual `graphService:codeMap`/
// `graphService:codeMapError` reply back into the `ipcMain.handle` Promise
// the renderer is awaiting. `pendingCodeMapPromise` is handed to a second
// overlapping caller (e.g. a fast double-click on Retry) so it shares the
// one in-flight result instead of getting an immediate, spurious "already
// in progress" failure (review finding).
let pendingCodeMapResolve: ((result: CodeMapResult) => void) | null = null;
let pendingCodeMapPromise: Promise<CodeMapResult> | null = null;

// A pure backstop, slightly exceeding `fetchCodeMap`'s own internal timeout
// (mcp-client.ts's `DEFAULT_TIMEOUT_MS`, 30 minutes) — for a hang that
// occurs BEFORE `fetchCodeMap` even starts (a lost `postMessage`, or a bug
// in the Graph Service's own message routing), which that internal timeout
// can never catch since it only wraps the MCP call itself. Not expected to
// fire under normal operation (review finding: without this, such a hang
// left the renderer's `getCodeMap()` promise unsettled forever, contradicting
// `requestCodeMap`'s own doc comment that it "rejects nothing... never
// hanging").
const CODE_MAP_REQUEST_TIMEOUT_MS = 30 * 60 * 1000 + 10_000;

// Story 1.8 (Phase 4): a dedicated, much shorter backstop than
// `CODE_MAP_REQUEST_TIMEOUT_MS` (sized for a whole-project fetch) — a
// single-Node regenerate call is bounded by summary-generator.ts's own
// per-Node `SUMMARY_PROMPT_TIMEOUT_MS` (2 min, local backend) / cloud-
// summary-generator.ts's `CLOUD_SUMMARY_TIMEOUT_MS` (3 min, cloud backend)
// call timeouts. Those constants are mirrored here rather than imported —
// main never imports the Graph Service's own subprocess-only modules (it
// only ever talks to that process over `postMessage`), and this codebase's
// own established precedent (see those two modules' own duplicated
// `withTimeout` helpers) is to mirror small cross-module constants with an
// explaining comment rather than force a shared import across this process
// boundary.
//
// Doubled (review round 2) rather than used as-is: `regenerateNodeSummary`
// enqueues at `{priority: 1}`, so it jumps ahead of every `generateSummaries`
// batch job still *waiting* in the shared queue — but priority can't preempt
// a job the queue has already dequeued and started running (concurrency is
// fixed at 1), so a regenerate call can still sit behind up to one
// already-in-flight job of the same worst-case (cloud) duration before its
// own `summarize()` call even starts. Sized for that one-job-ahead-plus-
// its-own-attempt worst case, plus a small margin — comfortably short of
// `CODE_MAP_REQUEST_TIMEOUT_MS`, but no longer prone to firing prematurely
// while a whole-project batch is still in progress (the false "timed out"
// report review round 2 found: main would give up and report an error while
// the Graph Service job kept running and eventually still persisted via
// `mergeNodeRecord`, with its late reply then silently discarded since
// `settlePendingRegenerateRequest` had nothing left to settle).
const REGENERATE_NODE_TIMEOUT_MS = 2 * (3 * 60 * 1000) + 10_000;

// Story 1.8 (Phase 4): correlates each in-flight `node:regenerate` request
// to its eventual Graph Service reply — a generalized, id-keyed version of
// `pendingCodeMapResolve`'s single slot (Design Notes: "this app's first
// id-keyed *mutating* IPC request/reply pattern"). Settled by whichever
// comes first: the 'message' handler below (a genuine
// `graphService:regenerateNodeResult` reply for that `nodeId`), the 'exit'
// handler (the subprocess died mid-request — every still-pending entry is
// settled, not just one), or that request's own per-nodeId timeout timer
// (`REGENERATE_NODE_TIMEOUT_MS`'s backstop — Spec Change Log Round 1,
// re-sized in review round 2). `reject` is provided for a well-formed
// `Promise` executor but is never actually invoked — like `requestCodeMap`,
// every failure path resolves to an explicit `{status: 'error', ...}`
// result rather than rejecting.
const pendingRegenerateResolvers = new Map<
  string,
  { resolve: (result: RegenerateNodeResult) => void; reject: (error: unknown) => void }
>();

// Story 2.3 (Phase 2): correlates each in-flight `prBot:runIngestion`
// request to its eventual Graph Service reply — the same id-keyed `Map`
// shape `pendingRegenerateResolvers` establishes above, keyed by `bot`
// instead of `nodeId` (there's no Node id here; `bot` plays the identical
// "what would otherwise collide on a shared single slot" role). Settled by
// whichever comes first: the 'message' handler below (a genuine
// `graphService:runIngestionResult` reply for that `bot`), the 'exit'
// handler (the subprocess died mid-request), or that request's own timeout
// backstop (`INGESTION_REQUEST_TIMEOUT_MS`). Key type widens from the
// literal `'codeRabbit'` to the full `PrBotId` union in Story 2.3 (Phase 3),
// now that Qodo/PR-Agent ingestion exists alongside CodeRabbit's.
const pendingIngestionResolvers = new Map<
  PrBotId,
  { resolve: (result: PrBotIngestionResult) => void; reject: (error: unknown) => void }
>();

// An ingestion pass shells out to `cr review --base <branch> --agent`, which
// itself sends code to CodeRabbit's own vendor cloud to review (Epic 2
// Context: "transmit diff/code content to their own vendor clouds") — this
// can genuinely take minutes for a real repo, unlike every other IPC round
// trip in this file. Sized generously (well past a single-Node regenerate
// call's own budget) rather than reusing `REGENERATE_NODE_TIMEOUT_MS` or
// `CODE_MAP_REQUEST_TIMEOUT_MS` outright — `cr`'s real-world latency is
// unverified in this environment (the CLI isn't installed here; Design
// Notes), so this value is a reasonable engineering guess pending real-world
// calibration, not a spec-mandated figure.
const INGESTION_REQUEST_TIMEOUT_MS = 10 * 60 * 1000 + 10_000;

// Story 3.1 (Phase 1): correlates each in-flight `diffScope:compute` request
// to its eventual Graph Service reply — the same id-keyed `Map` shape
// `pendingIngestionResolvers` establishes above, keyed by `projectPath`
// instead of `bot` (there's no bot/nodeId equivalent here; `projectPath` is
// the one natural id `computeDiffScope`'s own `(projectPath, baseRef)`
// signature carries, and is what the spec's "single-flight guard... for the
// same project" wording keys on). Settled by whichever comes first: the
// 'message' handler below (a genuine `graphService:computeDiffScopeResult`
// reply for that `projectPath`), the 'exit' handler (the subprocess died
// mid-request), or that request's own timeout backstop
// (`DIFF_SCOPE_REQUEST_TIMEOUT_MS`).
//
// Each entry also carries the `requestId` that was sent with it (review
// finding, Blind Hunter): keying by `projectPath` alone leaves a genuine
// stale-reply window — if a request times out and its entry is cleared, a
// *new* request for the same `projectPath` can be issued before the
// abandoned request's late reply finally arrives. `settlePendingDiffScopeRequest`
// checks the reply's own `requestId` against the current entry's before
// applying it, so a late reply from an abandoned request is discarded
// rather than incorrectly settling a newer one.
const pendingDiffScopeResolvers = new Map<
  string,
  { requestId: number; resolve: (result: DiffScopeResult) => void; reject: (error: unknown) => void }
>();

// Minted fresh for every `requestComputeDiffScope` call — see
// `pendingDiffScopeResolvers`'s own doc comment for the stale-reply race it
// closes.
let nextDiffScopeRequestId = 0;

// Unlike `cr`'s own PR-bot ingestion (which shells out to a vendor cloud and
// can genuinely take minutes), `computeDiffScope` only ever runs local `git
// merge-base`/`git diff` subprocess calls, now bounded to
// `GIT_SUBPROCESS_TIMEOUT_MS` each (20s, `services/graph-service/
// git-diff-scope.ts` — review finding, Blind Hunter + Edge Case Hunter) —
// sized generously past this outer, now-properly-bounded worst case (well
// under `INGESTION_REQUEST_TIMEOUT_MS`'s cloud-call sizing) so a genuine
// hang is still caught promptly rather than leaving the caller waiting
// minutes for what should be a sub-second local operation.
const DIFF_SCOPE_REQUEST_TIMEOUT_MS = 60 * 1000 + 10_000;

// Story 3.2 (Phase 1): correlates each in-flight `blastRadius:expand`
// request to its eventual Graph Service reply — mirrors
// `pendingDiffScopeResolvers`'s exact shape (an id-keyed `Map`, keyed by
// `projectPath` for the same "no bot/nodeId-equivalent id" reasoning, plus
// the same `requestId` stale-reply-window fix). Settled by whichever comes
// first: the 'message' handler below (a genuine
// `graphService:expandBlastRadiusResult` reply for that `projectPath`), the
// 'exit' handler (the subprocess died mid-request), or that request's own
// timeout backstop (`BLAST_RADIUS_REQUEST_TIMEOUT_MS`).
const pendingBlastRadiusResolvers = new Map<
  string,
  { requestId: number; resolve: (result: BlastRadiusExpansionResult) => void; reject: (error: unknown) => void }
>();

// Minted fresh for every `requestExpandBlastRadius` call — see
// `pendingBlastRadiusResolvers`'s own doc comment for the stale-reply race
// it closes.
let nextBlastRadiusRequestId = 0;

// The blast-radius expansion computation itself is a synchronous, no-I/O
// BFS in the Graph Service subprocess (`@driller/graph-contracts`'s
// `computeBlastRadiusHopDistances`) over data it already has cached — no
// git/vendor-cloud subprocess call like `computeDiffScope`'s own timeout
// sizing has to account for. Still sized generously past a genuine worst
// case (a very large graph, plus normal IPC/scheduling latency) rather than
// tightly, so a real hang is still caught promptly without risking a false
// timeout under load — same sizing philosophy `DIFF_SCOPE_REQUEST_TIMEOUT_MS`
// documents for its own (larger) worst case.
const BLAST_RADIUS_REQUEST_TIMEOUT_MS = 30 * 1000 + 10_000;

// Story 1.9 (Phase 1): a single-slot resolver for an in-flight `path:trace`
// request, mirroring `pendingCodeMapResolve`'s own single-slot shape rather
// than `pendingRegenerateResolvers`'s id-keyed Map — `requestPathTrace` has
// no natural id to key overlapping calls by the way a Node's `nodeId` does
// (two different queries in flight at once would need one slot each). Unlike
// `pendingCodeMapResolve`, a second overlapping call is never given a shared
// promise either (that's only safe for `requestCodeMap` because every caller
// wants the exact same code map back) — a different query in flight would
// get the wrong result if it shared this slot, so `requestPathTrace` instead
// rejects a second concurrent call outright with an explicit error, same
// spirit as `requestRegenerateNode`'s per-nodeId "already in progress" guard.
let pendingPathTraceResolve: ((result: PathTraceResult) => void) | null = null;

// Monotonic counter for `pendingPathTraceToken` below (Spec Change Log,
// post-review hardening) — every `requestPathTrace` call bumps this and
// captures its own value.
let pathTraceRequestToken = 0;

// The token (see `pathTraceRequestToken`) of whichever request currently
// owns `pendingPathTraceResolve`'s single slot, or `null` when nothing is
// pending. This is what closes a real stale/late-reply race the single-slot
// design alone doesn't handle: request A starts (token 1), times out —
// `settlePendingPathTraceRequest` resolves A's promise with a timeout error
// and frees the slot. Request B then starts (token 2), claiming the now-free
// slot. A's *original* subprocess-side call was never actually cancelable
// (MCP calls aren't cancelable mid-flight, same limitation
// `services/graph-service/index.ts`'s module doc comment already notes for
// indexing) and can still eventually reply — when that late
// `graphService:pathTraceResult` reply for token 1 arrives, comparing its
// echoed `requestId` (ipc-contracts's `GraphServicePathTraceRequest.
// requestId`/`GraphServicePathTraceResultMessage.requestId`) against this
// variable (now 2) is what lets `settlePendingPathTraceRequest` recognize
// it's stale and discard it, rather than misattributing A's result to B's
// still-pending promise. Every settle call site (timeout, the subprocess's
// own error/message-handler reply, `postMessage` throwing) goes through
// `settlePendingPathTraceRequest` with its own request's token, mirroring
// the snapshot-and-compare shape `services/graph-service/index.ts`'s own
// `activeSummaryGenerationId` uses for the same class of staleness problem
// (a slow, non-cancelable async result completing after something newer has
// superseded it). The one exception is the Graph Service subprocess exiting
// entirely (see the `'exit'` handler below) — that settles whatever is
// currently pending unconditionally, since no reply for ANY token will ever
// arrive once the subprocess is gone.
let pendingPathTraceToken: number | null = null;

// ---------------------------------------------------------------------------
// Graph Service subprocess (AD-1): spawned via `utilityProcess.fork`, never
// `child_process.fork` or inline indexing work in main. This story only
// establishes the process boundary and the alive/status handshake.
// ---------------------------------------------------------------------------

function sendGraphServiceStatus(status: GraphServiceStatusMessage): void {
  // A Graph Service status event can arrive after the window's webContents
  // was torn down during quit; guard against sending into a destroyed
  // WebContents, which would throw.
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.graphServiceStatus, status);
  }
}

/**
 * Relays a local-model download/verify status (Story 1.5 Phase 1, AD-18) to
 * the renderer — same destroyed-webContents guard as
 * `sendGraphServiceStatus`, and deliberately a separate channel/stream from
 * it (see `ModelStatusMessage`'s doc comment) since the two run in parallel
 * and either can fail independently of the other.
 */
function sendModelStatus(status: ModelStatusMessage): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.modelStatus, status);
  }
}

/**
 * Relays batched summary-generation progress (Story 1.5 Phase 2, AD-8) to
 * the renderer — same destroyed-webContents guard and same "own channel,
 * distinguished by `type`" pattern as `sendModelStatus`.
 */
function sendSummaryProgress(message: SummaryProgressMessage): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.summaryProgress, message);
  }
}

/**
 * Relays batched LLM-judgment generation progress (Story 2.2, Phase 2, AD-8)
 * to the renderer — same destroyed-webContents guard and "own channel,
 * distinguished by `type`" pattern as `sendModelStatus`/`sendSummaryProgress`.
 * No renderer subscriber consumes this yet (Phase 3's job).
 */
function sendLlmJudgmentProgress(message: LlmJudgmentProgressMessage): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.llmJudgmentProgress, message);
  }
}

/**
 * Relays the hardware-adequacy advisory (Story 1.5 Phase 3) to the renderer
 * — same destroyed-webContents guard and "own channel" pattern as
 * `sendModelStatus`/`sendSummaryProgress`.
 */
function sendHardwareAdvisory(message: HardwareAdvisoryMessage): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.hardwareAdvisory, message);
  }
}

/**
 * True for a `graphService:codeMap`/`graphService:codeMapError` reply —
 * distinguished from a `GraphServiceStatusMessage` by `type` rather than
 * `state`, per `ipc-contracts`'s doc comment on `GraphServiceCodeMapMessage`.
 */
function isCodeMapMessage(message: unknown): message is GraphServiceCodeMapMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const type = (message as { type?: unknown }).type;
  return type === 'graphService:codeMap' || type === 'graphService:codeMapError';
}

/**
 * True for a `graphService:regenerateNodeResult` reply (Story 1.8, Phase 4)
 * — distinguished from every other message shape on this same channel by
 * `type`, same convention as `isCodeMapMessage`.
 */
function isRegenerateNodeResultMessage(message: unknown): message is GraphServiceRegenerateNodeResultMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:regenerateNodeResult';
}

/**
 * True for a `graphService:pathTraceResult` reply (Story 1.9, Phase 1) —
 * distinguished from every other message shape on this same channel by
 * `type`, same convention as `isCodeMapMessage`/`isRegenerateNodeResultMessage`.
 */
function isPathTraceResultMessage(message: unknown): message is GraphServicePathTraceResultMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:pathTraceResult';
}

/**
 * True for a `graphService:runIngestionResult` reply (Story 2.3, Phase 2) —
 * distinguished from every other message shape on this same channel by
 * `type`, same convention as `isRegenerateNodeResultMessage`/
 * `isPathTraceResultMessage`.
 */
function isRunIngestionResultMessage(message: unknown): message is GraphServiceRunIngestionResultMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:runIngestionResult';
}

/**
 * True for a `graphService:computeDiffScopeResult` reply (Story 3.1, Phase
 * 1) — distinguished from every other message shape on this same channel by
 * `type`, same convention as `isRunIngestionResultMessage`.
 */
function isComputeDiffScopeResultMessage(
  message: unknown,
): message is GraphServiceComputeDiffScopeResultMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:computeDiffScopeResult';
}

/**
 * True for a `graphService:expandBlastRadiusResult` reply (Story 3.2, Phase
 * 1) — distinguished from every other message shape on this same channel by
 * `type`, same convention as `isComputeDiffScopeResultMessage`.
 */
function isExpandBlastRadiusResultMessage(
  message: unknown,
): message is GraphServiceExpandBlastRadiusResultMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:expandBlastRadiusResult';
}

/**
 * True for a `graphService:modelStatus` post — distinguished from a
 * `GraphServiceStatusMessage` by `type` the same way `isCodeMapMessage` is,
 * since both status unions use overlapping `state` values (e.g. `'error'`).
 */
function isModelStatusMessage(message: unknown): message is ModelStatusMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:modelStatus';
}

/**
 * True for a `graphService:summaryProgress` post — distinguished from the
 * other message shapes on this same `parentPort` channel by `type`, same
 * convention as `isCodeMapMessage`/`isModelStatusMessage`.
 */
function isSummaryProgressMessage(message: unknown): message is SummaryProgressMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:summaryProgress';
}

/**
 * True for a `graphService:llmJudgmentProgress` post (Story 2.2, Phase 2) —
 * distinguished from the other message shapes on this same `parentPort`
 * channel by `type`, same convention as `isSummaryProgressMessage`.
 */
function isLlmJudgmentProgressMessage(message: unknown): message is LlmJudgmentProgressMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:llmJudgmentProgress';
}

/**
 * True for a `graphService:hardwareAdvisory` post — distinguished from the
 * other message shapes on this same `parentPort` channel by `type`, same
 * convention as `isCodeMapMessage`/`isModelStatusMessage`/
 * `isSummaryProgressMessage`.
 */
function isHardwareAdvisoryMessage(message: unknown): message is HardwareAdvisoryMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === 'graphService:hardwareAdvisory';
}

/**
 * Settles the currently pending `codeMap:get` request (if any) with an
 * explicit error result — used both when the subprocess itself reports
 * `graphService:codeMapError` and when it exits/crashes with a request
 * still outstanding. Without the latter, a Graph Service crash mid-fetch
 * would leave the renderer's `getCodeMap()` promise hanging forever instead
 * of surfacing the matrix's required "explicit error/retry state."
 */
function settlePendingCodeMapRequest(result: CodeMapResult): void {
  const resolve = pendingCodeMapResolve;
  if (!resolve) {
    return;
  }
  pendingCodeMapResolve = null;
  pendingCodeMapPromise = null;
  resolve(result);
}

/**
 * Settles the pending `node:regenerate` request for `nodeId`, if any — used
 * both by a genuine `graphService:regenerateNodeResult` reply and by that
 * request's own timeout backstop (Story 1.8, Phase 4, Spec Change Log Round
 * 1). A no-op if there's no entry for `nodeId` (already settled by whichever
 * of those two fired first, or none was ever made).
 */
function settlePendingRegenerateRequest(nodeId: string, result: RegenerateNodeResult): void {
  const pending = pendingRegenerateResolvers.get(nodeId);
  if (!pending) {
    return;
  }
  pendingRegenerateResolvers.delete(nodeId);
  pending.resolve(result);
}

/**
 * Settles EVERY still-pending `node:regenerate` request with an explicit
 * error — used when the Graph Service subprocess exits with one or more
 * regenerate requests outstanding (Always: "settling every still-pending
 * entry with an error result if the Graph Service subprocess exits
 * mid-request"). Without this, a subprocess crash mid-regenerate would leave
 * the renderer's `regenerateNode()` promise(s) hanging forever, exactly the
 * failure `settlePendingCodeMapRequest`'s own 'exit' handling already
 * guards against for the read-only Code Map fetch.
 */
function settleAllPendingRegenerateRequests(message: string): void {
  for (const [nodeId, pending] of pendingRegenerateResolvers) {
    pendingRegenerateResolvers.delete(nodeId);
    pending.resolve({ status: 'error', message });
  }
}

/**
 * Settles the pending `prBot:runIngestion` request for `bot`, if any (Story
 * 2.3, Phase 2) — used both by a genuine `graphService:runIngestionResult`
 * reply and by that request's own timeout backstop, mirroring
 * `settlePendingRegenerateRequest`'s exact shape (keyed by `bot` instead of
 * `nodeId`). A no-op if there's no entry for `bot` (already settled by
 * whichever of those two fired first, or none was ever made).
 */
function settlePendingIngestionRequest(bot: PrBotId, result: PrBotIngestionResult): void {
  const pending = pendingIngestionResolvers.get(bot);
  if (!pending) {
    return;
  }
  pendingIngestionResolvers.delete(bot);
  pending.resolve(result);
}

/**
 * Settles EVERY still-pending `prBot:runIngestion` request with an explicit
 * error — used when the Graph Service subprocess exits with one or more
 * ingestion requests outstanding, mirroring
 * `settleAllPendingRegenerateRequests`'s exact reasoning.
 */
function settleAllPendingIngestionRequests(message: string): void {
  for (const [bot, pending] of pendingIngestionResolvers) {
    pendingIngestionResolvers.delete(bot);
    pending.resolve({ status: 'error', message });
  }
}

/**
 * Settles the pending `diffScope:compute` request for `projectPath`, if any
 * (Story 3.1, Phase 1) — used both by a genuine
 * `graphService:computeDiffScopeResult` reply and by that request's own
 * timeout backstop, mirroring `settlePendingIngestionRequest`'s exact shape
 * (keyed by `projectPath` instead of `bot`). A no-op if there's no entry for
 * `projectPath` (already settled by whichever of those two fired first, or
 * none was ever made).
 *
 * `requestId` (review finding, Blind Hunter): when provided (the message
 * handler's own call, for a genuine reply), only settles if it matches the
 * CURRENT entry's own `requestId` — a mismatch means this is a stale reply
 * from an already-abandoned request (its own entry was already cleared by
 * its timeout, and a newer request has since taken this `projectPath`'s
 * slot), discarded rather than incorrectly settling the newer request's
 * promise. Omitted by the timeout backstop and the exit-handler's
 * settle-all (`settleAllPendingDiffScopeRequests`) — both are unconditional
 * "give up on whatever's here" callers, not reacting to a specific reply,
 * and are never reachable concurrently with a second request for the same
 * `projectPath` in the first place (`requestComputeDiffScope`'s own
 * single-flight guard).
 */
function settlePendingDiffScopeRequest(projectPath: string, result: DiffScopeResult, requestId?: number): void {
  const pending = pendingDiffScopeResolvers.get(projectPath);
  if (!pending) {
    return;
  }
  if (requestId !== undefined && pending.requestId !== requestId) {
    return;
  }
  pendingDiffScopeResolvers.delete(projectPath);
  pending.resolve(result);
}

/**
 * Settles EVERY still-pending `diffScope:compute` request with an explicit
 * error — used when the Graph Service subprocess exits with one or more
 * diff-scope requests outstanding, mirroring
 * `settleAllPendingIngestionRequests`'s exact reasoning.
 */
function settleAllPendingDiffScopeRequests(message: string): void {
  for (const [projectPath, pending] of pendingDiffScopeResolvers) {
    pendingDiffScopeResolvers.delete(projectPath);
    pending.resolve({ status: 'error', message });
  }
}

/**
 * Settles the pending `blastRadius:expand` request for `projectPath`, if any
 * (Story 3.2, Phase 1) — mirrors `settlePendingDiffScopeRequest`'s exact
 * shape and the same `requestId` stale-reply-window reasoning (a mismatch
 * means this is a stale reply from an already-abandoned request, discarded
 * rather than incorrectly settling a newer request's promise). Omitted by
 * the timeout backstop and the exit-handler's settle-all
 * (`settleAllPendingBlastRadiusRequests`), same reasoning as
 * `settlePendingDiffScopeRequest`'s own omitted-`requestId` callers.
 */
function settlePendingBlastRadiusRequest(
  projectPath: string,
  result: BlastRadiusExpansionResult,
  requestId?: number,
): void {
  const pending = pendingBlastRadiusResolvers.get(projectPath);
  if (!pending) {
    return;
  }
  if (requestId !== undefined && pending.requestId !== requestId) {
    return;
  }
  pendingBlastRadiusResolvers.delete(projectPath);
  pending.resolve(result);
}

/**
 * Settles EVERY still-pending `blastRadius:expand` request with an explicit
 * error — used when the Graph Service subprocess exits with one or more
 * blast-radius requests outstanding, mirroring
 * `settleAllPendingDiffScopeRequests`'s exact reasoning.
 */
function settleAllPendingBlastRadiusRequests(message: string): void {
  for (const [projectPath, pending] of pendingBlastRadiusResolvers) {
    pendingBlastRadiusResolvers.delete(projectPath);
    pending.resolve({ status: 'error', message });
  }
}

/**
 * Settles the pending `path:trace` request for `token` (if it's still the
 * one occupying the slot) with an explicit result — used both for a genuine
 * `graphService:pathTraceResult` reply (whose echoed `requestId` becomes
 * `token`) and for that same request's own failure paths (`postMessage`
 * throwing, its timeout backstop firing).
 *
 * A no-op — deliberately discarding `result` — when `token` no longer
 * matches `pendingPathTraceToken`: see that variable's own doc comment for
 * the exact stale/late-reply race this guards against (a request that
 * already timed out and had the slot reassigned to a newer request must
 * never have its late reply resolve that newer request's promise instead).
 */
function settlePendingPathTraceRequest(token: number, result: PathTraceResult): void {
  if (pendingPathTraceResolve === null || token !== pendingPathTraceToken) {
    return;
  }
  const resolve = pendingPathTraceResolve;
  pendingPathTraceResolve = null;
  pendingPathTraceToken = null;
  resolve(result);
}

/**
 * Settles whatever `path:trace` request is currently pending, regardless of
 * its token — used only when the Graph Service subprocess itself exits: no
 * reply, for any token, will ever arrive once the subprocess is gone, so
 * there's no staleness ambiguity left to check for (unlike
 * `settlePendingPathTraceRequest`'s own token comparison, which exists
 * specifically to disambiguate between two requests that could both still
 * be alive).
 */
function settleAnyPendingPathTraceRequest(result: PathTraceResult): void {
  const resolve = pendingPathTraceResolve;
  if (!resolve) {
    return;
  }
  pendingPathTraceResolve = null;
  pendingPathTraceToken = null;
  resolve(result);
}

function spawnGraphService(): void {
  if (graphService) {
    return;
  }

  isGraphServiceShuttingDown = false;
  const modulePath = path.join(__dirname, 'graph-service.js');

  try {
    // The Graph Service subprocess has no runtime access to Electron's
    // `app` module (only `process.parentPort` is real inside a
    // `utilityProcess.fork`ed script) — `app.getPath('userData')` is
    // resolved here, on the main-process side, and passed as the
    // subprocess's first fork argument (`process.argv[2]`, mirroring
    // `child_process.fork`'s own argv convention) so the Node record store
    // and the local-model download/verify machinery (Story 1.5 Phase 1,
    // AD-18/AD-19/AD-20) can persist under the same userData root main
    // itself uses.
    graphService = utilityProcess.fork(modulePath, [app.getPath('userData')], {
      serviceName: 'driller-graph-service',
    });
  } catch (error) {
    graphService = null;
    sendGraphServiceStatus({
      state: 'error',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  graphService.on(
    'message',
    (
      message:
        | GraphServiceStatusMessage
        | GraphServiceCodeMapMessage
        | GraphServiceRegenerateNodeResultMessage
        | GraphServicePathTraceResultMessage
        | GraphServiceRunIngestionResultMessage
        | GraphServiceComputeDiffScopeResultMessage
        | GraphServiceExpandBlastRadiusResultMessage
        | ModelStatusMessage
        | SummaryProgressMessage
        | LlmJudgmentProgressMessage
        | HardwareAdvisoryMessage,
    ) => {
      if (isCodeMapMessage(message)) {
        settlePendingCodeMapRequest(
          message.type === 'graphService:codeMap'
            ? { status: 'ok', nodes: message.nodes, edges: message.edges }
            : { status: 'error', message: message.message },
        );
        return;
      }
      if (isRegenerateNodeResultMessage(message)) {
        settlePendingRegenerateRequest(message.nodeId, message.result);
        return;
      }
      if (isPathTraceResultMessage(message)) {
        settlePendingPathTraceRequest(message.requestId, message.result);
        return;
      }
      if (isRunIngestionResultMessage(message)) {
        settlePendingIngestionRequest(message.bot, message.result);
        return;
      }
      if (isComputeDiffScopeResultMessage(message)) {
        settlePendingDiffScopeRequest(message.projectPath, message.result, message.requestId);
        return;
      }
      if (isExpandBlastRadiusResultMessage(message)) {
        settlePendingBlastRadiusRequest(message.projectPath, message.result, message.requestId);
        return;
      }
      if (isModelStatusMessage(message)) {
        sendModelStatus(message);
        return;
      }
      if (isSummaryProgressMessage(message)) {
        sendSummaryProgress(message);
        return;
      }
      if (isLlmJudgmentProgressMessage(message)) {
        sendLlmJudgmentProgress(message);
        return;
      }
      if (isHardwareAdvisoryMessage(message)) {
        sendHardwareAdvisory(message);
        return;
      }
      sendGraphServiceStatus(message);
    },
  );

  graphService.on('exit', (code: number) => {
    graphService = null;
    // A request still outstanding when the subprocess exits will never get
    // its reply now — settle it as an explicit failure rather than leaving
    // the renderer's `getCodeMap()` promise hanging (matrix: "Map data
    // fetch fails").
    settlePendingCodeMapRequest({
      status: 'error',
      message: 'Graph Service exited before the Code Map could be fetched.',
    });
    // Story 1.8 (Phase 4, Always): every still-pending regenerate request is
    // settled with an explicit error too — the subprocess dying mid-request
    // will never post the `graphService:regenerateNodeResult` reply those
    // promises are waiting on.
    settleAllPendingRegenerateRequests('Graph Service exited before the Node could be regenerated.');
    // Story 1.9 (Phase 1, matrix: "No project indexed yet, or Graph Service
    // unavailable" -> "Trace refused" with an explicit `error` result): a
    // Path Trace request still outstanding when the subprocess exits will
    // never get its reply now — settle it as an explicit failure, same
    // reasoning as the two settle calls above it.
    settleAnyPendingPathTraceRequest({
      status: 'error',
      message: 'Graph Service exited before the Path Trace could complete.',
    });
    // Story 2.3 (Phase 2): every still-pending ingestion request is settled
    // too, same reasoning as the regenerate/Path Trace settle calls above —
    // the subprocess dying mid-ingestion will never post the
    // `graphService:runIngestionResult` reply those promises are waiting on.
    settleAllPendingIngestionRequests('Graph Service exited before the ingestion pass could complete.');
    // Story 3.1 (Phase 1): every still-pending diff-scope request is settled
    // too, same reasoning as the settle calls above it — the subprocess
    // dying mid-computation will never post the
    // `graphService:computeDiffScopeResult` reply those promises are waiting
    // on.
    settleAllPendingDiffScopeRequests('Graph Service exited before the diff scope could be computed.');
    // Story 3.2 (Phase 1): every still-pending blast-radius expansion
    // request is settled too, same reasoning as the settle calls above it —
    // the subprocess dying mid-computation will never post the
    // `graphService:expandBlastRadiusResult` reply those promises are
    // waiting on.
    settleAllPendingBlastRadiusRequests('Graph Service exited before the blast radius could be expanded.');
    if (code === 0 || isGraphServiceShuttingDown) {
      // A deliberate shutdown (app quit, or teardownGraphService's 2s kill
      // fallback) can exit with a non-zero/null code too — that's not an
      // unexpected error, so don't report it as one.
      sendGraphServiceStatus({ state: 'exited', at: new Date().toISOString(), code });
    } else {
      // An unexpected exit surfaces as an explicit, actionable error rather
      // than a crash — the renderer offers a manual retry (matrix: "Graph
      // Service fails to spawn").
      sendGraphServiceStatus({
        state: 'error',
        at: new Date().toISOString(),
        code,
        message: `Graph Service exited unexpectedly (code ${code}).`,
      });
    }
    isGraphServiceShuttingDown = false;
  });
}

/**
 * Sends an index-start request to a running Graph Service subprocess
 * (Story 1.2, Phase 1). A no-op if the subprocess isn't up — callers only
 * invoke this once `spawnGraphService()` has run.
 *
 * Story 1.6 (Phase 2) adds the backend choice: `activeBackend` is read from
 * the persisted backend settings at the moment this is called, and the
 * cloud key — decrypted here, in main, the only process with `safeStorage`
 * access (this story's Design Notes) — is included only when cloud is
 * actually active. The Graph Service never receives a key it can't use.
 */
function sendIndexRequest(projectPath: string): void {
  const backendConfig = getBackendConfig();
  graphService?.postMessage({
    type: 'graphService:index',
    path: projectPath,
    activeBackend: backendConfig.activeBackend,
    ...(backendConfig.activeBackend === 'cloud'
      ? { cloudApiKey: getDecryptedCloudApiKey() }
      : {}),
  } satisfies GraphServiceIndexRequest);
}

/**
 * Relays a Code Map fetch to the Graph Service subprocess (Story 1.3) and
 * resolves once it replies. `utilityProcess.postMessage` has no built-in
 * request/response correlation, so `pendingCodeMapResolve` is what bridges
 * the fire-and-forget subprocess message to this Promise — settled by
 * whichever comes first: the 'message' handler above (a genuine reply),
 * the 'exit' handler (the subprocess died first), or `CODE_MAP_REQUEST_
 * TIMEOUT_MS` firing (a hang with no reply and no exit).
 *
 * Rejects nothing: every failure path (no subprocess running, the
 * subprocess's own error reply, it exiting mid-fetch, `postMessage` itself
 * throwing, or the request timing out) resolves to `{status: 'error', ...}`
 * — the matrix's "explicit error state... never blank/crash" applies here
 * exactly like the index flow.
 *
 * An overlapping call (e.g. a fast double-click on Retry) shares the one
 * in-flight `pendingCodeMapPromise` rather than getting an immediate,
 * spurious "already in progress" failure — both callers see the same
 * eventual result.
 */
function requestCodeMap(): Promise<CodeMapResult> {
  if (pendingCodeMapPromise) {
    return pendingCodeMapPromise;
  }
  if (!graphService) {
    return Promise.resolve({ status: 'error', message: 'Graph Service is not running.' });
  }
  const service = graphService;

  const promise = new Promise<CodeMapResult>((resolve) => {
    pendingCodeMapResolve = resolve;
  });
  // Assigned before the postMessage attempt below (and before the timeout
  // is armed) so a synchronous settle from either one can safely null this
  // back out without a subsequent assignment resurrecting an
  // already-resolved stale promise.
  pendingCodeMapPromise = promise;

  const timeoutTimer = setTimeout(() => {
    settlePendingCodeMapRequest({
      status: 'error',
      message: 'Timed out waiting for the Graph Service to respond with the Code Map.',
    });
  }, CODE_MAP_REQUEST_TIMEOUT_MS);
  void promise.finally(() => clearTimeout(timeoutTimer));

  try {
    service.postMessage({
      type: 'graphService:getCodeMap',
    } satisfies GraphServiceGetCodeMapRequest);
  } catch (error) {
    // A synchronous throw here would otherwise leave pendingCodeMapResolve
    // set with nothing left to ever call it, leaking the request forever.
    settlePendingCodeMapRequest({
      status: 'error',
      message: `Failed to send the Code Map request to the Graph Service: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return promise;
}

/**
 * Relays a single-Node regenerate request to the Graph Service subprocess
 * (Story 1.8, Phase 4) and resolves once it replies — this app's first
 * id-keyed *mutating* IPC round-trip. Unlike `requestCodeMap`'s own
 * overlapping-call handling (which shares one in-flight promise, safe only
 * because a Code Map fetch is read-only/idempotent), a second regenerate
 * call for a Node already in flight is rejected immediately with an
 * explicit error result (Always) — never queued behind the first, never
 * silently dropped — since a mutating request has no such idempotent-replay
 * safety.
 *
 * Rejects nothing, matching `requestCodeMap`'s own framing: every failure
 * path (no subprocess running, an already-in-flight request for this exact
 * Node, the subprocess's own error reply, it exiting mid-request,
 * `postMessage` itself throwing, or the request timing out) resolves to
 * `{status: 'error', ...}`.
 *
 * Carries its own timeout backstop (Spec Change Log Round 1) — `REGENERATE_
 * NODE_TIMEOUT_MS`, NOT `requestCodeMap`'s own `CODE_MAP_REQUEST_TIMEOUT_MS`
 * (review round 2: that 30-minute, whole-project-fetch-sized value let a
 * regenerate call queued behind an in-progress batch appear to "succeed"
 * eventually while main had already reported a false timeout — see
 * `REGENERATE_NODE_TIMEOUT_MS`'s own doc comment for the sizing rationale).
 * If the Graph Service never posts a `graphService:regenerateNodeResult`
 * for this `nodeId` within that window (a lost message, a hung call, no
 * exit), this settles the pending entry with an explicit error and removes
 * it from `pendingRegenerateResolvers`, so a retry is possible rather than
 * the Regenerate button staying stuck "Regenerating…" forever.
 */
function requestRegenerateNode(nodeId: string): Promise<RegenerateNodeResult> {
  if (pendingRegenerateResolvers.has(nodeId)) {
    return Promise.resolve({
      status: 'error',
      message: 'A regenerate request for this Node is already in progress.',
    });
  }
  if (!graphService) {
    return Promise.resolve({ status: 'error', message: 'Graph Service is not running.' });
  }
  const service = graphService;

  const promise = new Promise<RegenerateNodeResult>((resolve, reject) => {
    pendingRegenerateResolvers.set(nodeId, { resolve, reject });
  });

  const timeoutTimer = setTimeout(() => {
    settlePendingRegenerateRequest(nodeId, {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to respond to the regenerate request.',
    });
  }, REGENERATE_NODE_TIMEOUT_MS);
  void promise.finally(() => clearTimeout(timeoutTimer));

  try {
    service.postMessage({
      type: 'graphService:regenerateNode',
      nodeId,
    } satisfies GraphServiceRegenerateNodeRequest);
  } catch (error) {
    // A synchronous throw here would otherwise leave this nodeId's resolver
    // set with nothing left to ever call it, leaking the request forever —
    // same reasoning as `requestCodeMap`'s own matching catch block.
    settlePendingRegenerateRequest(nodeId, {
      status: 'error',
      message: `Failed to send the regenerate request to the Graph Service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  return promise;
}

/**
 * Relays a PR-bot ingestion request to the Graph Service subprocess (Story
 * 2.3, Phase 2) and resolves once it replies — mirrors
 * `requestRegenerateNode`'s overall shape exactly (an id-keyed
 * `pendingIngestionResolvers` Map, keyed by `bot` instead of `nodeId`; a
 * second overlapping call for the same `bot` is rejected immediately rather
 * than queued; its own timeout backstop; a wrapped `postMessage` call).
 *
 * `projectPath` must be the currently-open project (`currentProjectPath`,
 * the same value `sendIndexRequest`'s callers set) — this call is only ever
 * meaningful against the project the Graph Service actually has indexed and
 * cached Nodes for (mirrors `requestRegenerateNode`'s implicit reliance on
 * `activeCodeMapNodes` belonging to whatever project is currently open,
 * made explicit here since, unlike `regenerateNode`, this IPC call's own
 * signature carries a `projectPath` the renderer could otherwise pass for a
 * project that isn't the one actually open).
 *
 * Rejects nothing, matching `requestRegenerateNode`'s own framing: every
 * failure path (no subprocess running or shutting down, a request already
 * in flight for this `bot`, `projectPath` not the open project, the
 * subprocess's own error reply, it exiting mid-request, `postMessage` itself
 * throwing, or the request timing out) resolves to `{status: 'error', ...}`.
 */
function requestPrBotIngestion(projectPath: string, bot: PrBotId): Promise<PrBotIngestionResult> {
  if (pendingIngestionResolvers.has(bot)) {
    return Promise.resolve({
      status: 'error',
      message: 'An ingestion request for this PR-bot is already in progress.',
    });
  }
  if (!graphService || isGraphServiceShuttingDown) {
    return Promise.resolve({ status: 'error', message: 'Graph Service is not running.' });
  }
  if (projectPath !== currentProjectPath) {
    return Promise.resolve({
      status: 'error',
      message: 'The requested project is not the currently open project.',
    });
  }
  const service = graphService;

  const promise = new Promise<PrBotIngestionResult>((resolve, reject) => {
    pendingIngestionResolvers.set(bot, { resolve, reject });
  });

  const timeoutTimer = setTimeout(() => {
    settlePendingIngestionRequest(bot, {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to respond to the ingestion request.',
    });
  }, INGESTION_REQUEST_TIMEOUT_MS);
  void promise.finally(() => clearTimeout(timeoutTimer));

  try {
    service.postMessage({
      type: 'graphService:runIngestion',
      bot,
    } satisfies GraphServiceRunIngestionRequest);
  } catch (error) {
    // A synchronous throw here would otherwise leave this bot's resolver set
    // with nothing left to ever call it, leaking the request forever — same
    // reasoning as `requestRegenerateNode`'s own matching catch block.
    settlePendingIngestionRequest(bot, {
      status: 'error',
      message: `Failed to send the ingestion request to the Graph Service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  return promise;
}

/**
 * Relays a diff-scope computation request to the Graph Service subprocess
 * (Story 3.1, Phase 1) and resolves once it replies — mirrors
 * `requestPrBotIngestion`'s overall shape exactly (an id-keyed
 * `pendingDiffScopeResolvers` Map, keyed by `projectPath` instead of `bot`;
 * a second overlapping call for the same project is rejected immediately
 * rather than queued; its own timeout backstop; a wrapped `postMessage`
 * call).
 *
 * `projectPath` must be the currently-open project (`currentProjectPath`) —
 * same validation `requestPrBotIngestion` already applies, for the same
 * reason: this call is only ever meaningful against the project the Graph
 * Service actually has indexed and cached Nodes for.
 *
 * Rejects nothing, matching `requestPrBotIngestion`'s own framing: every
 * failure path (no subprocess running or shutting down, a request already
 * in flight for this project, `projectPath` not the open project, the
 * subprocess's own error reply, it exiting mid-request, `postMessage` itself
 * throwing, or the request timing out) resolves to `{status: 'error', ...}`.
 */
function requestComputeDiffScope(projectPath: string, baseRef: string | undefined): Promise<DiffScopeResult> {
  if (pendingDiffScopeResolvers.has(projectPath)) {
    return Promise.resolve({
      status: 'error',
      message: 'A diff-scope computation for this project is already in progress.',
    });
  }
  if (!graphService || isGraphServiceShuttingDown) {
    return Promise.resolve({ status: 'error', message: 'Graph Service is not running.' });
  }
  if (projectPath !== currentProjectPath) {
    return Promise.resolve({
      status: 'error',
      message: 'The requested project is not the currently open project.',
    });
  }
  const service = graphService;
  const requestId = ++nextDiffScopeRequestId;

  const promise = new Promise<DiffScopeResult>((resolve, reject) => {
    pendingDiffScopeResolvers.set(projectPath, { requestId, resolve, reject });
  });

  const timeoutTimer = setTimeout(() => {
    settlePendingDiffScopeRequest(projectPath, {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to respond to the diff-scope request.',
    });
  }, DIFF_SCOPE_REQUEST_TIMEOUT_MS);
  void promise.finally(() => clearTimeout(timeoutTimer));

  try {
    service.postMessage({
      type: 'graphService:computeDiffScope',
      projectPath,
      requestId,
      ...(baseRef !== undefined ? { baseRef } : {}),
    } satisfies GraphServiceComputeDiffScopeRequest);
  } catch (error) {
    // A synchronous throw here would otherwise leave this projectPath's
    // resolver set with nothing left to ever call it, leaking the request
    // forever — same reasoning as `requestPrBotIngestion`'s own matching
    // catch block.
    settlePendingDiffScopeRequest(projectPath, {
      status: 'error',
      message: `Failed to send the diff-scope request to the Graph Service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  return promise;
}

/**
 * Relays a blast-radius expansion request to the Graph Service subprocess
 * (Story 3.2, Phase 1) and resolves once it replies — mirrors
 * `requestComputeDiffScope`'s overall shape exactly (an id-keyed
 * `pendingBlastRadiusResolvers` Map keyed by `projectPath`; a second
 * overlapping call for the same project is rejected immediately rather than
 * queued; its own timeout backstop; a wrapped `postMessage` call).
 *
 * `projectPath` must be the currently-open project (`currentProjectPath`) —
 * same validation `requestComputeDiffScope` already applies, for the same
 * reason: this call is only ever meaningful against the project the Graph
 * Service actually has indexed and cached Nodes/Edges for.
 *
 * Rejects nothing, matching `requestComputeDiffScope`'s own framing: every
 * failure path (no subprocess running or shutting down, a request already
 * in flight for this project, `projectPath` not the open project, the
 * subprocess's own error reply, it exiting mid-request, `postMessage` itself
 * throwing, or the request timing out) resolves to `{status: 'error', ...}`.
 */
function requestExpandBlastRadius(projectPath: string, nodeIds: string[]): Promise<BlastRadiusExpansionResult> {
  if (pendingBlastRadiusResolvers.has(projectPath)) {
    return Promise.resolve({
      status: 'error',
      message: 'A blast radius expansion for this project is already in progress.',
    });
  }
  if (!graphService || isGraphServiceShuttingDown) {
    return Promise.resolve({ status: 'error', message: 'Graph Service is not running.' });
  }
  if (projectPath !== currentProjectPath) {
    return Promise.resolve({
      status: 'error',
      message: 'The requested project is not the currently open project.',
    });
  }
  const service = graphService;
  const requestId = ++nextBlastRadiusRequestId;

  const promise = new Promise<BlastRadiusExpansionResult>((resolve, reject) => {
    pendingBlastRadiusResolvers.set(projectPath, { requestId, resolve, reject });
  });

  const timeoutTimer = setTimeout(() => {
    settlePendingBlastRadiusRequest(projectPath, {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to respond to the blast-radius request.',
    });
  }, BLAST_RADIUS_REQUEST_TIMEOUT_MS);
  void promise.finally(() => clearTimeout(timeoutTimer));

  try {
    service.postMessage({
      type: 'graphService:expandBlastRadius',
      projectPath,
      nodeIds,
      requestId,
    } satisfies GraphServiceExpandBlastRadiusRequest);
  } catch (error) {
    // A synchronous throw here would otherwise leave this projectPath's
    // resolver set with nothing left to ever call it, leaking the request
    // forever — same reasoning as `requestComputeDiffScope`'s own matching
    // catch block.
    settlePendingBlastRadiusRequest(projectPath, {
      status: 'error',
      message: `Failed to send the blast-radius request to the Graph Service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  return promise;
}

/**
 * Relays a Path Trace request to the Graph Service subprocess (Story 1.9,
 * Phase 1) and resolves once it replies — read-only, single-slot, mirroring
 * `requestCodeMap`'s overall shape (subprocess-running check, timeout
 * backstop reusing `CODE_MAP_REQUEST_TIMEOUT_MS`, a wrapped `postMessage`
 * call). Unlike `requestCodeMap`, a second overlapping call is never given a
 * shared promise (see `pendingPathTraceResolve`'s own doc comment for why a
 * different query in flight makes that unsafe here) — it's rejected outright
 * with an explicit error instead, same spirit as `requestRegenerateNode`'s
 * per-nodeId "already in progress" guard, just keyed on the single global
 * slot rather than a per-id Map since a trace request carries no id of its
 * own to key by.
 *
 * Also checks `isGraphServiceShuttingDown` (Spec Change Log, post-review
 * hardening), not just `!graphService` — a request sent while the
 * subprocess is mid-shutdown would otherwise be silently dropped by the
 * subprocess's own `!isShuttingDown` message-handler guard
 * (services/graph-service/index.ts), leaving the caller to wait out the
 * full timeout instead of getting an immediate explicit error; every other
 * request-sending function in this file (`sendIndexRequest`'s callers,
 * `requestRegenerateNode`, etc.) already treats a shutting-down subprocess
 * as unusable.
 *
 * Every request gets its own `requestId` token (`pathTraceRequestToken`,
 * bumped here) that `settlePendingPathTraceRequest` compares against
 * `pendingPathTraceToken` before resolving anything — see that variable's
 * own doc comment for the stale/late-reply race this closes.
 *
 * Rejects nothing, matching `requestCodeMap`/`requestRegenerateNode`'s own
 * framing: every failure path (no subprocess running or shutting down, a
 * request already in flight, the subprocess's own error reply, it exiting
 * mid-request, `postMessage` itself throwing, or the request timing out)
 * resolves to `{status: 'error', ...}` — the matrix's "No project indexed
 * yet, or Graph Service unavailable" -> "Trace refused" / "Explicit `error`
 * result with message" applies here exactly like the Code Map fetch.
 */
function requestPathTrace(query: string): Promise<PathTraceResult> {
  if (pendingPathTraceResolve) {
    return Promise.resolve({
      status: 'error',
      message: 'A Path Trace request is already in progress.',
    });
  }
  if (!graphService || isGraphServiceShuttingDown) {
    return Promise.resolve({ status: 'error', message: 'Graph Service is not running.' });
  }
  const service = graphService;

  const myToken = ++pathTraceRequestToken;
  pendingPathTraceToken = myToken;

  const promise = new Promise<PathTraceResult>((resolve) => {
    pendingPathTraceResolve = resolve;
  });

  const timeoutTimer = setTimeout(() => {
    settlePendingPathTraceRequest(myToken, {
      status: 'error',
      message: 'Timed out waiting for the Graph Service to respond to the Path Trace request.',
    });
  }, CODE_MAP_REQUEST_TIMEOUT_MS);
  void promise.finally(() => clearTimeout(timeoutTimer));

  try {
    service.postMessage({
      type: 'graphService:pathTrace',
      query,
      requestId: myToken,
    } satisfies GraphServicePathTraceRequest);
  } catch (error) {
    // A synchronous throw here would otherwise leave pendingPathTraceResolve
    // set with nothing left to ever call it, leaking the request forever —
    // same reasoning as `requestCodeMap`'s own matching catch block.
    settlePendingPathTraceRequest(myToken, {
      status: 'error',
      message: `Failed to send the Path Trace request to the Graph Service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  return promise;
}

// ---------------------------------------------------------------------------
// One-click-to-source (FR3/FR17 groundwork): a local file read off the
// user's own disk, resolved under the open project's root — never an MCP
// call (the Graph Service/backend only ever produced the {file, startLine,
// endLine} coordinates; reading the bytes back is main's own job).
// ---------------------------------------------------------------------------

/**
 * Result of `resolveProjectFilePath`: either the `realpath`-resolved
 * absolute path (containment-checked, safe to pass to `readFile`/
 * `shell.openPath`/an editor URI), or an explicit containment-violation
 * error.
 */
type ResolveProjectFilePathResult =
  | { status: 'ok'; absolutePath: string }
  | { status: 'error'; message: string };

/**
 * Resolves a Node's POSIX-relative `file` (AD-19) to an absolute, OS-native
 * path under `projectRoot` — the shared containment-checked resolution both
 * `handleReadSourceRange` (one-click-to-source, FR3/FR17 groundwork) and
 * `requestOpenInEditor` (Story 1.10, Phase 2, the external-editor hand-off)
 * call, extracted rather than duplicated (Boundaries & Constraints: "never
 * duplicated").
 *
 * Rejects a path that would resolve outside `projectRoot` — the Graph
 * Service backend is trusted for graph *content*, but a `file` value
 * reaching either caller still crosses the same untrusted IPC boundary as
 * any other renderer-supplied input (main/index.ts's existing
 * `projectOpenPath` validation is the precedent), so it's checked here
 * rather than assumed safe. Checked twice: once lexically (cheap, catches
 * an obvious `../`-escape even for a path that doesn't exist on disk), and
 * once against the `realpath`-resolved path (review finding: a symlink
 * *inside* `projectRoot` pointing outside it passes the lexical check alone
 * — `path.resolve()` never follows symlinks — and a consumer would then
 * happily follow it). `projectRoot` itself is resolved the same way before
 * the second comparison, since a legitimate project root can itself sit
 * behind a symlinked ancestor (e.g. macOS's `/tmp` -> `/private/tmp`) —
 * otherwise a perfectly legitimate file would fail containment because only
 * one side of the comparison got de-symlinked.
 */
async function resolveProjectFilePath(
  projectRoot: string,
  file: string,
): Promise<ResolveProjectFilePathResult> {
  const absolutePath = path.resolve(projectRoot, file);
  const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (absolutePath !== projectRoot && !absolutePath.startsWith(rootWithSep)) {
    return { status: 'error', message: 'Resolved path is outside the project root.' };
  }

  let realAbsolutePath: string;
  let realRoot: string;
  try {
    [realAbsolutePath, realRoot] = await Promise.all([
      resolveRealPathIfExists(absolutePath),
      resolveRealPathIfExists(projectRoot),
    ]);
  } catch (error) {
    // An unexpected realpath failure (e.g. a permission error on an
    // intermediate directory) — reject explicitly rather than falling
    // through to a containment check against an unresolved path.
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realAbsolutePath !== realRoot && !realAbsolutePath.startsWith(realRootWithSep)) {
    return { status: 'error', message: 'Resolved path is outside the project root.' };
  }

  return { status: 'ok', absolutePath: realAbsolutePath };
}

/**
 * Resolves a Node's POSIX-relative `file` (AD-19) to an absolute, OS-native
 * path under `projectRoot` (via `resolveProjectFilePath`), and reads back
 * the `[startLine, endLine]` line range (1-indexed, inclusive) as read-only
 * raw source (Non-Goal: no editing surface). Line endings are normalized to
 * `\n` for display (see the `readFile` block below) — this returns the
 * requested lines' *content* verbatim, not necessarily the source file's
 * original bytes, so a CRLF/CR file's line terminators are not reproduced
 * byte-for-byte.
 *
 * This is a pure refactor of already-shipped, already-reviewed logic (Design
 * Notes) — `resolveProjectFilePath`'s extraction changes nothing about this
 * function's own behavior.
 */
async function handleReadSourceRange(
  projectRoot: string,
  file: string,
  startLine: number,
  endLine: number,
): Promise<ReadSourceRangeResult> {
  if (
    typeof file !== 'string' ||
    file.length === 0 ||
    !Number.isFinite(startLine) ||
    !Number.isFinite(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return { status: 'error', message: 'Invalid source range request.' };
  }

  const resolved = await resolveProjectFilePath(projectRoot, file);
  if (resolved.status === 'error') {
    return resolved;
  }

  try {
    const raw = await readFile(resolved.absolutePath, 'utf8');
    const lines = raw.split(/\r\n|\r|\n/);
    if (lines.length < endLine) {
      // The file is shorter than the Node's indexed range — it likely
      // shrank since the last index. Silently clamping and returning
      // whatever's left would look confident but be wrong (review finding
      // — the same honesty principle behind Story 1.2's coverage-gap
      // reporting), so this says so explicitly instead of guessing.
      return {
        status: 'error',
        message: `The file now has only ${lines.length} line(s), fewer than the requested range (${startLine}-${endLine}). It may have changed since the last index — try re-indexing.`,
      };
    }
    const content = lines.slice(startLine - 1, endLine).join('\n');
    return { status: 'ok', content };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * URI-encodes an absolute filesystem path for insertion into the
 * `vscode://file{path}:{line}` / `idea://open?file={path}&line={line}`
 * editor-launch URIs (Story 1.10, Phase 2, AD-23) — encoded per path
 * segment, not via a single `encodeURIComponent` over the whole string
 * (which would also escape the `/` separators and corrupt the path), so an
 * unusual-but-legal filename character (a space, `#`, `&`, `%`, non-ASCII,
 * ...) can never be interpreted as URI syntax by the receiving editor or the
 * OS's protocol dispatch. Never raw string interpolation (Always).
 *
 * A POSIX absolute path (`/Users/foo/bar.ts`) splits on its leading `/`
 * into a leading empty segment, which re-joining with `/` reproduces as the
 * URI's own leading slash for free. A Windows absolute path
 * (`C:\Users\foo\bar.ts`) has no such leading separator to split on — its
 * first segment is the drive letter (`C:`) — so without special handling
 * this would both lose the leading `/` the `vscode://file/...`/`idea://
 * open?file=...` shape expects, and have its drive-letter colon
 * percent-encoded to `%3A` by the same per-segment `encodeURIComponent`
 * every other segment needs (review finding: this silently broke the
 * Windows hand-off — `openExternal` still resolves on a malformed URI, so
 * nothing would visibly fail even though the editor never actually opens).
 * Detected and special-cased below: the drive segment keeps its colon
 * literal and a `/` is prepended, matching the `file:///C:/...` shape every
 * consumer here expects; every other segment (Windows or POSIX) is
 * unaffected.
 */
function encodePathForEditorUri(absolutePath: string): string {
  const rawSegments = absolutePath.split(path.sep);
  const isWindowsDrivePath = /^[a-zA-Z]:$/.test(rawSegments[0] ?? '');
  const encodedSegments = rawSegments.map((segment, index) =>
    isWindowsDrivePath && index === 0 ? segment : encodeURIComponent(segment),
  );
  return isWindowsDrivePath ? `/${encodedSegments.join('/')}` : encodedSegments.join('/');
}

/**
 * Hands a Node's exact source location off to the Phase 1-configured
 * external editor (Story 1.10, Phase 2, AD-23) — this app's first
 * `shell.openExternal`/`shell.openPath` call site, reachable only from main
 * (Always: "renderer never calls `shell.openExternal`/`shell.openPath`
 * directly"). `file` is resolved to an absolute path via the same
 * containment-checked `resolveProjectFilePath` helper `handleReadSourceRange`
 * uses, then:
 * - `vscode` builds `vscode://file/{absolutePath}:{startLine}` and dispatches
 *   it via `shell.openExternal` (exact-line-jump).
 * - `jetbrains` builds `idea://open?file={absolutePath}&line={startLine}`
 *   (IntelliJ IDEA's own scheme, user-confirmed — a product sub-selector is
 *   tracked in `deferred-work.md`, not this phase) via `shell.openExternal`.
 * - `system-default` calls `shell.openPath(absolutePath)` — the OS's generic
 *   file-open mechanism, no line-jump.
 *
 * Every failure path resolves to an explicit `{status: 'error', message}` —
 * never a silent no-op (Always): a containment violation from
 * `resolveProjectFilePath`, an `openExternal` rejection, or a non-empty
 * `openPath` result (Electron's own failure shape — it resolves with a
 * human-readable error string on failure rather than rejecting, so that's
 * checked explicitly rather than treated as success just because the
 * promise resolved) are all surfaced this way.
 *
 * `shell.openExternal` resolving successfully doesn't guarantee the target
 * editor actually opened the file — it's a fire-and-forget OS-level
 * protocol dispatch (Design Notes) — so an `'ok'` result here is a
 * best-effort signal, not a hard guarantee, consistent with AD-23's own
 * framing.
 */
async function requestOpenInEditor(
  projectRoot: string,
  file: string,
  startLine: number,
): Promise<OpenInEditorResult> {
  if (
    typeof file !== 'string' ||
    file.length === 0 ||
    !Number.isInteger(startLine) ||
    startLine < 1
  ) {
    return { status: 'error', stage: 'validate', message: 'Invalid open-in-editor request.' };
  }

  const resolved = await resolveProjectFilePath(projectRoot, file);
  if (resolved.status === 'error') {
    // A containment violation — failed before any launch was attempted, so
    // this is NOT "editor not found" (review finding: the caller uses
    // `stage` to tell these apart and frame each correctly).
    return { status: 'error', stage: 'resolve', message: resolved.message };
  }

  const preference = getEditorPreference();

  try {
    if (preference === 'vscode') {
      const encodedPath = encodePathForEditorUri(resolved.absolutePath);
      await shell.openExternal(`vscode://file${encodedPath}:${startLine}`);
      return { status: 'ok' };
    }
    if (preference === 'jetbrains') {
      const encodedPath = encodePathForEditorUri(resolved.absolutePath);
      await shell.openExternal(`idea://open?file=${encodedPath}&line=${startLine}`);
      return { status: 'ok' };
    }
    // 'system-default': the OS's generic file-open mechanism, no line-jump.
    // `shell.openPath` resolves with a non-empty string describing the
    // failure rather than rejecting (Electron's own shape) — checked
    // explicitly below rather than assumed to have succeeded.
    const failure = await shell.openPath(resolved.absolutePath);
    if (failure.length > 0) {
      return { status: 'error', stage: 'launch', message: failure };
    }
    return { status: 'ok' };
  } catch (error) {
    // `openExternal` rejecting — an unregistered URI scheme, or the OS
    // reporting it can't dispatch the protocol (matrix: "Editor not
    // found / handler unavailable") — a genuine launch-stage failure.
    return {
      status: 'error',
      stage: 'launch',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `fs.promises.realpath`, tolerant of a not-yet-existing path: `readFile`
 * (the actual consumer, right after the containment check this feeds) will
 * itself fail with its own clear ENOENT-based error, so there's nothing
 * useful to resolve here — `candidate` is returned as-is rather than
 * treating "doesn't exist" as the same kind of failure as a genuine
 * realpath error (e.g. a permission error on an intermediate directory),
 * which the caller does still want to know about.
 */
async function resolveRealPathIfExists(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return candidate;
    }
    throw error;
  }
}

/**
 * Stops the Graph Service subprocess. `onTornDown`, when given, fires once
 * the subprocess has actually exited (either on its own after the shutdown
 * message, or via the 2s fallback kill) — callers that must not proceed
 * until the process is truly gone (e.g. app quit) should wait on it rather
 * than treating this function as synchronous.
 */
function teardownGraphService(onTornDown?: () => void): void {
  if (!graphService) {
    onTornDown?.();
    return;
  }
  isGraphServiceShuttingDown = true;
  const child = graphService;
  graphService = null;
  child.postMessage({ type: 'graphService:shutdown' });

  let settled = false;
  // Fallback in case the subprocess doesn't exit promptly on its own.
  const killTimer = setTimeout(() => child.kill(), 2000);
  child.once('exit', () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(killTimer);
    onTornDown?.();
  });
}

// ---------------------------------------------------------------------------
// Open-folder flow (FR1): detects a git repo before confirming; a non-git
// folder states that explicitly. Confirmed opens are recorded to Recent
// Projects and (re)spawn the Graph Service.
// ---------------------------------------------------------------------------

function resolveOpenedFolder(folderPath: string): ProjectOpenResult {
  const git: GitDetectionResult = detectGitRepo(folderPath);

  if (!git.isGitRepo) {
    return { status: 'not-a-git-repo', path: folderPath };
  }

  const project = recordProjectOpened(folderPath);
  currentProjectPath = project.path;
  spawnGraphService();
  sendIndexRequest(project.path);

  return { status: 'opened', project, git };
}

async function handleOpenFolder(): Promise<ProjectOpenResult> {
  if (!mainWindow) {
    return { status: 'error', message: 'No window available to show the folder picker.' };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { status: 'cancelled' };
  }

  return resolveOpenedFolder(result.filePaths[0]!);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.projectOpen, () => handleOpenFolder());

  ipcMain.handle(IpcChannels.projectOpenPath, (_event, folderPath: unknown): ProjectOpenResult => {
    // The renderer-supplied path crosses the contextBridge boundary as an
    // untyped value at runtime; validate it before it reaches filesystem
    // calls in resolveOpenedFolder/detectGitRepo.
    if (typeof folderPath !== 'string' || folderPath.length === 0 || !path.isAbsolute(folderPath)) {
      return { status: 'error', message: 'Invalid path' };
    }
    return resolveOpenedFolder(folderPath);
  });

  ipcMain.handle(IpcChannels.projectListRecent, () => listRecentProjects());

  ipcMain.handle(IpcChannels.graphServiceRestart, () => {
    spawnGraphService();
    // spawnGraphService's fork() + catch above run synchronously, so
    // `graphService` already reflects whether the spawn actually succeeded.
    if (graphService && currentProjectPath) {
      // Covers both a fresh respawn (the subprocess itself died) and a
      // still-alive subprocess whose indexing MCP call errored (spawn's own
      // guard no-ops in that case) — either way, Retry re-attempts indexing
      // rather than leaving the project un-indexed with no further signal.
      sendIndexRequest(currentProjectPath);
    }
    return { ok: graphService !== null };
  });

  ipcMain.handle(IpcChannels.codeMapGet, (): Promise<CodeMapResult> => requestCodeMap());

  ipcMain.handle(
    IpcChannels.sourceReadRange,
    (_event, file: unknown, startLine: unknown, endLine: unknown): Promise<ReadSourceRangeResult> => {
      // Renderer-supplied values cross the contextBridge boundary untyped at
      // runtime (same precedent as `projectOpenPath` above) — validated here
      // before touching the filesystem, and again inside
      // `handleReadSourceRange` for the numeric range itself.
      if (!currentProjectPath) {
        return Promise.resolve({ status: 'error', message: 'No project is open.' });
      }
      if (typeof file !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number') {
        return Promise.resolve({ status: 'error', message: 'Invalid source range request.' });
      }
      return handleReadSourceRange(currentProjectPath, file, startLine, endLine);
    },
  );

  // -------------------------------------------------------------------------
  // Story 1.10 (Phase 2): external-editor hand-off — the one call site
  // reachable from main for `shell.openExternal`/`shell.openPath` (AD-11,
  // AD-23). Same untyped-arg validation discipline as `sourceReadRange`
  // immediately above.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.shellOpenInEditor,
    (_event, file: unknown, startLine: unknown): Promise<OpenInEditorResult> => {
      if (!currentProjectPath) {
        return Promise.resolve({ status: 'error', stage: 'validate', message: 'No project is open.' });
      }
      if (typeof file !== 'string' || typeof startLine !== 'number') {
        return Promise.resolve({
          status: 'error',
          stage: 'validate',
          message: 'Invalid open-in-editor request.',
        });
      }
      return requestOpenInEditor(currentProjectPath, file, startLine);
    },
  );

  // -------------------------------------------------------------------------
  // Story 1.6 (Phase 1): backend config + cloud API key storage. Thin
  // delegation to backend-settings.ts — main owns no storage/encryption
  // logic of its own (same "thin shell" boundary as every other handler
  // here).
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.settingsGetBackendConfig, (): BackendConfig => getBackendConfig());

  ipcMain.handle(IpcChannels.settingsSetActiveBackend, (_event, backend: unknown): void => {
    // Renderer-supplied value crosses the contextBridge boundary untyped at
    // runtime (same precedent as projectOpenPath above); setActiveBackend
    // itself also defensively no-ops on an invalid value.
    if (backend !== 'local' && backend !== 'cloud') {
      return;
    }
    setActiveBackend(backend);
    // Story 1.6 (Phase 2): relay the switch to a running Graph Service only
    // when a project is actually open — a no-op backend change before any
    // project has ever been opened has nothing to clear/re-queue, and the
    // next `graphService:index` (once a project is opened) already carries
    // this same up-to-date backend choice on its own.
    if (graphService && currentProjectPath) {
      graphService.postMessage({
        type: 'graphService:backendSwitched',
        activeBackend: backend,
        ...(backend === 'cloud' ? { cloudApiKey: getDecryptedCloudApiKey() } : {}),
      } satisfies GraphServiceBackendSwitchedRequest);
    }
  });

  ipcMain.handle(
    IpcChannels.settingsSetCloudApiKey,
    (_event, key: unknown, acknowledgeInsecureStorage: unknown): SetCloudApiKeyResult => {
      if (typeof key !== 'string') {
        return { status: 'error', message: 'Invalid API key.' };
      }
      return setCloudApiKey(key, acknowledgeInsecureStorage === true);
    },
  );

  // -------------------------------------------------------------------------
  // Story 1.10 (Phase 1): external editor preference. Thin delegation to
  // editor-settings.ts, same shape as the settingsGetBackendConfig/
  // settingsSetActiveBackend handlers above — no consumer of the value yet
  // (Never: the actual hand-off is Phase 2).
  // -------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.settingsGetEditorPreference,
    (): EditorPreference => getEditorPreference(),
  );

  ipcMain.handle(IpcChannels.settingsSetEditorPreference, (_event, value: unknown): void => {
    // Renderer-supplied value crosses the contextBridge boundary untyped at
    // runtime (same precedent as settingsSetActiveBackend above);
    // setEditorPreference itself also defensively no-ops on an invalid
    // value.
    if (value !== 'vscode' && value !== 'jetbrains' && value !== 'system-default') {
      return;
    }
    setEditorPreference(value);
  });

  // -------------------------------------------------------------------------
  // Story 2.3 (Phase 1): per-project PR-bot opt-in settings. Thin delegation
  // to pr-bot-settings.ts, same "no storage/encryption logic of its own"
  // shell as every other settings handler above — same untyped-arg
  // validation discipline as settingsSetEditorPreference's handler
  // immediately above (Code Map). driller's first per-project settings
  // channels: both take `projectPath` as their first argument, unlike the
  // global settingsGet*/settingsSet* channels above.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.settingsGetPrBotConfig,
    (_event, projectPath: unknown): PrBotConfig => {
      // Renderer-supplied value crosses the contextBridge boundary untyped
      // at runtime (same precedent as every other handler's own guard in
      // this file) — an invalid projectPath falls back to the same
      // "nothing enabled" default a project with no persisted entry yet
      // reads back as, rather than throwing.
      if (typeof projectPath !== 'string' || projectPath.length === 0) {
        return { codeRabbitEnabled: false, qodoEnabled: false };
      }
      return getPrBotConfig(projectPath);
    },
  );

  ipcMain.handle(
    IpcChannels.settingsSetPrBotEnabled,
    (_event, projectPath: unknown, bot: unknown, enabled: unknown): PrBotConfig => {
      if (typeof projectPath !== 'string' || projectPath.length === 0) {
        return { codeRabbitEnabled: false, qodoEnabled: false };
      }
      if ((bot !== 'codeRabbit' && bot !== 'qodo') || typeof enabled !== 'boolean') {
        // Malformed bot/enabled value: no-op (same defensive-backstop
        // precedent as setActiveBackend/setEditorPreference's own guards),
        // returning the project's current, unchanged config rather than a
        // stale default.
        return getPrBotConfig(projectPath);
      }
      return setPrBotEnabled(projectPath, bot, enabled);
    },
  );

  // ---------------------------------------------------------------------------
  // Story 2.3 (Phase 2): CodeRabbit ingestion — driller's first external-CLI
  // subprocess invocation; Phase 3 adds Qodo/PR-Agent alongside it, same
  // `bot`-keyed round trip. Reachable only via this direct call so far (no UI
  // trigger/rendering yet — that's Phase 4's job — no renderer component
  // invokes it yet, mirroring Story 1.9 Phase 1's `path:trace` being callable
  // only from the DevTools console before its Phase 2 UI).
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.prBotRunIngestion,
    (_event, projectPath: unknown, bot: unknown): Promise<PrBotIngestionResult> => {
      // Renderer-supplied values cross the contextBridge boundary untyped at
      // runtime (same precedent as every other handler's own guard in this
      // file).
      if (typeof projectPath !== 'string' || projectPath.length === 0) {
        return Promise.resolve({ status: 'error', message: 'Invalid project path.' });
      }
      if (bot !== 'codeRabbit' && bot !== 'qodo') {
        return Promise.resolve({ status: 'error', message: 'Unsupported PR-bot.' });
      }
      return requestPrBotIngestion(projectPath, bot);
    },
  );

  // ---------------------------------------------------------------------------
  // Story 3.1 (Phase 1): compute a diff-scoped Node set from local git —
  // driller's first `git diff`/`git merge-base` subprocess computation. No
  // renderer entry point yet (Never: "no UI trigger, mode switcher... this
  // phase") — reachable only via this direct call, mirroring Story 2.3
  // Phase 2's `prBot:runIngestion` being callable only from the DevTools
  // console before its own UI phase.
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.diffScopeCompute,
    (_event, projectPath: unknown, baseRefInput: unknown): Promise<DiffScopeResult> => {
      // Renderer-supplied values cross the contextBridge boundary untyped at
      // runtime (same precedent as `prBotRunIngestion`'s own guard above).
      if (typeof projectPath !== 'string' || projectPath.length === 0) {
        return Promise.resolve({ status: 'error', message: 'Invalid project path.' });
      }
      // Review finding (Blind Hunter + Edge Case Hunter, independently):
      // `null` (a plausible default form value crossing the untyped
      // contextBridge) and a whitespace-only string were both previously
      // rejected as `'Invalid base ref.'` instead of being treated the same
      // as an omitted `baseRef` — both mean "no explicit ref, resolve a
      // default." Only a genuinely wrong type (not `undefined`/`null`/a
      // string) is actually invalid.
      if (baseRefInput !== undefined && baseRefInput !== null && typeof baseRefInput !== 'string') {
        return Promise.resolve({ status: 'error', message: 'Invalid base ref.' });
      }
      const trimmedBaseRef = typeof baseRefInput === 'string' ? baseRefInput.trim() : '';
      const baseRef = trimmedBaseRef.length > 0 ? trimmedBaseRef : undefined;
      return requestComputeDiffScope(projectPath, baseRef);
    },
  );

  // ---------------------------------------------------------------------------
  // Story 3.2 (Phase 1): compute multi-Node blast radius hop distances — a
  // full IPC/graph-service round trip mirroring Story 3.1 Phase 1's
  // `diffScope:compute` shape layer-for-layer. No renderer entry point yet
  // (Never: "no renderer/UI changes in this phase") — reachable only via
  // this direct call, mirroring `diffScope:compute`'s own precedent.
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.blastRadiusExpand,
    (_event, projectPath: unknown, nodeIdsInput: unknown): Promise<BlastRadiusExpansionResult> => {
      // Renderer-supplied values cross the contextBridge boundary untyped at
      // runtime (same precedent as `diffScopeCompute`'s own guard above).
      if (typeof projectPath !== 'string' || projectPath.length === 0) {
        return Promise.resolve({ status: 'error', message: 'Invalid project path.' });
      }
      if (!Array.isArray(nodeIdsInput) || !nodeIdsInput.every((nodeId) => typeof nodeId === 'string')) {
        return Promise.resolve({ status: 'error', message: 'Invalid Node IDs.' });
      }
      return requestExpandBlastRadius(projectPath, nodeIdsInput);
    },
  );

  // ---------------------------------------------------------------------------
  // Story 1.8 (Phase 4): on-demand single-Node regeneration — this app's
  // first id-keyed mutating IPC channel.
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.nodeRegenerate,
    (_event, nodeId: unknown): Promise<RegenerateNodeResult> => {
      // Renderer-supplied value crosses the contextBridge boundary untyped
      // at runtime (same precedent as `sourceReadRange`'s own guard above).
      if (typeof nodeId !== 'string' || nodeId.length === 0) {
        return Promise.resolve({ status: 'error', message: 'Invalid Node ID.' });
      }
      return requestRegenerateNode(nodeId);
    },
  );

  // ---------------------------------------------------------------------------
  // Story 1.9 (Phase 1): Path Trace — a new, dedicated, strictly read-only IPC
  // round trip (Boundaries & Constraints). Callable directly via
  // `window.driller.tracePath(query)` (e.g. from the DevTools console); no
  // search UI consumes it yet (Phase 2).
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.pathTrace,
    (_event, query: unknown): Promise<PathTraceResult> => {
      // Renderer-supplied value crosses the contextBridge boundary untyped at
      // runtime (same precedent as `sourceReadRange`'s own guard above). The
      // trimmed value — not the raw one — is both what's validated and what
      // gets sent onward: incidental leading/trailing whitespace (easy to
      // produce calling `window.driller.tracePath(...)` by hand, this
      // phase's documented entry point) would otherwise either silently fall
      // through to `no-path-found` (an exact match no longer matches with
      // the padding attached) or, worse, still match via the substring tier
      // against an unintended Node. A whitespace-only query is rejected the
      // same as an empty one.
      if (typeof query !== 'string') {
        return Promise.resolve({ status: 'error', message: 'Invalid Path Trace query.' });
      }
      const trimmedQuery = query.trim();
      if (trimmedQuery.length === 0) {
        return Promise.resolve({ status: 'error', message: 'Invalid Path Trace query.' });
      }
      return requestPathTrace(trimmedQuery);
    },
  );

  // ---------------------------------------------------------------------------
  // Story 1.9 (Phase 4): the local-only diagnostic log sink (AD-21). Fire-
  // and-forget from the renderer's perspective — this handler never rejects;
  // `appendDiagnosticLogEntry` itself swallows/console-logs any write
  // failure (Boundaries & Constraints: best-effort by design).
  // ---------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.diagnosticLog, (_event, entry: unknown): Promise<void> => {
    // Renderer-supplied value crosses the contextBridge boundary untyped at
    // runtime (same precedent as `sourceReadRange`/`pathTrace`'s own guards
    // above) — validated here before it reaches the filesystem write.
    const candidate = entry as {
      eventType?: unknown;
      timestamp?: unknown;
      query?: unknown;
      resultStatus?: unknown;
    } | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      candidate.eventType !== 'path-trace-dismissed' ||
      typeof candidate.timestamp !== 'string' ||
      typeof candidate.query !== 'string' ||
      (candidate.resultStatus !== 'found' &&
        candidate.resultStatus !== 'no-path-found' &&
        candidate.resultStatus !== 'ambiguous')
    ) {
      // Review fix: still dropped rather than written (matching this sink's
      // own best-effort-never-surfaced-to-the-user contract), but no longer
      // silently — a malformed IPC argument here can only come from a real
      // bug (never user action), so it's worth a developer-visible signal.
      console.warn('Dropped malformed diagnostic log entry.', candidate);
      return Promise.resolve();
    }
    // Review fix: rebuilt from just the four validated fields, never the raw
    // `entry` object forwarded as-is — the validation above only checks that
    // these fields exist with the right types, so passing `entry` through
    // unchanged would let any extra enumerable property on it get
    // `JSON.stringify`'d and persisted to disk verbatim.
    const sanitizedEntry: DiagnosticLogEntry = {
      eventType: 'path-trace-dismissed',
      timestamp: candidate.timestamp,
      query: candidate.query,
      resultStatus: candidate.resultStatus,
    };
    return appendDiagnosticLogEntry(sanitizedEntry);
  });
}

// ---------------------------------------------------------------------------
// Window creation (AD-11 security baseline)
// ---------------------------------------------------------------------------

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // AD-11 security baseline: renderer content never gets to open new
  // Electron-hosted windows (e.g. via target="_blank" or window.open()).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.on('ready', () => {
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', (event) => {
  if (!graphService) {
    // Nothing running to wait on — let quit proceed immediately. This is
    // also how the second, re-triggered quit below completes: by the time
    // it fires, teardownGraphService has already nulled `graphService`.
    return;
  }
  // Don't let the app process exit before the subprocess actually dies —
  // that would orphan it. Defer quitting until teardown confirms the
  // subprocess has exited (or the 2s fallback kill completed), then
  // request quit again.
  event.preventDefault();
  teardownGraphService(() => {
    app.quit();
  });
});
