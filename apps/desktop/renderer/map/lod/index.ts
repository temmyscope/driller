/**
 * Shared LOD (level-of-detail) / clustering module (Story 1.3 Phase 2, AD-2).
 *
 * This is the ONE exported interface for the mechanism — reused unmodified
 * by every later mode that renders the map at scale (Health Audit, PR
 * Review, per epic-1-context.md's Cross-Story Dependencies). Nothing about
 * per-mode visual treatment (heatmaps, blast-radius overlays) lives here —
 * only culling + cluster/expand over a Node-ID set and viewport bounds.
 *
 * Clustering is deliberately spatial, not graph-structural (Never, this
 * spec's Boundaries & Constraints): Nodes are grid-bucketed by their
 * already-computed layout position (Phase 1's `layoutNodes` in
 * `CodeMap.tsx`), with grid cell size scaling inversely with zoom so
 * on-screen proximity — not any CALLS/IMPORTS/USAGE relationship — decides
 * which Nodes group together. No graph traversal, no semantic/community
 * grouping.
 *
 * A `Cluster` is a renderer-local aggregate over real Node IDs. It never
 * gets an identifier that flows into any Graph Service call (AD-2) — a
 * cluster's `id` exists only to key it in the renderer (e.g. React's `key`,
 * or tracking which clusters a user has expanded); resolving a cluster
 * always means reading its `nodeIds` back out, client-side, before any
 * lookup/query.
 *
 * `viewportBounds` (this spec's own frozen Boundaries & Constraints: the
 * interface takes "a Node-ID set + viewport bounds") is not optional
 * decoration — it's what keeps "full" rendering scoped to what the user is
 * actually looking at. Review finding: an earlier revision computed
 * `fullNodeIds` from `zoom`/`threshold` alone, with no viewport awareness.
 * That meant crossing the zoom threshold — via an ordinary mouse-wheel zoom,
 * or via a single cluster-expand zoom-in — promoted the ENTIRE Node set to
 * "full" in one step, regardless of how much of it was ever going to be on
 * screen: the exact "full Node set MUST NOT render as live rich DOM
 * simultaneously at any zoom level" violation this module exists to
 * prevent, reachable through completely normal interaction. Every bucket is
 * now gated on whether any of its Nodes fall within a (margin-padded)
 * `viewportBounds` — a bucket entirely outside that area always stays
 * clustered/culled, no matter how high `zoom` climbs.
 */

export interface LODPosition {
  x: number;
  y: number;
}

/** The minimal shape `computeLOD` needs from an already laid-out Node. */
export interface LODInputNode {
  id: string;
  position: LODPosition;
}

export interface Cluster {
  /**
   * Renderer-local key only (React `key`, expand-state tracking) — derived
   * from grid-cell coordinates, so it MUST NOT be sent to the Graph Service.
   */
  id: string;
  /** The real, constituent Node IDs this cluster stands in for. */
  nodeIds: string[];
  /** Centroid of the constituent Nodes' layout positions, for placing the cluster's own card. */
  position: LODPosition;
}

/** A world-space (same coordinate space as `LODInputNode.position`) axis-aligned rectangle. */
export interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputeLODParams {
  nodes: LODInputNode[];
  /** Current viewport zoom (e.g. from `@xyflow/react`'s `useViewport`/`onMove`). */
  zoom: number;
  /** Zoom level at/above which an in-viewport Node renders full-size, unclustered. */
  threshold: number;
  /**
   * The world-space rectangle currently on screen. Only Nodes within (or
   * near — see `VIEWPORT_MARGIN_RATIO`) this rectangle are ever eligible for
   * full rendering; everything else stays clustered/culled regardless of
   * `zoom`.
   */
  viewportBounds: ViewportBounds;
}

export interface ComputeLODResult {
  /** Node IDs that should render as full, live rich Node components. */
  fullNodeIds: Set<string>;
  /** Spatial clusters standing in for the remaining Nodes below `threshold`. */
  clusters: Cluster[];
}

/**
 * World-space grid-cell size at `zoom === 1`. Chosen relative to
 * `CodeMap.tsx`'s own layout grid (`NODE_COLUMN_GAP`/`NODE_ROW_GAP`, 260x110)
 * so that, once zoomed out enough to cross `threshold`, a cell spans a
 * small neighborhood of Nodes rather than either a single Node or the
 * entire map.
 */
