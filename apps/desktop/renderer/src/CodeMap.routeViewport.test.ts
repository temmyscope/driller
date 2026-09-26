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
  type CallTreeInput,
  type FoundPathTrace,
  callTreeOrder,
  isRouteClamped,
  quantizeZoomBand,
  routeExtendsBeyondText,
  routeFitRequest,
  routeViewport,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

/** The trace props `FoundTraceSteps` takes — the same `FoundPathTrace` fields the component's own props use. */
type FoundTrace = Pick<FoundPathTrace, 'path' | 'parents' | 'depths'>;

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
  const found: PathTraceState = { status: 'found', path, parents: { a: null, b: 'a' }, depths: { a: 0, b: 1 } };
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
        parents: { entry: null, leaf: 'entry' },
        depths: { entry: 0, leaf: 1 },
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

// FIX-2: the step list renders the call tree in depth-first order.
describe('FoundTraceSteps call tree', () => {
  const INDENT = 'code-map__path-trace-indent';
  const CALLER = 'code-map__path-trace-stack-row-caller';
  const ROW = 'code-map__path-trace-stack-row';
  const NAME = 'code-map__path-trace-stack-row-name';

  const render = (trace: FoundTrace) =>
    renderTree(
      FoundTraceSteps({
        ...trace,
        resolveNode: (id) => ({ name: `fn_${id}`, file: undefined }),
        onNavigate: () => {},
        onDismiss: () => {},
      }),
    );

  /** Per row, in document order: its name, indent px (0 = no connector), and "called by" note ('' = none). */
  const rowsOf = (trace: FoundTrace) =>
    render(trace)
      .filter((element) => element.props.className === ROW)
      .map((row) => {
        const inner = renderTree(row.props.children);
        const indent = inner.find((element) => element.props.className === INDENT);
        const caller = inner.find((element) => element.props.className === CALLER);
        return {
          name: textOf(inner.find((element) => element.props.className === NAME)),
          indent: indent ? Number.parseInt(String((indent.props.style as { marginLeft: string }).marginLeft), 10) : 0,
          calledBy: caller ? textOf(caller) : '',
        };
      });

  const SIBLINGS: FoundTrace = {
    // E calls A and B; A calls C → BFS path [E, A, B, C].
    path: ['E', 'A', 'B', 'C'],
    parents: { E: null, A: 'E', B: 'E', C: 'A' },
    depths: { E: 0, A: 1, B: 1, C: 2 },
  };

  it('renders rows in depth-first tree order: C under A, B back at A’s level naming its caller', () => {
    assert.deepEqual(rowsOf(SIBLINGS), [
      { name: 'fn_E', indent: 0, calledBy: '' },
      { name: 'fn_A', indent: 8, calledBy: '' },
      { name: 'fn_C', indent: 16, calledBy: '' },
      // B follows C but is called by E: same indent as A, caller named.
      { name: 'fn_B', indent: 8, calledBy: 'called by fn_E' },
    ]);
  });

  it('nests the lists so B is not inside A’s subtree', () => {
    const elements = render(SIBLINGS);
    const itemNames = (li: RenderedElement) =>
      renderTree(li.props.children)
        .filter((element) => element.props.className === NAME)
        .map((element) => textOf(element));
    const items = elements.filter((element) => element.type === 'li');
    const byFirstName = new Map(items.map((li) => [itemNames(li)[0], itemNames(li)]));
    assert.deepEqual(byFirstName.get('fn_E'), ['fn_E', 'fn_A', 'fn_C', 'fn_B']);
    assert.deepEqual(byFirstName.get('fn_A'), ['fn_A', 'fn_C']);
    assert.deepEqual(byFirstName.get('fn_B'), ['fn_B']);
  });

  it('has no hop numbers and labels the region "Call tree"', () => {
    const elements = render(SIBLINGS);
    assert.equal(elements.filter((element) => element.props.className === 'code-map__path-trace-hop-circle').length, 0);
    const region = elements.find((element) => element.props.role === 'region');
    assert.equal(region?.props['aria-label'], 'Call tree');
  });

  it('renders a linear chain as a descending chain with no caller notes', () => {
    assert.deepEqual(
      rowsOf({ path: ['E', 'A', 'B'], parents: { E: null, A: 'E', B: 'A' }, depths: { E: 0, A: 1, B: 2 } }),
      [
        { name: 'fn_E', indent: 0, calledBy: '' },
        { name: 'fn_A', indent: 8, calledBy: '' },
        { name: 'fn_B', indent: 16, calledBy: '' },
      ],
    );
  });

  it('renders a leaf entry as a single unindented row', () => {
    assert.deepEqual(rowsOf({ path: ['E'], parents: { E: null }, depths: { E: 0 } }), [
      { name: 'fn_E', indent: 0, calledBy: '' },
    ]);
  });

  it('caps the indent at 64px and names the caller on every row from depth 8', () => {
    const ids = Array.from({ length: 11 }, (_, index) => `n${index}`);
    const rows = rowsOf(chain(ids));
    assert.deepEqual(
      rows.map((row) => row.indent),
      [0, 8, 16, 24, 32, 40, 48, 56, 64, 64, 64],
    );
    assert.deepEqual(
      rows.map((row) => row.calledBy),
      ['', '', '', '', '', '', '', '', 'called by fn_n7', 'called by fn_n8', 'called by fn_n9'],
    );
  });
});

