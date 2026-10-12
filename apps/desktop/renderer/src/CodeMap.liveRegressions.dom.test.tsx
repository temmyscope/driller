/**
 * FIX-7: the 2026-10-11 batched live pass's regressions, rendered for real
 * (jsdom, a fake `window.driller`):
 * - P4-2f: a "Go to …" link in Node detail closes the panel (and the focused
 *   link with it); focus lands on the target's card, never <body>.
 * - P2-4 / P3-11/12: a lit edge's VISIBLE path paints its token. The class
 *   sits on the edge's `<g>`, and `@xyflow/react`'s `.react-flow__edge-path`
 *   rule set the path's stroke directly, so the earlier class-counting tests
 *   passed while the edge stayed grey. These tests load the two real
 *   stylesheets (React Flow's and `styles.css`) into the document and read
 *   the cascaded `stroke`/`stroke-width` of the drawn `.react-flow__edge-path`
 *   (jsdom cascades by specificity and inherits custom properties; it does
 *   not substitute `var()`, so `paintedStroke` does). Cascade only, never
 *   layout — domEnv's "never assert CSS layout in jsdom" still holds.
 * - P4-7e: Revealed cards taller and wider than the 110 × 260 grid pitch
 *   (domEnv's `cardSize`) are spaced by their measured size: no two overlap.
 * - FIX-5 follow-up: Back/Forward pressed at the end of history disables
 *   itself; focus lands on the step's card, never <body> (or the disabled
 *   button, where jsdom leaves it).
 *
 * The fast-path rescue tests (FIX-5) stay in `CodeMap.focusRescue.dom.test.tsx`.
 */
