/**
 * P4-8f: the Revealed start view's wiring inside `CodeMap` (P4-7d), rendered
 * for real (jsdom, a fake `window.driller`) — replacing the
 * `CodeMap.revealed.test.ts` source pins. Each test drives what a user
 * drives (the "Revealed / Full map" toggle, "Show full map", a pill, a Path
 * Trace search, Back, a section or project change, a refresh, the mode) and
 * asserts what the user and the IPC boundary see: the cards drawn and where
 * (`layoutPosition` / `layeredLayout`, the positions `positionOf` hands
 * `layoutNodes`), the viewport, the one `role="status"` line, the notices,
 * and the recorded `listEntryCandidates` / `getCodeMap` calls.
 *
 * The default fixture is `path-trace-basic` (7 Nodes) with its one
 * candidate, `handleRequest`. `drillMap` hubs give a three-candidate listing.
 * The byte-identical Full snapshot test stays in `CodeMap.revealed.test.ts`.
 */
import './test/domEnv';
import { animatingElements, assertSameElement, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import process, { env } from 'node:process';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CodeMapResult, EntryCandidatesResult, PathTraceResult } from '@driller/ipc-contracts';
import type { MapFooterState } from './appFrame';
import {
  CodeMap,
  initialViewport,
  LOD_ZOOM_THRESHOLD,
  MAP_MAX_ZOOM,
  NODE_CARD_FALLBACK_HEIGHT,
  NODE_CARD_FALLBACK_WIDTH,
  ROUTE_MIN_READABLE_ZOOM,
  type CodeMapProps,
} from './CodeMap';
import {
  ENTRY_CANDIDATES_LOADING_TEXT,
  ENTRY_CANDIDATES_NOT_ON_MAP_SENTENCE,
  initialRevealState,
  layeredLayout,
  NO_ENTRY_CANDIDATES_SENTENCE,
  REVEAL_LAYER_CAP,
  REVEAL_SWITCH_STATUS_MS,
  REVEAL_TWO_LAYER_MAX,
  revealSwitchMessage,
} from './revealView';
import { createFakeDrillerApi, deferred, type Deferred, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import {
  drillHub,
  drillMap,
  entryCandidate,
  FIXTURE_NODES,
  FIXTURE_PROJECT_PATH,
  foundListing,
  pathTraceBasicListing,
  pathTraceBasicMap,
  SECTION_NODES,
  sectionedMap,
  syntheticMap,
  type CodeMapOk,
  type SectionName,
  fullMapPositions,
} from './test/mapFixture';

afterEach(cleanupAfterEach);

/**
 * Asserts an element is absent. Never `assert.equal(element, null)`: on
 * failure `node:assert` diffs the jsdom element graph, which takes minutes.
 */
function assertAbsent(element: Element | null | undefined, what: string): void {
  assert.ok(element === null || element === undefined, `${what} is absent`);
}


/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const FIND = { timeout: 1_500 };
const N = FIXTURE_NODES;
const S = SECTION_NODES;
const ALL_IDS = Object.values(N).map((node) => node.id);

function revealFake(stubs: DrillerStubs = {}): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    getCodeMap: async () => pathTraceBasicMap(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
    listEntryCandidates: async () => pathTraceBasicListing(),
    ...stubs,
  });
  fake.install();
  return fake;
}

function props(overrides: Partial<CodeMapProps> = {}): CodeMapProps {
  const noop = () => {};
  return {
    projectPath: FIXTURE_PROJECT_PATH,
    noSummaryBackendAvailable: false,
    cloudSelectedNoKey: false,
    mode: 'codeMap',
    onRequestCodeMapMode: noop,
    graphServiceAvailable: true,
    dataVersion: 0,
    onMapState: noop,
    onDiffScopeSynced: noop,
    onOpenSettings: noop,
    onReindex: async () => true,
    onSwitchSection: noop,
    ...overrides,
  };
}

/**
 * Reports the canvas's and the cards' sizes to every ResizeObserver, as a
 * browser does: React Flow keeps a card `visibility: hidden` (so out of the
 * accessibility tree) until it is measured, and draws an edge only between
 * measured cards.
 */
function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

/** The ids of the cards drawn (cluster cards left out), sorted. */
function drawnIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('cluster:'))
    .sort();
}

async function waitForDrawn(ids: readonly string[]): Promise<void>;
async function waitForDrawn(wait: { timeout: number }, ids: readonly string[]): Promise<void>;
async function waitForDrawn(first: readonly string[] | { timeout: number }, second?: readonly string[]): Promise<void> {
  const [wait, ids] = Array.isArray(first) ? [FIND, first as readonly string[]] : [first as { timeout: number }, second!];
  await waitFor(() => {
    measure();
    assert.deepEqual(drawnIds(), [...ids].sort());
  }, wait);
}

/** A drill draws a layered column per step; under load that takes longer than one card query. */
const DRILL_WAIT = { timeout: 3_000 };

/** A control on a card (drawn and measured first), by role and name. */
async function findOnCanvas(name: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    measure();
    return screen.getByRole('button', { name });
  }, FIND);
}

function toggleButton(view: 'Revealed' | 'Full map'): HTMLElement {
  return within(screen.getByRole('group', { name: 'Code Map view' })).getByRole('button', { name: view });
}

/** Which view the toggle says is on. */
function pressedView(): string {
  const pressed = within(screen.getByRole('group', { name: 'Code Map view' }))
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1, 'exactly one view is pressed');
  return pressed[0]!.textContent ?? '';
}

function showRevealed(): void {
  fireEvent.click(toggleButton('Revealed'));
}

function showFull(): void {
  fireEvent.click(toggleButton('Full map'));
}

/**
 * Full map draws every Node: the collapsed community view's "All Nodes"
 * (`CommunityViewToggle`). A no-op on a map too small to group, where the
 * toggle is not shown and every Node is drawn already.
 */
