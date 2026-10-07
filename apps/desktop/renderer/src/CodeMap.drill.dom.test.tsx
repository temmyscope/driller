/**
 * P4-8f: the drill in Revealed (P4-7e), rendered for real (jsdom, a fake
 * `window.driller`) — replacing the `CodeMap.drill.test.ts` source pins.
 * Each test toggles Revealed, then expands, collapses, activates a stub or a
 * ref card (pointer and keyboard), clicks a ref connector, refreshes or
 * reloads, and asserts what the user and the IPC boundary see: the cards
 * drawn, their buttons, the ref and stub cards, the connector, the Panel's
 * status line and the recorded `window.driller` calls.
 *
 * Fixtures: `path-trace-basic` (fan-in `serviceA`/`serviceB` → `repository`,
 * the `repository` ↔ `cacheLookup` cycle) and `drillMap` hubs sized from
 * `REVEAL_TWO_LAYER_MAX` and `REVEAL_LAYER_CAP` (12, 13, 30 and 31 callees).
 * Each drilling test makes the canvas large enough that React Flow culls no
 * drilled card at Revealed's zoom (2×, fitted to the candidates).
 */
import './test/domEnv';
import { animatingElements, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CodeMapEdge } from '@driller/ipc-contracts';
import type { MapFooterState } from './appFrame';
import { CodeMap, type CodeMapProps } from './CodeMap';
import { REVEAL_LAYER_CAP, REVEAL_TWO_LAYER_MAX, revealRefCardId, revealStubCardId } from './revealView';
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
  type CodeMapOk,
  type DrillHub,
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
const FIND = { timeout: 1_500 };
const N = FIXTURE_NODES;
const S = SECTION_NODES;
const SECTIONED_PROJECT = '/work/two-sections';

function drillFake(stubs: DrillerStubs = {}): FakeDrillerApi {
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

/** Every `window.driller` request so far, as `member:count` — a drill step must leave it unchanged. */
function ipcCalls(fake: FakeDrillerApi): string[] {
  return Object.entries(fake.calls)
    .filter(([name, calls]) => !name.startsWith('on') && calls.length > 0)
    .map(([name, calls]) => `${name}:${calls.length}`);
}

/** Reports the canvas's and the cards' sizes (React Flow hides a card until it is measured, and draws edges only between measured cards). */
function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

/** Every drawn card's id (a Node's id, or a ref/stub card's), clusters left out. */
function drawnCardIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('cluster:'));
}

async function waitForDrawn(ids: readonly string[]): Promise<void> {
  await waitFor(() => {
    measure();
    assert.deepEqual([...drawnCardIds()].sort(), [...ids].sort());
  }, FIND);
}

/** A button (or a `role="button"` card) on the canvas, once drawn and measured. */
async function findOnCanvas(name: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    measure();
    return screen.getByRole('button', { name });
  }, FIND);
}

function viewToggle(view: 'Revealed' | 'Full map'): HTMLElement {
  return within(screen.getByRole('group', { name: 'Code Map view' })).getByRole('button', { name: view });
}

/** The Panel's one status line. */
function revealStatus(): string {
  return document.querySelector<HTMLElement>('.code-map__reveal-status')?.textContent ?? '';
}

function viewportTransform(): string {
  return document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
}

async function settleViewport(): Promise<void> {
  await waitFor(() => assert.equal(animatingElements().length, 0, 'the viewport is still animating'), FIND);
}

function refCardId(parent: { id: string }, target: { id: string }): string {
  return revealRefCardId(parent.id, target.id);
}

function cardElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
}

/** Mounts Code Map and switches to Revealed, waiting for exactly the candidates' cards. */
async function mountRevealed(candidates: readonly string[], overrides: Partial<CodeMapProps> = {}) {
  const view = render(<CodeMap {...props(overrides)} />);
  await waitFor(() => {
    measure();
    assert.ok(drawnCardIds().length > 0);
  }, FIND);
  fireEvent.click(viewToggle('Revealed'));
  await waitForDrawn(candidates);
  return view;
}

/** What expanding path-trace-basic's `handleRequest` draws: two layers, serviceB's call to repository a ref. */
const HANDLE_REQUEST_EXPANDED = [
  N.handleRequest.id,
  N.serviceA.id,
  N.serviceB.id,
  N.repository.id,
  refCardId(N.serviceB, N.repository),
];

