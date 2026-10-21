/**
 * P4-8d: what `CodeMap` does with a section, rendered for real (jsdom, a
 * fake `window.driller`) — replacing the P4-4 source pins on `CodeMap.tsx`.
 * Each test drives the props App drives and asserts what the user and the
 * IPC boundary see: the recorded `getCodeMap(section)` calls, the cards
 * drawn, Node detail, notices, and where focus lands.
 *
 * - The section prop and its mirror: the first fetch is the whole scope, and
 *   every switch fetches the section on screen; a reply that settles after a
 *   switch never replaces the newer section's map.
 * - Node detail's cross-section switch, and the one-shot pending focus that
 *   comes back: the card once drawn, the canvas wrapper if it never draws,
 *   the "not on the current map" notice (with or without a Path Trace
 *   wrapper) when it is missing; the consumer is called once.
 * - The first fit per section, the empty-section notice, the regenerate
 *   patch in a section, and a Blast Radius expansion whose section is gone.
 *
 * Moving to a Node animates the viewport (React Flow's `setCenter`, 300 ms,
 * driven by jsdom's real animation frames); `settleViewport` waits for that
 * animation to end so it can't update the tree after the test.
 */
import './test/domEnv';
import { animatingElements, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BlastRadiusExpansionResult, CodeMapNode, CodeMapResult, DiffScopeResult, PathTraceResult } from '@driller/ipc-contracts';
import {
  CARD_FOCUS_MAX_FRAMES,
  CodeMap,
  CROSS_SECTION_MISS_TEXT_ID,
  initialViewport,
  LOD_ZOOM_THRESHOLD,
  MAP_MAX_ZOOM,
  NODE_CARD_FALLBACK_HEIGHT,
  NODE_CARD_FALLBACK_WIDTH,
  NOT_ON_CURRENT_MAP,
  ROUTE_MIN_READABLE_ZOOM,
  type CodeMapProps,
} from './CodeMap';
import { SectionBar } from './SectionBar';
import { createFakeDrillerApi, deferred, type Deferred, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import { fullMapPositions, SECTION_NODES, sectionedMap, syntheticMap, type CodeMapOk, type SectionName } from './test/mapFixture';

// `cleanupAfterEach` also lets a viewport animation still running finish (bounded) before the unmount.
afterEach(cleanupAfterEach);

/** Never `assert.equal(element, null)`: a failing diff of a jsdom element takes minutes (it looks like a hang). */
function assertAbsent(element: Element | null | undefined, what: string): void {
  assert.ok(element === null || element === undefined, `${what} is absent`);
}


/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const FIND = { timeout: 1_500 };
const PROJECT = '/work/two-sections';
const S = SECTION_NODES;

function codeMapFake(stubs: DrillerStubs = {}): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
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

/** The drawn card text of a Node (inside a React Flow Node). */
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

function findCard(name: string): Promise<HTMLElement> {
  return screen.findByText(name, { selector: '.react-flow__node .code-map__node *' }, FIND);
}

function drawnNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('cluster:'))
    .sort();
}

/**
 * Reports the canvas's size to every ResizeObserver, as a browser does once
 * the canvas mounts (the DOM environment's observers report only when told).
 * Until `CodeMap`'s own observer reports, its LOD pass has no viewport and
 * folds every Node but the first into a cluster card.
 */
function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

/** Waits until exactly these Nodes are drawn as cards, measuring the (re)mounted canvas meanwhile. */
async function waitForDrawn(ids: readonly string[]): Promise<void> {
  await waitFor(() => {
    measure();
    assert.deepEqual(drawnNames(), [...ids].sort());
  }, FIND);
}

function cardOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"] .code-map__node`);
}

/**
 * Asserts which element has focus. Never `assert.equal` on two elements: its
 * failure message diffs both jsdom object graphs, which takes minutes.
 */
function assertFocused(element: Element | null, what: string): void {
  const active = document.activeElement;
  assert.ok(element !== null && active === element, `${what} has focus (it is on ${describeElement(active)})`);
}

function describeElement(element: Element | null): string {
  if (element === null) {
    return 'nothing';
  }
  const label = element.getAttribute('aria-label') ?? element.textContent?.slice(0, 40) ?? '';
  return `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> ${label}`;
}

function viewportTransform(): string | undefined {
  return document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
}

/** Whether a d3 transition (React Flow's animated `setCenter`) is still scheduled or running. */
function viewportAnimating(): boolean {
  return animatingElements().length > 0;
}

/** Waits for the animated move to a Node to end (see the header). */
async function settleViewport(): Promise<void> {
  await waitFor(() => assert.equal(viewportAnimating(), false, 'the viewport is still animating'), FIND);
}

/** Opens Node detail for a drawn card, as a click on it does. */
async function openNodeDetail(name: string): Promise<HTMLElement> {
  fireEvent.click(await findCard(name));
  return screen.findByRole('dialog', { name: `Node detail: ${name}` }, FIND);
}

/**
 * Takes over `requestAnimationFrame` for the card-focus wait, so a test can
 * step the frames itself. React Flow's own animation keeps jsdom's frames
 * (d3 bound them when it loaded).
 */