function showAllNodes(): void {
  const all = screen.queryByRole('button', { name: 'All Nodes' });
  if (all !== null) {
    fireEvent.click(all);
  }
}

/** The Panel's status line (the one live region Revealed speaks through). */
function revealStatus(): HTMLElement {
  const line = document.querySelector<HTMLElement>('.code-map__reveal-status');
  assert.ok(line, 'the Revealed status line is mounted');
  return line;
}

/** Every live region whose text is `text` — Revealed must say a thing once. */
function statusRegionsSaying(text: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"], [aria-live]')].filter(
    (element) => element.textContent === text,
  );
}

function candidateLines(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node .code-map__node-candidate')]
    .map((line) => (line.textContent ?? '').replace(/\s+/g, ' ').trim())
    .sort();
}

/** Each drawn card's position, from its React Flow wrapper (`translate(xpx,ypx)`). */
function cardPositions(): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const card of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card.style.transform);
    assert.ok(match, `card ${card.getAttribute('data-id')} has a position`);
    positions.set(card.getAttribute('data-id') ?? '', { x: Number(match[1]), y: Number(match[2]) });
  }
  return positions;
}

function viewportTransform(): string {
  return document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
}

function parseViewport(): { x: number; y: number; zoom: number } {
  const match = /translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(viewportTransform());
  assert.ok(match, `a viewport transform (${viewportTransform()})`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/** The world point at the centre of the canvas. */
function viewportCentre(): { x: number; y: number } {
  const { x, y, zoom } = parseViewport();
  return { x: (elementSize.width / 2 - x) / zoom, y: (elementSize.height / 2 - y) / zoom };
}

/** The transform `initialViewport` gives for cards at `positions` in the measured canvas. */
function fitTransform(positions: readonly { x: number; y: number }[]): string {
  const fit = initialViewport({
    nodes: positions.map((position, index) => ({ id: String(index), position })),
    cardSize: { width: NODE_CARD_FALLBACK_WIDTH, height: NODE_CARD_FALLBACK_HEIGHT },
    viewport: { width: elementSize.width, height: elementSize.height },
    minReadableZoom: ROUTE_MIN_READABLE_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    lodThreshold: LOD_ZOOM_THRESHOLD,
  });
  assert.ok(fit);
  return `translate(${fit.x}px,${fit.y}px) scale(${fit.zoom})`;
}

/** Where Full lays out each Node of a map — the community layout, as `positionOf` hands it to `layoutNodes`. */
function fullGrid(map: CodeMapOk): ReadonlyMap<string, { x: number; y: number }> {
  return fullMapPositions(map);
}

/** Waits for an animated viewport move (React Flow's `setCenter`/route fit) to end. */
async function settleViewport(): Promise<void> {
  await waitFor(() => assert.equal(animatingElements().length, 0, 'the viewport is still animating'), FIND);
}

/** The drawn real map edges (no Revealed decorations), as `source→target`. */
function drawnEdges(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__edge[data-id]')]
    .map((edge) => edge.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('reveal-connector:') && !id.startsWith('shared-reach:'))
    .map((id) => id.split(':CALLS:')[0]!)
    .sort();
}

/** Mounts Code Map on path-trace-basic and waits for the whole Full map. */
async function mountFull(fake: FakeDrillerApi, overrides: Partial<CodeMapProps> = {}) {
  const view = render(<CodeMap {...props(overrides)} />);
  await waitForDrawn(ALL_IDS);
  return { ...view, fake };
}

/** Toggles Revealed on path-trace-basic and waits for `handleRequest`'s candidate card. */
async function toRevealed(): Promise<void> {
  showRevealed();
  await waitForDrawn([N.handleRequest.id]);
}

/** A listing stub whose replies the test settles, one deferred per call, in call order. */
function deferredListings(): {
  stub: NonNullable<DrillerStubs['listEntryCandidates']>;
  replies: Deferred<EntryCandidatesResult>[];
} {
  const replies: Deferred<EntryCandidatesResult>[] = [];
  return {
    replies,
    stub: () => {
      const reply = deferred<EntryCandidatesResult>();
      replies.push(reply);
      return reply.promise;
    },
  };
}

describe('Full is the default (replaces the flowNodes-call and revealCanvas-gating pins)', () => {
  it('never toggled: every card at today’s grid position, every edge, no candidate line, no listing; Full map pressed', BUDGET, async () => {
    const fake = revealFake();
    await mountFull(fake);
    assert.equal(pressedView(), 'Full map');
    assert.deepEqual(cardPositions(), fullGrid(pathTraceBasicMap()));
    await waitFor(() => {
      measure();
      assert.equal(drawnEdges().length, 6);
    }, FIND);
    assert.deepEqual(candidateLines(), []);
    assertAbsent(screen.queryByRole('button', { name: /^Expand \d+ callee/ }), 'no drill control in Full');
    assert.deepEqual(fake.calls.listEntryCandidates, [], 'Full never lists candidates');
    // The status line is mounted (and empty) before anything is said in it.
    assert.equal(revealStatus().getAttribute('role'), 'status');
    assert.equal(revealStatus().textContent, '');
  });

  it('Revealed → Full restores the full card set unchanged: the same positions and edges, the Full viewport, no candidate line', BUDGET, async () => {
    const fake = revealFake();
    await mountFull(fake);
    const before = { positions: cardPositions(), viewport: viewportTransform() };
    await toRevealed();
    assert.notEqual(viewportTransform(), before.viewport, 'Revealed fitted its candidate');
    showFull();
    await waitForDrawn(ALL_IDS);
    assert.equal(pressedView(), 'Full map');
    assert.deepEqual(cardPositions(), before.positions);
    assert.deepEqual(candidateLines(), []);
    assert.equal(viewportTransform(), before.viewport, 'the Full viewport saved on entering Revealed is restored');
    await waitFor(() => {
      measure();
      assert.equal(drawnEdges().length, 6);
    }, FIND);
    assert.deepEqual(fake.calls.listEntryCandidates.length, 1);
  });
});

describe('Toggling Revealed (replaces the Revealed-branch and listing-fetch pins)', () => {
  const hubs = [
    drillHub(REVEAL_TWO_LAYER_MAX, { grandchildren: true }),
    drillHub(REVEAL_TWO_LAYER_MAX + 1, { grandchildren: true }),
    drillHub(REVEAL_LAYER_CAP + 1, { grandchildren: false }),
  ];
  const listing = () => foundListing(hubs.map((hub) => hub.candidate));

  it('3 candidates: one listing call with the section on screen; only their cards, in column 0, each with its reason', BUDGET, async () => {
    const map = drillMap(hubs);
    const reports: MapFooterState[] = [];
    const fake = revealFake({ getCodeMap: async () => structuredClone(map), listEntryCandidates: async () => listing() });
    render(<CodeMap {...props({ onMapState: (_project, state) => reports.push(state) })} />);
    await waitFor(() => {
      measure();
      showAllNodes();
      assert.ok(drawnIds().length > hubs.length);
    }, FIND);
    showRevealed();
    await waitForDrawn(hubs.map((hub) => hub.hub.id));
    assert.deepEqual(fake.calls.listEntryCandidates, [[FIXTURE_PROJECT_PATH, undefined]]);
    assert.equal(pressedView(), 'Revealed');
    // Each card carries its reason, and sits where `layeredLayout` puts it.
    assert.deepEqual(
      candidateLines(),
      hubs.map((hub) => `◎ candidate · no callers in indexed code · reaches ${hub.candidate.reach} Nodes`).sort(),
    );
    assert.deepEqual(cardPositions(), layeredLayout(initialRevealState(listing())));
    for (const hub of hubs) {
      const card = screen.getByRole('button', {
        name: `Function ${hub.hub.name}, entry candidate, reaches ${hub.candidate.reach} Nodes, open Node detail`,
      });
      // The drill is passed to the cards, and every count still reads the whole map.
      assert.ok(within(card).getByRole('button', { name: `Expand ${hub.callees.length} callees of ${hub.hub.name}` }));
      assert.ok(within(card).getByRole('button', { name: `${hub.callees.length} calls — show the callees of ${hub.hub.name}` }));
    }
    const ready = reports.filter((report) => report.status === 'ready').at(-1);
    assert.ok(ready?.status === 'ready' && ready.nodes === map.nodes.length && ready.edges === map.edges.length);
    // No edge between candidates (none call each other).
    assert.deepEqual(drawnEdges(), []);
  });

  it('in a section, the listing asks for that section', BUDGET, async () => {
    const fake = revealFake({
      getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
      listEntryCandidates: async () => foundListing([entryCandidate(S.handler, 1)]),
    });
    render(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    showRevealed();
    await waitForDrawn([S.handler.id]);
    assert.deepEqual(fake.calls.listEntryCandidates, [['/work/two-sections', 'api']]);
  });

  it('lists once per map fetch: re-renders and a toggle back to the held state list nothing; a refresh lists again', BUDGET, async () => {
    const fake = revealFake();
    const { rerender } = await mountFull(fake);
    await toRevealed();
    assert.equal(fake.calls.listEntryCandidates.length, 1);
    // Re-renders with nothing new for Revealed.
    rerender(<CodeMap {...props({ noSummaryBackendAvailable: true })} />);
    rerender(<CodeMap {...props({ noSummaryBackendAvailable: false })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Risk signals' }));
    await waitForDrawn([N.handleRequest.id]);
    // Full and back: the held state is drawn again, never re-listed.
    showFull();
    await waitForDrawn(ALL_IDS);
    await toRevealed();
    assert.equal(fake.calls.listEntryCandidates.length, 1, 'no listing for anything but a new map fetch');
    // A re-index refreshes the map in place: a new fetch, so a new listing.
    rerender(<CodeMap {...props({ dataVersion: 1 })} />);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    assert.equal(fake.calls.getCodeMap.length, 2);
    await waitForDrawn([N.handleRequest.id]);
  });
});

describe('PR Review renders Full (replaces the toggle-panel and revealDrawn pins)', () => {
  it('mounted in PR Review: no toggle, no status line, the whole map', BUDGET, async () => {
    const fake = revealFake();
    render(<CodeMap {...props({ mode: 'prReview' })} />);
    await waitForDrawn(ALL_IDS);
    assertAbsent(screen.queryByRole('group', { name: 'Code Map view' }), 'the Revealed / Full map toggle');
    assertAbsent(document.querySelector('.code-map__reveal-status'), 'the Revealed status line');
    assert.deepEqual(fake.calls.listEntryCandidates, []);
  });

  it('with Revealed on: PR Review draws the whole map without the toggle and leaves the viewport; Code Map shows Revealed again', BUDGET, async () => {
    const fake = revealFake();
    const { rerender } = await mountFull(fake);
    await toRevealed();
    const revealedViewport = viewportTransform();

    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    // Full's layout, seen through Revealed's viewport (zoomed on the
    // candidate, so React Flow culls the cards beyond it).
    await waitFor(() => {
      measure();
      assert.ok(drawnIds().includes(N.serviceA.id) && drawnIds().includes(N.repository.id));
    }, FIND);
    assertAbsent(screen.queryByRole('group', { name: 'Code Map view' }), 'the Revealed / Full map toggle');
    assert.deepEqual(candidateLines(), []);
    const grid = fullGrid(pathTraceBasicMap());
    for (const [id, position] of cardPositions()) {
      assert.deepEqual(position, grid.get(id), `${id} at its Full grid position`);
    }
    assert.equal(viewportTransform(), revealedViewport, 'entering PR Review never moves the viewport');

    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(pressedView(), 'Revealed');
    assert.equal(fake.calls.listEntryCandidates.length, 1, 'the held state, not a new listing');
  });
});

describe('PR Review never takes the view a toggle owes (replaces the apply-effect pin)', () => {
  it('Revealed asked while its listing is out, then PR Review: the view waits, and fits the candidates back in Code Map', BUDGET, async () => {
    const listings = deferredListings();
    const { rerender } = await mountFull(revealFake({ listEntryCandidates: listings.stub }));
    const fullViewport = viewportTransform();
    showRevealed();
    await waitFor(() => assert.equal(listings.replies.length, 1), FIND);
    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    await act(async () => listings.replies[0]!.resolve(pathTraceBasicListing()));
    await waitForDrawn(ALL_IDS);
    assert.equal(viewportTransform(), fullViewport, 'PR Review keeps its view');
    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    await waitForDrawn([N.handleRequest.id]);
    await waitFor(() => assert.equal(viewportTransform(), fitTransform([{ x: 0, y: 0 }])), FIND);
  });
});

describe('The none/error/stale notice and the one status line (replaces the canvas-notice and status pins)', () => {
  it('none: the notice over the canvas with one action, "Show full map", said once (in the Panel line); the action shows Full', BUDGET, async () => {
    await mountFull(revealFake({ listEntryCandidates: async () => ({ status: 'none' }) }));
    showRevealed();
    const notice = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.code-map__notice--reveal');
      assert.ok(found, 'the Revealed notice is shown');
      return found;
    }, FIND);
    assert.match(notice.textContent ?? '', new RegExp(NO_ENTRY_CANDIDATES_SENTENCE.replace(/[().]/g, '\\$&')));
    assert.deepEqual(
      within(notice).getAllByRole('button').map((button) => button.textContent),
      ['Show full map'],
    );
    assert.equal(drawnIds().length, 0, 'nothing to draw — but never an empty canvas without the notice');
    assert.notEqual(document.querySelector<HTMLElement>('.react-flow')?.style.visibility, 'hidden');
    assert.equal(revealStatus().textContent, NO_ENTRY_CANDIDATES_SENTENCE);
    assert.equal(statusRegionsSaying(NO_ENTRY_CANDIDATES_SENTENCE).length, 1, 'one live region says it');
    assertSameElement(statusRegionsSaying(NO_ENTRY_CANDIDATES_SENTENCE)[0], revealStatus(), 'the Panel line');

    fireEvent.click(within(notice).getByRole('button', { name: 'Show full map' }));
    await waitForDrawn(ALL_IDS);
    assert.equal(pressedView(), 'Full map');
    assertAbsent(document.querySelector('.code-map__notice--reveal'), 'the Revealed notice');
    assert.equal(revealStatus().textContent, '');
  });

  for (const [kind, stub, sentence] of [
    ['error (a failed listing)', async () => Promise.reject(new Error('boom')), 'Couldn’t list entry candidates: boom'],
    ['error (an error reply)', async () => ({ status: 'error', message: 'index unavailable' }), 'Couldn’t list entry candidates: index unavailable'],
    [
      'stale (no candidate on the map on screen)',
      async () => foundListing([entryCandidate({ ...N.handleRequest, id: 'gone.ts::gone', name: 'gone' }, 5)]),
      ENTRY_CANDIDATES_NOT_ON_MAP_SENTENCE,
    ],
  ] as const) {
    it(`${kind}: the same notice and one action, said once`, BUDGET, async () => {
      await mountFull(revealFake({ listEntryCandidates: stub as NonNullable<DrillerStubs['listEntryCandidates']> }));
      showRevealed();
      const notice = await waitFor(() => {
        const found = document.querySelector<HTMLElement>('.code-map__notice--reveal');
        assert.ok(found);
        return found;
      }, FIND);
      assert.ok((notice.textContent ?? '').includes(sentence));
      assert.deepEqual(within(notice).getAllByRole('button').map((button) => button.textContent), ['Show full map']);
      assert.equal(drawnIds().length, 0);
      assert.equal(revealStatus().textContent, sentence);
      assert.equal(statusRegionsSaying(sentence).length, 1);
    });
  }

  it('loading: the Panel line alone says so, over a canvas held visible — never a notice', BUDGET, async () => {
    const listings = deferredListings();
    await mountFull(revealFake({ listEntryCandidates: listings.stub }));
    showRevealed();
    await waitFor(() => assert.equal(revealStatus().textContent, ENTRY_CANDIDATES_LOADING_TEXT), FIND);
    assert.equal(statusRegionsSaying(ENTRY_CANDIDATES_LOADING_TEXT).length, 1);
    assertAbsent(document.querySelector('.code-map__notice--reveal'), 'the Revealed notice');
    assert.equal(drawnIds().length, 0);
    assert.notEqual(document.querySelector<HTMLElement>('.react-flow')?.style.visibility, 'hidden');
    await act(async () => listings.replies[0]!.resolve(pathTraceBasicListing()));
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(revealStatus().textContent, '');
  });

  it('a section switch in Revealed: the new canvas isn’t held hidden while it has nothing to draw', BUDGET, async () => {
    const listings = deferredListings();
    const maps: Deferred<CodeMapResult>[] = [];
    revealFake({
      getCodeMap: (section) => {
        if (section === undefined || section === 'api') {
          return Promise.resolve(sectionedMap((section ?? null) as SectionName | null));
        }
        const reply = deferred<CodeMapResult>();
        maps.push(reply);
        return reply.promise;
      },
      listEntryCandidates: listings.stub,
    });
    const { rerender } = render(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    showRevealed();
    await act(async () => listings.replies[0]!.resolve(foundListing([entryCandidate(S.handler, 1)])));
    await waitForDrawn([S.handler.id]);

    rerender(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'web' })} />);
    await waitFor(() => assert.equal(maps.length, 1), FIND);
    // The web map lands; its listing is still out. The remounted canvas owes
    // its first fit, but Revealed has nothing to fit yet: shown at once.
    await act(async () => maps[0]!.resolve(sectionedMap('web')));
    act(() => measure());
    // Sampled over 30 animation frames (~0.5 s): never hidden, though the
    // first fit waits for cards (held hidden it would stay ~1 s, the retry window).
    for (let frame = 0; frame < 30; frame += 1) {
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      assert.notEqual(document.querySelector<HTMLElement>('.react-flow')?.style.visibility, 'hidden', `frame ${frame}`);
    }
    assert.equal(revealStatus().textContent, ENTRY_CANDIDATES_LOADING_TEXT);
    await act(async () => listings.replies[1]!.resolve(foundListing([entryCandidate(S.render, 1)])));
    await waitForDrawn([S.render.id]);
    await waitFor(() => assert.equal(viewportTransform(), fitTransform([{ x: 0, y: 0 }])), FIND);
  });
});

describe('Only an explicit toggle moves the viewport (replaces the view-request, apply and refit pins)', () => {
  /** Zooms out with the canvas's own control: a programmatic move, not a user gesture. */
  async function zoomOutWithControl(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
    await settleViewport();
  }

  /** A wheel turn over the canvas: the user's own gesture. */
  async function wheelOverCanvas(): Promise<void> {
    const pane = document.querySelector<HTMLElement>('.react-flow__pane');
    assert.ok(pane);
    fireEvent.wheel(pane, { deltaY: 120, deltaMode: 0, clientX: 100, clientY: 100 });
    await settleViewport();
  }

  it('Revealed fits its candidates; Full brings back the Full viewport the user left, not a fresh fit', BUDGET, async () => {
    await mountFull(revealFake());
    await zoomOutWithControl();
    const left = viewportTransform();
    await toRevealed();
    await waitFor(() => assert.equal(viewportTransform(), fitTransform([...layeredLayout(initialRevealState(pathTraceBasicListing())).values()])), FIND);
    showFull();
    await waitForDrawn(ALL_IDS);
    assert.equal(viewportTransform(), left);
  });

  it('a refresh re-fits Revealed to its new listing — unless the user has moved the view since', BUDGET, async () => {
    let listing: EntryCandidatesResult = pathTraceBasicListing();
    const fake = revealFake({ listEntryCandidates: async () => structuredClone(listing) });
    const { rerender } = await mountFull(fake);
    await toRevealed();
    const twoCandidates = foundListing([entryCandidate(N.handleRequest, 4), entryCandidate(N.repository, 3)]);
    const refitted = fitTransform([...layeredLayout(initialRevealState(twoCandidates)).values()]);
    assert.notEqual(refitted, viewportTransform());

    // A programmatic move (the zoom control) is not the user's: the refresh re-fits.
    await zoomOutWithControl();
    listing = twoCandidates;
    rerender(<CodeMap {...props({ dataVersion: 1 })} />);
    await waitForDrawn([N.handleRequest.id, N.repository.id]);
    await waitFor(() => assert.equal(viewportTransform(), refitted), FIND);

    // A wheel turn is: the next refresh leaves the view where the user put it.
    await wheelOverCanvas();
    const moved = viewportTransform();
    assert.notEqual(moved, refitted);
    listing = pathTraceBasicListing();
    rerender(<CodeMap {...props({ dataVersion: 2 })} />);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 3), FIND);
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(viewportTransform(), moved);
  });
});

