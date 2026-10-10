/**
 * P4-8g: Revealed's shared-reach edges inside `CodeMap` (P4-7h, after the
 * founder decisions of 2026-10-05), rendered for real (jsdom, a fake
 * `window.driller`) — replacing the `CodeMap.sharedReach.test.ts` source
 * pins. Each test hovers or focuses candidate cards, clicks an edge, toggles
 * Full, opens Node detail or pins a Node, and asserts what the user sees:
 * the "shares N" edges drawn (and their accessible names), the legend, Node
 * detail's "Shared reach" line, history and the lit path.
 *
 * The fixture (`sharedReachMap`) lists five candidates with the Graph
 * Service's real ranking (`sharedReachListing`): `alpha`–`beta` 5,
 * `alpha`–`gamma` 4, `alpha`–`delta` 3, `beta`–`gamma` 2, `alpha`–`eps` 1.
 * The pure tests (partners, arcs, the edge component) stay in
 * `CodeMap.sharedReach.test.ts`.
 */
import './test/domEnv';
import { animatingElements, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CodeMap, type CodeMapProps } from './CodeMap';
import { createFakeDrillerApi, entryPinsStore, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import {
  FIXTURE_PROJECT_PATH,
  SHARED_REACH_CANDIDATES,
  SHARED_REACH_MID,
  sharedReachListing,
  sharedReachMap,
} from './test/mapFixture';

afterEach(cleanupAfterEach);

function assertAbsent(element: Element | null | undefined, what: string): void {
  assert.ok(element === null || element === undefined, `${what} is absent`);
}

/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const LONG = { timeout: 2 * BUDGET.timeout };
const FIND = { timeout: 1_500 };
const C = SHARED_REACH_CANDIDATES;
const CANDIDATE_IDS = Object.values(C).map((node) => node.id);
const MAP_SIZE = sharedReachMap().nodes.length;

function reachFake(stubs: DrillerStubs = {}): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    getCodeMap: async () => sharedReachMap(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
    listEntryCandidates: async () => sharedReachListing(),
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

async function settleViewport(): Promise<void> {
  await waitFor(() => assert.equal(animatingElements().length, 0, 'the viewport is still animating'), FIND);
}

function cardWrapper(id: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  assert.ok(card, `${id} is drawn`);
  return card;
}

/** The shared-reach edges drawn, as `source→target "label"`, in drawing order. */
function sharedEdges(): string[] {
  return [...document.querySelectorAll<SVGElement>('.react-flow__edge.code-map__edge--shared-reach')].map((edge) => {
    const [source, target] = JSON.parse((edge.getAttribute('data-id') ?? '').replace(/^shared-reach:/, '')) as [string, string];
    return `${nameOf(source)}→${nameOf(target)} "${labelOf(edge)}"`;
  });
}

function nameOf(id: string): string {
  return id.replace(/^.*::/, '');
}

/** An edge's label text ("shares N"), wherever React Flow renders it. */
function labelOf(edge: Element): string {
  return (edge.textContent ?? '').trim();
}

/** Waits until the shared-reach edges drawn are `expected` (measuring, since edges need measured cards). */
async function waitForSharedEdges(expected: readonly string[]): Promise<void> {
  await waitFor(() => {
    measure();
    assert.deepEqual(sharedEdges(), [...expected]);
  }, FIND);
}

function hover(id: string): void {
  fireEvent.mouseEnter(cardWrapper(id));
}

function unhover(id: string): void {
  fireEvent.mouseLeave(cardWrapper(id));
}

/** Focuses a candidate's Node card (inside `act`: the canvas keeps the focused candidate in state). */
function focusCard(id: string): void {
  const card = cardWrapper(id).querySelector<HTMLElement>('.code-map__node');
  assert.ok(card);
  act(() => card.focus());
}

async function mountRevealed(overrides: Partial<CodeMapProps> = {}) {
  const view = render(<CodeMap {...props(overrides)} />);
  await waitFor(() => {
    measure();
    assert.ok(drawnIds().length > 0);
  }, FIND);
  fireEvent.click(toggleButton('Revealed'));
  await waitForDrawn(CANDIDATE_IDS);
  return view;
}

const ALPHA_EDGES = ['alpha→beta "shares 5"', 'alpha→gamma "shares 4"', 'alpha→delta "shares 3"'];
const BETA_EDGES = ['beta→alpha "shares 5"', 'beta→gamma "shares 2"'];

describe('Drawn for the hovered, else focused, candidate only (replaces the drawing pin)', () => {
  it('a clean canvas; hovering A draws A’s three strongest, "shares N"; focus moving to B swaps them — never both', BUDGET, async () => {
    reachFake();
    await mountRevealed();
    await waitForSharedEdges([]);

    hover(C.alpha.id);
    await waitForSharedEdges(ALPHA_EDGES);
    const edge = document.querySelector('.react-flow__edge.code-map__edge--shared-reach');
    assert.equal(edge?.getAttribute('aria-label'), 'alpha and beta both reach 5 Nodes in indexed code');
    assertAbsent(document.querySelector(`.react-flow__edge[data-id*="${C.eps.id}"]`), 'the weakest partner’s edge (shares 1)');

    // Hover outranks focus: focusing B while A is hovered keeps A's.
    focusCard(C.beta.id);
    await waitForSharedEdges(ALPHA_EDGES);
    unhover(C.alpha.id);
    await waitForSharedEdges(BETA_EDGES);

    // Focus leaves the canvas: clean again.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await waitForSharedEdges([]);
  });

  it('a card that isn’t a candidate draws nothing; Full draws none, hovered or focused', BUDGET, async () => {
    elementSize.set(4000, 8000);
    reachFake();
    await mountRevealed();
    fireEvent.click(await findOnCanvas(new RegExp(`^Expand \\d+ callees? of ${C.delta.name}$`)));
    const callee = await waitFor(() => {
      measure();
      const id = drawnIds().find((drawn) => drawn.startsWith('shared/ad.ts::'));
      assert.ok(id, 'delta’s callees are drawn');
      return id;
    }, FIND);
    hover(callee);
    focusCard(callee);
    await waitForSharedEdges([]);
    // Hovering a non-candidate never takes over from the focused candidate.
    focusCard(C.alpha.id);
    await waitForSharedEdges(ALPHA_EDGES);
    hover(callee);
    await act(async () => {});
    await waitForSharedEdges(ALPHA_EDGES);
    unhover(callee);

    // Toggled to Full with the pointer still on a candidate (no mouseleave):
    // nothing is drawn, nor on a later hover or focus.
    hover(C.beta.id);
    await waitForSharedEdges(BETA_EDGES);
    fireEvent.click(toggleButton('Full map'));
    await waitFor(() => {
      measure();
      assert.equal(drawnIds().length, MAP_SIZE);
    }, FIND);
    assert.deepEqual(sharedEdges(), []);
    hover(C.alpha.id);
    focusCard(C.beta.id);
    await act(async () => {});
    act(() => measure());
    assert.deepEqual(sharedEdges(), []);
  });
});

describe('Never a map edge (replaces the click-guard and never-path-lit pins)', () => {
  it('clicking a shared-reach edge adds no history entry, moves nothing and lights no path', BUDGET, async () => {
    reachFake();
    await mountRevealed();
    await settleViewport();
    hover(C.alpha.id);
    await waitForSharedEdges(ALPHA_EDGES);
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    const edge = document.querySelector<HTMLElement>('.react-flow__edge.code-map__edge--shared-reach');
    assert.ok(edge);
    assert.equal(edge.getAttribute('tabindex'), null, 'not a keyboard stop');
    fireEvent.click(edge);
    await settleViewport();
    assert.equal(document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform, viewport);
    assert.equal(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled'), true, 'no history entry');
    assertAbsent(document.querySelector('.code-map__path-highlight, .code-map__edge--path-highlight'), 'a lit path');
    assertAbsent(screen.queryByRole('dialog'), 'Node detail');
  });

  it('a neighbour trace lit on Revealed lights its call edges, never a shared-reach edge', BUDGET, async () => {
    elementSize.set(4000, 8000);
    reachFake();
    await mountRevealed();
    fireEvent.click(await findOnCanvas(new RegExp(`^Expand \\d+ callees? of ${C.delta.name}$`)));
    await waitFor(() => {
      measure();
      assert.ok(drawnIds().some((id) => id.startsWith('shared/ad.ts::')));
    }, FIND);
    fireEvent.click(await findOnCanvas(new RegExp(`^\\d+ calls — show the callees of ${C.delta.name}$`)));
    await settleViewport();
    const lit = await waitFor(() => {
      measure();
      const edges = [...document.querySelectorAll('.react-flow__edge.code-map__edge--path-highlight')];
      assert.equal(edges.length, 3, 'delta’s three call edges are lit');
      return edges.map((element) => element.getAttribute('data-id'));
    }, FIND);
    hover(C.alpha.id);
    await waitFor(() => {
      measure();
      assert.ok(sharedEdges().length > 0);
    }, FIND);
    for (const shared of document.querySelectorAll('.react-flow__edge.code-map__edge--shared-reach')) {
      assert.ok(!shared.classList.contains('code-map__edge--path-highlight'), `${shared.getAttribute('data-id')} is not lit`);
    }
    assert.deepEqual(
      [...document.querySelectorAll('.react-flow__edge.code-map__edge--path-highlight')].map((element) => element.getAttribute('data-id')),
      lit,
    );
  });
});

describe('The legend and Node detail (replaces the legend and Node-detail pins)', () => {
  it('the legend: two lines, glyphs hidden from assistive tech; only while Revealed is drawn', BUDGET, async () => {
    reachFake();
    await mountRevealed();
    const legend = screen.getByRole('list', { name: 'Revealed edges' });
    const items = within(legend).getAllByRole('listitem');
    assert.deepEqual(
      items.map((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim()),
      ['··· shares N: candidates reaching common Nodes (focus or hover a candidate)', '- - shown above: a callee already revealed'],
    );
    for (const item of items) {
      const glyph = item.querySelector('span');
      assert.equal(glyph?.getAttribute('aria-hidden'), 'true');
    }
    fireEvent.click(toggleButton('Full map'));
    assertAbsent(screen.queryByRole('list', { name: 'Revealed edges' }), 'the legend in Full');
  });

  it('Node detail lists every partner of a shown candidate, uncapped — and nothing for a non-candidate or in Full', BUDGET, async () => {
    elementSize.set(4000, 8000);
    reachFake();
    await mountRevealed();
    const sharedReachLine = (detail: HTMLElement) =>
      within(detail).queryByRole('heading', { name: 'Shared reach' })?.closest('section')?.querySelector('p')?.textContent ?? null;

    fireEvent.click(await findOnCanvas(/^Function alpha,/));
    let detail = await screen.findByRole('dialog', { name: 'Node detail: alpha' }, FIND);
    assert.equal(
      sharedReachLine(detail),
      'Shares reach with: beta (5), gamma (4), delta (3), eps (1) — Nodes both reach in indexed code.',
    );
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    await waitFor(() => assertAbsent(screen.queryByRole('dialog'), 'Node detail'), FIND);

    fireEvent.click(await findOnCanvas(new RegExp(`^Expand \\d+ callees? of ${C.delta.name}$`)));
    const callee = await waitFor(() => {
      measure();
      const id = drawnIds().find((drawn) => drawn.startsWith('shared/ad.ts::'));
      assert.ok(id);
      return id;
    }, FIND);
    fireEvent.click(await findOnCanvas(new RegExp(`^Function ${nameOf(callee)},`)));
    detail = await screen.findByRole('dialog', { name: `Node detail: ${nameOf(callee)}` }, FIND);
    assert.equal(sharedReachLine(detail), null, 'a drilled callee is no candidate');
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    await waitFor(() => assertAbsent(screen.queryByRole('dialog'), 'Node detail'), FIND);

    fireEvent.click(toggleButton('Full map'));
    fireEvent.click(await findOnCanvas(/^Function alpha,/));
    detail = await screen.findByRole('dialog', { name: 'Node detail: alpha' }, FIND);
    assert.equal(sharedReachLine(detail), null, 'Full shows no candidates');
  });
});

describe('A pin change brings its own relations, into history too (replaces the rebase-relations pin)', () => {
  it('after pinning mid, Back restores a step whose snapshot carries the new relations', LONG, async () => {
    elementSize.set(4000, 16_000);
    const store = entryPinsStore();
    const fake = reachFake({
      ...store.stubs,
      listEntryCandidates: async (projectPath) => sharedReachListing(store.pinsOf(projectPath)),
    });
    await mountRevealed();
    fireEvent.click(await findOnCanvas(new RegExp(`^Expand \\d+ callees? of ${C.alpha.name}$`)));
    await waitFor(() => {
      measure();
      assert.ok(drawnIds().includes(SHARED_REACH_MID.id));
    }, FIND);
    fireEvent.click(await findOnCanvas(/^Function mid,/));
    const detail = await screen.findByRole('dialog', { name: 'Node detail: mid' }, FIND);
    const toggle = within(detail).getByRole('button', { name: 'Pin as entry point' });
    await waitFor(() => assert.equal(toggle.hasAttribute('disabled'), false), FIND);
    fireEvent.click(toggle);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    await waitFor(() => assertAbsent(screen.queryByRole('dialog'), 'Node detail'), FIND);

    // Undo the expand: the restored snapshot is the rebased one.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitForDrawn([...CANDIDATE_IDS, SHARED_REACH_MID.id]);
    hover(C.beta.id);
    await waitForSharedEdges(['beta→alpha "shares 5"', 'beta→gamma "shares 2"', 'beta→mid "shares 2"']);
    await settleViewport();
  });
});