import './test/domEnv';
import { animatingElements, assertSameElement, cardSize, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CodeMap, type CodeMapProps } from './CodeMap';
import { createFakeDrillerApi, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import {
  FIXTURE_NODES,
  FIXTURE_PROJECT_PATH,
  pathTraceBasicListing,
  pathTraceBasicMap,
  prReviewBlastRadius,
  prReviewDiffScope,
  prReviewMap,
  SHARED_REACH_CANDIDATES,
  sharedReachListing,
  sharedReachMap,
} from './test/mapFixture';

const injectedStyles: HTMLStyleElement[] = [];
afterEach(() => {
  for (const style of injectedStyles.splice(0)) {
    style.remove();
  }
});
afterEach(cleanupAfterEach);

/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const FIND = { timeout: 1_500 };
const N = FIXTURE_NODES;

function fake(stubs: DrillerStubs = {}): FakeDrillerApi {
  const api = createFakeDrillerApi({
    getCodeMap: async () => pathTraceBasicMap(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
    listEntryCandidates: async () => pathTraceBasicListing(),
    ...stubs,
  });
  api.install();
  return api;
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

async function settleViewport(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
  await waitFor(() => assert.equal(animatingElements().length, 0, 'the viewport is still animating'), FIND);
}

function nodeCard(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"] .code-map__node`);
}

async function mountFull(overrides: Partial<CodeMapProps> = {}) {
  const view = render(<CodeMap {...props(overrides)} />);
  await waitForDrawn(Object.values(N).map((node) => node.id).filter((id) => pathTraceBasicMap().nodes.some((n) => n.id === id)));
  return view;
}

async function toRevealed(): Promise<void> {
  fireEvent.click(within(screen.getByRole('group', { name: 'Code Map view' })).getByRole('button', { name: 'Revealed' }));
  await waitForDrawn([N.handleRequest.id]);
}

const backButton = () => screen.getByRole('button', { name: 'Back' });
const forwardButton = () => screen.getByRole('button', { name: 'Forward' });

/** A mouse press: Chromium focuses a button on mousedown, so it holds focus when the click lands. */
function mousePress(button: HTMLElement): void {
  act(() => button.focus());
  fireEvent.click(button);
}

// ---------------------------------------------------------------------------
// The painted edge stroke

const require = createRequire(import.meta.url);

/** Loads React Flow's stylesheet, then the app's — the order `CodeMap.tsx` and `main.tsx` import them. */
function loadRealStylesheets(): void {
  const sources = [
    readFileSync(require.resolve('@xyflow/react/dist/style.css'), 'utf8'),
    readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8'),
  ];
  for (const source of sources) {
    const style = document.createElement('style');
    style.textContent = source;
    document.head.append(style);
    injectedStyles.push(style);
  }
}

/** `value` with every `var(--x[, fallback])` substituted from `element`'s computed custom properties. */
function substituteVars(value: string, element: Element): string {
  const pattern = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/;
  let current = value;
  for (let guard = 0; guard < 20; guard += 1) {
    const match = pattern.exec(current);
    if (match === null) {
      return current.trim();
    }
    const custom = getComputedStyle(element).getPropertyValue(match[1]!).trim();
    current = current.replace(match[0], custom !== '' ? custom : (match[2] ?? '').trim());
  }
  return current.trim();
}

/** The cascaded stroke and width of `edge`'s visible path (its `.react-flow__edge-path`), `var()`s substituted. */
function paintedStroke(edge: Element): { stroke: string; width: string } {
  const path = edge.querySelector('.react-flow__edge-path');
  assert.ok(path, 'the edge has a visible path');
  const style = getComputedStyle(path);
  return { stroke: substituteVars(style.getPropertyValue('stroke'), path), width: substituteVars(style.getPropertyValue('stroke-width'), path) };
}

/** A design token's value, as `:root` defines it. */
function token(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  assert.notEqual(value, '', `${name} is defined`);
  return value;
}

function edgesWithClass(className: string): Element[] {
  return [...document.querySelectorAll(`.react-flow__edge.${className}`)];
}

describe('FIX-7: a lit edge paints its visible path (P2-4, P3-11/12)', () => {
  it('a neighbour trace’s edges paint trace-cyan, 2px; an unlit edge does not', BUDGET, async () => {
    fake();
    await mountFull();
    loadRealStylesheets();
    fireEvent.click(await findOnCanvas(`2 calls — show the callees of ${N.handleRequest.name}`));
    await settleViewport();
    const lit = await waitFor(() => {
      measure();
      const edges = edgesWithClass('code-map__edge--path-highlight');
      assert.equal(edges.length, 2, 'handleRequest’s two call edges are lit');
      return edges;
    }, FIND);
    const cyan = token('--trace-cyan');
    for (const edge of lit) {
      assert.deepEqual(paintedStroke(edge), { stroke: cyan, width: '2' }, `${edge.getAttribute('data-id')} paints the route`);
    }
    const unlit = [...document.querySelectorAll('.react-flow__edge')].filter((edge) => !lit.includes(edge));
    assert.ok(unlit.length > 0, 'some edge is not lit');
    for (const edge of unlit) {
      assert.notEqual(paintedStroke(edge).stroke, cyan, `${edge.getAttribute('data-id')} is not painted as the route`);
    }
  });

  it('PR Review: an edge leaving a changed Node paints the accent, 2px', BUDGET, async () => {
    createFakeDrillerApi({
      getCodeMap: async () => prReviewMap(),
      getShowFoldedKinds: async () => false,
      getEntryPins: async () => [],
      computeDiffScope: async () => prReviewDiffScope(),
      expandBlastRadius: async () => prReviewBlastRadius(),
    }).install();
    render(<CodeMap {...props({ mode: 'prReview' })} />);
    const input = await screen.findByRole('textbox', { name: 'Base ref' }, FIND);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'main' } });
      fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
    });
    loadRealStylesheets();
    await settleViewport();
    const changed = await waitFor(() => {
      measure();
      const edges = edgesWithClass('code-map__edge--changed-source');
      assert.ok(edges.length > 0, 'an edge leaves the changed repository');
      return edges;
    }, FIND);
    const accent = token('--accent');
    for (const edge of changed) {
      assert.deepEqual(paintedStroke(edge), { stroke: accent, width: '2' }, `${edge.getAttribute('data-id')} paints the accent`);
    }
  });
});

// ---------------------------------------------------------------------------
// Revealed card spacing

/** A drawn card's box: React Flow's `translate(x, y)` and domEnv's measured `cardSize`. */
function cardBox(wrapper: HTMLElement): { id: string; x: number; y: number; width: number; height: number } {
  const match = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(wrapper.style.transform);
  assert.ok(match, `${wrapper.getAttribute('data-id')} has a position`);
  return { id: wrapper.getAttribute('data-id') ?? '', x: Number(match[1]), y: Number(match[2]), width: cardSize.width, height: cardSize.height };
}