describe('Resets (replaces the reload, section-switch and project-reset pins)', () => {
  it('a section switch ignores the old section’s listing, landing before or after the new one’s', BUDGET, async () => {
    const listings = deferredListings();
    const fake = revealFake({
      getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
      listEntryCandidates: listings.stub,
    });
    const { rerender } = render(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    showRevealed();
    await waitFor(() => assert.equal(listings.replies.length, 1), FIND);

    rerender(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'web' })} />);
    await waitFor(() => assert.equal(listings.replies.length, 2), FIND);
    assert.deepEqual(fake.calls.listEntryCandidates, [
      ['/work/two-sections', 'api'],
      ['/work/two-sections', 'web'],
    ]);
    // api's reply lands first: ignored — web is still loading.
    await act(async () => listings.replies[0]!.resolve(foundListing([entryCandidate(S.handler, 1)])));
    assert.deepEqual(drawnIds(), []);
    assert.equal(revealStatus().textContent, ENTRY_CANDIDATES_LOADING_TEXT);
    await act(async () => listings.replies[1]!.resolve(foundListing([entryCandidate(S.render, 1)])));
    await waitForDrawn([S.render.id]);

    // And back to api, its reply landing after the web one it replaced.
    rerender(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'api' })} />);
    await waitFor(() => assert.equal(listings.replies.length, 3), FIND);
    rerender(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'web' })} />);
    await waitFor(() => assert.equal(listings.replies.length, 4), FIND);
    await act(async () => listings.replies[3]!.resolve(foundListing([entryCandidate(S.render, 1)])));
    await waitForDrawn([S.render.id]);
    await act(async () => listings.replies[2]!.resolve(foundListing([entryCandidate(S.handler, 1)])));
    assert.deepEqual(drawnIds(), [S.render.id]);
    assert.equal(fake.calls.listEntryCandidates.length, 4);
  });

  it('a refresh while a listing is out: the newer listing wins, the older reply landing after it changes nothing (P4-8k)', BUDGET, async () => {
    const listings = deferredListings();
    let maps = 0;
    const fake = revealFake({
      getCodeMap: async (section) => {
        maps += 1;
        return sectionedMap((section ?? null) as SectionName | null);
      },
      listEntryCandidates: listings.stub,
    });
    const view = (dataVersion: number) => <CodeMap {...props({ projectPath: '/work/two-sections', section: 'api', dataVersion })} />;
    const { rerender } = render(view(0));
    await waitForDrawn([S.handler.id, S.validate.id]);
    showRevealed();
    await waitFor(() => assert.equal(listings.replies.length, 1), FIND);
    rerender(view(1));
    await waitFor(() => assert.equal(listings.replies.length, 2), FIND);
    assert.equal(maps, 2);
    await act(async () => listings.replies[1]!.resolve(foundListing([entryCandidate(S.validate, 1)])));
    await waitForDrawn([S.validate.id]);
    await act(async () => listings.replies[0]!.resolve(foundListing([entryCandidate(S.handler, 1)])));
    assert.deepEqual(drawnIds(), [S.validate.id]);
    assert.equal(fake.calls.listEntryCandidates.length, 2);
  });

  it('a listing whose section is gone: the section asked for goes to the fallback, once, and the notice offers the full map (P4-8k)', BUDGET, async () => {
    const fake = revealFake({
      getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
      listEntryCandidates: async () => ({ status: 'unknown-section', section: 'echo', knownSections: ['web'] }),
    });
    const gone: string[] = [];
    render(<CodeMap {...props({ projectPath: '/work/two-sections', section: 'api', onUnknownSection: (name) => gone.push(name) })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    showRevealed();
    await waitFor(() => assert.deepEqual(gone, ['api']), FIND);
    const notice = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.code-map__notice--reveal');
      assert.ok(found);
      return found;
    }, FIND);
    assert.deepEqual(within(notice).getAllByRole('button').map((button) => button.textContent), ['Show full map']);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    });
    assert.deepEqual(gone, ['api'], 'once');
    assert.deepEqual(fake.calls.listEntryCandidates, [['/work/two-sections', 'api']]);
  });

  it('a project change resets the view to Full: the whole map, no candidate', BUDGET, async () => {
    const fake = revealFake();
    const { rerender } = await mountFull(fake);
    await toRevealed();
    // (App remounts CodeMap per project; CodeMap's own reset is what this pins.)
    rerender(<CodeMap {...props({ projectPath: '/fixture/other' })} />);
    await waitForDrawn(ALL_IDS);
    assert.equal(pressedView(), 'Full map');
    assert.deepEqual(candidateLines(), []);
    assert.equal(fake.calls.listEntryCandidates.length, 1, 'no listing for the new project');
  });

  // Latent, not reachable through App (it remounts CodeMap per project).
  // FIX-5: the view goes back to Full in the render where `projectPath`
  // changes, so the listing effect never asks for the new project's
  // candidates against the old project's map fetch.
  it(
    'a project change makes no listing call for the new project',
    BUDGET,
    async () => {
      const fake = revealFake();
      const { rerender } = await mountFull(fake);
      await toRevealed();
      rerender(<CodeMap {...props({ projectPath: '/fixture/other' })} />);
      await waitForDrawn(ALL_IDS);
      assert.deepEqual(fake.calls.listEntryCandidates, [[FIXTURE_PROJECT_PATH, undefined]]);
    },
  );
});

