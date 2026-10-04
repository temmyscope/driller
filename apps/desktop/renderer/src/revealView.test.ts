/**
 * P4-7d: the Revealed view's pure functions (`revealView.ts`) — the reveal
 * state, the layered layout, the population filter, the reason copy, the held
 * listing's lifecycle (keyed by project, section and map fetch), the
 * out-of-order reply rule, the notice choice and the hidden-Node target.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapEdge, CodeMapNode, EntryCandidate, EntryCandidatesResult } from '@driller/ipc-contracts';

import type { CanvasPopulation, FoldedCanvasNode } from './CodeMap';
import {
  candidateAriaSuffix,
  decideRevealView,
  drawnRevealState,
  isCanvasRevealNotice,
  revealCapText,
  REVEAL_SWITCH_STATUS_MS,
  revealEndsFirstFitWait,
  revealRefitOnListing,
  revealStatusText,
  revealViewRequestForToggle,
  EMPTY_REVEAL_STATE,
  ENTRY_CANDIDATES_LOADING_TEXT,
  formatCandidateReason,
  formatCandidateReasonLine,
  heldRevealFor,
  hiddenNavigationTarget,
  initialRevealState,
  layeredLayout,
  needsRevealListing,
  NO_ENTRY_CANDIDATES_SENTENCE,
  NODE_COLUMN_GAP,
  NODE_ROW_GAP,
  revealedPopulation,
  revealKey,
  revealListingOf,
  revealListingReplyOutcome,
  revealNoticeFor,
  revealSwitchMessage,
  startRevealListing,
  type HeldReveal,
  type RevealState,
} from './revealView';

function candidate(id: string, reach: number, reason: EntryCandidate['reason'] = { kind: 'no-callers' }): EntryCandidate {
  return { id, name: id.slice(id.lastIndexOf(':') + 1), file: 'src/entry.ts', startLine: 1, endLine: 5, reach, reason };
}

function mapNode(id: string): CodeMapNode {
  return {
    id,
    name: id,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: [],
  };
}

const edge = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });

const found = (candidates: EntryCandidate[]): Extract<EntryCandidatesResult, { status: 'found' }> => ({
  status: 'found',
  candidates,
  totalQualifying: candidates.length,
});

// The `path-trace-basic` fixture's one candidate (P4-7b): handleRequest, reach 4.
const HANDLE_REQUEST = candidate('fixtures/path-trace-basic/entry.ts::handleRequest', 4);

describe('initialRevealState', () => {
  it('reveals every candidate in column 0 with no parent', () => {
    const state = initialRevealState(found([HANDLE_REQUEST, candidate('b', 3)]));
    assert.deepEqual(state.candidates, [HANDLE_REQUEST, candidate('b', 3)]);
    assert.deepEqual(
      [...state.revealed],
      [
        [HANDLE_REQUEST.id, { depth: 0, parentId: null }],
        ['b', { depth: 0, parentId: null }],
      ],
    );
  });
});

describe('layeredLayout', () => {
  it('puts path-trace-basic’s one candidate at the origin of column 0', () => {
    assert.deepEqual([...layeredLayout(initialRevealState(found([HANDLE_REQUEST])))], [[HANDLE_REQUEST.id, { x: 0, y: 0 }]]);
  });

  it('orders a column by reach descending, then id; column = depth × NODE_COLUMN_GAP, row × NODE_ROW_GAP', () => {
    const state = initialRevealState(found([candidate('c', 5), candidate('a', 9), candidate('b', 5)]));
    assert.deepEqual(Object.fromEntries(layeredLayout(state)), {
      a: { x: 0, y: 0 },
      b: { x: 0, y: NODE_ROW_GAP },
      c: { x: 0, y: 2 * NODE_ROW_GAP },
    });
  });

  it('orders a deeper column by its parents’ rows first', () => {
    const state: RevealState = {
      candidates: [candidate('p1', 9), candidate('p2', 3)],
      revealed: new Map([
        ['p1', { depth: 0, parentId: null }],
        ['p2', { depth: 0, parentId: null }],
        ['z-child-of-p1', { depth: 1, parentId: 'p1' }],
        ['a-child-of-p2', { depth: 1, parentId: 'p2' }],
      ]),
    };
    assert.deepEqual(Object.fromEntries(layeredLayout(state)), {
      p1: { x: 0, y: 0 },
      p2: { x: 0, y: NODE_ROW_GAP },
      'z-child-of-p1': { x: NODE_COLUMN_GAP, y: 0 },
      'a-child-of-p2': { x: NODE_COLUMN_GAP, y: NODE_ROW_GAP },
    });
  });

  it('never depends on the order of its input', () => {
    const entries: [string, { depth: number; parentId: string | null }][] = [
      ['r1', { depth: 0, parentId: null }],
      ['r2', { depth: 0, parentId: null }],
      ['r3', { depth: 0, parentId: null }],
      ['k1', { depth: 1, parentId: 'r2' }],
      ['k2', { depth: 1, parentId: 'r1' }],
      ['k3', { depth: 1, parentId: 'r1' }],
      ['g1', { depth: 2, parentId: 'k3' }],
    ];
    const candidates = [candidate('r1', 4), candidate('r2', 4), candidate('r3', 7)];
    const expected = Object.fromEntries(layeredLayout({ candidates, revealed: new Map(entries) }));
    const reversed = Object.fromEntries(
      layeredLayout({ candidates: [...candidates].reverse(), revealed: new Map([...entries].reverse()) }),
    );
    const rotated = Object.fromEntries(
      layeredLayout({ candidates: [candidates[1]!, candidates[2]!, candidates[0]!], revealed: new Map([...entries.slice(3), ...entries.slice(0, 3)]) }),
    );
    assert.deepEqual(reversed, expected);
    assert.deepEqual(rotated, expected);
    assert.deepEqual(expected.r3, { x: 0, y: 0 });
    assert.deepEqual(expected.k2, { x: NODE_COLUMN_GAP, y: 0 });
    assert.deepEqual(expected.k1, { x: NODE_COLUMN_GAP, y: 2 * NODE_ROW_GAP });
  });
});

describe('revealedPopulation', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(mapNode);
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'd')];
  const folded: FoldedCanvasNode = {
    folded: true,
    id: 'types.ts::T',
    name: 'T',
    kind: 'Interface',
    file: 'types.ts',
    startLine: 1,
    endLine: 3,
  } as FoldedCanvasNode;
  const population: CanvasPopulation = {
    riskNodes: nodes,
    riskEdges: edges,
    canvasNodes: [...nodes, folded],
    canvasEdges: [...edges, { source: 'a', target: folded.id, kind: 'USAGE' }],
    foldedNodes: [folded],
  };
  const state: RevealState = {
    candidates: [candidate('a', 3)],
    revealed: new Map([
      ['a', { depth: 0, parentId: null }],
      ['b', { depth: 1, parentId: 'a' }],
    ]),
  };

  it('draws only revealed ids, and only edges with both ends revealed', () => {
    const drawn = revealedPopulation(population, state);
    assert.deepEqual(
      drawn.canvasNodes.map((node) => node.id),
      ['a', 'b'],
    );
    assert.deepEqual(drawn.mapNodes.map((node) => node.id), ['a', 'b']);
    assert.deepEqual(drawn.canvasEdges, [edge('a', 'b')]);
    assert.deepEqual(drawn.foldedNodes, []);
  });

  it('never touches what the numbers read: riskNodes and riskEdges are the same arrays', () => {
    const drawn = revealedPopulation(population, state);
    assert.equal(drawn.riskNodes, population.riskNodes);
    assert.equal(drawn.riskEdges, population.riskEdges);
    assert.equal(drawn.riskNodes.length, 4);
    assert.equal(drawn.riskEdges.length, 4);
  });

  it('an empty reveal set draws nothing', () => {
    const drawn = revealedPopulation(population, EMPTY_REVEAL_STATE);
    assert.deepEqual([drawn.canvasNodes, drawn.canvasEdges, drawn.mapNodes], [[], [], []]);
  });
});

describe('candidate copy', () => {
  it('states the reason in indexed code, with the reach', () => {
    assert.equal(formatCandidateReason(HANDLE_REQUEST), 'no callers in indexed code · reaches 4 Nodes');
    assert.equal(formatCandidateReasonLine(HANDLE_REQUEST), 'no callers in indexed code · reaches 4 Nodes');
    assert.equal(candidateAriaSuffix(HANDLE_REQUEST), ', entry candidate, reaches 4 Nodes');
    assert.equal(candidateAriaSuffix(undefined), '');
  });

  it('adds the files that run it at load', () => {
    const loaded = candidate('createWindow', 12, { kind: 'no-callers', loadedBy: ['main/index.ts'], loadedByTotal: 1 });
    assert.equal(
      formatCandidateReasonLine(loaded),
      'no callers in indexed code · reaches 12 Nodes · run at load by main/index.ts',
    );
    const many = candidate('x', 3, { kind: 'no-callers', loadedBy: ['a.ts', 'b.ts', 'c.ts'], loadedByTotal: 5 });
    assert.equal(
      formatCandidateReasonLine(many),
      'no callers in indexed code · reaches 3 Nodes · run at load by a.ts, b.ts, c.ts and 2 more',
    );
  });

  it('never says "the entry point"', () => {
    for (const text of [
      formatCandidateReasonLine(HANDLE_REQUEST),
      candidateAriaSuffix(HANDLE_REQUEST),
      NO_ENTRY_CANDIDATES_SENTENCE,
      ENTRY_CANDIDATES_LOADING_TEXT,
      revealSwitchMessage('x'),
    ]) {
      assert.doesNotMatch(text, /the entry point/i);
    }
  });
});

describe('the held reveal state', () => {
  const stamp: CodeMapEdge[] = [];
  const key = revealKey('/repo', null);
  const ready: HeldReveal = { key, mapStamp: stamp, listing: revealListingOf(found([HANDLE_REQUEST])) };

  it('is keyed by project and section', () => {
    assert.notEqual(revealKey('/repo', 'api'), revealKey('/repo', null));
    assert.notEqual(revealKey('/repo', 'api'), revealKey('/other', 'api'));
    assert.equal(heldRevealFor(ready, key), ready);
  });

  it('a toggle back to Revealed on the same map restores the held state, with no new listing', () => {
    assert.equal(needsRevealListing(ready, key, stamp), false);
    assert.deepEqual(drawnRevealState(ready, key), initialRevealState(found([HANDLE_REQUEST])));
  });

  it('a section switch drops it: nothing restored, a new listing owed', () => {
    const apiKey = revealKey('/repo', 'api');
    assert.equal(heldRevealFor(ready, apiKey), null);
    assert.equal(needsRevealListing(ready, apiKey, stamp), true);
    assert.equal(drawnRevealState(ready, apiKey), EMPTY_REVEAL_STATE);
    assert.deepEqual(startRevealListing(ready, apiKey, stamp).listing, { status: 'loading', previous: null });
  });

  it('a refresh (new map fetch) owes a new listing and keeps the previous state drawn meanwhile', () => {
    const refreshed: CodeMapEdge[] = [];
    assert.equal(needsRevealListing(ready, key, refreshed), true);
    const loading = startRevealListing(ready, key, refreshed);
    assert.equal(loading.mapStamp, refreshed);
    assert.deepEqual(drawnRevealState(loading, key), initialRevealState(found([HANDLE_REQUEST])));
    assert.deepEqual(revealNoticeFor(loading, key, 1), { kind: 'loading', text: ENTRY_CANDIDATES_LOADING_TEXT });
  });

  it('a failed listing is retried when Revealed is shown again; none is not', () => {
    assert.equal(needsRevealListing({ key, mapStamp: stamp, listing: { status: 'error', message: 'x' } }, key, stamp), true);
    assert.equal(needsRevealListing({ key, mapStamp: stamp, listing: { status: 'none' } }, key, stamp), false);
  });

  it('maps each settled result', () => {
    assert.deepEqual(revealListingOf({ status: 'none' }), { status: 'none' });
    assert.deepEqual(revealListingOf({ status: 'error', message: 'boom' }), { status: 'error', message: 'boom' });
  });
});

describe('revealListingReplyOutcome: out-of-order replies are dropped', () => {
  const stamp: CodeMapEdge[] = [];
  const key = revealKey('/repo', 'api');
  const loading = startRevealListing(null, key, stamp);
  const base = {
    isLatest: true,
    requestedSection: 'api' as string | null,
    currentSection: 'api' as string | null,
    held: loading,
    key,
    mapStamp: stamp,
    result: found([HANDLE_REQUEST]) as EntryCandidatesResult,
  };

  it('applies the latest reply for the section and map on screen', () => {
    assert.deepEqual(revealListingReplyOutcome(base), {
      kind: 'apply',
      held: { key, mapStamp: stamp, listing: { status: 'ready', state: initialRevealState(found([HANDLE_REQUEST])), totalQualifying: 1 } },
    });
  });

  it('a stale reply (a later request started) is ignored', () => {
    // The same guard CodeMap uses (`createLatestRequestGuard`'s contract).
    let latest = 0;
    const begin = () => ++latest;
    const first = begin();
    begin();
    assert.deepEqual(revealListingReplyOutcome({ ...base, isLatest: first === latest }), { kind: 'ignore' });
  });

  it('a reply for another section (the echoed section no longer on screen) is ignored', () => {
    assert.deepEqual(revealListingReplyOutcome({ ...base, currentSection: 'web' }), { kind: 'ignore' });
    assert.deepEqual(revealListingReplyOutcome({ ...base, requestedSection: null }), { kind: 'ignore' });
  });

  it('a reply for a dropped or replaced held state is ignored (project switch, reload)', () => {
    assert.deepEqual(revealListingReplyOutcome({ ...base, held: null }), { kind: 'ignore' });
    assert.deepEqual(revealListingReplyOutcome({ ...base, held: { ...loading, mapStamp: [] } }), { kind: 'ignore' });
    assert.deepEqual(
      revealListingReplyOutcome({ ...base, held: startRevealListing(null, revealKey('/other', 'api'), stamp) }),
      { kind: 'ignore' },
    );
  });

  it('an unknown-section reply goes to the section fallback, naming the requested section', () => {
    assert.deepEqual(
      revealListingReplyOutcome({ ...base, result: { status: 'unknown-section', section: 'api', knownSections: ['web'] } }),
      { kind: 'unknown-section', section: 'api' },
    );
  });
});

describe('revealNoticeFor: never an empty canvas without a notice', () => {
  const stamp: CodeMapEdge[] = [];
  const key = revealKey('/repo', null);
  const held = (listing: HeldReveal['listing']): HeldReveal => ({ key, mapStamp: stamp, listing });

  it('none → the warning notice with its sentence', () => {
    assert.deepEqual(revealNoticeFor(held({ status: 'none' }), key, 0), {
      kind: 'none',
      tone: 'warning',
      sentence:
        'No entry candidates found in indexed code (every Node has a caller, or reaches fewer than 3 Nodes).',
    });
    assert.equal(drawnRevealState(held({ status: 'none' }), key), EMPTY_REVEAL_STATE);
  });

  it('error → the error notice with the message', () => {
    assert.deepEqual(revealNoticeFor(held({ status: 'error', message: 'Graph Service is not running.' }), key, 0), {
      kind: 'error',
      tone: 'error',
      sentence: 'Couldn’t list entry candidates: Graph Service is not running.',
    });
  });

  it('loading (or nothing held yet) → the loading line; ready with cards drawn → no notice', () => {
    assert.equal(revealNoticeFor(null, key, 0)?.kind, 'loading');
    assert.equal(revealNoticeFor(held({ status: 'loading', previous: null }), key, 0)?.kind, 'loading');
    assert.equal(revealNoticeFor(held(revealListingOf(found([HANDLE_REQUEST]))), key, 1), null);
  });

  it('review round 1: a ready listing that draws nothing here → the stale notice, never an empty canvas', () => {
    const notice = revealNoticeFor(held(revealListingOf(found([HANDLE_REQUEST]))), key, 0);
    assert.deepEqual(notice, {
      kind: 'stale',
      tone: 'error',
      sentence: 'Couldn’t show the entry candidates: none of them is on the map on screen.',
    });
    assert.equal(isCanvasRevealNotice(notice), true);
    assert.equal(isCanvasRevealNotice({ kind: 'loading', text: '' }), false);
    assert.equal(isCanvasRevealNotice(null), false);
  });
});

describe('the Panel status line (review round 1: one status region)', () => {
  const stamp: CodeMapEdge[] = [];
  const key = revealKey('/repo', null);
  const capped: HeldReveal = {
    key,
    mapStamp: stamp,
    listing: { status: 'ready', state: initialRevealState(found([HANDLE_REQUEST])), totalQualifying: 20 },
  };

  it('says the cap honestly when candidates were cut', () => {
    assert.equal(revealCapText(capped, key), 'Showing 1 of 20 candidates (most reach first)');
    assert.equal(revealCapText({ ...capped, listing: revealListingOf(found([HANDLE_REQUEST])) }, key), null);
    assert.equal(revealCapText(capped, revealKey('/repo', 'api')), null);
  });

  it('switch message first, then the notice sentence or loading line, then the cap line', () => {
    const none = { kind: 'none', tone: 'warning', sentence: NO_ENTRY_CANDIDATES_SENTENCE } as const;
    assert.equal(revealStatusText({ switchStatus: 'Showing the full map to reach x', notice: none, capText: 'cap' }), 'Showing the full map to reach x');
    assert.equal(revealStatusText({ switchStatus: null, notice: none, capText: 'cap' }), NO_ENTRY_CANDIDATES_SENTENCE);
    assert.equal(
      revealStatusText({ switchStatus: null, notice: { kind: 'error', tone: 'error', sentence: 'Couldn’t list entry candidates: boom' }, capText: null }),
      'Couldn’t list entry candidates: boom',
    );
    assert.equal(revealStatusText({ switchStatus: null, notice: { kind: 'loading', text: ENTRY_CANDIDATES_LOADING_TEXT }, capText: null }), ENTRY_CANDIDATES_LOADING_TEXT);
    assert.equal(revealStatusText({ switchStatus: null, notice: null, capText: 'cap' }), 'cap');
    assert.equal(revealStatusText({ switchStatus: null, notice: null, capText: null }), '');
  });

  it('the switch line clears itself after 8 s', () => {
    assert.equal(REVEAL_SWITCH_STATUS_MS, 8000);
  });
});

describe('the viewport (review round 1: explicit toggles only)', () => {
  const stamp: CodeMapEdge[] = [];
  const key = revealKey('/repo', null);
  const view = { x: 10, y: 20, zoom: 0.5 };

  it('entering Revealed saves the Full viewport and owes a fit; leaving owes Full; no change owes nothing', () => {
    const enter = revealViewRequestForToggle({ from: 'full', to: 'revealed', key, mapStamp: stamp, viewport: view, saved: null });
    assert.deepEqual(enter, { request: { target: 'revealed', key, mapStamp: stamp }, saved: { key, mapStamp: stamp, viewport: view } });
    const leave = revealViewRequestForToggle({ from: 'revealed', to: 'full', key, mapStamp: stamp, viewport: { x: 0, y: 0, zoom: 1 }, saved: enter.saved });
    assert.deepEqual(leave, { request: { target: 'full', key, mapStamp: stamp }, saved: enter.saved });
    assert.deepEqual(revealViewRequestForToggle({ from: 'full', to: 'full', key, mapStamp: stamp, viewport: view, saved: null }), {
      request: null,
      saved: null,
    });
  });

  const base = {
    codeMapMode: true,
    revealDrawn: false,
    key,
    mapStamp: stamp,
    canvasReady: true,
    nodesCount: 5,
    awaitingFirstFit: false,
    saved: { key, mapStamp: stamp, viewport: view },
  };
  const full = { target: 'full' as const, key, mapStamp: stamp };
  const revealed = { target: 'revealed' as const, key, mapStamp: stamp };

  it('restores the saved Full viewport for the same map, else fits', () => {
    assert.deepEqual(decideRevealView({ ...base, request: full }), { kind: 'restore', viewport: view });
    // Saved for an earlier map fetch (a refresh since): fit instead.
    assert.deepEqual(decideRevealView({ ...base, request: { ...full, mapStamp: [] }, mapStamp: [] }), { kind: 'fit' });
    assert.deepEqual(decideRevealView({ ...base, request: full, saved: null }), { kind: 'fit' });
    assert.deepEqual(decideRevealView({ ...base, revealDrawn: true, request: revealed }), { kind: 'fit' });
    assert.deepEqual(decideRevealView({ ...base, request: null }), { kind: 'none' });
  });

  it('entering PR Review never moves the viewport: the request waits', () => {
    assert.deepEqual(decideRevealView({ ...base, codeMapMode: false, request: revealed }), { kind: 'wait' });
  });

  it('waits for the canvas, cards and first fit', () => {
    assert.deepEqual(decideRevealView({ ...base, request: full, canvasReady: false }), { kind: 'wait' });
    assert.deepEqual(decideRevealView({ ...base, request: full, nodesCount: 0 }), { kind: 'wait' });
    assert.deepEqual(decideRevealView({ ...base, request: full, awaitingFirstFit: true }), { kind: 'wait' });
  });

  it('drops a request that can never apply: another project or section, or the other view', () => {
    assert.deepEqual(decideRevealView({ ...base, request: full, key: revealKey('/repo', 'api') }), { kind: 'drop' });
    assert.deepEqual(decideRevealView({ ...base, revealDrawn: true, request: full }), { kind: 'drop' });
  });

  it('a refresh’s listing re-fits once, only if the user hasn’t moved the view', () => {
    assert.equal(revealRefitOnListing({ revealDrawn: true, hadPrevious: true, userMoved: false }), true);
    assert.equal(revealRefitOnListing({ revealDrawn: true, hadPrevious: true, userMoved: true }), false);
    assert.equal(revealRefitOnListing({ revealDrawn: true, hadPrevious: false, userMoved: false }), false);
    assert.equal(revealRefitOnListing({ revealDrawn: false, hadPrevious: true, userMoved: false }), false);
  });

  it('Revealed with nothing to draw ends the first-fit wait at once; Full never does', () => {
    assert.equal(revealEndsFirstFitWait(true, 0), true);
    assert.equal(revealEndsFirstFitWait(true, 3), false);
    assert.equal(revealEndsFirstFitWait(false, 0), false);
  });
});

describe('hiddenNavigationTarget', () => {
  const nodes = new Map(['a', 'b', 'c'].map((id) => [id, mapNode(id)]));
  const drawn = new Set(['a']);
  const target = (ids: string[]) =>
    hiddenNavigationTarget(ids, (id) => drawn.has(id), (id) => nodes.get(id))?.id ?? null;

  it('is the first target on the map that is not drawn', () => {
    assert.equal(target(['a', 'c', 'b']), 'c');
    assert.equal(target(['a']), null);
    assert.equal(target(['gone']), null);
  });

  it('names it in the status line', () => {
    assert.equal(revealSwitchMessage('serviceA'), 'Showing the full map to reach serviceA');
  });
});
