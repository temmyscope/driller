/**
 * P4-7g: pins in the renderer — the pure toggle plan and save outcome
 * (`entryPins.ts`), the never-rejecting IPC helpers, and Revealed's re-listing
 * on a pin change (`revealView.ts`: `pinsRevision` owes a new listing, the
 * listing lands like a refresh — the drill beneath candidates still listed is
 * kept, an unpinned Node no longer a candidate leaves with its subtree — and
 * the view is not re-fitted), plus the pinned card copy.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENTRY_PINS_MAX,
  type CodeMapEdge,
  type CodeMapNode,
  type EntryCandidate,
  type EntryCandidatesResult,
  type EntryPinUpdateResult,
} from '@driller/ipc-contracts';

import {
  loadEntryPins,
  PIN_BUTTON_TEXT,
  pinSaveOutcome,
  planPinToggle,
  PIN_LIMIT_TEXT,
  PIN_SAVE_FAILED_TEXT,
  saveEntryPin,
} from './entryPins';
import {
  candidateAriaSuffix,
  candidateLoadedBy,
  collapseNode,
  expandNode,
  formatCandidateReason,
  formatCandidateReasonLine,
  initialRevealState,
  needsRevealListing,
  pinsListingFailedText,
  rebaseRevealHistory,
  refreshRevealState,
  restoreRevealSnapshot,
  revealCapText,
  revealDrillGraphFor,
  revealNoticeFor,
  revealStateOf,
  revealStatusText,
  type HistoryEntry,
  type RevealState,
  revealKey,
  revealListingReplyOutcome,
  revealRefitOnListing,
  startRevealListing,
  type HeldReveal,
} from './revealView';

/** Runs `fn` with `console.warn` silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

describe('planPinToggle and pinSaveOutcome', () => {
  it('sends one id: pin when not pinned, unpin when pinned', () => {
    assert.deepEqual(planPinToggle(['b', 'a'], 'c'), { kind: 'send', pinned: true });
    assert.deepEqual(planPinToggle(['b', 'a', 'c'], 'a'), { kind: 'send', pinned: false });
  });

  it('the 51st pin is refused before anything is sent; unpinning at the cap is fine', () => {
    const full = Array.from({ length: ENTRY_PINS_MAX }, (_, i) => `n${i}`);
    assert.deepEqual(planPinToggle(full, 'one-more'), { kind: 'limit' });
    assert.deepEqual(planPinToggle(full, 'n3'), { kind: 'send', pinned: false });
    assert.match(PIN_LIMIT_TEXT, /^Pin limit \(50\) reached/);
  });

  it("main's stored list wins; a change owes a listing, a limit, error or failed call does not", () => {
    assert.deepEqual(pinSaveOutcome({ previous: ['a'], result: { status: 'stored', pins: ['a', 'b'] } }), {
      pins: ['a', 'b'],
      message: null,
      changed: true,
    });
    assert.deepEqual(pinSaveOutcome({ previous: ['a'], result: { status: 'limit', pins: ['a'] } }), {
      pins: ['a'],
      message: PIN_LIMIT_TEXT,
      changed: false,
    });
    assert.deepEqual(pinSaveOutcome({ previous: ['a'], result: { status: 'error', message: 'unreadable' } }), {
      pins: ['a'],
      message: 'unreadable',
      changed: false,
    });
    assert.deepEqual(pinSaveOutcome({ previous: ['a'], result: null }), {
      pins: ['a'],
      message: PIN_SAVE_FAILED_TEXT,
      changed: false,
    });
    // Main's list differs from the one held here (another change landed): it is taken, and is a change.
    assert.deepEqual(pinSaveOutcome({ previous: ['a'], result: { status: 'stored', pins: ['x', 'a'] } }).pins, ['x', 'a']);
    assert.equal(pinSaveOutcome({ previous: ['a', 'b'], result: { status: 'stored', pins: ['b', 'a'] } }).changed, true);
    assert.equal(pinSaveOutcome({ previous: ['a'], result: { status: 'stored', pins: ['a'] } }).changed, false);
  });

  it('one stable button label (review round 1)', () => {
    assert.equal(PIN_BUTTON_TEXT, 'Pin as entry point');
  });
});

describe('loadEntryPins / saveEntryPin never reject', () => {
  it('load: null with no project, on a failure or a malformed reply (the toggle waits for a read)', { timeout: 5_000 }, async () => {
    assert.equal(await loadEntryPins(null, () => Promise.reject(new Error('never called'))), null);
    assert.deepEqual(await loadEntryPins('/p', (path) => Promise.resolve(path === '/p' ? ['a'] : [])), ['a']);
    await quietly(async () => {
      assert.equal(await loadEntryPins('/p', () => Promise.reject(new Error('down'))), null);
      assert.equal(
        await loadEntryPins('/p', () => {
          throw new Error('no preload method');
        }),
        null,
      );
    });
    assert.equal(await loadEntryPins('/p', () => Promise.resolve([3] as unknown as string[])), null);
  });

  it("save: sends one id and resolves with main's outcome, or null", { timeout: 5_000 }, async () => {
    const sent: unknown[] = [];
    assert.deepEqual(
      await saveEntryPin('/p', 'b', true, (path, id, pinned) => {
        sent.push([path, id, pinned]);
        return Promise.resolve({ status: 'stored', pins: ['a', 'b'] });
      }),
      { status: 'stored', pins: ['a', 'b'] },
    );
    assert.deepEqual(sent, [['/p', 'b', true]]);
    assert.deepEqual(await saveEntryPin('/p', 'b', true, () => Promise.resolve({ status: 'error', message: 'x' })), {
      status: 'error',
      message: 'x',
    });
    await quietly(async () => {
      assert.equal(await saveEntryPin('/p', 'a', true, () => Promise.reject(new Error('down'))), null);
      assert.equal(
        await saveEntryPin('/p', 'a', true, () => {
          throw new Error('sync');
        }),
        null,
      );
    });
    for (const bad of ['a', { status: 'stored', pins: [3] }, { status: 'error' }, { status: 'other', pins: [] }]) {
      assert.equal(await saveEntryPin('/p', 'a', true, () => Promise.resolve(bad as unknown as EntryPinUpdateResult)), null);
    }
  });
});

const PINNED: EntryCandidate = {
  id: 'serviceB',
  name: 'serviceB',
  file: 'src/services.ts',
  startLine: 1,
  endLine: 9,
  reach: 2,
  reason: { kind: 'pinned' },
};

describe('the pinned candidate copy', () => {
  it('"pinned by you" instead of the heuristic reason; the real reach stays, qualified', () => {
    assert.equal(formatCandidateReason(PINNED), 'reaches 2 Nodes in indexed code');
    assert.equal(formatCandidateReasonLine(PINNED), 'pinned by you · reaches 2 Nodes in indexed code');
    assert.equal(candidateAriaSuffix(PINNED), ', pinned entry point, reaches 2 Nodes');
    assert.equal(candidateLoadedBy(PINNED), null);
    assert.equal(candidateAriaSuffix({ ...PINNED, reason: { kind: 'no-callers' } }), ', entry candidate, reaches 2 Nodes');
  });
});

// The `path-trace-basic` graph (P4-7b).
const mapNode = (id: string): CodeMapNode => ({
  id,
  name: id,
  file: `src/${id}.ts`,
  startLine: 1,
  endLine: 9,
  kind: 'Function',
  summaryStatus: 'ready',
  riskSignals: [],
});
const edge = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });
const PTB_NODES = ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup', 'helper'].map(mapNode);
const PTB_EDGES: CodeMapEdge[] = [
  edge('handleRequest', 'serviceA'),
  edge('handleRequest', 'serviceB'),
  edge('serviceA', 'repository'),
  edge('serviceB', 'repository'),
  edge('repository', 'cacheLookup'),
  edge('cacheLookup', 'repository'),
];
const candidate = (id: string, reach: number, kind: 'pinned' | 'no-callers' = 'no-callers'): EntryCandidate => ({
  id,
  name: id,
  file: `src/${id}.ts`,
  startLine: 1,
  endLine: 9,
  reach,
  reason: { kind },
});
const found = (candidates: EntryCandidate[]): Extract<EntryCandidatesResult, { status: 'found' }> => ({
  status: 'found',
  candidates,
  totalQualifying: candidates.length,
});
const nodeIdsOf = (held: HeldReveal) =>
  held.listing.status === 'ready' ? held.listing.state.entries.filter((e) => e.kind === 'node').map((e) => (e.kind === 'node' ? e.id : '')) : [];

describe('Revealed re-lists on a pin change, like a refresh on the same map', () => {
  const key = revealKey('/p', null);
  const graph = revealDrillGraphFor(null, PTB_NODES, PTB_EDGES);
  const drilled = expandNode(initialRevealState(found([candidate('handleRequest', 4)])), graph.adjacency, graph.reachById, 'handleRequest');
  const held: HeldReveal = { key, mapStamp: PTB_EDGES, listing: { status: 'ready', state: drilled, totalQualifying: 1 } };

  /** Lands `result` as the listing for pins revision `revision` on the same map fetch. */
  function relist(from: HeldReveal, revision: number, result: EntryCandidatesResult): HeldReveal {
    assert.equal(needsRevealListing(from, key, PTB_EDGES, revision), true, 'a pin change owes a listing');
    const loading = startRevealListing(from, key, PTB_EDGES, revision);
    assert.equal(
      loading.listing.status === 'loading' ? loading.listing.previous : null,
      from.listing.status === 'ready' ? from.listing.state : undefined,
      'the drilled state stays drawn',
    );
    const outcome = revealListingReplyOutcome({
      isLatest: true,
      requestedSection: null,
      currentSection: null,
      held: loading,
      key,
      mapStamp: PTB_EDGES,
      result,
      pinsRevision: revision,
      drillGraph: graph,
    });
    assert.equal(outcome.kind, 'apply');
    return outcome.kind === 'apply' ? outcome.held : from;
  }

  it('the same revision on the same map owes nothing; a new one does', () => {
    assert.equal(needsRevealListing(held, key, PTB_EDGES), false);
    assert.equal(needsRevealListing(held, key, PTB_EDGES, 0), false);
    assert.equal(needsRevealListing(held, key, PTB_EDGES, 1), true);
    // No pin change: the P4-7d shape exactly (no `pinsRevision` field).
    assert.deepEqual(Object.keys(startRevealListing(held, key, PTB_EDGES)), ['key', 'mapStamp', 'listing']);
  });

  it('pinning serviceB: it tops column 0, the drill under handleRequest is kept (serviceB shown there as a ref)', () => {
    const after = relist(held, 1, found([candidate('serviceB', 2, 'pinned'), candidate('handleRequest', 4)]));
    assert.equal(after.pinsRevision, 1);
    assert.equal(needsRevealListing(after, key, PTB_EDGES, 1), false, 'settled for this revision');
    assert.ok(after.listing.status === 'ready');
    const state = after.listing.state;
    assert.deepEqual(state.candidates.map((c) => c.id), ['serviceB', 'handleRequest']);
    assert.deepEqual(nodeIdsOf(after).sort(), ['handleRequest', 'repository', 'serviceA', 'serviceB']);
    assert.equal(state.revealed.get('serviceB')?.depth, 0, 'a candidate now, never a second card');
    assert.ok(state.entries.some((e) => e.kind === 'ref' && e.parentId === 'handleRequest' && e.targetId === 'serviceB'));
  });

  it('unpinning a Node that is not a heuristic candidate removes it, with its subtree; the rest stays', () => {
    const pinned = relist(held, 1, found([candidate('serviceB', 2, 'pinned'), candidate('handleRequest', 4)]));
    assert.ok(pinned.listing.status === 'ready');
    const withDrill: HeldReveal = {
      ...pinned,
      listing: {
        ...pinned.listing,
        state: expandNode(pinned.listing.state, graph.adjacency, graph.reachById, 'serviceB'),
      },
    };
    const unpinned = relist(
      { ...withDrill, listing: withDrill.listing },
      2,
      found([candidate('handleRequest', 4)]),
    );
    assert.ok(unpinned.listing.status === 'ready');
    assert.deepEqual(unpinned.listing.state.candidates.map((c) => c.id), ['handleRequest']);
    assert.ok(!unpinned.listing.state.entries.some((e) => e.parentId === 'serviceB'), "serviceB's subtree left with it");
  });

  it('a reply for an earlier pins revision is ignored', () => {
    const loading = startRevealListing(held, key, PTB_EDGES, 2);
    assert.deepEqual(
      revealListingReplyOutcome({
        isLatest: true,
        requestedSection: null,
        currentSection: null,
        held: loading,
        key,
        mapStamp: PTB_EDGES,
        result: found([candidate('handleRequest', 4)]),
        pinsRevision: 1,
      }),
      { kind: 'ignore' },
    );
  });

  it('a pin change never moves the view (sameFetch); a refresh still may', () => {
    assert.equal(revealRefitOnListing({ revealDrawn: true, hadPrevious: true, userMoved: false, sameFetch: true }), false);
    assert.equal(revealRefitOnListing({ revealDrawn: true, hadPrevious: true, userMoved: false, sameFetch: false }), true);
    assert.equal(revealRefitOnListing({ revealDrawn: true, hadPrevious: true, userMoved: false }), true);
  });
});