async function expandHandleRequest(also: readonly string[] = []): Promise<void> {
  fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
  await waitForDrawn([...HANDLE_REQUEST_EXPANDED, ...also]);
}

/** The Revealed connectors drawn (parent → ref card), by id. */
function connectorIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__edge[data-id^="reveal-connector:"]')].map(
    (edge) => edge.getAttribute('data-id') ?? '',
  );
}

/** A hub's card ids: the hub, its first `calleeCount` callees, and (optionally) their leaves. */
function hubIds(hub: DrillHub, calleeCount = hub.callees.length, withLeaves = false): string[] {
  return [
    hub.hub.id,
    ...hub.callees.slice(0, calleeCount).map((node) => node.id),
    ...(withLeaves ? hub.leaves.map((node) => node.id) : []),
  ];
}

function hubFake(hubs: readonly DrillHub[]): FakeDrillerApi {
  return drillFake({
    getCodeMap: async () => drillMap(hubs),
    listEntryCandidates: async () => foundListing(hubs.map((hub) => hub.candidate)),
  });
}

describe('Expand reveals the callees (replaces the Revealed-canvas controls pin)', () => {
  it('path-trace-basic: two layers in one step; fan-in and the cycle are "↺ shown above" refs with connectors — never a second card, never an IPC call', BUDGET, async () => {
    // Five columns deep at 2×: wide enough that none is culled.
    elementSize.set(6000, 2000);
    const fake = drillFake();
    await mountRevealed([N.handleRequest.id]);
    const before = ipcCalls(fake);

    await expandHandleRequest();
    assert.equal(revealStatus(), `Revealed 3 callees of ${N.handleRequest.name} in 2 layers`);
    const collapse = screen.getByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` });
    assert.equal(collapse.getAttribute('aria-expanded'), 'true');
    assert.equal(collapse.textContent, '▾ Collapse');
    const ref = screen.getByRole('button', { name: `${N.repository.name} is shown above, go to it` });
    assert.equal(ref.textContent?.replace(/\s+/g, ' ').trim(), `↺ ${N.repository.name} shown above`);
    assert.ok(cardElement(refCardId(N.serviceB, N.repository))?.contains(ref));
    await waitFor(() => {
      measure();
      assert.deepEqual(connectorIds(), [`reveal-connector:${refCardId(N.serviceB, N.repository)}`]);
    }, FIND);
    assert.match(document.querySelector('.react-flow__edge[data-id^="reveal-connector:"]')?.textContent ?? '', /shown above/);

    // The cycle: repository's callee cacheLookup calls repository back — a ref, not a card.
    fireEvent.click(await findOnCanvas(`Expand 1 callee of ${N.repository.name}`));
    await waitForDrawn([...HANDLE_REQUEST_EXPANDED, N.cacheLookup.id, refCardId(N.cacheLookup, N.repository)]);
    assert.equal(revealStatus(), `Revealed 1 callee of ${N.repository.name}`);
    const ids = drawnCardIds();
    assert.equal(new Set(ids).size, ids.length, 'no card id twice');
    await waitFor(() => {
      measure();
      assert.equal(screen.getAllByRole('button', { name: `${N.repository.name} is shown above, go to it` }).length, 2);
      assert.equal(connectorIds().length, 2);
    }, FIND);
    assert.deepEqual(ipcCalls(fake), before, 'a drill step asks main for nothing');
  });

  it(`REVEAL_TWO_LAYER_MAX (${REVEAL_TWO_LAYER_MAX}) new callees open two layers; one more opens one`, BUDGET, async () => {
    elementSize.set(4000, 16_000);
    const twoLayers = drillHub(REVEAL_TWO_LAYER_MAX, { grandchildren: true });
    const oneLayer = drillHub(REVEAL_TWO_LAYER_MAX + 1, { grandchildren: true });
    hubFake([twoLayers, oneLayer]);
    await mountRevealed([twoLayers.hub.id, oneLayer.hub.id]);

    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_TWO_LAYER_MAX} callees of ${twoLayers.hub.name}`));
    await waitForDrawn([...hubIds(twoLayers, REVEAL_TWO_LAYER_MAX, true), oneLayer.hub.id]);
    assert.equal(revealStatus(), `Revealed ${REVEAL_TWO_LAYER_MAX * 2} callees of ${twoLayers.hub.name} in 2 layers`);

    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_TWO_LAYER_MAX + 1} callees of ${oneLayer.hub.name}`));
    await waitForDrawn([...hubIds(twoLayers, REVEAL_TWO_LAYER_MAX, true), ...hubIds(oneLayer)]);
    assert.equal(revealStatus(), `Revealed ${REVEAL_TWO_LAYER_MAX + 1} callees of ${oneLayer.hub.name}`);
    for (const callee of oneLayer.callees) {
      assert.ok(screen.getByRole('button', { name: `Expand 1 callee of ${callee.name}` }), `${callee.name} can still be expanded`);
    }
  });

  it(`over REVEAL_LAYER_CAP (${REVEAL_LAYER_CAP}): that many cards and an activatable "+1 more callee" stub; exactly at the cap, no stub`, BUDGET, async () => {
    elementSize.set(4000, 16_000);
    const atCap = drillHub(REVEAL_LAYER_CAP, { grandchildren: false });
    const overCap = drillHub(REVEAL_LAYER_CAP + 1, { grandchildren: false });
    const fake = hubFake([atCap, overCap]);
    await mountRevealed([atCap.hub.id, overCap.hub.id]);
    const before = ipcCalls(fake);
    const user = userEvent.setup();

    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_LAYER_CAP + 1} callees of ${overCap.hub.name}`));
    const stubId = revealStubCardId(overCap.hub.id);
    await waitForDrawn([atCap.hub.id, ...hubIds(overCap, REVEAL_LAYER_CAP), stubId]);
    assert.equal(revealStatus(), `Revealed ${REVEAL_LAYER_CAP} of ${REVEAL_LAYER_CAP + 1} callees of ${overCap.hub.name}; 1 more`);
    const stub = screen.getByRole('button', { name: `+1 more callee of ${overCap.hub.name}, show the next 1` });
    assert.equal(stub.textContent, '+1 more callee');
    assert.ok(cardElement(stubId)?.contains(stub));

    // The keyboard activates it: the rest shows, and the stub goes.
    stub.focus();
    await user.keyboard('{Enter}');
    await waitForDrawn([atCap.hub.id, ...hubIds(overCap)]);
    assert.equal(revealStatus(), `Showed 1 more callee of ${overCap.hub.name}`);

    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_LAYER_CAP} callees of ${atCap.hub.name}`));
    await waitForDrawn([...hubIds(atCap), ...hubIds(overCap)]);
    assertAbsent(document.querySelector('.react-flow__node[data-id^="reveal:more:"]'), 'no stub at the cap');
    assert.deepEqual(ipcCalls(fake), before);
  });
});

describe('Collapse, and the ref card', () => {
  it('collapse hides the subtree, refs and connectors included; a collapsed candidate stays', BUDGET, async () => {
    elementSize.set(3000, 2000);
    drillFake();
    await mountRevealed([N.handleRequest.id]);
    await expandHandleRequest();
    fireEvent.click(await findOnCanvas(`Expand 1 callee of ${N.repository.name}`));
    await waitForDrawn([...HANDLE_REQUEST_EXPANDED, N.cacheLookup.id, refCardId(N.cacheLookup, N.repository)]);

    fireEvent.click(screen.getByRole('button', { name: `Collapse the callees of ${N.repository.name}` }));
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(revealStatus(), `Collapsed ${N.repository.name}, hid 1 Node`);
    fireEvent.click(screen.getByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` }));
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(revealStatus(), `Collapsed ${N.handleRequest.name}, hid 3 Nodes`);
    assert.ok(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
    assert.deepEqual(connectorIds(), []);
  });

  it('a ref card (Enter) goes to its target the way any navigation does: the view moves, with a history entry', BUDGET, async () => {
    elementSize.set(3000, 2000);
    drillFake();
    await mountRevealed([N.handleRequest.id]);
    await expandHandleRequest();
    const user = userEvent.setup();
    const forward = screen.getByRole('button', { name: 'Forward' });
    const viewport = viewportTransform();
    const ref = screen.getByRole('button', { name: `${N.repository.name} is shown above, go to it` });
    ref.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => assert.notEqual(viewportTransform(), viewport, 'the view moves to repository'), FIND);
    await settleViewport();
    // A navigation ends the drill's announcement, and Back steps back over it (not over the expand).
    assert.equal(revealStatus(), '');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => assert.equal(forward.hasAttribute('disabled'), false), FIND);
    await settleViewport();
    assert.deepEqual([...drawnCardIds()].sort(), [...HANDLE_REQUEST_EXPANDED].sort(), 'the expand stays');
  });
});

