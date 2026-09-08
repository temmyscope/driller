/**
 * Cloud-model summary generation (Story 1.6, Phase 2, FR6, AD-8, AD-16).
 *
 * `createCloudSummarizer(apiKey)` is the cloud counterpart to
 * `summary-generator.ts`'s `createLocalSummarizer(model)` — both produce a
 * `SummarizeFn` that `generateSummaries` drives identically, so this module
 * knows nothing about the job pool, eligibility filter, progress batching,
 * or Node-record persistence (all of that stays in `summary-generator.ts`,
 * unchanged per this story's Never constraint).
 *
 * Reads a Node's source the same way the local path does
 * (`summary-generator.ts`'s `readNodeSource`, AD-16 — off disk, in this same
 * Graph Service subprocess, never through the renderer's `readSourceRange`
 * IPC path), then sends only that source snippet to the Anthropic API via
 * `messages.create` — no other project content is ever transmitted (FR6,
 * AD-16, this story's Boundaries & Constraints).
 *
 * The `Anthropic` client is constructed once per `createCloudSummarizer`
 * call (one call per generation run, from index.ts) with `maxRetries`
 * raised above the SDK's own default (this story's Always constraint) —
 * retry/backoff for a transient failure relies on the SDK's own handling
 * first (Always), so this module adds no retry/backoff logic of its own on
 * top of it — only a bounded overall timeout per call (review finding,
 * Medium — mirroring the local path's own reasoning: with the job pool's
 * concurrency fixed at 1, one hung/slow `messages.create` call would
 * otherwise stall every remaining Node in the queue indefinitely, and the
 * SDK's own retries only cover *transient* failures, not a single call that
 * never settles at all). `Anthropic.AuthenticationError`/`RateLimitError`
 * are classified via `instanceof` (typed exceptions, never string-matching)
 * purely for a more specific log line; either way the error is rethrown so
 * it reaches `generateSummaries`' own generic catch-and-log-and-skip path,
 * uncounted toward the local-hardware-specific degenerate-rate tracker
 * (Story 1.5 Phase 3) — an API auth/rate-limit/timeout failure says nothing
 * about this machine's own hardware.
 *
 * Once an `AuthenticationError` occurs for one Node in a given
 * `createCloudSummarizer` run, the stored key won't become valid mid-run —
 * every subsequent Node would just repeat the identical doomed network call
 * (review finding, Low-Medium). `createCloudSummarizer` trips a
 * closure-scoped flag on the first classified `AuthenticationError` and
 * skips the real network call for every Node after it for the rest of that
 * run, still rethrowing (so each skipped Node is still logged and left
 * `'pending'` by `generateSummaries`' generic catch path, exactly as if it
 * had actually been attempted and failed). A fresh `createCloudSummarizer`
 * call (e.g. once the key is fixed and generation is re-kicked) gets a
 * fresh, untripped flag.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CodeMapNode } from '@driller/ipc-contracts';
import { normalizeSummaryText, readNodeSource, type SummarizeFn } from './summary-generator';

/**
 * `claude-sonnet-5` (this story's Design Notes): the epics text frames cloud
 * as trading local compute for "a stronger model" than the local 0.5B/1.5B
 * tiers, which Sonnet clearly is, without Opus's cost/latency for a bulk
 * one-line-summary-per-Node workload that may run across hundreds of Nodes
 * in one project. Exported so index.ts can use the exact same string as the
 * `modelName` persisted into `NodeRecord.summary.model` for a cloud run.
 */
export const CLOUD_SUMMARY_MODEL = 'claude-sonnet-5';

// Small enough to keep a generated summary genuinely one line/sentence,
// mirroring the local path's own SUMMARY_MAX_TOKENS bound for the same
// reason — an expensive, unbounded generation per Node isn't needed for a
// one-sentence summary.
const CLOUD_SUMMARY_MAX_TOKENS = 256;

// Raised above the SDK's own default (2) for unattended batch runs (Always,
// AD-8) — this generation run may need to summarize hundreds of Nodes
// serially (the job pool's concurrency stays at 1, unchanged per this
// story's Never constraint), so a single Node's transient failure (a 429, a
// brief network blip) shouldn't need a whole extra `generateSummaries`
// invocation to recover from. Retry/backoff itself is entirely the SDK's
// own handling (Always) — this module adds no timeout/backoff logic on top.
const CLOUD_MAX_RETRIES = 5;

