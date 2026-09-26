/**
 * FIX-1: fitting a traced route never zooms below the level where Nodes
 * render. `routeFitRequest` turns a route into `routeViewport`'s input (or
 * the unmeasured-viewport fallback), `routeViewport` is the fit-or-clamp
 * decision, `isRouteClamped` ties the clamp flag to the showing trace, and
 * both step panels (`FoundTraceSteps`, `NeighborTraceSteps`) render
 * `RouteExtendsBeyondLine` when clamped.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FoundTraceSteps,
  LOD_ZOOM_THRESHOLD,
  MAX_RENDERED_NEIGHBORS,
  NeighborTraceSteps,
  ROUTE_MIN_READABLE_ZOOM,
  type PathTraceState,
  type RouteFit,
  isRouteClamped,
  quantizeZoomBand,
  routeExtendsBeyondText,
  routeFitRequest,
  routeViewport,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

const EPSILON = 1e-9;
const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < EPSILON, message ?? `expected ${actual} ≈ ${expected}`);

const viewport = { width: 1200, height: 800 };
const floor = ROUTE_MIN_READABLE_ZOOM;
const maxZoom = 2;

describe('ROUTE_MIN_READABLE_ZOOM', () => {
  it('stays at or above the LOD threshold once banded the way the renderer bands zoom', () => {
    assert.ok(quantizeZoomBand(ROUTE_MIN_READABLE_ZOOM, LOD_ZOOM_THRESHOLD) >= LOD_ZOOM_THRESHOLD);
  });
});

describe('routeViewport', () => {
  const fit = (bounds: { x: number; y: number; width: number; height: number }, anchor = { x: 0, y: 0 }) =>
    routeViewport({ bounds, anchor, viewport, minReadableZoom: floor, maxZoom });

  it('compact route: fits to the bounds, centred, unclamped', () => {
    // 2000 x 1000 world units → min(1200/2000, 800/1000) = 0.6.
    const result = fit({ x: 100, y: 200, width: 2000, height: 1000 }, { x: 100, y: 200 });
    assert.equal(result.clamped, false);
    near(result.zoom, 0.6);
    // The bounds' centre (1100, 700) lands on the viewport's centre.
    near(result.x + 1100 * result.zoom, viewport.width / 2);
    near(result.y + 700 * result.zoom, viewport.height / 2);
  });

  it('sprawling route: clamps to the floor and centres on the anchor', () => {
    // min(1200/8000, 800/5000) = 0.15 — the live run measured 0.14.
    const anchor = { x: 520, y: 330 };
    const result = fit({ x: 0, y: 0, width: 8000, height: 5000 }, anchor);
    assert.equal(result.clamped, true);
    near(result.zoom, floor);
    near(result.x + anchor.x * result.zoom, viewport.width / 2);
    near(result.y + anchor.y * result.zoom, viewport.height / 2);
  });

  it('single-Node route: zero-size bounds cap at maxZoom, centred on the Node', () => {
    const result = fit({ x: 40, y: 60, width: 0, height: 0 }, { x: 40, y: 60 });
    assert.equal(result.clamped, false);
    near(result.zoom, maxZoom);
    near(result.x, viewport.width / 2 - 40 * maxZoom);
    near(result.y, viewport.height / 2 - 60 * maxZoom);
  });

  it('caps a small route at maxZoom', () => {
    const result = fit({ x: 0, y: 0, width: 100, height: 100 });
    near(result.zoom, maxZoom);
    assert.equal(result.clamped, false);
  });

  it('neighbour trace spanning the map: clamped, anchored on the origin', () => {
    const origin = { x: 9000, y: 4000 };
    const result = fit({ x: 0, y: 0, width: 12_000, height: 6000 }, origin);
    assert.equal(result.clamped, true);
    near(result.zoom, floor);
    near(result.x, viewport.width / 2 - origin.x * floor);
    near(result.y, viewport.height / 2 - origin.y * floor);
  });

  it('boundary: a fit exactly at the floor is not clamped', () => {
    // 1200 / 4800 = 0.25 exactly; height is looser.
    const result = fit({ x: 0, y: 0, width: 4800, height: 1000 }, { x: 999, y: 999 });
    assert.equal(result.clamped, false);
    near(result.zoom, floor);
    // Centred on the bounds (2400, 500), not the anchor.
    near(result.x, viewport.width / 2 - 2400 * floor);
    near(result.y, viewport.height / 2 - 500 * floor);
  });

  it('boundary: a fit just under the floor clamps', () => {
    const result = fit({ x: 0, y: 0, width: 4801, height: 1000 }, { x: 999, y: 999 });
    assert.equal(result.clamped, true);
    near(result.zoom, floor);
    near(result.x, viewport.width / 2 - 999 * floor);
  });

  it('the tighter axis decides: a tall route clamps even when its width fits', () => {
    assert.equal(fit({ x: 0, y: 0, width: 100, height: 4000 }).clamped, true);
  });

  it('an unusable viewport or bounds gives the safe clamped view on the anchor, never NaN', () => {
    const anchor = { x: 300, y: 120 };
    const cases = [
      { bounds: { x: 0, y: 0, width: 500, height: 500 }, viewport: { width: 0, height: 800 } },
      { bounds: { x: 0, y: 0, width: 500, height: 500 }, viewport: { width: 1200, height: Number.NaN } },
      { bounds: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 500 }, viewport },
      { bounds: { x: Number.NaN, y: 0, width: 500, height: 500 }, viewport },
      { bounds: { x: 0, y: 0, width: -10, height: 500 }, viewport },
    ];
    for (const { bounds, viewport: size } of cases) {
      const result = routeViewport({ bounds, anchor, viewport: size, minReadableZoom: floor, maxZoom });
      assert.equal(result.clamped, true, JSON.stringify({ bounds, size }));
      near(result.zoom, floor);
      for (const value of [result.x, result.y, result.zoom]) {
        assert.ok(Number.isFinite(value), JSON.stringify({ bounds, size, result }));
      }
    }
  });

  it('a floor above maxZoom never pushes the zoom past maxZoom', () => {
    const lowMax = 0.2;
    const sprawling = routeViewport({
      bounds: { x: 0, y: 0, width: 50_000, height: 50_000 },
      anchor: { x: 0, y: 0 },
      viewport,
      minReadableZoom: floor,
      maxZoom: lowMax,
    });
    near(sprawling.zoom, lowMax);
    const compact = routeViewport({
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      anchor: { x: 0, y: 0 },
      viewport,
      minReadableZoom: floor,
      maxZoom: lowMax,
    });
    near(compact.zoom, lowMax);
    assert.equal(compact.clamped, false);
  });
});

describe('routeFitRequest', () => {
  const positions = new Map([
    ['entry', { x: 0, y: 0 }],
    ['mid', { x: 2600, y: 1100 }],
    ['leaf', { x: 5200, y: 2200 }],
  ]);
  const cardSize = { width: 200, height: 80 };

  it('pads the route bounds (grid gap, then fitBounds’ 10%) and anchors on the first card’s centre', () => {
    const request = routeFitRequest(['entry', 'mid', 'leaf'], positions, cardSize, viewport);
    assert.ok(request !== null && 'params' in request);
    const { params } = request;
    // Raw: x -130..5330 (width 5460), y -55..2255 (height 2310); then x1.1.
    near(params.bounds.width, 5460 * 1.1);
    near(params.bounds.height, 2310 * 1.1);
    near(params.bounds.x, -130 - (5460 * 0.1) / 2);
    near(params.bounds.y, -55 - (2310 * 0.1) / 2);
    near(params.anchor.x, 100);
    near(params.anchor.y, 40);
    assert.deepEqual(params.viewport, viewport);
    assert.equal(params.minReadableZoom, ROUTE_MIN_READABLE_ZOOM);
  });

  it('anchors on the first Node of the path, whatever order the positions are in', () => {
    const request = routeFitRequest(['leaf', 'mid', 'entry'], positions, cardSize, viewport);
    assert.ok(request !== null && 'params' in request);
    near(request.params.anchor.x, 5200 + 100);
    near(request.params.anchor.y, 2200 + 40);
  });

  it('an unmeasured container asks for the fitBounds fallback, with unpadded bounds and the same anchor', () => {
    const request = routeFitRequest(['entry', 'mid', 'leaf'], positions, cardSize, { width: 0, height: 0 });
    assert.ok(request !== null && 'fallback' in request);
    assert.deepEqual(request.fallback.bounds, { x: -130, y: -55, width: 5460, height: 2310 });
    assert.deepEqual(request.fallback.anchor, { x: 100, y: 40 });
  });

  it('returns null when no route Node has a position', () => {
    assert.equal(routeFitRequest(['ghost'], positions, cardSize, viewport), null);
  });

  it('a sprawling request through routeViewport clamps with the entry card centred', () => {
    const request = routeFitRequest(['entry', 'mid', 'leaf'], positions, cardSize, viewport);
    assert.ok(request !== null && 'params' in request);
    const result = routeViewport(request.params);
    assert.equal(result.clamped, true);
    near(result.x + 100 * result.zoom, viewport.width / 2);
    near(result.y + 40 * result.zoom, viewport.height / 2);
  });
});

describe('isRouteClamped', () => {
  const path = ['a', 'b'];
  const found: PathTraceState = { status: 'found', path };
  const nodeIds = ['o', 'x'];
  const neighborIds = ['x'];
  const neighbors: PathTraceState = {
    status: 'neighbors',
    originId: 'o',
    direction: 'callees',
    nodeIds,
    neighborIds,
    edgeKeys: ['o→x'],
  };
  const clampedFit = (route: readonly string[]): RouteFit => ({ route, clamped: true });

  it('is true only for the exact fitted array of a found trace', () => {
    assert.equal(isRouteClamped(clampedFit(path), found), true);
    assert.equal(isRouteClamped(clampedFit([...path]), found), false);
  });

  it('is true only for a neighbour trace’s own nodeIds array', () => {
    assert.equal(isRouteClamped(clampedFit(nodeIds), neighbors), true);
    assert.equal(isRouteClamped(clampedFit(neighborIds), neighbors), false);
    assert.equal(isRouteClamped(clampedFit([...nodeIds]), neighbors), false);
  });

  it('is false when unclamped, unset, or no route is showing', () => {
    assert.equal(isRouteClamped({ route: path, clamped: false }, found), false);
    assert.equal(isRouteClamped(null, found), false);
    assert.equal(isRouteClamped(clampedFit(path), { status: 'idle' }), false);
    assert.equal(isRouteClamped(clampedFit(path), { status: 'searching' }), false);
  });
});

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const statusLines = (elements: RenderedElement[]) => elements.filter((element) => element.props.role === 'status');
const TRUNCATED = 'code-map__path-trace-candidates-truncated';

describe('FoundTraceSteps extends-beyond line', () => {
  const render = (routeClamped?: boolean) =>
    renderTree(
      FoundTraceSteps({
        path: ['entry', 'leaf'],
        resolveNode: (id) => ({ name: id, file: undefined }),
        onNavigate: () => {},
        onDismiss: () => {},
        ...(routeClamped === undefined ? {} : { routeClamped }),
      }),
    );

  it('renders one muted status line when the fit clamped', () => {
    const lines = statusLines(render(true));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.props.className, TRUNCATED);
    assert.equal(textOf(lines[0]), routeExtendsBeyondText());
  });

  it('renders no line when the route fits (or the flag is absent)', () => {
    assert.equal(statusLines(render(false)).length, 0);
    assert.equal(statusLines(render()).length, 0);
  });

  it('still lists every step', () => {
    const rows = render(true).filter((element) => element.props.className === 'code-map__path-trace-stack-row');
    assert.equal(rows.length, 2);
  });
});

describe('NeighborTraceSteps extends-beyond line', () => {
  const render = (neighborIds: string[], routeClamped?: boolean) =>
    renderTree(
      NeighborTraceSteps({
        originId: 'o',
        originName: 'quantizeZoomBand',
        direction: 'callers',
        neighborIds,
        resolveNode: (id) => ({ name: id, file: undefined }),
        onNavigate: () => {},
        onDismiss: () => {},
        ...(routeClamped === undefined ? {} : { routeClamped }),
      }),
    );

  it('renders the line when clamped, and none when not', () => {
    const clamped = statusLines(render(['a'], true));
    assert.equal(clamped.length, 1);
    assert.equal(textOf(clamped[0]), routeExtendsBeyondText());
    assert.equal(statusLines(render(['a'], false)).length, 0);
    assert.equal(statusLines(render(['a'])).length, 0);
  });

  it('folds a capped list into the same sentence instead of a second line', () => {
    const total = MAX_RENDERED_NEIGHBORS + 7;
    const ids = Array.from({ length: total }, (_, index) => `n${index}`);
    const elements = render(ids, true);
    const muted = elements.filter((element) => element.props.className === TRUNCATED);
    assert.equal(muted.length, 1);
    assert.equal(
      textOf(muted[0]),
      `The route extends beyond the view — use the steps to follow it (first ${MAX_RENDERED_NEIGHBORS} of ${total} listed).`,
    );
    // Unclamped, the capped list keeps its own truncation line.
    const unclamped = render(ids, false).filter((element) => element.props.className === TRUNCATED);
    assert.equal(unclamped.length, 1);
    assert.match(textOf(unclamped[0]), /^Showing the first /);
  });
});
