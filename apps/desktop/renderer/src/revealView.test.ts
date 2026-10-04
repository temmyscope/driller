/**
 * P4-7d: the Revealed view's pure functions (`revealView.ts`) — the reveal
 * state, the layered layout, the population filter, the reason copy, the held
 * listing's lifecycle (keyed by project, section and map fetch), the
 * out-of-order reply rule, the notice choice and the hidden-Node target.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapEdge, CodeMapNode, EntryCandidate, EntryCandidatesResult } from '@driller/ipc-contracts';

// Test-only: the server's pure ranking, for the reach-agreement test (`@driller/graph-contracts` is a desktop devDependency; app code reaches contracts only through ipc-contracts).
import { listEntryCandidates } from '@driller/graph-contracts';

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
  revealStateOf,
  type HeldReveal,
  type RevealState,
} from './revealView';
import {
  applyRevealTransition,
  collapseNode,
  expandNode,
  expandStub,
  pruneRevealState,
  refreshRevealState,
  REVEAL_LAYER_CAP,
  REVEAL_TWO_LAYER_MAX,
  revealAuxCards,
  revealCrossSectionNote,
  revealDrillButtonText,
  revealDrillControls,
  revealDrillGraphFor,
  revealRefCardId,
  revealRefText,
  revealStubCardId,
  revealStubText,
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

/** P4-7e: a state from P4-7d's `{candidates, revealed}` shape — each revealed id becomes a `node` entry (reach 0 unless a candidate). */
function stateFrom(input: {
  candidates: EntryCandidate[];
  revealed: ReadonlyMap<string, { depth: number; parentId: string | null }>;
}): RevealState {
  return revealStateOf(
    input.candidates,
    [...input.revealed].map(([id, entry]) => ({ kind: 'node' as const, id, depth: entry.depth, parentId: entry.parentId, reach: 0 })),
  );
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
    const state: RevealState = stateFrom({
      candidates: [candidate('p1', 9), candidate('p2', 3)],
      revealed: new Map([
        ['p1', { depth: 0, parentId: null }],
        ['p2', { depth: 0, parentId: null }],
        ['z-child-of-p1', { depth: 1, parentId: 'p1' }],
        ['a-child-of-p2', { depth: 1, parentId: 'p2' }],
      ]),
    });
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
    const expected = Object.fromEntries(layeredLayout(stateFrom({ candidates, revealed: new Map(entries) })));
    const reversed = Object.fromEntries(
      layeredLayout(stateFrom({ candidates: [...candidates].reverse(), revealed: new Map([...entries].reverse()) })),
    );
    const rotated = Object.fromEntries(
      layeredLayout(stateFrom({ candidates: [candidates[1]!, candidates[2]!, candidates[0]!], revealed: new Map([...entries.slice(3), ...entries.slice(0, 3)]) })),
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
  const state: RevealState = stateFrom({
    candidates: [candidate('a', 3)],
    revealed: new Map([
      ['a', { depth: 0, parentId: null }],
      ['b', { depth: 1, parentId: 'a' }],
    ]),
  });

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

// ---------------------------------------------------------------------------
// P4-7e: drilling
// ---------------------------------------------------------------------------

const kindEdge = (source: string, target: string, kind: CodeMapEdge['kind']): CodeMapEdge => ({ source, target, kind });

// The `path-trace-basic` graph (P4-7b): handleRequest→serviceA,serviceB→repository↔cacheLookup;
// helper×2. Plus an IMPORTS edge handleRequest→helperOne, which the drill must never follow.
const PTB_IDS = ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup', 'helperOne', 'helperTwo'];
const PTB_NODES = PTB_IDS.map(mapNode);
const PTB_EDGES: CodeMapEdge[] = [
  edge('handleRequest', 'serviceA'),
  edge('handleRequest', 'serviceB'),
  edge('serviceA', 'repository'),
  edge('serviceB', 'repository'),
  edge('repository', 'cacheLookup'),
  edge('cacheLookup', 'repository'),
  kindEdge('handleRequest', 'helperOne', 'IMPORTS'),
];
const PTB_CANDIDATE = candidate('handleRequest', 4);

function ptb() {
  const graph = revealDrillGraphFor(null, PTB_NODES, PTB_EDGES);
  const start = initialRevealState(found([PTB_CANDIDATE]));
  return { graph, start };
}

const nodeIdsOf = (state: RevealState) =>
  state.entries.filter((entry) => entry.kind === 'node').map((entry) => (entry as { id: string }).id);

/** Every node id appears once; every ref and stub hangs off a revealed Node; every ref's target is revealed. */
function assertWellFormed(state: RevealState) {
  const ids = nodeIdsOf(state);
  assert.equal(new Set(ids).size, ids.length, `duplicate card: ${ids.join(', ')}`);
  assert.deepEqual([...state.revealed.keys()].sort(), [...ids].sort());
  for (const entry of state.entries) {
    if (entry.parentId !== null) {
      assert.ok(state.revealed.has(entry.parentId), `orphan entry under ${entry.parentId}`);
    }
    if (entry.kind === 'ref') {
      assert.ok(state.revealed.has(entry.targetId), `orphaned ref to ${entry.targetId}`);
    }
  }
  for (const candidate of state.candidates) {
    assert.ok(state.revealed.has(candidate.id), `candidate ${candidate.id} gone`);
  }
}

/** A hub `hub` with `count` fresh callees `c00…`; callee `cNN` calls `NN % 7` leaves of its own, so reach varies. */
function hubGraph(count: number) {
  const nodes: CodeMapNode[] = [mapNode('hub')];
  const edges: CodeMapEdge[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `c${String(i).padStart(2, '0')}`;
    nodes.push(mapNode(id));
    edges.push(edge('hub', id));
    for (let leaf = 0; leaf < i % 7; leaf += 1) {
      const leafId = `${id}-leaf${leaf}`;
      nodes.push(mapNode(leafId));
      edges.push(edge(id, leafId));
    }
  }
  const graph = revealDrillGraphFor(null, nodes, edges);
  const start = initialRevealState(found([candidate('hub', graph.reachById.get('hub'))]));
  return { graph, start };
}

/** A root with `width` children, each with one grandchild. */
function fanGraph(width: number) {
  const nodes: CodeMapNode[] = [mapNode('root')];
  const edges: CodeMapEdge[] = [];
  for (let i = 0; i < width; i += 1) {
    nodes.push(mapNode(`k${i}`), mapNode(`g${i}`));
    edges.push(edge('root', `k${i}`), edge(`k${i}`, `g${i}`));
  }
  const graph = revealDrillGraphFor(null, nodes, edges);
  return { graph, start: initialRevealState(found([candidate('root', 2 * width)])) };
}

describe('P4-7e: the thresholds', () => {
  it('are the named constants (Decision 3): 2 layers at 12 or fewer, a 30-Node cap', () => {
    assert.equal(REVEAL_TWO_LAYER_MAX, 12);
    assert.equal(REVEAL_LAYER_CAP, 30);
  });
});

describe('P4-7e: computeReachById', () => {
  it('agrees with the server’s reach for every candidate (path-trace-basic, and a generated graph with IMPORTS)', () => {
    const graphs: { nodes: CodeMapNode[]; edges: CodeMapEdge[] }[] = [{ nodes: PTB_NODES, edges: PTB_EDGES }];
    // Generated: 60 Nodes, CALLS/USAGE/IMPORTS edges, cycles included.
    const nodes = Array.from({ length: 60 }, (_, i) => mapNode(`n${i}`));
    const edges: CodeMapEdge[] = [];
    for (let i = 0; i < 60; i += 1) {
      const kinds: CodeMapEdge['kind'][] = ['CALLS', 'USAGE', 'IMPORTS'];
      for (let k = 1; k <= 3; k += 1) {
        const target = (i * 7 + k * 13) % 60;
        if (target > i || (i % 11 === 0 && k === 1)) {
          edges.push(kindEdge(`n${i}`, `n${target}`, kinds[(i + k) % 3]!));
        }
      }
    }
    graphs.push({ nodes, edges });
    for (const { nodes: graphNodes, edges: graphEdges } of graphs) {
      const result = listEntryCandidates(graphNodes, graphEdges);
      assert.equal(result.status, 'found');
      if (result.status !== 'found') {
        continue;
      }
      const drill = revealDrillGraphFor(null, graphNodes, graphEdges);
      for (const listed of result.candidates) {
        assert.equal(drill.reachById.get(listed.id), listed.reach, listed.id);
      }
    }
  });

  it('is computed once per Node and per map fetch (memoized; reused while the edges array is the same)', () => {
    const { graph } = ptb();
    assert.equal(graph.reachById.get('handleRequest'), 4);
    assert.equal(graph.reachById.get('handleRequest'), 4);
    assert.equal(graph.reachById.get('helperOne'), 0);
    assert.equal(revealDrillGraphFor(graph, PTB_NODES, PTB_EDGES), graph);
    assert.notEqual(revealDrillGraphFor(graph, PTB_NODES, [...PTB_EDGES]), graph);
  });
});

describe('P4-7e: expandNode', () => {
  it('handleRequest on path-trace-basic opens two layers: serviceA, serviceB, then repository; serviceB→repository is a ref', () => {
    const { graph, start } = ptb();
    const after = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    assertWellFormed(after);
    assert.deepEqual(
      after.entries.map((entry) =>
        entry.kind === 'node'
          ? ['node', entry.id, entry.depth, entry.parentId]
          : entry.kind === 'ref'
            ? ['ref', entry.targetId, entry.depth, entry.parentId]
            : ['more', entry.hiddenCount, entry.depth, entry.parentId],
      ),
      [
        ['node', 'handleRequest', 0, null],
        ['node', 'serviceA', 1, 'handleRequest'],
        ['node', 'serviceB', 1, 'handleRequest'],
        ['node', 'repository', 2, 'serviceA'],
        ['ref', 'repository', 2, 'serviceB'],
      ],
    );
    // cacheLookup is the third layer: not revealed by this step.
    assert.equal(after.revealed.has('cacheLookup'), false);
  });

  it('never follows IMPORTS (helperOne is only imported) — and its count never includes it', () => {
    const { graph, start } = ptb();
    const after = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    assert.equal(after.revealed.has('helperOne'), false);
    assert.deepEqual(revealDrillControls(start, graph.adjacency).get('handleRequest'), { kind: 'expand', count: 2 });
  });

  it('follows USAGE like CALLS (a JSX-rendered component is a callee)', () => {
    const graph = revealDrillGraphFor(null, ['app', 'Panel', 'x'].map(mapNode), [
      kindEdge('app', 'Panel', 'USAGE'),
      kindEdge('app', 'x', 'IMPORTS'),
    ]);
    const start = initialRevealState(found([candidate('app', 1)]));
    assert.deepEqual(nodeIdsOf(expandNode(start, graph.adjacency, graph.reachById, 'app')), ['app', 'Panel']);
  });

  it('walks only the section’s own Nodes: an edge to a Node outside them (another section) is never revealed', () => {
    const graph = revealDrillGraphFor(null, ['a', 'b'].map(mapNode), [edge('a', 'b'), edge('a', 'web/render')]);
    const start = initialRevealState(found([candidate('a', 1)]));
    assert.deepEqual(revealDrillControls(start, graph.adjacency).get('a'), { kind: 'expand', count: 1 });
    assert.deepEqual(nodeIdsOf(expandNode(start, graph.adjacency, graph.reachById, 'a')), ['a', 'b']);
  });

  it('orders a layer by reach descending, then id', () => {
    const { graph, start } = hubGraph(10);
    const after = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    const layer = after.entries.filter((entry) => entry.kind === 'node' && entry.depth === 1).map((entry) => (entry as { id: string }).id);
    const expected = [...layer].sort((a, b) => graph.reachById.get(b) - graph.reachById.get(a) || (a < b ? -1 : 1));
    assert.deepEqual(layer, expected);
    assert.equal(layer[0], 'c06');
  });

  it('a first layer of exactly REVEAL_TWO_LAYER_MAX Nodes opens two layers', () => {
    const { graph, start } = fanGraph(REVEAL_TWO_LAYER_MAX);
    const after = expandNode(start, graph.adjacency, graph.reachById, 'root');
    assert.equal(after.revealed.size, 1 + 2 * REVEAL_TWO_LAYER_MAX);
    assert.equal(after.revealed.get('g0')?.depth, 2);
  });

  it('a first layer of REVEAL_TWO_LAYER_MAX + 1 Nodes opens one layer', () => {
    const { graph, start } = fanGraph(REVEAL_TWO_LAYER_MAX + 1);
    const after = expandNode(start, graph.adjacency, graph.reachById, 'root');
    assert.equal(after.revealed.size, 1 + REVEAL_TWO_LAYER_MAX + 1);
    assert.equal(after.revealed.has('g0'), false);
  });

  it('a hub with 45 fresh callees: one layer, the top 30 by reach plus a "+15 more callees" stub', () => {
    const { graph, start } = hubGraph(45);
    const after = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    assertWellFormed(after);
    const layer = nodeIdsOf(after).filter((id) => id !== 'hub');
    assert.equal(layer.length, REVEAL_LAYER_CAP);
    const all = (graph.adjacency.forward.get('hub') ?? []).slice();
    const top30 = all.sort((a, b) => graph.reachById.get(b) - graph.reachById.get(a) || (a < b ? -1 : 1)).slice(0, 30);
    assert.deepEqual(layer, top30);
    const stubs = after.entries.filter((entry) => entry.kind === 'more');
    assert.deepEqual(stubs, [{ kind: 'more', parentId: 'hub', hiddenCount: 15, depth: 1 }]);
    assert.equal(revealStubText(15), '+15 more callees');
    // 30 > 12: no second layer.
    assert.equal([...after.revealed.values()].some((entry) => entry.depth === 2), false);
  });

  it('caps per parent, not per layer: two children with 20 fresh callees each show all 40', () => {
    const nodes: CodeMapNode[] = ['root', 'k1', 'k2'].map(mapNode);
    const edges = [edge('root', 'k1'), edge('root', 'k2')];
    for (const parent of ['k1', 'k2']) {
      for (let i = 0; i < 20; i += 1) {
        nodes.push(mapNode(`${parent}-${i}`));
        edges.push(edge(parent, `${parent}-${i}`));
      }
    }
    const graph = revealDrillGraphFor(null, nodes, edges);
    const after = expandNode(initialRevealState(found([candidate('root', 42)])), graph.adjacency, graph.reachById, 'root');
    assert.equal(after.revealed.size, 43);
    assert.equal(after.entries.some((entry) => entry.kind === 'more'), false);
  });

  it('applies the cap to the second layer too', () => {
    const nodes: CodeMapNode[] = ['root', 'k'].map(mapNode);
    const edges = [edge('root', 'k')];
    for (let i = 0; i < 31; i += 1) {
      nodes.push(mapNode(`g${String(i).padStart(2, '0')}`));
      edges.push(edge('k', `g${String(i).padStart(2, '0')}`));
    }
    const graph = revealDrillGraphFor(null, nodes, edges);
    const after = expandNode(initialRevealState(found([candidate('root', 32)])), graph.adjacency, graph.reachById, 'root');
    assert.equal(after.revealed.size, 2 + 30);
    assert.deepEqual(after.entries.filter((entry) => entry.kind === 'more'), [
      { kind: 'more', parentId: 'k', hiddenCount: 1, depth: 2 },
    ]);
  });

  it('a cycle (repository ↔ cacheLookup): expanding cacheLookup gives "↺ repository shown above", no new card', () => {
    const { graph } = ptb();
    const state = revealStateOf([PTB_CANDIDATE], [
      { kind: 'node', id: 'handleRequest', depth: 0, parentId: null, reach: 4 },
      { kind: 'node', id: 'serviceA', depth: 1, parentId: 'handleRequest', reach: 2 },
      { kind: 'node', id: 'repository', depth: 2, parentId: 'serviceA', reach: 1 },
      { kind: 'node', id: 'cacheLookup', depth: 3, parentId: 'repository', reach: 1 },
    ]);
    // Every callee of cacheLookup is already shown: N = 0, so no button.
    assert.equal(revealDrillControls(state, graph.adjacency).has('cacheLookup'), false);
    const after = expandNode(state, graph.adjacency, graph.reachById, 'cacheLookup');
    assertWellFormed(after);
    assert.equal(after.revealed.size, state.revealed.size);
    assert.deepEqual(after.entries.at(-1), { kind: 'ref', parentId: 'cacheLookup', targetId: 'repository', depth: 4 });
    assert.equal(revealRefText('repository'), '↺ repository shown above');
  });

  it('expanding repository opens cacheLookup, whose callee repository is then a ref (two layers)', () => {
    const { graph, start } = ptb();
    const once = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const after = expandNode(once, graph.adjacency, graph.reachById, 'repository');
    assertWellFormed(after);
    assert.deepEqual(after.revealed.get('cacheLookup'), { depth: 3, parentId: 'repository' });
    assert.ok(after.entries.some((entry) => entry.kind === 'ref' && entry.parentId === 'cacheLookup' && entry.targetId === 'repository'));
  });

  it('is pure: the state it was given is unchanged, and an unrevealed or expanded Node returns the same state', () => {
    const { graph, start } = ptb();
    const before = JSON.stringify(start.entries);
    const after = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    assert.equal(JSON.stringify(start.entries), before);
    assert.equal(expandNode(after, graph.adjacency, graph.reachById, 'handleRequest'), after);
    assert.equal(expandNode(start, graph.adjacency, graph.reachById, 'repository'), start);
  });
});

describe('P4-7e: expandStub', () => {
  it('activating "+15 more callees" shows the remaining 15, and the stub is gone', () => {
    const { graph, start } = hubGraph(45);
    const once = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    const after = expandStub(once, graph.adjacency, graph.reachById, 'hub');
    assertWellFormed(after);
    assert.equal(after.revealed.size, 46);
    assert.equal(after.entries.some((entry) => entry.kind === 'more'), false);
    // The 30 already beneath the hub aren't repeated as refs.
    assert.equal(after.entries.some((entry) => entry.kind === 'ref'), false);
    assert.equal(after.revealed.get('c00')?.depth, 1);
  });

  it('reveals the next 30 at a time, keeping a stub with the exact remainder', () => {
    const { graph, start } = hubGraph(75);
    const once = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    assert.deepEqual(once.entries.filter((entry) => entry.kind === 'more').map((entry) => (entry as { hiddenCount: number }).hiddenCount), [45]);
    const twice = expandStub(once, graph.adjacency, graph.reachById, 'hub');
    assert.equal(twice.revealed.size, 61);
    assert.deepEqual(twice.entries.filter((entry) => entry.kind === 'more').map((entry) => (entry as { hiddenCount: number }).hiddenCount), [15]);
    const thrice = expandStub(twice, graph.adjacency, graph.reachById, 'hub');
    assert.equal(thrice.revealed.size, 76);
    assert.equal(thrice.entries.some((entry) => entry.kind === 'more'), false);
  });

  it('a hidden callee revealed elsewhere since becomes a ref, never a second card', () => {
    const { graph, start } = hubGraph(31);
    const once = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    const hidden = (graph.adjacency.forward.get('hub') ?? []).find((id) => !once.revealed.has(id));
    assert.ok(hidden !== undefined);
    // Reveal it under another parent (as a drill from elsewhere would).
    const elsewhere = revealStateOf(once.candidates, [
      ...once.entries,
      { kind: 'node', id: hidden, depth: 2, parentId: 'c06', reach: 0 },
    ]);
    const after = expandStub(elsewhere, graph.adjacency, graph.reachById, 'hub');
    assertWellFormed(after);
    assert.ok(after.entries.some((entry) => entry.kind === 'ref' && entry.parentId === 'hub' && entry.targetId === hidden));
  });
});

describe('P4-7e: collapseNode', () => {
  it('collapsing serviceA removes its subtree; serviceB stays, and its ref to repository is re-homed as a plain card (review round 1)', () => {
    const { graph, start } = ptb();
    const expanded = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const deeper = expandNode(expanded, graph.adjacency, graph.reachById, 'repository');
    const after = collapseNode(deeper, 'serviceA');
    assertWellFormed(after);
    // repository (and the cacheLookup beneath it) left with serviceA's subtree;
    // serviceB showed repository as a ref, so repository comes back under
    // serviceB as a plain card with no subtree, in the ref's place.
    assert.deepEqual(nodeIdsOf(after), ['handleRequest', 'serviceA', 'serviceB', 'repository']);
    assert.deepEqual(after.revealed.get('repository'), { depth: 2, parentId: 'serviceB' });
    assert.equal(after.revealed.has('cacheLookup'), false);
    assert.equal(after.entries.some((entry) => entry.kind === 'ref'), false);
    const controls = revealDrillControls(after, graph.adjacency);
    assert.equal(controls.has('serviceA'), false);
    assert.deepEqual(controls.get('serviceB'), { kind: 'collapse' });
    assert.deepEqual(controls.get('repository'), { kind: 'expand', count: 1 });
  });

  it('collapse restores the view from before the expand', () => {
    const { graph, start } = ptb();
    const expanded = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const deeper = expandNode(expanded, graph.adjacency, graph.reachById, 'repository');
    assert.deepEqual(collapseNode(deeper, 'repository').entries, expanded.entries);
  });

  it('a diamond with two surviving refs: the first becomes the card, the other stays a ref to it', () => {
    // root → a, b, c; a → shared; b → shared; c → shared.
    const graph = revealDrillGraphFor(null, ['root', 'a', 'b', 'c', 'shared'].map(mapNode), [
      edge('root', 'a'),
      edge('root', 'b'),
      edge('root', 'c'),
      edge('a', 'shared'),
      edge('b', 'shared'),
      edge('c', 'shared'),
    ]);
    const start = initialRevealState(found([candidate('root', 4)]));
    const expanded = expandNode(start, graph.adjacency, graph.reachById, 'root');
    assert.deepEqual(expanded.revealed.get('shared'), { depth: 2, parentId: 'a' });
    const after = collapseNode(expanded, 'a');
    assertWellFormed(after);
    assert.deepEqual(after.revealed.get('shared'), { depth: 2, parentId: 'b' });
    assert.deepEqual(
      after.entries.filter((entry) => entry.kind === 'ref'),
      [{ kind: 'ref', parentId: 'c', targetId: 'shared', depth: 2 }],
    );
  });

  it('a ref under a surviving Node to a surviving target stays', () => {
    const { graph, start } = ptb();
    const expanded = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const deeper = expandNode(expanded, graph.adjacency, graph.reachById, 'repository');
    const after = collapseNode(deeper, 'cacheLookup');
    assertWellFormed(after);
    assert.ok(after.entries.some((entry) => entry.kind === 'ref' && entry.parentId === 'serviceB'));
    assert.equal(after.entries.some((entry) => entry.kind === 'ref' && entry.parentId === 'cacheLookup'), false);
  });

  it('collapsing a candidate removes its subtree; the candidate card stays', () => {
    const { graph, start } = ptb();
    const expanded = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const after = collapseNode(expanded, 'handleRequest');
    assertWellFormed(after);
    assert.deepEqual(after.entries, start.entries);
  });

  it('never removes a candidate, and leaves the other candidates’ trees alone', () => {
    const graph = revealDrillGraphFor(null, ['a', 'b', 'x', 'y'].map(mapNode), [edge('a', 'x'), edge('b', 'y'), edge('x', 'b')]);
    const start = initialRevealState(found([candidate('a', 3), candidate('b', 1)]));
    const expandedB = expandNode(start, graph.adjacency, graph.reachById, 'b');
    const expanded = expandNode(expandedB, graph.adjacency, graph.reachById, 'a');
    // x → b is a ref: b is a candidate, shown above.
    assert.ok(expanded.entries.some((entry) => entry.kind === 'ref' && entry.parentId === 'x' && entry.targetId === 'b'));
    const after = collapseNode(expanded, 'a');
    assertWellFormed(after);
    assert.deepEqual(nodeIdsOf(after).sort(), ['a', 'b', 'y']);
  });

  it('a stub goes with its parent', () => {
    const { graph, start } = hubGraph(45);
    const after = collapseNode(expandNode(start, graph.adjacency, graph.reachById, 'hub'), 'hub');
    assert.deepEqual(after.entries, start.entries);
  });
});

describe('P4-7e: the drill control', () => {
  it('"▸ Expand callees (N)" with N not yet revealed; "▾ Collapse" once expanded; none on a leaf', () => {
    const { graph, start } = ptb();
    const expanded = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const controls = revealDrillControls(expanded, graph.adjacency);
    assert.deepEqual(controls.get('handleRequest'), { kind: 'collapse' });
    assert.deepEqual(controls.get('serviceA'), { kind: 'collapse' });
    // serviceB's one callee is shown (as a ref): expanded.
    assert.deepEqual(controls.get('serviceB'), { kind: 'collapse' });
    assert.deepEqual(controls.get('repository'), { kind: 'expand', count: 1 });
    assert.equal(revealDrillButtonText({ kind: 'expand', count: 3 }), '▸ Expand callees (3)');
    assert.equal(revealDrillButtonText({ kind: 'collapse' }), '▾ Collapse');
    const leaf = revealDrillGraphFor(null, [mapNode('leaf')], []);
    const leafState = initialRevealState(found([candidate('leaf', 0)]));
    assert.equal(revealDrillControls(leafState, leaf.adjacency).has('leaf'), false);
  });
});

describe('P4-7e: a refresh while drilled', () => {
  it('pruneRevealState keeps ids still on the map and drops vanished ones with their subtrees and refs', () => {
    const { graph, start } = ptb();
    const drilled = expandNode(
      expandNode(start, graph.adjacency, graph.reachById, 'handleRequest'),
      graph.adjacency,
      graph.reachById,
      'repository',
    );
    const after = pruneRevealState(drilled, new Set(PTB_IDS.filter((id) => id !== 'repository')));
    assertWellFormed(after);
    assert.deepEqual(nodeIdsOf(after), ['handleRequest', 'serviceA', 'serviceB']);
    assert.equal(after.entries.some((entry) => entry.kind === 'ref'), false);
    // Nothing vanished: the same state.
    assert.equal(pruneRevealState(drilled, new Set(PTB_IDS)), drilled);
  });

  it('with the new adjacency, a child its parent no longer calls is dropped, and a stub is re-counted', () => {
    const { graph, start } = hubGraph(45);
    const drilled = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    const shown = nodeIdsOf(drilled).filter((id) => id !== 'hub');
    const dropped = shown[0]!;
    const hiddenOne = (graph.adjacency.forward.get('hub') ?? []).find((id) => !drilled.revealed.has(id))!;
    const edges = [...graph.edges].filter(
      (e) => !(e.source === 'hub' && (e.target === dropped || e.target === hiddenOne)),
    );
    const next = revealDrillGraphFor(null, [...graph.adjacency.validNodeIds].map(mapNode), edges);
    const after = pruneRevealState(drilled, next.adjacency.validNodeIds, next.adjacency);
    assertWellFormed(after);
    assert.equal(after.revealed.has(dropped), false);
    assert.deepEqual(after.entries.filter((entry) => entry.kind === 'more'), [
      { kind: 'more', parentId: 'hub', hiddenCount: 14, depth: 1 },
    ]);
  });

  it('a refresh’s listing keeps the drill, pruned to the new map (revealListingReplyOutcome)', () => {
    const { graph, start } = ptb();
    const drilled = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const key = revealKey('/p', null);
    const oldStamp = PTB_EDGES;
    const held: HeldReveal = { key, mapStamp: oldStamp, listing: { status: 'ready', state: drilled, totalQualifying: 1 } };
    // The refresh: serviceB is gone.
    const newNodes = PTB_NODES.filter((n) => n.id !== 'serviceB');
    const newEdges = PTB_EDGES.filter((e) => e.source !== 'serviceB' && e.target !== 'serviceB');
    const loading = startRevealListing(held, key, newEdges);
    const outcome = revealListingReplyOutcome({
      isLatest: true,
      requestedSection: null,
      currentSection: null,
      held: loading,
      key,
      mapStamp: newEdges,
      result: found([candidate('handleRequest', 3)]),
      drillGraph: revealDrillGraphFor(null, newNodes, newEdges),
    });
    assert.equal(outcome.kind, 'apply');
    if (outcome.kind !== 'apply' || outcome.held.listing.status !== 'ready') {
      return;
    }
    const state = outcome.held.listing.state;
    assertWellFormed(state);
    assert.deepEqual(nodeIdsOf(state), ['handleRequest', 'serviceA', 'repository']);
    assert.equal(state.candidates[0]?.reach, 3);
    // Without a drill graph (or for another fetch), the listing starts fresh.
    const fresh = revealListingReplyOutcome({
      isLatest: true,
      requestedSection: null,
      currentSection: null,
      held: loading,
      key,
      mapStamp: newEdges,
      result: found([candidate('handleRequest', 3)]),
    });
    assert.ok(fresh.kind === 'apply' && fresh.held.listing.status === 'ready');
    assert.deepEqual(fresh.kind === 'apply' && fresh.held.listing.status === 'ready' ? nodeIdsOf(fresh.held.listing.state) : [], ['handleRequest']);
  });

  it('review round 1: an expanded parent that gains callees on refresh gets them back — refs, and its stub re-counted or added', () => {
    const graph = revealDrillGraphFor(null, ['p', 'a', 'b'].map(mapNode), [edge('p', 'a')]);
    const start = initialRevealState(found([candidate('p', 1), candidate('b', 0)]));
    const drilled = expandNode(start, graph.adjacency, graph.reachById, 'p');
    assert.deepEqual(nodeIdsOf(drilled), ['p', 'b', 'a']);
    // The refresh: p now also calls b (shown, a candidate) and two new Nodes.
    const next = revealDrillGraphFor(null, ['p', 'a', 'b', 'n1', 'n2'].map(mapNode), [
      edge('p', 'a'),
      edge('p', 'b'),
      edge('p', 'n1'),
      edge('p', 'n2'),
    ]);
    const after = pruneRevealState(drilled, next.adjacency.validNodeIds, next.adjacency);
    assertWellFormed(after);
    assert.deepEqual(
      after.entries.filter((entry) => entry.kind !== 'node'),
      [
        { kind: 'ref', parentId: 'p', targetId: 'b', depth: 1 },
        { kind: 'more', parentId: 'p', hiddenCount: 2, depth: 1 },
      ],
    );
    // An unexpanded Node gets nothing new (its button counts them instead).
    assert.equal(after.entries.some((entry) => entry.parentId === 'a'), false);
  });

  it('review round 1: a Node promoted to candidate on refresh brings its subtree, re-based to columns 1, 2', () => {
    // Before: a → x → y → z. After the refresh nothing calls x: x is a candidate.
    const graph = revealDrillGraphFor(null, ['a', 'x', 'y', 'z'].map(mapNode), [edge('a', 'x'), edge('x', 'y'), edge('y', 'z')]);
    let drilled = initialRevealState(found([candidate('a', 3)]));
    for (const id of ['a', 'y']) {
      drilled = expandNode(drilled, graph.adjacency, graph.reachById, id);
    }
    assert.deepEqual(drilled.revealed.get('z'), { depth: 3, parentId: 'y' });
    const next = revealDrillGraphFor(null, ['a', 'x', 'y', 'z', 'w'].map(mapNode), [
      edge('x', 'y'),
      edge('y', 'z'),
      edge('a', 'w'),
      edge('w', 'z'),
    ]);
    const after = refreshRevealState(drilled, initialRevealState(found([candidate('x', 2), candidate('a', 2)])), next);
    assertWellFormed(after);
    assert.deepEqual(after.revealed.get('x'), { depth: 0, parentId: null });
    assert.deepEqual(after.revealed.get('y'), { depth: 1, parentId: 'x' });
    assert.deepEqual(after.revealed.get('z'), { depth: 2, parentId: 'y' });
  });

  it('a Node that is no longer a candidate leaves with its subtree', () => {
    const graph = revealDrillGraphFor(null, ['a', 'b', 'x'].map(mapNode), [edge('a', 'x'), edge('b', 'x')]);
    const start = initialRevealState(found([candidate('a', 1), candidate('b', 1)]));
    const drilled = expandNode(start, graph.adjacency, graph.reachById, 'a');
    const after = refreshRevealState(drilled, initialRevealState(found([candidate('b', 1)])), graph);
    assertWellFormed(after);
    assert.deepEqual(nodeIdsOf(after), ['b']);
  });
});

describe('P4-7e: layout, cards and transitions', () => {
  it('layeredLayout places refs and stubs in their parent’s child column, after its Nodes; order-independent', () => {
    const { graph, start } = ptb();
    const after = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const positions = layeredLayout(after);
    assert.deepEqual(positions.get('repository'), { x: 2 * NODE_COLUMN_GAP, y: 0 });
    assert.deepEqual(positions.get(revealRefCardId('serviceB', 'repository')), { x: 2 * NODE_COLUMN_GAP, y: NODE_ROW_GAP });
    const reversed = layeredLayout(revealStateOf([...after.candidates], [...after.entries].reverse()));
    assert.deepEqual(Object.fromEntries(reversed), Object.fromEntries(positions));

    const hub = hubGraph(45);
    const hubState = expandNode(hub.start, hub.graph.adjacency, hub.graph.reachById, 'hub');
    assert.deepEqual(layeredLayout(hubState).get(revealStubCardId('hub')), { x: NODE_COLUMN_GAP, y: 30 * NODE_ROW_GAP });
  });

  it('within one parent: its Nodes first, then its refs, then its stub — whatever the ids', () => {
    const state = revealStateOf([candidate('p', 2), candidate('alpha', 0)], [
      { kind: 'node', id: 'p', depth: 0, parentId: null, reach: 2 },
      { kind: 'node', id: 'alpha', depth: 0, parentId: null, reach: 0 },
      { kind: 'ref', parentId: 'p', targetId: 'alpha', depth: 1 },
      { kind: 'more', parentId: 'p', hiddenCount: 1, depth: 1 },
      { kind: 'node', id: 'zeta', depth: 1, parentId: 'p', reach: 0 },
    ]);
    const positions = layeredLayout(state);
    assert.deepEqual(
      [positions.get('zeta'), positions.get(revealRefCardId('p', 'alpha')), positions.get(revealStubCardId('p'))],
      [
        { x: NODE_COLUMN_GAP, y: 0 },
        { x: NODE_COLUMN_GAP, y: NODE_ROW_GAP },
        { x: NODE_COLUMN_GAP, y: 2 * NODE_ROW_GAP },
      ],
    );
  });

  it('a depth past the canvas keeps growing columns (nothing clipped)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
    const graph = revealDrillGraphFor(null, ids.map(mapNode), ids.slice(1).map((id, i) => edge(ids[i]!, id)));
    let state = initialRevealState(found([candidate('d0', 39)]));
    for (const id of ids) {
      state = expandNode(state, graph.adjacency, graph.reachById, id);
    }
    assert.equal(state.revealed.size, 40);
    assert.deepEqual(layeredLayout(state).get('d39'), { x: 39 * NODE_COLUMN_GAP, y: 0 });
  });

  it('revealAuxCards: a ref or stub is drawn only beside drawn Nodes', () => {
    const { graph, start } = ptb();
    const after = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const all = revealAuxCards(after, (id) => (after.revealed.has(id) ? id : undefined));
    assert.deepEqual(all, [
      { kind: 'ref', id: revealRefCardId('serviceB', 'repository'), parentId: 'serviceB', targetId: 'repository', targetName: 'repository' },
    ]);
    assert.deepEqual(revealAuxCards(after, (id) => (id === 'repository' ? undefined : id)), []);
  });

  it('review round 1: a stub card counts the callees not shown anywhere now (and isn’t drawn at 0)', () => {
    const { graph, start } = hubGraph(32);
    const once = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    const hidden = (graph.adjacency.forward.get('hub') ?? []).filter((id) => !once.revealed.has(id));
    assert.equal(hidden.length, 2);
    const nameOf = (id: string) => id;
    const stubCount = (state: RevealState) =>
      revealAuxCards(state, nameOf, graph.adjacency)
        .filter((card) => card.kind === 'more')
        .map((card) => (card.kind === 'more' ? card.hiddenCount : 0));
    assert.deepEqual(stubCount(once), [2]);
    // One hidden callee is revealed elsewhere (under c06): the stub says 1.
    const withOne = revealStateOf(once.candidates, [...once.entries, { kind: 'node', id: hidden[0]!, depth: 2, parentId: 'c06', reach: 0 }]);
    assert.deepEqual(stubCount(withOne), [1]);
    const withBoth = revealStateOf(withOne.candidates, [...withOne.entries, { kind: 'node', id: hidden[1]!, depth: 2, parentId: 'c06', reach: 0 }]);
    assert.deepEqual(stubCount(withBoth), []);
  });

  it('applyRevealTransition: on a ready listing, on a refresh’s previous state, or nothing', () => {
    const { graph, start } = ptb();
    const key = revealKey('/p', null);
    const expand = (state: RevealState) => expandNode(state, graph.adjacency, graph.reachById, 'handleRequest');
    const ready: HeldReveal = { key, mapStamp: PTB_EDGES, listing: { status: 'ready', state: start, totalQualifying: 1 } };
    const applied = applyRevealTransition(ready, key, expand);
    assert.ok(applied !== null);
    assert.equal(applied.before, start);
    assert.equal(applied.held.listing.status === 'ready' && applied.held.listing.state, applied.after);
    const loading: HeldReveal = { key, mapStamp: PTB_EDGES, listing: { status: 'loading', previous: start } };
    const onPrevious = applyRevealTransition(loading, key, expand);
    assert.ok(onPrevious !== null && onPrevious.held.listing.status === 'loading' && onPrevious.held.listing.previous === onPrevious.after);
    assert.equal(applyRevealTransition(ready, revealKey('/p', 'api'), expand), null);
    assert.equal(applyRevealTransition({ key, mapStamp: PTB_EDGES, listing: { status: 'none' } }, key, expand), null);
    assert.equal(applyRevealTransition(ready, key, (state) => state), null);
  });

  it('revealCrossSectionNote: the server’s count of callees in other sections, or nothing', () => {
    assert.equal(
      revealCrossSectionNote({ crossSectionCalls: [{ id: 'w', name: 'render', section: 'web' }], crossSectionCallsTotal: 25 }),
      '↗ Calls 25 Nodes in other sections (not shown in this section)',
    );
    assert.equal(
      revealCrossSectionNote({ crossSectionCalls: [{ id: 'w', name: 'render', section: 'web' }] }),
      '↗ Calls 1 Node in other sections (not shown in this section)',
    );
    assert.equal(revealCrossSectionNote({}), null);
  });
});

// ---------------------------------------------------------------------------
// P4-7e review round 1: reach by strongly connected component
// ---------------------------------------------------------------------------

/** A small deterministic PRNG (LCG), so the generated graphs are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The reference: a plain string-keyed BFS per Node (P4-7e round 0's walk). */
function referenceReach(graph: ReturnType<typeof revealDrillGraphFor>, id: string): number {
  const visited = new Set([id]);
  const queue = [id];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of graph.adjacency.forward.get(queue[head]!) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited.size - 1;
}

describe('P4-7e review round 1: computeReachById by component', () => {
  it('equals a per-Node BFS for every Node on generated graphs (cycles, self-loops, IMPORTS, dangling edges)', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = seeded(seed);
      const count = 5 + Math.floor(random() * 60);
      const nodes = Array.from({ length: count }, (_, i) => mapNode(`n${i}`));
      const kinds: CodeMapEdge['kind'][] = ['CALLS', 'USAGE', 'IMPORTS'];
      const edges: CodeMapEdge[] = [];
      const edgeCount = Math.floor(random() * count * 3);
      for (let e = 0; e < edgeCount; e += 1) {
        const source = Math.floor(random() * count);
        const target = random() < 0.05 ? 'outside' : `n${Math.floor(random() * count)}`;
        edges.push(kindEdge(`n${source}`, target, kinds[Math.floor(random() * 3)]!));
      }
      const graph = revealDrillGraphFor(null, nodes, edges);
      for (const node of nodes) {
        assert.equal(graph.reachById.get(node.id), referenceReach(graph, node.id), `seed ${seed}, ${node.id}`);
      }
      assert.equal(graph.reachById.get('outside'), 0);
    }
  });

  it('expanding a 200-callee hub on a seeded 50k map (a 20k-Node cycle-connected component) stays within AD-14’s budget', () => {
    const random = seeded(7);
    const total = 50_000;
    const ring = 20_000;
    const nodes: CodeMapNode[] = [];
    const edges: CodeMapEdge[] = [];
    for (let i = 0; i < total; i += 1) {
      nodes.push(mapNode(`n${i}`));
    }
    for (let i = 0; i < ring; i += 1) {
      edges.push(edge(`n${i}`, `n${(i + 1) % ring}`), kindEdge(`n${i}`, `n${Math.floor(random() * ring)}`, 'USAGE'));
    }
    for (let i = ring; i < total; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        const target = random() < 0.1 ? Math.floor(random() * ring) : i + 1 + Math.floor(random() * (total - i - 1));
        if (target < total && target !== i) {
          edges.push(kindEdge(`n${i}`, `n${target}`, k === 2 ? 'IMPORTS' : 'CALLS'));
        }
      }
    }
    nodes.push(mapNode('hub'), mapNode('hub12'));
    for (let k = 0; k < 200; k += 1) {
      edges.push(edge('hub', `n${ring + k * 37}`));
    }
    for (let k = 0; k < 12; k += 1) {
      edges.push(edge('hub12', `n${ring + 5000 + k * 101}`));
    }
    const start = initialRevealState(found([candidate('hub', 1), candidate('hub12', 1)]));

    // Cold: the expand pays for the component index (built on the first reach asked).
    const graph = revealDrillGraphFor(null, nodes, edges);
    let began = performance.now();
    const hub = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    const hubMs = performance.now() - began;
    const other = revealDrillGraphFor(null, nodes, [...edges]);
    began = performance.now();
    const twoLayers = expandNode(start, other.adjacency, other.reachById, 'hub12');
    const twoLayersMs = performance.now() - began;

    assert.equal(hub.revealed.size, 2 + REVEAL_LAYER_CAP);
    assert.ok(twoLayers.revealed.size > 2 + 12, 'two layers opened');
    // AD-14's ~150 ms, with margin for CI noise; the measured numbers are recorded in the spec.
    assert.ok(hubMs < 300, `200-callee expand took ${hubMs.toFixed(1)} ms`);
    assert.ok(twoLayersMs < 300, `12-callee two-layer expand took ${twoLayersMs.toFixed(1)} ms`);
  });
});