describe('Connectors and render-only cards (replaces the connector, node-type and not-counted pins)', () => {
  it('a click on a ref connector is ignored: no navigation, no history entry, the drill’s line stays', BUDGET, async () => {
    elementSize.set(3000, 2000);
    drillFake();
    await mountRevealed([N.handleRequest.id]);
    await expandHandleRequest();
    const said = revealStatus();
    const viewport = viewportTransform();
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    const connector = await waitFor(() => {
      measure();
      const found = document.querySelector<HTMLElement>('.react-flow__edge[data-id^="reveal-connector:"]');
      assert.ok(found);
      return found;
    }, FIND);
    assert.equal(connector.getAttribute('tabindex'), null, 'not a keyboard stop');
    fireEvent.click(connector);
    await settleViewport();
    assert.equal(viewportTransform(), viewport);
    assert.equal(revealStatus(), said, 'no navigation ended the drill’s announcement');
    // History holds the expand alone: one Back undoes it.
    fireEvent.click(back);
    await waitForDrawn([N.handleRequest.id]);
    assert.equal(back.hasAttribute('disabled'), true);
    assert.equal(forward.hasAttribute('disabled'), false);
  });

  it('ref and stub cards are drawn as their own kinds, never as map Nodes: no Node detail, in no Node count', BUDGET, async () => {
    elementSize.set(4000, 16_000);
    const hub = drillHub(REVEAL_LAYER_CAP + 1, { grandchildren: false });
    // The hub beside path-trace-basic, for a stub and a ref at once.
    const map: CodeMapOk = drillMap([hub]);
    const basic = pathTraceBasicMap();
    map.nodes.push(...basic.nodes);
    map.edges.push(...basic.edges);
    const reports: MapFooterState[] = [];
    drillFake({
      getCodeMap: async () => structuredClone(map),
      listEntryCandidates: async () => foundListing([hub.candidate, entryCandidate(N.handleRequest, 4)]),
    });
    await mountRevealed([hub.hub.id, N.handleRequest.id], { onMapState: (_project, state) => reports.push(state) });
    fireEvent.click(await findOnCanvas(`Expand ${REVEAL_LAYER_CAP + 1} callees of ${hub.hub.name}`));
    const stubId = revealStubCardId(hub.hub.id);
    await waitForDrawn([...hubIds(hub, REVEAL_LAYER_CAP), stubId, N.handleRequest.id]);
    await expandHandleRequest([...hubIds(hub, REVEAL_LAYER_CAP), stubId]);
    const refId = refCardId(N.serviceB, N.repository);

    for (const id of [stubId, refId]) {
      const card = cardElement(id)!;
      assertAbsent(card.querySelector('.code-map__node'), `${id} is not a Node card`);
      assert.doesNotMatch(card.textContent ?? '', /Summary/);
    }
    assert.ok(cardElement(stubId)?.classList.contains('react-flow__node-codeMapRevealStub'));
    assert.ok(cardElement(refId)?.classList.contains('react-flow__node-codeMapRevealRef'));
    // Every Node card names a map Node; neither decoration is among them.
    assert.equal(screen.getAllByRole('button', { name: /, open Node detail$/ }).length, 1 + REVEAL_LAYER_CAP + 4);
    // A click on the stub opens no Node detail: it shows the next callee.
    fireEvent.click(cardElement(stubId)!);
    await waitForDrawn([...hubIds(hub), ...HANDLE_REQUEST_EXPANDED]);
    assertAbsent(screen.queryByRole('dialog'), 'a dialog');
    // The footer's counts are the fetched map's, whatever is drawn.
    const ready = reports.filter((report) => report.status === 'ready');
    assert.ok(ready.length > 0);
    for (const report of ready) {
      assert.ok(report.status === 'ready' && report.nodes === map.nodes.length && report.edges === map.edges.length);
    }
  });
});

