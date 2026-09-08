/**
 * Local-model summary generation (Story 1.5 Phase 2, FR5, AD-8, AD-20).
 *
 * Loads the verified local GGUF model (Story 1.5 Phase 1's `model-manager.ts`
 * result) once per Graph Service lifetime — live-verified API:
 * `getLlama()` -> `loadModel({modelPath})` -> `model.createContext()` ->
 * `context.getSequence()` — then, for every eligible Node, prompts a
 * **fresh** `LlamaChatSession` wrapping that same shared sequence (a
 * one-line setup cost) rather than one long-lived session reused across
 * Nodes: `LlamaChatSession` accumulates conversation history by default, and
 * a shared session across unrelated Nodes would let an earlier Node's
 * source/summary leak into a later prompt's context (see this story's
 * Design Notes). Only the expensive `loadModel`/`createContext` step is
 * memoized for the process's lifetime; the session wrapper is cheap and
 * created/disposed per job.
 *
 * A Node is eligible only if its file isn't in the current index's coverage
 * gap set (FR5) and it doesn't already have a persisted `summary` (AD-20 —
 * re-indexing/restart never regenerates an existing summary; see
 * `classifyNode`, reused by both the eligibility filter here and
 * `annotateNodesWithSummaryState` in index.ts so the two can never disagree
 * about a Node's state).
 *
 * Concurrency is bounded via `p-queue` at 1 (Design Notes: a single local
 * GGUF model instance has no meaningful way to run two generations in
 * parallel on typical consumer hardware without continuous-batching support
 * this story doesn't take on — 1 is the honest, correct bound for this
 * phase). Progress is batched (every ~1s or `PROGRESS_FLUSH_BATCH_SIZE`
 * completions, whichever first) rather than posted per Node (Always/AD-8).
 *
 * Runs only in the Graph Service subprocess (AD-16: no code content leaves
 * the machine) — reads source directly off disk via `fs.readFile`, never
 * through the renderer's `readSourceRange` IPC path.
 *
 * Story 1.6 (Phase 2) makes the actual model call pluggable: `generateSummaries`
 * no longer knows anything local-model-specific — it drives a `SummarizeFn`
 * (`(node, projectRoot) => Promise<SummarizeOutcome>`) supplied by the
 * caller (index.ts), which builds either this module's own
 * `createLocalSummarizer(model)` (the `LlamaChatSession` logic previously
 * inlined here, unchanged in behavior) or `cloud-summary-generator.ts`'s
 * `createCloudSummarizer(apiKey)`. The job pool, eligibility filter,
 * progress batcher, and merge-write logic below are otherwise unchanged —
 * only the per-Node model call itself is swappable (this story's Never
 * constraint).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  getLlama as GetLlama,
  LlamaChatSession as LlamaChatSessionClass,
  LlamaContext,
  LlamaContextSequence,
  LlamaModel,
} from 'node-llama-cpp';
import type { CodeMapNode, SummaryProgressUpdate, SummaryStatus } from '@driller/ipc-contracts';
import type { LocalModelReady } from './model-manager';
// p-queue is ESM-only but (unlike node-llama-cpp) carries no top-level await
// in its own dependency graph and is never in vite.graph-service.config.ts's
// `external` list — Vite inlines it straight into the subprocess's CJS
// bundle at build time (`ssr.noExternal: true`), so a plain static import
// here compiles to real bundled code, never a runtime `require("p-queue")`
// that could hit the same `ERR_REQUIRE_ASYNC_MODULE` node-llama-cpp's own
// dynamic-import workaround exists for (see model-manager.ts's doc comment).
import PQueue from 'p-queue';
import { getNodeRecord, mergeNodeRecord } from './node-record-store';

// See model-manager.ts's doc comment for why node-llama-cpp (ESM-only, top-
// level await in its dependency graph) must be lazily `import()`-ed rather
// than statically imported in a module this subprocess's CJS bundle
// `require()`s — a static import would throw `ERR_REQUIRE_ASYNC_MODULE` at
// runtime. Cached after the first successful import, same as model-manager.
let nodeLlamaCppModule:
  | Promise<{ getLlama: typeof GetLlama; LlamaChatSession: typeof LlamaChatSessionClass }>
  | undefined;

function loadNodeLlamaCppModule(): Promise<{
  getLlama: typeof GetLlama;
  LlamaChatSession: typeof LlamaChatSessionClass;
}> {
  nodeLlamaCppModule ??= import('node-llama-cpp');
  return nodeLlamaCppModule;
}

/** `p-queue` concurrency (Design Notes) — a single local model instance, not a placeholder. */
const SUMMARY_QUEUE_CONCURRENCY = 1;

