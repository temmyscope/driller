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
 */

import os from 'node:os';
import path from 'node:path';
import type {
  GraphServiceCodeMapMessage,
  GraphServiceGetCodeMapRequest,
  GraphServiceIndexRequest,
  GraphServiceShutdownRequest,
  GraphServiceStatusMessage,
  ModelStatusMessage,
} from '@driller/ipc-contracts';
// Type-only import: pulls in Electron's ambient `process.parentPort`
// augmentation (real, present only when forked via `utilityProcess.fork`)
// without adding a runtime dependency on the `electron` package.
import type {} from 'electron';
import { ensureLocalModel } from './model-manager';
import { fetchCodeMap, indexRepository } from './mcp-client';
import { flushNodeRecordStore, initNodeRecordStore, setActiveProject } from './node-record-store';

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

function isIndexRequest(data: unknown): data is GraphServiceIndexRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, path: projectPath } = data as { type?: unknown; path?: unknown };
  // Mirrors the validation pattern main/index.ts's projectOpenPath handler
  // already uses for a renderer-supplied path: non-empty and absolute, not
  // merely a string, before it reaches the backend uncaught.
  return (
    type === 'graphService:index' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    path.isAbsolute(projectPath)
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
  postStatus({ state: 'exited', pid: process.pid, at: now(), code: 0 });
  process.exit(0);
}

async function handleIndexRequest(projectPath: string): Promise<void> {
  activeIndexPath = projectPath;
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
 */
async function handleGetCodeMapRequest(): Promise<void> {
  if (activeProject === undefined) {
    postCodeMapMessage({
      type: 'graphService:codeMapError',
      message: 'No project has finished indexing yet.',
    });
    return;
  }
  try {
    const { nodes, edges } = await fetchCodeMap(activeProject);
    postCodeMapMessage({ type: 'graphService:codeMap', nodes, edges });
  } catch (error) {
    postCodeMapMessage({
      type: 'graphService:codeMapError',
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
    activeIndexRequest = handleIndexRequest(event.data.path);
  }
});

process.on('SIGTERM', shutdown);

postStatus({ state: 'alive', pid: process.pid, at: now() });