describe('Refresh and reload (replaces the refresh pin)', () => {
  it('a refresh keeps the expansions — listed again for the new fetch', BUDGET, async () => {
    elementSize.set(3000, 2000);
    const fake = drillFake();
    const { rerender } = await mountRevealed([N.handleRequest.id]);
    await expandHandleRequest();
    rerender(<CodeMap {...props({ dataVersion: 1 })} />);
    await waitFor(() => assert.equal(fake.calls.listEntryCandidates.length, 2), FIND);
    await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 2), FIND);
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.ok(screen.getByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` }));
  });

  it('a section switch drops them: back on the section, Revealed starts again from a new listing', BUDGET, async () => {
    const fake = drillFake({
      getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
      listEntryCandidates: async (_project, section) => foundListing([entryCandidate(section === 'web' ? S.render : S.handler, 1)]),
    });
    const sectionProps = (section: SectionName) => ({ projectPath: SECTIONED_PROJECT, section });
    const { rerender } = await mountRevealed([S.handler.id], sectionProps('api'));
    fireEvent.click(await findOnCanvas(`Expand 1 callee of ${S.handler.name}`));
    await waitForDrawn([S.handler.id, S.validate.id]);
    // Away in Full, to web and back: Revealed shows nothing meanwhile.
    fireEvent.click(viewToggle('Full map'));
    await waitForDrawn([S.handler.id, S.validate.id]);
    rerender(<CodeMap {...props(sectionProps('web'))} />);
    await waitForDrawn([S.render.id, S.layout.id]);
    rerender(<CodeMap {...props(sectionProps('api'))} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    fireEvent.click(viewToggle('Revealed'));
    await waitForDrawn([S.handler.id]);
    assert.ok(await findOnCanvas(`Expand 1 callee of ${S.handler.name}`));
    assert.deepEqual(fake.calls.listEntryCandidates, [
      [SECTIONED_PROJECT, 'api'],
      [SECTIONED_PROJECT, 'api'],
    ]);
  });
});

describe('The drill graph (replaces the drill-graph pin)', () => {
  it('walks the section’s own map: a callee in another section is neither counted nor drawn — the expanded card says so', BUDGET, async () => {
    drillFake({
      getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
      listEntryCandidates: async () => foundListing([entryCandidate(S.handler, 1)]),
    });
    await mountRevealed([S.handler.id], { projectPath: SECTIONED_PROJECT, section: 'api' });
    // handler calls validate (api) and render (web): one callee here.
    assertAbsent(cardElement(S.handler.id)?.querySelector('.code-map__node-cross-section-note'), 'no note before the expand');
    fireEvent.click(await findOnCanvas(`Expand 1 callee of ${S.handler.name}`));
    await waitForDrawn([S.handler.id, S.validate.id]);
    assert.equal(
      cardElement(S.handler.id)?.querySelector('.code-map__node-cross-section-note')?.textContent,
      '↗ Calls 1 Node in other sections (not shown in this section)',
    );
  });

  it('is built once per map fetch — a re-render never reads the map’s edges again', BUDGET, async () => {
    elementSize.set(3000, 2000);
    let reads = 0;
    const counted = (): CodeMapOk => {
      const map = pathTraceBasicMap();
      map.edges = map.edges.map((edge): CodeMapEdge => {
        const { kind } = edge;
        const copy = { ...edge };
        Object.defineProperty(copy, 'kind', {
          enumerable: true,
          get: () => {
            reads += 1;
            return kind;
          },
        });
        return copy;
      });
      return map;
    };
    drillFake({ getCodeMap: async () => counted() });
    const { rerender } = await mountRevealed([N.handleRequest.id]);
    await expandHandleRequest();
    // Re-renders with nothing new (a drill step re-reads only the edges it
    // draws, for their styling, never the whole map's).
    const after = reads;
    for (let pass = 0; pass < 3; pass += 1) {
      rerender(<CodeMap {...props()} />);
    }
    await waitForDrawn(HANDLE_REQUEST_EXPANDED);
    assert.equal(reads, after, 'no edge read again: the adjacency and the reach belong to the fetch');
  });
});
