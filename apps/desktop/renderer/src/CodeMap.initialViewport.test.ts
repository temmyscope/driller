/**
 * FIX-3: a project's map first opens at a readable zoom. `initialViewport`
 * is the whole-map fit when that is readable, else the readable floor
 * centred on `densestCluster` of the clustering the whole-map fit would have
 * shown — both through FIX-1's `routeViewport`. `initialFitDecision` and the
 * `armInitialFit`/`completeInitialFit` bookkeeping gate when it runs.
 *
 * Maps are laid out with the real `layoutPosition` and the real card-size
 * and spacing constants, so these tests move with the layout.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeLOD, type Cluster, type LODInputNode } from '../map/lod';

import {
  INITIAL_FIT_STATE,
  LOD_ZOOM_THRESHOLD,
  MAP_MAX_ZOOM,
  NODE_CARD_FALLBACK_HEIGHT,
  NODE_CARD_FALLBACK_WIDTH,
  NODE_COLUMN_GAP,
  NODE_ROW_GAP,
  ROUTE_MIN_READABLE_ZOOM,
  armInitialFit,
  completeInitialFit,
  densestCluster,
  initialFitDecision,
  initialViewport,
  layoutPosition,
  quantizeZoomBand,
  type InitialFitDecisionInput,
} from './CodeMap';

const EPSILON = 1e-9;
const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < EPSILON, message ?? `expected ${actual} ≈ ${expected}`);

const CARD = { width: NODE_CARD_FALLBACK_WIDTH, height: NODE_CARD_FALLBACK_HEIGHT };
/** Roughly the 2026-09-26 live run's map area in a 1100×688 window. */
const VIEW = { width: 1100, height: 560 };

/** `count` Nodes laid out exactly as `layoutNodes` lays them out. */
function grid(count: number, prefix = 'n'): LODInputNode[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, position: layoutPosition(index, count) }));
}

function fit(
  nodes: readonly LODInputNode[],
  viewport = VIEW,
  { minReadableZoom = ROUTE_MIN_READABLE_ZOOM, maxZoom = MAP_MAX_ZOOM } = {},
) {
  return initialViewport({ nodes, cardSize: CARD, viewport, minReadableZoom, maxZoom, lodThreshold: LOD_ZOOM_THRESHOLD });
}

/** The world point at the centre of the view. */
function viewCentre(result: { x: number; y: number; zoom: number }, viewport = VIEW) {
  return { x: (viewport.width / 2 - result.x) / result.zoom, y: (viewport.height / 2 - result.y) / result.zoom };
}

/** Full Node cards the live render would show at `result` — `computeLOD` at its banded zoom, over what's on screen. */
function cardsInView(nodes: LODInputNode[], result: { x: number; y: number; zoom: number }, viewport = VIEW): string[] {
  const band = quantizeZoomBand(result.zoom, LOD_ZOOM_THRESHOLD);
  const visible = {
    x: -result.x / result.zoom,
    y: -result.y / result.zoom,
    width: viewport.width / result.zoom,
    height: viewport.height / result.zoom,
  };
  const { fullNodeIds } = computeLOD({
    nodes,
    zoom: band,
    threshold: LOD_ZOOM_THRESHOLD,
    viewportBounds: { x: -result.x / band, y: -result.y / band, width: viewport.width / band, height: viewport.height / band },
  });
  return nodes
    .filter((node) => fullNodeIds.has(node.id))
    .filter(
      (node) =>
        node.position.x + CARD.width > visible.x &&
        node.position.x < visible.x + visible.width &&
        node.position.y + CARD.height > visible.y &&
        node.position.y < visible.y + visible.height,
    )
    .map((node) => node.id);
}

function cluster(id: string, size: number, x = 0, y = 0): Cluster {
  return { id, nodeIds: Array.from({ length: size }, (_, index) => `${id}-${index}`), position: { x, y } };
}

describe('layout constants the fit relies on', () => {
  it('layoutPosition puts cards on the NODE_COLUMN_GAP × NODE_ROW_GAP grid', () => {
    assert.deepEqual(layoutPosition(0, 9), { x: 0, y: 0 });
    assert.deepEqual(layoutPosition(4, 9), { x: NODE_COLUMN_GAP, y: NODE_ROW_GAP });
    assert.deepEqual(layoutPosition(8, 9), { x: 2 * NODE_COLUMN_GAP, y: 2 * NODE_ROW_GAP });
  });

  // `initialViewport` anchors on `cluster.position + card / 2`. That is the
  // centre of the average card only if `Cluster.position` is the centroid of
  // the members' TOP-LEFT positions (not of their centres) — pinned here
  // against the real `computeLOD`.
  it('Cluster.position is the centroid of its members’ top-left positions', () => {
    const members: LODInputNode[] = [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 40, y: 0 } },
      { id: 'c', position: { x: 20, y: 30 } },
    ];
    const { clusters } = computeLOD({
      nodes: members,
      zoom: 0.01,
      threshold: LOD_ZOOM_THRESHOLD,
      viewportBounds: { x: 0, y: 0, width: 100, height: 100 },
    });
    assert.equal(clusters.length, 1);
    near(clusters[0]!.position.x, 20);
    near(clusters[0]!.position.y, 10);
  });
});

