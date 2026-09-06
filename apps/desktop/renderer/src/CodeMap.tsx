/**
 * The Code Map (Story 1.3): `@xyflow/react`'s `<ReactFlow>` over the real
 * Node/edge data fetched via `window.driller.getCodeMap()` (AD-3).
 *
 * Phase 1 shipped no LOD/clustering (fine at this repo's real scale, ~200
 * nodes, live-verified). Phase 2 (this revision) wires in the shared LOD
 * module from `apps/desktop/renderer/map/lod/` (AD-2): below
 * `LOD_ZOOM_THRESHOLD`, Nodes below the spatial-grid clustering threshold
 * render as lightweight cluster cards instead of live rich Node components;
 * `onlyRenderVisibleElements` adds `@xyflow/react`'s own viewport culling.
 * A dev-only synthetic fixture (`devFixture.ts`, `?fixtureNodes=N`) is how
 * this was validated at 10,000-Node scale (epics AC) without a shipped
 * feature or new IPC surface. Every Node still shows only its identifier,
 * verbatim and monospace (Always) — no summary/signal-strip content
 * (Stories 1.5-1.9). Never a BI/analytics-dashboard treatment (UX-DR3): no
 * stat tiles, no data-viz divorced from the map's own structure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeMouseHandler,
  type NodeProps,
  type OnMove,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CodeMapEdge, CodeMapNode } from '@driller/ipc-contracts';
import { computeLOD, type Cluster } from '../map/lod';

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; nodes: CodeMapNode[]; edges: CodeMapEdge[] }
  | { status: 'error'; message: string };

type SourceViewState =
  | { status: 'closed' }
  | { status: 'loading'; node: CodeMapNode }
  | { status: 'open'; node: CodeMapNode; content: string }
  | { status: 'error'; node: CodeMapNode; message: string };

// No LOD/layout library yet (Design Notes: acceptable at this phase's real
// scale) — a plain deterministic grid, roughly square, is enough to lay the
// full fetched Node set out without overlap.
const NODE_COLUMN_GAP = 260;
const NODE_ROW_GAP = 110;

// `@xyflow/react`'s own default `minZoom` is 0.5 — found, via this story's
// live CDP verification, to silently clamp `fitView`'s computed zoom for
// EVERY map size (a 10,000-Node fixture's natural fit zoom is ~0.05, but it
// rendered at 0.5 anyway), which would have made `LOD_ZOOM_THRESHOLD` below
// unreachable through any normal pan/zoom/fitView interaction — clustering
// could never activate. Only the dev fixture needs to zoom out this far
// (review finding: an unconditionally low `minZoom` also lets an ordinary
// user on a real, small repo zoom out far enough that every Node/cluster
// becomes minuscule and hard to click) — real usage gets a much higher
// floor (`MIN_ZOOM_REAL`); only `?fixtureNodes=N` dev sessions get
// `MIN_ZOOM_FIXTURE`, low enough that a much-larger-than-10,000-Node map
// still has real headroom below `LOD_ZOOM_THRESHOLD`.
const MIN_ZOOM_FIXTURE = 0.02;
const MIN_ZOOM_REAL = 0.1;

// Zoom (as `@xyflow/react` reports it — 1 = 100%) at/above which an
// in-viewport Node renders full-size, unclustered, matching Phase 1 exactly
// (I/O Matrix: "Below cluster threshold ... Renders exactly as Phase 1
// did"). Live-verified via CDP against this component's own `layoutNodes`
// grid: this repo's real ~155-Node map's `fitView` lands at zoom ≈0.29
// (comfortably above), while the 10,000-Node dev fixture's much larger
// footprint lands at zoom ≈0.04 (comfortably below) — see this spec's
// Verification section for the exact measured values. `computeLOD` also
// gates full rendering on `viewportBounds` (review finding — see
// `map/lod/index.ts`'s doc comment): crossing this threshold only promotes
// Nodes actually on screen, never the whole dataset at once.
const LOD_ZOOM_THRESHOLD = 0.2;

// A single spatial-grid cell can cover an enormous share of the map at
// extreme zoom-out (live CDP verification found a single cluster holding
// ~5,200 of a 10,000-Node fixture at `MIN_ZOOM_FIXTURE`) — fully dissolving
// a cluster that large into live rich Node cards on one click would itself
// violate AD-2's "the full Node set MUST NOT render as live rich DOM
// simultaneously at any zoom level". Above this cap, a click zooms in on
// the cluster instead (still purely a viewport change, still no Graph
// Service call) so `computeLOD` re-buckets it into smaller sub-clusters at
// the next zoom level — the user drills down click by click rather than
// getting a one-shot Node dump. At/below the cap, a click still fully
// dissolves the cluster into its real constituent Nodes as before. Set to
// Phase 1's own live-verified full-rich-DOM scale (this repo's real map,
// ~120-200 Nodes) — never show more Nodes live at once than that was
// already proven fine at.
const CLUSTER_EXPAND_MAX = 200;

// The dev-fixture's fixed edge-fanout (Code Map: `generateSyntheticCodeMap
// (nodeCount, edgeFanout)`) — only `nodeCount` is exposed via the
// `?fixtureNodes=N` URL param; a constant fanout is enough to exercise edge
// rendering at scale without a second dev-only URL param to maintain.
const DEV_FIXTURE_EDGE_FANOUT = 3;

// Upper bound on the dev-only `?fixtureNodes=N` URL param (review finding —
// unbounded input risks a renderer hang generating/laying out an absurdly
// large synthetic fixture). 50,000 is comfortably above the 10,000-Node
// target scale this story validates against, with headroom to stress-test
// further without opening the door to an arbitrarily large value.
const FIXTURE_NODE_COUNT_MAX = 50_000;

// `computeLOD` recomputation is throttled to coarser "bands" rather than
// running on every `onMove` animation-frame delta (review finding: the
// previous hundredths-of-zoom rounding still recomputed constantly during a
// smooth gesture, churning cluster `id`s — which are derived from grid-cell
// coordinates computed from zoom — fast enough to make expand-state feel
// like it "silently collapses on minor zoom jitter," and to let
// `expandedClusterIds` accumulate unboundedly over a session). Zoom bands
// are geometric (powers of 2) and anchored exactly on `LOD_ZOOM_THRESHOLD`,
// so the threshold itself is always a band edge — the "at/above threshold"
// decision in `computeLOD` is never blurred by banding. Pan is quantized
// separately, as a fraction of the current (banded) viewport size, so
// dragging less than a quarter-viewport doesn't trigger a recompute either.
function quantizeZoomBand(zoom: number, threshold: number): number {
  const safeZoom = Math.max(zoom, 1e-6);
  const power = Math.floor(Math.log2(safeZoom / threshold));
  return threshold * 2 ** power;
}

const PAN_QUANTIZE_RATIO = 0.25;

// Defensive cap on `expandedClusterIds` (review finding, defense in depth
// on top of `quantizeZoomBand` reducing churn): even with far fewer
// recomputations, a very long session could still accumulate orphaned
// cluster ids (a cluster's `id` is band/position-derived, so an old one
// never gets removed once its band/position is no longer current). Evicts
// the oldest entry (`Set` preserves insertion order) once the cap is hit,
// rather than growing without bound.
const MAX_EXPANDED_CLUSTER_IDS = 500;

/**
 * Dev-only synthetic-fixture gate (Always: `import.meta.env.DEV`-gated, a
 * renderer-local URL param — no new IPC surface, no production code path
 * change). `readFixtureNodeCount` always returns `undefined` outside dev,
 * but that alone does NOT keep `devFixture.ts` out of a production bundle —
 * confirmed by building one and finding its code present regardless (review
 * finding). `devFixture.ts` is only ever imported dynamically, directly
 * behind a literal `import.meta.env.DEV` check at the one call site
 * (`loadCodeMap`) — see that comment for why the literal check there is
 * what actually lets the bundler drop the module.
 *
 * The raw string must be a clean, unsigned integer (review finding: loose
 * parsing like `Number.parseInt` alone accepts `"10000abc"` and has no
 * upper bound, risking a renderer hang generating/laying out an absurdly
 * large fixture) — anything else is treated the same as the param being
 * absent. The parsed value is capped at `FIXTURE_NODE_COUNT_MAX`.
 */