function manualAnimationFrames(): { step(): void; restore(): void } {
  const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const cafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  let queue = new Map<number, FrameRequestCallback>();
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
    step() {
      const due = queue;
      queue = new Map();
      for (const callback of due.values()) {
        callback(performance.now());
      }
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

/** A `getCodeMap` stub whose replies the test settles, one deferred per call, in call order. */
function deferredMaps(): { stub: NonNullable<DrillerStubs['getCodeMap']>; replies: Deferred<CodeMapResult>[] } {
  const replies: Deferred<CodeMapResult>[] = [];
  return {
    replies,
    stub: () => {
      const reply = deferred<CodeMapResult>();
      replies.push(reply);
      return reply.promise;
    },
  };
}

/**
 * App's side of the switch, in miniature: the section and the one-shot
 * pending Node are its state, a switch sets both, and the consumer clears
 * the pending Node.
 */
function SwitchingShell({ initialSection, onConsumed }: { initialSection: string | null; onConsumed: () => void }) {
  const [section, setSection] = useState<string | null>(initialSection);
  const [pending, setPending] = useState<string | null>(null);
  return (
    <CodeMap
      {...props({
        section,
        pendingFocusNodeId: pending,
        onSwitchSection: (next, focusNodeId) => {
          setSection(next);
          setPending(focusNodeId ?? null);
        },
        onPendingFocusConsumed: () => {
          onConsumed();
          setPending(null);
        },
      })}
    />
  );
}

describe('CodeMap: the section prop (replaces the sectionScopedOps prop/ref pin)', () => {
  it('fetches the whole scope by default, then the section on screen after every switch', BUDGET, async () => {
    const fake = codeMapFake();
    const { rerender } = render(<CodeMap {...props()} />);
    await findCard(S.render.name);
    assert.deepEqual(fake.calls.getCodeMap, [[undefined]], 'no section prop: the whole scope');

    rerender(<CodeMap {...props({ section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);

    rerender(<CodeMap {...props({ section: 'web' })} />);
    await waitForDrawn([S.layout.id, S.render.id]);

    rerender(<CodeMap {...props({ section: null })} />);
    await waitForDrawn([S.handler.id, S.validate.id, S.render.id, S.layout.id]);
    assert.deepEqual(fake.calls.getCodeMap, [[undefined], ['api'], ['web'], [undefined]]);
  });

  it('a reply that settles after a switch is ignored: api → web, api answering last, shows web', BUDGET, async () => {
    const maps = deferredMaps();
    const fake = codeMapFake({ getCodeMap: maps.stub });
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    rerender(<CodeMap {...props({ section: 'web' })} />);
    assert.deepEqual(fake.calls.getCodeMap, [['api'], ['web']]);

    await act(async () => {
      maps.replies[1]!.resolve(sectionedMap('web'));
    });
    await waitForDrawn([S.layout.id, S.render.id]);
    await act(async () => {
      maps.replies[0]!.resolve(sectionedMap('api'));
    });
    assert.deepEqual(drawnNames(), [S.layout.id, S.render.id]);
    assert.equal(screen.queryByText(S.handler.name), null);
  });
});

// P5-d: main supersedes a waiting Code Map request when a later one for
// another section arrives; that caller gets this explicit result (the same
// text as main's `SUPERSEDED_RESULT`, `code-map-requests.ts`).
const SUPERSEDED: CodeMapResult = { status: 'error', message: 'Superseded by a later Code Map request.' };

describe('CodeMap: a fast run of switches main coalesces (P5-d)', () => {
  it('all → api → web, api superseded: shows web, with no error and nothing said about it', BUDGET, async () => {
    const maps = deferredMaps();
    const fake = codeMapFake({ getCodeMap: maps.stub });
    const { rerender } = render(<CodeMap {...props({ section: null })} />);
    rerender(<CodeMap {...props({ section: 'api' })} />);
    rerender(<CodeMap {...props({ section: 'web' })} />);
    assert.deepEqual(fake.calls.getCodeMap, [[undefined], ['api'], ['web']]);

    // Main's order: api is superseded the moment web arrives, then the
    // whole scope (in flight) answers, then web.
    await act(async () => {
      maps.replies[1]!.resolve(SUPERSEDED);
    });
    assertAbsent(screen.queryByRole('alert'), 'an error notice while web loads');
    assert.equal(document.body.textContent?.includes('Superseded'), false, 'nothing flashes');
    await act(async () => {
      maps.replies[0]!.resolve(sectionedMap(null));
    });
    await act(async () => {
      maps.replies[2]!.resolve(sectionedMap('web'));
    });
    await waitForDrawn([S.layout.id, S.render.id]);
    assertAbsent(screen.queryByRole('alert'), 'an error notice');
    assert.equal(document.body.textContent?.includes('Superseded'), false, 'the superseded result is never shown or announced');
  });
});

describe('CodeMap: switching section from Node detail (replaces the crossSection wiring pins)', () => {
  it('offers the callee’s section on a section map only, and asks for the switch with the callee', BUDGET, async () => {
    codeMapFake({
      // Even with the field on the `all` reply, `all` offers no switch.
      getCodeMap: async (section) =>
        section === undefined
          ? sectionedMap(null, { nodes: [sectionedMap('api').nodes[0]!, S.validate, S.render, S.layout] })
          : sectionedMap(section as SectionName),
    });
    const switches: unknown[][] = [];
    const { rerender } = render(<CodeMap {...props({ onSwitchSection: (...args) => switches.push(args) })} />);
    const allDetail = await openNodeDetail(S.handler.name);
    assert.equal(within(allDetail).queryByRole('list', { name: 'Calls into other sections' }), null);
    fireEvent.click(within(allDetail).getByRole('button', { name: /close/i }));

    rerender(<CodeMap {...props({ section: 'api', onSwitchSection: (...args) => switches.push(args) })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    const detail = await openNodeDetail(S.handler.name);
    const list = within(detail).getByRole('list', { name: 'Calls into other sections' });
    fireEvent.click(within(list).getByRole('button', { name: 'Switch to web and show render' }));
    assert.deepEqual(switches, [['web', S.render.id]]);
    assert.equal(screen.queryByRole('dialog', { name: `Node detail: ${S.handler.name}` }), null, 'Node detail closed');
  });

  it('once the target section is drawn, focuses the callee’s card and reports the pending Node consumed once', BUDGET, async () => {
    const fake = codeMapFake();
    let consumed = 0;
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    await findCard(S.handler.name);
    rerender(
      <CodeMap {...props({ section: 'web', pendingFocusNodeId: S.render.id, onPendingFocusConsumed: () => (consumed += 1) })} />,
    );
    await waitFor(() => assertFocused(cardOf(S.render.id), 'the render card'), FIND);
    assert.ok(document.activeElement?.closest(`.react-flow__node[data-id="${CSS.escape(S.render.id)}"]`));
    assert.equal(consumed, 1);
    assert.deepEqual(fake.calls.getCodeMap, [['api'], ['web']]);
    await settleViewport();
    assert.equal(consumed, 1);
  });

  it('when the callee’s card never draws, focus falls back to the canvas wrapper — never <body>', BUDGET, async () => {
    // A 300-Node `web` map: the target sits far outside the first fit, so
    // React Flow culls its card until the (animated) move reaches it. The
    // test steps the card-focus frames itself, all before the move can
    // start, so the card is never drawn while the wait lasts.
    const web = syntheticMap({ nodes: 300 });
    const webMap: CodeMapOk = { ...web, appliedScope: ['api', 'web'], section: 'web', sections: sectionedMap('web').sections };
    const target = web.nodes.at(-1)!;
    codeMapFake({ getCodeMap: async (section) => (section === 'web' ? structuredClone(webMap) : sectionedMap('api')) });
    let consumed = 0;
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    await findCard(S.handler.name);
    rerender(<CodeMap {...props({ section: 'web' })} />);
    await waitFor(() => {
      showAllNodes();
      assert.ok(drawnNames().length > 0 && drawnNames().every((id) => id.startsWith('fixture://')));
    }, FIND);
    await waitFor(() => assert.notEqual(document.querySelector<HTMLElement>('.react-flow')?.style.visibility, 'hidden'), FIND);
    assert.equal(cardOf(target.id), null, 'the target card is culled');

    const frames = manualAnimationFrames();
    try {
      act(() => {
        rerender(
          <CodeMap
            {...props({ section: 'web', pendingFocusNodeId: target.id, onPendingFocusConsumed: () => (consumed += 1) })}
          />,
        );
      });
      assert.equal(consumed, 1);
      for (let frame = 0; frame < CARD_FOCUS_MAX_FRAMES; frame += 1) {
        assert.notEqual(document.activeElement?.className, 'code-map__canvas', `not before frame ${frame + 1}`);
        act(() => frames.step());
      }
    } finally {
      frames.restore();
    }
    assert.equal(cardOf(target.id), null);
    const canvas = document.querySelector<HTMLElement>('.code-map__canvas');
    assert.ok(canvas);
    assertFocused(canvas, 'the canvas wrapper');
    assert.equal(canvas.tabIndex, -1);
    await settleViewport();
    assert.equal(consumed, 1);
  });

  it('a callee the target map lacks: the notice names it (as Node detail did), its Dismiss takes focus, consumed once', BUDGET, async () => {
    // The `web` reply has no `render` (hidden by scope or filters).
    codeMapFake({
      getCodeMap: async (section) =>
        section === 'web' ? sectionedMap('web', { nodes: [S.layout], edges: [] }) : sectionedMap(section as SectionName),
    });
    let consumed = 0;
    render(<SwitchingShell initialSection="api" onConsumed={() => (consumed += 1)} />);
    const detail = await openNodeDetail(S.handler.name);
    fireEvent.click(within(detail).getByRole('button', { name: 'Switch to web and show render' }));

    const dismiss = await screen.findByRole('button', { name: 'Dismiss' }, FIND);
    // Named by the callee's name from Node detail, never its id.
    assert.equal(document.getElementById(CROSS_SECTION_MISS_TEXT_ID)?.textContent, `render in web/ — ${NOT_ON_CURRENT_MAP}`);
    await waitFor(() => assertFocused(dismiss, 'Dismiss'), FIND);
    assert.equal(consumed, 1);
  });

  it('the miss notice shows even with no Path Trace wrapper: an empty target section', BUDGET, async () => {
    codeMapFake({
      getCodeMap: async (section) =>
        section === 'web' ? sectionedMap('web', { nodes: [], edges: [] }) : sectionedMap(section as SectionName),
    });
    let consumed = 0;
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    await findCard(S.handler.name);
    rerender(
      <CodeMap {...props({ section: 'web', pendingFocusNodeId: S.render.id, onPendingFocusConsumed: () => (consumed += 1) })} />,
    );
    await screen.findByText('No map Nodes in', { exact: false }, FIND);
    assert.equal(screen.queryByRole('search'), null);
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' }, FIND);
    // No Node detail named it here, so the notice names its id.
    assert.ok(dismiss.closest('.code-map__path-trace'));
    assert.equal(document.getElementById(CROSS_SECTION_MISS_TEXT_ID)?.textContent, `${S.render.id} in web/ — ${NOT_ON_CURRENT_MAP}`);
    await waitFor(() => assertFocused(dismiss, 'Dismiss'), FIND);
    assert.equal(consumed, 1);
  });
});

/**
 * App's side with the real Section bar above `CodeMap`: the section and the
 * one-shot pending Node are state; a tab, Node detail's switch, or the
 * test (`control.switchTo`) sets them.
 */
function BarShell({
  initialSection,
  mode = 'codeMap',
  onConsumed,
  control = {},
}: {
  initialSection: string | null;
  mode?: CodeMapProps['mode'];
  onConsumed: () => void;
  control?: { switchTo?: (section: string, focusNodeId: string) => void };
}) {
  const [section, setSection] = useState<string | null>(initialSection);
  const [pending, setPending] = useState<string | null>(null);
  control.switchTo = (next, focusNodeId) => {
    setSection(next);
    setPending(focusNodeId);
  };
  return (
    <>
      <SectionBar
        sections={sectionedMap('api').sections}
        section={section}
        enabled
        onChange={(next) => {
          setSection(next);
          setPending(null);
        }}
      />
      <CodeMap
        {...props({
          mode,
          section,
          pendingFocusNodeId: pending,
          onSwitchSection: (next, focusNodeId) => {
            setSection(next);
            setPending(focusNodeId ?? null);
          },
          onPendingFocusConsumed: () => {
            onConsumed();
            setPending(null);
          },
        })}
      />
    </>
  );
}

function selectedTab(): HTMLElement {
  return screen.getByRole('tab', { selected: true });
}

/** A drawn card's position (its React Flow wrapper's `translate`) — what `centerOnNode` centres on. */
function cardPosition(id: string): { x: number; y: number } {
  const wrapper = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  assert.ok(wrapper, `${id} is drawn`);
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(wrapper.style.transform);
  assert.ok(match, `${id} has a position`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** The world point at the centre of the canvas. */
function viewportCentre(): { x: number; y: number } {
  const match = /translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(viewportTransform() ?? '');
  assert.ok(match, `a viewport transform (${viewportTransform()})`);
  const [x, y, zoom] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { x: (elementSize.width / 2 - x) / zoom, y: (elementSize.height / 2 - y) / zoom };
}

/** Records every `focus()` call's target and options while `run` runs. */
async function recordingFocus(run: (calls: { target: HTMLElement; options: FocusOptions | undefined }[]) => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus');
  assert.ok(original?.value);
  const calls: { target: HTMLElement; options: FocusOptions | undefined }[] = [];
  Object.defineProperty(HTMLElement.prototype, 'focus', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options?: FocusOptions) {
      calls.push({ target: this, options });
      return (original.value as (options?: FocusOptions) => void).call(this, options);
    },
  });
  try {
    await run(calls);
  } finally {
    Object.defineProperty(HTMLElement.prototype, 'focus', original);
  }
}

describe('CodeMap: the pending Node waits for its map and its first fit (P4-8j: replaces the pending-focus effect pins)', () => {
  it('while the target map loads nothing is consumed or said; then the view centres on the callee, focused without a scroll, by navigating to it', BUDGET, async () => {
    const maps = deferredMaps();
    codeMapFake({ getCodeMap: maps.stub });
    let consumed = 0;
    render(<BarShell initialSection="api" onConsumed={() => (consumed += 1)} />);
    await act(async () => maps.replies[0]!.resolve(sectionedMap('api')));
    const detail = await openNodeDetail(S.handler.name);
    await recordingFocus(async (focusCalls) => {
      fireEvent.click(within(detail).getByRole('button', { name: 'Switch to web and show render' }));
      // The old (api) map is still the ready one while web's reply is out.
      for (let turn = 0; turn < 5; turn += 1) {
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        });
      }
      assert.equal(consumed, 0, 'nothing consumed while web’s map loads');
      assertAbsent(screen.queryByRole('button', { name: 'Dismiss' }), 'never "not on the current map" for the old map');

      await act(async () => maps.replies[1]!.resolve(sectionedMap('web')));
      await waitFor(() => assertFocused(cardOf(S.render.id), 'the render card'), FIND);
      assert.equal(consumed, 1);
      const cardFocus = focusCalls.filter((call) => call.target === cardOf(S.render.id));
      assert.ok(cardFocus.length > 0 && cardFocus.every((call) => call.options?.preventScroll === true), 'focused without scrolling');
    });
    await settleViewport();
    const centre = viewportCentre();
    const at = cardPosition(S.render.id);
    assert.ok(Math.abs(centre.x - at.x) < 1e-6 && Math.abs(centre.y - at.y) < 1e-6, `centred on render (${at.x}, ${at.y}), not (${centre.x}, ${centre.y})`);
    assert.equal(consumed, 1);
  });

  it('a reload clears the "not on the current map" notice', BUDGET, async () => {
    codeMapFake({
      getCodeMap: async (section) =>
        section === 'web' ? sectionedMap('web', { nodes: [S.layout], edges: [] }) : sectionedMap(section as SectionName),
    });
    render(<BarShell initialSection="api" onConsumed={() => {}} />);
    const detail = await openNodeDetail(S.handler.name);
    fireEvent.click(within(detail).getByRole('button', { name: 'Switch to web and show render' }));
    await screen.findByRole('button', { name: 'Dismiss' }, FIND);
    fireEvent.click(screen.getByRole('tab', { name: /^api/ }));
    await waitForDrawn([S.handler.id, S.validate.id]);
    assertAbsent(screen.queryByRole('button', { name: 'Dismiss' }), 'screen.queryByRole(button, { name: Dismiss })');
    assertAbsent(document.getElementById(CROSS_SECTION_MISS_TEXT_ID), 'document.getElementById(CROSS_SECTION_MISS_TEXT_ID)');
  });

  it('Dismiss hands focus to the selected Section bar tab', BUDGET, async () => {
    codeMapFake({
      getCodeMap: async (section) =>
        section === 'web' ? sectionedMap('web', { nodes: [S.layout], edges: [] }) : sectionedMap(section as SectionName),
    });
    render(<BarShell initialSection="api" onConsumed={() => {}} />);
    const detail = await openNodeDetail(S.handler.name);
    fireEvent.click(within(detail).getByRole('button', { name: 'Switch to web and show render' }));
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' }, FIND);
    await waitFor(() => assertFocused(dismiss, 'Dismiss'), FIND);
    fireEvent.click(dismiss);
    assertAbsent(screen.queryByRole('button', { name: 'Dismiss' }), 'screen.queryByRole(button, { name: Dismiss })');
    assert.match(selectedTab().textContent ?? '', /^web/);
    assertFocused(selectedTab(), 'the web tab');
  });

  it('Health Audit (no canvas): the callee opens in Node detail, opened from the selected tab — closing it returns there', BUDGET, async () => {
    codeMapFake();
    let consumed = 0;
    const control: { switchTo?: (section: string, focusNodeId: string) => void } = {};
    render(<BarShell initialSection="api" mode="healthAudit" onConsumed={() => (consumed += 1)} control={control} />);
    await screen.findByRole('tab', { name: /^api/, selected: true }, FIND);
    await screen.findByRole('search', {}, FIND);
    act(() => control.switchTo!('web', S.render.id));
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${S.render.name}` }, FIND);
    assert.equal(consumed, 1);
    assertAbsent(document.querySelector('.react-flow'), 'no canvas in Health Audit');
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    await waitFor(() => assertAbsent(screen.queryByRole('dialog', { name: `Node detail: ${S.render.name}` }), 'screen.queryByRole(dialog, { name: Node detail: ${S.render.name} })'), FIND);
    assert.match(selectedTab().textContent ?? '', /^web/);
    await waitFor(() => assertFocused(selectedTab(), 'the web tab'), FIND);
    assert.equal(consumed, 1);
  });
});

/** A found route along `ids` (each the previous one's callee). */
function foundRoute(ids: readonly string[]): PathTraceResult {
  const parents = Object.create(null) as Record<string, string | null>;
  const depths = Object.create(null) as Record<string, number>;
  ids.forEach((id, index) => {
    parents[id] = index === 0 ? null : ids[index - 1]!;
    depths[id] = index;
  });
  return { status: 'found', path: [...ids], parents, depths };
}

/** The canvas Nodes lit as a Path Trace route. */
function routeIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node.code-map__path-highlight')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .sort();
}

/** The canvas Nodes lit as the blast radius. */
function blastIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node.code-map__blast-radius-highlight')]
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

function trace(query: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Path Trace query' }), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: /^(Trace|Searching…)$/ }));
}

async function computeDiff(baseRef = 'main'): Promise<void> {
  const input = await screen.findByRole('textbox', { name: 'Base ref' }, FIND);
  await act(async () => {
    fireEvent.change(input, { target: { value: baseRef } });
    fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
  });
}

/** In `act`: a few macrotask turns, for replies that would land. */
async function turns(count = 5): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

const IDLE_PROMPT = 'Enter a base ref (or leave it blank to auto-resolve) and compute the diff scope to see changed Nodes.';
const API_DIFF: DiffScopeResult = { status: 'resolved', resolvedBaseRef: 'abc123', nodeIds: [S.handler.id] };
const API_BLAST: BlastRadiusExpansionResult = { status: 'resolved', hopDistances: { [S.handler.id]: 0, [S.validate.id]: 1 } };

describe('CodeMap: a switch reloads through the full reset (P4-8k: replaces the loadCodeMap reset pins)', () => {
  it('history, Node detail and the Path Trace route of the old map are gone, and a trace still out never lands', BUDGET, async () => {
    const traces: Deferred<PathTraceResult>[] = [];
    codeMapFake({
      tracePath: () => {
        const reply = deferred<PathTraceResult>();
        traces.push(reply);
        return reply.promise;
      },
      logDiagnosticEvent: async () => undefined,
    });
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    // Two clicks on handler → validate: to validate, then back to handler.
    const back = screen.getByRole('button', { name: 'Back' });
    fireEvent.click(await findEdge(S.handler.id, S.validate.id));
    await settleViewport();
    fireEvent.click(await findEdge(S.handler.id, S.validate.id));
    await waitFor(() => assert.equal(back.hasAttribute('disabled'), false, 'a history to go back through'), FIND);
    await settleViewport();
    trace('validate');
    await act(async () => traces[0]!.resolve(foundRoute([S.handler.id, S.validate.id])));
    await waitFor(() => {
      measure();
      assert.deepEqual(routeIds(), [S.handler.id, S.validate.id].sort());
    }, FIND);
    await settleViewport();
    trace('handler');
    await openNodeDetail(S.validate.name);

    rerender(<CodeMap {...props({ section: 'web' })} />);
    await waitForDrawn([S.layout.id, S.render.id]);
    rerender(<CodeMap {...props({ section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    assert.equal(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled'), true, 'no history');
    assert.equal(screen.getByRole('button', { name: 'Forward' }).hasAttribute('disabled'), true);
    assertAbsent(screen.queryByRole('dialog'), 'no Node detail');
    assert.deepEqual(routeIds(), [], 'no route');
    assert.equal(screen.getByRole('button', { name: 'Trace' }).hasAttribute('disabled'), false, 'not searching');
    // The trace sent before the switches answers now, back on its section.
    await act(async () => traces[1]!.resolve(foundRoute([S.handler.id, S.validate.id])));
    await turns();
    act(() => measure());
    assert.deepEqual(routeIds(), [], 'the late route never lands');
  });

  it('PR Review’s base ref, diff, sync time and blast radius go with the old map; late replies land nowhere', BUDGET, async () => {
    const diffs: Deferred<DiffScopeResult>[] = [];
    const blasts: Deferred<BlastRadiusExpansionResult>[] = [];
    const fake = codeMapFake({
      computeDiffScope: () => {
        const reply = deferred<DiffScopeResult>();
        diffs.push(reply);
        return reply.promise;
      },
      expandBlastRadius: () => {
        const reply = deferred<BlastRadiusExpansionResult>();
        blasts.push(reply);
        return reply.promise;
      },
    });
    const synced: [string | null, number | null][] = [];
    const view = (mode: CodeMapProps['mode'], section: string) => (
      <CodeMap {...props({ mode, section, onDiffScopeSynced: (path, at) => synced.push([path, at]) })} />
    );
    const { rerender } = render(view('prReview', 'api'));
    await waitForDrawn([S.handler.id, S.validate.id]);
    await computeDiff();
    await act(async () => diffs[0]!.resolve(API_DIFF));
    await act(async () => blasts[0]!.resolve(API_BLAST));
    await waitFor(() => assert.deepEqual(blastIds(), [S.handler.id, S.validate.id].sort()), FIND);
    assert.equal(synced.at(-1)?.[0], PROJECT);
    assert.equal(typeof synced.at(-1)?.[1], 'number', 'a sync time is held');

    // Out of PR Review (no diff to carry), a switch away and back.
    rerender(view('codeMap', 'api'));
    rerender(view('codeMap', 'web'));
    await waitForDrawn([S.layout.id, S.render.id]);
    rerender(view('codeMap', 'api'));
    await waitForDrawn([S.handler.id, S.validate.id]);
    assert.deepEqual(synced.at(-1), [PROJECT, null], 'the sync time is cleared');
    rerender(view('prReview', 'api'));
    await waitFor(() => assert.equal((screen.getByRole('textbox', { name: 'Base ref' }) as HTMLInputElement).value, ''), FIND);
    assert.ok(screen.getByText(IDLE_PROMPT));
    act(() => measure());
    assert.deepEqual(blastIds(), [], 'no blast radius on the canvas');
    assert.equal(fake.calls.expandBlastRadius.length, 1);

    // A diff and its expansion sent before another switch answer late.
    await computeDiff();
    await act(async () => diffs[1]!.resolve(API_DIFF));
    assert.equal(fake.calls.expandBlastRadius.length, 2);
    rerender(view('codeMap', 'api'));
    rerender(view('codeMap', 'web'));
    await waitForDrawn([S.layout.id, S.render.id]);
    rerender(view('codeMap', 'api'));
    await waitForDrawn([S.handler.id, S.validate.id]);
    rerender(view('prReview', 'api'));
    await act(async () => blasts[1]!.resolve(API_BLAST));
    await turns();
    act(() => measure());
    assert.deepEqual(blastIds(), [], 'the late expansion never lands');
    assert.ok(screen.getByText(IDLE_PROMPT));
  });

  for (const settle of ['resolve', 'reject'] as const) {
    it(`a diff sent before a switch away and back: its late ${settle === 'resolve' ? 'reply' : 'rejection'} changes nothing`, BUDGET, async () => {
      const diffs: Deferred<DiffScopeResult>[] = [];
      const fake = codeMapFake({
        computeDiffScope: () => {
          const reply = deferred<DiffScopeResult>();
          diffs.push(reply);
          return reply.promise;
        },
        expandBlastRadius: async () => API_BLAST,
      });
      const view = (mode: CodeMapProps['mode'], section: string) => <CodeMap {...props({ mode, section })} />;
      const { rerender } = render(view('prReview', 'api'));
      await waitForDrawn([S.handler.id, S.validate.id]);
      await computeDiff();
      rerender(view('codeMap', 'api'));
      rerender(view('codeMap', 'web'));
      await waitForDrawn([S.layout.id, S.render.id]);
      rerender(view('codeMap', 'api'));
      await waitForDrawn([S.handler.id, S.validate.id]);
      rerender(view('prReview', 'api'));
      await act(async () => (settle === 'resolve' ? diffs[0]!.resolve(API_DIFF) : diffs[0]!.reject(new Error('git failed'))));
      await turns();
      assert.ok(screen.getByText(IDLE_PROMPT), `${settle}: still the idle prompt`);
      assertAbsent(screen.queryByRole('alert'), `${settle}: no error`);
      assert.equal(fake.calls.expandBlastRadius.length, 0, `${settle}: no expansion`);
    });
  }
});

describe('CodeMap: an unknown-section map reply (P4-8k: replaces the load and refresh hand-off pins)', () => {
  const GONE: CodeMapResult = { status: 'unknown-section', section: 'echo', knownSections: ['web'] };

  it('a load: the section asked for goes to the fallback once — never the error state', BUDGET, async () => {
    codeMapFake({ getCodeMap: async () => structuredClone(GONE) });
    const gone: string[] = [];
    render(<CodeMap {...props({ section: 'api', onUnknownSection: (name) => gone.push(name) })} />);
    await waitFor(() => assert.deepEqual(gone, ['api']), FIND);
    await turns();
    assert.deepEqual(gone, ['api']);
    assertAbsent(screen.queryByRole('alert'), 'no error notice');
    assertAbsent(screen.queryByRole('button', { name: 'Retry' }), 'screen.queryByRole(button, { name: Retry })');
  });

  it('a load with no fallback wired: the explicit error', BUDGET, async () => {
    codeMapFake({ getCodeMap: async () => structuredClone(GONE) });
    render(<CodeMap {...props({ section: 'api' })} />);
    const alert = await screen.findByRole('alert', {}, FIND);
    assert.match(alert.textContent ?? '', /Couldn.t load the Code Map/);
  });

  it('a refresh (a new data version) asks for the section on screen; gone, it goes to the fallback and keeps the map', BUDGET, async () => {
    let calls = 0;
    const fake = codeMapFake({
      getCodeMap: async (section) => {
        calls += 1;
        return calls === 1 ? sectionedMap(section as SectionName) : structuredClone(GONE);
      },
    });
    const gone: string[] = [];
    const view = (dataVersion: number) => (
      <CodeMap {...props({ section: 'api', dataVersion, onUnknownSection: (name) => gone.push(name) })} />
    );
    const { rerender } = render(view(0));
    await waitForDrawn([S.handler.id, S.validate.id]);
    rerender(view(1));
    await waitFor(() => assert.deepEqual(gone, ['api']), FIND);
    assert.deepEqual(fake.calls.getCodeMap, [['api'], ['api']]);
    await turns();
    assert.deepEqual(gone, ['api']);
    assertAbsent(screen.queryByRole('alert'), 'screen.queryByRole(alert)');
    assertAbsent(screen.queryByText(/Couldn.t refresh/), 'screen.queryByText(/Couldn.t refresh/)');
    assert.deepEqual(drawnNames(), [S.handler.id, S.validate.id].sort(), 'the map stays');
  });
});

describe('CodeMap: a stale refresh reply (P4-8k: replaces the refresh hand-off pin)', () => {
  it('a refresh superseded by a switch: its unknown-section reply calls no fallback', BUDGET, async () => {
    const refresh = deferred<CodeMapResult>();
    let calls = 0;
    codeMapFake({
      getCodeMap: (section) => {
        calls += 1;
        return calls === 2 ? refresh.promise : Promise.resolve(sectionedMap(section as SectionName));
      },
    });
    const gone: string[] = [];
    const view = (section: string, dataVersion: number) => (
      <CodeMap {...props({ section, dataVersion, onUnknownSection: (name) => gone.push(name) })} />
    );
    const { rerender } = render(view('api', 0));
    await waitForDrawn([S.handler.id, S.validate.id]);
    rerender(view('api', 1));
    rerender(view('web', 1));
    await waitForDrawn([S.layout.id, S.render.id]);
    await act(async () => refresh.resolve({ status: 'unknown-section', section: 'api', knownSections: ['web'] }));
    await turns();
    assert.deepEqual(gone, [], 'no fallback for a superseded refresh');
    assert.deepEqual(drawnNames(), [S.layout.id, S.render.id].sort());
  });
});

describe('CodeMap: an expansion sent before a switch away and back (P4-8k: replaces the section-scoped ops pin)', () => {
  it('its rejection says nothing', BUDGET, async () => {
    const blasts: Deferred<BlastRadiusExpansionResult>[] = [];
    codeMapFake({
      computeDiffScope: async () => API_DIFF,
      expandBlastRadius: () => {
        const reply = deferred<BlastRadiusExpansionResult>();
        blasts.push(reply);
        return reply.promise;
      },
    });
    const view = (mode: CodeMapProps['mode'], section: string) => <CodeMap {...props({ mode, section })} />;
    const { rerender } = render(view('prReview', 'api'));
    await waitForDrawn([S.handler.id, S.validate.id]);
    await computeDiff();
    await waitFor(() => assert.equal(blasts.length, 1), FIND);
    rerender(view('codeMap', 'api'));
    rerender(view('codeMap', 'web'));
    await waitForDrawn([S.layout.id, S.render.id]);
    rerender(view('codeMap', 'api'));
    await waitForDrawn([S.handler.id, S.validate.id]);
    rerender(view('prReview', 'api'));
    await act(async () => blasts[0]!.reject(new Error('expansion failed')));
    await turns();
    assertAbsent(screen.queryByText(/expansion failed/), 'no error for the old map’s expansion');
    assert.ok(screen.getByText(IDLE_PROMPT));
  });
});

describe('CodeMap: the map it reports carries the reply’s section and sections (P4-8k: replaces the ready-map pin)', () => {
  it('after a load and after a refresh', BUDGET, async () => {
    const sectionsAt = (docs: number) => [
      { path: 'api', nodeCount: 2 },
      { path: 'web', nodeCount: 2 },
      { path: 'docs', nodeCount: docs },
    ];
    let calls = 0;
    codeMapFake({
      getCodeMap: async () => {
        calls += 1;
        return sectionedMap('api', { sections: sectionsAt(calls === 1 ? 1 : 7) });
      },
    });
    const reports: unknown[] = [];
    const view = (dataVersion: number) => (
      <CodeMap {...props({ section: 'api', dataVersion, onMapState: (_path, state) => reports.push(state) })} />
    );
    const { rerender } = render(view(0));
    const ready = () => reports.filter((state) => (state as { status: string }).status === 'ready') as { section: unknown; sections: unknown }[];
    await waitFor(() => assert.equal(ready().length, 1), FIND);
    assert.equal(ready()[0]!.section, 'api');
    assert.deepEqual(ready()[0]!.sections, sectionsAt(1));
    rerender(view(1));
    await waitFor(() => assert.deepEqual(ready().at(-1)!.sections, sectionsAt(7)), FIND);
    assert.equal(ready().at(-1)!.section, 'api');
  });
});

describe('CodeMap: Path Trace and the diff are sent with the section on screen (P4-8k: replaces the section-scoped ops pin)', () => {
  it('tracePath: the section, or none in all; an unknown-section reply hands that section to the fallback and traces nothing', BUDGET, async () => {
    const fake = codeMapFake({
      tracePath: async (_query, section) =>
        section === 'api' ? { status: 'unknown-section', section: 'echo', knownSections: ['web'] } : foundRoute([S.render.id, S.layout.id]),
      logDiagnosticEvent: async () => undefined,
    });
    const gone: string[] = [];
    const view = (section: string | null) => <CodeMap {...props({ section, onUnknownSection: (name) => gone.push(name) })} />;
    const { rerender } = render(view(null));
    await waitForDrawn([S.handler.id, S.validate.id, S.render.id, S.layout.id]);
    trace('render');
    await waitFor(() => {
      measure();
      assert.deepEqual(routeIds(), [S.layout.id, S.render.id]);
    }, FIND);
    await settleViewport();
    rerender(view('api'));
    await waitForDrawn([S.handler.id, S.validate.id]);
    trace('handler');
    await waitFor(() => assert.deepEqual(gone, ['api']), FIND);
    assert.deepEqual(fake.calls.tracePath, [
      ['render', undefined],
      ['handler', 'api'],
    ]);
    assert.equal(screen.getByRole('button', { name: 'Trace' }).hasAttribute('disabled'), false, 'not left searching');
    assertAbsent(screen.queryByRole('alert'), 'screen.queryByRole(alert)');
    assert.deepEqual(routeIds(), []);
  });

  it('a trace sent before a switch away and back: its rejection says nothing', BUDGET, async () => {
    const traces: Deferred<PathTraceResult>[] = [];
    codeMapFake({
      tracePath: () => {
        const reply = deferred<PathTraceResult>();
        traces.push(reply);
        return reply.promise;
      },
      logDiagnosticEvent: async () => undefined,
    });
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    trace('validate');
    rerender(<CodeMap {...props({ section: 'web' })} />);
    await waitForDrawn([S.layout.id, S.render.id]);
    rerender(<CodeMap {...props({ section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    await act(async () => traces[0]!.reject(new Error('Graph Service down')));
    await turns();
    assertAbsent(screen.queryByText(/Graph Service down/), 'no error for a trace of the old map');
  });

  it('computeDiffScope: the section; an unknown-section reply hands that section to the fallback, with no diff and no sync time', BUDGET, async () => {
    const fake = codeMapFake({
      computeDiffScope: async () => ({ status: 'unknown-section', section: 'echo', knownSections: ['web'] }),
    });
    const gone: string[] = [];
    const synced: [string | null, number | null][] = [];
    render(
      <CodeMap
        {...props({
          mode: 'prReview',
          section: 'api',
          onUnknownSection: (name) => gone.push(name),
          onDiffScopeSynced: (path, at) => synced.push([path, at]),
        })}
      />,
    );
    await waitForDrawn([S.handler.id, S.validate.id]);
    await computeDiff();
    await waitFor(() => assert.deepEqual(gone, ['api']), FIND);
    assert.deepEqual(fake.calls.computeDiffScope, [[PROJECT, 'main', 'api']]);
    assert.ok(screen.getByText(IDLE_PROMPT), 'the diff is idle');
    assert.deepEqual(synced.filter(([, at]) => at !== null), [], 'no sync time');
    assert.equal(fake.calls.expandBlastRadius.length, 0);
  });
});

describe('CodeMap: per-section first fit and empty notice (replaces the sectionBar CodeMap pins)', () => {
  // The fit the canvas owes on opening: the collapsed community view, which
  // is what it draws before anything is expanded.
  function expectedFit(map: CodeMapOk): string {
    const fit = initialViewport({
      nodes: [...fullMapPositions(map, [], 'default')].map(([id, position]) => ({ id, position })),
      cardSize: { width: NODE_CARD_FALLBACK_WIDTH, height: NODE_CARD_FALLBACK_HEIGHT },
      viewport: { width: elementSize.width, height: elementSize.height },
      minReadableZoom: ROUTE_MIN_READABLE_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      lodThreshold: LOD_ZOOM_THRESHOLD,
    });
    assert.ok(fit);
    return `translate(${fit.x}px,${fit.y}px) scale(${fit.zoom})`;
  }

  it('each section’s map gets its own first fit', BUDGET, async () => {
    // `api` has 2 Nodes; `web` 40, which a 2-Node fit would leave off screen.
    const web = syntheticMap({ nodes: 40 });
    const api = sectionedMap('api');
    codeMapFake({
      getCodeMap: async (section) =>
        section === 'web'
          ? { ...web, appliedScope: ['api', 'web'], section: 'web', sections: sectionedMap('web').sections }
          : api,
    });
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    await findCard(S.handler.name);
    await waitFor(() => assert.equal(viewportTransform(), expectedFit(api)), FIND);

    rerender(<CodeMap {...props({ section: 'web' })} />);
    // `includes`, not `startsWith`: in the collapsed community view the drawn
    // cards are the communities, whose ids carry their representative Node's.
    await waitFor(() => assert.ok(drawnNames().some((id) => id.includes('fixture://'))), FIND);
    assert.notEqual(expectedFit(web), expectedFit(api));
    await waitFor(() => assert.equal(viewportTransform(), expectedFit(web)), FIND);
  });

  it('an empty section names the section, never the indexing-scope notice', BUDGET, async () => {
    codeMapFake({ getCodeMap: async () => sectionedMap('api', { nodes: [], edges: [], hiddenByScope: 229 }) });
    render(<CodeMap {...props({ section: 'api' })} />);
    const notice = await screen.findByText('No map Nodes in', { exact: false }, FIND);
    assert.equal(within(notice).getByText('api').tagName, 'CODE');
    assert.doesNotMatch(document.body.textContent ?? '', /indexing scope/);
    assert.equal(screen.queryByRole('button', { name: /Edit indexing scope/ }), null);
  });
});

describe('CodeMap: Regenerate in a section keeps the section’s own Node (replaces the regenerate pin)', () => {
  it('takes the new summary from the whole-scope reply, never its severities — card and panel alike', BUDGET, async () => {
    const onScreen: CodeMapNode = {
      ...S.validate,
      summaryStatus: 'ready',
      summary: 'Checks the request body.',
      riskSignals: [
        { family: 'deterministic', type: 'complexity', value: 4, severity: 'moderate', location: { file: S.validate.file, startLine: 1, endLine: 4 } },
      ],
    };
    const wholeScope: CodeMapNode = {
      ...onScreen,
      summary: 'Validates the request body against the schema.',
      riskSignals: [
        { family: 'deterministic', type: 'complexity', value: 40, severity: 'severe', location: { file: S.validate.file, startLine: 1, endLine: 4 } },
      ],
    };
    const fake = codeMapFake({
      getCodeMap: async () => sectionedMap('api', { nodes: [sectionedMap('api').nodes[0]!, onScreen] }),
      regenerateNode: async () => ({ status: 'ok', node: wholeScope }),
    });
    render(<CodeMap {...props({ section: 'api' })} />);
    await waitForDrawn([S.handler.id, S.validate.id]);
    const card = () => cardOf(S.validate.id)!;
    assert.match(card().textContent ?? '', /Checks the request body\./);

    const detail = await openNodeDetail(S.validate.name);
    fireEvent.click(within(detail).getByRole('button', { name: 'Regenerate' }));
    await within(detail).findByText('Validates the request body against the schema.', { exact: false }, FIND);
    assert.deepEqual(fake.calls.regenerateNode, [[S.validate.id]]);

    assert.match(card().textContent ?? '', /Validates the request body against the schema\./, 'the card has the new summary');
    for (const [where, root] of [
      ['card', card()],
      ['panel', detail],
    ] as const) {
      const html = root.outerHTML;
      assert.doesNotMatch(html, /Complexity: 40|\(severe\)/, `${where}: no whole-scope severity`);
      assert.match(html, /Complexity: 4\b/, `${where}: the section’s own signal`);
    }
  });
});

describe('CodeMap: a Blast Radius expansion whose section is gone (replaces the expansion-effect pin)', () => {
  const CHANGED = { status: 'resolved' as const, resolvedBaseRef: 'abc123', nodeIds: [S.handler.id] };

  async function computeDiffScope(): Promise<void> {
    const input = await screen.findByRole('textbox', { name: 'Base ref' }, FIND);
    // In `act`, so the replies it starts land inside it.
    await act(async () => {
      fireEvent.change(input, { target: { value: 'main' } });
      fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
    });
  }

  it('with the fallback wired: hands the section to it, and the reload into all leaves the expansion idle', BUDGET, async () => {
    const fake = codeMapFake({
      computeDiffScope: async () => CHANGED,
      expandBlastRadius: async () => ({ status: 'unknown-section', section: 'api', knownSections: ['web'] }),
      // The switch to `all` checks whether the diff can be carried there (P4-4h).
      checkDiffScopeCarry: async () => ({ status: 'not-carried' }),
    });
    const gone: string[] = [];
    const view = (section: string | null) => (
      <CodeMap {...props({ mode: 'prReview', section, onUnknownSection: (name) => gone.push(name) })} />
    );
    const { rerender } = render(view('api'));
    await findCard(S.handler.name);
    await computeDiffScope();
    await waitFor(() => assert.deepEqual(gone, ['api']), FIND);
    assert.deepEqual(fake.calls.expandBlastRadius, [[PROJECT, [S.handler.id], 'api']]);

    // App's fallback: the section becomes `all`, which reloads the map.
    rerender(view(null));
    await waitFor(() => assert.deepEqual(fake.calls.getCodeMap.at(-1), [undefined]), FIND);
    await waitForDrawn([S.handler.id, S.validate.id, S.render.id, S.layout.id]);
    assert.equal(screen.queryByText('Computing blast radius…'), null);
    assert.ok(screen.getByText(/Enter a base ref/));
    assert.equal(fake.calls.expandBlastRadius.length, 1, 'no re-send of the gone section');
  });

  it('with no fallback wired: an explicit error naming the section — never left computing', BUDGET, async () => {
    codeMapFake({
      computeDiffScope: async () => CHANGED,
      expandBlastRadius: async () => ({ status: 'unknown-section', section: 'api', knownSections: ['web'] }),
    });
    render(<CodeMap {...props({ mode: 'prReview', section: 'api' })} />);
    await findCard(S.handler.name);
    await computeDiffScope();
    const alert = await screen.findByRole('alert', {}, FIND);
    assert.match(alert.textContent ?? '', /The section "api" is not in this project's included subfolders\.$/);
    assert.equal(screen.queryByText('Computing blast radius…'), null);
  });
});