describe('review round 1: a pin change keeps the reveal steps that still apply', () => {
  const key = revealKey('/p', null);
  const graph = revealDrillGraphFor(null, PTB_NODES, PTB_EDGES);
  const s0 = initialRevealState(found([candidate('handleRequest', 4)]));
  const s1 = expandNode(s0, graph.adjacency, graph.reachById, 'handleRequest');
  const step = (before: RevealState, after: RevealState, focusId: string): HistoryEntry => ({
    kind: 'reveal',
    before,
    after,
    focusId,
    name: focusId,
    step: 'expand',
    key,
    mapStamp: PTB_EDGES,
  });
  const relistOnto = (previous: RevealState, candidates: EntryCandidate[]) => {
    const fresh = initialRevealState(found(candidates));
    const landed = refreshRevealState(previous, fresh, graph);
    return { landed, rebase: (state: RevealState) => refreshRevealState(state, fresh, graph) };
  };

  it('pinning: the expand step is rebased (still chained to the drawn state), so Back still undoes it', () => {
    const history = { stack: [{ kind: 'node' as const, id: 'x' }, step(s0, s1, 'handleRequest')], index: 1 };
    const { landed, rebase } = relistOnto(s1, [candidate('serviceB', 2, 'pinned'), candidate('handleRequest', 4)]);
    const next = rebaseRevealHistory(history, { key, mapStamp: PTB_EDGES, previous: s1, landed, rebase });
    assert.equal(next.stack.length, 2);
    assert.equal(next.index, 1);
    const entry = next.stack[1];
    assert.ok(entry?.kind === 'reveal');
    assert.equal(entry.after, landed, 'the step ends at the state now drawn');
    const held: HeldReveal = { key, mapStamp: PTB_EDGES, pinsRevision: 1, listing: { status: 'ready', state: landed, totalQualifying: 2 } };
    const undone = restoreRevealSnapshot(held, key, entry, entry.after, entry.before);
    assert.ok(undone !== null && undone.listing.status === 'ready');
    assert.deepEqual(undone.listing.state.candidates.map((c) => c.id), ['serviceB', 'handleRequest'], 'undo keeps the new pins');
    assert.equal(undone.listing.state.revealed.has('serviceA'), false, 'the expand is undone');
  });

  it("unpinning drops only the step whose Node left (its subtree went with it); the others stay", () => {
    const pinned = relistOnto(s1, [candidate('serviceB', 2, 'pinned'), candidate('handleRequest', 4)]).landed;
    // serviceB came over with its ref beneath it: collapsing it is a step.
    const s2 = collapseNode(pinned, 'serviceB');
    assert.notEqual(s2, pinned);
    const history = { stack: [step(s0, s1, 'handleRequest'), step(pinned, s2, 'serviceB')], index: 1 };
    // Re-chain the first step onto the pinned state, as a first rebase would have.
    const chained = rebaseRevealHistory(history, {
      key,
      mapStamp: PTB_EDGES,
      previous: s1,
      landed: pinned,
      rebase: relistOnto(s1, [candidate('serviceB', 2, 'pinned'), candidate('handleRequest', 4)]).rebase,
    });
    const { landed, rebase } = relistOnto(s2, [candidate('handleRequest', 4)]);
    const next = rebaseRevealHistory(chained, { key, mapStamp: PTB_EDGES, previous: s2, landed, rebase });
    assert.deepEqual(
      next.stack.map((entry) => (entry.kind === 'reveal' ? entry.focusId : entry.id)),
      ['handleRequest'],
    );
    assert.equal(next.index, 0);
  });

  it("a step whose Node is no longer revealed is dropped even when the snapshots still differ", () => {
    const history = { stack: [step(s0, s1, 'handleRequest')], index: 0 };
    // A rebase that removes the step's own Node but keeps the rest of the difference.
    const strip = (state: RevealState) =>
      revealStateOf(
        state.candidates,
        state.entries.filter((entry) => !(entry.kind === 'node' && entry.id === 'handleRequest')),
      );
    const landed = strip(s1);
    const next = rebaseRevealHistory(history, { key, mapStamp: PTB_EDGES, previous: s1, landed, rebase: strip });
    assert.deepEqual(next.stack, []);
  });

  it('a step for another map fetch is left to the stale-step purge', () => {
    const other = { ...step(s0, s1, 'handleRequest'), mapStamp: [] as CodeMapEdge[] };
    const history = { stack: [other], index: 0 };
    const { landed, rebase } = relistOnto(s1, [candidate('handleRequest', 4)]);
    assert.equal(rebaseRevealHistory(history, { key, mapStamp: PTB_EDGES, previous: s1, landed, rebase }).stack[0], other);
  });
});

