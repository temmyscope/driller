/**
 * P4-8g: entry pins inside `CodeMap` (P4-7g), rendered for real (jsdom, a
 * fake `window.driller` whose pins store behaves as main's) — replacing the
 * `CodeMap.entryPins.test.ts` source pins. Each test pins or unpins from
 * Node detail's "Entry point" section and asserts what the user and the IPC
 * boundary see: the toggle (`aria-pressed`, disabled, its status line), the
 * Revealed candidates and their reasons, the viewport, Back, and the
 * recorded `getEntryPins`, `setEntryPins` and `listEntryCandidates` calls.
 *
 * The listing is the Graph Service's real ranking of the fixture map with
 * the pins main stores (`rankedListing`): pinned Nodes first, in pin order.
 * The hookless card and toggle tests stay in `CodeMap.entryPins.test.ts`.
 */
import './test/domEnv';
import { animatingElements, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ENTRY_PINS_MAX, type EntryCandidatesResult, type EntryPinUpdateResult } from '@driller/ipc-contracts';
import { CodeMap, type CodeMapProps } from './CodeMap';
import { PIN_LIMIT_TEXT } from './entryPins';
import { revealRefCardId } from './revealView';
import {
  createFakeDrillerApi,
  deferred,
  entryPinsStore,
  type DrillerStubs,
  type EntryPinsStore,
  type FakeDrillerApi,
} from './test/fakeDrillerApi';
import { FIXTURE_NODES, FIXTURE_PROJECT_PATH, pathTraceBasicMap, rankedListing } from './test/mapFixture';

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
// `[2026-10-25]` Scaled for CI like the test budget beside it. A flat inner
// budget gave every `waitFor` half the allowance, relative to machine speed,
// that the test around it got — see `4a1c48b` and status.md's row on it.
const FIND = { timeout: 1_500 * (env.CI === 'true' ? 2 : 1) };
const N = FIXTURE_NODES;
const PROJECT = FIXTURE_PROJECT_PATH;
const OTHER_PROJECT = '/fixture/other';

/**
 * A fake over path-trace-basic whose pins are `store`'s (main's), and whose
 * listing ranks them as the Graph Service does.
 */
function pinsFake(store: EntryPinsStore = entryPinsStore(), stubs: DrillerStubs = {}): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    getCodeMap: async () => pathTraceBasicMap(),
    getShowFoldedKinds: async () => false,
    ...store.stubs,
    listEntryCandidates: async (projectPath) => rankedListing(pathTraceBasicMap(), store.pinsOf(projectPath)),
    ...stubs,
  });
  fake.install();
  return fake;
}

function props(overrides: Partial<CodeMapProps> = {}): CodeMapProps {
  const noop = () => {};
  return {
    projectPath: PROJECT,
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

function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

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

async function findOnCanvas(name: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    measure();
    return screen.getByRole('button', { name });
  }, FIND);
}

function toggleButton(view: 'Revealed' | 'Full map'): HTMLElement {
  return within(screen.getByRole('group', { name: 'Code Map view' })).getByRole('button', { name: view });
}

function revealStatus(): string {
  return document.querySelector<HTMLElement>('.code-map__reveal-status')?.textContent ?? '';
}

function viewportTransform(): string {
  return document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
}

async function settleViewport(): Promise<void> {
  await waitFor(() => assert.equal(animatingElements().length, 0, 'the viewport is still animating'), FIND);
}

