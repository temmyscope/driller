/**
 * P4-8c: `CodeMap` mounted in jsdom with a fake `window.driller` — the smoke
 * test that React Flow draws fixture cards and that the first fit is the one
 * the measured container size calls for. `domEnv` must stay the first import
 * (see its header).
 *
 * How the first fit gets its size (observed here, review round 1): React
 * Flow reads its container's `offsetWidth`/`offsetHeight` when it mounts,
 * and `CodeMap`'s `measuredViewportSize` falls back to that store size until
 * its own ResizeObserver reports. So the fit lands at mount, sized by
 * `elementSize`, before any `resizeAll`; a later resize does not re-fit
 * (the first fit is spent). A container measuring 0×0 is fitted to React
 * Flow's own 500×500 placeholder instead — recorded in the spec's review
 * round 1, not asserted here.
 */
import './test/domEnv';
import { cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { act, render, screen, waitFor } from '@testing-library/react';
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
import type { MapFooterState } from './appFrame';
import { createFakeDrillerApi, type FakeDrillerApi } from './test/fakeDrillerApi';
import { fullMapPositions, FIXTURE_NODES, FIXTURE_PROJECT_PATH, pathTraceBasicMap, syntheticMap, type CodeMapOk } from './test/mapFixture';

afterEach(cleanupAfterEach);

/** Spec P4-8c: each smoke mount under 2 s; doubled under CI (P4-8b's convention). */
const MOUNT_BUDGET_MS = 2_000 * (env.CI === 'true' ? 2 : 1);
/** `findBy…`/`waitFor` wait this long at most — the fake settles at once. */
// `[2026-10-25]` Scaled for CI like the test budget beside it. A flat inner
// budget gave every `waitFor` half the allowance, relative to machine speed,
// that the test around it got — see `4a1c48b` and status.md's row on it.
const FIND = { timeout: 1_000 * (env.CI === 'true' ? 2 : 1) };

function mapFake(map: () => CodeMapOk = pathTraceBasicMap): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    getCodeMap: async () => map(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
  });
  fake.install();
  return fake;
}

function renderCodeMap(onMapState: CodeMapProps['onMapState'] = () => {}) {
  const noop = () => {};
  return render(
    <CodeMap
      projectPath={FIXTURE_PROJECT_PATH}
      noSummaryBackendAvailable={false}
      cloudSelectedNoKey={false}
      mode="codeMap"
      onRequestCodeMapMode={noop}
      graphServiceAvailable
      dataVersion={0}
      onMapState={onMapState}
      onDiffScopeSynced={noop}
      onOpenSettings={noop}
      onReindex={async () => true}
      onSwitchSection={noop}
    />,
  );
}

/** The React Flow node wrapper a card's text sits in, if any. */
function flowNodeOf(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>('.react-flow__node');
}

/** The fit `CodeMap` owes a container of `width`×`height` for `map`, laid out as Full lays it out. */
function expectedFirstFit(map: CodeMapOk, width: number, height: number): string {
  const fit = initialViewport({
    nodes: [...fullMapPositions(map)].map(([id, position]) => ({ id, position })),
    cardSize: { width: NODE_CARD_FALLBACK_WIDTH, height: NODE_CARD_FALLBACK_HEIGHT },
    viewport: { width, height },
    minReadableZoom: ROUTE_MIN_READABLE_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    lodThreshold: LOD_ZOOM_THRESHOLD,
  });
  assert.ok(fit);
  return `translate(${fit.x}px,${fit.y}px) scale(${fit.zoom})`;
}

function viewportTransform(): string | undefined {
  return document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
}

describe('CodeMap (DOM smoke)', () => {
  it('mounts the fixture to a drawn card and reports a ready map with the fixture’s Node count', { timeout: MOUNT_BUDGET_MS }, async () => {
    const fake = mapFake();
    const reports: { projectPath: string | null; state: MapFooterState }[] = [];
    renderCodeMap((projectPath, state) => reports.push({ projectPath, state }));

    const name = await screen.findByText(FIXTURE_NODES.handleRequest.name, { selector: '.react-flow__node *' }, FIND);
    const card = flowNodeOf(name);
    assert.ok(card?.isConnected, 'the name is inside a mounted React Flow Node');
    const canvas = card.closest<HTMLElement>('.react-flow');
    assert.ok(canvas);

    const fixture = pathTraceBasicMap();
    // The first fit is the one a 1200×800 container calls for — not React
    // Flow's 500×500 placeholder, and not the unfitted identity.
    const fitted = expectedFirstFit(fixture, elementSize.width, elementSize.height);
    assert.notEqual(fitted, expectedFirstFit(fixture, 500, 500));
    await waitFor(() => assert.equal(viewportTransform(), fitted), FIND);
    assert.notEqual(canvas.style.visibility, 'hidden', 'the canvas is shown once fitted');

    const ready = reports.filter((report) => report.state.status === 'ready');
    assert.ok(ready.length > 0, 'onMapState received a ready state');
    const last = ready.at(-1)!;
    assert.equal(last.projectPath, FIXTURE_PROJECT_PATH);
    assert.equal(last.state.status === 'ready' && last.state.nodes, fixture.nodes.length);
    assert.equal(last.state.status === 'ready' && last.state.edges, fixture.edges.length);
    assert.deepEqual(fake.calls.getCodeMap, [[undefined]], 'one whole-scope fetch');
  });

  it('fits a smaller container to its own size, and a later resize does not re-fit', { timeout: MOUNT_BUDGET_MS }, async () => {
    mapFake();
    elementSize.set(600, 400);
    renderCodeMap();
    await screen.findByText(FIXTURE_NODES.handleRequest.name, { selector: '.react-flow__node *' }, FIND);
    const fitted = expectedFirstFit(pathTraceBasicMap(), 600, 400);
    await waitFor(() => assert.equal(viewportTransform(), fitted), FIND);

    // `CodeMap`'s canvas and map frames, React Flow's container and its Node
    // cards each observe; `resizeAll` reports the new size to all of them.
    assert.ok(resizeObservers.liveCount >= 3, `${resizeObservers.liveCount} live ResizeObservers`);
    await act(async () => {
      resizeObservers.resizeAll(1200, 800);
    });
    assert.equal(viewportTransform(), fitted, 'the first fit is spent: a resize keeps the view');
  });

  it('remounts cleanly: one canvas and one handleRequest card, nothing left from the earlier test', { timeout: MOUNT_BUDGET_MS }, async () => {
    mapFake();
    renderCodeMap();

    // `findByText` fails on more than one match: a tree left mounted by the
    // previous test would show a second `handleRequest`.
    const name = await screen.findByText(FIXTURE_NODES.handleRequest.name, { selector: '.react-flow__node *' }, FIND);
    assert.ok(flowNodeOf(name)?.isConnected);
    assert.equal(document.querySelectorAll('.react-flow').length, 1);
  });

  it('mounts a 300-Node synthetic map and reports all of it, drawing only what React Flow culls in', { timeout: MOUNT_BUDGET_MS }, async () => {
    const map = syntheticMap({ nodes: 300 });
    mapFake(() => map);
    const reports: MapFooterState[] = [];
    renderCodeMap((_projectPath, state) => reports.push(state));

    await waitFor(() => assert.ok(document.querySelector('.react-flow__node')), FIND);
    const last = reports.filter((state) => state.status === 'ready').at(-1);
    assert.equal(last?.status === 'ready' && last.nodes, 300);
    const drawn = document.querySelectorAll('.react-flow__node').length;
    assert.ok(drawn > 0 && drawn < 300, `${drawn} cards drawn of 300`);
  });
});