/** A linear chain ids[0] → ids[1] → … as a found trace. */
function chain(ids: string[]): FoundTrace {
  const parents: Record<string, string | null> = {};
  const depths: Record<string, number> = {};
  ids.forEach((id, index) => {
    parents[id] = index === 0 ? null : ids[index - 1]!;
    depths[id] = index;
  });
  return { path: ids, parents, depths };
}

describe('callTreeOrder', () => {
  const rows = (input: CallTreeInput) => callTreeOrder(input).map(({ id, depth, calledBy }) => ({ id, depth, calledBy }));

  /** Runs `fn` with console.warn captured; returns the warnings. */
  function warningsDuring(fn: () => void): string[] {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  it('orders depth-first, children by sorted id, not BFS', () => {
    assert.deepEqual(
      rows({
        path: ['E', 'A', 'B', 'C'],
        parents: { E: null, A: 'E', B: 'E', C: 'A' },
        depths: { E: 0, A: 1, B: 1, C: 2 },
      }),
      [
        { id: 'E', depth: 0, calledBy: null },
        { id: 'A', depth: 1, calledBy: null },
        { id: 'C', depth: 2, calledBy: null },
        { id: 'B', depth: 1, calledBy: 'E' },
      ],
    );
  });

  it('sorts children by id even when path lists them otherwise', () => {
    assert.deepEqual(
      rows({ path: ['E', 'b', 'a'], parents: { E: null, b: 'E', a: 'E' }, depths: { E: 0, b: 1, a: 1 } }).map((r) => r.id),
      ['E', 'a', 'b'],
    );
  });

  it('accepts the engine’s null-prototype records', () => {
    const parents = Object.assign(Object.create(null) as Record<string, string | null>, { E: null, A: 'E' });
    const depths = Object.assign(Object.create(null) as Record<string, number>, { E: 0, A: 1 });
    assert.deepEqual(rows({ path: ['E', 'A'], parents, depths }), [
      { id: 'E', depth: 0, calledBy: null },
      { id: 'A', depth: 1, calledBy: null },
    ]);
  });

  it('missing parents: a flat list in path order, no caller notes, logged once', () => {
    const input = { path: ['E', 'A', 'B'], depths: { E: 0, A: 1, B: 1 } };
    let result: ReturnType<typeof rows> = [];
    const warnings = warningsDuring(() => {
      result = rows(input);
      rows(input);
    });
    assert.deepEqual(result, [
      { id: 'E', depth: 0, calledBy: null },
      { id: 'A', depth: 0, calledBy: null },
      { id: 'B', depth: 0, calledBy: null },
    ]);
    assert.equal(warnings.length, 1);
  });

  it('missing depths: derived as the parent’s depth + 1, logged once', () => {
    const input = { path: ['E', 'A', 'B', 'C'], parents: { E: null, A: 'E', B: 'E', C: 'A' } };
    let result: ReturnType<typeof rows> = [];
    const warnings = warningsDuring(() => {
      result = rows(input);
      rows(input);
    });
    assert.deepEqual(
      result.map((row) => [row.id, row.depth]),
      [
        ['E', 0],
        ['A', 1],
        ['C', 2],
        ['B', 1],
      ],
    );
    assert.equal(warnings.length, 1);
  });

  it('a depth that disagrees with the parent chain is re-derived, never trusted', () => {
    const warnings = warningsDuring(() => {
      assert.deepEqual(
        rows({ path: ['E', 'A'], parents: { E: null, A: 'E' }, depths: { E: 0, A: 5 } }).map((row) => row.depth),
        [0, 1],
      );
    });
    assert.equal(warnings.length, 1);
  });

  it('a self-parent or a parent outside path makes that Node a root', () => {
    const warnings = warningsDuring(() => {
      assert.deepEqual(
        rows({
          path: ['E', 'A', 'B'],
          parents: { E: null, A: 'A', B: 'ghost' },
          depths: { E: 0, A: 1, B: 1 },
        }),
        [
          { id: 'E', depth: 0, calledBy: null },
          { id: 'A', depth: 0, calledBy: null },
          { id: 'B', depth: 0, calledBy: null },
        ],
      );
    });
    assert.ok(warnings.length >= 1);
  });

  it('a parent cycle unreachable from the entry still renders every Node once', () => {
    warningsDuring(() => {
      const result = rows({ path: ['E', 'A', 'B'], parents: { E: null, A: 'B', B: 'A' }, depths: { E: 0, A: 1, B: 1 } });
      assert.deepEqual(result.map((row) => row.id).sort(), ['A', 'B', 'E']);
      assert.equal(result[0]!.id, 'E');
    });
  });

  it('FoundTraceSteps renders a found state missing parents/depths without throwing', () => {
    warningsDuring(() => {
      const elements = renderTree(
        FoundTraceSteps({
          ...({ path: ['E', 'A'] } as unknown as FoundTrace),
          resolveNode: (id) => ({ name: id, file: undefined }),
          onNavigate: () => {},
          onDismiss: () => {},
        }),
      );
      assert.equal(elements.filter((element) => element.props.className === 'code-map__path-trace-stack-row').length, 2);
    });
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
