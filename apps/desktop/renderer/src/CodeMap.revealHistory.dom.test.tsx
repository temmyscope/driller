/**
 * P4-8g: drill steps in Back/Forward history, the `+`/`−` keyboard and the
 * Panel's announcements (P4-7f), rendered for real (jsdom, a fake
 * `window.driller`) — replacing the `CodeMap.revealHistory.test.ts` source
 * pins. Each test drives what a user drives (the toggle, a card's expand and
 * collapse buttons, a stub, a ref card, an edge click, the keyboard on a
 * focused card, Back and Forward, a refresh, a section or mode change) and
 * asserts what the user and the IPC boundary see: the cards drawn, the
 * history buttons' state, the view's centre, focus, the one `role="status"`
 * line, and the recorded `window.driller` calls.
 *
 * Fixtures: `path-trace-basic` (its candidate `handleRequest`; fan-in
 * `serviceA`/`serviceB` → `repository`, the `repository` ↔ `cacheLookup`
 * cycle), a `drillHub` over `REVEAL_LAYER_CAP` for a stub, and the
 * two-section project for a section switch. The pure history tests
 * (`historyMove`, the cap, …) stay in `CodeMap.revealHistory.test.ts`.
 */
import './test/domEnv';
import { animatingElements, assertSameElement, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import process, { env } from 'node:process';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodeMap, type CodeMapProps } from './CodeMap';
import {
  NO_MORE_CALLEES_TEXT,
  NOTHING_TO_COLLAPSE_TEXT,
  REVEAL_LAYER_CAP,
  REVEAL_SWITCH_STATUS_MS,
  revealRefCardId,
  revealStubCardId,
  revealSwitchMessage,
} from './revealView';
import { createFakeDrillerApi, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
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
  type SectionName,
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
const LONG = { timeout: 2 * BUDGET.timeout };
const FIND = { timeout: 1_500 };
const N = FIXTURE_NODES;
const S = SECTION_NODES;
const SECTIONED_PROJECT = '/work/two-sections';

function historyFake(stubs: DrillerStubs = {}): FakeDrillerApi {
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

/** Every `window.driller` request so far, as `member:count` — a history step must leave it unchanged. */
function ipcCalls(fake: FakeDrillerApi): string[] {
  return Object.entries(fake.calls)
    .filter(([name, calls]) => !name.startsWith('on') && calls.length > 0)
    .map(([name, calls]) => `${name}:${calls.length}`);
}

/** Reports the canvas's and the cards' sizes (React Flow hides a card until it is measured). */
function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

/** Every drawn card's id (a Node's, or a ref/stub card's), clusters left out, sorted. */
function drawnIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('cluster:'))
    .sort();
}

async function waitForDrawn(ids: readonly string[]): Promise<void> {
  await waitFor(() => {
    measure();
    assert.deepEqual(drawnIds(), [...ids].sort());
  }, FIND);
}

/** A button (or a `role="button"` card) on the canvas, once drawn and measured. */
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

/** The Panel's one status line (`role="status"`), mounted while Code Map shows a map. */
function revealStatus(): string {
  const line = document.querySelector<HTMLElement>('.code-map__reveal-status');
  assert.ok(line, 'the Revealed status line is mounted');
  assert.equal(line.getAttribute('role'), 'status');
  return line.textContent ?? '';
}

/** Every live region whose text is `text` — a reveal is said once, in one place. */
function statusRegionsSaying(text: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"], [aria-live]')].filter(
    (element) => element.textContent === text,
  );
}

function backButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Back' });
}

function forwardButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Forward' });
}

/** Back and Forward's state, as `{back, forward}` enabled flags. */
function historyButtons(): { back: boolean; forward: boolean } {
  return { back: !backButton().hasAttribute('disabled'), forward: !forwardButton().hasAttribute('disabled') };
}

function viewportTransform(): string {
  return document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
}

/**
 * Waits for an animated viewport move to end. A move asked for by an effect
 * (Back's centring) starts a frame or two after the click, so the first
 * frames run inside `act` before the wait begins — otherwise the wait could
 * pass before the move starts and its frames update React outside `act`.
 */
async function settleViewport(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
  await waitFor(() => assert.equal(animatingElements().length, 0, 'the viewport is still animating'), FIND);
}

