/**
 * FIX-7 (live pass 2026-10-11, P4-2f / Path Trace): centring on a Node far
 * from the map origin at a high zoom drew "Cluster of N Nodes" bubbles
 * (even one-Node ones) instead of the Node's card. The live render placed
 * `computeLOD`'s viewport bounds with the banded zoom (`-x / band`) rather
 * than the real one, so the bounds slid off the screen by
 * `distance × (1/band − 1/zoom)`. `liveLODView` is what the render now uses.
 *
 * Maps are laid out with the real `layoutPosition`, viewports are built the
 * way `setCenter` builds them, and the real `computeLOD` decides.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeLOD, type LODInputNode } from '../map/lod';

import { LOD_ZOOM_THRESHOLD, MAP_MAX_ZOOM, layoutPosition, liveLODView, quantizeZoomBand } from './CodeMap';

/** The live pass's canvas, roughly (a 1512-wide window less the chrome). */
const CANVAS = { width: 1512, height: 760 };

function grid(count: number): LODInputNode[] {
  return Array.from({ length: count }, (_, index) => ({ id: `n${index}`, position: layoutPosition(index, count) }));
}

/** React Flow's viewport after `setCenter(x, y, { zoom })`. */
function centredOn(point: { x: number; y: number }, zoom: number, canvas = CANVAS) {
  return { x: canvas.width / 2 - point.x * zoom, y: canvas.height / 2 - point.y * zoom, zoom };
}

function liveFullIds(nodes: LODInputNode[], viewport: { x: number; y: number; zoom: number }, canvas = CANVAS) {
  const { zoomBand, bounds } = liveLODView(viewport, canvas, LOD_ZOOM_THRESHOLD);
  return computeLOD({ nodes, zoom: zoomBand, threshold: LOD_ZOOM_THRESHOLD, viewportBounds: bounds }).fullNodeIds;
}

describe('FIX-7: the live LOD bounds follow the real zoom', () => {
  it('centred at zoom 2 on the far corner of a 1,131-Node map, that Node is drawn as a card, not a cluster', () => {
    const nodes = grid(1_131);
    const target = nodes[nodes.length - 1]!;
    const full = liveFullIds(nodes, centredOn(target.position, MAP_MAX_ZOOM));
    assert.ok(full.has(target.id), `${target.id} at (${target.position.x}, ${target.position.y}) is clustered at zoom 2`);
  });

  it('every Node of the map, centred at any zoom from the readable floor to the ceiling, is drawn as a card', () => {
    const nodes = grid(1_131);
    for (const zoom of [0.2, 0.25, 0.31, 0.5, 0.79, 1, 1.21, 1.6, 1.99, 2]) {
      for (const node of nodes) {
        const full = liveFullIds(nodes, centredOn(node.position, zoom));
        assert.ok(full.has(node.id), `${node.id} at (${node.position.x}, ${node.position.y}) is clustered at zoom ${zoom}`);
      }
    }
  });

  it('the bounds always cover the visible world rectangle, wherever the view is', () => {
    for (const zoom of [0.2, 0.37, 0.4, 1, 1.6, 2]) {
      for (const point of [
        { x: 0, y: 0 },
        { x: 8_000, y: 3_700 },
        { x: -2_500, y: 9_100 },
      ]) {
        const viewport = centredOn(point, zoom);
        const { bounds } = liveLODView(viewport, CANVAS, LOD_ZOOM_THRESHOLD);
        const visible = { x: -viewport.x / zoom, y: -viewport.y / zoom, width: CANVAS.width / zoom, height: CANVAS.height / zoom };
        // `computeLOD` pads by half the bounds on each side; the pan snap moves the origin by at most an eighth.
        const padX = bounds.width / 2;
        const padY = bounds.height / 2;
        const where = `zoom ${zoom} at (${point.x}, ${point.y})`;
        assert.ok(bounds.x - padX <= visible.x, `left edge uncovered, ${where}`);
        assert.ok(bounds.y - padY <= visible.y, `top edge uncovered, ${where}`);
        assert.ok(bounds.x + bounds.width + padX >= visible.x + visible.width, `right edge uncovered, ${where}`);
        assert.ok(bounds.y + bounds.height + padY >= visible.y + visible.height, `bottom edge uncovered, ${where}`);
        // And the centre of the view is inside the unpadded bounds.
        const centre = { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
        assert.ok(centre.x >= bounds.x && centre.x <= bounds.x + bounds.width, `centre x outside the bounds, ${where}`);
        assert.ok(centre.y >= bounds.y && centre.y <= bounds.y + bounds.height, `centre y outside the bounds, ${where}`);
      }
    }
  });

  it('keeps the banded zoom and size (recompute throttling), and zero bounds while unmeasured', () => {
    const live = liveLODView({ x: -100, y: -40, zoom: 1.9 }, CANVAS, LOD_ZOOM_THRESHOLD);
    assert.equal(live.zoomBand, quantizeZoomBand(1.9, LOD_ZOOM_THRESHOLD));
    assert.equal(live.bounds.width, CANVAS.width / live.zoomBand);
    assert.equal(live.bounds.height, CANVAS.height / live.zoomBand);
    assert.deepEqual(liveLODView({ x: -100, y: -40, zoom: 1.9 }, { width: 0, height: 0 }, LOD_ZOOM_THRESHOLD).bounds, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