/** Each drawn candidate card's reason line, by Node id. */
function candidateLines(): Record<string, string> {
  const lines: Record<string, string> = {};
  for (const line of document.querySelectorAll<HTMLElement>('.react-flow__node .code-map__node-candidate')) {
    const id = line.closest('.react-flow__node')?.getAttribute('data-id') ?? '';
    lines[id] = (line.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  return lines;
}

async function mountMap(overrides: Partial<CodeMapProps> = {}) {
  const view = render(<CodeMap {...props(overrides)} />);
  await waitFor(() => {
    measure();
    assert.ok(drawnIds().length > 0);
  }, FIND);
  return view;
}

async function mountRevealed(candidates: readonly string[] = [N.handleRequest.id], overrides: Partial<CodeMapProps> = {}) {
  const view = await mountMap(overrides);
  fireEvent.click(toggleButton('Revealed'));
  await waitForDrawn(candidates);
  return view;
}

const REPOSITORY_REF = revealRefCardId(N.serviceB.id, N.repository.id);
const HANDLE_REQUEST_EXPANDED = [N.handleRequest.id, N.serviceA.id, N.serviceB.id, N.repository.id, REPOSITORY_REF];

async function expandHandleRequest(): Promise<void> {
  fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
  await waitForDrawn(HANDLE_REQUEST_EXPANDED);
}

/** Opens Node detail from a drawn card and returns the dialog. */
async function openDetail(node: { name: string }): Promise<HTMLElement> {
  fireEvent.click(await findOnCanvas(new RegExp(`^Function ${node.name},`)));
  return screen.findByRole('dialog', { name: `Node detail: ${node.name}` }, FIND);
}

async function closeDetail(detail: HTMLElement): Promise<void> {
  fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
  await waitFor(() => assertAbsent(screen.queryByRole('dialog'), 'Node detail'), FIND);
}

/** Node detail's "Entry point" section: its toggle, the visible pinned note, its status line. */
function pinSection(detail: HTMLElement): { toggle: HTMLElement; note: string | null; status: string } {
  const section = within(detail).getByRole('heading', { name: 'Entry point' }).closest('section');
  assert.ok(section, 'an "Entry point" section');
  const toggle = within(section).getByRole('button', { name: 'Pin as entry point' });
  const note = section.querySelector('.code-map__node-detail-pin-state');
  return {
    toggle,
    note: note === null ? null : (note.textContent ?? '').trim(),
    status: within(section).getByRole('status').textContent ?? '',
  };
}

describe('Node detail’s toggle (replaces the Node-detail wiring pin)', () => {
  it('waits for this project’s pins: disabled until the read lands, then "Pin as entry point", not pressed', BUDGET, async () => {
    const read = deferred<string[]>();
    const fake = pinsFake(entryPinsStore(), { getEntryPins: () => read.promise });
    await mountMap();
    const detail = await openDetail(N.serviceA);
    assert.equal(pinSection(detail).toggle.hasAttribute('disabled'), true, 'no change before the pins are read');
    fireEvent.click(pinSection(detail).toggle);
    assert.deepEqual(fake.calls.setEntryPins, []);

    await act(async () => read.resolve([N.serviceB.id]));
    await waitFor(() => assert.equal(pinSection(detail).toggle.hasAttribute('disabled'), false), FIND);
    assert.equal(pinSection(detail).toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(pinSection(detail).note, null);
    assert.deepEqual(fake.calls.getEntryPins, [[PROJECT]]);

    // The control is for the Node shown: serviceB is pinned.
    await closeDetail(detail);
    const pinned = await openDetail(N.serviceB);
    assert.equal(pinSection(pinned).toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(pinSection(pinned).note, '⚑ pinned by you');
  });

  it('pins are read again when the project changes, and the toggle waits for that read', BUDGET, async () => {
    const otherRead = deferred<string[]>();
    const store = entryPinsStore({ [PROJECT]: [N.serviceA.id] });
    const fake = pinsFake(store, {
      getEntryPins: (projectPath) => (projectPath === OTHER_PROJECT ? otherRead.promise : store.stubs.getEntryPins(projectPath)),
    });
    const { rerender } = await mountMap();
    const first = await openDetail(N.serviceA);
    await waitFor(() => assert.equal(pinSection(first).toggle.getAttribute('aria-pressed'), 'true'), FIND);
    await closeDetail(first);

    rerender(<CodeMap {...props({ projectPath: OTHER_PROJECT })} />);
    await waitFor(() => assert.deepEqual(fake.calls.getEntryPins, [[PROJECT], [OTHER_PROJECT]]), FIND);
    const other = await openDetail(N.serviceA);
    assert.equal(pinSection(other).toggle.hasAttribute('disabled'), true, 'the first project’s pins never stand in');
    assert.equal(pinSection(other).toggle.getAttribute('aria-pressed'), 'false');
    await act(async () => otherRead.resolve([]));
    await waitFor(() => assert.equal(pinSection(other).toggle.hasAttribute('disabled'), false), FIND);
    assert.equal(pinSection(other).toggle.getAttribute('aria-pressed'), 'false');
  });
});

describe('Pinning re-lists Revealed on the same map (replaces the pins-revision and listing-effect pins)', () => {
  it('pin from Node detail: one setEntryPins(project, id, true), pressed; one re-list, the pinned Node first; the view doesn’t move', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const store = entryPinsStore();
    const fake = pinsFake(store);
    await mountRevealed();
    await expandHandleRequest();
    await settleViewport();
    const viewport = viewportTransform();
    assert.equal(fake.calls.listEntryCandidates.length, 1);

    const detail = await openDetail(N.serviceB);
    fireEvent.click(pinSection(detail).toggle);
    await waitFor(() => assert.equal(pinSection(detail).toggle.getAttribute('aria-pressed'), 'true'), FIND);
    assert.equal(pinSection(detail).note, '⚑ pinned by you');
    assert.deepEqual(fake.calls.setEntryPins, [[PROJECT, N.serviceB.id, true]]);
    assert.deepEqual(store.pinsOf(PROJECT), [N.serviceB.id]);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    assert.deepEqual(fake.calls.listEntryCandidates[1], [PROJECT, undefined]);
    assert.equal(fake.calls.getCodeMap.length, 1, 'the same map: no fetch');
    await closeDetail(detail);

    await waitFor(() => {
      measure();
      assert.equal(candidateLines()[N.serviceB.id], '⚑ pinned by you · reaches 2 Nodes in indexed code');
    }, FIND);
    assert.match(candidateLines()[N.handleRequest.id] ?? '', /^◎ candidate/);
    assert.ok(screen.getByRole('button', { name: /^Function serviceB, pinned entry point, reaches 2 Nodes/ }));
    await settleViewport();
    assert.equal(viewportTransform(), viewport, 'a pin change never re-fits the view');

    // Unpin: one more call, one more re-list; serviceB is no candidate again.
    const again = await openDetail(N.serviceB);
    fireEvent.click(pinSection(again).toggle);
    await waitFor(() => assert.equal(pinSection(again).toggle.getAttribute('aria-pressed'), 'false'), FIND);
    assert.deepEqual(fake.calls.setEntryPins, [
      [PROJECT, N.serviceB.id, true],
      [PROJECT, N.serviceB.id, false],
    ]);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 3), FIND);
    await closeDetail(again);
    await waitFor(() => {
      measure();
      assert.equal(candidateLines()[N.serviceB.id], undefined);
    }, FIND);
    assert.equal(viewportTransform(), viewport);
  });

  it('in Full, a pin change is listed when Revealed is shown next — once', BUDGET, async () => {
    const fake = pinsFake();
    await mountMap();
    const detail = await openDetail(N.serviceB);
    fireEvent.click(pinSection(detail).toggle);
    await waitFor(() => assert.equal(pinSection(detail).toggle.getAttribute('aria-pressed'), 'true'), FIND);
    await closeDetail(detail);
    assert.deepEqual(fake.calls.listEntryCandidates, [], 'Full never lists');
    fireEvent.click(toggleButton('Revealed'));
    await waitForDrawn([N.serviceB.id, N.handleRequest.id]);
    assert.equal(fake.calls.listEntryCandidates.length, 1);
  });

  it('the same state again sends nothing more: a second activation while saving, and a reply that changes nothing re-lists nothing', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const save = deferred<EntryPinUpdateResult>();
    const fake = pinsFake(entryPinsStore(), { setEntryPins: () => save.promise });
    await mountRevealed();
    await expandHandleRequest();
    const detail = await openDetail(N.serviceB);
    fireEvent.click(pinSection(detail).toggle);
    assert.equal(pinSection(detail).toggle.hasAttribute('disabled'), true, 'busy while saving');
    fireEvent.click(pinSection(detail).toggle);
    assert.equal(fake.calls.setEntryPins.length, 1);

    // Main says it stored the pins the renderer already held (nothing changed).
    await act(async () => save.resolve({ status: 'stored', pins: [] }));
    await waitFor(() => assert.equal(pinSection(detail).toggle.hasAttribute('disabled'), false), FIND);
    assert.equal(pinSection(detail).toggle.getAttribute('aria-pressed'), 'false');
    await act(async () => {});
    assert.equal(fake.calls.listEntryCandidates.length, 1, 'no change, no re-list');
  });

  it('a failed save keeps the pins, says why, and re-lists nothing', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const fake = pinsFake(entryPinsStore(), {
      setEntryPins: async () => ({ status: 'error', message: 'The stored entry pins couldn’t be read, so nothing was changed.' }),
    });
    await mountRevealed();
    await expandHandleRequest();
    const detail = await openDetail(N.serviceB);
    fireEvent.click(pinSection(detail).toggle);
    await waitFor(() => assert.equal(pinSection(detail).status, 'The stored entry pins couldn’t be read, so nothing was changed.'), FIND);
    assert.equal(pinSection(detail).toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(fake.calls.listEntryCandidates.length, 1);
  });
});

