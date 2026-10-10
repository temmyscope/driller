/**
 * FIX-5 review round 1: the Back/Forward focus rescue (P4-7f review round 1
 * #6) waits for React Flow to remove the focused card, rendered for real
 * (jsdom, a fake `window.driller`). The app's `MutationObserver` is held
 * (`holdMutationObservers`), so each test acts between the card going and the
 * rescue seeing it: focus moved elsewhere, no step card, a kept card or
 * cluster, a new step, the cap, an unmount, the canvas going, a reload.
 * The rescue's main path stays in `CodeMap.revealHistory.dom.test.tsx`
 * (split out to keep that file under Node 22's per-file test timeout).
 */
import './test/domEnv';
import { animatingElements, assertSameElement, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodeMap, REVEAL_FOCUS_RESCUE_CAP_MS, type CodeMapProps } from './CodeMap';
import { ENTRY_CANDIDATES_LOADING_TEXT, REVEAL_LAYER_CAP, revealRefCardId } from './revealView';
import { createFakeDrillerApi, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import {
  drillHub,
  drillMap,
  FIXTURE_NODES,
  FIXTURE_PROJECT_PATH,
  foundListing,
  pathTraceBasicListing,
  pathTraceBasicMap,
} from './test/mapFixture';

afterEach(cleanupAfterEach);

/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const LONG = { timeout: 2 * BUDGET.timeout };
const FIND = { timeout: 1_500 };
const N = FIXTURE_NODES;

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

/** The Panel's one status line (`role="status"`), mounted while Code Map shows a map. */
function revealStatus(): string {
  const line = document.querySelector<HTMLElement>('.code-map__reveal-status');
  assert.ok(line, 'the Revealed status line is mounted');
  assert.equal(line.getAttribute('role'), 'status');
  return line.textContent ?? '';
}

function backButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Back' });
}

function forwardButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Forward' });
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

async function expandHandleRequest(): Promise<void> {
  fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
  await waitForDrawn(HANDLE_REQUEST_EXPANDED);
}

/** What expanding `handleRequest` draws: two layers, serviceB's call to repository a ref. */
const HANDLE_REQUEST_EXPANDED = [N.handleRequest.id, N.serviceA.id, N.serviceB.id, N.repository.id, revealRefCardId(N.serviceB.id, N.repository.id)];

/** Revealed: expand handleRequest, go to repository through its ref card (a node entry), expand repository. */
async function drillToCacheLookup() {
  historyFake();
  const view = await mountRevealed();
  await expandHandleRequest();
  const user = userEvent.setup();
  const ref = screen.getByRole('button', { name: `${N.repository.name} is shown above, go to it` });
  act(() => ref.focus());
  await user.keyboard('{Enter}');
  await settleViewport();
  fireEvent.click(await findOnCanvas(`Expand 1 callee of ${N.repository.name}`));
  await waitForDrawn([...HANDLE_REQUEST_EXPANDED, N.cacheLookup.id, revealRefCardId(N.cacheLookup.id, N.repository.id)]);
  return view;
}

/** A `MutationObserver` CodeMap made while held: whether it observes, was disconnected, and its held callback. */
interface HeldObserver {
  readonly observing: boolean;
  readonly disconnected: boolean;
  /** Delivers the mutations it saw while held (inside `act`), unless disconnected — as a real one would. */
  release(): void;
}

/**
 * FIX-5 review round 1: holds the callbacks of every `MutationObserver` the
 * app makes (the global one; Testing Library's `waitFor` takes the jsdom
 * window's own, so it is untouched), so a test can act between React Flow
 * removing a card and the focus rescue seeing it go — the gap a browser has
 * between a DOM change and its observer's microtask.
 */
function holdMutationObservers(): { observers: HeldObserver[]; restore(): void } {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  const Real = window.MutationObserver;
  const observers: HeldObserver[] = [];
  class Held implements HeldObserver {
    observing = false;
    disconnected = false;
    private pending = false;
    private readonly real: MutationObserver;
    constructor(private readonly callback: MutationCallback) {
      this.real = new Real(() => {
        this.pending = !this.disconnected;
      });
      observers.push(this);
    }
    observe(target: Node, options?: MutationObserverInit): void {
      this.observing = true;
      this.real.observe(target, options);
    }
    disconnect(): void {
      this.disconnected = true;
      this.pending = false;
      this.real.disconnect();
    }
    takeRecords(): MutationRecord[] {
      return this.real.takeRecords();
    }
    release(): void {
      if (this.pending && !this.disconnected) {
        this.pending = false;
        act(() => this.callback([], this as unknown as MutationObserver));
      }
    }
  }
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, enumerable: false, value: Held });
  return {
    observers,
    restore() {
      if (descriptor !== undefined) {
        Object.defineProperty(globalThis, 'MutationObserver', descriptor);
      }
    },
  };
}