const BASE_CELL_SIZE = 400;

/**
 * Overscan applied to `viewportBounds` before testing bucket membership:
 * padded by this fraction of the viewport's own width/height on every side.
 * Existing purpose: avoids Nodes popping between representations right at
 * the visible edge during a pan. It also means a bucket doesn't need to be
 * pixel-perfectly on screen to count as "in view" — a reasonable, bounded
 * margin, never the whole dataset.
 */
const VIEWPORT_MARGIN_RATIO = 0.5;

function padBounds(bounds: ViewportBounds, ratio: number): ViewportBounds {
  const marginX = bounds.width * ratio;
  const marginY = bounds.height * ratio;
  return {
    x: bounds.x - marginX,
    y: bounds.y - marginY,
    width: bounds.width + marginX * 2,
    height: bounds.height + marginY * 2,
  };
}

function isInsideBounds(position: LODPosition, bounds: ViewportBounds): boolean {
  return (
    position.x >= bounds.x &&
    position.x <= bounds.x + bounds.width &&
    position.y >= bounds.y &&
    position.y <= bounds.y + bounds.height
  );
}

/**
 * Computes which Nodes render full-size versus which spatial clusters stand
 * in for the rest, at the given zoom and viewport. No graph traversal, no
 * semantic grouping (Never) — purely a grid bucketing of `nodes`' layout
 * positions, gated by on-screen relevance.
 *
 * Every Node is grid-bucketed by position (cell size scales inversely with
 * `zoom`, same as before). A bucket is only ever eligible to render full
 * when at least one of its Nodes falls within the padded `viewportBounds`
 * AND either `zoom >= threshold` or the bucket has exactly one member (the
 * "cluster of one" case — an isolated Node renders full regardless of
 * `zoom`, so it never flips representation purely from being alone in its
 * cell). A bucket that fails either check — including every bucket zoom
 * would otherwise have promoted in full, if it's nowhere near the
 * viewport — becomes a `Cluster` over all its members, centered on their
 * positions' centroid. This is what keeps "the full Node set MUST NOT
 * render as live rich DOM simultaneously at any zoom level" (AD-2) true
 * even when `zoom` alone would suggest otherwise.
 */
export function computeLOD({ nodes, zoom, threshold, viewportBounds }: ComputeLODParams): ComputeLODResult {
  if (nodes.length === 0) {
    return { fullNodeIds: new Set(), clusters: [] };
  }

  const padded = padBounds(viewportBounds, VIEWPORT_MARGIN_RATIO);

  // Cell size scales inversely with zoom: further zoomed out (smaller zoom)
  // means more world-space is visible per screen pixel, so cells must cover
  // more world-space to keep grouping Nodes that are close together
  // on-screen. Guard against zoom <= 0 (shouldn't happen in practice, but
  // would otherwise divide by zero / produce a negative cell size).
  const cellSize = BASE_CELL_SIZE / Math.max(zoom, 0.001);

  const buckets = new Map<string, LODInputNode[]>();
  for (const node of nodes) {
    const cellX = Math.floor(node.position.x / cellSize);
    const cellY = Math.floor(node.position.y / cellSize);
    const key = `${cellX}:${cellY}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      buckets.set(key, [node]);
    }
  }

  const fullNodeIds = new Set<string>();
  const clusters: Cluster[] = [];
  for (const [key, bucketNodes] of buckets) {
    const bucketInView = bucketNodes.some((node) => isInsideBounds(node.position, padded));
    const [singleton] = bucketNodes;
    const isSingleton = bucketNodes.length === 1 && singleton !== undefined;
    const eligibleForFull = bucketInView && (zoom >= threshold || isSingleton);

    if (eligibleForFull) {
      for (const node of bucketNodes) {
        fullNodeIds.add(node.id);
      }
      continue;
    }

    let sumX = 0;
    let sumY = 0;
    for (const node of bucketNodes) {
      sumX += node.position.x;
      sumY += node.position.y;
    }
    clusters.push({
      id: `cluster:${key}`,
      nodeIds: bucketNodes.map((node) => node.id),
      position: { x: sumX / bucketNodes.length, y: sumY / bucketNodes.length },
    });
  }

  return { fullNodeIds, clusters };
}