describe('review round 1: a failed pin-change listing keeps the candidates drawn', () => {
  const key = revealKey('/p', null);
  const state = initialRevealState(found([candidate('handleRequest', 4)]));
  const held: HeldReveal = { key, mapStamp: PTB_EDGES, listing: { status: 'ready', state, totalQualifying: 20 } };

  it('error or "map refreshing" on the same fetch: the previous state stays, with a status line, and the next show retries', () => {
    const loading = startRevealListing(held, key, PTB_EDGES, 1);
    assert.deepEqual(loading.listing, { status: 'loading', previous: state, previousTotal: 20 });
    for (const message of ['Graph Service is not running.', 'The map is refreshing; try again once it has loaded.']) {
      const outcome = revealListingReplyOutcome({
        isLatest: true,
        requestedSection: null,
        currentSection: null,
        held: loading,
        key,
        mapStamp: PTB_EDGES,
        result: { status: 'error', message },
        pinsRevision: 1,
        sameFetch: true,
      });
      assert.ok(outcome.kind === 'apply');
      assert.deepEqual(outcome.held.listing, { status: 'ready', state, totalQualifying: 20, pinsListingFailed: message });
      assert.equal(outcome.held.listing.status === 'ready' && outcome.held.listing.state, state, 'the very state drawn');
      const notice = revealNoticeFor(outcome.held, key, 1);
      assert.deepEqual(notice, { kind: 'status', text: pinsListingFailedText(message) });
      assert.equal(revealStatusText({ switchStatus: null, notice, capText: null }), pinsListingFailedText(message));
      assert.equal(needsRevealListing(outcome.held, key, PTB_EDGES, 1), true, 'retried on the next show');
    }
  });

  it('a refresh (another fetch) that fails is still the error notice', () => {
    const loading = startRevealListing(held, key, PTB_EDGES, 1);
    const outcome = revealListingReplyOutcome({
      isLatest: true,
      requestedSection: null,
      currentSection: null,
      held: loading,
      key,
      mapStamp: PTB_EDGES,
      result: { status: 'error', message: 'boom' },
      pinsRevision: 1,
    });
    assert.ok(outcome.kind === 'apply');
    assert.deepEqual(outcome.held.listing, { status: 'error', message: 'boom' });
  });
});

describe('review round 1: the cap line counts pins outside the heuristic candidates', () => {
  const key = revealKey('/p', null);
  const heldWith = (candidates: EntryCandidate[], totalQualifying: number): HeldReveal => ({
    key,
    mapStamp: PTB_EDGES,
    listing: { status: 'ready', state: initialRevealState(found(candidates)), totalQualifying },
  });
  const twelve = Array.from({ length: 12 }, (_, i) => candidate(`h${i}`, 20 - i));

  it('"Showing N pinned + 12 of M candidates"; without pins, unchanged; nothing cut, no line', () => {
    assert.equal(
      revealCapText(heldWith([candidate('p1', 1, 'pinned'), candidate('p2', 0, 'pinned'), ...twelve], 2 + 30), key),
      'Showing 2 pinned + 12 of 30 candidates (most reach first)',
    );
    assert.equal(revealCapText(heldWith(twelve, 30), key), 'Showing 12 of 30 candidates (most reach first)');
    assert.equal(revealCapText(heldWith([candidate('p1', 1, 'pinned'), ...twelve], 13), key), null);
  });
});