describe('The pin limit (replaces the limit wiring pin)', () => {
  const fullPins = Array.from({ length: ENTRY_PINS_MAX }, (_, index) => `gone.ts::pin${index}`);

  it(`at ENTRY_PINS_MAX (${ENTRY_PINS_MAX}) pins, pinning says so in Node detail and sends nothing`, BUDGET, async () => {
    const fake = pinsFake(entryPinsStore({ [PROJECT]: fullPins }));
    await mountRevealed();
    const listed = fake.calls.listEntryCandidates.length;
    const detail = await openDetail(N.handleRequest);
    await waitFor(() => assert.equal(pinSection(detail).toggle.hasAttribute('disabled'), false), FIND);
    fireEvent.click(pinSection(detail).toggle);
    assert.equal(pinSection(detail).status, PIN_LIMIT_TEXT);
    assert.equal(pinSection(detail).toggle.getAttribute('aria-pressed'), 'false');
    await act(async () => {});
    assert.deepEqual(fake.calls.setEntryPins, [], 'no IPC');
    assert.equal(fake.calls.listEntryCandidates.length, listed, 'no re-list');

    // The message belongs to the Node it was for.
    await closeDetail(detail);
    fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
    const other = await openDetail(N.serviceA);
    assert.equal(pinSection(other).status, '');
  });

  it('main refuses a pin past the limit it holds: the limit text, and main’s stored pins replace the ones held', BUDGET, async () => {
    const store = entryPinsStore({ [PROJECT]: fullPins.slice(1) });
    const fake = pinsFake(store);
    await mountRevealed();
    // Another pin lands in main after this window read its pins.
    await store.stubs.setEntryPins(PROJECT, fullPins[0]!, true);
    const listed = fake.calls.listEntryCandidates.length;
    const detail = await openDetail(N.handleRequest);
    await waitFor(() => assert.equal(pinSection(detail).toggle.hasAttribute('disabled'), false), FIND);
    fireEvent.click(pinSection(detail).toggle);
    await waitFor(() => assert.equal(pinSection(detail).status, PIN_LIMIT_TEXT), FIND);
    assert.deepEqual(fake.calls.setEntryPins, [[PROJECT, N.handleRequest.id, true]]);
    assert.equal(pinSection(detail).toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(fake.calls.listEntryCandidates.length, listed + 1, 'main’s list differs from the one held: the change is listed');
  });
});

describe('A pin change and history (replaces the same-fetch rebase pin)', () => {
  it('Back after a pin change still undoes the expand: the reveal step was rebased onto the new candidates', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const fake = pinsFake();
    await mountRevealed();
    await expandHandleRequest();
    const detail = await openDetail(N.serviceB);
    fireEvent.click(pinSection(detail).toggle);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    await closeDetail(detail);
    await waitFor(() => {
      measure();
      assert.ok(candidateLines()[N.serviceB.id]?.startsWith('⚑ pinned by you'));
    }, FIND);
    const back = screen.getByRole('button', { name: 'Back' });
    assert.equal(back.hasAttribute('disabled'), false, 'the expand is still in history');
    fireEvent.click(back);
    await waitFor(() => assert.equal(revealStatus(), `Back: restored the view before expanding ${N.handleRequest.name}`), FIND);
    // The pre-expand view, on the new candidates: both cards, nothing drilled.
    await waitForDrawn([N.serviceB.id, N.handleRequest.id]);
    assert.equal(screen.getByRole('button', { name: 'Forward' }).hasAttribute('disabled'), false);
    assert.equal(fake.calls.listEntryCandidates.length, 2, 'Back never re-lists');
    await settleViewport();
  });

  /** A fake whose listing fails once `failing.now` is set (after a pin change, say). */
  function failingListingFake(store: EntryPinsStore, failing: { now: boolean }): FakeDrillerApi {
    return pinsFake(store, {
      listEntryCandidates: async (projectPath): Promise<EntryCandidatesResult> =>
        failing.now ? { status: 'error', message: 'map refreshing' } : rankedListing(pathTraceBasicMap(), store.pinsOf(projectPath)),
    });
  }

  const PIN_LISTING_FAILED = 'Couldn’t update the entry candidates after the pin change (map refreshing); showing the previous ones.';

  it('a failed pin-change listing keeps the candidates, says so in the Panel line (never over the canvas), and is retried on the next show', BUDGET, async () => {
    const store = entryPinsStore();
    const failing = { now: false };
    const fake = failingListingFake(store, failing);
    await mountRevealed();
    failing.now = true;
    const detail = await openDetail(N.handleRequest);
    fireEvent.click(pinSection(detail).toggle);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    await closeDetail(detail);
    await waitFor(() => assert.equal(revealStatus(), PIN_LISTING_FAILED), FIND);
    await waitForDrawn([N.handleRequest.id]);
    assert.match(candidateLines()[N.handleRequest.id] ?? '', /^◎ candidate/, 'the previous listing stays');
    assertAbsent(document.querySelector('.code-map__reveal-notice'), 'an error notice over the canvas');

    failing.now = false;
    fireEvent.click(toggleButton('Full map'));
    fireEvent.click(toggleButton('Revealed'));
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 3), FIND);
    await waitFor(() => {
      measure();
      assert.ok(candidateLines()[N.handleRequest.id]?.startsWith('⚑ pinned by you'));
    }, FIND);
  });

  it('after a drill, a failed pin-change listing keeps the drawn state and the reveal steps', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const failing = { now: false };
    const fake = failingListingFake(entryPinsStore(), failing);
    await mountRevealed();
    await expandHandleRequest();
    await settleViewport();
    failing.now = true;
    const detail = await openDetail(N.serviceB);
    fireEvent.click(pinSection(detail).toggle);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    await closeDetail(detail);
    await act(async () => {});
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(candidateLines()[N.serviceB.id], undefined);
    assertAbsent(document.querySelector('.code-map__reveal-notice'), 'an error notice over the canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(revealStatus(), `Back: restored the view before expanding ${N.handleRequest.name}`);
    // FIX-5: Back's centring animates; let it end inside the test (under a
    // loaded full run its frames otherwise land outside act()).
    await settleViewport();
  });

  // P4-7g review round 1 #2 ("The Panel status line says 'Couldn’t update
  // the entry candidates after the pin change …'"). The Panel line shows the
  // latest drill announcement before any notice (`revealStatusText`), so
  // after a drill (the usual way to reach a Node to pin) the failure was
  // never said. FIX-5: a failed pin-change listing clears the announcement.
  it(
    'after a drill, a failed pin-change listing is still said in the Panel line',
    BUDGET,
    async () => {
      elementSize.set(3000, 2000);
      const failing = { now: false };
      const fake = failingListingFake(entryPinsStore(), failing);
      await mountRevealed();
      await expandHandleRequest();
      await settleViewport();
      failing.now = true;
      const detail = await openDetail(N.serviceB);
      fireEvent.click(pinSection(detail).toggle);
      await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
      await closeDetail(detail);
      await waitFor(() => assert.equal(revealStatus(), PIN_LISTING_FAILED), FIND);
    },
  );
});