/** The cards lit as a Path Trace route or a neighbour trace. */
function litIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node.code-map__path-highlight')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .sort();
}

/** The drawn edge `source → target`, measuring the cards first (React Flow draws edges between measured cards). */
async function findEdge(source: string, target: string): Promise<HTMLElement> {
  return waitFor(() => {
    measure();
    const found = [...document.querySelectorAll<HTMLElement>('.react-flow__edge')].find((element) =>
      (element.getAttribute('data-id') ?? '').startsWith(`${source}→${target}:`),
    );
    assert.ok(found, `the edge ${source} → ${target} is drawn`);
    return found;
  }, FIND);
}

function assertCentredOn(position: { x: number; y: number }, what: string): void {
  const centre = viewportCentre();
  assert.ok(
    Math.abs(centre.x - position.x) < 1e-6 && Math.abs(centre.y - position.y) < 1e-6,
    `${what}: the view is centred on (${position.x}, ${position.y}), not (${centre.x}, ${centre.y})`,
  );
}

/**
 * Expands `handleRequest` (two layers: serviceA, serviceB, then repository; serviceB's call to it a ref).
 *
 * P4-8j: the toggle's fit may still be moving the view when this starts; a
 * drilled column is culled until it ends, and under a loaded machine that
 * outlasted the drawn-cards wait once (the flake seen at the old line 711).
 * So the move settles first, and the drill gets a wait of its own.
 */