// Small enough to keep a generated summary genuinely one line/sentence
// without an expensive, unbounded generation per Node.
const SUMMARY_MAX_TOKENS = 96;

// Progress batching (Always/AD-8: "never one IPC message per Node").
const PROGRESS_FLUSH_INTERVAL_MS = 1000;
const PROGRESS_FLUSH_BATCH_SIZE = 5;

// Story 1.5 Phase 3: the reactive hardware-advisory trigger — a *rate*
// within the current run, never a single fluke (Boundaries & Constraints).
// `MIN_COMPLETED_FOR_ADVISORY` gates the check until enough of this run's
// Nodes have actually been attempted for a rate to mean anything (one
// degenerate result out of one attempted is a 100% rate but tells you
// nothing about the hardware); `DEGENERATE_RATE_THRESHOLD` is the Code Map's
// own example figure — a substantial fraction, not an occasional miss.
const MIN_COMPLETED_FOR_ADVISORY = 5;
const DEGENERATE_RATE_THRESHOLD = 0.3;

// A generous cap well within this model's real context window (review
// finding, Medium) — an unusually large indexed range (a big Module/
// Interface) could otherwise overrun the model's context on its own,
// wasting the whole prompt budget on source instead of leaving room for a
// real response. ~8000 characters is enough for a large real function while
// still bounding the worst case; truncated (not rejected) so an oversized
// Node still gets a best-effort summary of its first ~8000 characters
// rather than silently staying 'pending' forever.
const MAX_SOURCE_CHARS = 8000;

// A single hung `session.prompt()` call must not stall this project's
// entire generation forever (review finding, Medium — with concurrency
// fixed at 1, nothing else in this queue can ever make progress behind a
// truly stuck call, and recovery would otherwise require restarting the
// whole Graph Service subprocess). Generous enough for a slow-hardware,
// worst-case-length prompt; mirrors the `withTimeout` pattern already
// established in mcp-client.ts/model-manager.ts, including that pattern's
// own documented limitation: this does not (and, per the underlying
// llama.cpp binding, cannot) cancel the underlying native call — it only
// stops the caller from waiting on it forever, so an abandoned call may
// still be consuming CPU/holding the sequence in the background after this
// fires. Accepted here for the same reason it's accepted in those other
// two modules: a bounded, honest failure beats an unbounded hang.
const SUMMARY_PROMPT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The specific error `withTimeout` (below) rejects with — a dedicated,
 * checkable subclass (review finding, Medium) rather than a plain `Error`
 * identified only by its message text. `summarizeNode`'s own timeout
 * classification (`isTimeoutError`, further down) is central to this
 * story's whole hardware-advisory feature — it decides what counts as a
 * "degenerate" result — so it deserves a real type/tag to check, not a
 * regex coupled to this file's own message-format string only by a comment.
 */
class SummaryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummaryTimeoutError';
  }
}

/**
 * Races `promise` against a timeout, rejecting with a `SummaryTimeoutError`
 * if `ms` elapses first. Duplicated from mcp-client.ts's/model-manager.ts's
 * own `withTimeout` (same small-helper-not-worth-a-shared-module reasoning
 * those two already documented) — does not cancel the underlying work.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SummaryTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The expensive, once-per-process-lifetime resources: the loaded model, its
 * context, and one shared sequence, reused across every generation job for
 * the rest of this Graph Service subprocess's life (Design Notes). Keyed by
 * `modelPath` only incidentally — in practice `ensureLocalModel` (Phase 1)
 * already memoizes the download/verify attempt itself, so this is only ever
 * called with one `modelPath` per process lifetime too. `model`/`context`
 * are kept (not just `sequence`) so `disposeModelContext` (below) has
 * something to actually dispose on subprocess shutdown (review finding,
 * Medium).
 */
let modelContextPromise:
  | Promise<{ model: LlamaModel; context: LlamaContext; sequence: LlamaContextSequence }>
  | undefined;

async function ensureModelContext(
  modelPath: string,
): Promise<{ model: LlamaModel; context: LlamaContext; sequence: LlamaContextSequence }> {
  modelContextPromise ??= (async () => {
    const { getLlama } = await loadNodeLlamaCppModule();
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();
    const sequence = context.getSequence();
    return { model, context, sequence };
  })();
  return modelContextPromise;
}