function readFixtureNodeCount(): number | undefined {
  if (!import.meta.env.DEV) {
    return undefined;
  }
  const raw = new URLSearchParams(window.location.search).get('fixtureNodes');
  if (raw === null || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(parsed, FIXTURE_NODE_COUNT_MAX);
}

// `onActivate` is threaded through node `data` (rather than relied on only
// via `<ReactFlow>`'s own `onNodeClick`) so the custom Node card's keyboard
// handler (Enter/Space, review finding — see `CodeMapNodeCard`) can trigger
// the exact same one-click-to-source path a mouse click does, sharing one
// implementation instead of two.
type CodeMapFlowNode = FlowNode<{ node: CodeMapNode; onActivate: (node: CodeMapNode) => void }, 'codeMapNode'>;

function layoutNodes(
  nodes: CodeMapNode[],
  onActivate: (node: CodeMapNode) => void,
): CodeMapFlowNode[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  return nodes.map((node, index) => ({
    id: node.id,
    type: 'codeMapNode',
    position: {
      x: (index % columns) * NODE_COLUMN_GAP,
      y: Math.floor(index / columns) * NODE_ROW_GAP,
    },
    data: { node, onActivate },
  }));
}

function toFlowEdges(edges: CodeMapEdge[]): FlowEdge[] {
  return edges.map((edge, index) => ({
    // Cypher output has no inherent edge identity; (source, target, kind)
    // can repeat if the graph has parallel edges, so the row index keeps
    // ids unique without needing to de-duplicate/merge them.
    id: `${edge.source}→${edge.target}:${edge.kind}:${index}`,
    source: edge.source,
    target: edge.target,
    label: edge.kind,
    className: `code-map__edge code-map__edge--${edge.kind.toLowerCase()}`,
  }));
}

/**
 * The custom Node component: identifier verbatim, monospace — nothing else
 * (Always). `tabIndex`/`role="button"`/`onKeyDown` give one-click-to-source
 * a keyboard path (Enter/Space) alongside the mouse click `<ReactFlow>`'s
 * own `onNodeClick` already handles — the product's stated Accessibility
 * Floor requires map traversal to have one, and this was mouse-only before
 * (review finding).
 *
 * No editing surface (Non-Goal): a bare Handle would otherwise render as a
 * live, draggable connection point, implying an editing capability that
 * doesn't exist (review finding). Hidden via CSS (`.code-map__node
 * .react-flow__handle` in styles.css — `opacity: 0; pointer-events: none;`)
 * rather than React Flow's own `isConnectable`/`nodesConnectable` props:
 * live-tested both, and each one, combined with this custom Node type,
 * broke `@xyflow/react`'s node-measurement pipeline outright on this
 * installed version (12.11.6) — every Node silently stayed
 * `visibility: hidden` and no edges ever rendered, with no console error.
 * The Handle still needs to exist and be positioned for React Flow's own
 * edge-anchoring math (an edge's path is computed from its Handles'
 * positions) — only its visibility/interactivity is suppressed, not its
 * presence.
 */
function CodeMapNodeCard({ data }: NodeProps<CodeMapFlowNode>) {
  const { node, onActivate } = data;
  return (
    <div
      className="code-map__node"
      title={`${node.file}:${node.startLine}-${node.endLine}`}
      tabIndex={0}
      role="button"
      aria-label={`${node.kind} ${node.name}, open source`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(node);
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="code-map__node-kind">{node.kind}</span>
      <code className="code-map__node-id">{node.name}</code>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/**
 * The lightweight cluster card (AD-2's "below the zoom/proximity threshold,
 * Nodes render as lightweight cluster representations"). Carries no
 * per-Node content — just how many real Nodes it stands in for — since a
 * cluster is a renderer-local spatial aggregate, not a Node in its own
 * right (Boundaries & Constraints: it MUST NOT get an identifier that flows
 * into any Graph Service call). Clicking or activating it expands it
 * client-side (`onExpand`) — never a Graph Service call.
 *
 * A cluster over `CLUSTER_EXPAND_MAX` Nodes zooms in instead of expanding
 * (see `expandCluster`) — the `--zoom` modifier and "zoom in" label give
 * that a visible cue (review finding: otherwise a click just moves the
 * camera with no explanation of why this one behaved differently from
 * every other cluster).
 */
type CodeMapClusterFlowNode = FlowNode<{ cluster: Cluster; onExpand: (cluster: Cluster) => void }, 'codeMapCluster'>;

function CodeMapClusterCard({ data }: NodeProps<CodeMapClusterFlowNode>) {
  const { cluster, onExpand } = data;
  const willZoomInsteadOfExpand = cluster.nodeIds.length > CLUSTER_EXPAND_MAX;
  return (
    <div
      className={`code-map__cluster${willZoomInsteadOfExpand ? ' code-map__cluster--zoom' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={
        willZoomInsteadOfExpand
          ? `Cluster of ${cluster.nodeIds.length} nodes, too many to expand — zoom in`
          : `Cluster of ${cluster.nodeIds.length} nodes, expand`
      }
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onExpand(cluster);
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="code-map__cluster-count">{cluster.nodeIds.length}</span>
      <span className="code-map__cluster-label">{willZoomInsteadOfExpand ? 'zoom in' : 'nodes'}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type CodeMapAnyFlowNode = CodeMapFlowNode | CodeMapClusterFlowNode;

const nodeTypes = { codeMapNode: CodeMapNodeCard, codeMapCluster: CodeMapClusterCard };

/**
 * Dev-only frame-timing/selection-latency instrumentation (Code Map's
 * "Profiling methodology" — a CDP harness reads these off `window` while
 * driving synthetic pan/zoom/selection against the `?fixtureNodes=10000`
 * fixture). Only ever populated when `isDevFixtureMode` is true (see
 * `readFixtureNodeCount`) — never touched in a production build or normal
 * (non-fixture) dev use.
 *
 * `frameDeltas` is a fixed-size ring buffer, not a growing array (review
 * finding: trimming a growing array with `Array.prototype.shift()` once at
 * cap is an O(n) shift on every single subsequent frame forever —
 * self-interfering with the very frame-timing measurement it collects).
 * `frameDeltaCount` is how many of `frameDeltas`' `MAX_RECORDED_FRAME_DELTAS`
 * slots hold real data (caps at that length once the buffer has wrapped) —
 * a consumer reading this for aggregate stats (avg/percentile fps) can just
 * take `frameDeltas.slice(0, frameDeltaCount)` as an unordered sample set;
 * chronological order was never meaningful for that kind of aggregate.
 */
interface DrillerDevPerfWindow {
  __drillerPerf?: {
    frameDeltas: number[];
    frameDeltaWriteIndex: number;
    frameDeltaCount: number;
    selectionToDetailMs: number[];
  };
}

const MAX_RECORDED_FRAME_DELTAS = 1200;

function getDevPerfState(): NonNullable<DrillerDevPerfWindow['__drillerPerf']> {
  const perfWindow = window as unknown as DrillerDevPerfWindow;
  if (!perfWindow.__drillerPerf) {
    perfWindow.__drillerPerf = {
      frameDeltas: new Array<number>(MAX_RECORDED_FRAME_DELTAS).fill(0),
      frameDeltaWriteIndex: 0,
      frameDeltaCount: 0,
      selectionToDetailMs: [],
    };
  }
  return perfWindow.__drillerPerf;
}

/** O(1) ring-buffer write — see `DrillerDevPerfWindow`'s doc comment. */
function recordFrameDelta(perf: NonNullable<DrillerDevPerfWindow['__drillerPerf']>, delta: number): void {
  perf.frameDeltas[perf.frameDeltaWriteIndex] = delta;
  perf.frameDeltaWriteIndex = (perf.frameDeltaWriteIndex + 1) % MAX_RECORDED_FRAME_DELTAS;
  perf.frameDeltaCount = Math.min(perf.frameDeltaCount + 1, MAX_RECORDED_FRAME_DELTAS);
}

export function CodeMap() {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });
  const [sourceView, setSourceView] = useState<SourceViewState>({ status: 'closed' });
  // Correlates a `readSourceRange` response back to the click that started
  // it (review finding — the same concurrency/correlation bug class as
  // Story 1.2's indexing-status races): clicking Node A then quickly Node B
  // before A's response lands must never let A's stale response overwrite
  // `sourceView` after the user has already moved on to B. Incremented on
  // every activation; a response is only applied if it's still the latest.
  const sourceRequestIdRef = useRef(0);

  // Dev-only synthetic-fixture node count (Always: `import.meta.env.DEV`
  // plus `?fixtureNodes=N`) — read once per mount; the URL doesn't change
  // without a reload, so there is nothing to react to.
  const [fixtureNodeCount] = useState(() => readFixtureNodeCount());
  const isDevFixtureMode = fixtureNodeCount !== undefined;

  // Current viewport {x, y, zoom}, driving `computeLOD` — seeded from
  // `onInit`/`getViewport()` and kept live via `onMove` (see the `<ReactFlow>`
  // props below). Not read directly from `useViewport()`: that hook only
  // works in a component rendered *inside* `<ReactFlow>`'s own tree, and
  // this component is the one declaring `<ReactFlow>`, not a descendant of
  // it. `x`/`y` are needed (not just `zoom`) to derive `viewportBounds` for
  // `computeLOD` — see the `lodResult` memo below (review finding: the
  // interface's own frozen Boundaries already call for viewport bounds, not
  // zoom alone).
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  // The `<ReactFlow>` container's own pixel size (via `ResizeObserver` below)
  // — the other half of translating `viewport` into world-space bounds.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  // Clusters the user has clicked/activated to expand (Boundaries &
  // Constraints: "Clicking a cluster removes it from the cluster set for
  // this render"). A cluster's `id` is derived from its current
  // zoom-band/grid-cell coordinates (see `map/lod/index.ts` and
  // `quantizeZoomBand`), which shift whenever the zoom band or pan position
  // changes enough — so this naturally trims on a real zoom-level change
  // rather than needing an explicit reset effect. `MAX_EXPANDED_CLUSTER_IDS`
  // is a defensive cap on top of that (review finding).
  const [expandedClusterIds, setExpandedClusterIds] = useState<Set<string>>(() => new Set());
  // Set from `onInit`; used only to zoom in on an over-`CLUSTER_EXPAND_MAX`
  // cluster (a viewport change, never a data/Graph-Service operation).
  const reactFlowInstanceRef = useRef<ReactFlowInstance<CodeMapAnyFlowNode> | null>(null);

  // Dev-only selection-to-detail timing (Code Map's "Profiling methodology"):
  // set right before a click/activation opens the source view, read back out
  // once `sourceView` actually reaches `'open'` (see the effect below).
  const selectionStartRef = useRef<number | null>(null);

  const loadCodeMap = useCallback(() => {
    setFetchState({ status: 'loading' });
    if (import.meta.env.DEV && fixtureNodeCount !== undefined) {
      // Dynamic import, gated directly on the statically-known
      // `import.meta.env.DEV` — not just the runtime-derived
      // `fixtureNodeCount` (review finding: a static top-level import of
      // `devFixture.ts`, even only ever *called* behind a runtime check,
      // still shipped in a real production build regardless — confirmed by
      // grepping a production bundle for `devFixture.ts`'s own
      // `fixture://`/`fixtures/module-*` string literals and finding them
      // present. Gating the dynamic `import()` call itself on the literal
      // `import.meta.env.DEV` lets the bundler constant-fold this whole
      // branch to unreachable in a production build and drop the module).
      import('./devFixture')
        .then(({ generateSyntheticCodeMap }) => {
          const synthetic = generateSyntheticCodeMap(fixtureNodeCount, DEV_FIXTURE_EDGE_FANOUT);
          setFetchState({ status: 'ready', nodes: synthetic.nodes, edges: synthetic.edges });
        })
        .catch((error: unknown) => {
          setFetchState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    window.driller
      .getCodeMap()
      .then((result) => {
        if (result.status === 'ok') {
          setFetchState({ status: 'ready', nodes: result.nodes, edges: result.edges });
        } else {
          setFetchState({ status: 'error', message: result.message });
        }
      })
      .catch((error: unknown) => {
        // NFR4: no silent failure — a rejected IPC call surfaces the same
        // explicit error/retry state as a reported `{status: 'error'}`.
        setFetchState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [fixtureNodeCount]);

  useEffect(() => {
    loadCodeMap();
  }, [loadCodeMap]);

  const openSourceForNode = useCallback((node: CodeMapNode) => {
    const requestId = ++sourceRequestIdRef.current;
    setSourceView({ status: 'loading', node });
    window.driller
      .readSourceRange(node.file, node.startLine, node.endLine)
      .then((result) => {
        if (sourceRequestIdRef.current !== requestId) {
          // Superseded by a later click — this response is stale, discard
          // rather than let it clobber whatever the user is now looking at.
          return;
        }
        if (result.status === 'ok') {
          setSourceView({ status: 'open', node, content: result.content });
        } else {
          setSourceView({ status: 'error', node, message: result.message });
        }
      })
      .catch((error: unknown) => {
        if (sourceRequestIdRef.current !== requestId) {
          return;
        }
        setSourceView({
          status: 'error',
          node,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  // Wraps `openSourceForNode` to start the dev-only selection-to-detail
  // timer right at the click/activation, before the (async) source read —
  // this is the "around the click handler" measurement point the Code
  // Map's Profiling methodology calls for.
  const activateNode = useCallback(
    (node: CodeMapNode) => {
      if (isDevFixtureMode) {
        selectionStartRef.current = performance.now();
      }
      openSourceForNode(node);
    },
    [openSourceForNode, isDevFixtureMode],
  );

  const expandCluster = useCallback((cluster: Cluster) => {
    if (cluster.nodeIds.length > CLUSTER_EXPAND_MAX) {
      // Too many real Nodes to ever dissolve into live rich DOM at once
      // (AD-2) — zoom in on the cluster instead (a viewport change only,
      // still no Graph Service call) so `computeLOD` re-buckets it into
      // smaller sub-clusters at the next zoom level; the user drills down
      // click by click. See `CLUSTER_EXPAND_MAX`'s comment for how this was
      // found (a single cluster held ~5,200 of 10,000 fixture Nodes).
      const instance = reactFlowInstanceRef.current;
      if (instance) {
        const currentZoom = instance.getViewport().zoom;
        const desiredZoom = Math.max(currentZoom * 4, 0.1);
        // Defense in depth on top of `computeLOD`'s own `viewportBounds`
        // gating (review finding): this escape-hatch zoom-in must never
        // itself reach/cross `LOD_ZOOM_THRESHOLD` in one step — live-found
        // at 0.05 × 4 = 0.2, exactly at threshold, for the very
        // ~5,200-Node cluster this whole guard exists for. Capped at
        // halfway across the *remaining gap* to the threshold, not a fixed
        // ceiling (review-fix-of-a-review-fix, live-found in the same
        // verification pass): an earlier version of this clamp capped every
        // step at the same absolute value regardless of `currentZoom`,
        // which meant a cluster still over `CLUSTER_EXPAND_MAX` right at
        // that ceiling could never make further progress — every
        // subsequent click landed on the exact same zoom, permanently
        // stuck just below threshold. Halving the remaining gap guarantees
        // real forward progress on every click while still never reaching
        // threshold in one step; after a few clicks the gap is small enough
        // that one ordinary (unclamped) scroll-zoom closes it.
        const halfwayToThreshold = currentZoom + (LOD_ZOOM_THRESHOLD - currentZoom) * 0.5;
        const nextZoom = Math.min(desiredZoom, halfwayToThreshold, 2);
        instance.setCenter(cluster.position.x, cluster.position.y, {
          zoom: nextZoom,
          duration: 300,
        });
      }
      return;
    }
    // Client-side expand only (Boundaries & Constraints) — a cluster's own
    // `id` never reaches this call or anything downstream of it; only its
    // presence in this Set is used, to decide whether to render its real
    // constituent Nodes instead of the cluster card.
    setExpandedClusterIds((previous) => {
      const next = new Set(previous);
      next.add(cluster.id);
      // Defensive cap (review finding) — see `MAX_EXPANDED_CLUSTER_IDS`'s
      // comment. `Set` preserves insertion order, so the first value really
      // is the oldest.
      while (next.size > MAX_EXPANDED_CLUSTER_IDS) {
        const oldest = next.values().next().value;
        if (oldest === undefined) {
          break;
        }
        next.delete(oldest);
      }
      return next;
    });
  }, []);

  const handleInit = useCallback((instance: ReactFlowInstance<CodeMapAnyFlowNode>) => {
    reactFlowInstanceRef.current = instance;
    setViewport(instance.getViewport());
  }, []);

  const handleMove = useCallback<OnMove>((_event, nextViewport) => {
    setViewport(nextViewport);
  }, []);

  // Tracks the `<ReactFlow>` container's own pixel size — the other input
  // (alongside `viewport`) `computeLOD`'s `viewportBounds` is derived from.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Dev-only per-frame timing (Code Map's Profiling methodology): a CDP
  // harness drives synthetic pan/zoom against the fixture and reads
  // `window.__drillerPerf.frameDeltas` back out; only runs in fixture mode.
  useEffect(() => {
    if (!isDevFixtureMode) {
      return undefined;
    }
    const perf = getDevPerfState();
    let frameId: number;
    let lastTime = performance.now();
    const tick = (time: number) => {
      recordFrameDelta(perf, time - lastTime);
      lastTime = time;
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [isDevFixtureMode]);

  // Dev-only selection-to-detail latency: fires once the source view this
  // activation started reaches either terminal state — `'open'` or
  // `'error'`, not just `'open'`. The fixture's synthetic `file` paths
  // (`fixtures/module-N.ts`, from `devFixture.ts`) don't back any real file
  // on disk, so `readSourceRange` legitimately errors for every fixture
  // Node — found via this story's live CDP verification, where `'open'`
  // alone left this array permanently empty in fixture mode. AD-14 cares
  // about click-to-UI-response latency, not disk I/O success, so both
  // terminal states count; a real (non-fixture) project always resolves to
  // `'open'`.
  useEffect(() => {
    if (!isDevFixtureMode || selectionStartRef.current === null) {
      return;
    }
    if (sourceView.status === 'loading' || sourceView.status === 'closed') {
      return;
    }
    const elapsed = performance.now() - selectionStartRef.current;
    selectionStartRef.current = null;
    getDevPerfState().selectionToDetailMs.push(elapsed);
  }, [isDevFixtureMode, sourceView]);

  const flowNodes = useMemo(
    () => (fetchState.status === 'ready' ? layoutNodes(fetchState.nodes, activateNode) : []),
    [fetchState, activateNode],
  );
  const flowEdges = useMemo(
    () => (fetchState.status === 'ready' ? toFlowEdges(fetchState.edges) : []),
    [fetchState],
  );

  const flowNodesById = useMemo(() => {
    const byId = new Map<string, CodeMapFlowNode>();
    for (const flowNode of flowNodes) {
      byId.set(flowNode.id, flowNode);
    }
    return byId;
  }, [flowNodes]);

  // `zoom` is banded (geometric, anchored on `LOD_ZOOM_THRESHOLD`) rather
  // than used raw — see `quantizeZoomBand`'s comment. `worldWidth`/
  // `worldHeight` are derived from the *banded* zoom too, so they (and the
  // `computeLOD` call they feed) stay stable within a band instead of
  // drifting on every animation-frame's exact zoom value.
  const zoomBand = quantizeZoomBand(viewport.zoom, LOD_ZOOM_THRESHOLD);
  const worldWidth = containerSize.width > 0 ? containerSize.width / zoomBand : 0;
  const worldHeight = containerSize.height > 0 ? containerSize.height / zoomBand : 0;
  const worldMinX = containerSize.width > 0 ? -viewport.x / zoomBand : 0;
  const worldMinY = containerSize.height > 0 ? -viewport.y / zoomBand : 0;
  // Pan is quantized separately, to a quarter of the current (banded)
  // viewport size — panning less than that doesn't move `viewportBounds`
  // enough to matter, so it doesn't trigger a `computeLOD` recompute either.
  const panStepX = Math.max(worldWidth * PAN_QUANTIZE_RATIO, 1);
  const panStepY = Math.max(worldHeight * PAN_QUANTIZE_RATIO, 1);
  const boundsX = Math.round(worldMinX / panStepX) * panStepX;
  const boundsY = Math.round(worldMinY / panStepY) * panStepY;

  // AD-2's clustering half: `computeLOD` grid-buckets the already laid-out
  // Nodes and only ever promotes a bucket to full rendering when it's both
  // at/above `threshold` (or a lone Node in its cell) AND within
  // `viewportBounds` (review finding — see `map/lod/index.ts`'s doc
  // comment for why the viewport gate is load-bearing, not decorative).
  const lodResult = useMemo(
    () =>
      computeLOD({
        nodes: flowNodes.map((flowNode) => ({ id: flowNode.id, position: flowNode.position })),
        zoom: zoomBand,
        threshold: LOD_ZOOM_THRESHOLD,
        viewportBounds: { x: boundsX, y: boundsY, width: worldWidth, height: worldHeight },
      }),
    // Depends on the individual quantized numbers, not a `viewportBounds`
    // object literal — a fresh object every render would defeat memoization
    // even when its numeric contents are unchanged.
    [flowNodes, zoomBand, boundsX, boundsY, worldWidth, worldHeight],
  );

  const { renderedNodes, renderedEdges } = useMemo(() => {
    const visibleNodeIds = new Set(lodResult.fullNodeIds);
    const nodes: CodeMapAnyFlowNode[] = [];

    for (const id of lodResult.fullNodeIds) {
      const flowNode = flowNodesById.get(id);
      if (flowNode) {
        nodes.push(flowNode);
      }
    }

    for (const cluster of lodResult.clusters) {
      if (expandedClusterIds.has(cluster.id)) {
        // Client-side expand (Boundaries & Constraints): render this
        // cluster's real constituent Nodes instead of the cluster card —
        // never a Graph Service call.
        for (const nodeId of cluster.nodeIds) {
          const flowNode = flowNodesById.get(nodeId);
          if (flowNode) {
            nodes.push(flowNode);
            visibleNodeIds.add(nodeId);
          }
        }
        continue;
      }
      const clusterNode: CodeMapClusterFlowNode = {
        id: cluster.id,
        type: 'codeMapCluster',
        position: cluster.position,
        data: { cluster, onExpand: expandCluster },
      };
      nodes.push(clusterNode);
    }

    // An edge whose endpoint is folded into an (unexpanded) cluster has no
    // rendered Node to attach to — filtered out here rather than left for
    // `@xyflow/react` to warn about a missing source/target, which would
    // also mean thousands of console warnings at 10,000-Node scale.
    const edges = flowEdges.filter(
      (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
    );

    return { renderedNodes: nodes, renderedEdges: edges };
  }, [lodResult, flowNodesById, expandedClusterIds, expandCluster, flowEdges]);

  const handleNodeClick: NodeMouseHandler<CodeMapAnyFlowNode> = useCallback(
    (_event, flowNode) => {
      if (flowNode.type === 'codeMapCluster') {
        expandCluster(flowNode.data.cluster);
        return;
      }
      activateNode(flowNode.data.node);
    },
    [activateNode, expandCluster],
  );

  const closeSourceView = useCallback(() => setSourceView({ status: 'closed' }), []);

  // Escape closes the source overlay (review finding — a real dialog needs
  // a keyboard dismissal path, not just the × button). Only listens while
  // the overlay is actually open.
  useEffect(() => {
    if (sourceView.status === 'closed') {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSourceView();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sourceView.status, closeSourceView]);

  return (
    <div className="code-map" ref={containerRef}>
      {fetchState.status === 'loading' && (
        <div className="code-map__notice" role="status">
          Loading Code Map…
        </div>
      )}

      {fetchState.status === 'error' && (
        <div className="code-map__notice code-map__notice--error" role="alert">
          <p>Couldn&rsquo;t load the Code Map: {fetchState.message}</p>
          <button type="button" onClick={loadCodeMap}>
            Retry
          </button>
        </div>
      )}

      {fetchState.status === 'ready' && fetchState.nodes.length === 0 && (
        <div className="code-map__notice" role="status">
          This project has no map-eligible Nodes (no Function/Interface/Type/Module found).
        </div>
      )}

      {fetchState.status === 'ready' && fetchState.nodes.length > 0 && (
        // React Flow does not size itself from CSS alone — the parent
        // `.code-map` div is sized via `position: absolute; inset: 0`
        // (styles.css), but `<ReactFlow>`'s own root element still needs an
        // explicit width/height or it collapses to 0×0 and renders nothing.
        <ReactFlow<CodeMapAnyFlowNode>
          style={{ width: '100%', height: '100%' }}
          nodes={renderedNodes}
          edges={renderedEdges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onInit={handleInit}
          onMove={handleMove}
          // Without this, `@xyflow/react`'s default `minZoom` (0.5) clamps
          // `fitView` (and manual zoom-out) well above `LOD_ZOOM_THRESHOLD`
          // at any map size — found via live CDP verification. Only fixture
          // sessions get the very low floor; real usage keeps a much higher
          // one (`MIN_ZOOM_REAL`'s comment above — review finding).
          minZoom={isDevFixtureMode ? MIN_ZOOM_FIXTURE : MIN_ZOOM_REAL}
          // AD-2's viewport-culling half — confirmed present on the
          // installed `@xyflow/react` (12.11.6); this phase's own code only
          // needed to build the clustering half (`computeLOD`) alongside it.
          onlyRenderVisibleElements
          fitView
          colorMode="dark"
          // No editing surface (Non-Goal) — the Handles on each Node card
          // exist only so edges can attach visually; without this, they
          // render as live, draggable connection points, implying an
          // editing capability that doesn't exist (review finding).
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}

      {sourceView.status !== 'closed' && (
        <div className="code-map__source-overlay" role="dialog" aria-modal="true" aria-label="Node source">
          <div className="code-map__source-panel">
            <div className="code-map__source-header">
              <code>
                {sourceView.node.file}:{sourceView.node.startLine}-{sourceView.node.endLine}
              </code>
              <button type="button" onClick={closeSourceView} aria-label="Close source view">
                ×
              </button>
            </div>
            {sourceView.status === 'loading' && <p role="status">Loading source…</p>}
            {sourceView.status === 'error' && (
              <p role="alert" className="code-map__source-error">
                Couldn&rsquo;t open source: {sourceView.message}
              </p>
            )}
            {sourceView.status === 'open' && (
              <pre className="code-map__source-content">
                <code>{sourceView.content}</code>
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
