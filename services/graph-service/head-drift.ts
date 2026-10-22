/**
 * P5-a (founder decision 6.1, 2026-10-15): the pure half of the HEAD-drift
 * check `index.ts` runs at the start of every diff-scope computation and on
 * main's focus-time `graphService:checkHead`.
 *
 * Kept free of imports so it is unit-testable without loading `index.ts`.
 */

export interface HeadDriftInputs {
  /** HEAD when the index now served started (set only on that index's success). */
  indexedHead: string | undefined;
  /** HEAD now (`readHeadCommit`). */
  currentHead: string | undefined;
  /** The current HEAD an automatic re-index was already asked for, if any. */
  autoReindexHead: string | undefined;
  /** Whether any index is running right now. */
  indexInFlight: boolean;
  /**
   * Review round 1: a re-index was just requested (`headChanged` posted) and
   * main's index request may still be on its way — within
   * `REINDEX_REQUEST_GRACE_MS`, and no index has started since.
   */
  reindexRequestPending: boolean;
}

/** Review round 1: how long after a `headChanged` post a re-index counts as under way before its index starts. */
export const REINDEX_REQUEST_GRACE_MS = 10_000;

export type HeadDriftDecision =
  | { drift: false }
  | {
      drift: true;
      indexedHead: string;
      currentHead: string;
      /** Post `graphService:headChanged` (main re-indexes) — at most once per distinct current HEAD, never mid-index. */
      requestReindex: boolean;
      /**
       * Review round 1: a re-index is under way (requested now, in flight,
       * or requested moments ago) — else it failed or main ignored it, and
       * the diff error must not say "Re-indexing now".
       */
      reindexing: boolean;
    };

/**
 * Drift only when both HEADs are known and differ: an unknown HEAD (no repo,
 * unborn HEAD, git missing, a timeout) never counts, so it can never cause a
 * re-index.
 */
export function assessHeadDrift(inputs: HeadDriftInputs): HeadDriftDecision {
  const { indexedHead, currentHead } = inputs;
  if (indexedHead === undefined || currentHead === undefined || indexedHead === currentHead) {
    return { drift: false };
  }
  const requestReindex = !inputs.indexInFlight && inputs.autoReindexHead !== currentHead;
  return {
    drift: true,
    indexedHead,
    currentHead,
    requestReindex,
    reindexing: requestReindex || inputs.indexInFlight || inputs.reindexRequestPending,
  };
}

/**
 * The diff-scope error a drifted checkout returns instead of a diff, with
 * 7-character SHAs. While a re-index is under way: the spec's frozen
 * wording. Review round 1 (a founder-visible refinement of that wording):
 * when none is (the automatic re-index failed, or main ignored it), the text
 * never claims one — it points at Retry instead.
 */
export function headDriftErrorMessage(indexedHead: string, currentHead: string, reindexing = true): string {
  const heads = `HEAD ${indexedHead.slice(0, 7)} → ${currentHead.slice(0, 7)}`;
  return reindexing
    ? `The checkout changed since this project was indexed (${heads}). Re-indexing now — compute the diff scope again when the map refreshes.`
    : `The checkout moved since the last index (${heads}) and the re-index didn't complete — use Retry (or re-open the project), then compute the diff scope again.`;
}

/**
 * `autoReindexHead` after an index that started at `headAtStart` succeeds:
 * cleared once an index has caught up with the HEAD it was asked for (so a
 * later move back to it can re-index again), and on a project switch; kept
 * otherwise (the checkout moved again during that index).
 */
export function autoReindexHeadAfterSuccess(
  autoReindexHead: string | undefined,
  headAtStart: string | undefined,
  sameProject: boolean,
): string | undefined {
  return !sameProject || autoReindexHead === headAtStart ? undefined : autoReindexHead;
}