describe('FIX-7: Revealed spaces cards by their drawn size (P4-7e)', () => {
  /** Every drawn card's box (clusters left out). */
  function drawnBoxes() {
    return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
      .filter((wrapper) => !(wrapper.getAttribute('data-id') ?? '').startsWith('cluster:'))
      .map(cardBox);
  }

  it('cards taller and wider than the grid pitch never overlap after an expand; Full keeps its grid', BUDGET, async () => {
    elementSize.set(4000, 3000);
    fake();
    await mountFull();
    await toRevealed();
    // A summary + AI-judgment + risk-strip card, roughly, as the live pass
    // measured them — they grow only once Revealed is drawn (a size seen in
    // Full is never what Revealed spaces by).
    cardSize.set(420, 150);
    fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
    await settleViewport();
    await waitFor(() => {
      measure();
      const boxes = drawnBoxes();
      assert.ok(boxes.length >= 4, `the expand drew its layers (${boxes.map((box) => box.id).join(', ')})`);
      for (const a of boxes) {
        for (const b of boxes) {
          if (a.id >= b.id) continue;
          const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
          assert.ok(!overlap, `${a.id} at (${a.x}, ${a.y}) and ${b.id} at (${b.x}, ${b.y}) overlap`);
        }
      }
    }, FIND);
    // Full is untouched: its grid pitch, whatever the cards measure.
    fireEvent.click(within(screen.getByRole('group', { name: 'Code Map view' })).getByRole('button', { name: 'Full map' }));
    await settleViewport();
    await waitFor(() => {
      measure();
      const boxes = drawnBoxes();
      assert.equal(boxes.length, pathTraceBasicMap().nodes.length, 'Full draws every card');
      for (const box of boxes) {
        assert.ok(box.x % 260 === 0 && box.y % 110 === 0, `${box.id} at (${box.x}, ${box.y}) is on the Full grid`);
      }
    }, FIND);
    await settleViewport();
  });
});