/** The world point at the centre of the canvas. */
function viewportCentre(): { x: number; y: number } {
  const match = /translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(viewportTransform());
  assert.ok(match, `a viewport transform (${viewportTransform()})`);
  const [x, y, zoom] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { x: (elementSize.width / 2 - x) / zoom, y: (elementSize.height / 2 - y) / zoom };
}

/** A drawn card's position (its React Flow wrapper's `translate`) — what `centerOnNode` centres on. */
function cardPosition(id: string): { x: number; y: number } {
  const card = cardWrapper(id);
  assert.ok(card, `${id} is drawn`);
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card.style.transform);
  assert.ok(match, `${id} has a position`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function assertCentredOn(position: { x: number; y: number }, what: string): void {
  const centre = viewportCentre();
  assert.ok(
    Math.abs(centre.x - position.x) < 1e-6 && Math.abs(centre.y - position.y) < 1e-6,
    `${what}: the view is centred on (${position.x}, ${position.y}), not (${centre.x}, ${centre.y})`,
  );
}

function cardWrapper(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
}

/** A Node card's own focusable element (`role="button"`, the one the keyboard drives). */
function nodeCard(id: string): HTMLElement {
  const card = cardWrapper(id)?.querySelector<HTMLElement>('.code-map__node');
  assert.ok(card, `${id}'s Node card is drawn`);
  return card;
}

/** Focuses a Node card (inside `act`: the canvas tracks the focused candidate in state). */
function focusCard(id: string): void {
  act(() => nodeCard(id).focus());
}

/** A wheel turn over the canvas: the user moves the view. */
async function wheelOverCanvas(): Promise<void> {
  const pane = document.querySelector<HTMLElement>('.react-flow__pane');
  assert.ok(pane);
  fireEvent.wheel(pane, { deltaY: 120, deltaMode: 0, clientX: 100, clientY: 100 });
  await settleViewport();
  // d3-zoom ends a wheel gesture on a 150 ms idle timer, whose move-end
  // updates React Flow and CodeMap: let it fire inside `act`.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  });
}

/** The drawn real map edge `source → target`, measuring first (React Flow draws edges between measured cards). */
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

/** Mounts Code Map on its map and waits for some card. */
async function mountMap(overrides: Partial<CodeMapProps> = {}) {
  const view = render(<CodeMap {...props(overrides)} />);
  await waitFor(() => {
    measure();
    assert.ok(drawnIds().length > 0);
  }, FIND);
  return view;
}

async function toRevealed(candidates: readonly string[] = [N.handleRequest.id]): Promise<void> {
  fireEvent.click(toggleButton('Revealed'));
  await waitForDrawn(candidates);
}

/** Mounts Code Map and switches to Revealed, waiting for exactly the candidates' cards. */
async function mountRevealed(candidates: readonly string[] = [N.handleRequest.id], overrides: Partial<CodeMapProps> = {}) {
  const view = await mountMap(overrides);
  await toRevealed(candidates);
  return view;
}

const REPOSITORY_REF = revealRefCardId(N.serviceB.id, N.repository.id);

/** What expanding `handleRequest` draws: two layers, serviceB's call to repository a ref. */
const HANDLE_REQUEST_EXPANDED = [N.handleRequest.id, N.serviceA.id, N.serviceB.id, N.repository.id, REPOSITORY_REF];
const EXPANDED_ANNOUNCEMENT = `Revealed 3 callees of ${N.handleRequest.name} in 2 layers`;
const UNDO_ANNOUNCEMENT = `Back: restored the view before expanding ${N.handleRequest.name}`;

async function expandHandleRequest(): Promise<void> {
  fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
  await waitForDrawn(HANDLE_REQUEST_EXPANDED);
}

/**
 * Takes over `requestAnimationFrame` (and its cancel) so a test can step the
 * frame the announcement waits for. React Flow's own animation keeps jsdom's
 * frames (d3 bound them when it loaded).
 */
function manualAnimationFrames(): { pending(): number; step(): void; restore(): void } {
  const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const cafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const id = nextId;
      nextId += 1;
      queue.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => {
      queue.delete(id);
    },
  });
  return {
    pending: () => queue.size,
    step() {
      const callbacks = [...queue.values()];
      queue.clear();
      act(() => {
        for (const callback of callbacks) {
          callback(performance.now());
        }
      });
    },
    restore() {
      if (rafDescriptor !== undefined) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', rafDescriptor);
      }
      if (cafDescriptor !== undefined) {
        Object.defineProperty(globalThis, 'cancelAnimationFrame', cafDescriptor);
      }
    },
  };
}

