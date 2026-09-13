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
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import started from 'electron-squirrel-startup';
import {
  IpcChannels,
  type BackendConfig,
  type CodeMapResult,
  type GitDetectionResult,
  type GraphServiceBackendSwitchedRequest,
  type GraphServiceCodeMapMessage,
  type GraphServiceGetCodeMapRequest,
  type GraphServiceIndexRequest,
  type GraphServiceRegenerateNodeRequest,
  type GraphServiceRegenerateNodeResultMessage,
  type GraphServiceStatusMessage,
  type HardwareAdvisoryMessage,
  type ModelStatusMessage,
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
import { detectGitRepo } from './git-detect';
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
        | ModelStatusMessage
        | SummaryProgressMessage
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
      if (isModelStatusMessage(message)) {
        sendModelStatus(message);
        return;
      }
      if (isSummaryProgressMessage(message)) {
        sendSummaryProgress(message);
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

// ---------------------------------------------------------------------------
// One-click-to-source (FR3/FR17 groundwork): a local file read off the
// user's own disk, resolved under the open project's root — never an MCP
// call (the Graph Service/backend only ever produced the {file, startLine,
// endLine} coordinates; reading the bytes back is main's own job).
// ---------------------------------------------------------------------------

/**
 * Resolves a Node's POSIX-relative `file` (AD-19) to an absolute, OS-native
 * path under `projectRoot`, and reads back the `[startLine, endLine]` line
 * range (1-indexed, inclusive) as read-only raw source (Non-Goal: no editing
 * surface). Line endings are normalized to `\n` for display (see the
 * `readFile` block below) — this returns the requested lines' *content*
 * verbatim, not necessarily the source file's original bytes, so a CRLF/CR
 * file's line terminators are not reproduced byte-for-byte.
 *
 * Rejects a path that would resolve outside `projectRoot` — the Graph
 * Service backend is trusted for graph *content*, but a `file` value
 * reaching this handler still crosses the same untrusted IPC boundary as
 * any other renderer-supplied input (main/index.ts's existing
 * `projectOpenPath` validation is the precedent), so it's checked here
 * rather than assumed safe. Checked twice: once lexically (cheap, catches
 * an obvious `../`-escape even for a path that doesn't exist on disk), and
 * once against the `realpath`-resolved path (review finding: a symlink
 * *inside* `projectRoot` pointing outside it passes the lexical check alone
 * — `path.resolve()` never follows symlinks — and `readFile` would then
 * happily follow it). `projectRoot` itself is resolved the same way before
 * the second comparison, since a legitimate project root can itself sit
 * behind a symlinked ancestor (e.g. macOS's `/tmp` -> `/private/tmp`) —
 * otherwise a perfectly legitimate file would fail containment because only
 * one side of the comparison got de-symlinked.
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

  try {
    const raw = await readFile(realAbsolutePath, 'utf8');
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