function viewport(): { x: number; y: number; zoom: number } {
  const transform = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
  const match = /translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(transform);
  assert.ok(match, `a viewport transform (${transform})`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

describe('FIX-7: the Revealed fit covers the cards as measured', () => {
  const candidateIds = Object.values(SHARED_REACH_CANDIDATES).map((node) => node.id);

  async function mountSharedReachRevealed(): Promise<void> {
    fake({ getCodeMap: async () => sharedReachMap(), listEntryCandidates: async () => sharedReachListing() });
    render(<CodeMap {...props()} />);
    await waitFor(() => {
      measure();
      assert.ok(drawnIds().length > 0);
    }, FIND);
    fireEvent.click(within(screen.getByRole('group', { name: 'Code Map view' })).getByRole('button', { name: 'Revealed' }));
    await waitForDrawn(candidateIds);
    await settleViewport();
  }

  it('cards measured taller than the grid after the toggle’s fit: the view fits again, every candidate on screen', BUDGET, async () => {
    await mountSharedReachRevealed();
    cardSize.set(420, 190);
    await waitFor(() => {
      measure();
      assert.equal(cardBox(document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(candidateIds[1]!)}"]`)!).y >= 190, true, 'the rows spread by the measured height');
    }, FIND);
    await settleViewport();
    await waitFor(() => {
      measure();
      const { x, y, zoom } = viewport();
      for (const wrapper of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
        const box = cardBox(wrapper);
        const top = box.y * zoom + y;
        const left = box.x * zoom + x;
        assert.ok(top >= 0 && top < elementSize.height && left >= 0 && left < elementSize.width, `${box.id}'s card starts on screen (${left}, ${top})`);
      }
      assert.equal(document.querySelectorAll('.react-flow__node[data-id]').length, candidateIds.length);
    }, FIND);
    await settleViewport();
  });

  it('after the user zooms, a re-layout never moves the view', BUDGET, async () => {
    await mountSharedReachRevealed();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    await settleViewport();
    const before = viewport();
    cardSize.set(420, 190);
    await waitFor(() => {
      measure();
      assert.equal(cardBox(document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(candidateIds[1]!)}"]`)!).y >= 190, true, 'the rows spread by the measured height');
    }, FIND);
    await settleViewport();
    assert.deepEqual(viewport(), before);
  });

  it('after an expand a re-layout never moves the view', BUDGET, async () => {
    await mountSharedReachRevealed();
    fireEvent.click(await findOnCanvas(new RegExp(`^Expand \\d+ callees? of ${SHARED_REACH_CANDIDATES.alpha.name}$`)));
    await settleViewport();
    await waitFor(() => {
      measure();
      assert.ok(drawnIds().length > candidateIds.length, 'the expand drew callees');
    }, FIND);
    const before = viewport();
    cardSize.set(420, 190);
    await waitFor(() => {
      measure();
      // The re-layout happened (rows now 190 + the gap apart) …
      const ys = candidateIds.map((id) => cardBox(document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)!).y);
      assert.ok(ys.some((value) => value >= 190), `rows spread by the measured height (${ys.join(', ')})`);
    }, FIND);
    await settleViewport();
    // … and the view stayed where it was.
    assert.deepEqual(viewport(), before);
  });
});

// ---------------------------------------------------------------------------
// Focus

describe('FIX-7: focus lands on the card the map centres on', () => {
  it('P4-2f: a Node detail "Go to …" link closes the panel and focuses the target’s card', BUDGET, async () => {
    const map = pathTraceBasicMap();
    map.nodes[0] = { ...map.nodes[0]!, fileTopLevel: [{ id: N.serviceA.id, kind: 'CALLS' }] };
    fake({ getCodeMap: async () => structuredClone(map) });
    await mountFull();
    fireEvent.click(await findOnCanvas(/^Function handleRequest, open Node detail/));
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${N.handleRequest.name}` }, FIND);
    mousePress(within(detail).getByRole('button', { name: /^Go to serviceA/ }));
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null), FIND);
    await settleViewport();
    await waitFor(() => {
      measure();
      assertSameElement(document.activeElement, nodeCard(N.serviceA.id), 'focus');
    }, FIND);
  });

  it('P4-2f via Revealed: a link to a Node Revealed doesn’t draw switches to Full and focuses its card', BUDGET, async () => {
    const map = pathTraceBasicMap();
    map.nodes[0] = { ...map.nodes[0]!, fileTopLevel: [{ id: N.serviceA.id, kind: 'CALLS' }] };
    fake({ getCodeMap: async () => structuredClone(map) });
    await mountFull();
    await toRevealed();
    fireEvent.click(await findOnCanvas(/^Function handleRequest, entry candidate/));
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${N.handleRequest.name}` }, FIND);
    mousePress(within(detail).getByRole('button', { name: /^Go to serviceA/ }));
    await settleViewport();
    await waitFor(() => {
      measure();
      assertSameElement(document.activeElement, nodeCard(N.serviceA.id), 'focus');
    }, FIND);
  });

  it('FIX-5 follow-up: Back to the start of history focuses the step’s card; Forward to the end does too', BUDGET, async () => {
    fake();
    await mountFull();
    await toRevealed();
    fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
    await waitFor(() => assert.equal(backButton().hasAttribute('disabled'), false, 'Back is enabled'), FIND);
    await settleViewport();
    mousePress(backButton());
    await waitFor(() => assert.equal(backButton().hasAttribute('disabled'), true, 'Back is at the start'), FIND);
    await settleViewport();
    await waitFor(() => {
      measure();
      assertSameElement(document.activeElement, nodeCard(N.handleRequest.id), 'focus after Back');
    }, FIND);
    mousePress(forwardButton());
    await waitFor(() => assert.equal(forwardButton().hasAttribute('disabled'), true, 'Forward is at the end'), FIND);
    await settleViewport();
    await waitFor(() => {
      measure();
      assertSameElement(document.activeElement, nodeCard(N.handleRequest.id), 'focus after Forward');
    }, FIND);
  });

  it('a Back that stays enabled keeps focus on Back (P4-7f, unchanged)', BUDGET, async () => {
    fake();
    await mountFull();
    await toRevealed();
    fireEvent.click(await findOnCanvas(`Expand 2 callees of ${N.handleRequest.name}`));
    await settleViewport();
    fireEvent.click(await findOnCanvas(`Collapse the callees of ${N.handleRequest.name}`));
    await waitFor(() => {
      measure();
      assert.equal(screen.queryByRole('button', { name: `Collapse the callees of ${N.handleRequest.name}` }), null, 'collapsed');
    }, FIND);
    await settleViewport();
    mousePress(backButton());
    await settleViewport();
    assert.equal(backButton().hasAttribute('disabled'), false, 'Back is still enabled (the expand is left)');
    assertSameElement(document.activeElement, backButton(), 'focus stays on Back');
  });
});
