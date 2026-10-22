/** P5-a review round 1: the checkout-moved notice's transitions (pure). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphServiceStatusMessage, HeadMove } from '@driller/ipc-contracts';

import { headMoveNoticeClearsOnUserAction, headMoveNoticeText, nextHeadMoveNotice, type HeadMoveNotice } from './headMoveNotice';

const MOVE: HeadMove = { indexedHead: 'abc1234'.padEnd(40, 'f'), currentHead: 'def5678'.padEnd(40, '0') };
const P = '/p';
const AT = '2026-10-15T00:00:00.000Z';
const indexing = (headMoved?: HeadMove): GraphServiceStatusMessage => ({ state: 'indexing', path: P, at: AT, ...(headMoved ? { headMoved } : {}) });
const indexed = (headMoved?: HeadMove): GraphServiceStatusMessage => ({
  state: 'indexed', path: P, at: AT, nodes: 1, edges: 0, elapsedMs: 1, ...(headMoved ? { headMoved } : {}),
});
const error = (headMoved?: HeadMove): GraphServiceStatusMessage => ({ state: 'error', at: AT, message: 'x', ...(headMoved ? { path: P, headMoved } : {}) });
const notice = (phase: HeadMoveNotice['phase']): HeadMoveNotice => ({ phase, text: headMoveNoticeText(phase, MOVE) });

describe('headMoveNotice', () => {
  it('the three texts, with 7-character SHAs', () => {
    assert.equal(headMoveNoticeText('reindexing', MOVE), 'Checkout moved abc1234 → def5678 — re-indexing; compute the diff again when it finishes.');
    assert.equal(headMoveNoticeText('reindexed', MOVE), 'Checkout moved abc1234 → def5678 — re-indexed; compute the diff again.');
    assert.equal(
      headMoveNoticeText('failed', MOVE),
      "Checkout moved abc1234 → def5678 — the re-index didn't complete; use Retry, then compute the diff again.",
    );
  });

  it('a HEAD-triggered indexing / indexed / error sets its phase', () => {
    assert.deepEqual(nextHeadMoveNotice(null, indexing(MOVE)), notice('reindexing'));
    assert.deepEqual(nextHeadMoveNotice(notice('reindexing'), indexed(MOVE)), notice('reindexed'));
    assert.deepEqual(nextHeadMoveNotice(notice('reindexing'), error(MOVE)), notice('failed'));
  });

  it('an ordinary indexing / indexed clears it; a service failure mid re-index clears it; anything else keeps it', () => {
    assert.equal(nextHeadMoveNotice(notice('reindexed'), indexing()), null);
    assert.equal(nextHeadMoveNotice(notice('reindexing'), indexed()), null);
    assert.equal(nextHeadMoveNotice(notice('reindexing'), error()), null);
    assert.equal(nextHeadMoveNotice(notice('reindexing'), { state: 'exited', at: AT, code: 1 }), null);
    assert.deepEqual(nextHeadMoveNotice(notice('reindexed'), error()), notice('reindexed'));
    assert.deepEqual(nextHeadMoveNotice(notice('reindexed'), { state: 'alive', at: AT }), notice('reindexed'));
    assert.equal(nextHeadMoveNotice(null, { state: 'alive', at: AT }), null);
  });

  it('only a finished notice clears on the next user action', () => {
    assert.equal(headMoveNoticeClearsOnUserAction(null), false);
    assert.equal(headMoveNoticeClearsOnUserAction(notice('reindexing')), false);
    assert.equal(headMoveNoticeClearsOnUserAction(notice('reindexed')), true);
    assert.equal(headMoveNoticeClearsOnUserAction(notice('failed')), true);
  });
});