/**
 * `mock.timers` for `setTimeout` only (jsdom's animation frames run on
 * `setInterval`). Node 22 warns that MockTimers is experimental, through
 * `console.error` (which fails a DOM test); Node 25 doesn't. Only that
 * warning is dropped, and only while enabling.
 */
function mockSetTimeout(): void {
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
}

describe('Back and Forward over drill steps (replaces the Back/Forward, entry-union and node-push pins)', () => {
  it('Back after an expand collapses it, Forward re-expands it; disabled at either end; each step said once; no IPC', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const fake = historyFake();
    await mountRevealed();
    assert.deepEqual(historyButtons(), { back: false, forward: false }, 'toggling Revealed pushed nothing');
    const before = ipcCalls(fake);

    await expandHandleRequest();
    assert.equal(revealStatus(), EXPANDED_ANNOUNCEMENT);
    assert.equal(statusRegionsSaying(EXPANDED_ANNOUNCEMENT).length, 1, 'said in one place');
    assert.deepEqual(historyButtons(), { back: true, forward: false });

    fireEvent.click(backButton());
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(revealStatus(), UNDO_ANNOUNCEMENT);
    assert.equal(statusRegionsSaying(UNDO_ANNOUNCEMENT).length, 1);
    assert.deepEqual(historyButtons(), { back: false, forward: true });
    const expand = await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`);
    assert.equal(expand.getAttribute('aria-expanded'), 'false');

    fireEvent.click(forwardButton());
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(revealStatus(), `Forward: ${EXPANDED_ANNOUNCEMENT}`);
    assert.deepEqual(historyButtons(), { back: true, forward: false });
    assert.equal(screen.getByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` }).getAttribute('aria-expanded'), 'true');
    assert.deepEqual(ipcCalls(fake), before, 'Back and Forward restore locally: no listing, no fetch');
    await settleViewport();
  });

  it('expand, a stub and collapse are one Back step each; toggles push none; Back from Full switches to Revealed and restores', LONG, async () => {
    elementSize.set(4000, 16_000);
    const hub = drillHub(REVEAL_LAYER_CAP + 1, { grandchildren: false });
    historyFake({ getCodeMap: async () => drillMap([hub]), listEntryCandidates: async () => foundListing([hub.candidate]) });
    await mountRevealed([hub.hub.id]);
    const stubId = revealStubCardId(hub.hub.id);
    const capped = [hub.hub.id, ...hub.callees.slice(0, REVEAL_LAYER_CAP).map((node) => node.id), stubId];
    const all = [hub.hub.id, ...hub.callees.map((node) => node.id)];

    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_LAYER_CAP + 1} callees of ${hub.hub.name}`));
    await waitForDrawn(capped);
    fireEvent.click(await findOnCanvas(`+1 more callee of ${hub.hub.name}, show the next 1`));
    await waitForDrawn(all);
    fireEvent.click(screen.getByRole('button', { name: `Collapse the callees of ${hub.hub.name}` }));
    await waitForDrawn([hub.hub.id]);

    // Toggles in between push nothing; Back from Full goes back to Revealed.
    fireEvent.click(toggleButton('Full map'));
    await waitForDrawn(all);
    fireEvent.click(toggleButton('Revealed'));
    await waitForDrawn([hub.hub.id]);
    fireEvent.click(toggleButton('Full map'));
    await waitForDrawn(all);
    fireEvent.click(backButton());
    await waitFor(() => assert.equal(pressedView(), 'Revealed'), FIND);
    await waitForDrawn(all);
    assert.equal(revealStatus(), `Back: restored the view before collapsing ${hub.hub.name}`);

    fireEvent.click(backButton());
    await waitForDrawn(capped);
    assert.equal(revealStatus(), `Back: restored the view before showing more callees of ${hub.hub.name}`);
    fireEvent.click(backButton());
    await waitForDrawn([hub.hub.id]);
    assert.deepEqual(historyButtons(), { back: false, forward: true }, 'three steps, three Backs');
    await settleViewport();
  });

  it('a mixed stack [a, b, expand]: Back undoes the expand (b isn’t drawn: centred on the step’s Node, still Revealed), then reaches a through Full', LONG, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    await mountMap();
    // Two node entries, made in Full: repository, then serviceA.
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await settleViewport();
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await settleViewport();
    await toRevealed();
    await expandHandleRequest();
    await wheelOverCanvas();

    fireEvent.click(backButton());
    await waitForDrawn([N.handleRequest.id]);
    await settleViewport();
    assert.equal(pressedView(), 'Revealed', 'an undo never switches to Full');
    assert.equal(revealStatus(), UNDO_ANNOUNCEMENT);
    assertCentredOn(cardPosition(N.handleRequest.id), 'serviceA isn’t drawn: the step’s own Node');
    assert.deepEqual(historyButtons(), { back: true, forward: true });

    // The node entry before it is repository's: not drawn in Revealed, so the
    // move goes through Full (the hidden-Node replay) and lands on its index.
    fireEvent.click(backButton());
    await waitFor(() => assert.equal(pressedView(), 'Full map'), FIND);
    assert.equal(revealStatus(), revealSwitchMessage(N.repository.name));
    await settleViewport();
    assertCentredOn(cardPosition(N.repository.id), 'Back to repository');
    await waitFor(() => assert.deepEqual(historyButtons(), { back: false, forward: true }), FIND);

    // Forward: serviceA (Full), then the expand again — back in Revealed.
    fireEvent.click(forwardButton());
    await settleViewport();
    assertCentredOn(cardPosition(N.serviceA.id), 'Forward to serviceA');
    fireEvent.click(forwardButton());
    await waitFor(() => assert.equal(pressedView(), 'Revealed'), FIND);
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(revealStatus(), `Forward: ${EXPANDED_ANNOUNCEMENT}`);
    assert.deepEqual(historyButtons(), { back: true, forward: false });
    await settleViewport();
  });

  /** Revealed: expand handleRequest, go to repository through its ref card (a node entry), expand repository. */
  async function drillToCacheLookup(): Promise<void> {
    historyFake();
    await mountRevealed();
    await expandHandleRequest();
    const user = userEvent.setup();
    const ref = screen.getByRole('button', { name: `${N.repository.name} is shown above, go to it` });
    act(() => ref.focus());
    await user.keyboard('{Enter}');
    await settleViewport();
    fireEvent.click(await findOnCanvas(`Expand 1 callee of ${N.repository.name}`));
    await waitForDrawn([...HANDLE_REQUEST_EXPANDED, N.cacheLookup.id, revealRefCardId(N.cacheLookup.id, N.repository.id)]);
  }

  it('the Node the undo lands on is centred when it is drawn; Back from a Node onto a step shows it again', LONG, async () => {
    elementSize.set(3000, 2000);
    await drillToCacheLookup();
    await wheelOverCanvas();

    fireEvent.click(backButton());
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    await settleViewport();
    assert.equal(revealStatus(), `Back: restored the view before expanding ${N.repository.name}`);
    assertCentredOn(cardPosition(N.repository.id), 'the node entry it lands on is drawn');

    // Back again: from repository's node entry onto the expand — shown again.
    await wheelOverCanvas();
    fireEvent.click(backButton());
    await settleViewport();
    assert.equal(revealStatus(), `Back: returned to ${N.handleRequest.name} in the Revealed view`);
    assert.deepEqual(drawnIds(), [...HANDLE_REQUEST_EXPANDED].sort());
    assertCentredOn(cardPosition(N.handleRequest.id), 'the step’s Node');
    fireEvent.click(backButton());
    await waitForDrawn([N.handleRequest.id]);
    assert.deepEqual(historyButtons(), { back: false, forward: true });
    await settleViewport();
  });

  // P4-7f review round 1 #6 ("a Back/Forward over a reveal entry that
  // removes the keyboard-focused card moves focus to the step's Node card").
  // FIX-5: React Flow only removes the card in its next render (its
  // `StoreUpdater` copies the `nodes` prop into its store in a passive
  // effect), so the rescue once saw the card still connected, moved nothing,
  // and focus fell to `<body>`. It now waits for the card to go. The same
  // effect order holds in Chromium; confirm in the live check (FIX-5 row).
  it(
    'a step that removes the focused card moves focus to the step’s Node card',
    LONG,
    async () => {
      elementSize.set(3000, 2000);
      await drillToCacheLookup();
      // Focus on cacheLookup's card, which the undo removes. (A click doesn't
      // move focus in jsdom — as with a mouse click in Safari.)
      focusCard(N.cacheLookup.id);
      fireEvent.click(backButton());
      await waitForDrawn(HANDLE_REQUEST_EXPANDED);
      await settleViewport();
      await waitFor(() => assertSameElement(document.activeElement, nodeCard(N.repository.id), 'focus'), FIND);
    },
  );
});

describe('PR Review skips reveal entries (replaces the toolbar pins)', () => {
  it('Back in PR Review steps past a reveal entry to the Node before it; the drill is untouched for Code Map', LONG, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    const { rerender } = await mountMap();
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await settleViewport();
    await toRevealed();
    await expandHandleRequest();
    await wheelOverCanvas();

    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    await waitFor(() => {
      measure();
      assert.equal(drawnIds().length, Object.keys(N).length, 'PR Review renders Full');
    }, FIND);
    assert.deepEqual(historyButtons(), { back: true, forward: false });
    fireEvent.click(backButton());
    await settleViewport();
    assertCentredOn(cardPosition(N.repository.id), 'Back in PR Review centres on the node entry');
    // Forward would only reach the reveal entry: nothing to go to here.
    await waitFor(() => assert.deepEqual(historyButtons(), { back: false, forward: false }), FIND);

    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(pressedView(), 'Revealed');
  });

  it('a history of reveal entries only: Back and Forward are disabled in PR Review, enabled again in Code Map', BUDGET, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    const { rerender } = await mountRevealed();
    await expandHandleRequest();
    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    await waitFor(() => assert.deepEqual(historyButtons(), { back: false, forward: false }), FIND);
    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.deepEqual(historyButtons(), { back: true, forward: false });
  });
});

describe('No reveal entry outlives its map (replaces the stale-entry and section-switch pins)', () => {
  it('a refresh (a new map fetch) drops the reveal entries but keeps the node entries', LONG, async () => {
    elementSize.set(3000, 2000);
    const fake = historyFake();
    const { rerender } = await mountMap();
    // Two node entries: repository, then serviceA.
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await settleViewport();
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await settleViewport();
    await toRevealed();
    await expandHandleRequest();

    rerender(<CodeMap {...props({ dataVersion: 1 })} />);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    // Back is still possible — from serviceA's node entry to repository's
    // (drawn: the refresh kept the drill) — never to the expand taken on the
    // previous fetch.
    assert.deepEqual(historyButtons(), { back: true, forward: false });
    fireEvent.click(backButton());
    await settleViewport();
    assertCentredOn(cardPosition(N.repository.id), 'Back to repository');
    assert.equal(pressedView(), 'Revealed');
    await waitFor(() => assert.deepEqual(historyButtons(), { back: false, forward: true }), FIND);
  });

  it('a refresh with a lone expand leaves nothing to go Back to', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const fake = historyFake();
    const { rerender } = await mountRevealed();
    await expandHandleRequest();
    rerender(<CodeMap {...props({ dataVersion: 1 })} />);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    await waitFor(() => assert.deepEqual(historyButtons(), { back: false, forward: false }), FIND);
  });

  it('a refresh while Full is shown drops the reveal entries too (before any listing)', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const fake = historyFake();
    const { rerender } = await mountRevealed();
    await expandHandleRequest();
    fireEvent.click(toggleButton('Full map'));
    rerender(<CodeMap {...props({ dataVersion: 1 })} />);
    await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 2), FIND);
    await waitFor(() => assert.deepEqual(historyButtons(), { back: false, forward: false }), FIND);
    assert.equal(fake.calls.listEntryCandidates.length, 1, 'Full lists nothing');
  });

  it('a section switch clears all of history, with the reveal state', LONG, async () => {
    historyFake({
      getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
      listEntryCandidates: async (_project, section) => foundListing([entryCandidate(section === 'web' ? S.render : S.handler, 1)]),
    });
    const sectionProps = (section: SectionName) => ({ projectPath: SECTIONED_PROJECT, section });
    const { rerender } = await mountMap(sectionProps('api'));
    // Two node entries (validate, then handler) and a reveal entry.
    fireEvent.click(await findEdge(S.handler.id, S.validate.id));
    await settleViewport();
    fireEvent.click(await findEdge(S.handler.id, S.validate.id));
    await settleViewport();
    await toRevealed([S.handler.id]);
    fireEvent.click(await findOnCanvas(`Expand 1 callee of ${S.handler.name}`));
    await waitForDrawn([S.handler.id, S.validate.id]);
    assert.deepEqual(historyButtons(), { back: true, forward: false });

    rerender(<CodeMap {...props(sectionProps('web'))} />);
    await waitForDrawn([S.render.id]);
    assert.deepEqual(historyButtons(), { back: false, forward: false });
    rerender(<CodeMap {...props(sectionProps('api'))} />);
    await waitForDrawn([S.handler.id]);
    assert.deepEqual(historyButtons(), { back: false, forward: false });
  });
});

describe('The card keyboard: + / − on a focused card (Revealed only)', () => {
  it('`+` expands and `−` collapses the focused card, each step announced; a held key’s repeats are ignored', BUDGET, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    await mountRevealed();
    const user = userEvent.setup();
    focusCard(N.handleRequest.id);
    // Held down: one keydown, then auto-repeats — one expand.
    await user.keyboard('{+>3/}');
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(revealStatus(), EXPANDED_ANNOUNCEMENT);
    assert.deepEqual(historyButtons(), { back: true, forward: false });

    focusCard(N.handleRequest.id);
    await user.keyboard('-');
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(revealStatus(), `Collapsed ${N.handleRequest.name}, hid 3 Nodes`);
    focusCard(N.handleRequest.id);
    await user.keyboard('−');
    assert.equal(revealStatus(), NOTHING_TO_COLLAPSE_TEXT);
    await user.keyboard('=');
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
  });

  it('never with Ctrl, Cmd or Alt: no drill, no announcement, no history', BUDGET, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    await mountRevealed();
    const user = userEvent.setup();
    focusCard(N.handleRequest.id);
    for (const modifier of ['Control', 'Meta', 'Alt']) {
      for (const key of ['=', '+', '-']) {
        await user.keyboard(`{${modifier}>}${key}{/${modifier}}`);
      }
    }
    assert.deepEqual(drawnIds(), [N.handleRequest.id]);
    assert.equal(revealStatus(), '');
    assert.deepEqual(historyButtons(), { back: false, forward: false });
  });

  it('Enter on the card body still opens Node detail, never a drill; in Full, `+` does nothing', BUDGET, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    await mountRevealed();
    const user = userEvent.setup();
    focusCard(N.handleRequest.id);
    await user.keyboard('{Enter}');
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${N.handleRequest.name}` }, FIND);
    assert.deepEqual(drawnIds(), [N.handleRequest.id]);
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    await waitFor(() => assertAbsent(screen.queryByRole('dialog'), 'Node detail'), FIND);

    fireEvent.click(toggleButton('Full map'));
    await waitForDrawn(Object.values(N).map((node) => node.id));
    focusCard(N.handleRequest.id);
    await user.keyboard('+');
    fireEvent.click(toggleButton('Revealed'));
    await waitForDrawn([N.handleRequest.id]);
    assert.deepEqual(historyButtons(), { back: false, forward: false });
  });

  it('a stub card: `+` shows the next callees, its auto-repeat doesn’t', BUDGET, async () => {
    elementSize.set(4000, 16_000);
    const hub = drillHub(REVEAL_LAYER_CAP + 1, { grandchildren: false });
    historyFake({ getCodeMap: async () => drillMap([hub]), listEntryCandidates: async () => foundListing([hub.candidate]) });
    await mountRevealed([hub.hub.id]);
    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_LAYER_CAP + 1} callees of ${hub.hub.name}`));
    const stub = await findOnCanvas(`+1 more callee of ${hub.hub.name}, show the next 1`);
    fireEvent.keyDown(stub, { key: '+', shiftKey: true, repeat: true });
    assert.ok(cardWrapper(revealStubCardId(hub.hub.id)), 'a repeat shows nothing');
    stub.focus();
    await userEvent.setup().keyboard('+');
    await waitForDrawn([hub.hub.id, ...hub.callees.map((node) => node.id)]);
    assert.equal(revealStatus(), `Showed 1 more callee of ${hub.hub.name}`);
  });
});

describe('Announcements (replaces the announcement pins)', () => {
  it('expand, collapse, expand: each reveal is said, in the one status line', BUDGET, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    await mountRevealed();
    await expandHandleRequest();
    assert.equal(revealStatus(), EXPANDED_ANNOUNCEMENT);
    fireEvent.click(screen.getByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` }));
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(revealStatus(), `Collapsed ${N.handleRequest.name}, hid 3 Nodes`);
    await expandHandleRequest();
    assert.equal(revealStatus(), EXPANDED_ANNOUNCEMENT);
    assert.equal(statusRegionsSaying(EXPANDED_ANNOUNCEMENT).length, 1);
    // The next navigation ends it.
    fireEvent.click(screen.getByRole('button', { name: `${N.repository.name} is shown above, go to it` }));
    await waitFor(() => assert.equal(revealStatus(), ''), FIND);
    await settleViewport();
  });

  it('an identical announcement is said again: the line clears, then the text is set on the next frame', BUDGET, async () => {
    elementSize.set(3000, 2000);
    historyFake();
    await mountRevealed();
    await expandHandleRequest();
    // serviceA's callee (repository) is already shown: `+` has nothing to reveal.
    const frames = manualAnimationFrames();
    try {
      fireEvent.keyDown(nodeCard(N.serviceA.id), { key: '+', shiftKey: true });
      assert.equal(revealStatus(), NO_MORE_CALLEES_TEXT);
      assert.equal(frames.pending(), 0, 'a new text is set at once');
      fireEvent.keyDown(nodeCard(N.serviceA.id), { key: '+', shiftKey: true });
      assert.equal(revealStatus(), '', 'the same text is cleared first');
      assert.equal(frames.pending(), 1);
      frames.step();
      assert.equal(revealStatus(), NO_MORE_CALLEES_TEXT, 'then said again on the next frame');
      assert.equal(statusRegionsSaying(NO_MORE_CALLEES_TEXT).length, 1);
      // A pending re-announcement is cancelled by the next one.
      fireEvent.keyDown(nodeCard(N.serviceA.id), { key: '+', shiftKey: true });
      fireEvent.click(screen.getByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` }));
      frames.step();
      assert.equal(revealStatus(), `Collapsed ${N.handleRequest.name}, hid 3 Nodes`);
    } finally {
      frames.restore();
    }
    assert.deepEqual(historyButtons(), { back: true, forward: false }, '“No more callees” is no step');
  });

  it('an announcement stays (no timer) until the next event: a toggle, a mode change, a reload', LONG, async () => {
    elementSize.set(3000, 2000);
    // Any section answers path-trace-basic, so a section switch is a plain reload.
    const fake = historyFake({ getCodeMap: async (section) => ({ ...pathTraceBasicMap(), section: section ?? null }) });
    const { rerender } = await mountRevealed();
    const expand = await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`);
    mockSetTimeout();
    try {
      fireEvent.click(expand);
      await act(async () => {});
      assert.equal(revealStatus(), EXPANDED_ANNOUNCEMENT);
      act(() => mock.timers.tick(REVEAL_SWITCH_STATUS_MS * 3));
      assert.equal(revealStatus(), EXPANDED_ANNOUNCEMENT, 'never cleared by a timer');
    } finally {
      mock.timers.reset();
    }
    fireEvent.click(toggleButton('Full map'));
    assert.equal(revealStatus(), '', 'a toggle clears it');

    fireEvent.click(toggleButton('Revealed'));
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    fireEvent.click(screen.getByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` }));
    await waitForDrawn([N.handleRequest.id]);
    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    assert.equal(revealStatus(), '', 'a mode change clears it');

    await expandHandleRequest();
    assert.equal(revealStatus(), EXPANDED_ANNOUNCEMENT);
    // A reload: the section prop changes.
    rerender(<CodeMap {...props({ section: 'api' })} />);
    await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 2), FIND);
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(revealStatus(), '', 'a reload clears it');
  });
});
