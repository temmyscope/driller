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
 *
 * Story 1.8 (Phase 4) adds `regenerateNodeSummary`, the on-demand
 * single-Node counterpart to `generateSummaries`'s whole-project batch —
 * used only by an explicit Node Detail "Regenerate" action (index.ts's
 * `handleRegenerateNodeRequest`), never auto-triggered. It bypasses
 * `generateSummaries`'s `'pending'`-only eligibility filter (a stale Node is
 * already `'ready'`) entirely by design, but its `summarize()` call still
 * MUST go through the exact same `sharedSummaryQueue` `generateSummaries`
 * uses (Spec Change Log Round 1 — the first implementation attempt called
 * `summarize()` directly, with no serialization against an in-progress
 * whole-project batch or another overlapping regenerate call): a single
 * local GGUF model instance has no meaningful way to run two generations in
 * parallel (see this comment's next paragraph), so every local-model call —
 * regardless of which of these two functions it comes from — funnels
 * through the one concurrency-1 queue.
 *
 * Review round 2 found that sharing one FIFO queue traded the round-1
 * concurrency bug for a new starvation one: a regenerate call issued while a
 * whole-project batch was still processing pending Nodes could queue behind
 * the ENTIRE remaining batch, run long past main's own round-trip timeout,
 * and then still persist via `mergeNodeRecord` after main had already given
 * up and reported a false timeout to the renderer. Fixed two ways:
 * `regenerateNodeSummary` enqueues at `{priority: 1}` so it jumps ahead of
 * `generateSummaries`'s default-priority jobs still waiting in the queue
 * (though not one already dequeued and running); and `regenerateNodeSummary`
 * takes a `revalidate` callback, re-checked immediately before persisting,
 * so a job that DOES end up waiting a while can never write into a
 * meanwhile-switched project or a meanwhile-coverage-gapped Node.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
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

/**
 * The one shared job queue every local-model `summarize()` call funnels
 * through, regardless of whether it came from `generateSummaries`'s
 * whole-project batch or `regenerateNodeSummary`'s single-Node on-demand
 * path (Story 1.8 Phase 4, Spec Change Log Round 1). A single, module-level
 * singleton rather than one `PQueue` created per call (as `generateSummaries`
 * used to do internally): a fresh per-call queue would only ever bound
 * concurrency *within* that one call, letting an overlapping regenerate
 * call — or a second overlapping regenerate call for a different Node —
 * spin up its own `LlamaChatSession` against the same shared, memoized
 * model `sequence` concurrently, exactly the unreachable-by-design state
 * this concurrency-1 bound exists to prevent everywhere else in this file.
 * Cloud-backed jobs share this same queue too, purely for code-path
 * uniformity (Code Map) — the cloud path has no such hardware constraint,
 * but a queue shared by both backends still correctly serializes the rare
 * case of a cloud regenerate overlapping a cloud batch against the same
 * underlying rate limits.
 */
export const sharedSummaryQueue = new PQueue({ concurrency: SUMMARY_QUEUE_CONCURRENCY });

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
 * disagree about which Nodes are eligible/ineligible/already-done. Exported
 * (Story 1.8, Phase 4) so index.ts's `handleRegenerateNodeRequest` can
 * re-check the exact same coverage-gap classification before regenerating —
 * that handler intentionally bypasses `generateSummaries`'s `'pending'`-only
 * filter, but must still respect this same coverage-gap exclusion (Spec
 * Change Log Round 1), and reusing this function (rather than re-deriving
 * `coverageGapFiles.has(node.file)` inline) guarantees it can never silently
 * drift out of sync with what this file's other two callers already agree
 * on.
 */
export function classifyNode(
  node: CodeMapNode,
  coverageGapFiles: ReadonlySet<string>,
): { summaryStatus: SummaryStatus; summary?: string; stale?: boolean } {
  if (coverageGapFiles.has(node.file)) {
    return { summaryStatus: 'coverage-gap' };
  }
  const record = getNodeRecord(node.id);
  if (record?.summary) {
    // Story 1.8 Phase 3: thread the record's `stale` flag through the same
    // classification step that already threads `summary` — `record.stale`
    // is itself already tri-state (`true`/`false`/`undefined`; see
    // `NodeRecord.stale`'s own doc), so passing it straight through
    // preserves "absent means not evaluated" rather than coercing it to a
    // default `false`.
    return { summaryStatus: 'ready', summary: record.summary.text, stale: record.stale };
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
 * Reads a Node's exact, untruncated source line range directly off disk
 * (graph-service-local `fs.readFile`, AD-16 — never the renderer's
 * `readSourceRange` IPC path). Returns `undefined` (logged, not thrown)
 * rather than failing the whole batch when a Node's source can't be read —
 * e.g. the file changed or shrank since the last index; that Node simply
 * stays `'pending'` for this session rather than blocking every other
 * Node's generation.
 *
 * The shared core behind two callers with genuinely different needs:
 * `readNodeSource` (below) truncates this for the LLM prompt's sake;
 * `captureSourceBaseline` (Story 1.8, Phase 1, review finding — High) must
 * hash the true, untruncated range, since hashing a truncated-and-annotated
 * stand-in would silently stop reflecting any edit past the truncation
 * point for exactly the largest Nodes, defeating the whole staleness
 * mechanism for them. Not exported — both callers within this file/module
 * boundary reach it directly; `cloud-summary-generator.ts` still only ever
 * needs `readNodeSource`'s own (truncated) output.
 */
async function readNodeSourceRaw(projectRoot: string, node: CodeMapNode): Promise<string | undefined> {
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
  return lines.slice(node.startLine - 1, node.endLine).join('\n');
}

/**
 * Reads a Node's exact source line range, truncated to `MAX_SOURCE_CHARS`
 * for the LLM prompt's sake (see `MAX_SOURCE_CHARS`'s own comment) — never
 * changed by Story 1.8 Phase 1's review pass; only its untruncated core
 * (`readNodeSourceRaw`, above) gained a second caller.
 *
 * Exported (Story 1.6, Phase 2): shared by both `createLocalSummarizer`
 * below and `cloud-summary-generator.ts`'s `createCloudSummarizer` — reading
 * a Node's source off disk is identical regardless of which backend ends up
 * summarizing it, so this stays the one implementation both call.
 */
export async function readNodeSource(projectRoot: string, node: CodeMapNode): Promise<string | undefined> {
  const content = await readNodeSourceRaw(projectRoot, node);
  if (content === undefined) {
    return undefined;
  }
  // Truncated, not rejected (review finding, Medium) — see MAX_SOURCE_CHARS'
  // comment.
  return content.length > MAX_SOURCE_CHARS
    ? `${content.slice(0, MAX_SOURCE_CHARS)}\n… (truncated)`
    : content;
}

/**
 * Captures a staleness baseline for `node`'s source at the moment its
 * summary was generated (Story 1.8, Phase 1): a real `fs.stat` of the
 * Node's source file (`sourceMtimeMs`/`sourceSize`) plus a SHA-256 content
 * hash (mirroring `node-record-store.ts`'s own existing use of `createHash`
 * for project-slug hashing) of the exact, untruncated source range
 * `readNodeSourceRaw` re-reads for this Node — the same range the summary
 * was actually generated from.
 *
 * Hashes `readNodeSourceRaw`'s output, never `readNodeSource`'s (review
 * finding, High): `readNodeSource` truncates anything over
 * `MAX_SOURCE_CHARS` and appends a literal "… (truncated)" marker for the
 * LLM prompt's sake — hashing that would mean an edit past the truncation
 * point never changes the stored hash, silently defeating staleness
 * detection for exactly the largest Nodes. `captureSourceBaseline` needs
 * the real bytes, not the LLM-facing stand-in.
 *
 * `absolutePath` is resolved via `path.resolve` (review finding, Low),
 * matching `readNodeSourceRaw`/`readNodeSource`'s own resolution — dormant
 * today since `CodeMapNode.file` is always POSIX-relative (Story 1.7), but
 * keeps this function's own `fs.stat` call and its `readNodeSourceRaw` call
 * agreeing on the same path if that ever changed.
 *
 * Never throws: baseline capture is best-effort provenance, not part of the
 * summary write's own success/failure. A failure here (e.g. the file
 * vanished in the narrow window between generation and this call) is
 * logged and resolves to `undefined` so the caller can simply omit the
 * three fields from that Node's merge-write rather than blocking or
 * failing the summary write itself. When the source simply can't be
 * re-read, `readNodeSourceRaw` has already logged its own warning for that
 * failure (review finding, Low) — this function doesn't log a second,
 * redundant one for the same event.
 */
export async function captureSourceBaseline(
  projectRoot: string,
  node: CodeMapNode,
): Promise<{ sourceMtimeMs: number; sourceSize: number; sourceHash: string } | undefined> {
  try {
    const absolutePath = path.resolve(projectRoot, node.file);
    const [stats, source] = await Promise.all([stat(absolutePath), readNodeSourceRaw(projectRoot, node)]);
    if (source === undefined) {
      return undefined;
    }
    const sourceHash = createHash('sha256').update(source).digest('hex');
    return { sourceMtimeMs: stats.mtimeMs, sourceSize: stats.size, sourceHash };
  } catch (error) {
    console.warn(
      `[graph-service] staleness baseline: failed to capture for ${node.id}; omitting baseline for this write: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Detects staleness for every Node with a full recorded baseline (Story 1.8,
 * Phase 2) — run fire-and-forget from `index.ts`'s `handleGetCodeMapRequest`
 * on every `graphService:getCodeMap` fetch, since this app has no separate
 * incremental-refresh mechanism (Design Notes): today, this *is* "the next
 * index refresh" the feature description means.
 *
 * A Node is skipped entirely (its `stale` field left exactly as it already
 * is) unless it has a full baseline — `summary.sourceMtimeMs`/`sourceSize`/
 * `sourceHash` all present (Phase 1 omits all three together on capture
 * failure, never a partial triple, so checking `sourceHash` alone is
 * sufficient to know the other two are there too). This deliberately never
 * touches a Node with no `summary` at all, or one whose baseline capture
 * failed — nothing to compare against.
 *
 * Hybrid check, matching the Code Map's own description: a fresh `fs.stat`
 * (`path.resolve`, matching `captureSourceBaseline`) first — if both mtime
 * and size still match the baseline exactly, the source is unchanged and no
 * hash is computed at all (the common case: cheap, no disk read of the
 * source itself). Only a mismatch on either falls back to a real content-
 * hash comparison, via the same module-private `readNodeSourceRaw` and
 * hashing approach `captureSourceBaseline` uses, so a re-save with no actual
 * content change (mtime/size churn alone) never produces a false positive.
 *
 * Writes only `{ stale }` via `mergeNodeRecord` (AD-20) — never `summary` —
 * so this can never disturb what Phase 1 already proved non-clobbering by
 * construction. The write (and the hash re-read leading to it) is skipped
 * outright when `isStale` matches the record's current `stale` value
 * (nothing to change) or when `isSuperseded()` reports this pass's project
 * is no longer the active one — re-checked right before each write, the
 * same race shape Phase 1's own review found and fixed for
 * `captureSourceBaseline`'s merge-write.
 *
 * Never throws: a `fs.stat`/read failure for one Node (e.g. the file was
 * deleted since baseline capture) is logged and that Node is simply skipped
 * for this pass, rather than aborting detection for every other Node. The
 * `mergeNodeRecord` write itself is likewise wrapped (review finding, Low —
 * matching every other `mergeNodeRecord` call site in this file/index.ts,
 * including `captureSourceBaseline`'s own call): an uncaught write error
 * there would otherwise reject this whole fire-and-forget pass as an
 * unhandled rejection instead of being logged and skipped, aborting
 * detection for every remaining Node behind it.
 */
export async function detectStaleness(
  projectRoot: string,
  nodes: CodeMapNode[],
  isSuperseded: () => boolean,
): Promise<void> {
  for (const node of nodes) {
    if (isSuperseded()) {
      return;
    }
    const record = getNodeRecord(node.id);
    const baseline = record?.summary;
    if (
      baseline?.sourceHash === undefined ||
      baseline.sourceMtimeMs === undefined ||
      baseline.sourceSize === undefined
    ) {
      // No full baseline yet (Phase 1 never captured one, capture failed, or
      // no summary exists at all) — not evaluated; `stale` stays untouched.
      continue;
    }

    let isStale: boolean;
    try {
      const absolutePath = path.resolve(projectRoot, node.file);
      const stats = await stat(absolutePath);
      if (stats.mtimeMs === baseline.sourceMtimeMs && stats.size === baseline.sourceSize) {
        isStale = false;
      } else {
        const source = await readNodeSourceRaw(projectRoot, node);
        if (source === undefined) {
          // Source couldn't be re-read this round (e.g. shrank below the
          // indexed range) — `readNodeSourceRaw` already logged its own
          // warning for this; nothing safe to compare against, so this
          // Node is simply skipped for this pass rather than guessed at.
          continue;
        }
        const sourceHash = createHash('sha256').update(source).digest('hex');
        isStale = sourceHash !== baseline.sourceHash;
      }
    } catch (error) {
      console.warn(
        `[graph-service] staleness detection: failed to check ${node.id}; skipping for this pass: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    if (isSuperseded()) {
      return;
    }
    if (record?.stale === isStale) {
      // No change from the record's current state — skip the write
      // entirely (nothing for `mergeNodeRecord` to actually do).
      continue;
    }
    try {
      mergeNodeRecord(node.id, { stale: isStale });
    } catch (error) {
      console.error(
        `[graph-service] staleness detection: failed to persist stale=${isStale} for ${node.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
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

  // Story 1.8 Phase 4, Spec Change Log Round 1: the shared module-level
  // queue, not a fresh `PQueue` scoped to this one call — see
  // `sharedSummaryQueue`'s own doc comment for why a per-call queue would
  // fail to serialize against an overlapping `regenerateNodeSummary` call.
  const queue = sharedSummaryQueue;
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
          // Story 1.8 Phase 1: captured right before this same merge-write,
          // never a second write — a baseline-capture failure resolves to
          // `undefined` (never throws) and simply omits the three fields
          // below rather than blocking or failing this summary write.
          const baseline = await captureSourceBaseline(projectRoot, node);
          // Re-checked (review finding, Medium): `captureSourceBaseline`'s
          // own `await` above is a new async gap between the `isSuperseded`
          // check already done right after `summarize()` resolved (above)
          // and this merge-write — long enough for the run to become
          // superseded (e.g. the user opened a different project) in
          // between. Without this second check, the write below would
          // proceed anyway, reopening the exact cross-project record-store
          // write race this file's own module doc already flags as "fixed
          // twice elsewhere in this build."
          if (isSuperseded()) {
            return;
          }
          mergeNodeRecord(node.id, {
            summary: {
              text: outcome.text,
              model: modelName,
              generatedAt: new Date().toISOString(),
              ...baseline,
            },
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

/**
 * Result of a `regenerateNodeSummary` revalidation check (review round 2) —
 * `ok: false` carries a user-facing reason so the caller can resolve with an
 * explicit error rather than a generic one.
 */
export type RegenerateRevalidationResult = { ok: true } | { ok: false; message: string };

/**
 * Regenerates exactly one Node's summary on demand (Story 1.8, Phase 4) —
 * the single-Node counterpart to `generateSummaries`'s whole-project batch,
 * used only from an explicit Node Detail "Regenerate" action (index.ts's
 * `handleRegenerateNodeRequest`), never auto-triggered. Deliberately runs
 * with NO eligibility filter (`classifyNode` is not consulted here at all —
 * a stale Node this is called for is already `'ready'`, which
 * `generateSummaries`'s own filter would otherwise skip) and outside the
 * whole-project `activeGenerationRunId`/`activeSummaryGenerationId`
 * supersession gates those belong to index.ts, not this function.
 *
 * The `summarize()` call itself is still routed through `sharedSummaryQueue`
 * (Spec Change Log Round 1) — the same concurrency-1 queue
 * `generateSummaries` uses — so this can never run a local-model generation
 * concurrently with another regenerate call or an in-progress whole-project
 * batch, regardless of how many callers invoke this function at once.
 * Enqueued at `{priority: 1}` (review round 2), above `generateSummaries`'s
 * own default-priority batch jobs — an on-demand regenerate reliably jumps
 * ahead of whatever whole-project batch jobs are still *waiting* in the
 * queue, rather than queuing behind the entire remaining batch. Priority
 * only reorders jobs still waiting, though: it cannot preempt a job the
 * queue has already dequeued and started running (concurrency is fixed at
 * 1), so this can still sit behind up to one already-in-flight job — see
 * index.ts's `REGENERATE_NODE_TIMEOUT_MS`-mirroring backstop, sized with
 * that in mind.
 *
 * `revalidate` (review round 2) is called by the caller (index.ts) to
 * re-check the request is still valid against LIVE state, not just what was
 * true when the request was first made — the queue-priority fix above still
 * leaves a real wait window (behind one already-running job, or briefly
 * behind other regenerate calls) during which the open project could switch
 * or this Node could newly enter the coverage-gap set. Checked three times,
 * mirroring `generateSummaries`'s own already-review-fixed
 * `isSuperseded()` checkpoints: right after this job is dequeued (before
 * even calling `summarize()`), right after `summarize()` resolves, and
 * again right before the final `mergeNodeRecord` write (the async gap
 * `captureSourceBaseline` opens, exactly like `generateSummaries`'s own
 * doc comment on its matching check explains). Defaults to always-valid
 * when omitted (matches `generateSummaries`'s own `isSuperseded` default).
 *
 * On success, persists the new summary and a refreshed staleness baseline
 * together with `mergeNodeRecord(id, {summary: {...}, stale: false})` in one
 * atomic merge-write (AD-20, Always: "never a separate clear-then-write").
 * On any failure — unreadable source, a degenerate (empty/timeout) result,
 * a failed revalidation, or a persistence error — resolves to
 * `{status: 'error', ...}` and never calls `mergeNodeRecord` at all, leaving
 * the existing `summary`/baseline/`stale` fields completely untouched
 * (Always).
 */
export async function regenerateNodeSummary(
  node: CodeMapNode,
  projectRoot: string,
  summarize: SummarizeFn,
  modelName: string,
  revalidate: () => RegenerateRevalidationResult = () => ({ ok: true }),
): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
  return sharedSummaryQueue.add(
    async (): Promise<{ status: 'ok' } | { status: 'error'; message: string }> => {
      // Checked right after dequeue, before doing any real work — catches a
      // project switch/coverage-gap change that happened while this job sat
      // waiting behind an in-progress batch (review round 2).
      const dequeueCheck = revalidate();
      if (!dequeueCheck.ok) {
        return { status: 'error', message: dequeueCheck.message };
      }

      let outcome: SummarizeOutcome;
      try {
        outcome = await summarize(node, projectRoot);
      } catch (error) {
        return {
          status: 'error',
          message: `Regeneration failed for ${node.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      // Re-checked after the (potentially long) summarize() call resolves —
      // same reasoning as `generateSummaries`'s own matching checkpoint.
      const postSummarizeCheck = revalidate();
      if (!postSummarizeCheck.ok) {
        return { status: 'error', message: postSummarizeCheck.message };
      }

      if (outcome.kind === 'unreadable') {
        return {
          status: 'error',
          message: `Couldn't read the source for ${node.id} — it may have changed or been deleted since the last index.`,
        };
      }
      if (outcome.kind === 'degenerate') {
        return {
          status: 'error',
          message:
            outcome.reason === 'timeout'
              ? `Regenerating the summary for ${node.id} timed out.`
              : `Regenerating the summary for ${node.id} produced an empty result.`,
        };
      }

      // Story 1.8 Phase 1: captured right before this same merge-write, same
      // as `generateSummaries`'s own per-Node block — a baseline-capture
      // failure resolves to `undefined` (never throws) and simply omits the
      // three baseline fields from the write below rather than blocking or
      // failing the summary write itself.
      const baseline = await captureSourceBaseline(projectRoot, node);

      // Re-checked once more (review round 2, mirroring `generateSummaries`'s
      // own review-fixed check here): `captureSourceBaseline`'s own `await`
      // above is a new async gap since the last check — long enough for a
      // project switch or coverage-gap change to land in between. Without
      // this, the write below would proceed anyway, persisting into what
      // may now be the wrong project's record store.
      const preWriteCheck = revalidate();
      if (!preWriteCheck.ok) {
        return { status: 'error', message: preWriteCheck.message };
      }

      try {
        // AD-20: one atomic merge-write, never a separate clear-then-write —
        // `stale: false` lands in the same call as the fresh `summary`.
        mergeNodeRecord(node.id, {
          summary: {
            text: outcome.text,
            model: modelName,
            generatedAt: new Date().toISOString(),
            ...baseline,
          },
          stale: false,
        });
      } catch (error) {
        return {
          status: 'error',
          message: `Failed to persist the regenerated summary for ${node.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      return { status: 'ok' };
    },
    { priority: 1 },
  );
}