describe('densestCluster (FIX-3)', () => {
  it('picks the cluster standing in for the most Nodes', () => {
    const big = cluster('b', 9);
    assert.equal(densestCluster([cluster('a', 3), big, cluster('c', 8)]), big);
    assert.equal(densestCluster([big, cluster('a', 3)]), big);
  });

  it('breaks a tie on the smaller id, whatever the input order', () => {
    const a = cluster('a', 5);
    const b = cluster('b', 5);
    assert.equal(densestCluster([a, b]), a);
    assert.equal(densestCluster([b, a]), a);
  });

  it('is null with no clusters', () => {
    assert.equal(densestCluster([]), null);
  });
});

describe('initialViewport (FIX-3)', () => {
  it('fits a small map whole, centred, when that is readable', () => {
    const result = fit(grid(9));
    assert.ok(result);
    assert.equal(result.clamped, false);
    const width = 2 * NODE_COLUMN_GAP + CARD.width;
    const height = 2 * NODE_ROW_GAP + CARD.height;
    const centre = viewCentre(result);
    near(centre.x, width / 2);
    near(centre.y, height / 2);
    // fitView's 10% padding on the card footprint.
    near(result.zoom, Math.min(MAP_MAX_ZOOM, VIEW.width / (1.1 * width), VIEW.height / (1.1 * height)));
  });

  it("pads a height-bound map by fitView's 10% too", () => {
    const column = Array.from({ length: 4 }, (_, index) => ({ id: `c${index}`, position: { x: 0, y: index * NODE_ROW_GAP } }));
    const result = fit(column);
    assert.ok(result);
    assert.equal(result.clamped, false);
    near(result.zoom, VIEW.height / (1.1 * (3 * NODE_ROW_GAP + CARD.height)));
    near(viewCentre(result).y, (3 * NODE_ROW_GAP + CARD.height) / 2);
  });

  it('caps a one-Node map at maxZoom', () => {
    const result = fit(grid(1));
    assert.ok(result);
    assert.equal(result.clamped, false);
    assert.equal(result.zoom, MAP_MAX_ZOOM);
  });

  it('opens a ~1,000-Node map at the readable floor with its dense region, as real cards, on screen', () => {
    // 900 Nodes on the real layout grid, plus 114 packed into one known
    // rectangle near the grid's lower right — the region the first view
    // should land in. Independent of how the clustering is computed.
    const spread = grid(900, 's');
    const region = { x: 6000, y: 2600, width: 300, height: 120 };
    const packed = Array.from({ length: 114 }, (_, index) => ({
      id: `p${index}`,
      position: { x: region.x + (index % 19) * 15, y: region.y + Math.floor(index / 19) * 20 },
    }));
    const nodes = [...spread, ...packed];
    const result = fit(nodes);
    assert.ok(result);
    assert.equal(result.clamped, true);
    assert.ok(result.zoom >= ROUTE_MIN_READABLE_ZOOM);
    // The whole packed region is on screen (the anchor is the centroid of
    // the coarse whole-map cluster containing it, so it lands near the region
    // rather than exactly on it), and so are real cards from it.
    const left = -result.x / result.zoom;
    const top = -result.y / result.zoom;
    assert.ok(
      region.x >= left &&
        region.x + region.width + CARD.width <= left + VIEW.width / result.zoom &&
        region.y >= top &&
        region.y + region.height + CARD.height <= top + VIEW.height / result.zoom,
      JSON.stringify({ left, top, zoom: result.zoom }),
    );
    const cards = cardsInView(nodes, result);
    assert.ok(cards.some((id) => id.startsWith('p')), `${cards.length} cards in view`);
  });

  it('opens the uniform 1,014-Node map at the floor with real cards on screen', () => {
    const nodes = grid(1014);
    const result = fit(nodes);
    assert.ok(result);
    assert.equal(result.clamped, true);
    assert.equal(result.zoom, ROUTE_MIN_READABLE_ZOOM);
    assert.ok(cardsInView(nodes, result).length >= 1);
  });

  it('centres on the densest region, not on the map centre', () => {
    // 40 Nodes loosely spread over the left, 60 packed tightly far right.
    const sparse = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, position: { x: index * 500, y: 0 } }));
    const dense = grid(60, 'd').map((node) => ({
      ...node,
      position: { x: node.position.x / 4 + 100_000, y: node.position.y / 4 },
    }));
    const result = fit([...sparse, ...dense]);
    assert.ok(result);
    assert.equal(result.clamped, true);
    const centre = viewCentre(result);
    // Inside the packed block, nowhere near the map centre (~50,000).
    assert.ok(centre.x > 100_000 && centre.x < 100_000 + 7 * NODE_COLUMN_GAP, JSON.stringify(centre));
  });

  it('anchors on the centre of the densest cluster’s average card', () => {
    // Two lone Nodes (each a cluster of one, rendered full, so not a
    // cluster) and ten stacked at one point: the only cluster is the stack,
    // its position is that point, and the view centres half a card from it.
    const stack = { x: 100_000, y: 0 };
    const nodes: LODInputNode[] = [
      { id: 'lone-a', position: { x: 0, y: 0 } },
      { id: 'lone-b', position: { x: 50_000, y: 0 } },
      ...Array.from({ length: 10 }, (_, index) => ({ id: `stack${index}`, position: { ...stack } })),
    ];
    const result = fit(nodes);
    assert.ok(result);
    assert.equal(result.clamped, true);
    const centre = viewCentre(result);
    near(centre.x, stack.x + CARD.width / 2);
    near(centre.y, stack.y + CARD.height / 2);
  });

  it('never opens below the readable floor, whatever the map size or window', () => {
    for (const count of [1, 2, 10, 100, 500, 1014, 3000, 10_000]) {
      for (const viewport of [VIEW, { width: 550, height: 300 }, { width: 2400, height: 1400 }]) {
        const result = fit(grid(count), viewport);
        assert.ok(result);
        assert.ok(result.zoom >= ROUTE_MIN_READABLE_ZOOM, `${count} Nodes in ${viewport.width}px: ${result.zoom}`);
        assert.ok([result.x, result.y, result.zoom].every(Number.isFinite));
      }
    }
  });

  it('never exceeds a maxZoom below the readable floor', () => {
    for (const count of [1, 9, 1014]) {
      const result = fit(grid(count), VIEW, { minReadableZoom: 0.25, maxZoom: 0.2 });
      assert.ok(result);
      assert.ok(result.zoom <= 0.2 + EPSILON, `${count}: ${result.zoom}`);
      assert.ok([result.x, result.y, result.zoom].every(Number.isFinite));
    }
    // A large map clamps to that cap exactly.
    near(fit(grid(1014), VIEW, { minReadableZoom: 0.25, maxZoom: 0.2 })!.zoom, 0.2);
  });

  it('waits (null) with nothing to fit or an unmeasured container', () => {
    assert.equal(fit([]), null);
    assert.equal(fit(grid(5), { width: 0, height: 0 }), null);
    assert.equal(fit(grid(5), { width: 800, height: Number.NaN }), null);
  });
});