async function expandHandleRequest(): Promise<void> {
  await settleViewport();
  fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
  await waitForDrawn(DRILL_WAIT, [
    N.handleRequest.id,
    N.serviceA.id,
    N.serviceB.id,
    N.repository.id,
    `reveal:ref:${JSON.stringify([N.serviceB.id, N.repository.id])}`,
  ]);
}

describe('Navigating to a Node Revealed doesn’t draw switches to Full (replaces the navigation, switch and cross-section pins)', () => {
  it('a card’s callee pill: Full, "Showing the full map to reach …", the trace drawn there; the drill is kept for Revealed', { timeout: 2 * BUDGET.timeout }, async () => {
    // Wide enough for Revealed's third column at the candidate's zoom (no culling).
    elementSize.set(3000, 2000);
    const fake = revealFake();
    await mountFull(fake);
    const fullViewport = viewportTransform();
    await toRevealed();
    await expandHandleRequest();
    const drilled = drawnIds();
    const revealedViewport = viewportTransform();

    // repository's callee (cacheLookup) is not revealed.
    fireEvent.click(await findOnCanvas(`1 call — show the callee of ${N.repository.name}`));
    await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
    assert.equal(revealStatus().textContent, revealSwitchMessage(N.cacheLookup.name));
    assert.equal(statusRegionsSaying(revealSwitchMessage(N.cacheLookup.name)).length, 1);
    // The navigation is replayed on Full: the trace and its fit.
    await waitFor(() => {
      measure();
      assert.deepEqual(litIds(), [N.cacheLookup.id, N.repository.id].sort());
    }, FIND);
    assert.match(document.body.textContent ?? '', /Callees of\s*repository\s*\(1\)/, 'the trace’s step panel');
    await settleViewport();
    assert.notEqual(viewportTransform(), fullViewport, 'the switch restores no saved view');
    assert.notEqual(viewportTransform(), revealedViewport, 'the replay fits the trace');
    assert.equal(revealStatus().textContent, revealSwitchMessage(N.cacheLookup.name), 'the replay keeps the line it set');

    // The reveal state is kept: Revealed comes back drilled, with no new listing.
    showRevealed();
    await waitForDrawn(drilled);
    assert.equal(fake.calls.listEntryCandidates.length, 1);
    assert.equal(revealStatus().textContent, '', 'a toggle clears the switch line');
    // P5-b (Node 22 act flake): the toggle's fit is still moving the view;
    // let it finish inside the test's own wait, not in the teardown.
    await settleViewport();
  });

  it('a Path Trace search through hidden Nodes: Full, the line, the route lit', BUDGET, async () => {
    const route: PathTraceResult = {
      status: 'found',
      path: [N.handleRequest.id, N.serviceA.id, N.repository.id],
      parents: Object.assign(Object.create(null) as Record<string, string | null>, {
        [N.handleRequest.id]: null,
        [N.serviceA.id]: N.handleRequest.id,
        [N.repository.id]: N.serviceA.id,
      }),
      depths: Object.assign(Object.create(null) as Record<string, number>, {
        [N.handleRequest.id]: 0,
        [N.serviceA.id]: 1,
        [N.repository.id]: 2,
      }),
    };
    await mountFull(revealFake({ tracePath: async () => route, logDiagnosticEvent: async () => undefined }));
    await toRevealed();
    fireEvent.change(screen.getByRole('textbox', { name: 'Path Trace query' }), { target: { value: 'handleRequest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trace' }));
    await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
    assert.equal(revealStatus().textContent, revealSwitchMessage(N.serviceA.name));
    await waitFor(() => {
      measure();
      assert.deepEqual(litIds(), [...route.path].sort());
    }, FIND);
    await settleViewport();
  });

  it('Back and Forward to a Node Revealed doesn’t draw: Full, the line, centred on it, history moved', { timeout: 2 * BUDGET.timeout }, async () => {
    await mountFull(revealFake());
    // Two node entries, made in Full: repository, then serviceA.
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await settleViewport();
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await settleViewport();
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    assert.equal(back.hasAttribute('disabled'), false);

    await toRevealed();
    fireEvent.click(back);
    await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
    assert.equal(revealStatus().textContent, revealSwitchMessage(N.repository.name));
    await waitFor(() => assert.equal(back.hasAttribute('disabled'), true, 'history moved back to the first entry'), FIND);
    assert.equal(forward.hasAttribute('disabled'), false);
    await settleViewport();
    assertCentredOn(fullGrid(pathTraceBasicMap()).get(N.repository.id)!, 'Back');

    // And Forward, from Revealed again, to serviceA.
    await toRevealed();
    fireEvent.click(forward);
    await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
    assert.equal(revealStatus().textContent, revealSwitchMessage(N.serviceA.name));
    await waitFor(() => assert.equal(forward.hasAttribute('disabled'), true, 'history moved forward'), FIND);
    await settleViewport();
    assertCentredOn(fullGrid(pathTraceBasicMap()).get(N.serviceA.id)!, 'Forward');
  });

  it('a cross-section focus target Revealed doesn’t draw (Node detail’s "Switch to web"): Full, the line, centred and focused — never "not on the map"', BUDGET, async () => {
    const fake = revealFake({
      getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
      listEntryCandidates: async (_project, section) =>
        // In web, `render` reaches 1 Node: no candidate.
        section === 'api' ? foundListing([entryCandidate(S.handler, 1)]) : { status: 'none' },
    });
    function Shell() {
      const [section, setSection] = useState<string | null>('api');
      const [pending, setPending] = useState<string | null>(null);
      return (
        <CodeMap
          {...props({
            projectPath: '/work/two-sections',
            section,
            pendingFocusNodeId: pending,
            onSwitchSection: (next, focusNodeId) => {
              setSection(next);
              setPending(focusNodeId ?? null);
            },
            onPendingFocusConsumed: () => setPending(null),
          })}
        />
      );
    }
    render(<Shell />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    showRevealed();
    await waitForDrawn([S.handler.id]);
    fireEvent.click(await findOnCanvas(/^Function handler, entry candidate/));
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${S.handler.name}` }, FIND);
    fireEvent.click(within(detail).getByRole('button', { name: 'Switch to web and show render' }));

    await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
    assert.equal(revealStatus().textContent, revealSwitchMessage(S.render.name));
    assertAbsent(screen.queryByRole('button', { name: 'Dismiss' }), 'no "not on the current map" notice');
    await waitForDrawn([S.render.id, S.layout.id]);
    await settleViewport();
    assertCentredOn(fullGrid(sectionedMap('web')).get(S.render.id)!, 'the cross-section target');
    await waitFor(() => {
      const card = document.querySelector(`.react-flow__node[data-id="${CSS.escape(S.render.id)}"] .code-map__node`);
      assertSameElement(document.activeElement, card, 'focus');
    }, FIND);
    assert.deepEqual(fake.calls.listEntryCandidates, [
      ['/work/two-sections', 'api'],
      ['/work/two-sections', 'web'],
    ]);
  });

  // P4-7d "a Node-detail link … switches to Full" (FIX-5): a Node Revealed
  // doesn't draw is still a link — it once read "Not on the current map
  // (hidden by scope or filters)", with no link and a false reason.
  it(
    'a Node detail link to a Node Revealed doesn’t draw switches to Full',
    BUDGET,
    async () => {
      const map = pathTraceBasicMap();
      map.nodes[0] = { ...map.nodes[0]!, fileTopLevel: [{ id: N.serviceA.id, kind: 'CALLS' }] };
      await mountFull(revealFake({ getCodeMap: async () => structuredClone(map) }));
      // In Full, the entry is a link.
      fireEvent.click(await findOnCanvas(/^Function handleRequest, open Node detail/));
      const full = await screen.findByRole('dialog', { name: `Node detail: ${N.handleRequest.name}` }, FIND);
      assert.ok(within(full).getByRole('button', { name: /^Go to serviceA/ }));
      fireEvent.click(within(full).getByRole('button', { name: /close/i }));
      await waitFor(() => assertAbsent(screen.queryByRole('dialog'), 'a dialog'), FIND);
      await toRevealed();
      fireEvent.click(await findOnCanvas(/^Function handleRequest, entry candidate/));
      const detail = await screen.findByRole('dialog', { name: `Node detail: ${N.handleRequest.name}` }, FIND);
      fireEvent.click(within(detail).getByRole('button', { name: /^Go to serviceA/ }));
      await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
      assert.equal(revealStatus().textContent, revealSwitchMessage(N.serviceA.name));
    },
  );
});

describe('The switch line clears (replaces the status-clear pin)', () => {
  const message = revealSwitchMessage(N.serviceA.name);

  /** Revealed with `handleRequest` alone; its callee pill reaches serviceA, which Revealed doesn't draw. */
  async function revealedWithPill(fake: FakeDrillerApi) {
    const view = await mountFull(fake);
    await toRevealed();
    return { ...view, pill: await findOnCanvas(`2 calls — show the callees of ${N.handleRequest.name}`) };
  }

  it('the replay of the navigation that set it keeps it; the next navigation clears it', BUDGET, async () => {
    const { pill } = await revealedWithPill(revealFake());
    fireEvent.click(pill);
    await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
    await waitFor(() => {
      measure();
      assert.deepEqual(litIds(), [N.handleRequest.id, N.serviceA.id, N.serviceB.id].sort());
    }, FIND);
    await settleViewport();
    assert.equal(revealStatus().textContent, message);

    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await waitFor(() => assert.equal(revealStatus().textContent, ''), FIND);
    await settleViewport();
  });

  it('a mode change clears it', BUDGET, async () => {
    const { pill, rerender } = await revealedWithPill(revealFake());
    fireEvent.click(pill);
    await waitFor(() => assert.equal(revealStatus().textContent, message), FIND);
    await settleViewport();
    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    assert.equal(revealStatus().textContent, '');
  });

  it(`it clears itself after REVEAL_SWITCH_STATUS_MS (${REVEAL_SWITCH_STATUS_MS} ms)`, BUDGET, async () => {
    const { pill } = await revealedWithPill(revealFake());
    // Only `setTimeout` is mocked (jsdom's animation frames run on
    // `setInterval`); nothing below waits through Testing Library, whose
    // waits run on `setTimeout`.
    // Node 22 warns that MockTimers is experimental (through console.error,
    // which fails a DOM test); Node 25 doesn't. Only that warning is dropped.
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (!String(warning instanceof Error ? warning.message : warning).includes('MockTimers')) {
        (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
      }
    }) as typeof process.emitWarning;
    try {
      mock.timers.enable({ apis: ['setTimeout'] });
    } finally {
      process.emitWarning = emitWarning;
    }
    try {
      fireEvent.click(pill);
      await act(async () => {});
      assert.equal(pressedView(), 'Full map');
      assert.equal(revealStatus().textContent, message);
      act(() => mock.timers.tick(REVEAL_SWITCH_STATUS_MS - 1));
      assert.equal(revealStatus().textContent, message);
      act(() => mock.timers.tick(1));
      assert.equal(revealStatus().textContent, '');
    } finally {
      mock.timers.reset();
    }
    await settleViewport();
  });
});

describe('A toggle resets the cluster expansions (replaces the toggle wiring pin)', () => {
  // P5-d chore: usually 1.2–2.3 s, it overran its ~3 s budget once under
  // full-suite load (P5-c's run); the doubled budget its siblings use.
  it('a cluster expanded in Full is a cluster again after Revealed and back', { timeout: 2 * BUDGET.timeout }, async () => {
    const map = syntheticMapForClusters();
    await mountClusters(map);
    showAllNodes();
    const cluster = expandableCluster();
    const clusterId = cluster.getAttribute('data-id') ?? '';
    fireEvent.click(cluster);
    await waitFor(() => {
      measure();
      assert.ok(!drawnIdsWithClusters().includes(clusterId), 'the cluster opened into its cards');
    }, FIND);
    const left = viewportTransform();

    showRevealed();
    await waitForDrawn([map.nodes[0]!.id]);
    showFull();
    await waitFor(() => {
      measure();
      assert.equal(viewportTransform(), left);
      assert.ok(drawnIdsWithClusters().includes(clusterId), 'the cluster is closed again');
    }, FIND);
  });
});

function syntheticMapForClusters(): CodeMapOk {
  return syntheticMap({ nodes: 300 });
}

function drawnIdsWithClusters(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')].map((node) => node.getAttribute('data-id') ?? '');
}

/** Mounts a 300-Node map and zooms out (with the canvas's control) until clusters are drawn. */
async function mountClusters(map: CodeMapOk): Promise<void> {
  revealFake({
    getCodeMap: async () => structuredClone(map),
    listEntryCandidates: async () => foundListing([entryCandidate(map.nodes[0]!, 3)]),
  });
  render(<CodeMap {...props()} />);
  await waitFor(() => {
    measure();
    assert.ok(drawnIds().length > 0);
  }, FIND);
  for (let step = 0; step < 6 && document.querySelector('.react-flow__node[data-id^="cluster:"]') === null; step += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
    await settleViewport();
    act(() => measure());
  }
}

/** A drawn cluster card small enough to open in place ("N nodes", not "zoom in"). */
function expandableCluster(): HTMLElement {
  const cluster = [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="cluster:"]')].find((card) =>
    /nodes$/.test(card.textContent ?? ''),
  );
  assert.ok(cluster, 'an expandable cluster is drawn');
  return cluster;
}
