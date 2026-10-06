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
import type { CodeMapNode, CodeMapResult } from '@driller/ipc-contracts';
import {
  CARD_FOCUS_MAX_FRAMES,
  CodeMap,
  CROSS_SECTION_MISS_TEXT_ID,
  initialViewport,
  layoutPosition,
  LOD_ZOOM_THRESHOLD,
  MAP_MAX_ZOOM,
  NODE_CARD_FALLBACK_HEIGHT,
  NODE_CARD_FALLBACK_WIDTH,
  NOT_ON_CURRENT_MAP,
  ROUTE_MIN_READABLE_ZOOM,
  type CodeMapProps,
} from './CodeMap';
import { createFakeDrillerApi, deferred, type Deferred, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import { SECTION_NODES, sectionedMap, syntheticMap, type CodeMapOk, type SectionName } from './test/mapFixture';

// `cleanupAfterEach` also lets a viewport animation still running finish (bounded) before the unmount.
afterEach(cleanupAfterEach);

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
    await waitFor(() => assert.ok(drawnNames().length > 0 && drawnNames().every((id) => id.startsWith('fixture://'))), FIND);
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

describe('CodeMap: per-section first fit and empty notice (replaces the sectionBar CodeMap pins)', () => {
  function expectedFit(nodeCount: number): string {
    const fit = initialViewport({
      nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: String(index), position: layoutPosition(index, nodeCount) })),
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
    codeMapFake({
      getCodeMap: async (section) =>
        section === 'web'
          ? { ...web, appliedScope: ['api', 'web'], section: 'web', sections: sectionedMap('web').sections }
          : sectionedMap('api'),
    });
    const { rerender } = render(<CodeMap {...props({ section: 'api' })} />);
    await findCard(S.handler.name);
    await waitFor(() => assert.equal(viewportTransform(), expectedFit(2)), FIND);

    rerender(<CodeMap {...props({ section: 'web' })} />);
    await waitFor(() => assert.ok(drawnNames().some((id) => id.startsWith('fixture://'))), FIND);
    assert.notEqual(expectedFit(40), expectedFit(2));
    await waitFor(() => assert.equal(viewportTransform(), expectedFit(40)), FIND);
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