/** Column 0's card ids, top to bottom, from the cards' drawn transforms. */
function columnZeroTopToBottom(): string[] {
  const cards: { id: string; y: number }[] = [];
  for (const card of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card.style.transform);
    assert.ok(match, `card ${card.getAttribute('data-id')} has a position`);
    if (Number(match[1]) === 0) cards.push({ id: card.getAttribute('data-id') ?? '', y: Number(match[2]) });
  }
  return cards.sort((a, b) => a.y - b.y).map((card) => card.id);
}

describe('FIX-6 (P4-7g): pinned candidates are drawn first, in pin order', () => {
  it('stored pins serviceB, then cacheLookup: the canvas reads serviceB, cacheLookup, handleRequest top to bottom', BUDGET, async () => {
    pinsFake(entryPinsStore({ [PROJECT]: [N.serviceB.id, N.cacheLookup.id] }));
    await mountRevealed([N.serviceB.id, N.cacheLookup.id, N.handleRequest.id]);
    await waitFor(() => {
      measure();
      assert.deepEqual(columnZeroTopToBottom(), [N.serviceB.id, N.cacheLookup.id, N.handleRequest.id]);
    }, FIND);
  });

  it('pinning from Node detail moves the Node above the higher-reach candidate', BUDGET, async () => {
    pinsFake();
    await mountRevealed();
    // serviceB (reach 2) is drawn once handleRequest (reach 4) is expanded.
    await expandHandleRequest();
    const serviceB = await openDetail(N.serviceB);
    fireEvent.click(pinSection(serviceB).toggle);
    await waitFor(() => assert.equal(pinSection(serviceB).toggle.getAttribute('aria-pressed'), 'true'), FIND);
    await closeDetail(serviceB);
    await waitFor(() => {
      measure();
      assert.deepEqual(columnZeroTopToBottom(), [N.serviceB.id, N.handleRequest.id]);
    }, FIND);
  });
});
