/**
 * P5-a review round 1 (never a silent reset): the session notice that says
 * why the map re-indexed and PR Review reset — the open project's checkout
 * moved. Driven by the `headMoved` main adds to a HEAD-triggered re-index's
 * statuses (`apps/desktop/main/head-drift.ts`'s `tagHeadMove`). Pure, so
 * every transition is unit-tested; `App.tsx` renders it and clears a
 * finished one on the next user action. The diff is never re-run
 * automatically (Ask First).
 */
import type { GraphServiceStatusMessage, HeadMove } from '@driller/ipc-contracts';

export interface HeadMoveNotice {
  /** `reindexing` while it runs; `reindexed` / `failed` once it ended (cleared on the next user action). */
  phase: 'reindexing' | 'reindexed' | 'failed';
  text: string;
}

const moved = ({ indexedHead, currentHead }: HeadMove): string =>
  `Checkout moved ${indexedHead.slice(0, 7)} → ${currentHead.slice(0, 7)}`;

/** The text for each phase. */
export function headMoveNoticeText(phase: HeadMoveNotice['phase'], move: HeadMove): string {
  switch (phase) {
    case 'reindexing':
      return `${moved(move)} — re-indexing; compute the diff again when it finishes.`;
    case 'reindexed':
      return `${moved(move)} — re-indexed; compute the diff again.`;
    case 'failed':
      return `${moved(move)} — the re-index didn't complete; use Retry, then compute the diff again.`;
  }
}

/**
 * The notice after `status` (already filtered to the open project):
 *  - a HEAD-triggered `indexing` / `indexed` / index-attempt `error` → that phase;
 *  - any other `indexing` / `indexed` (a re-index for another reason) → none;
 *  - an `error` / `exited` without one while re-indexing → none;
 *  - anything else → unchanged.
 */
export function nextHeadMoveNotice(current: HeadMoveNotice | null, status: GraphServiceStatusMessage): HeadMoveNotice | null {
  if (status.state === 'indexing' || status.state === 'indexed' || status.state === 'error') {
    const move = status.headMoved;
    if (move !== undefined) {
      const phase = status.state === 'indexing' ? 'reindexing' : status.state === 'indexed' ? 'reindexed' : 'failed';
      return { phase, text: headMoveNoticeText(phase, move) };
    }
    if (status.state !== 'error') {
      return null;
    }
  }
  // A Graph Service failure mid re-index (no `headMoved`): the degraded
  // notice speaks for it; a "re-indexing" line would be stale.
  if ((status.state === 'error' || status.state === 'exited') && current?.phase === 'reindexing') {
    return null;
  }
  return current;
}

/** Whether the next user action clears it (only once the re-index has ended). */
export const headMoveNoticeClearsOnUserAction = (notice: HeadMoveNotice | null): boolean =>
  notice !== null && notice.phase !== 'reindexing';