// A bounded overall timeout around one `messages.create` call (review
// finding, Medium — see this module's doc comment). Generous for a single
// one-line-summary request even accounting for the SDK's own retries
// (`CLOUD_MAX_RETRIES`) backing off between attempts; well short of the
// local path's SUMMARY_PROMPT_TIMEOUT_MS × queue-depth risk, but still long
// enough that a legitimately slow-but-working request isn't cut off early.
const CLOUD_SUMMARY_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The specific error `withTimeout` (below) rejects with. Not shared with
 * `summary-generator.ts`'s own `SummaryTimeoutError` (review-considered,
 * rejected): that type is tightly coupled to the local path's own
 * `SummarizeOutcome` 'degenerate'/'timeout' classification, which a cloud
 * timeout deliberately does NOT use — see this module's doc comment for why
 * a cloud timeout just rethrows into `generateSummaries`' generic
 * catch-and-log path instead. A distinct, dedicated type here still gives
 * `withTimeout`'s own caller something real to identify if it ever needs
 * to, without pulling in the local path's unrelated classification baggage.
 */
class CloudSummaryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudSummaryTimeoutError';
  }
}

/**
 * Races `promise` against a timeout, rejecting with a
 * `CloudSummaryTimeoutError` if `ms` elapses first. Duplicated from
 * `summary-generator.ts`'s (and mcp-client.ts's/model-manager.ts's) own
 * `withTimeout` — this codebase's established precedent (see those modules'
 * own doc comments) is to duplicate this small helper per module rather
 * than share/export it, since each caller pairs it with its own
 * timeout-error type. Does not cancel the underlying `messages.create`
 * call; it only stops the caller from waiting on it forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CloudSummaryTimeoutError(`${label} timed out after ${ms}ms`));
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

function buildCloudSystemPrompt(node: CodeMapNode): string {
  return [
    `You are documenting a codebase for another engineer. Below is the real source of a ${node.kind.toLowerCase()} named "${node.name}", from ${node.file}.`,
    'Write exactly one concise, plain-language sentence describing what it does. Do not repeat the code. Do not use markdown. Reply with only the sentence.',
  ].join('\n');
}

/**
 * Calls the Anthropic API for one Node's already-read `source`, returning
 * the raw (not yet normalized) response text. Classifies
 * `AuthenticationError`/`RateLimitError` distinctly for logging (typed
 * `instanceof` checks, never string-matching on the error message) before
 * rethrowing every error unchanged — see this module's doc comment for why
 * nothing here is caught-and-classified into a `SummarizeOutcome` the way
 * the local path's timeout is.
 */
async function callCloud(client: Anthropic, node: CodeMapNode, source: string): Promise<string> {
  let response: Anthropic.Message;
  try {
    response = await withTimeout(
      client.messages.create({
        model: CLOUD_SUMMARY_MODEL,
        max_tokens: CLOUD_SUMMARY_MAX_TOKENS,
        system: buildCloudSystemPrompt(node),
        messages: [{ role: 'user', content: source }],
      }),
      CLOUD_SUMMARY_TIMEOUT_MS,
      `cloud summary request for ${node.id}`,
    );
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error(
        `[graph-service] cloud summary generation: authentication failed for ${node.id} (check the stored API key): ${error.message}`,
      );
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error(
        `[graph-service] cloud summary generation: rate limited for ${node.id} after the SDK's own retries: ${error.message}`,
      );
    }
    throw error;
  }

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );
  if (!textBlock) {
    // Review finding, Low: a missing text block (a refusal, a future
    // SDK content-block type, or a genuinely empty response) is otherwise
    // indistinguishable from a real blank reply once collapsed to `''`
    // below. Logs only the content blocks' own `type`s — never the raw
    // content itself (this module's "never log content" discipline, AD-16).
    console.warn(
      `[graph-service] cloud summary generation: no text content block in the response for ${node.id} (content block types: ${
        response.content.map((block) => block.type).join(', ') || '(none)'
      }).`,
    );
  }
  return textBlock?.text ?? '';
}

/**
 * Builds a `SummarizeFn` backed by the Anthropic cloud API (Story 1.6, Phase
 * 2) — the cloud counterpart to `summary-generator.ts`'s
 * `createLocalSummarizer`. Constructs the `Anthropic` client once, up front,
 * reused across every Node this generation run summarizes.
 */
export function createCloudSummarizer(apiKey: string): SummarizeFn {
  const client = new Anthropic({ apiKey, maxRetries: CLOUD_MAX_RETRIES });
  // See this module's doc comment — tripped on the first classified
  // AuthenticationError this run, short-circuiting every Node after it.
  let authenticationFailed = false;

  return async (node, projectRoot) => {
    const source = await readNodeSource(projectRoot, node);
    if (source === undefined) {
      return { kind: 'unreadable' };
    }

    if (authenticationFailed) {
      throw new Error(
        `Skipping ${node.id}: cloud generation already failed authentication earlier in this run — the stored key won't become valid mid-run.`,
      );
    }

    let response: string;
    try {
      response = await callCloud(client, node, source);
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        authenticationFailed = true;
      }
      throw error;
    }

    const text = normalizeSummaryText(response);
    // Empty-text responses classify as 'degenerate' (reason: 'empty'), same
    // shape as the local path (this story's Code Map).
    return text.length > 0 ? { kind: 'success', text } : { kind: 'degenerate', reason: 'empty' };
  };
}