describe('initialFitDecision (FIX-3)', () => {
  const ready: InitialFitDecisionInput = {
    pending: true,
    instanceReady: true,
    projectPath: '/repo/app',
    fittedProjectPath: null,
    nodesCount: 1014,
    size: VIEW,
  };

  it('fits once everything it needs is there', () => {
    assert.equal(initialFitDecision(ready), 'fit');
  });

  it('waits for the instance, the laid-out map and a measured size', () => {
    assert.equal(initialFitDecision({ ...ready, instanceReady: false }), 'wait');
    assert.equal(initialFitDecision({ ...ready, nodesCount: 0 }), 'wait');
    assert.equal(initialFitDecision({ ...ready, size: { width: 0, height: 0 } }), 'wait');
    assert.equal(initialFitDecision({ ...ready, size: { width: 800, height: Number.NaN } }), 'wait');
  });

  it('is done once the fit is spent, for the same project', () => {
    const spent = completeInitialFit('/repo/app');
    assert.equal(initialFitDecision({ ...ready, ...spent }), 'done');
  });

  it('re-arms on a project change, and on a new canvas mount', () => {
    const spent = completeInitialFit('/repo/app');
    assert.equal(initialFitDecision({ ...ready, ...spent, projectPath: '/repo/other' }), 'fit');
    assert.equal(initialFitDecision({ ...ready, ...armInitialFit(spent) }), 'fit');
  });

  it('starts unarmed until a canvas mounts', () => {
    assert.equal(initialFitDecision({ ...ready, ...INITIAL_FIT_STATE, projectPath: null }), 'done');
    assert.deepEqual(armInitialFit(INITIAL_FIT_STATE), { pending: true, fittedProjectPath: null });
  });
});