// FIX-5 review round 1: the rescue's guards, each with the observer held so
// the test acts while it still waits for the card to go.
describe('The focus rescue waits for the card to go (FIX-5 review round 1)', () => {
  /** Revealed, drilled to cacheLookup, focus on its card, observers held, then Back (which removes the card). */
  async function backFromCacheLookupHeld() {
    elementSize.set(3000, 2000);
    const view = await drillToCacheLookup();
    focusCard(N.cacheLookup.id);
    const held = holdMutationObservers();
    fireEvent.click(backButton());
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(held.observers.length, 1, 'one rescue waits for the card to go');
    return { ...view, held, rescue: held.observers[0]! };
  }

  it('focus the user moved elsewhere before the card went is left there', LONG, async () => {
    const { held, rescue } = await backFromCacheLookupHeld();
    try {
      act(() => forwardButton().focus());
      rescue.release();
      assertSameElement(document.activeElement, forwardButton(), 'focus');
    } finally {
      held.restore();
    }
    await settleViewport();
  });

  it('the step’s Node card not shown: focus goes to Back', LONG, async () => {
    const { held, rescue } = await backFromCacheLookupHeld();
    // As if repository were clustered or culled: no Node card to take focus.
    const stepCard = nodeCard(N.repository.id);
    stepCard.classList.remove('code-map__node');
    try {
      rescue.release();
      assertSameElement(document.activeElement, backButton(), 'focus');
    } finally {
      stepCard.classList.add('code-map__node');
      held.restore();
    }
    await settleViewport();
  });

  it('a focused card the step keeps keeps focus, and no rescue waits', LONG, async () => {
    elementSize.set(3000, 2000);
    await drillToCacheLookup();
    focusCard(N.handleRequest.id);
    const held = holdMutationObservers();
    try {
      fireEvent.click(backButton());
      await waitForDrawn(HANDLE_REQUEST_EXPANDED);
      assert.equal(held.observers.length, 0, 'no rescue');
      assertSameElement(document.activeElement, nodeCard(N.handleRequest.id), 'focus');
    } finally {
      held.restore();
    }
    await settleViewport();
  });

  it('a focused cluster card still drawn after the step counts as kept (its id is only in the rendered set)', LONG, async () => {
    elementSize.set(4000, 16_000);
    const hub = drillHub(REVEAL_LAYER_CAP + 5, { grandchildren: false });
    historyFake({ getCodeMap: async () => drillMap([hub]), listEntryCandidates: async () => foundListing([hub.candidate]) });
    await mountRevealed([hub.hub.id]);
    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_LAYER_CAP + 5} callees of ${hub.hub.name}`));
    await settleViewport();
    fireEvent.click(await findOnCanvas(`+5 more callees of ${hub.hub.name}, show the next 5`));
    await settleViewport();
    // Zoom out (the canvas's control) until the hub's column is a cluster.
    elementSize.set(1200, 800);
    act(() => measure());
    const hubCluster = () => document.querySelector<HTMLElement>('.react-flow__node[data-id="cluster:0:0"] .code-map__cluster');
    for (let step = 0; step < 8 && hubCluster() === null; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
      await settleViewport();
      act(() => measure());
    }
    const cluster = hubCluster();
    assert.ok(cluster, 'the hub’s column is clustered');
    act(() => cluster.focus());
    const held = holdMutationObservers();
    try {
      // Back undoes the stub; the zoom (and so the hub's cluster) is as it was when the rescue decides.
      fireEvent.click(backButton());
      assert.equal(held.observers.length, 0, 'no rescue waits on a cluster that stays');
      assertSameElement(document.activeElement, cluster, 'focus');
    } finally {
      held.restore();
    }
    await settleViewport();
  });

  it('a new step stops a rescue still waiting', LONG, async () => {
    const { held, rescue } = await backFromCacheLookupHeld();
    try {
      fireEvent.click(forwardButton());
      assert.equal(rescue.disconnected, true, 'the previous rescue stopped');
      rescue.release();
      await waitForDrawn([...HANDLE_REQUEST_EXPANDED, N.cacheLookup.id, revealRefCardId(N.cacheLookup.id, N.repository.id)]);
      assert.notEqual(document.activeElement, nodeCard(N.repository.id), 'the stopped rescue moved nothing');
    } finally {
      held.restore();
    }
    await settleViewport();
  });

  it(`a rescue gives up after REVEAL_FOCUS_RESCUE_CAP_MS (${REVEAL_FOCUS_RESCUE_CAP_MS} ms)`, LONG, async () => {
    const { held, rescue } = await backFromCacheLookupHeld();
    try {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, REVEAL_FOCUS_RESCUE_CAP_MS + 100));
      });
      assert.equal(rescue.disconnected, true);
      rescue.release();
      assert.notEqual(document.activeElement, nodeCard(N.repository.id), 'no late rescue');
    } finally {
      held.restore();
    }
    await settleViewport();
  });

  it('unmounting mid-wait stops the rescue', LONG, async () => {
    const { held, rescue, unmount } = await backFromCacheLookupHeld();
    try {
      await settleViewport();
      unmount();
      assert.equal(rescue.disconnected, true);
    } finally {
      held.restore();
    }
  });

  it('the canvas going (Health Audit) mid-wait stops the rescue', LONG, async () => {
    const { held, rescue, rerender } = await backFromCacheLookupHeld();
    try {
      await settleViewport();
      rerender(<CodeMap {...props({ mode: 'healthAudit' })} />);
      assert.equal(rescue.disconnected, true);
    } finally {
      held.restore();
    }
  });

  it('a reload (a section switch, `loadCodeMap`) mid-wait stops the rescue', LONG, async () => {
    const { held, rescue, rerender } = await backFromCacheLookupHeld();
    try {
      await settleViewport();
      rerender(<CodeMap {...props({ section: 'api' })} />);
      assert.equal(rescue.disconnected, true);
    } finally {
      held.restore();
    }
    // Let the reload land inside the test: the new map's canvas (its
    // first fit) and the listing it starts.
    await waitFor(() => assert.equal(revealStatus(), ENTRY_CANDIDATES_LOADING_TEXT), FIND);
    await settleViewport();
  });
});