/**
 * Disposes the loaded model/context (review finding, Medium — previously
 * never disposed, leaking the native llama.cpp resources for the life of
 * the OS process rather than just this subprocess's own lifetime). Called
 * from index.ts's `finishShutdown`, alongside the Node record store flush,
 * so a clean subprocess shutdown always releases what it holds. A no-op if
 * generation was never actually used this session (`modelContextPromise`
 * still `undefined`) — nothing to dispose. Best-effort: a disposal failure
 * is logged, never thrown, since shutdown must still proceed regardless
 * (matching `flushNodeRecordStore`'s own best-effort framing).
 */
export async function disposeModelContext(): Promise<void> {
  if (!modelContextPromise) {
    return;
  }
  let handle: { model: LlamaModel; context: LlamaContext } | undefined;
  try {
    handle = await modelContextPromise;
  } catch {
    // Never successfully loaded — nothing real to dispose.
    return;
  }
  try {
    await handle.context.dispose();
  } catch (error) {
    console.warn(
      `[graph-service] failed to dispose the local model's context during shutdown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    await handle.model.dispose();
  } catch (error) {
    console.warn(
      `[graph-service] failed to dispose the local model during shutdown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Classifies one Node's summary state (Story 1.5 Phase 2, FR5) — shared by
 * `annotateNodesWithSummaryState` (what `getCodeMap` responses show) and
 * `generateSummaries`'s own eligibility filter below, so the two can never
 * disagree about which Nodes are eligible/ineligible/already-done.
 */
function classifyNode(
  node: CodeMapNode,
  coverageGapFiles: ReadonlySet<string>,
): { summaryStatus: SummaryStatus; summary?: string } {
  if (coverageGapFiles.has(node.file)) {
    return { summaryStatus: 'coverage-gap' };
  }
  const record = getNodeRecord(node.id);
  if (record?.summary) {
    return { summaryStatus: 'ready', summary: record.summary.text };
  }
  return { summaryStatus: 'pending' };
}

/**
 * Returns `nodes` with `summaryStatus`/`summary` populated from the Node
 * record store's current state and `coverageGapFiles` (Code Map: "populated
 * at `getCodeMap` fetch time from the store's current state") — called by
 * index.ts right before posting a `graphService:codeMap` message, so main/
 * the renderer never see the placeholder `'pending'` `mcp-client.ts` sets on
 * every freshly-parsed Node.
 */
export function annotateNodesWithSummaryState(
  nodes: CodeMapNode[],
  coverageGapFiles: ReadonlySet<string>,
): CodeMapNode[] {
  return nodes.map((node) => ({ ...node, ...classifyNode(node, coverageGapFiles) }));
}

/**
 * Reads a Node's exact source line range directly off disk (graph-service-
 * local `fs.readFile`, AD-16 — never the renderer's `readSourceRange` IPC
 * path). Returns `undefined` (logged, not thrown) rather than failing the
 * whole batch when a Node's source can't be read — e.g. the file changed or
 * shrank since the last index; that Node simply stays `'pending'` for this
 * session rather than blocking every other Node's generation.
 *
 * Exported (Story 1.6, Phase 2): shared by both `createLocalSummarizer`
 * below and `cloud-summary-generator.ts`'s `createCloudSummarizer` — reading
 * a Node's source off disk is identical regardless of which backend ends up
 * summarizing it, so this stays the one implementation both call.
 */
export async function readNodeSource(projectRoot: string, node: CodeMapNode): Promise<string | undefined> {
  // Defensive (review finding, Low): a malformed/corrupt indexed range would
  // otherwise slice backwards (`Array.prototype.slice(end, start)` with
  // `start > end` yields an empty array, silently sending the model an
  // empty "Source:" block) rather than being caught explicitly. Checked
  // before the disk read so a garbage range doesn't even cost an I/O call.
  if (node.startLine > node.endLine) {
    console.warn(
      `[graph-service] summary generation: ${node.id} has an invalid line range (${node.startLine}-${node.endLine}, start after end); skipping.`,
    );
    return undefined;
  }
  const absolutePath = path.resolve(projectRoot, node.file);
  let raw: string;
  try {
    raw = await readFile(absolutePath, 'utf8');
  } catch (error) {
    console.warn(
      `[graph-service] summary generation: couldn't read source for ${node.id} (${absolutePath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines.length < node.endLine) {
    console.warn(
      `[graph-service] summary generation: ${node.id}'s source file now has only ${lines.length} line(s), fewer than its indexed range (${node.startLine}-${node.endLine}); skipping this round.`,
    );
    return undefined;
  }
  const content = lines.slice(node.startLine - 1, node.endLine).join('\n');
  // Truncated, not rejected (review finding, Medium) — see MAX_SOURCE_CHARS'
  // comment.
  return content.length > MAX_SOURCE_CHARS
    ? `${content.slice(0, MAX_SOURCE_CHARS)}\n… (truncated)`
    : content;
}

function buildPrompt(node: CodeMapNode, source: string): string {
  return [
    `You are documenting a codebase for another engineer. Below is the real source of a ${node.kind.toLowerCase()} named "${node.name}", from ${node.file}.`,
    'Write exactly one concise, plain-language sentence describing what it does. Do not repeat the code. Do not use markdown. Reply with only the sentence.',
    '',
    'Source:',
    source,
  ].join('\n');
}

/**
 * Collapses a model response into a genuine single line, trimmed of
 * surrounding whitespace. Exported (Story 1.6, Phase 2): shared by
 * `cloud-summary-generator.ts`, so a cloud response is normalized exactly
 * the same way a local one already is.
 */
export function normalizeSummaryText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * A backend-agnostic per-Node summarization outcome (Story 1.5 Phase 3;
 * generalized in Story 1.6 Phase 2 to cover the cloud path too) — a
 * discriminated result rather than a bare `string | undefined`, so
 * `generateSummaries` can tell apart the three cases that would otherwise
 * all collapse into the same "nothing to persist" `undefined`:
 *  - `'unreadable'`: the Node's source couldn't be read this round (file
 *    changed/shrank since indexing) — not a hardware-adequacy signal at
 *    all, so it must never count toward the reactive degenerate-rate
 *    tracker below (Boundaries & Constraints: the *rate* signal is about
 *    slow/empty *generation*, not source-availability churn).
 *  - `'degenerate'`: a genuine empty/whitespace-only model response, or (for
 *    the local backend) the prompt timing out — exactly the two conditions
 *    the Code Map's own tracker description names. Counts toward the rate.
 *  - `'success'`: a real, non-empty summary. Counts toward the rate's
 *    denominator, never its numerator.
 *
 * `cloud-summary-generator.ts`'s `createCloudSummarizer` uses this same
 * shape (Code Map: "same shape as the local path") — an authentication/rate-
 * limit failure from the Anthropic API is neither of these; it's thrown
 * instead, so it reaches `generateSummaries`' own generic catch-and-log path
 * uncounted toward the (local-hardware-specific) degenerate rate.
 */
export type SummarizeOutcome =
  | { kind: 'success'; text: string }
  | { kind: 'unreadable' }
  | { kind: 'degenerate'; reason: 'empty' | 'timeout' };

/**
 * The pluggable per-Node summarization step (Story 1.6, Phase 2) —
 * `generateSummaries` drives one of these instead of knowing anything
 * backend-specific itself. `createLocalSummarizer` (below) and
 * `cloud-summary-generator.ts`'s `createCloudSummarizer` both produce one.
 */
export type SummarizeFn = (node: CodeMapNode, projectRoot: string) => Promise<SummarizeOutcome>;

/**
 * True for the specific error `withTimeout` throws — a real `instanceof`
 * check against `SummaryTimeoutError` (review finding, Medium), not a regex
 * matched against `withTimeout`'s own message text: this classification
 * decides what counts as a "degenerate" result for the whole hardware-
 * advisory feature, so it's checked against a type/tag `withTimeout` itself
 * controls, immune to an unrelated future wording change to its message.
 */
function isTimeoutError(error: unknown): error is SummaryTimeoutError {
  return error instanceof SummaryTimeoutError;
}

/**
 * Builds a `SummarizeFn` backed by the local GGUF model (Story 1.6, Phase 2
 * — this is the `LlamaChatSession` logic previously inlined directly in
 * `generateSummaries`/`summarizeNode`, unchanged in behavior, just extracted
 * behind the same pluggable interface `createCloudSummarizer` also
 * implements). Lazily resolves the shared, memoized model context
 * (`ensureModelContext`) on first use rather than requiring the caller to
 * await it up front — cheap after the first call, since that promise is
 * memoized for the process's lifetime (see `ensureModelContext`'s own doc
 * comment).
 */
export function createLocalSummarizer(model: LocalModelReady): SummarizeFn {
  return async (node, projectRoot) => {
    const source = await readNodeSource(projectRoot, node);
    if (source === undefined) {
      return { kind: 'unreadable' };
    }

    const { LlamaChatSession } = await loadNodeLlamaCppModule();
    const { sequence } = await ensureModelContext(model.path);

    // A fresh session per job (Design Notes) — shares the already-loaded
    // `sequence`, so this is a cheap wrapper, not a new model/context load.
    const session = new LlamaChatSession({ contextSequence: sequence });
    try {
      let response: string;
      try {
        // Timeout-wrapped (review finding, Medium) — see SUMMARY_PROMPT_
        // TIMEOUT_MS's comment for why a bounded, honest failure beats
        // letting one hung call stall the whole concurrency-1 queue forever.
        // A timeout here is itself one of the two degenerate conditions
        // (Story 1.5 Phase 3's Code Map) — caught and classified rather than
        // left to propagate to the generic error path below, which would
        // otherwise just log-and-skip it without it ever counting toward the
        // reactive hardware-advisory rate.
        response = await withTimeout(
          session.prompt(buildPrompt(node, source), { maxTokens: SUMMARY_MAX_TOKENS }),
          SUMMARY_PROMPT_TIMEOUT_MS,
          `summary prompt for ${node.id}`,
        );
      } catch (error) {
        if (isTimeoutError(error)) {
          return { kind: 'degenerate', reason: 'timeout' };
        }
        // A genuine, non-timeout failure (e.g. a native binding error) is not
        // one of the two documented degenerate conditions — rethrown so the
        // caller's existing catch-and-log path handles it exactly as before,
        // uncounted toward the hardware-advisory rate.
        throw error;
      }
      const text = normalizeSummaryText(response);
      return text.length > 0 ? { kind: 'success', text } : { kind: 'degenerate', reason: 'empty' };
    } finally {
      // Disposes only the session wrapper, not the shared sequence (default
      // `disposeSequence: false`) — the sequence is reused by the next job.
      session.dispose();
    }
  };
}

/** Batches individual completions into `onProgress` posts (Always/AD-8). */
function createProgressBatcher(onProgress: (updated: SummaryProgressUpdate[]) => void) {
  let pending: SummaryProgressUpdate[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    onProgress(batch);
  }

  function add(update: SummaryProgressUpdate): void {
    pending.push(update);
    if (pending.length >= PROGRESS_FLUSH_BATCH_SIZE) {
      flush();
      return;
    }
    timer ??= setTimeout(flush, PROGRESS_FLUSH_INTERVAL_MS);
  }

  return { add, flush };
}

export interface GenerateSummariesOptions {
  /** Absolute, OS-native path to the project root — source is read relative to this. */
  projectRoot: string;
  /** The Code Map's Nodes (already-fetched, Story 1.3) — filtered down to the eligible subset here. */
  nodes: CodeMapNode[];
  /** POSIX-relative paths (matching `CodeMapNode.file`) currently in the index's coverage gap set (FR5). */
  coverageGapFiles: ReadonlySet<string>;
  /**
   * The pluggable per-Node summarization step (Story 1.6, Phase 2) — built
   * by the caller (index.ts) via `createLocalSummarizer`/`cloud-summary-
   * generator.ts`'s `createCloudSummarizer` depending on the active backend.
   * `generateSummaries` itself is fully backend-agnostic; this is its only
   * point of contact with either model.
   */
  summarize: SummarizeFn;
  /**
   * The backend/model name persisted into `NodeRecord.summary.model` for
   * every Node this run successfully summarizes (Story 1.6, Phase 2 — was
   * previously always `model.model`, the local GGUF filename; now supplied
   * directly by the caller since `generateSummaries` no longer holds a
   * `LocalModelReady` to read it from).
   */
  modelName: string;
  /** Fired with each batched group of completions (Always/AD-8: never one call per Node). */
  onProgress: (updated: SummaryProgressUpdate[]) => void;
  /**
   * Story 1.5 Phase 3: fired at most once for this run, the moment the
   * rolling `{completed, degenerate}` count first crosses
   * `MIN_COMPLETED_FOR_ADVISORY`/`DEGENERATE_RATE_THRESHOLD` (Code Map:
   * "once per run, not repeated per subsequent Node"). Optional — omitted
   * entirely is a valid no-advisory-wanted caller, same as `isSuperseded`'s
   * own default.
   */
  onHardwareAdvisory?: () => void;
  /**
   * Checked before every merge-write/progress post — lets a caller (index.ts)
   * discard a superseded run's results (e.g. the user opened a different
   * project mid-generation) rather than letting a stale job corrupt the
   * now-active project's Node record store or post progress for a Node id
   * that may not even belong to the map on screen (the same
   * concurrency/correlation bug class node-record-store.ts's own module doc
   * already flags as "fixed twice elsewhere in this build"). Defaults to
   * always-current when omitted.
   */
  isSuperseded?: () => boolean;
}

/**
 * Generates one-line summaries for every eligible Node (FR5), bounded by a
 * concurrency-1 `p-queue` (Design Notes), merge-writing each result via the
 * store's `mergeNodeRecord` (AD-20 — this phase's first real caller) and
 * batching progress via `onProgress`. Resolves once every eligible Node has
 * been attempted (success or logged-and-skipped failure) — callers run this
 * in the background (never awaited alongside the Code Map response).
 */
export async function generateSummaries(options: GenerateSummariesOptions): Promise<void> {
  const {
    projectRoot,
    nodes,
    coverageGapFiles,
    summarize,
    modelName,
    onProgress,
    onHardwareAdvisory,
    isSuperseded = () => false,
  } = options;

  const eligible = nodes.filter(
    (node) => classifyNode(node, coverageGapFiles).summaryStatus === 'pending',
  );
  if (eligible.length === 0 || isSuperseded()) {
    return;
  }

  const queue = new PQueue({ concurrency: SUMMARY_QUEUE_CONCURRENCY });
  const batcher = createProgressBatcher((updated) => {
    if (isSuperseded()) {
      return;
    }
    onProgress(updated);
  });

  // Story 1.5 Phase 3: this run's rolling `{completed, degenerate}` count
  // (Code Map) — closed over by the queue jobs below, not shared across
  // `generateSummaries` calls, since each run gets its own fresh read on
  // "is this run's hardware struggling." `advisoryFired` makes the
  // once-per-run trigger idempotent even though `recordOutcome` itself is
  // only ever called from this single-concurrency queue (defense in depth,
  // matching this file's existing caution around this exact bug class).
  let completed = 0;
  let degenerate = 0;
  let advisoryFired = false;

  function recordOutcome(isDegenerate: boolean): void {
    completed += 1;
    if (isDegenerate) {
      degenerate += 1;
    }
    if (
      !advisoryFired &&
      completed >= MIN_COMPLETED_FOR_ADVISORY &&
      degenerate / completed >= DEGENERATE_RATE_THRESHOLD
    ) {
      advisoryFired = true;
      if (!isSuperseded()) {
        onHardwareAdvisory?.();
      }
    }
  }

  await Promise.all(
    eligible.map((node) =>
      queue.add(async () => {
        if (isSuperseded()) {
          return;
        }
        let outcome: SummarizeOutcome;
        try {
          outcome = await summarize(node, projectRoot);
        } catch (error) {
          console.error(
            `[graph-service] summary generation failed for ${node.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        if (isSuperseded()) {
          return;
        }
        if (outcome.kind === 'unreadable') {
          // Not a hardware-adequacy signal (Story 1.5 Phase 3's own
          // `SummarizeOutcome` doc comment) — the Node simply stays
          // `'pending'` for this session, same as before this phase.
          return;
        }
        if (outcome.kind === 'degenerate') {
          recordOutcome(true);
          return;
        }
        recordOutcome(false);
        // Wrapped (review finding, Medium — matching `summarizeNode`'s own
        // try/catch right above): an uncaught persistence error here would
        // otherwise reject this queued job's promise, which rejects the
        // outer `Promise.all` below, aborting `generateSummaries` before its
        // final `batcher.flush()` runs — while every other already-queued
        // job keeps executing fully detached, with nothing left awaiting or
        // logging their outcome. A failed merge-write skips only this
        // Node's progress post (nothing to tell the renderer is `'ready'`
        // if the write didn't actually happen) rather than taking the whole
        // batch down with it.
        try {
          mergeNodeRecord(node.id, {
            summary: { text: outcome.text, model: modelName, generatedAt: new Date().toISOString() },
          });
        } catch (error) {
          console.error(
            `[graph-service] failed to persist summary for ${node.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        batcher.add({ id: node.id, summary: outcome.text });
      }),
    ),
  );
  batcher.flush();
}
