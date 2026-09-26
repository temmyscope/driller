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
 * feature or new IPC surface. Every Node's identifier is always shown
 * verbatim and monospace (Always) — never affected by summary state.
 *
 * Story 1.5 (Phase 2) adds the one-line summary itself: each Node card
 * additionally renders its `summaryStatus` — a real generated summary when
 * `'ready'`, a lightweight "Summary pending…" state while generation hasn't
 * reached it yet, or a distinct coverage-gap indicator when the Node's file
 * is in the current index's coverage gap set (FR5) — never a
 * confident-looking placeholder standing in for a summary that doesn't
 * exist. Batched `graphService:summaryProgress` events (AD-8) patch the
 * already-rendered node set's `summaryStatus`/`summary` in place; they never
 * trigger a full remap/refetch. Never a BI/analytics-dashboard treatment
 * (UX-DR3): no stat tiles, no data-viz divorced from the map's own
 * structure.
 *
 * Story 1.8 (Phase 4) added the inline Node Detail overlay (matching the
 * existing source-view overlay's own pattern — no shared Modal component)
 * and the on-demand single-Node regenerate action inside it, wired to
 * `window.driller.regenerateNode` — this app's first id-keyed mutating IPC
 * round-trip. On success, it patches `fetchState.nodes` in place by id, the
 * same idiom `onSummaryProgress` already uses, rather than refetching.
 *
 * P0-1 (2026-09-24) made that overlay the Node's primary surface. Story 1.8
 * reached it only through a "Details" affordance shown when a Node was
 * `summaryStatus === 'ready' && stale === true` — which is precisely the
 * condition UJ-1 step 4 excludes, so the panel was unreachable for the
 * journey that depends on it. Now:
 *  - Activating a Node card — a mouse click, or Enter/Space on the focused
 *    card — opens Node Detail, for any Node regardless of staleness or
 *    summary status (EXPERIENCE.md's IA row, "Node detail | Click/select
 *    any Node"). The "Details" affordance is gone; activation covers it.
 *  - Source viewing moved to its own Source pill in the affordance row, so
 *    it stays exactly one action away and the Interaction Primitives' trust
 *    mechanism survives in substance.
 *  - The panel carries what that IA row promises: summary/pending/
 *    coverage-gap state, staleness, the Node's risk signals (rendered by
 *    the same `NodeRiskSignalSections` the card uses — one implementation,
 *    never a fork) and a one-click source action. Regenerate stays, but is
 *    offered only on a `'ready'` Node: Story 1.8 could rely on "panel
 *    implies stale implies Regenerate makes sense," and that invariant is
 *    gone.
 *
 * Story 1.9 (Phase 2) adds the first search affordance: a persistent,
 * non-modal toolbar (never `App.tsx`'s header — Phase 1's frozen boundary)
 * that calls Phase 1's `window.driller.tracePath(query)`. On `found`, the
 * path's Nodes/edges get a distinct highlight treatment threaded into the
 * `renderedNodes`/`renderedEdges` memo below, the view fits to show the
 * whole route (`reactFlowInstanceRef`), and an ordered, clickable step list
 * renders alongside it — each entry re-using `navigateToNode` (Story 1.4),
 * never a new traversal mechanism. `no-path-found`/`error` render through
 * the shared `ActionableNotice` shape (P1-7).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge as FlowEdge,
  type EdgeMouseHandler,
  type Node as FlowNode,
  type NodeMouseHandler,
  type NodeProps,
  type OnMove,
  type ReactFlowInstance,
  useStoreApi,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  BlastRadiusExpansionResult,
  CodeMapEdge,
  CodeMapNode,
  DeterministicRiskSignal,
  DeterministicRiskSignalType,
  DiffScopeResult,
  IngestedRiskSignal,
  LlmJudgmentRiskSignal,
  RiskSignal,
  SummaryStatus,
} from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';
import {
  ACTIONABLE_NOTICE_GLYPHS,
  ACTIONABLE_NOTICE_SPOKEN_PREFIX,
  ActionableNotice,
  type ActionableNoticeTone,
} from './ActionableNotice';
import { computeLOD, type Cluster, type ComputeLODResult, type LODInputNode } from '../map/lod';
import { resolveRefreshOutcome, type CodeMapFetchReply } from './sessionView';
import { diffScopeSyncTimeFor, mapFooterState, type MapFooterState } from './appFrame';
import { MODAL_FOCUS_FALLBACK_ID, nodeDetailOverlayOpen, sourceOverlayOpen } from './modalStack';
import { useModalLayer } from './useModalLayer';

export type FetchState =
  | { status: 'loading' }
  | {
      status: 'ready';
      nodes: CodeMapNode[];
      edges: CodeMapEdge[];
      /** P2-5: Nodes the indexing scope filter removed (`CodeMapResult.hiddenByScope`). */
      hiddenByScope: number;
      /** P2-5: the scope that filter used (`CodeMapResult.appliedScope`); `[]` means none. */
      appliedScope: string[];
    }
  | { status: 'error'; message: string };

export type SourceViewState =
  | { status: 'closed' }
  | { status: 'loading'; node: CodeMapNode }
  | { status: 'open'; node: CodeMapNode; content: string }
  | { status: 'error'; node: CodeMapNode; message: string };

/**
 * The Node Detail panel's own state (Story 1.8, Phase 4) — mirrors
 * `SourceViewState`'s shape, but simpler: opening it never involves an async
 * fetch (everything it shows is already on the fetched `CodeMapNode`), so
 * there's no `'loading'`/`'error'` state of its own here — only whether it's
 * open, and for which Node. `node` is replaced in place (not just read once
 * at open time) once a regenerate succeeds, so the panel reflects the fresh
 * summary/staleness without needing a second lookup.
 */
export type NodeDetailState = { status: 'closed' } | { status: 'open'; node: CodeMapNode };

/**
 * The Node Detail panel's Regenerate button state — mirrors Settings.tsx's
 * `KeyEntryState` shape (a similar "idle/in-flight/error" async-action
 * pattern), simplified: no `'warning'` state exists for this action.
 */
export type RegenerateState = { kind: 'idle' | 'regenerating' } | { kind: 'error'; message: string };

/**
 * The source overlay's "Open in external editor" affordance state (Story
 * 1.10, Phase 2) — mirrors `RegenerateState`'s idle/in-flight/error shape.
 * Reset to `'idle'` whenever the source overlay opens for a (possibly new)
 * Node or closes, so a leftover error from a previous Node/attempt never
 * bleeds into the next.
 */
type OpenInEditorState = { status: 'idle' } | { status: 'opening' } | { status: 'error'; message: string };

/**
 * The search toolbar's own result state (Story 1.9, Phase 2) — mirrors
 * `RegenerateState`'s idle/in-flight/error shape (Code Map), but carries
 * `PathTraceResult` states directly (`'found'`/`'ambiguous'`/
 * `'no-path-found'`/`'error'`) rather than collapsing them into one generic
 * error: Boundaries & Constraints requires `'no-path-found'` to render
 * "visibly distinct from the `searching` state" (UX-DR16), and distinct from
 * a real `'error'` too, so each is its own explicit state rather than folded
 * together. `'ambiguous'` (Story 1.9, Phase 3) is the same idea applied to a
 * multi-match query: it gets its own explicit state and its own Actionable
 * Notice rendering, never folded into `'found'`/`'error'`. `PathTraceResult`
 * (`@driller/ipc-contracts`, re-exported from `@driller/graph-contracts`) is
 * assignable directly into this type's `'found'`/`'ambiguous'`/
 * `'no-path-found'`/`'error'` members — `window.driller.tracePath`'s
 * resolved value is set into this state as-is, only `'idle'`/`'searching'`
 * are local additions.
 */
export type PathTraceState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'found'; path: string[] }
  // P2-4: a 1-hop trace drawn by a Node card's "called by"/"calls" pill —
  // renderer-local (no IPC), highlighted/fitted like `'found'`. It stores
  // `neighborTrace`'s whole snapshot, so the step panel and the highlight
  // (`pathTraceHighlight`) always read the same data, never live adjacency.
  | ({ status: 'neighbors'; originId: string; direction: NeighborDirection } & NeighborTrace)
  | { status: 'ambiguous'; candidates: { id: string; name: string }[] }
  | { status: 'no-path-found' }
  | { status: 'error'; message: string };

/**
 * Story 3.1 (Phase 2): PR Review Mode's own base-ref/diff-scope state —
 * mirrors `PathTraceState`'s shape (idle/in-flight/explicit-result-states),
 * but carries `DiffScopeResult`'s own enumerated states nearly as-is
 * (`@driller/ipc-contracts`, `window.driller.computeDiffScope`'s resolved
 * value) rather than collapsing them into one generic error — Phase 1's own
 * contract already enumerates `'no-changes'`/`'not-a-git-repo'`/
 * `'no-base-ref-resolvable'` as distinct, never-silently-guessed states
 * (epic-3-context.md), and this component's job is to render each one as
 * its own Actionable Notice, not fold them together.
 *
 * The one deliberate departure from `DiffScopeResult['resolved']` itself:
 * `nodeIds` is stored as a `Set<string>` here, not the raw `string[]` the
 * IPC result carries — every consumer below only ever needs O(1) membership
 * checks (`layoutNodes`' new `changedNodeIds` parameter, mirroring
 * `pathHighlightNodeIds`'s own Set-typed precedent), never the array itself.
 */
export type DiffScopeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'resolved'; resolvedBaseRef: string; nodeIds: Set<string> }
  | { status: 'no-changes' }
  | { status: 'not-a-git-repo' }
  | { status: 'no-base-ref-resolvable' }
  | { status: 'error'; message: string };

/**
 * The three non-happy-path `DiffScopeState` statuses that each show their own
 * distinct Actionable Notice above the map, never in its place — named here
 * once so `resolvePrReviewView` and `formatDiffScopeNotice` below share one
 * literal list rather than risking the two drifting apart.
 */
export type DiffScopeNoticeStatus = 'no-changes' | 'not-a-git-repo' | 'no-base-ref-resolvable';

/**
 * One specific, concrete sentence per non-happy-path state (UX & Interaction
 * Patterns: "Actionable Notice ... one specific concrete sentence") — never
 * vague reassurance language (epic-3-context.md voice/tone). The base-ref
 * input/trigger toolbar rendered alongside this (Boundaries & Constraints)
 * is this notice's "at most one clear next action" — re-enter a ref and
 * trigger again — so the sentence itself states only what happened, not a
 * redundant restatement of that action.
 */
function formatDiffScopeNotice(status: DiffScopeNoticeStatus): string {
  switch (status) {
    case 'no-changes':
      return 'No changes to review — the resolved base ref has no diff against the current working tree.';
    case 'not-a-git-repo':
      return "This project isn't a git repository — PR Review Mode needs local git history to compute a diff.";
    case 'no-base-ref-resolvable':
      return 'No base ref could be resolved automatically (no upstream tracking branch or local main/master found) — enter one explicitly above.';
  }
}

/**
 * P1-7: each diff-scope notice's Actionable Notice tone. "No changes" is a
 * plain fact about the diff (info); the other two block PR Review (warning),
 * matching App.tsx's own not-a-git-repo warning.
 */
export const DIFF_SCOPE_NOTICE_TONES: Readonly<Record<DiffScopeNoticeStatus, ActionableNoticeTone>> = {
  'no-changes': 'info',
  'not-a-git-repo': 'warning',
  'no-base-ref-resolvable': 'warning',
};

/**
 * Story 3.2 (Phase 2): the combined blast-radius expansion's own state —
 * mirrors `DiffScopeState`'s shape (idle/in-flight/explicit-result-states),
 * carrying `BlastRadiusExpansionResult`'s `'resolved'`/`'error'` states
 * nearly as-is (`@driller/ipc-contracts`, `window.driller.expandBlastRadius`'s
 * resolved value) rather than collapsing them into one generic error, same
 * reasoning as `DiffScopeState`'s own doc comment.
 *
 * Two deliberate departures from the raw IPC result:
 * - `hopDistances` is stored as a `Map<string, number>` here, not the wire
 *   `Record<string, number>` — every consumer below (`blastRadiusNodeIds`)
 *   only ever iterates entries, and a `Map` is the natural shape for that.
 * - `maxDepth` is derived once here (the maximum hop distance actually
 *   present in the result — "its own 'further'", Always) rather than
 *   re-scanned on every stepper render.
 *
 * Reset to `'idle'` at the same three points `DiffScopeState` itself resets
 * at (Always: "mirrors the three existing `diffScopeState` reset points
 * exactly") — see the project-change effect, `loadCodeMap`, and
 * `handleComputeDiffScope`. The last of these resets synchronously the
 * instant a new diff-scope computation *starts* (review fix, Edge Case
 * Hunter + Verification Gap: resetting only once it settles left a window
 * where the map kept showing the previous diff scope's blast radius while
 * the toolbar already said "Computing…" for the new one), not once it
 * resolves/rejects.
 */
type BlastRadiusState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'resolved'; hopDistances: Map<string, number>; maxDepth: number }
  | { status: 'error'; message: string };

// No LOD/layout library yet (Design Notes: acceptable at this phase's real
// scale) — a plain deterministic grid, roughly square, is enough to lay the
// full fetched Node set out without overlap.
const NODE_COLUMN_GAP = 260;
const NODE_ROW_GAP = 110;

// FIX-1: a Node card's size when `@xyflow/react` hasn't measured it (a card
// still folded into an LOD cluster has no DOM, so no `measured` size). An
// estimate of the rendered `.code-map__node` card (min-width 160px plus
// padding, identifier + one-line summary + signal strip), used only to find
// the card's centre for `routeFitRequest`'s anchor; a measured size wins.
const NODE_CARD_FALLBACK_WIDTH = 200;
const NODE_CARD_FALLBACK_HEIGHT = 80;

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
export const LOD_ZOOM_THRESHOLD = 0.2;

// FIX-1: the lowest zoom a Path Trace / neighbour-trace fit may land at.
// `LOD_ZOOM_THRESHOLD` plus a margin, so float drift and `quantizeZoomBand`'s
// banding can never drop the fitted view back under the threshold (where
// every card collapses into cluster dots and the highlighted route vanishes).
export const ROUTE_MIN_READABLE_ZOOM = 0.25;

// The map's zoom ceiling: passed to `<ReactFlow maxZoom>` below and used as
// `routeViewport`'s cap, so a route fit can't disagree with the map. 2 is
// `@xyflow/react`'s own default, i.e. what the map allowed before FIX-1.
const MAP_MAX_ZOOM = 2;

// `fitBounds`' own default padding (`options.padding ?? 0.1`): a fraction
// that shrinks the usable viewport to `size / (1 + padding)`. `fitViewToPath`
// folds it into the bounds it hands `routeViewport`, so a compact route fits
// exactly as it did before FIX-1.
const ROUTE_FIT_PADDING = 0.1;

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
export function quantizeZoomBand(zoom: number, threshold: number): number {
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

// Defensive cap on the Back/Forward `history.stack` (review finding, same
// spirit as `MAX_EXPANDED_CLUSTER_IDS` above) — unlike that Set, unbounded
// growth here isn't self-trimming on any natural event, so a very long
// session's worth of traversal would otherwise accumulate forever. Trimmed
// from the front (oldest entries) once exceeded, with `index` shifted down
// by the same amount so it keeps pointing at the same logical entry.
const MAX_HISTORY_LENGTH = 500;

// Hard termination guarantee for `resolveZoomToRevealNode`'s halving loop
// (Story 1.4 Design Notes: reuse `expandCluster`'s own halve-the-
// remaining-gap convergence, not a second zoom-convergence approach) — 24
// halvings shrinks even fixture mode's extreme starting gap (0.02 vs.
// `LOD_ZOOM_THRESHOLD`'s 0.2) to a fraction of a float's precision long
// before this cap is reached. It exists only as a defensive termination
// bound, not a value expected to be hit: the loop's own fallback (landing
// exactly at `threshold`, always sufficient per `computeLOD`'s own
// `zoom >= threshold` check) is what actually guarantees resolution.
const MAX_ZOOM_RESOLVE_ITERATIONS = 24;

interface ResolveZoomParams {
  targetId: string;
  targetPosition: LODInputNode['position'];
  nodes: LODInputNode[];
  currentZoom: number;
  threshold: number;
  containerWidth: number;
  containerHeight: number;
}

/**
 * The LOD-aware half of `navigateToNode` (Story 1.4 Design Notes): finds a
 * zoom level — starting from `currentZoom`, reusing `expandCluster`'s own
 * halve-the-remaining-gap convergence toward `threshold` — at which
 * `targetId` resolves to a full, unclustered Node once the viewport is
 * centered on it.
 *
 * Re-runs `computeLOD` against a *hypothetical* viewport centered on the
 * target at each candidate zoom, rather than the map's actual current
 * viewport (Code Map: "re-run computeLOD at the target zoom before
 * deciding") — the target may currently be off-screen entirely (culled,
 * not "clustered"), which the actual current `computeLOD` result alone
 * can't distinguish from "grouped into a cluster with others." Each
 * candidate zoom is banded via `quantizeZoomBand` before being fed to
 * `computeLOD` — the same banding the live render path applies to
 * `viewport.zoom` — so this simulation matches what will actually render
 * once `setCenter` settles, rather than validating against unbanded
 * precision the renderer will never use.
 *
 * Terminates as soon as `targetId` lands in `fullNodeIds`: immediately if
 * it's already a singleton bucket (or `currentZoom` already bands to
 * threshold-or-above) — no zoom change at all — otherwise after however
 * many halving steps it takes to either isolate the target into its own
 * bucket or reach `threshold` outright. Never falls back to an
 * IDs-by-position/index shortcut (Boundaries & Constraints) — resolution
 * is always by content-stable `targetId` membership in `fullNodeIds`.
 */
function resolveZoomToRevealNode({
  targetId,
  targetPosition,
  nodes,
  currentZoom,
  threshold,
  containerWidth,
  containerHeight,
}: ResolveZoomParams): number {
  // An unmeasured container (`ResizeObserver` hasn't reported real
  // dimensions yet — width/height still 0) can't produce a meaningful
  // hypothetical `viewportBounds`: every candidate zoom would compute a
  // degenerate zero-size box, burning the full `MAX_ZOOM_RESOLVE_ITERATIONS`
  // budget before falling back to `threshold` regardless (review finding).
  // Fail fast to `currentZoom` unchanged instead — `centerOnNode` still
  // re-centers on the target, just without a wasted, meaningless zoom
  // convergence attempt; a real `computeLOD`/`fitView` pass corrects itself
  // once the container is actually measured.
  if (containerWidth <= 0 || containerHeight <= 0) {
    return currentZoom;
  }
  let zoom = currentZoom;
  for (let iteration = 0; iteration < MAX_ZOOM_RESOLVE_ITERATIONS; iteration += 1) {
    const band = quantizeZoomBand(zoom, threshold);
    const worldWidth = containerWidth > 0 ? containerWidth / band : 0;
    const worldHeight = containerHeight > 0 ? containerHeight / band : 0;
    const viewportBounds = {
      x: targetPosition.x - worldWidth / 2,
      y: targetPosition.y - worldHeight / 2,
      width: worldWidth,
      height: worldHeight,
    };
    const result = computeLOD({ nodes, zoom: band, threshold, viewportBounds });
    if (result.fullNodeIds.has(targetId)) {
      return zoom;
    }
    zoom = zoom + (threshold - zoom) * 0.5;
  }
  // Ran out of halving steps while still asymptotically short of
  // `threshold` — land exactly at it, always sufficient per computeLOD's
  // own `zoom >= threshold` check once the viewport is centered on the
  // target (guaranteeing `bucketInView`).
  return threshold;
}

interface Point {
  x: number;
  y: number;
}
interface Size {
  width: number;
  height: number;
}
interface Rect extends Point, Size {}

export interface RouteViewportParams {
  bounds: Rect;
  anchor: Point;
  viewport: Size;
  minReadableZoom: number;
  maxZoom: number;
}

const isFiniteNumber = (value: number) => Number.isFinite(value);

/**
 * FIX-1: the viewport a traced route is fitted to. Same maths as
 * `fitBounds` (centre the bounds at `min(width / bounds.width, height /
 * bounds.height)`, capped at `maxZoom`; padding is the caller's job, folded
 * into `bounds`) as long as that zoom stays readable. A route that only fits
 * below `minReadableZoom` would render as cluster dots, so the zoom is
 * clamped to the floor and the view centres on `anchor` (the centre of the
 * route's first Node: the entry point, or a neighbour trace's origin)
 * instead; `clamped` tells the step panel to say the route extends past the
 * view.
 *
 * Zero-size bounds (a single-Node route) divide to `Infinity`, which the
 * `maxZoom` cap turns into a plain centre-on-it at `maxZoom` (the spec's
 * single-Node row). An unusable viewport (zero, negative or non-finite) or
 * non-finite/negative bounds can't be fitted, so they get the safe clamped
 * view on the anchor — never a NaN. The floor itself never exceeds
 * `maxZoom`.
 */
export function routeViewport({
  bounds,
  anchor,
  viewport,
  minReadableZoom,
  maxZoom,
}: RouteViewportParams): { x: number; y: number; zoom: number; clamped: boolean } {
  const floor = Math.min(minReadableZoom, maxZoom);
  const viewportUsable =
    isFiniteNumber(viewport.width) && isFiniteNumber(viewport.height) && viewport.width > 0 && viewport.height > 0;
  const halfWidth = viewportUsable ? viewport.width / 2 : 0;
  const halfHeight = viewportUsable ? viewport.height / 2 : 0;
  const boundsUsable =
    [bounds.x, bounds.y, bounds.width, bounds.height].every(isFiniteNumber) && bounds.width >= 0 && bounds.height >= 0;
  if (viewportUsable && boundsUsable) {
    const fitZoom = Math.min(maxZoom, viewport.width / bounds.width, viewport.height / bounds.height);
    if (fitZoom >= floor) {
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      return { x: halfWidth - centerX * fitZoom, y: halfHeight - centerY * fitZoom, zoom: fitZoom, clamped: false };
    }
  }
  const anchorX = isFiniteNumber(anchor.x) ? anchor.x : 0;
  const anchorY = isFiniteNumber(anchor.y) ? anchor.y : 0;
  return { x: halfWidth - anchorX * floor, y: halfHeight - anchorY * floor, zoom: floor, clamped: true };
}

/**
 * FIX-1: what `fitViewToPath` should do for `path`, as a pure decision.
 * `positionsById` holds each route Node's absolute (world) top-left
 * position; `cardSize` is the first Node's card size (measured, or the
 * fallback constants), used to anchor on that card's centre rather than its
 * top-left corner.
 *
 * - `null`: none of the route's Nodes has a position (nothing to fit).
 * - `{ fallback }`: the container isn't measured, so the caller uses
 *   `fitBounds` with these (unpadded — `fitBounds` pads itself) bounds, and
 *   the anchor for clamping its result up to the floor.
 * - `{ params }`: `routeViewport`'s input, with `fitBounds`' default 10%
 *   padding folded into the bounds so an unclamped fit lands exactly where
 *   `fitBounds` used to put it.
 */
export function routeFitRequest(
  path: readonly string[],
  positionsById: ReadonlyMap<string, Point>,
  cardSize: Size,
  containerSize: Size,
): { fallback: { bounds: Rect; anchor: Point } } | { params: RouteViewportParams } | null {
  const positions = path
    .map((id) => positionsById.get(id))
    .filter((position): position is Point => position !== undefined);
  if (positions.length === 0) {
    return null;
  }
  // Review fix: `Math.min(...positions.map(...))`-style spread has a
  // practical engine argument-count ceiling well under this app's own
  // validated 10,000-Node scale (Story 1.3 Phase 2) — a large enough
  // `found` path would throw a `RangeError` here. `.reduce()` has no
  // such limit.
  const firstPosition = positions[0]!;
  const minX = positions.reduce((min, position) => Math.min(min, position.x), firstPosition.x);
  const maxX = positions.reduce((max, position) => Math.max(max, position.x), firstPosition.x);
  const minY = positions.reduce((min, position) => Math.min(min, position.y), firstPosition.y);
  const maxY = positions.reduce((max, position) => Math.max(max, position.y), firstPosition.y);
  // Padded by roughly one Node card's own footprint on each side (the
  // same `NODE_COLUMN_GAP`/`NODE_ROW_GAP` grid spacing `layoutNodes`
  // lays every card out on) so a card sitting exactly at the bounding
  // box's edge isn't clipped flush against the viewport border.
  const bounds = {
    x: minX - NODE_COLUMN_GAP / 2,
    y: minY - NODE_ROW_GAP / 2,
    width: maxX - minX + NODE_COLUMN_GAP,
    height: maxY - minY + NODE_ROW_GAP,
  };
  // The route's first Node: a `found` path's entry point, or a neighbour
  // trace's origin (`neighborTrace` puts it first).
  const first = (path[0] !== undefined ? positionsById.get(path[0]) : undefined) ?? firstPosition;
  const anchor = { x: first.x + cardSize.width / 2, y: first.y + cardSize.height / 2 };
  const measured =
    isFiniteNumber(containerSize.width) &&
    isFiniteNumber(containerSize.height) &&
    containerSize.width > 0 &&
    containerSize.height > 0;
  if (!measured) {
    return { fallback: { bounds, anchor } };
  }
  const paddedWidth = bounds.width * (1 + ROUTE_FIT_PADDING);
  const paddedHeight = bounds.height * (1 + ROUTE_FIT_PADDING);
  return {
    params: {
      bounds: {
        x: bounds.x - (paddedWidth - bounds.width) / 2,
        y: bounds.y - (paddedHeight - bounds.height) / 2,
        width: paddedWidth,
        height: paddedHeight,
      },
      anchor,
      viewport: { width: containerSize.width, height: containerSize.height },
      minReadableZoom: ROUTE_MIN_READABLE_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
    },
  };
}

/** FIX-1: the last route fit — which route array it was for, and whether it clamped. */
export interface RouteFit {
  route: readonly string[];
  clamped: boolean;
}

/**
 * FIX-1: whether the step panel should say the route extends past the view.
 * Only while the showing trace is the one that was fitted: compared by
 * reference against the exact array `fitViewToPath` was handed (`found`'s
 * `path`, `neighbors`' `nodeIds`), so any reset or new trace — a different
 * object — drops the line.
 */
export function isRouteClamped(routeFit: RouteFit | null, pathTrace: PathTraceState): boolean {
  if (routeFit === null || !routeFit.clamped) {
    return false;
  }
  if (pathTrace.status === 'found') {
    return routeFit.route === pathTrace.path;
  }
  if (pathTrace.status === 'neighbors') {
    return routeFit.route === pathTrace.nodeIds;
  }
  return false;
}

/**
 * FIX-1: the extends-beyond line's text. When the step list is also capped
 * (a neighbour trace past `MAX_RENDERED_NEIGHBORS`), the cap folds into the
 * same sentence rather than a second line.
 */
export function routeExtendsBeyondText(listed?: { shown: number; total: number }): string {
  return listed
    ? `The route extends beyond the view — use the steps to follow it (first ${listed.shown} of ${listed.total} listed).`
    : 'The route extends beyond the view — use the steps to follow it.';
}

/** FIX-1: the muted extends-beyond line, shared by both step panels. Hookless. */
export function RouteExtendsBeyondLine({ listed }: { listed?: { shown: number; total: number } }) {
  return (
    <p className="code-map__path-trace-candidates-truncated" role="status">
      {routeExtendsBeyondText(listed)}
    </p>
  );
}

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
// the exact same activation path a mouse click does, sharing one
// implementation instead of two. P0-1 (2026-09-24) retargeted what that
// shared path *does* — it opens Node Detail now, not the source viewer —
// without changing how it's threaded.
// `onShowNeighbors`/the adjacency-derived counts are threaded through node
// `data` the same way `onActivate` already is. P2-4 retargeted the caller/
// callee affordances: they draw a 1-hop neighbour trace (Path Trace's
// `'neighbors'` state) instead of calling `navigateToNode` on the first
// neighbour; edge-click navigation is unchanged.
type CodeMapFlowNode = FlowNode<
  {
    node: CodeMapNode;
    onActivate: (node: CodeMapNode) => void;
    // P2-4: the caller/callee pills draw a 1-hop neighbour trace (all
    // neighbours in that direction, highlighted like a Path Trace) instead
    // of jumping to the first neighbour via `navigateToNode`.
    onShowNeighbors: (originId: string, direction: NeighborDirection) => void;
    // P0-1 (2026-09-24): threaded through the same way `onActivate` already
    // is — the Source pill in the affordance row calls
    // this to open the source viewer. (It replaces Story 1.8's
    // `onOpenDetail`, whose "Details" pill this change removed: card
    // activation itself opens Node Detail now, so a pill for it would be
    // redundant.)
    onOpenSource: (node: CodeMapNode) => void;
    callerCount: number;
    calleeCount: number;
    // Story 1.6 (Phase 2): threaded through the same way `onActivate`
    // already is — a `'pending'` Node renders one of these two
    // Actionable Notices instead of the ordinary "Summary pending…" text
    // when generation can't actually produce anything right now (Boundaries
    // & Constraints: never a silent empty summary).
    noSummaryBackendAvailable: boolean;
    cloudSelectedNoKey: boolean;
    // Story 2.1 (Phase 3): threaded through the same way `noSummaryBackend
    // Available` already is — a renderer-local, no-persistence/no-IPC
    // toggle (Boundaries & Constraints) for the whole deterministic
    // `riskSignals` family's visibility, read by `CodeMapNodeCard` to gate
    // its signal strip.
    showDeterministicSignals: boolean;
    // Story 2.2 (Phase 3): a second, fully independent renderer-local toggle
    // for the `'llm-judgment'` family — threaded through identically to
    // `showDeterministicSignals` above, but never reading/writing it (this
    // story's own Boundaries & Constraints: "no shared toggle with
    // showDeterministicSignals").
    showLlmJudgment: boolean;
    // Story 2.3 (Phase 4): a third, fully independent renderer-local toggle
    // for the `'ingested'` family — threaded through identically to
    // `showDeterministicSignals`/`showLlmJudgment` above, but never reading
    // or writing either of them (this story's own Boundaries & Constraints:
    // "never reads/writes showDeterministicSignals/showLlmJudgment").
    showIngestedFindings: boolean;
    // Story 3.1 (Phase 2): true when this Node's id is in PR Review Mode's
    // resolved `changedNodeIds` set — threaded through the same way every
    // other per-Node boolean above is (`layoutNodes` derives it once per
    // Node from a `Set.has` lookup, never re-derived inside the card
    // component itself). Already `false` for every Node while `mode !==
    // 'prReview'`/no `'resolved'` diff scope exists yet (the `changedNodeIds`
    // this is computed from is the module-level empty Set outside those
    // conditions — see the `CodeMap` component's own derivation) — Boundaries
    // & Constraints: "switching back to Code Map Mode ... no changed-Node
    // treatment ... anywhere".
    isChanged: boolean;
  },
  'codeMapNode'
>;

/** Per-Node adjacency (Code Map: `Map<nodeId, {callers, callees}>`), built once from the fetched `CodeMapEdge[]`. */
export type NodeAdjacency = Map<string, { callers: string[]; callees: string[] }>;

/** P2-4: which side of a Node a 1-hop neighbour trace follows. */
export type NeighborDirection = 'callers' | 'callees';

/** P2-4: `neighborTrace`'s result — also the snapshot a `'neighbors'` Path Trace state stores. */
export interface NeighborTrace {
  nodeIds: string[];
  edgeKeys: string[];
  neighborIds: string[];
}

/**
 * P2-4: the 1-hop neighbour trace a Node card's "called by"/"calls" pill
 * draws. Pure, over the already-built `NodeAdjacency` (no IPC): the origin
 * plus every neighbour in `direction`, in adjacency order, and the
 * `pathEdgeKey`s of the edges between them in their true orientation —
 * caller→origin for `'callers'`, origin→callee for `'callees'`. Self-loops and
 * duplicate pairs are already excluded by the adjacency itself. An origin
 * with no neighbours (or absent from the adjacency) yields just itself.
 */
export function neighborTrace(adjacency: NodeAdjacency, originId: string, direction: NeighborDirection): NeighborTrace {
  const entry = adjacency.get(originId);
  const neighborIds = entry ? [...(direction === 'callers' ? entry.callers : entry.callees)] : [];
  const edgeKeys = neighborIds.map((id) =>
    direction === 'callers' ? pathEdgeKey(id, originId) : pathEdgeKey(originId, id),
  );
  return { nodeIds: [originId, ...neighborIds], edgeKeys, neighborIds };
}

/**
 * P2-4: what the map highlights for a Path Trace state — the Node ids, the
 * `pathEdgeKey`s of the edges between them, and whether an edge of any kind
 * counts (`callsOnly`). A `'found'` path is `traceCallPath`'s `CALLS`-only
 * walk, so only a `CALLS` edge on a consecutive pair highlights (unchanged
 * from Story 1.9). A `'neighbors'` trace reads its stored snapshot, and since
 * the adjacency it came from counts every edge kind, its connecting edges
 * highlight whatever their kind. Every other state highlights nothing (the
 * shared `EMPTY_ID_SET`, so memoized consumers don't see a new Set).
 */
export interface PathHighlight {
  nodeIds: ReadonlySet<string>;
  edgeKeys: ReadonlySet<string>;
  callsOnly: boolean;
}

export function pathTraceHighlight(pathTrace: PathTraceState): PathHighlight {
  if (pathTrace.status === 'found') {
    const edgeKeys = new Set<string>();
    for (let i = 0; i < pathTrace.path.length - 1; i += 1) {
      edgeKeys.add(pathEdgeKey(pathTrace.path[i]!, pathTrace.path[i + 1]!));
    }
    return { nodeIds: new Set(pathTrace.path), edgeKeys, callsOnly: true };
  }
  if (pathTrace.status === 'neighbors') {
    return { nodeIds: new Set(pathTrace.nodeIds), edgeKeys: new Set(pathTrace.edgeKeys), callsOnly: false };
  }
  return { nodeIds: EMPTY_ID_SET, edgeKeys: EMPTY_ID_SET, callsOnly: true };
}

/** P2-4: whether one rendered edge gets the Path Trace highlight — see `pathTraceHighlight`. */
export function isPathHighlightEdge(
  highlight: PathHighlight,
  edge: { source: string; target: string; label?: unknown },
): boolean {
  if (highlight.callsOnly && edge.label !== 'CALLS') {
    return false;
  }
  return highlight.edgeKeys.has(pathEdgeKey(edge.source, edge.target));
}

/**
 * P2-4: a caller/callee pill's visible text (minus its arrow glyph):
 * "3 called by" (no plural form) / "1 call" / "2 calls".
 */
export function neighborPillText(direction: NeighborDirection, count: number): string {
  return direction === 'callers' ? `${count} called by` : `${count} call${count === 1 ? '' : 's'}`;
}

/**
 * P2-4: a caller/callee pill's `aria-label` — its visible text first, then
 * what activating it does: "3 called by — show the callers of handle",
 * "1 call — show the callee of handle".
 */
export function neighborPillLabel(direction: NeighborDirection, count: number, originName: string): string {
  const noun = direction === 'callers' ? 'caller' : 'callee';
  return `${neighborPillText(direction, count)} — show the ${noun}${count === 1 ? '' : 's'} of ${originName}`;
}

/** P2-4: the neighbour-trace step panel's heading text ("Callers of handle (3)"). */
export function neighborTraceHeading(originName: string, direction: NeighborDirection, count: number): string {
  return `${direction === 'callers' ? 'Callers' : 'Callees'} of ${originName} (${count})`;
}

/**
 * P2-4: the Node card's caller/callee pills. Each draws a 1-hop neighbour
 * trace via `onShowNeighbors` rather than jumping to one neighbour. A pill
 * stays absent (not just hidden) when its count is 0. Hookless so a test
 * can walk its element tree and fire each `onClick`.
 *
 * `stopPropagation` on mousedown, click, AND keydown keeps these nested
 * controls from also being read as an interaction with the Node card itself
 * (see `CodeMapNodeCard`'s affordance-row comment).
 */
export function NodeNeighborPills({
  node,
  callerCount,
  calleeCount,
  onShowNeighbors,
}: {
  node: { id: string; name: string };
  callerCount: number;
  calleeCount: number;
  onShowNeighbors: (originId: string, direction: NeighborDirection) => void;
}) {
  return (
    <>
      {callerCount > 0 && (
        <button
          type="button"
          className="code-map__node-affordance"
          aria-label={neighborPillLabel('callers', callerCount, node.name)}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onShowNeighbors(node.id, 'callers');
          }}
        >
          ↑{neighborPillText('callers', callerCount)}
        </button>
      )}
      {calleeCount > 0 && (
        <button
          type="button"
          className="code-map__node-affordance"
          aria-label={neighborPillLabel('callees', calleeCount, node.name)}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onShowNeighbors(node.id, 'callees');
          }}
        >
          ↓{neighborPillText('callees', calleeCount)}
        </button>
      )}
    </>
  );
}

// P2-4: the neighbour-trace panel's row cap — same render-layer-only
// reasoning as `MAX_RENDERED_AMBIGUOUS_CANDIDATES`: a hub Node can have
// hundreds of callers, so only the first rows render, with an explicit
// "Showing the first N of M" line. The map highlight and view fit still
// cover every neighbour.
export const MAX_RENDERED_NEIGHBORS = 50;

/**
 * P2-4: the step panel for a `'neighbors'` Path Trace state — the same
 * panel and `path-trace-stack-row` rows a `'found'` path uses, minus the hop
 * numbers/indent, in a `<ul>` (a 1-hop fan has no order of descent). Each
 * row navigates via `onNavigate` (`navigateToNode`, LOD-aware, as a path
 * step does); the origin's name in the heading does too, so the user can get
 * back after jumping to a neighbour. Only the first `MAX_RENDERED_NEIGHBORS`
 * rows are resolved and rendered. Hookless, so it's testable by walking its
 * element tree.
 */
export function NeighborTraceSteps({
  originId,
  originName,
  direction,
  neighborIds,
  resolveNode,
  onNavigate,
  onDismiss,
  routeClamped = false,
}: {
  originId: string;
  originName: string;
  direction: NeighborDirection;
  neighborIds: readonly string[];
  resolveNode: (id: string) => { name: string; file: string | undefined };
  onNavigate: (id: string) => void;
  onDismiss: () => void;
  /** FIX-1: `routeViewport` clamped the fit, so the fan runs past the view. */
  routeClamped?: boolean;
}) {
  const heading = neighborTraceHeading(originName, direction, neighborIds.length);
  const shownIds = neighborIds.slice(0, MAX_RENDERED_NEIGHBORS);
  return (
    <div className="code-map__path-trace-steps-panel" role="region" aria-label={heading}>
      {/* The origin's identifier stays monospace (Epic 1's visual floor). */}
      <p className="code-map__path-trace-neighbors-heading">
        {direction === 'callers' ? 'Callers' : 'Callees'} of{' '}
        <button
          type="button"
          className="code-map__path-trace-neighbors-origin"
          aria-label={`Go to ${originName}`}
          onClick={() => onNavigate(originId)}
        >
          <code>{originName}</code>
        </button>{' '}
        ({neighborIds.length})
      </p>
      <ul className="code-map__path-trace-steps">
        {shownIds.map((id) => {
          const neighbor = resolveNode(id);
          return (
            <li key={id}>
              <button type="button" className="code-map__path-trace-stack-row" onClick={() => onNavigate(id)}>
                <span className="code-map__path-trace-stack-row-text">
                  <code className="code-map__path-trace-stack-row-name">{neighbor.name}</code>
                  {neighbor.file && <span className="code-map__path-trace-stack-row-module">{neighbor.file}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {routeClamped ? (
        <RouteExtendsBeyondLine
          {...(neighborIds.length > MAX_RENDERED_NEIGHBORS
            ? { listed: { shown: MAX_RENDERED_NEIGHBORS, total: neighborIds.length } }
            : {})}
        />
      ) : (
        neighborIds.length > MAX_RENDERED_NEIGHBORS && (
          <p className="code-map__path-trace-candidates-truncated">
            Showing the first {MAX_RENDERED_NEIGHBORS} of {neighborIds.length}. All of them are highlighted on the map.
          </p>
        )
      )}
      <button type="button" className="code-map__path-trace-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/** FIX-1: the slice of `@xyflow/react`'s store `fitViewToPath` reads. */
type FlowStoreSize = { getState: () => { width: number; height: number } };

/**
 * FIX-1: hands `<CodeMap>` a handle on `@xyflow/react`'s store. `CodeMap`
 * renders `<ReactFlow>` itself (no `ReactFlowProvider` above it), so only a
 * child of `<ReactFlow>` can reach the store; this one renders nothing.
 */
function ReactFlowStoreBridge({ storeRef }: { storeRef: { current: FlowStoreSize | null } }) {
  const store = useStoreApi();
  useEffect(() => {
    storeRef.current = store;
    return () => {
      storeRef.current = null;
    };
  }, [store, storeRef]);
  return null;
}

/**
 * Story 1.9 (Phase 2): the step panel for a `'found'` Path Trace state —
 * extracted (FIX-1) as a hookless component, like `NeighborTraceSteps`, so a
 * test can walk its element tree. `resolveNode` returns the id itself as the
 * name when a Node can't be resolved.
 */
export function FoundTraceSteps({
  path,
  resolveNode,
  onNavigate,
  onDismiss,
  routeClamped = false,
}: {
  path: readonly string[];
  resolveNode: (id: string) => { name: string; file: string | undefined };
  onNavigate: (id: string) => void;
  onDismiss: () => void;
  /** FIX-1: `routeViewport` clamped the fit, so the route runs past the view. */
  routeClamped?: boolean;
}) {
  return (
    // Boundaries & Constraints (UX-DR10): "leaves the
    // highlight/step list visible for further stepping" — clicking
    // an entry only re-centers the map via `navigateToNode`, it
    // never closes/collapses this panel.
    //
    // DESIGN.md `path-trace-stack-row` (this pass): dense-profiler's
    // own indented call-stack visual — hop circle, tree-indent
    // glyph, identifier, module — replacing the old flat numbered-
    // pill/name row. Deliberately no duration/timing field (Never:
    // driller resolves paths statically and never executes code;
    // dense-profiler's own per-hop duration would be fabricated
    // data here — see that token's own DESIGN.md comment).
    <div className="code-map__path-trace-steps-panel" role="region" aria-label="Traced path steps">
      <ol className="code-map__path-trace-steps">
        {path.map((id, index) => {
          const node = resolveNode(id);
          return (
            // Review fix: `id` alone isn't guaranteed unique — nothing
            // rules out a real graph shape producing a path that
            // revisits the same Node id twice — so the index is
            // folded into the key too.
            <li key={`${id}-${index}`}>
              <button
                type="button"
                className="code-map__path-trace-stack-row"
                onClick={() => onNavigate(id)}
              >
                <span className="code-map__path-trace-hop-circle" aria-hidden="true">
                  {index + 1}
                </span>
                {/* The entry point (index 0) has nothing to descend
                    from, so it carries no indent connector — every
                    hop after it does, indented one further step
                    than the last (dense-profiler's own "indented
                    call-stack" visual, Design Notes).
                    Review fix (Blind Hunter + Edge Case Hunter,
                    independently): `(index - 1) * 8` put hop 1 (the
                    first indented row) at 0px, visually flush with
                    the unindented entry point — off by one. `index *
                    8` fixes that (hop 1 → 8px, hop 2 → 16px, ...).
                    Capped at 8 levels (64px) so a very long traced
                    path can't push the row's text out of this fixed-
                    width panel — depth beyond that stops being
                    legible anyway, so no further indent is lost
                    information, just a plateau. */}
                {index > 0 && (
                  <span
                    className="code-map__path-trace-indent"
                    aria-hidden="true"
                    style={{ marginLeft: `${Math.min(index * 8, 64)}px` }}
                  >
                    └─
                  </span>
                )}
                <span className="code-map__path-trace-stack-row-text">
                  <code className="code-map__path-trace-stack-row-name">{node.name}</code>
                  {node.file && (
                    <span className="code-map__path-trace-stack-row-module">{node.file}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {routeClamped && <RouteExtendsBeyondLine />}
      {/* Story 1.9 (Phase 4): logs the dismissal (AD-21) and resets
          the panel to `idle` — also driller's first clear-search
          affordance, resolving Phase 2's deferred gap. */}
      <button
        type="button"
        className="code-map__path-trace-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

function layoutNodes(
  nodes: CodeMapNode[],
  onActivate: (node: CodeMapNode) => void,
  onShowNeighbors: (originId: string, direction: NeighborDirection) => void,
  onOpenSource: (node: CodeMapNode) => void,
  adjacency: NodeAdjacency,
  noSummaryBackendAvailable: boolean,
  cloudSelectedNoKey: boolean,
  showDeterministicSignals: boolean,
  showLlmJudgment: boolean,
  showIngestedFindings: boolean,
  // Story 3.1 (Phase 2): PR Review Mode's resolved changed-Node id set —
  // the module-level empty Set (`EMPTY_ID_SET`) outside `mode === 'prReview'`/
  // a `'resolved'` diff scope, so every Node's `isChanged` below is simply
  // `false` in every other state (Boundaries & Constraints).
  changedNodeIds: ReadonlySet<string>,
): CodeMapFlowNode[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  return nodes.map((node, index) => {
    const entry = adjacency.get(node.id);
    return {
      id: node.id,
      type: 'codeMapNode',
      position: {
        x: (index % columns) * NODE_COLUMN_GAP,
        y: Math.floor(index / columns) * NODE_ROW_GAP,
      },
      data: {
        node,
        onActivate,
        onShowNeighbors,
        onOpenSource,
        callerCount: entry?.callers.length ?? 0,
        calleeCount: entry?.callees.length ?? 0,
        noSummaryBackendAvailable,
        cloudSelectedNoKey,
        showDeterministicSignals,
        showLlmJudgment,
        showIngestedFindings,
        isChanged: changedNodeIds.has(node.id),
      },
    };
  });
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
 * Resolves which endpoint of a clicked edge `navigateToNode` should target
 * (Story 1.4 Code Map): the endpoint that ISN'T the currently-focused Node
 * — tracked via `focusedNodeIdRef`, since Story 1.3 has no persistent
 * Node-selection state (Design Notes) — defaulting to `target` when neither
 * endpoint is focused (e.g. the very first edge click of a session).
 */
// Story 1.9 (Phase 2): a stable, reused-across-renders empty Set for
// `pathTraceHighlight`'s Sets outside a `'found'`/`'neighbors'` result
// — a fresh `new Set()` every render would still be referentially new each
// time (defeating the `useMemo`s that return it), so it's declared once at
// module scope instead.
const EMPTY_ID_SET: ReadonlySet<string> = new Set();

/**
 * P0-2b: what the LOD/render pipeline returns in a mode that mounts no canvas
 * (Health Audit). Stable module-scope references, same precedent as
 * `EMPTY_ID_SET` just above — a fresh literal per render would be referentially
 * new every time and defeat the very memos these short-circuit.
 */
const EMPTY_LOD_RESULT: ComputeLODResult = { fullNodeIds: new Set(), clusters: [] };
const EMPTY_FLOW_NODES: CodeMapAnyFlowNode[] = [];
const EMPTY_FLOW_EDGES: FlowEdge[] = [];

/** Edge key for `pathTraceHighlight`'s `edgeKeys` (Story 1.9, Phase 2) — matches `toFlowEdges`'s own `id` separator. */
function pathEdgeKey(source: string, target: string): string {
  return `${source}→${target}`;
}

/**
 * P3-11: whether an edge whose RENDERED source is `renderedSourceId` leaves a
 * changed Node. True when that id is itself a changed Node, or when it is an
 * unexpanded LOD cluster (a key of `clusterMembers`) with at least one
 * changed member. Without the cluster half, a changed Node folded into a
 * cluster loses its `code-map__edge--changed-source` accent the moment the
 * user zooms out, because the rendered source is then the cluster's id.
 *
 * Pure: `clusterMembers` holds only the clusters actually rendered as a
 * cluster card (expanded clusters render their members as cards instead).
 */
export function isChangedSource(
  renderedSourceId: string,
  changedNodeIds: ReadonlySet<string>,
  clusterMembers: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (changedNodeIds.has(renderedSourceId)) {
    return true;
  }
  const members = clusterMembers.get(renderedSourceId);
  return members !== undefined && members.some((id) => changedNodeIds.has(id));
}

/** P3-11: how many of a cluster's members are changed Nodes. `0` outside PR Review (empty set). */
export function changedMemberCount(memberIds: readonly string[], changedNodeIds: ReadonlySet<string>): number {
  if (changedNodeIds.size === 0) {
    return 0;
  }
  let count = 0;
  for (const id of memberIds) {
    if (changedNodeIds.has(id)) {
      count += 1;
    }
  }
  return count;
}

/** P3-11: the marker `ClusterEdgeData.kind` carries; `edgeNodeEndpoints` trusts only data carrying it. */
export const CHANGED_CLUSTER_EDGE = 'changed-cluster';

/** P3-11: `label` of a synthetic edge standing in for real edges of more than one kind. */
export const MIXED_EDGE_LABEL = 'mixed';

/** One real (Node → Node) edge a synthetic cluster edge stands in for. */
export interface NodePair {
  source: string;
  target: string;
  /** The real edge's kind (`CodeMapEdgeKind`), as `toFlowEdges` put it on `label`. */
  kind: string | undefined;
}

/**
 * P3-11: `FlowEdge.data` on a synthetic changed-cluster edge. `nodePairs` is
 * every real edge collapsed into it, in input order, so a click can resolve
 * to a real Node id (a cluster id must never reach `navigateToNode`, AD-2)
 * and the path highlight can test the real endpoints.
 */
export interface ClusterEdgeData extends Record<string, unknown> {
  kind: typeof CHANGED_CLUSTER_EDGE;
  nodePairs: NodePair[];
}

function clusterEdgeData(edge: Pick<FlowEdge, 'data'>): ClusterEdgeData | undefined {
  const data = edge.data;
  if (
    data !== undefined &&
    data.kind === CHANGED_CLUSTER_EDGE &&
    Array.isArray(data.nodePairs) &&
    data.nodePairs.length > 0
  ) {
    return data as ClusterEdgeData;
  }
  return undefined;
}

/**
 * P3-11: the real Node pairs an edge stands for — every collapsed pair of a
 * synthetic changed-cluster edge, or the edge's own endpoints otherwise.
 */
export function edgeNodePairs(edge: Pick<FlowEdge, 'source' | 'target' | 'data' | 'label'>): NodePair[] {
  const data = clusterEdgeData(edge);
  if (data !== undefined) {
    return data.nodePairs;
  }
  return [{ source: edge.source, target: edge.target, kind: typeof edge.label === 'string' ? edge.label : undefined }];
}

/** P3-11: an edge's (first) real Node endpoints — see `edgeNodePairs`. */
export function edgeNodeEndpoints(edge: Pick<FlowEdge, 'source' | 'target' | 'data' | 'label'>): {
  source: string;
  target: string;
} {
  const [first] = edgeNodePairs(edge);
  return first !== undefined ? { source: first.source, target: first.target } : { source: edge.source, target: edge.target };
}

/**
 * P3-11: the edges leaving a changed Node that have at least one end folded
 * into an unexpanded LOD cluster — a clustered changed source (target a card
 * or a cluster), or a changed card whose target is clustered. The ordinary
 * edge path drops every edge with a clustered endpoint (no rendered Node to
 * attach to), so without these a zoomed-out PR Review loses those edges.
 *
 * Deliberately narrow — only edges whose real source is changed — so Code
 * Map Mode and every other edge render exactly as before. Each edge is
 * re-anchored on its rendered endpoints, de-duplicated per rendered pair
 * (every collapsed real pair kept in `data.nodePairs`), and never drawn when
 * both ends fold into the same cluster. A collapsed edge keeps its kind's
 * `label` and class when every real edge shares it, and is labelled
 * `MIXED_EDGE_LABEL` with no kind class otherwise. `memberToCluster` needs
 * entries only for the clustered ends of changed-source edges (see
 * `assembleRenderedEdges`); `visibleNodeIds` is every Node rendered as a card.
 */
export function changedClusterEdges(
  edges: readonly FlowEdge[],
  changedNodeIds: ReadonlySet<string>,
  memberToCluster: ReadonlyMap<string, string>,
  visibleNodeIds: ReadonlySet<string>,
): FlowEdge[] {
  if (changedNodeIds.size === 0 || memberToCluster.size === 0) {
    return [];
  }
  const groups = new Map<string, { source: string; target: string; pairs: NodePair[] }>();
  for (const edge of edges) {
    if (!changedNodeIds.has(edge.source) || edge.source === edge.target) {
      continue;
    }
    const sourceCluster = memberToCluster.get(edge.source);
    const targetCluster = memberToCluster.get(edge.target);
    if (sourceCluster === undefined && targetCluster === undefined) {
      continue;
    }
    const renderedSource = sourceCluster ?? (visibleNodeIds.has(edge.source) ? edge.source : undefined);
    const renderedTarget = targetCluster ?? (visibleNodeIds.has(edge.target) ? edge.target : undefined);
    if (renderedSource === undefined || renderedTarget === undefined || renderedSource === renderedTarget) {
      continue;
    }
    const key = pathEdgeKey(renderedSource, renderedTarget);
    const pair: NodePair = {
      source: edge.source,
      target: edge.target,
      kind: typeof edge.label === 'string' ? edge.label : undefined,
    };
    const group = groups.get(key);
    if (group) {
      group.pairs.push(pair);
    } else {
      groups.set(key, { source: renderedSource, target: renderedTarget, pairs: [pair] });
    }
  }
  const out: FlowEdge[] = [];
  for (const [key, group] of groups) {
    const kinds = new Set(group.pairs.map((pair) => pair.kind));
    const [onlyKind] = kinds;
    const sharedKind = kinds.size === 1 ? onlyKind : undefined;
    const data: ClusterEdgeData = { kind: CHANGED_CLUSTER_EDGE, nodePairs: group.pairs };
    out.push({
      id: `${CHANGED_CLUSTER_EDGE}:${key}`,
      source: group.source,
      target: group.target,
      label: sharedKind ?? MIXED_EDGE_LABEL,
      // The changed-source accent is threaded on by `highlightEdge`, through
      // `isChangedSource`, like every other edge.
      className:
        sharedKind !== undefined ? `code-map__edge code-map__edge--${sharedKind.toLowerCase()}` : 'code-map__edge',
      data,
    });
  }
  return out;
}

/**
 * The rendered-edge class threading (Story 1.9 Phase 2's path highlight,
 * then DESIGN.md `canvas-edge-highlighted`), pure so P3-11's cluster case is
 * testable.
 *
 * Path highlight first, and it wins: only a `CALLS` edge can be part of a
 * traced `'found'` path (`traceCallPath` walks `CALLS` only), so a same-pair
 * `IMPORTS`/`USAGE` edge never highlights just because it shares (source,
 * target) with a real step. P2-4: `isPathHighlightEdge` keeps that CALLS-only
 * rule for `'found'`, but lets a `'neighbors'` trace highlight its real
 * connecting edge whatever its kind (the adjacency it came from counts every
 * kind). P3-11: tested on the edge's real Node pairs and their kinds
 * (`edgeNodePairs`), so a synthetic cluster edge carrying a traced step is
 * path-highlighted too.
 *
 * Then the changed-source accent (`canvas-edge-highlighted`, an accent
 * stroke on any edge leaving a changed Node in PR Review Mode) — distinct
 * from the traced route's trace-cyan stroke (that token's own note: "Path
 * Trace routes use path-trace-route instead"), so the two never share an
 * edge. `changedNodeIds` is empty outside PR Review Mode, so this is a no-op
 * everywhere else. P3-11: `isChangedSource` also counts a rendered cluster
 * source with a changed member.
 */
export function highlightEdge(
  edge: FlowEdge,
  pathHighlight: PathHighlight,
  changedNodeIds: ReadonlySet<string>,
  clusterMembers: ReadonlyMap<string, readonly string[]>,
): FlowEdge {
  const onPath = edgeNodePairs(edge).some((pair) =>
    isPathHighlightEdge(pathHighlight, { source: pair.source, target: pair.target, label: pair.kind }),
  );
  if (onPath) {
    return { ...edge, className: `${edge.className ?? ''} code-map__edge--path-highlight`.trim() };
  }
  if (isChangedSource(edge.source, changedNodeIds, clusterMembers)) {
    return { ...edge, className: `${edge.className ?? ''} code-map__edge--changed-source`.trim() };
  }
  return edge;
}

export interface AssembleRenderedEdgesParams {
  flowEdges: readonly FlowEdge[];
  /** `computeLOD`'s clusters; those in `expandedClusterIds` render as cards and are skipped here. */
  clusters: readonly Cluster[];
  expandedClusterIds: ReadonlySet<string>;
  /** Every Node rendered as a card (including an expanded cluster's members). */
  visibleNodeIds: ReadonlySet<string>;
  changedNodeIds: ReadonlySet<string>;
  pathHighlight: PathHighlight;
}

/**
 * The rendered edge list for the canvas. An edge whose endpoint is folded
 * into an (unexpanded) cluster has no rendered Node to attach to, so it is
 * filtered out rather than left for `@xyflow/react` to warn about (thousands
 * of warnings at 10,000-Node scale) — except, P3-11, an edge leaving a
 * changed Node, which `changedClusterEdges` re-anchors on its cluster(s).
 * Every edge then goes through `highlightEdge`.
 *
 * 10,000-Node budget: nothing cluster-related is built unless some changed
 * Node's edge has a clustered end, and `memberToCluster` only ever holds
 * those ends (never every clustered Node).
 */
export function assembleRenderedEdges({
  flowEdges,
  clusters,
  expandedClusterIds,
  visibleNodeIds,
  changedNodeIds,
  pathHighlight,
}: AssembleRenderedEdgesParams): FlowEdge[] {
  const cardEdges = flowEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const clusterMembers = new Map<string, readonly string[]>();
  let synthetic: FlowEdge[] = [];
  if (changedNodeIds.size > 0) {
    // The clustered ends of changed-source edges — checked `has(source)`
    // first, so an unchanged edge costs one Set lookup.
    const clusteredEnds = new Set<string>();
    for (const edge of flowEdges) {
      if (!changedNodeIds.has(edge.source)) {
        continue;
      }
      if (!visibleNodeIds.has(edge.source)) {
        clusteredEnds.add(edge.source);
      }
      if (!visibleNodeIds.has(edge.target)) {
        clusteredEnds.add(edge.target);
      }
    }
    if (clusteredEnds.size > 0) {
      const memberToCluster = new Map<string, string>();
      for (const cluster of clusters) {
        if (expandedClusterIds.has(cluster.id)) {
          continue;
        }
        clusterMembers.set(cluster.id, cluster.nodeIds);
        for (const nodeId of cluster.nodeIds) {
          if (clusteredEnds.has(nodeId)) {
            memberToCluster.set(nodeId, cluster.id);
          }
        }
      }
      synthetic = changedClusterEdges(flowEdges, changedNodeIds, memberToCluster, visibleNodeIds);
    }
  }
  return cardEdges.concat(synthetic).map((edge) => highlightEdge(edge, pathHighlight, changedNodeIds, clusterMembers));
}

/**
 * P3-11: which real Node an edge click navigates to. A synthetic cluster
 * edge resolves on the collapsed pair touching `focusedNodeId` if there is
 * one, else its first pair — always a real Node id, never a cluster id.
 */
export function edgeClickTarget(
  edge: Pick<FlowEdge, 'source' | 'target' | 'data' | 'label'>,
  focusedNodeId: string | null,
): string {
  const pairs = edgeNodePairs(edge);
  const pair =
    pairs.find((candidate) => candidate.source === focusedNodeId || candidate.target === focusedNodeId) ?? pairs[0];
  return resolveEdgeClickTarget(pair ?? { source: edge.source, target: edge.target }, focusedNodeId);
}

function resolveEdgeClickTarget(edge: { source: string; target: string }, focusedNodeId: string | null): string {
  if (focusedNodeId === edge.source) {
    return edge.target;
  }
  if (focusedNodeId === edge.target) {
    return edge.source;
  }
  return edge.target;
}

// Review fix (Story 1.9, Phase 3): the search toolbar's ambiguous-match
// panel is a small fixed-width surface (`code-map__path-trace`'s own
// `width: min(320px, ...)`), never meant to hold more than a handful of
// items — but `traceCallPath`'s `ambiguous` result carries a tier's FULL
// match list with no upper bound (Always, in `packages/graph-contracts`: an
// honest, never-silently-narrowed candidate set). A short/common substring
// query against a real 10,000-Node-scale project could plausibly return
// dozens or hundreds of candidates. Rather than cap the engine's own
// contract (which would silently drop real matches from the data itself),
// the cap lives here at the render layer: only the first
// `MAX_RENDERED_AMBIGUOUS_CANDIDATES` are rendered, with an explicit
// truncation notice when there are more — honest about being partial
// rather than silently dropping matches from view.
const MAX_RENDERED_AMBIGUOUS_CANDIDATES = 20;

/**
 * Review fix (Story 1.9, Phase 3): every candidate in one `ambiguous`
 * result shares the exact same `name` by construction (that's why they're
 * ambiguous) — rendering `candidate.name` alone would make two candidates
 * indistinguishable, defeating the point of disambiguation. `candidate.id`
 * is the Node's qualified name (path + symbol, AD-19), so this strips just
 * the trailing `.<name>` symbol segment (when present) to surface the
 * distinguishing file/location part alone, e.g. an id of
 * `…fixtures/path-trace-basic.utilA.helper` for a `helper` candidate
 * becomes `…fixtures/path-trace-basic.utilA` — falls back to the full `id`
 * verbatim if it doesn't end with that exact suffix (a defensive case, not
 * one the current qualified-name scheme is expected to hit).
 */
function formatCandidateLocation(candidate: { id: string; name: string }): string {
  const symbolSuffix = `.${candidate.name}`;
  return candidate.id.endsWith(symbolSuffix) ? candidate.id.slice(0, -symbolSuffix.length) : candidate.id;
}

/**
 * Story 2.1 (Phase 3): one distinct shape glyph per `DeterministicRiskSignalType`
 * — Accessibility Floor requires shape distinction, never color alone. The
 * five values are geometrically distinct on sight (●/■/▲/◆/⊘) so Story
 * 2.2/2.3's own future families can pick their own equally-distinct shapes
 * without colliding with these (Design Notes). Rendered `aria-hidden` inside
 * each chip — the chip's own `aria-label` carries the accessible name, not
 * this glyph.
 */
export const DETERMINISTIC_SIGNAL_ICONS: Record<DeterministicRiskSignalType, string> = {
  complexity: '●',
  'cognitive-complexity': '■',
  hotspot: '▲',
  'blast-radius': '◆',
  'test-coverage-gap': '⊘',
};

/**
 * The full, never-truncated signal name for each chip's `aria-label` (e.g.
 * `"Complexity: 4"`) — the visible chip itself only ever shows icon+number
 * (Design Notes: mirrors `.code-map__node-affordance`'s own existing
 * "glyph+abbreviated-text, full meaning in `aria-label`" convention).
 */
const DETERMINISTIC_SIGNAL_LABELS: Record<DeterministicRiskSignalType, string> = {
  complexity: 'Complexity',
  'cognitive-complexity': 'Cognitive complexity',
  hotspot: 'Hotspot',
  'blast-radius': 'Blast radius',
  'test-coverage-gap': 'Test coverage gap',
};

/**
 * P0-5: the full accessible name / tooltip for one deterministic chip —
 * `"Complexity: 4"` for most signals. Blast Radius spells out its bound and
 * what it counts (`"Blast radius: 4 Nodes within 2 hops (callers and
 * callees)"`, built from `BLAST_RADIUS_DEFAULT_HOPS`) so the number never
 * reads as total impact. An unknown `type` (a future backend's value this
 * renderer's union doesn't know) falls back to the raw type string.
 * Every chip surface (canvas card, Health Audit row) goes through this, so
 * the wording can't fork.
 */
export function formatDeterministicSignalLabel(
  signal: Pick<DeterministicRiskSignal, 'type' | 'value' | 'severity'>,
): string {
  const label = DETERMINISTIC_SIGNAL_LABELS[signal.type] ?? signal.type;
  const severe = signal.severity === 'severe' ? ' (severe)' : '';
  if (signal.type === 'blast-radius') {
    const hops: number = BLAST_RADIUS_DEFAULT_HOPS;
    return `${label}: ${signal.value} Node${signal.value === 1 ? '' : 's'} within ${hops} hop${hops === 1 ? '' : 's'} (callers and callees)${severe}`;
  }
  return `${label}: ${signal.value}${severe}`;
}

/**
 * P1-1: the glyph a severe deterministic chip adds before its type icon —
 * red is never the only cue (Accessibility Floor), so a severe chip also
 * carries this and "(severe)" in its label. Moderate chips get neither.
 * Must differ from every `DETERMINISTIC_SIGNAL_ICONS` value (`▲` was
 * rejected in review because it is hotspot's own icon); a test pins that.
 */
export const SEVERE_SIGNAL_GLYPH = '!';

/**
 * Story 2.3 (Phase 4): severity ordering for the ingested-findings callout
 * — `blocker` > `major` > `minor` > `info` (Boundaries & Constraints,
 * lower rank number sorts first). `Array.prototype.sort` is stable per spec
 * (ES2019+), so sorting `node.riskSignals`' own filtered-in-order entries by
 * this rank alone already satisfies "ties by array order" — no secondary
 * comparator/index tracking needed.
 */
const INGESTED_SEVERITY_RANK: Record<IngestedRiskSignal['severity'], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/**
 * Cap on rendered ingested findings per Node (Boundaries & Constraints: "A
 * Node with more than 3 findings shows the 3 highest-severity ones ... plus
 * a '+N more' line — never renders every finding unbounded"). Ingested
 * findings are genuinely unbounded in count/length (Design Notes), unlike
 * the fixed five-member deterministic family above — this is this phase's
 * own resolution of UX-DR27's "never a wall of inline comments" warning.
 */
const MAX_RENDERED_INGESTED_FINDINGS = 3;

/**
 * The three independent, map-level family toggles (`showDeterministicSignals`
 * / `showLlmJudgment` / `showIngestedFindings`) every risk-signal surface
 * honors, passed as one object so a second surface can't silently honor a
 * subset of them.
 */
export type RiskSignalFamilyToggles = {
  showDeterministicSignals: boolean;
  showLlmJudgment: boolean;
  showIngestedFindings: boolean;
};

/**
 * P0-1 (2026-09-24): the deterministic-family selection, lifted verbatim out
 * of `CodeMapNodeCard` so both the card and the Node Detail panel run the
 * identical filter rather than forking it.
 *
 * Filtered, not assumed — `RiskSignal` is a real discriminated union
 * (`llm-judgment`/`ingested` are sibling shapes with no `type`/`value`), and
 * the chip loop below must never render a non-deterministic signal through
 * this one unfiltered. Written as an explicit type predicate so the result is
 * actually typed `DeterministicRiskSignal[]`, not still the wider union.
 * A repeat `type` is dropped defensively: the "at most one signal per
 * `DeterministicRiskSignalType`" invariant lives in a different module
 * (`graph-service/index.ts`'s `buildRiskSignals`) this file can't see, and a
 * future bug there would otherwise produce colliding React keys here. The
 * `Set` is typed against `DeterministicRiskSignalType` specifically so a
 * typo/drift against that union fails at compile time.
 */
function selectDeterministicSignals(signals: RiskSignal[]): DeterministicRiskSignal[] {
  const seen = new Set<DeterministicRiskSignalType>();
  return signals.filter((signal): signal is DeterministicRiskSignal => {
    if (signal.family !== 'deterministic' || seen.has(signal.type)) {
      return false;
    }
    seen.add(signal.type);
    return true;
  });
}

/**
 * At most one `'llm-judgment'` signal per Node by construction
 * (`buildRiskSignals`/the judgment generator never emit more than one), so
 * `find` (not `filter`) is enough — and unlike the deterministic family
 * there's no `type` discriminant to de-duplicate by. `undefined` when the
 * Node carries none: the callout is gated on this being defined, never an
 * empty/placeholder callout.
 */
function selectLlmJudgmentSignal(signals: RiskSignal[]): LlmJudgmentRiskSignal | undefined {
  return signals.find((signal): signal is LlmJudgmentRiskSignal => signal.family === 'llm-judgment');
}

/**
 * The ingested-PR-bot family — genuinely multi-valued per Node (multiple bots
 * can legitimately coexist on one Node), so no de-duplication: two distinct
 * findings from the same tool at the same location are both real. Sorted by
 * severity (`blocker` > `major` > `minor` > `info`, ties by array order via
 * `Array.prototype.sort`'s own stability guarantee) BEFORE any capping, so
 * the findings actually rendered are always the highest-severity ones.
 */
function selectIngestedSignals(signals: RiskSignal[]): IngestedRiskSignal[] {
  return signals
    .filter((signal): signal is IngestedRiskSignal => signal.family === 'ingested')
    .sort((a, b) => INGESTED_SEVERITY_RANK[a.severity] - INGESTED_SEVERITY_RANK[b.severity]);
}

/**
 * Whether `<NodeRiskSignalSections>` would render anything at all for these
 * signals under these toggles — the same three gates the component itself
 * applies, answered without rendering, so a caller that wraps it in a
 * labelled section (the Node Detail panel) can omit that wrapper entirely
 * rather than emitting an empty container (I/O matrix: "signals section
 * absent entirely, not an empty container").
 */
function hasVisibleRiskSignals(signals: RiskSignal[], toggles: RiskSignalFamilyToggles): boolean {
  if (toggles.showDeterministicSignals && selectDeterministicSignals(signals).length > 0) {
    return true;
  }
  if (toggles.showLlmJudgment) {
    const judgment = selectLlmJudgmentSignal(signals);
    if (judgment !== undefined && judgment.judgment.trim().length > 0) {
      return true;
    }
  }
  return toggles.showIngestedFindings && selectIngestedSignals(signals).length > 0;
}

/**
 * P0-1 (2026-09-24): every risk-signal section a Node can show, in one
 * shared renderer.
 *
 * Lifted verbatim out of `CodeMapNodeCard` (which now calls it) so the Node
 * Detail panel renders the *same* glyphs, labels, chips, callout and list
 * rather than a second, drifting copy — the spec's "extracted and shared,
 * never forked". Both surfaces therefore also honor the same three
 * map-level family toggles by construction.
 *
 * Renders `null` when nothing is visible, so neither surface ever produces
 * an empty row/container.
 *
 * Exported only so `CodeMap.blastRadius.test.ts` can render the canvas chip
 * strip directly (P0-5). That test calls this as a plain function, so it must
 * stay HOOKLESS — same pact as `HealthAuditClusterRow`.
 */
export function NodeRiskSignalSections({
  signals,
  toggles,
}: {
  signals: RiskSignal[];
  toggles: RiskSignalFamilyToggles;
}) {
  const deterministicSignals = selectDeterministicSignals(signals);
  const llmJudgmentSignal = selectLlmJudgmentSignal(signals);
  const ingestedSignals = selectIngestedSignals(signals);
  const visibleIngestedSignals = ingestedSignals.slice(0, MAX_RENDERED_INGESTED_FINDINGS);
  const hiddenIngestedSignalCount = ingestedSignals.length - visibleIngestedSignals.length;

  if (!hasVisibleRiskSignals(signals, toggles)) {
    return null;
  }

  return (
    <>
      {/* Story 2.1 (Phase 3): the deterministic risk-signal strip — one chip
          per `riskSignals` entry with `family === 'deterministic'`, gated on
          the map-level toggle AND on actually having at least one such
          signal (Boundaries & Constraints: "A Node with `riskSignals: []`
          ... renders no signal strip at all — never an empty row"). Each
          chip: `role="img"` — `aria-label` alone on a bare, non-interactive
          `<span>` (implicit role `generic`) is not reliably exposed to
          assistive technology; `role="img"` is the standard fix for a static
          icon+label combination. `title` gives sighted mouse users — who
          never see `aria-label` — the same glyph -> meaning mapping via the
          native hover tooltip. An unrecognized `signal.type` (e.g. a runtime
          value from a future backend build that doesn't match this
          renderer's still-five-member union) falls back to `'?'`/the raw
          type string rather than rendering a literal "undefined". */}
      {toggles.showDeterministicSignals && deterministicSignals.length > 0 && (
        <div className="code-map__node-signal-strip">
          {deterministicSignals.map((signal) => {
            const label = formatDeterministicSignalLabel(signal);
            const icon = DETERMINISTIC_SIGNAL_ICONS[signal.type] ?? '?';
            return (
              <span
                key={signal.type}
                className={
                  signal.severity === 'severe'
                    ? 'code-map__signal-chip code-map__signal-chip--severe'
                    : 'code-map__signal-chip'
                }
                role="img"
                aria-label={label}
                title={label}
              >
                {signal.severity === 'severe' && <span aria-hidden="true">{SEVERE_SIGNAL_GLYPH}</span>}
                <span aria-hidden="true">{icon}</span>
                {signal.value}
              </span>
            );
          })}
        </div>
      )}
      {/* Story 2.2 (Phase 3): the LLM-judgment risk-signal callout — rendered
          after the deterministic strip above, gated on its own independent
          toggle AND on the Node actually carrying an `'llm-judgment'` signal
          (never an empty/placeholder callout). Deliberately never
          `.code-map__signal-chip`'s classes — dashed border, icon+full
          sentence, not a solid-border pill (FR8/UX-DR7: "no shared visual
          language between the two families"). The visible copy leads with
          "AI judgment:" so it reads as an inference, never with a
          deterministic signal's unqualified-measurement confidence. The
          blank/whitespace-only guard closes the gap between "never an
          empty/placeholder callout" and what the JSX actually checked. */}
      {toggles.showLlmJudgment && llmJudgmentSignal !== undefined && llmJudgmentSignal.judgment.trim().length > 0 && (
        <p className="code-map__llm-judgment" title={`AI judgment: ${llmJudgmentSignal.judgment}`}>
          <span aria-hidden="true">✦</span> AI judgment: {llmJudgmentSignal.judgment}
        </p>
      )}
      {/* Story 2.3 (Phase 4): the ingested-PR-bot-findings callout — its own
          distinct visual treatment (Boundaries & Constraints: "never
          `.code-map__signal-chip`'s classes, never llm-judgment's callout
          classes"), gated on its own independent toggle AND on the Node
          actually carrying at least one `'ingested'` signal. Each finding is
          its own row, always naming its severity as real visible text —
          never color/icon alone (Accessibility Floor) — plus the originating
          tool and finding text (FR9, AD-12). Rows are capped at
          `MAX_RENDERED_INGESTED_FINDINGS` plus an explicit "+N more" line
          when more exist — never an unbounded wall of inline comments
          (UX-DR27). `key={index}` (review-pattern precedent: `toFlowEdges`
          keys on index too) since a raw ingested finding carries no
          identifier of its own to key by. */}
      {toggles.showIngestedFindings && ingestedSignals.length > 0 && (
        <ul className="code-map__ingested-findings">
          {visibleIngestedSignals.map((signal, index) => (
            <li
              key={index}
              className="code-map__ingested-finding"
              title={`${signal.sourceTool} (${signal.severity}): ${signal.finding}`}
            >
              <span aria-hidden="true">⚑</span>
              <span className="code-map__ingested-finding-severity">{signal.severity}</span>
              <span className="code-map__ingested-finding-tool">{signal.sourceTool}:</span>
              <span className="code-map__ingested-finding-text">{signal.finding}</span>
            </li>
          ))}
          {hiddenIngestedSignalCount > 0 && (
            <li className="code-map__ingested-findings-more">+{hiddenIngestedSignalCount} more</li>
          )}
        </ul>
      )}
    </>
  );
}

/**
 * The custom Node component: identifier verbatim, monospace (Always),
 * plus its one-line summary/pending/coverage-gap state (Story 1.5 Phase 2 —
 * see this file's module doc comment). `tabIndex`/`role="button"`/
 * `onKeyDown` give activation a keyboard path (Enter/Space) alongside the
 * mouse click `<ReactFlow>`'s own `onNodeClick` already handles — the
 * product's stated Accessibility Floor requires map traversal to have one,
 * and this was mouse-only before (review finding). P0-1 (2026-09-24):
 * activating the card — by either route — now opens the Node Detail panel
 * (EXPERIENCE.md's IA row, "Node detail | Click/select any Node"); source
 * viewing moved to its own pill in the affordance row below.
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
  const {
    node,
    onActivate,
    onShowNeighbors,
    onOpenSource,
    callerCount,
    calleeCount,
    noSummaryBackendAvailable,
    cloudSelectedNoKey,
    showDeterministicSignals,
    showLlmJudgment,
    showIngestedFindings,
    isChanged,
  } = data;
  return (
    <div
      className={`code-map__node${isChanged ? ' code-map__node--changed' : ''}`}
      title={`${node.file}:${node.startLine}-${node.endLine}`}
      tabIndex={0}
      role="button"
      aria-label={`${node.kind} ${node.name}${isChanged ? ', changed' : ''}, open Node detail`}
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
      {/* Story 3.1 (Phase 2): PR Review Mode's changed-Node treatment —
          never color-only (Accessibility Floor): this visible "Changed"
          text label carries the meaning on its own; `code-map__node--changed`
          above only adds a border as reinforcement, exactly the same
          "text label + border reinforcement" split every other non-color-only
          treatment in this card already uses (Coverage Gap/staleness/the
          Actionable Notices above). `role="status"` mirrors that same
          precedent (e.g. `.code-map__node-staleness`). */}
      {isChanged && (
        <p className="code-map__node-changed-badge" role="status">
          Changed
        </p>
      )}
      {/* Story 1.5 Phase 2: one-line summary / pending / coverage-gap — a
          Node's file being in the current index's coverage gap set (FR5)
          is a real, distinct signal from an ordinary "not generated yet"
          state, so it gets its own icon+text indicator rather than looking
          like a summary that just hasn't arrived (Boundaries &
          Constraints: "never a confident-looking placeholder", and the
          product's Accessibility Floor: "signal/trust states never
          color-only"). */}
      {node.summaryStatus === 'ready' && node.summary !== undefined && (
        <p className="code-map__node-summary">{node.summary}</p>
      )}
      {/* Story 1.8 (Phase 3): a `'ready'` Node's summary can still drift out
          of sync with its source — that's a different failure mode from
          Coverage Gap (no summary was ever possible) and Actionable Notices
          (no summary backend), so it gets its own icon (never `⚠`, already
          spoken for by those) and always renders alongside the summary text
          rather than replacing it or hiding behind hover/click (Boundaries
          & Constraints). Non-color-only (Accessibility Floor): the icon and
          exact copy carry the signal on their own.

          The `node.summary !== undefined` guard mirrors the summary
          paragraph's own condition just above (review finding, Low):
          `classifyNode` only ever returns `stale` alongside a defined
          `summary` today, but `CodeMapNode.summary` is independently
          optional in the type, so nothing enforces that pairing at the type
          level — without this guard, a future `classifyNode`/construction-
          site change could produce `stale: true` with no summary text
          rendered above it, leaving the staleness note floating with
          nothing for it to describe. */}
      {node.summaryStatus === 'ready' && node.summary !== undefined && node.stale === true && (
        <p className="code-map__node-staleness" role="status">
          <span aria-hidden="true">⏳</span> Summary may be stale — source changed since generation
        </p>
      )}
      {/* Story 1.6 (Phase 2): a `'pending'` Node that will genuinely never
          get a summary this session — either backend is unusable — renders
          the matching Actionable Notice instead of the ordinary "Summary
          pending…" text (Boundaries & Constraints: never a silent empty
          summary; UX-DR17: "cloud selected, no key" is the more specific
          message and takes priority when both technically apply — already
          resolved in App.tsx, so at most one of these two is ever true
          here). */}
      {node.summaryStatus === 'pending' && cloudSelectedNoKey && (
        <p className="code-map__node-summary code-map__node-summary--notice" role="status">
          <span aria-hidden="true">☁</span> Cloud is selected but no API key is set — add one in
          Settings.
        </p>
      )}
      {node.summaryStatus === 'pending' && !cloudSelectedNoKey && noSummaryBackendAvailable && (
        <p className="code-map__node-summary code-map__node-summary--notice" role="status">
          <span aria-hidden="true">⚠</span> No summary backend is available — check Settings.
        </p>
      )}
      {node.summaryStatus === 'pending' && !cloudSelectedNoKey && !noSummaryBackendAvailable && (
        <p className="code-map__node-summary code-map__node-summary--pending" role="status">
          Summary pending…
        </p>
      )}
      {node.summaryStatus === 'coverage-gap' && (
        <p className="code-map__node-summary code-map__node-summary--coverage-gap">
          <span aria-hidden="true">⚠</span> Coverage gap — no summary
        </p>
      )}
      {/* P0-1 (2026-09-24): every risk-signal section this card can show is
          now rendered by the shared `NodeRiskSignalSections` the Node Detail
          panel also uses — extracted, never forked, so the two surfaces
          cannot drift in glyphs, labels, chip markup, ordering, caps or
          family-toggle handling. */}
      <NodeRiskSignalSections
        signals={node.riskSignals}
        toggles={{ showDeterministicSignals, showLlmJudgment, showIngestedFindings }}
      />
      {/* The affordance row (Story 1.4, + the Source pill added by P0-1 on
          2026-09-24): lightweight alternatives to precisely clicking a thin
          edge line, plus the Node's own one-action route to its source.
          The caller/callee pills stay hidden/inert entirely (not just
          visually) when the count is 0; the Source pill has no such
          condition — every Node has source to show — so the row itself is
          now unconditional rather than gated on any pill being relevant.

          `stopPropagation` on mousedown, click, AND keydown keeps these
          nested controls from also being read as an interaction with the
          Node card itself: without it on keydown too (review finding — a
          concrete bug, not just a style nit), pressing Enter/Space while a
          button is focused still bubbles the keydown up to the card's own
          `onKeyDown` above, firing `onActivate` (which since P0-1 opens
          Node Detail) at the same time as this pill's own action — the
          keydown that activates a native `<button>` propagates regardless
          of the button's own click response to it. Also initiating React
          Flow's own node-drag/selection handling is what the mousedown stop
          guards against. */}
      <div className="code-map__node-affordances">
        {/* P2-4: each pill draws a 1-hop neighbour trace (origin + every
            neighbour in that direction + the edges between them) rather
            than jumping to the first neighbour only. */}
        <NodeNeighborPills
          node={node}
          callerCount={callerCount}
          calleeCount={calleeCount}
          onShowNeighbors={onShowNeighbors}
        />
        {/* P0-1 (2026-09-24): the Source pill. Activating the card itself
            now opens Node Detail (the IA row's "Node detail | Click/select
            any Node"), so source viewing gets its own affordance rather
            than losing its entry point — it stays exactly one action away,
            which is what the Interaction Primitives' "zero friction by
            design" trust mechanism actually rests on. Unconditional: every
            Node has a source range. Follows the caller/callee pattern
            above verbatim, all three `stopPropagation` handlers included
            — the `onKeyDown` one is load-bearing here, since without it
            Enter/Space on this pill would bubble to the card and open Node
            Detail at the same time as the source viewer. */}
        <button
          type="button"
          className="code-map__node-affordance code-map__node-affordance--source"
          aria-label={`Open source for ${node.name}`}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenSource(node);
          }}
        >
          {'</>'} source
        </button>
      </div>
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
 *
 * P0-2b: Story 4.1's `riskCount` tint prop is gone. It only ever had a
 * non-zero value in Health Audit Mode, and that mode no longer renders a
 * canvas — so a cluster and a health tint can never coexist again. The
 * heat a user came for lives on the cluster-card grid instead
 * (`HealthAuditClusterGrid`).
 */
type CodeMapClusterFlowNode = FlowNode<
  {
    cluster: Cluster;
    onExpand: (cluster: Cluster) => void;
    /** P3-11: members that are changed Nodes (PR Review). `0` renders no changed marker. */
    changedCount: number;
  },
  'codeMapCluster'
>;

/**
 * Story 4.1's signal-count bucket (Design Notes: "no normalized severity
 * score exists across signal types ... a simple signal-count bucket, not a
 * cross-type weighted score"): `0` → no tint, `1-2` → light, `3-5` →
 * medium, `6+` → strong. Returns `null` for `0` so the caller can render no
 * modifier class/tint at all rather than a zero-opacity one.
 */
function riskCountBucket(riskCount: number): 'low' | 'medium' | 'high' | null {
  if (riskCount <= 0) {
    return null;
  }
  if (riskCount <= 2) {
    return 'low';
  }
  if (riskCount <= 5) {
    return 'medium';
  }
  return 'high';
}

/**
 * P0-2a: the Node's LLM judgment if — and only if — it is one that actually
 * counts and renders. `selectLlmJudgmentSignal` finds the judgment;
 * this adds the blank-text gate, because a whitespace-only judgment renders
 * nothing and so must not be counted either (the gap Story 4.1's review
 * round had to close once already).
 *
 * One definition, deliberately: `riskCountForNode` and
 * `groupNodesIntoHealthClusters`' `llmJudgment` field both call it, so a
 * Node can never be counted as carrying a judgment while the field that is
 * supposed to show it is absent, or vice versa.
 */
function selectCountedLlmJudgment(signals: RiskSignal[]): LlmJudgmentRiskSignal | undefined {
  const judgment = selectLlmJudgmentSignal(signals);
  return judgment !== undefined && judgment.judgment.trim().length > 0 ? judgment : undefined;
}

/**
 * P0-2a: the per-Node risk-signal count Health Audit Mode ranks by —
 * deterministic signals (de-duplicated per `DeterministicRiskSignalType` by
 * `selectDeterministicSignals`) plus one for a judgment that passes
 * `selectCountedLlmJudgment`. `family: 'ingested'` is excluded: that is
 * Epic 3's PR-bot-findings concept, not part of Epic 2's Risk Overlay.
 *
 * P0-2b: `groupNodesIntoHealthClusters` is now the only caller. The Code
 * Map's LOD cluster tint used to be the second one, aggregating these same
 * per-Node counts into `clusterRiskCounts`; that tint is gone (it could only
 * ever appear below `LOD_ZOOM_THRESHOLD`, and Health Audit Mode no longer
 * renders a canvas at all), so there is nothing left for this count to drift
 * against.
 */
export function riskCountForNode(node: CodeMapNode): number {
  const judgmentCount = selectCountedLlmJudgment(node.riskSignals) !== undefined ? 1 : 0;
  return selectDeterministicSignals(node.riskSignals).length + judgmentCount;
}

/**
 * P0-2a: a cluster's heat band. One-to-one with `riskCountBucket`'s own
 * four outcomes — `null` → `'healthy'`, `'low'` → `'cool'`, `'medium'` →
 * `'warm'`, `'high'` → `'hot'` — so the banding itself is reused verbatim
 * and nothing new is thresholded. The rename is only so a caller never has
 * to render `null` as a band: a clean repo's cluster is ordinary output
 * carrying `'healthy'`, never an absent heat.
 *
 * DESIGN.md's `components.health-cluster-card` defines three heat-dot
 * colors, with `heat-dot-cool` already being `{colors.healthy}` — so
 * `'cool'` and `'healthy'` share a color there while staying distinct here,
 * and no information is lost in either direction.
 */
export type HealthClusterHeat = 'hot' | 'warm' | 'cool' | 'healthy';

const HEAT_BY_BUCKET = {
  high: 'hot',
  medium: 'warm',
  low: 'cool',
} as const satisfies Record<Exclude<ReturnType<typeof riskCountBucket>, null>, HealthClusterHeat>;

/**
 * P0-2a's banding, as a function. `groupNodesIntoHealthClusters` bands a
 * cluster's `heatCount` through this, and P0-2b's grid bands each ROW's own
 * `riskCount` through the same call — so the row's colour and the card's
 * colour can never come from two separately-maintained thresholds (Always:
 * "All grouping, ordering, capping, and heat banding come from 2a's helper —
 * no second copy"). Extracted, not re-implemented: this is verbatim the
 * expression the helper already inlined.
 */
export function heatForRiskCount(riskCount: number): HealthClusterHeat {
  const bucket = riskCountBucket(riskCount);
  return bucket === null ? 'healthy' : HEAT_BY_BUCKET[bucket];
}

/**
 * P0-2a: one Node inside a health cluster, carrying the count it was ranked
 * by and the signals behind that count — so a caller renders rows from real
 * signal values (`DETERMINISTIC_SIGNAL_LABELS`/`_ICONS` plus each signal's
 * own `value`) and never has to re-derive, or invent, a metric.
 */
export interface HealthClusterNode {
  node: CodeMapNode;
  /** `riskCountForNode(node)` — deterministic signals plus a non-blank judgment, never `ingested`. */
  riskCount: number;
  /** De-duplicated per `type`, then ordered by `type` ascending so the row order is total. */
  deterministicSignals: DeterministicRiskSignal[];
  /** Present only when the Node carries a judgment with non-whitespace text — the same gate `riskCountForNode` counts by. */
  llmJudgment?: LlmJudgmentRiskSignal;
}

/** P0-2a: one module cluster — the Nodes under a single containing directory. */
export interface HealthCluster {
  /**
   * The full containing directory, POSIX-relative (`api/internal/service`),
   * or `HEALTH_CLUSTER_ROOT_KEY` for a file that sits at the repo root.
   * Unique across the returned list, which is what makes the cluster
   * ordering below total.
   */
  directory: string;
  /** What to display. Never the bare `'.'` sentinel — see `HEALTH_CLUSTER_ROOT_LABEL`. */
  label: string;
  /** Banded from `heatCount` via `riskCountBucket`. */
  heat: HealthClusterHeat;
  /**
   * The highest per-Node `riskCount` in the cluster — never the sum, so one
   * bad Node makes a cluster hot rather than a large directory doing so by
   * volume. Carried so a caller can state the evidence next to the band
   * ("hot · 7 signals") instead of showing a bare adjective.
   *
   * The MAX is what makes a health cluster a module being ranked against
   * other modules rather than a bag whose score grows with its size. (Story
   * 4.1's LOD cluster tint banded the SUM instead, correctly for a viewport
   * artifact; P0-2b deleted it, so that divergence no longer exists.)
   */
  heatCount: number;
  /** Sum of every member Node's `riskCount`, including Nodes dropped by the cap. The secondary ordering key. */
  totalRiskCount: number;
  /** Capped at `HEALTH_CLUSTER_NODE_LIMIT`, ordered by `riskCount` desc, then `name` asc, then `id` asc. */
  nodes: HealthClusterNode[];
  /** How many member Nodes the cap left out. `0` when all of them fit. */
  remainingNodeCount: number;
}

/** P0-2a: the helper's whole return shape — a settled contract with `spec-p0-2b-health-audit-surface.md`. */
export interface HealthClusterGrouping {
  clusters: HealthCluster[];
  /** How many clusters `HEALTH_CLUSTER_LIMIT` left out. `0` when all of them fit. */
  remainingClusterCount: number;
}

/**
 * The directory key for a Node whose `file` has no `/` at all (`main.ts`).
 * A stable sentinel rather than `''`, so the root cluster can never collide
 * with, or be mistaken for, a missing key.
 */
export const HEALTH_CLUSTER_ROOT_KEY = '.';

/** What to show for `HEALTH_CLUSTER_ROOT_KEY` — the sentinel is never rendered raw. */
export const HEALTH_CLUSTER_ROOT_LABEL = '(repo root)';

/**
 * Display caps. Renderer-local presentation limits, never a Graph Service
 * concern: the full Node set is still grouped and counted, and whatever the
 * caps drop is reported as an explicit remainder rather than silently
 * vanishing (AD-13's explicit-result-state pattern applied to truncation).
 */
export const HEALTH_CLUSTER_LIMIT = 12;
export const HEALTH_CLUSTER_NODE_LIMIT = 8;

/**
 * Plain code-unit ordering, deliberately NOT `localeCompare`: that consults
 * the runtime's ICU data, so the same input could order differently on two
 * machines. Every tiebreak below has to be reproducible, not merely stable
 * within one process.
 */
function compareAscending(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * P0-2a: group `CodeMapNode[]` into Health Audit Mode's ranked module
 * clusters (UJ-2 step 3). Pure — no React, DOM, clock, or IPC — so the
 * whole thing is unit-testable and the surface spec that consumes it
 * (P0-2b) owns rendering only.
 *
 * Grouping is the containing directory and nothing else: no semantic, AI, or
 * heuristic module inference. Ranking is signal COUNT, not severity. P1-1
 * added `DeterministicRiskSignal.severity`, but deliberately left this
 * ranking and count unchanged (its Never list); severity shows only on the
 * row's chips.
 *
 * Every comparison chain ends in a key that is unique at its level
 * (`directory` for clusters, `id` for Nodes), so ordering is total and no
 * tie ever falls through to input order — running this twice over the same
 * input yields deeply equal results, array order included.
 */
export function groupNodesIntoHealthClusters(nodes: readonly CodeMapNode[]): HealthClusterGrouping {
  const byDirectory = new Map<string, HealthClusterNode[]>();

  for (const node of nodes) {
    const separator = node.file.lastIndexOf('/');
    const directory = separator > 0 ? node.file.slice(0, separator) : HEALTH_CLUSTER_ROOT_KEY;
    const judgment = selectCountedLlmJudgment(node.riskSignals);
    const members = byDirectory.get(directory);
    const member: HealthClusterNode = {
      node,
      riskCount: riskCountForNode(node),
      deterministicSignals: selectDeterministicSignals(node.riskSignals).sort((a, b) =>
        compareAscending(a.type, b.type),
      ),
      ...(judgment !== undefined ? { llmJudgment: judgment } : {}),
    };
    if (members === undefined) {
      byDirectory.set(directory, [member]);
    } else {
      members.push(member);
    }
  }

  const clusters: HealthCluster[] = [];
  for (const [directory, members] of byDirectory) {
    let heatCount = 0;
    let totalRiskCount = 0;
    for (const member of members) {
      heatCount = Math.max(heatCount, member.riskCount);
      totalRiskCount += member.riskCount;
    }
    members.sort(
      (a, b) =>
        b.riskCount - a.riskCount ||
        compareAscending(a.node.name, b.node.name) ||
        compareAscending(a.node.id, b.node.id),
    );
    clusters.push({
      directory,
      label: directory === HEALTH_CLUSTER_ROOT_KEY ? HEALTH_CLUSTER_ROOT_LABEL : directory,
      heat: heatForRiskCount(heatCount),
      heatCount,
      totalRiskCount,
      nodes: members.slice(0, HEALTH_CLUSTER_NODE_LIMIT),
      remainingNodeCount: Math.max(0, members.length - HEALTH_CLUSTER_NODE_LIMIT),
    });
  }

  clusters.sort(
    (a, b) =>
      b.heatCount - a.heatCount ||
      b.totalRiskCount - a.totalRiskCount ||
      compareAscending(a.directory, b.directory),
  );

  return {
    clusters: clusters.slice(0, HEALTH_CLUSTER_LIMIT),
    remainingClusterCount: Math.max(0, clusters.length - HEALTH_CLUSTER_LIMIT),
  };
}

/** The three modes `App.tsx` switches between, as one name both this file's prop and its render gates use. */
export type CodeMapMode = 'codeMap' | 'prReview' | 'healthAudit';

/**
 * P0-2b: which of this component's mutually-exclusive surfaces are on, for a
 * given mode and a given "is there a real, showable map here" (`mapIsRenderable`).
 *
 * One record rather than three same-shaped predicates, because three
 * `(CodeMapMode, boolean) => boolean` functions are interchangeable at a call
 * site: the compiler cannot tell a canvas gate from a search gate, so swapping
 * one for another in the JSX type-checks and renders two surfaces at once. A
 * single mapping makes the WHOLE decision one value a test can pin
 * exhaustively, and each JSX gate a named property read.
 *
 * (What a test still cannot reach: which property each JSX block actually
 * reads. This repo's runner is `node --test` with no DOM — see `docs/agent.md`
 * — so the wiring itself is covered by the spec's manual checks, not here.)
 */
export interface CodeMapSurfaces {
  /** `<ReactFlow>` and the Back/Forward history toolbar that floats over it. */
  canvas: boolean;
  /** Health Audit Mode's cluster-card grid. Replaces the canvas; never renders beside one. */
  healthAuditGrid: boolean;
  /**
   * The Path Trace query input. On in every mode: "search is always
   * reachable, not mode-gated". Submitting from Health Audit Mode switches the
   * app to Code Map Mode so the route lands on a canvas (FR-10) — see
   * `resolvePathTraceSubmit`.
   */
  pathTraceInput: boolean;
  /**
   * The Path Trace RESULT surfaces — the found route's step list, P2-4's
   * neighbour-trace panel, the disambiguation candidate list, and the
   * no-path/error notices.
   *
   * Tied to `canvas`, NOT to `pathTraceInput`, and that is deliberate: every
   * one of them describes or acts on a route drawn across the canvas (a
   * candidate click re-runs the trace and fits the viewport to it), so
   * offering them with no canvas mounted is offering a control for something
   * that is not there. Nothing resets `pathTrace` on a mode change, so a user
   * who traces and then switches to Health Audit really would otherwise be
   * left holding a live, clickable route list over a grid.
   */
  pathTraceResult: boolean;
}

/**
 * P1-5 + P1-6: "there is a real, showable map here" — a loaded fetch with at
 * least one Node. Deliberately says nothing about PR Review's diff-scope
 * notices: those explain a PR Review result and render ABOVE the map, so they
 * never take the canvas, the Back/Forward history or Path Trace away with
 * them. Only a fetch error or an empty map (their own notices, no canvas to
 * draw a route on) make this false.
 */
export function hasShowableMap(fetchState: FetchState): boolean {
  return fetchState.status === 'ready' && fetchState.nodes.length > 0;
}

/**
 * P0-2b: the asymmetry at the heart of this spec, resolved in one place so it
 * cannot be collapsed back by accident.
 *
 * `mapIsRenderable` is the single "there is a real, showable map here"
 * derivation three JSX gates used to share verbatim. Health Audit Mode splits
 * it, because it renders a DIFFERENT SURFACE rather than a variant of the
 * canvas: the canvas and its history toolbar go, the cluster-card grid takes
 * their place, and the Path Trace INPUT stays while its RESULT surfaces follow
 * the canvas.
 *
 * Do not "simplify" this back into one flag: `canvas` and `healthAuditGrid`
 * are opposites, `pathTraceInput` deliberately agrees with neither, and that
 * disagreement is the whole decision this spec makes.
 */
export function resolveCodeMapSurfaces(mode: CodeMapMode, mapIsRenderable: boolean): CodeMapSurfaces {
  const canvas = mapIsRenderable && mode !== 'healthAudit';
  return {
    canvas,
    healthAuditGrid: mapIsRenderable && mode === 'healthAudit',
    pathTraceInput: mapIsRenderable,
    pathTraceResult: canvas,
  };
}

/** What `CodeMap` renders for the current mode, fetch and PR Review diff scope. */
export interface PrReviewView {
  /**
   * The diff-scope Actionable Notice to show above the map, or `null` for
   * none. Non-null only in PR Review Mode, with a showable map, for one of
   * the three `DiffScopeNoticeStatus` results.
   */
  noticeStatus: DiffScopeNoticeStatus | null;
  /** Which surfaces are on — see `CodeMapSurfaces`. */
  surfaces: CodeMapSurfaces;
}

/**
 * P1-5 + P1-6: the one derivation `CodeMap` reads for "is there a PR Review
 * notice" and "which surfaces are on", kept together so the invariant between
 * them is pinned in one place: a diff-scope notice is an ANNOTATION on the
 * map, not a replacement for it. The notice status is not an input to
 * `surfaces` — with a showable map, PR Review keeps its canvas (and the
 * Back/Forward history over it), the Path Trace input and the Path Trace
 * results whatever the diff scope reports, so a benign "no changes" never
 * looks like the project was lost and search stays reachable.
 *
 * Without a showable map (loading, fetch error, empty map) there is no notice
 * either: those states have their own, more fundamental notice and no canvas.
 * `diffScopeState` survives a mode switch, so the notice is also gated on
 * `mode` — a `'no-changes'` left over from PR Review shows nothing in Code
 * Map Mode.
 */
export function resolvePrReviewView(
  mode: CodeMapMode,
  fetchState: FetchState,
  diffScopeState: DiffScopeState,
): PrReviewView {
  const showable = hasShowableMap(fetchState);
  const noticeStatus =
    mode === 'prReview' &&
    showable &&
    (diffScopeState.status === 'no-changes' ||
      diffScopeState.status === 'not-a-git-repo' ||
      diffScopeState.status === 'no-base-ref-resolvable')
      ? diffScopeState.status
      : null;
  return { noticeStatus, surfaces: resolveCodeMapSurfaces(mode, showable) };
}

/**
 * P1-5 + P1-6: the id of the PR Review notice's live region, which the
 * base-ref input names in `aria-describedby`. A module-scope constant rather
 * than a `useId`, so `PrReviewDiffScopeNoticeRegion` stays hookless (the same
 * convention `HealthAuditClusterGrid` follows); `CodeMap` mounts once.
 */
export const PR_REVIEW_NOTICE_ID = 'code-map-pr-review-notice';

/**
 * P1-5 + P1-6: the diff-scope Actionable Notice's sentence, or nothing for a
 * `null` status. MUST STAY HOOKLESS: `CodeMap.prReviewNotice.test.ts` calls
 * it directly, with no renderer.
 */
export function PrReviewDiffScopeNotice({ status }: { status: DiffScopeNoticeStatus | null }) {
  if (status === null) {
    return null;
  }
  return <ActionableNotice tone={DIFF_SCOPE_NOTICE_TONES[status]}>{formatDiffScopeNotice(status)}</ActionableNotice>;
}

/**
 * P1-5 + P1-6: the notice's `role="status"` live region. Always mounted
 * inside the PR Review block, with only its content changing — a live region
 * that appears together with its text is often not announced. The notice
 * inside it is gated on `status`. MUST STAY HOOKLESS, same as
 * `PrReviewDiffScopeNotice`.
 */
export function PrReviewDiffScopeNoticeRegion({ status }: { status: DiffScopeNoticeStatus | null }) {
  return (
    <div id={PR_REVIEW_NOTICE_ID} className="code-map__pr-review-notice-region" role="status">
      {status !== null && <PrReviewDiffScopeNotice status={status} />}
    </div>
  );
}

/**
 * P0-5: PR Review's initial Blast Radius stepper depth for a resolved result
 * whose farthest Node is `maxDepth` hops away — `BLAST_RADIUS_DEFAULT_HOPS`
 * (the badge's own bound), clamped into the stepper's range `[1, maxDepth]`
 * so a scope whose farthest Node is 1 hop away shows "1-hop", never a depth
 * that doesn't exist. A `maxDepth` of 0 (nothing reachable; the stepper is
 * not rendered) still yields 1, the stepper's floor; so does a non-finite
 * `maxDepth` (`NaN`/`Infinity`), and a fractional one is floored first.
 */
export function initialBlastRadiusDepth(maxDepth: number): number {
  if (!Number.isFinite(maxDepth)) {
    return 1;
  }
  return Math.max(1, Math.min(BLAST_RADIUS_DEFAULT_HOPS, Math.floor(maxDepth)));
}

/**
 * P0-2b: what a Path Trace submit does, in order. An ordered effect list
 * rather than a `{query, switchMode}` record, because the ORDER is the part
 * that matters and the part a test must be able to fail: the mode switch has
 * to be requested BEFORE the trace runs, so `setMode` is flushed and
 * `<ReactFlow>` has mounted and called `onInit` by the time the `tracePath`
 * IPC round trip resolves and `fitViewToPath` reaches for its instance.
 *
 * `handlePathTraceSubmit` is a dumb interpreter of this list — it decides
 * nothing itself. That is the point: the previous version of this logic lived
 * entirely inside the handler, so its test could only re-transcribe it and
 * assert the transcription (the self-referential-assertion failure mode P0-2a's
 * review round 1 had to fix once already).
 *
 * The trimmed-empty rejection lives here too, and returns NO effects at all:
 * `traceCallPath`'s substring tier (`name.includes('')`) is vacuously true, so
 * an empty query would match every Node — and an empty submit must not move
 * the user off the surface they are reading either.
 */
export type PathTraceSubmitEffect =
  | { readonly kind: 'requestCodeMapMode' }
  | { readonly kind: 'runPathTrace'; readonly query: string };

export function resolvePathTraceSubmit(
  mode: CodeMapMode,
  rawQuery: string,
): PathTraceSubmitEffect[] {
  const query = rawQuery.trim();
  if (query.length === 0) {
    return [];
  }
  return mode === 'healthAudit'
    ? [{ kind: 'requestCodeMapMode' }, { kind: 'runPathTrace', query }]
    : [{ kind: 'runPathTrace', query }];
}

/**
 * P0-2b: a cluster's heat label. Always the band AND the count it came from
 * (Always: never a bare adjective), never colour alone — this text sits beside
 * the dot and is what a screen reader reads.
 *
 * It also says WHAT the number is. `heatCount` is the highest count on any
 * SINGLE Node in the cluster, never the sum, so a bare "hot · 7 signals" on a
 * card listing eight Nodes reads as a module total it is not. When the module
 * carries more than its worst Node does, `totalRiskCount` is stated alongside
 * it; when the two are equal there is nothing to disambiguate and the clause
 * is dropped, which is also what a clean repo's "healthy · 0 signals on its
 * worst Node" reads as — ordinary output stating an explicit zero (P3-9).
 */
export function formatHealthClusterHeat(
  heat: HealthClusterHeat,
  heatCount: number,
  totalRiskCount: number,
): string {
  const worst = `${heat} · ${heatCount} signal${heatCount === 1 ? '' : 's'} on its worst Node`;
  return totalRiskCount === heatCount ? worst : `${worst}, ${totalRiskCount} in the module`;
}

/**
 * P0-2b: the per-cluster cap's explicit remainder (AD-13's
 * explicit-result-state pattern applied to truncation) — never silent
 * truncation. Pure and exported so the pluralization is pinned by a test
 * rather than by reading the JSX.
 */
export function formatRemainingNodes(remainingNodeCount: number): string {
  return `+${remainingNodeCount} more Node${remainingNodeCount === 1 ? '' : 's'}`;
}

/**
 * P1-2: the Node Detail panel's per-Node summary action, worded for the
 * Node's state — "Regenerate" for a `'ready'` Node, "Generate summary" for a
 * `'pending'` one (a Node whose generation failed stays `'pending'` all
 * session, so this is its only retry), and `null` for `'coverage-gap'`,
 * which the service rejects outright. Both labels run through the same
 * `regenerateNode` IPC. `busyLabel` is the in-flight button text.
 */
export function nodeDetailSummaryAction(
  summaryStatus: SummaryStatus,
): { label: string; busyLabel: string } | null {
  switch (summaryStatus) {
    case 'ready':
      return { label: 'Regenerate', busyLabel: 'Regenerating…' };
    case 'pending':
      return { label: 'Generate summary', busyLabel: 'Generating…' };
    case 'coverage-gap':
      return null;
    default: {
      // Exhaustive: a new `SummaryStatus` member fails to compile here. At
      // runtime an unknown value arriving over IPC offers no action.
      const unknownStatus: never = summaryStatus;
      void unknownStatus;
      return null;
    }
  }
}

/**
 * P2-12: Node Detail's module line — the directory of the Node's `file`, with
 * its trailing slash (`billing/pay.ts` → `billing/`), or `null` for a file at
 * the project root, whose module line is omitted rather than rendered empty.
 * Defensive about the path's shape even though AD-19 promises POSIX-relative:
 * backslashes become `/`, a leading `./` or `/` and a trailing `/` are
 * ignored, so it never returns `./` or the whole path.
 */
export function nodeModuleLine(file: string): string | null {
  const normalized = file
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash + 1) : null;
}

/**
 * P2-12: Node Detail's Location line — "<file> — lines <start>–<end>", or
 * "<file> — line N" for a one-line range. An inverted range is shown
 * min–max; a non-positive or non-finite line falls back to the file alone
 * rather than printing a nonsense range.
 */
export function formatNodeLocation(file: string, startLine: number, endLine: number): string {
  const valid = (line: number) => Number.isFinite(line) && line > 0;
  if (!valid(startLine) || !valid(endLine)) {
    return file;
  }
  const first = Math.min(startLine, endLine);
  const last = Math.max(startLine, endLine);
  return first === last ? `${file} — line ${first}` : `${file} — lines ${first}–${last}`;
}

/**
 * P2-12: the muted suffix after a Node's name in the Node Detail head — `()`
 * for a callable (`Function`) Node, nothing for a Type, Interface or Module.
 */
export function nodeNameSuffix(kind: CodeMapNode['kind']): string {
  switch (kind) {
    case 'Function':
      return '()';
    case 'Interface':
    case 'Type':
    case 'Module':
      return '';
    default: {
      // Exhaustive: a new `CodeMapNodeKind` member fails to compile here. At
      // runtime an unknown kind arriving over IPC gets no suffix.
      const unknownKind: never = kind;
      void unknownKind;
      return '';
    }
  }
}

/**
 * P2-12: the Node Detail head — module line, name (+ muted `()` for a
 * Function) and the "[esc] close" button. Hookless so
 * `CodeMap.nodeDetail.test.ts` can render it as a plain function.
 *
 * The `()` sits outside the truncating name span so a long name never
 * ellipsizes it away; both truncating lines carry their full text as
 * `title`. The close button's accessible name is its visible text plus a
 * visually hidden " Node detail" (label-in-name, as Settings' close).
 */
export function NodeDetailHead({ node, onClose }: { node: CodeMapNode; onClose: () => void }) {
  const moduleLine = nodeModuleLine(node.file);
  const suffix = nodeNameSuffix(node.kind);
  return (
    <div className="code-map__node-detail-head">
      <div className="code-map__node-detail-title">
        {moduleLine !== null && (
          <div className="code-map__node-detail-module" title={moduleLine}>
            {moduleLine}
          </div>
        )}
        <code className="code-map__node-detail-name">
          <span className="code-map__node-detail-name-text" title={node.name}>
            {node.name}
          </span>
          {suffix !== '' && <span className="code-map__node-detail-paren">{suffix}</span>}
        </code>
      </div>
      <button type="button" className="code-map__node-detail-close" onClick={onClose}>
        [esc] close<span className="visually-hidden"> Node detail</span>
      </button>
    </div>
  );
}

/**
 * P2-12: how many of a Node's risk signals the map-level overlay toggles are
 * hiding — the signals in a family whose toggle is off (a blank LLM judgment,
 * which never renders anyway, is not counted). Lets the Risk Overlay section
 * tell "nothing to show" apart from "hidden by the toggles".
 */
export function countToggleHiddenSignals(signals: RiskSignal[], toggles: RiskSignalFamilyToggles): number {
  let hidden = 0;
  if (!toggles.showDeterministicSignals) {
    hidden += selectDeterministicSignals(signals).length;
  }
  if (!toggles.showLlmJudgment) {
    const judgment = selectLlmJudgmentSignal(signals);
    if (judgment !== undefined && judgment.judgment.trim().length > 0) {
      hidden += 1;
    }
  }
  if (!toggles.showIngestedFindings) {
    hidden += selectIngestedSignals(signals).length;
  }
  return hidden;
}

/** P0-2b: the cluster-list cap's own remainder. See `formatRemainingNodes`. */
export function formatRemainingClusters(remainingClusterCount: number): string {
  return `+${remainingClusterCount} more module${remainingClusterCount === 1 ? '' : 's'}`;
}

/**
 * P0-2c: the row control's affordance text — the "and activating it opens
 * Node detail" half of the Node card's own `aria-label` convention, carried as
 * real (visually hidden) CONTENT rather than as an `aria-label`.
 *
 * The distinction is the whole point. An `aria-label` REPLACES an element's
 * text as its accessible name, so labelling the row button would silently
 * delete every chip's own `aria-label` from what a screen reader announces:
 * "Complexity: 21", "Blast radius: 14" and the entire AI-judgment sentence are
 * rendered for sighted users and announced nowhere. Composing the name from
 * content keeps all of it, and cannot drift from what is displayed the way a
 * hand-built label can — the row's name is, by construction, exactly what the
 * row shows plus this one phrase.
 */
const HEALTH_ROW_AFFORDANCE = 'open Node detail';

/**
 * P0-2b: one Node's row inside a cluster card. Values are the Node's real
 * `DeterministicRiskSignal.value`s, rendered through the same
 * `DETERMINISTIC_SIGNAL_ICONS`/`DETERMINISTIC_SIGNAL_LABELS` +
 * `role="img"`/`aria-label` chip convention `NodeRiskSignalSections` already
 * uses on the canvas — glyph and number visible, full signal name in the
 * accessible name. No percentages are derived: `test-coverage-gap` is a
 * boolean flag carrying `value: 1`, so the mockup's "61% gap"/"2 hotspots"
 * figures depict data driller does not have. P1-1: a severe signal's chip
 * gets the same `!` glyph and "(severe)" label as the canvas chip, and its
 * own `code-map__health-row-signal--severe` modifier.
 *
 * The row's own band is rendered as a WORD, not only as the value colour
 * (Accessibility Floor: the `--{heat}` class is reinforcement only, and the
 * signal chips' `aria-label`s carry name and value but never the band). It is
 * banded from this Node's own `riskCount` through the same `heatForRiskCount`
 * the card bands `heatCount` with, so a row and its card can never come from
 * two sets of thresholds — and a Node carrying nothing reads "healthy", which
 * is that same word, not a separate empty-state string.
 *
 * `formatCandidateLocation` supplies the row's second line: a directory
 * cluster merges every file under it, so `a.ts` and `b.ts` can both contribute
 * a `handle` and would otherwise render as two identical rows. That helper
 * already exists in this file for exactly this problem in the Path Trace
 * candidate list.
 *
 * P0-2c: the row is now a real control — a native `<button>` filling the
 * `<li>`, calling `onActivate` with ITS OWN `member.node` (the object, never a
 * name/id the callee would have to resolve, which is what makes two
 * same-named rows in one cluster open their own Nodes rather than the first
 * match). A native button rather than the canvas card's
 * `tabIndex`/`role="button"`/`onKeyDown` trio: that pattern exists on the card
 * because React Flow owns the card's mouse handling, which is not a constraint
 * here — and a real button gets Enter, Space, the focus stop and the AT role
 * from the platform instead of from three hand-written handlers.
 *
 * Exactly ONE control per row (Never: "no second click target per row"), so
 * unlike the Node card there is no nested pill and therefore no
 * `stopPropagation` handling to match: the signal chips stay `role="img"`
 * spans, and — because the button carries NO `aria-label` — each chip's own
 * label still reaches the accessible name (`HEALTH_ROW_AFFORDANCE`).
 *
 * The `title` is the mouse's recovery path for the two lines that ellipsise
 * (`.code-map__health-row-name` and `-location`): a long identifier under a
 * deep qualified path is otherwise unreadable at this card width with no way
 * to get it back. Same role the Node card's `title` and the cluster heading's
 * `title={cluster.directory}` already play; it sits on the button because the
 * button is what the pointer is actually over.
 *
 * MUST STAY HOOKLESS. This component and `HealthAuditClusterGrid` are invoked
 * as plain functions by `CodeMap.healthAuditRow.test.ts`, which is how the
 * handlers are reachable at all without a DOM (this repo's runner has none —
 * `docs/agent.md`). A `useMemo`/`useId` here, or a `memo()` wrapper around
 * either component, makes every one of those tests fail as a React dispatcher
 * error rather than as an assertion. Neither component needs one: both are
 * pure renderings of already-computed props.
 */
export function HealthAuditClusterRow({
  member,
  onActivate,
}: {
  member: HealthClusterNode;
  onActivate: (node: CodeMapNode) => void;
}) {
  const heat = heatForRiskCount(member.riskCount);
  const judgment = member.llmJudgment;
  const location = formatCandidateLocation(member.node);
  return (
    <li className="code-map__health-row">
      <button
        type="button"
        className="code-map__health-row-button"
        title={`${member.node.name} · ${location}`}
        onClick={() => onActivate(member.node)}
      >
        <span className="code-map__health-row-identity">
          <span className="code-map__health-row-name">{member.node.name}</span>
          <span className="code-map__health-row-location">{location}</span>
        </span>
        <span className={`code-map__health-row-values code-map__health-row-values--${heat}`}>
          <span className="code-map__health-row-band">{heat}</span>
          {member.deterministicSignals.map((signal) => {
            const label = formatDeterministicSignalLabel(signal);
            const icon = DETERMINISTIC_SIGNAL_ICONS[signal.type] ?? '?';
            return (
              <span
                key={signal.type}
                className={
                  signal.severity === 'severe'
                    ? 'code-map__health-row-signal code-map__health-row-signal--severe'
                    : 'code-map__health-row-signal'
                }
                role="img"
                aria-label={label}
                title={label}
              >
                {signal.severity === 'severe' && <span aria-hidden="true">{SEVERE_SIGNAL_GLYPH}</span>}
                <span aria-hidden="true">{icon}</span>
                {signal.value}
              </span>
            );
          })}
          {/* The judgment is a sentence, not a measurement — its glyph and
              accessible name follow `.code-map__llm-judgment`'s own "AI
              judgment:" lead-in so it never reads with a deterministic
              signal's unqualified-measurement confidence. */}
          {judgment !== undefined && (
            <span
              className="code-map__health-row-signal"
              role="img"
              aria-label={`AI judgment: ${judgment.judgment}`}
              title={`AI judgment: ${judgment.judgment}`}
            >
              <span aria-hidden="true">✦</span>
            </span>
          )}
        </span>
        {/* Last, so the name reads "<identifier> <location> <band> <signals…>
            open Node detail" — what the row is, then what activating it does.
            Visually hidden rather than `aria-label`d: see
            `HEALTH_ROW_AFFORDANCE`. */}
        <span className="visually-hidden">{HEALTH_ROW_AFFORDANCE}</span>
      </button>
    </li>
  );
}

/** The grid's own heading, referenced by the scroll region's `aria-labelledby`. */
const HEALTH_GRID_HEADING_ID = 'code-map-health-grid-heading';

/**
 * P0-2b: Health Audit Mode's own surface — the cluster-card grid that renders
 * INSTEAD OF the canvas (DESIGN.md `components.health-cluster-card`,
 * EXPERIENCE.md "Health Audit cluster card", `mockups/health-audit-mode.html`).
 *
 * Every number here comes from P0-2a's `groupNodesIntoHealthClusters`: the
 * grouping, the ordering, the caps, the remainders and the heat banding. This
 * component decides nothing about risk — it is the rendering half only.
 *
 * P0-2c: rows are no longer inert. `onActivateNode` is threaded to every
 * `HealthAuditClusterRow` and is the component's ONLY behavioral prop —
 * `openNodeDetail`, the same one-click open path the Code Map's Node cards
 * take, so Health Audit gains a caller of Node detail rather than a second
 * detail surface. Nothing else about the card changed: the heat, the chips and
 * the remainder lines are P0-2b's, unaltered.
 *
 * The remainder lines ("+N more Nodes"/"+N more modules") stay plain `<p>`s
 * deliberately (I/O Matrix): they are COUNTS of Nodes the caps dropped, not
 * Nodes, so there is nothing for them to open and they must not look or behave
 * as if there were.
 *
 * Deliberately NOT rendered when there is nothing ready to group: the loading,
 * fetch-error, empty-map and PR-Review notices keep the surface entirely to
 * themselves (I/O Matrix), so a partial card frame never appears over one.
 * There is also no "Last full scan N ago" footer, unlike the mockup's: driller
 * has no scan-timestamp source, and the figure will not be faked.
 *
 * `tabIndex={0}` on the scroll container survives P0-2c and is still
 * load-bearing, for a narrower reason than the one that put it here. Row
 * buttons now give the region focusable descendants, and moving focus between
 * them scrolls the region on its own — but the remainder lines and the
 * heading are NOT focusable, so a card list whose last content below the fold
 * is "+2 more modules" would have nothing to tab to in order to bring it into
 * view. The container's own focus stop is what keeps the whole region
 * scrollable, not just the parts that happen to be controls.
 *
 * The `<h2>` gives the cards' `<h3>`s a parent in the heading outline instead
 * of starting it at level 3, and names the region. Its id is a module-scope
 * constant rather than a `useId`, which is also what keeps this component
 * hookless — see `HealthAuditClusterRow`'s own MUST STAY HOOKLESS note, which
 * applies to this component identically.
 */
export function HealthAuditClusterGrid({
  grouping,
  onActivateNode,
}: {
  grouping: HealthClusterGrouping;
  onActivateNode: (node: CodeMapNode) => void;
}) {
  return (
    <section
      className="code-map__health-grid"
      aria-labelledby={HEALTH_GRID_HEADING_ID}
      tabIndex={0}
    >
      <h2 className="code-map__health-heading" id={HEALTH_GRID_HEADING_ID}>
        Risk signals clustered by module
      </h2>
      <ol className="code-map__health-cards">
        {grouping.clusters.map((cluster) => (
          <li key={cluster.directory} className="code-map__health-card">
            <h3 className="code-map__health-card-heading" title={cluster.directory}>
              <span
                className={`code-map__health-dot code-map__health-dot--${cluster.heat}`}
                aria-hidden="true"
              />
              <span className="code-map__health-card-label">{cluster.label}</span>
            </h3>
            <p className="code-map__health-card-heat">
              {formatHealthClusterHeat(cluster.heat, cluster.heatCount, cluster.totalRiskCount)}
            </p>
            <ul className="code-map__health-rows">
              {/* P0-2c: the key carries the member's POSITION as well as its
                  Node id. A Node id is a fully-qualified name, which is
                  unique in practice but is not guaranteed unique by anything
                  in `graph-contracts` — and two Nodes sharing one inside a
                  single cluster is exactly the "Duplicate names" case this
                  surface already has to survive. Id alone would make that a
                  duplicate React key: React would reuse one row element for
                  both, so the second row could render the first row's Node
                  and open it. The index is safe as a tiebreak here because
                  the list is a total order `groupNodesIntoHealthClusters`
                  already settled, not a user-reorderable one. */}
              {cluster.nodes.map((member, index) => (
                <HealthAuditClusterRow
                  key={`${member.node.id}#${index}`}
                  member={member}
                  onActivate={onActivateNode}
                />
              ))}
            </ul>
            {cluster.remainingNodeCount > 0 && (
              <p className="code-map__health-more">{formatRemainingNodes(cluster.remainingNodeCount)}</p>
            )}
          </li>
        ))}
      </ol>
      {grouping.remainingClusterCount > 0 && (
        <p className="code-map__health-more code-map__health-more--clusters">
          {formatRemainingClusters(grouping.remainingClusterCount)}
        </p>
      )}
    </section>
  );
}

/**
 * P3-11: a cluster card's accessible name. A cluster holding changed Nodes
 * (PR Review) appends ", N changed" so the marker is never colour-only.
 */
export function clusterAriaLabel(nodeCount: number, willZoomInsteadOfExpand: boolean, changedCount: number): string {
  const base = willZoomInsteadOfExpand
    ? `Cluster of ${nodeCount} nodes, too many to expand — zoom in`
    : `Cluster of ${nodeCount} nodes, expand`;
  return changedCount > 0 ? `${base}, ${changedCount} changed` : base;
}

export function CodeMapClusterCard({ data }: NodeProps<CodeMapClusterFlowNode>) {
  const { cluster, onExpand, changedCount } = data;
  const willZoomInsteadOfExpand = cluster.nodeIds.length > CLUSTER_EXPAND_MAX;
  const classNames = ['code-map__cluster'];
  if (willZoomInsteadOfExpand) {
    classNames.push('code-map__cluster--zoom');
  }
  if (changedCount > 0) {
    classNames.push('code-map__cluster--changed');
  }
  return (
    <div
      className={classNames.join(' ')}
      tabIndex={0}
      role="button"
      aria-label={clusterAriaLabel(cluster.nodeIds.length, willZoomInsteadOfExpand, changedCount)}
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
      {changedCount > 0 && (
        <span className="code-map__cluster-changed" aria-hidden="true">
          {changedCount} changed
        </span>
      )}
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
 *
 * `selectionToDetailMs` (AD-14's click-to-UI-response latency) is written only
 * from `activateNode` — i.e. only from a Node card ON THE CANVAS. P0-2c
 * (2026-09-24) gave Health Audit Mode's cluster grid its own route into the
 * same Node Detail panel via `openNodeDetail`, and that route deliberately
 * starts no timer, so the app's FIRST-OPEN surface contributes no samples to
 * this metric at all. Nothing is mis-measured — the recording effect
 * early-returns while `selectionStartRef` is null, so a grid open cannot be
 * attributed a stale start time — but a profiling run against this array is
 * measuring the canvas only, and must not be read as covering Health Audit.
 * Widening it means starting the clock in `openNodeDetail` itself (both
 * callers) rather than adding a second timer here.
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

export interface CodeMapProps {
  /**
   * Absolute, OS-native path of the currently-open project (review finding,
   * Medium) — used only to filter incoming `graphService:summaryProgress`
   * messages by `message.path`, mirroring the `currentProjectPathRef`-style
   * correlation pattern `App.tsx` already applies to
   * `GraphServiceStatusMessage` (Story 1.2/1.4): a progress message for a
   * project the user has since navigated away from is dropped rather than
   * patching a Node id that may not even belong to the map on screen.
   */
  projectPath: string | null;
  /**
   * Story 1.6 (Phase 2): true when neither summary backend can produce
   * anything at all right now (local unusable AND no cloud key) — derived
   * by App.tsx from `BackendConfig`/`ModelStatusMessage`, already resolved
   * against `cloudSelectedNoKey`'s own priority (UX-DR17), so CodeMap just
   * renders whichever of the two is true.
   */
  noSummaryBackendAvailable: boolean;
  /**
   * Story 1.6 (Phase 2): true when the active backend is cloud but no key is
   * stored — the more specific of the two notices (UX-DR17), derived by
   * App.tsx the same way `noSummaryBackendAvailable` is.
   */
  cloudSelectedNoKey: boolean;
  /**
   * Story 3.1 (Phase 2): the active mode (`App.tsx`'s own shell state,
   * Design Notes: "App.tsx only owns cross-cutting shell state like which
   * mode is active") — gates whether the base-ref input/trigger toolbar,
   * PR-Review Actionable Notices, and changed-Node treatment render at all.
   * `'prReview'`-specific local state (`baseRefInput`/`diffScopeState`) is
   * NOT reset on a mode switch itself, only on a `projectPath` change (see
   * the `useEffect` below) — switching away from and back to PR Review Mode
   * within the same project preserves whatever was already resolved,
   * matching this story's "no auto-trigger on mode switch" Design Notes.
   *
   * Story 4.1: widened to include `'healthAudit'` — `App.tsx`'s own `Mode`
   * type widens together with this one (Always: "both must change
   * together").
   *
   * P0-2b: `'healthAudit'` is now a different SURFACE, not a tint on the
   * shared one — it renders `HealthAuditClusterGrid` and suppresses both the
   * `<ReactFlow>` canvas and the history toolbar. The Path Trace toolbar is
   * deliberately NOT suppressed with them; see `healthAuditGridIsRenderable`.
   */
  mode: CodeMapMode;
  /**
   * P0-2b: asks `App.tsx` — which owns `mode` as shell state — to switch to
   * Code Map Mode. Called on a Path Trace submit from Health Audit Mode and
   * nowhere else: search stays reachable in every mode ("search is always
   * reachable, not mode-gated"), but a traced route must render on a canvas
   * (FR-10), and Health Audit Mode has none. A callback rather than local
   * state because `mode` is `App.tsx`'s to own — the mode switcher's own
   * radio has to reflect the change too.
   */
  onRequestCodeMapMode: () => void;
  /**
   * P0-3: false while the Graph Service isn't live (re-indexing, exited or
   * errored) — the map stays mounted showing the last completed index, but
   * the actions that need the Graph Service (diff-scope submit, Path Trace
   * submit, Regenerate) are disabled with an explanatory `title`. Source view
   * and Open in editor stay enabled: both are served by main alone.
   */
  graphServiceAvailable: boolean;
  /**
   * P0-3: `App.tsx` bumps this once per new `indexed` status for this
   * project. The value present at mount is the initial load (never a second
   * one); every later change triggers exactly one refetch that keeps the
   * canvas mounted, so viewport and Back/Forward history survive it. This is
   * the one refresh path — the map is no longer unmounted/remounted to
   * refresh.
   */
  dataVersion: number;
  /**
   * P2-3: reports the map's state (`mapFooterState`: loading, error, or ready
   * with its Node and edge totals) up to `App.tsx` for the frame's footer bar
   * on every `fetchState` change — load, Retry, refresh, failure — tagged
   * with `projectPath` so `App.tsx` can drop a report about a project that is
   * no longer open.
   */
  onMapState: (projectPath: string | null, state: MapFooterState) => void;
  /**
   * P3-10: reports when the diff scope last synced (epoch ms) up to
   * `App.tsx` for the footer bar's "PR REVIEW · synced …" — a settle of
   * `resolved`, `no-changes`, `not-a-git-repo` or `no-base-ref-resolvable`
   * (never `error`, which keeps the previous time), or `null` once the diff
   * scope is reset (project change, map reload, refresh after re-index) —
   * only when a time was reported, and under the project it was for.
   */
  onDiffScopeSynced: (projectPath: string | null, at: number | null) => void;
  /**
   * P2-5: the empty-map scope notice's "Edit indexing scope" — `App.tsx`
   * opens Settings (focused on the scope field).
   */
  onOpenSettings: () => void;
  /**
   * P2-5: the genuinely-empty-map notice's "Re-index" — the Graph Service
   * Retry path (`restartGraphService()`, no force), which re-sends the index
   * request. Resolves `false` when the restart failed or was rejected (App
   * has already reported it), so the button's pending state can end.
   */
  onReindex: () => Promise<boolean>;
}

/** P0-3: the `title` every Graph-Service-backed action carries while it's disabled for not being live. */
const GRAPH_SERVICE_UNAVAILABLE_TITLE =
  'Unavailable while the Graph Service is not live — the map shows the last completed index.';

/**
 * P0-3: marks a button disabled because the Graph Service is down, not merely
 * busy ("Computing…"/"Searching…"/"Regenerating…") — styles.css gives only
 * these `cursor: not-allowed`.
 */
const SERVICE_UNAVAILABLE_CLASS = 'code-map__action--service-unavailable';

/**
 * P3-8: the Path Trace placeholder. Shorter than DESIGN.md's "Path Trace —
 * e.g. ..." copy (review round 1): the `trace>` prompt already says what the
 * field is, and the long form was truncated in the 320px search box. It uses
 * no example names from the mockup project, which driller can't know.
 */
export const PATH_TRACE_PLACEHOLDER = 'function name or entry point';

/**
 * P3-8: the Path Trace search row — DESIGN.md `path-trace-search`'s accent
 * `trace>` prompt, the blinking block cursor, then the input, reading
 * `trace> █ placeholder` when idle. The field is a `<label>` wrapping the
 * input, so clicking the prompt or padding focuses it. Both decorations are
 * `aria-hidden`; the input's own `aria-label` stays its accessible name.
 *
 * Cursor visibility: not rendered at all while the Graph Service is down;
 * otherwise styles.css hides it (via `:has()` on the field) whenever the input
 * is focused (the native caret takes over), non-empty, or disabled.
 *
 * HOOKLESS on purpose: `CodeMap.pathTraceSearch.test.ts` renders it by calling
 * it as a plain function, and a hook here would break that test with a
 * dispatcher error. The search flow (value, change, submit, the disabled
 * rules, the button's label and unavailable title/class) is the pre-P3-8
 * inline form's; the placeholder copy and the form's `role` changed.
 */
export function PathTraceSearchRow({
  query,
  onQueryChange,
  onSubmit,
  searching,
  graphServiceAvailable,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  searching: boolean;
  graphServiceAvailable: boolean;
}) {
  return (
    <form
      className="code-map__path-trace-toolbar"
      role="search"
      aria-label="Search a traced path"
      onSubmit={onSubmit}
    >
      <label className="code-map__path-trace-field">
        <span className="code-map__path-trace-prompt" aria-hidden="true">
          trace&gt;
        </span>
        {graphServiceAvailable && <span className="code-map__path-trace-cursor" aria-hidden="true" />}
        <input
          type="text"
          className="code-map__path-trace-input"
          placeholder={PATH_TRACE_PLACEHOLDER}
          aria-label="Path Trace query"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          disabled={searching}
        />
      </label>
      {/* I/O Matrix: "Second submit while a search is in flight ...
          No-op — input/button disabled until the first resolves" —
          the `disabled` attributes here are belt-and-suspenders on
          top of `handlePathTraceSubmit`'s own no-op guard. */}
      <button
        type="submit"
        disabled={searching || !graphServiceAvailable}
        title={graphServiceAvailable ? undefined : GRAPH_SERVICE_UNAVAILABLE_TITLE}
        className={graphServiceAvailable ? undefined : SERVICE_UNAVAILABLE_CLASS}
      >
        {searching ? 'Searching…' : 'Trace'}
      </button>
    </form>
  );
}

/**
 * P2-12: the ids of Node Detail's section headings, referenced by each
 * section's `aria-labelledby`. Constants rather than `useId` so
 * `NodeDetailBody` stays hookless — only one Node Detail panel is ever open.
 */
export const NODE_DETAIL_SECTION_HEADING_IDS = {
  summary: 'code-map-node-detail-summary-heading',
  riskOverlay: 'code-map-node-detail-risk-overlay-heading',
  staleness: 'code-map-node-detail-staleness-heading',
  location: 'code-map-node-detail-location-heading',
} as const;

export interface NodeDetailBodyProps {
  node: CodeMapNode;
  toggles: RiskSignalFamilyToggles;
  cloudSelectedNoKey: boolean;
  noSummaryBackendAvailable: boolean;
  /** `nodeDetailSummaryAction(node.summaryStatus)` — `null` offers no action. */
  summaryAction: { label: string; busyLabel: string } | null;
  regenerateState: RegenerateState;
  graphServiceAvailable: boolean;
  onRegenerate: () => void;
}

/**
 * P2-12: Node Detail's scrolling body — the mockup's labelled, divided
 * sections in the order Summary → Risk Overlay → Staleness → Location.
 * Presentation only: every state, action and handler is the one the panel
 * already had, passed in. Hookless so `CodeMap.nodeDetail.test.ts` can render
 * it as a plain function.
 */
export function NodeDetailBody({
  node,
  toggles,
  cloudSelectedNoKey,
  noSummaryBackendAvailable,
  summaryAction,
  regenerateState,
  graphServiceAvailable,
  onRegenerate,
}: NodeDetailBodyProps) {
  const ids = NODE_DETAIL_SECTION_HEADING_IDS;
  const signalsVisible = hasVisibleRiskSignals(node.riskSignals, toggles);
  const toggleHiddenCount = signalsVisible ? 0 : countToggleHiddenSignals(node.riskSignals, toggles);

  // Honest staleness (P2-12 review): "Not stale." only asserts freshness for
  // a summary that exists. A pending / coverage-gap Node has none.
  let staleness: { className: string; content: ReactNode };
  if (node.stale === true) {
    staleness = {
      className: 'code-map__node-detail-staleness code-map__node-detail-staleness--stale',
      content: (
        <>
          <span aria-hidden="true">⏳</span> Summary may be stale — source changed since generation
        </>
      ),
    };
  } else if (node.summaryStatus === 'ready') {
    staleness = { className: 'code-map__node-detail-staleness', content: 'Not stale.' };
  } else {
    staleness = {
      className: 'code-map__node-detail-staleness code-map__node-detail-staleness--none',
      content: 'No summary yet.',
    };
  }

  return (
    <div className="code-map__node-detail-body">
      <section className="code-map__node-detail-section" aria-labelledby={ids.summary}>
        <h3 id={ids.summary} className="code-map__node-detail-label">
          Summary
        </h3>
        {node.summaryStatus === 'ready' &&
          (node.summary !== undefined ? (
            <p className="code-map__node-detail-summary">{node.summary}</p>
          ) : (
            <p className="code-map__node-detail-empty">No summary text.</p>
          ))}
        {/* P0-1: the same three non-`'ready'` summary states the card itself
            renders — same classes, same icons, same copy as the card: a Node
            that reads "Coverage gap — no summary" on the map must not read as
            a silent blank when opened. */}
        {node.summaryStatus === 'coverage-gap' && (
          <p className="code-map__node-summary code-map__node-summary--coverage-gap">
            <span aria-hidden="true">⚠</span> Coverage gap — no summary
          </p>
        )}
        {node.summaryStatus === 'pending' && cloudSelectedNoKey && (
          <p className="code-map__node-summary code-map__node-summary--notice" role="status">
            <span aria-hidden="true">☁</span> Cloud is selected but no API key is set — add one in Settings.
          </p>
        )}
        {node.summaryStatus === 'pending' && !cloudSelectedNoKey && noSummaryBackendAvailable && (
          <p className="code-map__node-summary code-map__node-summary--notice" role="status">
            <span aria-hidden="true">⚠</span> No summary backend is available — check Settings.
          </p>
        )}
        {node.summaryStatus === 'pending' && !cloudSelectedNoKey && !noSummaryBackendAvailable && (
          <p className="code-map__node-summary code-map__node-summary--pending" role="status">
            Summary pending…
          </p>
        )}
      </section>
      {/* P0-1: the Node's risk signals, rendered by the exact same
          `NodeRiskSignalSections` the card uses — one implementation, so
          glyphs, labels, chips, severity ordering, cap and the three map-level
          family toggles are identical here by construction. P2-12: the
          section is always present; when nothing renders it says whether the
          Node has no signals or the overlay toggles are hiding them. */}
      <section className="code-map__node-detail-section" aria-labelledby={ids.riskOverlay}>
        <h3 id={ids.riskOverlay} className="code-map__node-detail-label">
          Risk Overlay
        </h3>
        {signalsVisible ? (
          <div className="code-map__node-detail-signals">
            <NodeRiskSignalSections signals={node.riskSignals} toggles={toggles} />
          </div>
        ) : (
          <p className="code-map__node-detail-empty">
            {toggleHiddenCount > 0
              ? `${toggleHiddenCount} signal${toggleHiddenCount === 1 ? '' : 's'} hidden by the overlay toggles.`
              : 'No risk signals shown.'}
          </p>
        )}
      </section>
      <section className="code-map__node-detail-section" aria-labelledby={ids.staleness}>
        <h3 id={ids.staleness} className="code-map__node-detail-label">
          Staleness
        </h3>
        {/* One persistent `role="status"` element whose content changes, so
            the flip after a successful regenerate (stale → "Not stale.") is
            announced. Same "never color-only" treatment as the card's own
            staleness note: the icon and exact copy carry the signal. No
            generated-at time — the Node record carries none. */}
        <p className={staleness.className} role="status">
          {staleness.content}
        </p>
        {/* P0-1 (2026-09-24): the summary action is offered only where it can
            succeed — the service rejects a `'coverage-gap'` Node outright.
            P1-2: a `'pending'` Node gets it too, worded "Generate summary" —
            a Node whose generation failed stays `'pending'` for the whole
            session, so this is its only way to retry (e.g. after adding a
            cloud key). Same `regenerateNode` IPC either way. P2-12: a quiet
            outlined chip; the "↻" is decorative, so the accessible name stays
            exactly the label. */}
        {summaryAction && (
          <button
            type="button"
            className={`code-map__node-detail-regenerate${graphServiceAvailable ? '' : ` ${SERVICE_UNAVAILABLE_CLASS}`}`}
            onClick={onRegenerate}
            disabled={regenerateState.kind === 'regenerating' || !graphServiceAvailable}
            title={graphServiceAvailable ? undefined : GRAPH_SERVICE_UNAVAILABLE_TITLE}
          >
            <span aria-hidden="true">↻ </span>
            {regenerateState.kind === 'regenerating' ? summaryAction.busyLabel : summaryAction.label}
          </button>
        )}
        {regenerateState.kind === 'error' && (
          <ActionableNotice tone="error" role="alert">
            {regenerateState.message}
          </ActionableNotice>
        )}
      </section>
      <section
        className="code-map__node-detail-section code-map__node-detail-section--location"
        aria-labelledby={ids.location}
      >
        <h3 id={ids.location} className="code-map__node-detail-label">
          Location
        </h3>
        <p className="code-map__node-detail-location">
          <code>{formatNodeLocation(node.file, node.startLine, node.endLine)}</code>
        </p>
      </section>
    </div>
  );
}

/**
 * P0-3 + P1-7: the failed-refresh Actionable Notice — the last completed map
 * stays mounted beneath it. Its Retry re-runs only the refresh and is named
 * "Retry the map refresh" so it never shares an accessible name with the
 * degraded-session Retry (App.tsx `DegradedSessionNotice`). Disabled, with
 * the shared title, while the Graph Service isn't live. MUST STAY HOOKLESS:
 * `ActionableNotice.test.ts` calls it directly.
 */
export function RefreshErrorNotice({
  graphServiceAvailable,
  message,
  onRetry,
}: {
  graphServiceAvailable: boolean;
  message: string;
  onRetry: () => void;
}) {
  return (
    <ActionableNotice
      tone="warning"
      action={
        <button
          type="button"
          className={graphServiceAvailable ? undefined : SERVICE_UNAVAILABLE_CLASS}
          onClick={onRetry}
          disabled={!graphServiceAvailable}
          title={graphServiceAvailable ? undefined : GRAPH_SERVICE_UNAVAILABLE_TITLE}
          aria-label="Retry the map refresh"
        >
          Retry
        </button>
      }
    >
      Couldn&rsquo;t refresh the map — showing the last completed index ({message}).
    </ActionableNotice>
  );
}

/**
 * P2-5: which empty-map notice a `ready` map with zero Nodes gets. The Graph
 * Service reports how many Nodes its scope filter removed
 * (`hiddenByScope`), so "the scope hid everything" (most likely a typo like
 * `wbe`) is told apart from "the project genuinely has none".
 */
export type EmptyMapCase = { kind: 'scope-hid-everything'; hiddenCount: number } | { kind: 'no-map-eligible-nodes' };

export function chooseEmptyMapCase(hiddenByScope: number): EmptyMapCase {
  return hiddenByScope > 0 ? { kind: 'scope-hid-everything', hiddenCount: hiddenByScope } : { kind: 'no-map-eligible-nodes' };
}

/**
 * P2-5: the scope case's one sentence. `appliedScope` is the scope the Graph
 * Service filtered this very map with (`CodeMapResult.appliedScope`), so it
 * never names a scope that didn't produce the map; `[]` omits the list.
 */
export function emptyMapScopeSentence(appliedScope: readonly string[], hiddenCount: number): string {
  const scope = appliedScope.length > 0 ? ` (${appliedScope.join(', ')})` : '';
  const nodes = hiddenCount === 1 ? '1 Node' : `${hiddenCount} Nodes`;
  return `The indexing scope${scope} matches none of this project's ${nodes}.`;
}

export const EMPTY_MAP_NO_NODES_SENTENCE =
  'This project has no map-eligible Nodes (no Function/Interface/Type/Module found).';

/** P2-5: what was on screen when Re-index was clicked. */
export interface ReindexClickSnapshot {
  fetchState: FetchState;
  refreshError: string | null;
}

/**
 * P2-5: a Re-index stays pending only while the screen still shows what it
 * showed at the click — any new `fetchState` (the re-index's refresh landed)
 * or a new refresh error ends it. A failed or rejected restart ends it by
 * clearing the snapshot.
 */
export function isReindexPending(
  click: ReindexClickSnapshot | null,
  current: { fetchState: FetchState; refreshError: string | null },
): boolean {
  return click !== null && click.fetchState === current.fetchState && click.refreshError === current.refreshError;
}

/**
 * P2-5: the Re-index button's state. Disabled while the Graph Service is
 * down (P0-3's unavailable treatment) or while a Re-index is already
 * pending — a second click would only stack another restart.
 */
export function reindexButtonState({
  graphServiceAvailable,
  reindexPending,
}: {
  graphServiceAvailable: boolean;
  reindexPending: boolean;
}): { label: string; disabled: boolean; className: string | undefined; title: string | undefined } {
  return {
    label: reindexPending ? 'Re-indexing…' : 'Re-index',
    disabled: reindexPending || !graphServiceAvailable,
    className: graphServiceAvailable ? undefined : SERVICE_UNAVAILABLE_CLASS,
    title: graphServiceAvailable ? undefined : GRAPH_SERVICE_UNAVAILABLE_TITLE,
  };
}

/**
 * P2-5: the empty-map Actionable Notice — one sentence, exactly one action.
 * Scope hid everything → "Edit indexing scope" (opens Settings); otherwise →
 * "Re-index" (the Graph Service Retry path; see `reindexButtonState`). No
 * role of its own: the call site wraps it in a `role="status"` region, and
 * live regions must not nest. MUST STAY HOOKLESS:
 * `CodeMap.emptyMap.test.ts` calls it directly.
 */
export function EmptyMapNotice({
  hiddenByScope,
  appliedScope,
  graphServiceAvailable,
  reindexPending,
  onOpenSettings,
  onReindex,
}: {
  hiddenByScope: number;
  appliedScope: readonly string[];
  graphServiceAvailable: boolean;
  reindexPending: boolean;
  onOpenSettings: () => void;
  onReindex: () => void;
}) {
  const emptyCase = chooseEmptyMapCase(hiddenByScope);
  if (emptyCase.kind === 'scope-hid-everything') {
    return (
      <ActionableNotice
        tone="info"
        action={
          <button type="button" onClick={onOpenSettings}>
            Edit indexing scope
          </button>
        }
      >
        {emptyMapScopeSentence(appliedScope, emptyCase.hiddenCount)}
      </ActionableNotice>
    );
  }
  const reindex = reindexButtonState({ graphServiceAvailable, reindexPending });
  return (
    <ActionableNotice
      tone="info"
      action={
        <button
          type="button"
          className={reindex.className}
          onClick={onReindex}
          disabled={reindex.disabled}
          title={reindex.title}
        >
          {reindex.label}
        </button>
      }
    >
      {EMPTY_MAP_NO_NODES_SENTENCE}
    </ActionableNotice>
  );
}

export function CodeMap({
  projectPath,
  noSummaryBackendAvailable,
  cloudSelectedNoKey,
  mode,
  onRequestCodeMapMode,
  graphServiceAvailable,
  dataVersion,
  onMapState,
  onDiffScopeSynced,
  onOpenSettings,
  onReindex,
}: CodeMapProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });
  // P2-3: report every `fetchState` change, not just count changes — a Retry
  // or reopen can land a map with the same totals, and loading → error must
  // retract the counts. `App.tsx` dedups identical reports.
  const onMapStateRef = useRef(onMapState);
  useEffect(() => {
    onMapStateRef.current = onMapState;
  }, [onMapState]);
  useEffect(() => {
    onMapStateRef.current(projectPath, mapFooterState(fetchState));
  }, [projectPath, fetchState]);
  // P0-3: read by `refreshCodeMap`'s async settle to tell whether a completed
  // map is on screen to fall back to.
  const fetchStateRef = useRef<FetchState>(fetchState);
  useEffect(() => {
    fetchStateRef.current = fetchState;
  }, [fetchState]);
  // P0-3: a failed `refreshCodeMap` — shown as a map-level notice over the
  // still-mounted last completed map, never by replacing it.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // P2-5: the empty map's Re-index is pending from its click until the next
  // `fetchState` change, a refresh error, or a failed/rejected restart — the
  // snapshot records what was on screen at the click (`isReindexPending`).
  const [reindexClick, setReindexClick] = useState<ReindexClickSnapshot | null>(null);
  const reindexPending = isReindexPending(reindexClick, { fetchState, refreshError });
  const handleReindex = useCallback(() => {
    const snapshot: ReindexClickSnapshot = { fetchState, refreshError };
    setReindexClick(snapshot);
    void onReindex().then((ok) => {
      if (!ok) {
        // Only end the pending state this click started.
        setReindexClick((current) => (current === snapshot ? null : current));
      }
    });
  }, [fetchState, refreshError, onReindex]);
  const [sourceView, setSourceView] = useState<SourceViewState>({ status: 'closed' });
  // Story 1.10 (Phase 2): the source overlay's "Open in external editor"
  // button state — kept separate from `sourceView` itself (the overlay's
  // own loading/error state is about reading the source range, not about
  // the hand-off action a user can trigger once it's open).
  const [openInEditorState, setOpenInEditorState] = useState<OpenInEditorState>({ status: 'idle' });
  // Story 1.8 (Phase 4): the Node Detail panel's own state, plus the
  // Regenerate button's in-flight/error state — kept separate from
  // `sourceView` since the two overlays are independent (opening Node
  // Detail never reads source, and the source overlay's own state shape has
  // no room for a staleness/regenerate concept).
  const [nodeDetail, setNodeDetail] = useState<NodeDetailState>({ status: 'closed' });
  const [regenerateState, setRegenerateState] = useState<RegenerateState>({ kind: 'idle' });
  // Story 1.9 (Phase 2): the search toolbar's own query text and its
  // `tracePath` result state — kept separate (rather than folding the query
  // string into `PathTraceState` itself) since the input stays editable
  // (and its own value persists) independently of whatever the last search
  // resolved to.
  const [pathQuery, setPathQuery] = useState('');
  const [pathTrace, setPathTrace] = useState<PathTraceState>({ status: 'idle' });
  // FIX-1: whether `fitViewToPath` had to clamp the last route fit to
  // `ROUTE_MIN_READABLE_ZOOM`. Keyed by the fitted route's own array (the
  // same `path`/`nodeIds` reference `pathTrace` stores), so it only counts
  // while that exact trace is showing: every reset or new trace replaces
  // `pathTrace` with a different object and the flag falls away with it.
  // The flag also clears the first time the user pans/zooms or the
  // container resizes (`clearRouteClamp`), so the line only ever describes
  // the fitted view itself.
  const [routeFit, setRouteFit] = useState<RouteFit | null>(null);
  const routeClamped = isRouteClamped(routeFit, pathTrace);
  const clearRouteClamp = useCallback(() => {
    setRouteFit((previous) => (previous?.clamped ? { ...previous, clamped: false } : previous));
  }, []);
  // FIX-1: the unmeasured-viewport fallback's warning fires once per mount.
  const routeFitFallbackWarnedRef = useRef(false);
  // FIX-1: bumped per route fit, so a `fitBounds` fallback that settles
  // after a newer fit started doesn't clamp over it.
  const routeFitSeqRef = useRef(0);
  // FIX-1: `@xyflow/react`'s store (via `ReactFlowStoreBridge`, rendered
  // inside `<ReactFlow>`), read only for its measured `width`/`height` when
  // this component's own ResizeObserver hasn't reported yet.
  const reactFlowStoreRef = useRef<FlowStoreSize | null>(null);
  // Story 2.1 (Phase 3): the deterministic risk-signal layer's own toggle —
  // a renderer-local `useState`, no persistence, no IPC round trip (Boundaries
  // & Constraints, UX-DR21). Defaults to visible/on (EXPERIENCE.md: the
  // signal strip is part of what a Node "Always shows"). Threaded through
  // `layoutNodes`/`CodeMapFlowNode.data` the same way `noSummaryBackend
  // Available` already is, rather than read from context/a prop, since it's
  // controlled entirely from within this component (the new `Panel` toggle
  // below).
  const [showDeterministicSignals, setShowDeterministicSignals] = useState(true);
  // Story 2.2 (Phase 3): the LLM-judgment layer's own toggle — a second,
  // fully independent renderer-local `useState` (Boundaries & Constraints:
  // "no shared toggle with showDeterministicSignals"), same no-persistence/
  // no-IPC treatment and same default-on reasoning as the deterministic
  // toggle just above.
  const [showLlmJudgment, setShowLlmJudgment] = useState(true);
  // Story 2.3 (Phase 4): the ingested-PR-bot-findings layer's own toggle —
  // a third, fully independent renderer-local `useState` (Boundaries &
  // Constraints: "never reads/writes showDeterministicSignals/
  // showLlmJudgment"), same no-persistence/no-IPC treatment and same
  // default-on reasoning as the two toggles above.
  const [showIngestedFindings, setShowIngestedFindings] = useState(true);
  // P0-1 (2026-09-24): the three family toggles above, bundled once for the
  // two surfaces that render risk signals (the Node card, via `layoutNodes`'
  // own separate scalar props, and the Node Detail panel below). Passing one
  // object rather than three loose booleans is what makes it impossible for
  // the second surface to silently honor a subset of them.
  const riskSignalToggles: RiskSignalFamilyToggles = {
    showDeterministicSignals,
    showLlmJudgment,
    showIngestedFindings,
  };
  // Story 3.1 (Phase 2): PR Review Mode's own base-ref text and its
  // `computeDiffScope` result state — CodeMap-owned (Design Notes: "matches
  // this codebase's existing division of responsibility ... App.tsx only
  // owns cross-cutting shell state like which mode is active"), mirroring
  // `pathQuery`/`pathTrace`'s own separate-input-vs-result-state split just
  // above. Neither resets on a `mode` toggle — only on a `projectPath`
  // change (the effect below) — see `CodeMapProps.mode`'s own doc comment.
  const [baseRefInput, setBaseRefInput] = useState('');
  const [diffScopeState, setDiffScopeState] = useState<DiffScopeState>({ status: 'idle' });
  // Correlates a `computeDiffScope` response back to the trigger click that
  // started it — the same stale-response guard `pathTraceRequestIdRef`
  // already establishes for `tracePath`: bumped both on every trigger click
  // and on the `projectPath`-reset effect below, so a request abandoned by
  // a project switch (or superseded by a second trigger click) can never
  // apply its late reply over whatever the user is now looking at.
  const diffScopeRequestIdRef = useRef(0);
  // P3-10: reports the diff scope's sync time to `App.tsx` at exactly the
  // points `diffScopeState` settles (`diffScopeSyncTimeFor`: never on
  // `error`) or resets. Held in a ref so a new callback identity can never
  // re-run the `projectPath` reset effect or re-create the reload callbacks.
  const onDiffScopeSyncedRef = useRef(onDiffScopeSynced);
  useEffect(() => {
    onDiffScopeSyncedRef.current = onDiffScopeSynced;
  }, [onDiffScopeSynced]);
  // The project whose sync time `App.tsx` currently holds from this map, so a
  // reset reports `null` only when there is a time to clear — and under the
  // project it was recorded for, never the one just switched to.
  const diffScopeSyncHeldForRef = useRef<string | null>(null);
  const clearDiffScopeSync = useCallback(() => {
    const heldFor = diffScopeSyncHeldForRef.current;
    if (heldFor === null) {
      return;
    }
    diffScopeSyncHeldForRef.current = null;
    onDiffScopeSyncedRef.current(heldFor, null);
  }, []);
  // Story 3.2 (Phase 2): the combined blast-radius expansion's own result
  // state and the stepper's current depth — CodeMap-owned, same division-of-
  // responsibility reasoning as `baseRefInput`/`diffScopeState` just above.
  // P0-5: `blastRadiusDepth` defaults to `BLAST_RADIUS_DEFAULT_HOPS` — the
  // same bound the Blast Radius badge counts, so a one-Node diff's default
  // highlight is exactly that Node's badge set — and is reset to it alongside
  // `blastRadiusState` at each of its own reset points (never left stale at
  // a deeper depth from a previous diff scope). Once a result resolves, it is
  // clamped to that result's own max depth via `initialBlastRadiusDepth`.
  const [blastRadiusState, setBlastRadiusState] = useState<BlastRadiusState>({ status: 'idle' });
  const [blastRadiusDepth, setBlastRadiusDepth] = useState(BLAST_RADIUS_DEFAULT_HOPS);
  // Correlates an `expandBlastRadius` response back to the auto-trigger (or
  // reset) that started/invalidated it — same stale-response guard shape as
  // `diffScopeRequestIdRef` just above: bumped on every reset point (project
  // change, `loadCodeMap`, and the instant `handleComputeDiffScope` starts a
  // new computation) so a request abandoned by one of those can never apply
  // its late reply over whatever the user is now looking at.
  const blastRadiusRequestIdRef = useRef(0);
  // Review fix: correlates a `tracePath` response back to the search that
  // started it — the same generation-id pattern `sourceRequestIdRef` below
  // already applies to `readSourceRange`, and Phase 1's own
  // `pendingPathTraceToken` applies on the main-process side. Without this,
  // an in-flight search that resolves *after* a Retry/project reload (which
  // resets `pathTrace` to `'idle'` in `loadCodeMap` below but can't cancel
  // an already-inflight promise) would silently reapply a highlight/
  // step-list/`fitViewToPath` lookup for Node ids belonging to the
  // already-discarded map. Bumped in both `handlePathTraceSubmit` (captured
  // at call time) and `loadCodeMap`'s reset; a response is only applied if
  // it's still the latest.
  const pathTraceRequestIdRef = useRef(0);
  // P0-3: correlates a `refreshCodeMap` reply (see below) with the latest
  // refresh — and is bumped by `loadCodeMap` too, so a full reload started
  // after a refresh can never be overwritten by that refresh's late reply.
  const refreshRequestIdRef = useRef(0);
  // Review fix (Phase 4): the query text that actually produced the
  // *currently-displayed* `pathTrace` result — set alongside
  // `pathTraceRequestIdRef` at the top of `runPathTrace`, so it always holds
  // whatever string was actually passed into that call (the input field's
  // text on a fresh search, or a disambiguation candidate's exact `id` on a
  // candidate-pick re-trace). Live `pathQuery` state is NOT a safe substitute
  // here: the input stays editable once a result is showing (only disabled
  // during `searching`), so a user can change its text before clicking
  // Dismiss, and a candidate-pick trace never updates `pathQuery` to the
  // candidate's id at all. `handleDismissPathTrace` reads this ref, never
  // `pathQuery`, when building the diagnostic log entry.
  const lastTracedQueryRef = useRef('');
  // Mirrors `nodeDetail` for `handleRegenerate`'s `.then`/`.catch` (Spec
  // Change Log Round 1) — the same `configRef`-style pattern Settings.tsx
  // already uses to read the LATEST state from inside an async callback
  // without depending on `nodeDetail` itself (which would otherwise force
  // `handleRegenerate` to be recreated, and re-subscribe its own
  // closures, on every panel open/close). Synced synchronously inside
  // `updateNodeDetail` below (review round 2) rather than via a separate
  // `useEffect(() => { nodeDetailRef.current = nodeDetail }, [nodeDetail])`
  // — an effect only flushes after React commits the render it was
  // scheduled from, a theoretical (if unlikely) lag a fast-resolving
  // `regenerateNode()` promise's `.then` could read through: this way the
  // ref is always current the instant `nodeDetail` state changes, with no
  // window in between.
  const nodeDetailRef = useRef<NodeDetailState>({ status: 'closed' });
  const updateNodeDetail = useCallback((next: NodeDetailState) => {
    nodeDetailRef.current = next;
    setNodeDetail(next);
  }, []);
  // Correlates a `readSourceRange` response back to the click that started
  // it (review finding — the same concurrency/correlation bug class as
  // Story 1.2's indexing-status races): clicking Node A then quickly Node B
  // before A's response lands must never let A's stale response overwrite
  // `sourceView` after the user has already moved on to B. Incremented on
  // every activation; a response is only applied if it's still the latest.
  const sourceRequestIdRef = useRef(0);
  // Correlates an `openInEditor` response back to the click that started it
  // (Story 1.10, Phase 2) — same stale-response guard as
  // `sourceRequestIdRef` above: bumped whenever the source overlay opens for
  // a (possibly different) Node or closes, so a late reply for a Node the
  // user has since moved on from (or a closed overlay) never resurrects
  // `openInEditorState`.
  const openInEditorRequestIdRef = useRef(0);

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
  // FIX-1: the same size as a ref, so `fitViewToPath` reads the latest value
  // without depending on it (a resize must never re-create — and so never
  // re-trigger — the route fit and throw away the user's own pan/zoom).
  const containerSizeRef = useRef({ width: 0, height: 0 });
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

  // Story 1.4 Design Notes: "track the most recently `navigateToNode`'d or
  // clicked Node ID in a ref" — a traversal-local concept, not a new global
  // selection state, that lets an edge click resolve to its non-focused
  // endpoint. Set by both `activateNode` (a direct click/keyboard
  // activation) and `centerOnNode` (a traversal via edge/affordance/
  // back/forward).
  const focusedNodeIdRef = useRef<string | null>(null);

  // Back/forward navigation history (Story 1.4, AD-2 restated): renderer-
  // local ephemeral state only — never persisted, never routed through
  // IPC/main. `stack` holds visited Node ids in traversal order; `index`
  // is the current position within it. Navigating to a new Node (not via
  // Back/Forward) truncates any forward entries past `index` before
  // appending, exactly like a browser's own history stack.
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });

  // `navigateToNode` needs `flowNodesById`/`flowNodes` (built later, from
  // this same render's `layoutNodes` call) to resolve a target's laid-out
  // position — and the Node Detail panel, path-trace step rows and the
  // toolbar all hold it before that render's `flowNodesById` exists (the
  // caller/callee pills used to be threaded through `layoutNodes` as
  // `data.onNavigate` too, until P2-4 gave them `onShowNeighbors`). Broken the same way `sourceRequestIdRef`
  // breaks its own timing race: a ref holding the real implementation,
  // synced via an effect below, behind a stable wrapper (identity never
  // changes) so neither `flowNodes`' memoization nor `onEdgeClick`/the
  // toolbar need the real implementation in their dependency arrays.
  const navigateToNodeImplRef = useRef<(id: string) => void>(() => {});
  const navigateToNode = useCallback((id: string) => {
    navigateToNodeImplRef.current(id);
  }, []);
  // P2-4: the Node card pills' `onShowNeighbors` — the same stable-wrapper-
  // over-a-ref shape as `navigateToNode` just above, for the same reason:
  // the real implementation needs `adjacency`/`fitViewToPath` (declared
  // later), but a changing callback identity here would re-run `layoutNodes`.
  const showNeighborsImplRef = useRef<(originId: string, direction: NeighborDirection) => void>(() => {});
  const showNeighbors = useCallback((originId: string, direction: NeighborDirection) => {
    showNeighborsImplRef.current(originId, direction);
  }, []);

  const loadCodeMap = useCallback(() => {
    // P0-3: this full load shares `refreshRequestIdRef` with
    // `refreshCodeMap`, so whichever started last wins — a slow initial reply
    // can never overwrite a map refreshed after a newer `indexed`, and a
    // refresh started before this reload can never land after it.
    const requestId = ++refreshRequestIdRef.current;
    setRefreshError(null);
    setFetchState({ status: 'loading' });
    // Review fix: `history` and `focusedNodeIdRef` are scoped to one
    // fetched map — a Retry (this function is the Retry button's own
    // `onClick`) or a future reload with a different project swaps in an
    // entirely different node/edge set, so stale ids from the previous map
    // must never survive into it (Back/Forward landing nowhere for a Node
    // id that no longer exists, or an edge click resolving against a
    // "focused" Node from a map that's gone).
    setHistory({ stack: [], index: -1 });
    focusedNodeIdRef.current = null;
    // Story 1.8 (Phase 4): a Retry/reload swaps in an entirely different
    // Node set, same reasoning as the history reset just above — a Node
    // Detail panel left open for a Node from the previous map must not
    // survive into this one.
    updateNodeDetail({ status: 'closed' });
    setRegenerateState({ kind: 'idle' });
    // Story 1.9 (Phase 2): same reasoning as the Node Detail reset just
    // above — a Retry/reload swaps in an entirely different Node/edge set,
    // so a highlighted route or step list from the previous map must not
    // survive into this one. Bumping the request id too (review fix) means
    // an already-inflight `tracePath` promise from before this reload can
    // no longer apply its result once it resolves — see
    // `pathTraceRequestIdRef`'s own doc comment.
    setPathTrace({ status: 'idle' });
    pathTraceRequestIdRef.current += 1;
    // Review finding (Edge Case Hunter): a Retry/re-index for the SAME
    // `projectPath` (e.g. Story 1.8's refresh flow) swaps in a fresh
    // fetched Node set without `projectPath` itself ever changing — the
    // `projectPath`-keyed reset effect below therefore never fires, so a
    // previously-resolved `diffScopeState.nodeIds` would keep referencing
    // Node ids from the map that's gone, same "stale ids from the previous
    // map must never survive" reasoning the history/Node-Detail/Path-Trace
    // resets just above already apply. A stale diff scope is more actively
    // misleading than an empty one (spurious/missing "Changed" treatment
    // with no indication it's out of date), so this resets to `'idle'`
    // rather than trying to preserve it — the user re-triggers explicitly,
    // consistent with this phase's own no-auto-trigger design.
    setBaseRefInput('');
    setDiffScopeState({ status: 'idle' });
    clearDiffScopeSync();
    diffScopeRequestIdRef.current += 1;
    // Story 3.2 (Phase 2, Always): "Resets to idle whenever the diff scope
    // changes ... or the project changes/reindexes — mirrors the three
    // existing `diffScopeState` reset points exactly" — a Retry/reindex swaps
    // in a fresh Node/edge set (and, via the reset just above, a fresh
    // `diffScopeState`), so a previously-resolved blast radius keyed off the
    // now-gone map's Node ids must not survive either. Bumping the request id
    // invalidates any still-in-flight `expandBlastRadius` call from before
    // this reload the same way `diffScopeRequestIdRef` just above does.
    setBlastRadiusState({ status: 'idle' });
    setBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS);
    blastRadiusRequestIdRef.current += 1;
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
          setFetchState({
            status: 'ready',
            nodes: synthetic.nodes,
            edges: synthetic.edges,
            hiddenByScope: 0,
            appliedScope: [],
          });
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
        if (requestId !== refreshRequestIdRef.current) {
          return;
        }
        if (result.status === 'ok') {
          setFetchState({
            status: 'ready',
            nodes: result.nodes,
            edges: result.edges,
            hiddenByScope: result.hiddenByScope,
            appliedScope: result.appliedScope,
          });
        } else {
          setFetchState({ status: 'error', message: result.message });
        }
      })
      .catch((error: unknown) => {
        if (requestId !== refreshRequestIdRef.current) {
          return;
        }
        // NFR4: no silent failure — a rejected IPC call surfaces the same
        // explicit error/retry state as a reported `{status: 'error'}`.
        setFetchState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [fixtureNodeCount, clearDiffScopeSync]);

  useEffect(() => {
    loadCodeMap();
  }, [loadCodeMap]);

  /**
   * P0-3: refetch the map after a new `indexed` for the same project
   * (`dataVersion` bump) WITHOUT `loadCodeMap`'s full reset — the canvas
   * stays mounted on the previous data while the fetch is in flight, so the
   * viewport, Back/Forward history and focused Node all survive (Node ids are
   * content-stable across re-index, so history entries keep resolving).
   *
   * What does reset is every query result computed against the previous
   * index — a Path Trace route, a diff scope and its blast radius — since
   * showing those against the refreshed map would be serving stale
   * structural data as current (EXPERIENCE.md). Their request ids are bumped
   * too, so an in-flight reply from before the refresh can't land after it.
   * An open Node Detail panel is re-pointed at the refreshed copy of its
   * Node, or closed if that Node is gone.
   */
  const refreshCodeMap = useCallback(() => {
    if (isDevFixtureMode) {
      // A synthetic fixture has no index behind it to refresh from.
      return;
    }
    const requestId = ++refreshRequestIdRef.current;
    setRefreshError(null);
    setPathTrace({ status: 'idle' });
    pathTraceRequestIdRef.current += 1;
    setDiffScopeState({ status: 'idle' });
    clearDiffScopeSync();
    diffScopeRequestIdRef.current += 1;
    setBlastRadiusState({ status: 'idle' });
    setBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS);
    blastRadiusRequestIdRef.current += 1;
    // The decision lives in `resolveRefreshOutcome` (sessionView.ts, unit
    // tested); this only carries it out.
    const settle = (reply: CodeMapFetchReply) => {
      const openDetail = nodeDetailRef.current;
      const outcome = resolveRefreshOutcome({
        requestId,
        latestRequestId: refreshRequestIdRef.current,
        reply,
        hasReadyData: fetchStateRef.current.status === 'ready',
        openDetailNodeId: openDetail.status === 'open' ? openDetail.node.id : null,
      });
      switch (outcome.kind) {
        case 'ignore':
          return;
        case 'keep-with-error':
          // The last completed map stays on screen (P0-3 Always: the map
          // stays mounted) — only a map-level notice says the refresh failed.
          setRefreshError(outcome.message);
          return;
        case 'replace-with-error':
          setFetchState({ status: 'error', message: outcome.message });
          return;
        case 'apply':
          setFetchState({
            status: 'ready',
            nodes: outcome.nodes,
            edges: outcome.edges,
            hiddenByScope: outcome.hiddenByScope,
            appliedScope: outcome.appliedScope,
          });
          if (outcome.nodeDetail.kind === 'close') {
            updateNodeDetail({ status: 'closed' });
            setRegenerateState({ kind: 'idle' });
          } else if (outcome.nodeDetail.kind === 'repoint') {
            updateNodeDetail({ status: 'open', node: outcome.nodeDetail.node });
          }
          return;
      }
    };
    window.driller
      .getCodeMap()
      .then((result) => {
        settle(
          result.status === 'ok'
            ? {
                kind: 'ok',
                nodes: result.nodes,
                edges: result.edges,
                hiddenByScope: result.hiddenByScope,
                appliedScope: result.appliedScope,
              }
            : { kind: 'failed', message: result.message },
        );
      })
      .catch((error: unknown) => {
        settle({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      });
  }, [isDevFixtureMode, updateNodeDetail, clearDiffScopeSync]);

  // The version present at mount was already covered by `loadCodeMap` just
  // above — only a later change is a refresh.
  const loadedDataVersionRef = useRef(dataVersion);
  useEffect(() => {
    if (dataVersion === loadedDataVersionRef.current) {
      return;
    }
    loadedDataVersionRef.current = dataVersion;
    refreshCodeMap();
  }, [dataVersion, refreshCodeMap]);

  // Story 1.5 Phase 2: incoming batched summary-generation progress patches
  // the already-rendered node set in place — never a full remap/refetch
  // (Code Map: "patch the already-rendered node set in place"), so the map
  // stays exactly where the user left it (viewport, expanded clusters,
  // selection) while summaries fill in around them. A `Map` lookup (built
  // fresh per event, `updated` batches are small — see
  // `PROGRESS_FLUSH_BATCH_SIZE` in summary-generator.ts) is cheap next to
  // re-running `layoutNodes`/`computeLOD` on every batch.
  useEffect(() => {
    const unsubscribe = window.driller.onSummaryProgress((message) => {
      // Structural correlation (review finding, Medium) — see `CodeMapProps.
      // projectPath`'s doc comment. Previously relied entirely on the
      // backend never sending a stale message; this is a defensive filter
      // on the renderer side too.
      if (message.path !== projectPath) {
        return;
      }
      const updatesById = new Map(message.updated.map((update) => [update.id, update.summary]));
      if (updatesById.size === 0) {
        return;
      }
      setFetchState((previous) => {
        if (previous.status !== 'ready') {
          // The map isn't showing this fetch's Nodes (yet, or anymore) —
          // nothing to patch. A same-session late arrival for a since-
          // discarded map is simply dropped, matching the same
          // stale-response handling `openSourceForNode` already applies.
          return previous;
        }
        let changed = false;
        const nodes = previous.nodes.map((node) => {
          const summary = updatesById.get(node.id);
          if (summary === undefined) {
            return node;
          }
          changed = true;
          return { ...node, summaryStatus: 'ready' as const, summary };
        });
        return changed ? { ...previous, nodes } : previous;
      });
      // P0-1 (2026-09-24): the open Node Detail panel holds its OWN copied
      // `CodeMapNode`, so patching `fetchState` alone left it frozen at
      // whatever the Node looked like when it was opened. Story 1.8 never
      // hit this — the panel was reachable only for a `'ready' && stale`
      // Node, which by definition is not still generating. Now that
      // activation opens it for any Node, a Node opened mid-generation would
      // otherwise read "Summary pending…" forever while the card behind the
      // overlay quietly filled in.
      //
      // Read through `nodeDetailRef` (kept in sync synchronously by
      // `updateNodeDetail`), and patch only when this batch actually carries
      // this Node — the same shape `handleRegenerate`'s own late-reply path
      // already uses.
      const openDetail = nodeDetailRef.current;
      if (openDetail.status === 'open') {
        const summary = updatesById.get(openDetail.node.id);
        if (summary !== undefined) {
          updateNodeDetail({
            status: 'open',
            node: { ...openDetail.node, summaryStatus: 'ready' as const, summary },
          });
        }
      }
    });
    return unsubscribe;
  }, [projectPath, updateNodeDetail]);

  // Story 3.1 (Phase 2, Always): "PR-Review-specific state ... resets
  // whenever `projectPath` changes" — mirrors every other per-project
  // renderer-state reset this session (Settings.tsx's `prBotConfig`/
  // `ingestionRun`, this same file's own `showLlmJudgment` etc. never
  // leaking across projects, per this story's own Boundaries &
  // Constraints). Bumping `diffScopeRequestIdRef` too (same reasoning as
  // `loadCodeMap`'s own `pathTraceRequestIdRef` bump) invalidates any
  // still-in-flight `computeDiffScope` call from the project being left,
  // so its late reply can never resolve into the newly-opened project's
  // state. Deliberately does NOT depend on `mode` — a mode toggle alone
  // must never clear this (`CodeMapProps.mode`'s own doc comment).
  useEffect(() => {
    setBaseRefInput('');
    setDiffScopeState({ status: 'idle' });
    clearDiffScopeSync();
    diffScopeRequestIdRef.current += 1;
    // Story 3.2 (Phase 2, Always): same "resets whenever ... the project
    // changes" reasoning as the `diffScopeState` reset just above — a project
    // switch swaps in an entirely different Node set, so a blast radius
    // computed against the previous project's Node ids must not survive
    // into the new one. Also deliberately does NOT depend on `mode`, same
    // reasoning as the reset above.
    setBlastRadiusState({ status: 'idle' });
    setBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS);
    blastRadiusRequestIdRef.current += 1;
  }, [projectPath, clearDiffScopeSync]);

  /**
   * Story 3.1 (Phase 2): the base-ref trigger's own click handler — the
   * explicit "select a base ref" action (Boundaries & Constraints: "does
   * not auto-trigger `computeDiffScope`"). A blank/whitespace-only input is
   * passed through as `undefined` (Boundaries & Constraints: "an empty
   * input on trigger means 'omit,' triggering auto-resolution, exactly
   * matching Phase 1's own supported path") — `window.driller.
   * computeDiffScope`'s own `baseRef` parameter is already optional for
   * exactly this reason.
   *
   * Same staleness-guard shape as `runPathTrace` above: a fresh
   * `requestId` is minted and captured before the async call, then checked
   * again once it resolves/rejects — a project switch (which bumps this
   * same ref in the reset effect above) in the meantime must not let a
   * since-superseded reply apply a changed-Node set that no longer belongs
   * to the project now on screen.
   */
  const handleComputeDiffScope = useCallback(() => {
    if (projectPath === null || diffScopeState.status === 'loading') {
      return;
    }
    const requestId = ++diffScopeRequestIdRef.current;
    const trimmedBaseRef = baseRefInput.trim();
    // Review finding (Blind Hunter): the input's own visible value never
    // reflected the trimmed text that was actually sent — a `" main "`
    // submission left the untrimmed string on screen afterward even though
    // `"main"` (trimmed) was what was actually diffed against.
    setBaseRefInput(trimmedBaseRef);
    setDiffScopeState({ status: 'loading' });
    // Review fix (Edge Case Hunter + Verification Gap, High): resetting
    // `blastRadiusState` only once the new `computeDiffScope` call *settles*
    // (in `.then`/`.catch` below) left a window — for the whole duration of
    // this new request — where `blastRadiusNodeIds` (gated on `mode`/
    // `blastRadiusState.status` alone, never on `diffScopeState.status`)
    // kept rendering the *previous* diff scope's blast-radius highlight
    // while the toolbar already said "Computing…" for the new one; a late
    // reply from a still-in-flight previous `expandBlastRadius` call could
    // also still apply during that window. Resetting synchronously here,
    // the instant a genuinely new diff-scope computation starts (mirrors
    // `diffScopeState` itself moving to `'loading'` on the very same line),
    // closes that window entirely instead of only closing it once the new
    // diff scope resolves. The auto-trigger effect below (guarded on
    // `blastRadiusState.status === 'idle'`) picks this back up and re-fires
    // on its own once `diffScopeState` lands on a `'resolved'` status with a
    // non-empty `nodeIds` set — no separate reset is needed in `.then`/
    // `.catch` below anymore, since this one already covers both outcomes.
    setBlastRadiusState({ status: 'idle' });
    setBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS);
    blastRadiusRequestIdRef.current += 1;
    window.driller
      .computeDiffScope(projectPath, trimmedBaseRef.length > 0 ? trimmedBaseRef : undefined)
      .then((result: DiffScopeResult) => {
        if (diffScopeRequestIdRef.current !== requestId) {
          return;
        }
        // P3-10: every settle but `error` is a completed sync; an error
        // keeps whatever time was held.
        const syncedAt = diffScopeSyncTimeFor(result, Date.now());
        if (syncedAt !== null) {
          diffScopeSyncHeldForRef.current = projectPath;
          onDiffScopeSyncedRef.current(projectPath, syncedAt);
        }
        switch (result.status) {
          case 'resolved':
            setDiffScopeState({
              status: 'resolved',
              resolvedBaseRef: result.resolvedBaseRef,
              nodeIds: new Set(result.nodeIds),
            });
            break;
          case 'no-changes':
            setDiffScopeState({ status: 'no-changes' });
            break;
          case 'not-a-git-repo':
            setDiffScopeState({ status: 'not-a-git-repo' });
            break;
          case 'no-base-ref-resolvable':
            setDiffScopeState({ status: 'no-base-ref-resolvable' });
            break;
          case 'error':
            setDiffScopeState({ status: 'error', message: result.message });
            break;
        }
      })
      .catch((error: unknown) => {
        if (diffScopeRequestIdRef.current !== requestId) {
          return;
        }
        // `blastRadiusState` was already reset synchronously above, the
        // instant this request started — nothing further to reset here for
        // a rejected `computeDiffScope` call either.
        setDiffScopeState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [projectPath, baseRefInput, diffScopeState.status]);

  const handleDiffScopeSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // P0-3: belt-and-suspenders on top of the disabled submit button.
      if (!graphServiceAvailable) {
        return;
      }
      handleComputeDiffScope();
    },
    [handleComputeDiffScope, graphServiceAvailable],
  );

  /**
   * Story 3.2 (Phase 2): the auto-trigger — `expandBlastRadius` fires on its
   * own once the diff scope resolves with a non-empty changed-Node set
   * (combined/unioned across every changed Node), the one deliberate
   * exception to this codebase's "no auto-trigger" convention (Always: "a
   * downstream call off an already-explicit diff-scope trigger, not a second
   * unprompted git-adjacent call" — epic-3-context.md Technical Decision).
   *
   * Every guard condition is independent and all are required (Always: "one
   * `expandBlastRadius` call ... auto-triggers once per resolved diff scope
   * with a non-empty changed-Node set"):
   * - `mode === 'prReview'` — never fires while looking at the ordinary Code
   *   Map, mirroring `changedNodeIds`'s own mode gate just below.
   * - `diffScopeState.status === 'resolved'` — nothing to seed this with
   *   otherwise (no changed Nodes yet, or an explicit non-happy-path state).
   * - `diffScopeState.nodeIds.size > 0` — an empty changed-Node set (I/O
   *   Matrix: "Diff scope resolves with zero changed Nodes") has nothing to
   *   seed `expandBlastRadius` with either, even though `status` itself is
   *   `'resolved'`.
   * - `projectPath !== null` — mirrors every other IPC-calling callback in
   *   this file (`handleComputeDiffScope` etc.).
   * - `blastRadiusState.status === 'idle'` — the load-bearing "don't
   *   re-trigger" guard (Never: "No re-triggering `expandBlastRadius` on a
   *   bare `mode` toggle once already resolved for the current diff scope —
   *   guard on the blast-radius state itself, not just `mode`"): once this
   *   effect has moved `blastRadiusState` past `'idle'` for the current
   *   `diffScopeState`, toggling `mode` away and back re-runs this effect
   *   (its dependency list includes `mode`) but this condition alone blocks
   *   a second call — the *only* way back to `'idle'` is one of the three
   *   explicit reset points above, each of which represents the diff scope
   *   genuinely changing.
   *
   * Seeded with every changed-Node id from the resolved diff scope — never a
   * per-Node call (Always: "never per-Node").
   */
  useEffect(() => {
    if (
      mode !== 'prReview' ||
      projectPath === null ||
      // P0-3: `expandBlastRadius` needs the Graph Service. Left `'idle'`, so
      // it fires once the service is live again.
      !graphServiceAvailable ||
      diffScopeState.status !== 'resolved' ||
      diffScopeState.nodeIds.size === 0 ||
      blastRadiusState.status !== 'idle'
    ) {
      return;
    }
    const requestId = ++blastRadiusRequestIdRef.current;
    const seedNodeIds = Array.from(diffScopeState.nodeIds);
    setBlastRadiusState({ status: 'loading' });
    window.driller
      .expandBlastRadius(projectPath, seedNodeIds)
      .then((result: BlastRadiusExpansionResult) => {
        if (blastRadiusRequestIdRef.current !== requestId) {
          // Superseded by a later reset/trigger (a project switch, a
          // Retry/reload, or a fresh diff-scope resolution) — discard rather
          // than let a stale reply apply a blast radius keyed to a Node set
          // that may no longer even be on screen.
          return;
        }
        if (result.status === 'resolved') {
          const hopDistances = new Map(Object.entries(result.hopDistances));
          // The stepper's own upper bound — "its own 'further'" (Always) —
          // is the maximum hop distance actually present, not an arbitrary
          // constant.
          let maxDepth = 0;
          for (const distance of hopDistances.values()) {
            if (distance > maxDepth) {
              maxDepth = distance;
            }
          }
          setBlastRadiusState({ status: 'resolved', hopDistances, maxDepth });
          setBlastRadiusDepth(initialBlastRadiusDepth(maxDepth));
        } else {
          setBlastRadiusState({ status: 'error', message: result.message });
        }
      })
      .catch((error: unknown) => {
        if (blastRadiusRequestIdRef.current !== requestId) {
          return;
        }
        setBlastRadiusState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [mode, projectPath, diffScopeState, blastRadiusState.status, graphServiceAvailable]);

  const openSourceForNode = useCallback((node: CodeMapNode) => {
    const requestId = ++sourceRequestIdRef.current;
    // A fresh source-view open (possibly for a different Node) invalidates
    // any still-in-flight `openInEditor` request from whatever was
    // previously shown, and resets its own idle/error display.
    openInEditorRequestIdRef.current += 1;
    setOpenInEditorState({ status: 'idle' });
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

  // Opens the Node Detail panel for a Node — resets any leftover Regenerate
  // state from a previously-viewed Node so a fresh open never shows a stale
  // error/"Regenerating…" from a different Node.
  //
  // Story 1.8 (Phase 4) reached this only via the stale-only "Details"
  // affordance. P0-1 (2026-09-24) made it the destination of `activateNode`
  // below — i.e. of every card click and Enter/Space — and removed that
  // pill, so it must be declared BEFORE `activateNode`: `activateNode`'s
  // dependency array is evaluated during render, and a `const` referenced
  // there before its own initializer has run is a TDZ ReferenceError, not
  // merely a lint complaint.
  const openNodeDetail = useCallback((node: CodeMapNode) => {
    updateNodeDetail({ status: 'open', node });
    setRegenerateState({ kind: 'idle' });
  }, []);

  // The shared activation path for a Node card — a mouse click
  // (`handleNodeClick`) and the card's own Enter/Space handler both land
  // here.
  //
  // P0-1 (2026-09-24): opens Node Detail rather than the source viewer
  // (EXPERIENCE.md's IA row; source moved to its own pill on the card).
  // Both of this function's side effects survive that retarget unchanged:
  // the `focusedNodeIdRef` write, and the dev-fixture selection timer — now
  // genuinely a selection-to-*detail* measurement, read back by the effect
  // keyed on `nodeDetail` further below.
  const activateNode = useCallback(
    (node: CodeMapNode) => {
      // Design Notes: a click/keyboard activation counts as "focusing" a
      // Node for the purpose of resolving a later edge click's endpoint.
      focusedNodeIdRef.current = node.id;
      if (isDevFixtureMode) {
        selectionStartRef.current = performance.now();
      }
      openNodeDetail(node);
    },
    [openNodeDetail, isDevFixtureMode],
  );

  const closeNodeDetail = useCallback(() => {
    updateNodeDetail({ status: 'closed' });
    setRegenerateState({ kind: 'idle' });
  }, []);

  /**
   * Wires the Node Detail panel's Regenerate button to
   * `window.driller.regenerateNode` (Story 1.8, Phase 4) — this app's first
   * id-keyed mutating IPC round-trip. On success, patches `fetchState.nodes`
   * in place by id (reusing the `onSummaryProgress` batched-patch idiom
   * above) rather than refetching — unconditionally, the same way an
   * `onSummaryProgress` batch patches the map in the background regardless
   * of what's currently selected/open, since the regeneration genuinely did
   * happen and the map's card for this Node should reflect it either way.
   *
   * **Spec Change Log Round 1:** by contrast, `updateNodeDetail`/
   * `setRegenerateState` — the Node Detail *panel's own* displayed state —
   * are only ever called after checking the panel is still open for the
   * SAME Node ID (`nodeDetailRef.current`, not the `nodeDetail` this
   * callback closed over at click time). Without that check, closing the
   * panel and opening a different stale Node before this request settles
   * would let the first Node's late result overwrite the second Node's
   * displayed panel/button state.
   */
  const handleRegenerate = useCallback(() => {
    // P0-3: `!graphServiceAvailable` is belt-and-suspenders on top of the
    // disabled button.
    if (nodeDetail.status !== 'open' || !graphServiceAvailable) {
      return;
    }
    const targetNode = nodeDetail.node;
    setRegenerateState({ kind: 'regenerating' });
    window.driller
      .regenerateNode(targetNode.id)
      .then((result) => {
        if (result.status === 'ok') {
          setFetchState((previous) => {
            if (previous.status !== 'ready') {
              // The map isn't showing this fetch's Nodes (yet, or anymore)
              // — nothing to patch, same reasoning as the summary-progress
              // patch above.
              return previous;
            }
            const nodes = previous.nodes.map((candidate) =>
              candidate.id === result.node.id ? result.node : candidate,
            );
            return { ...previous, nodes };
          });
        }
        const current = nodeDetailRef.current;
        if (current.status !== 'open' || current.node.id !== targetNode.id) {
          // The panel has since closed, or moved on to a different stale
          // Node — this response is stale for the PANEL's own display
          // (the map card was already patched above regardless), so discard
          // applying it to `nodeDetail`/`regenerateState` rather than let it
          // clobber whatever the user is now looking at (Round 1 fix).
          return;
        }
        if (result.status === 'ok') {
          updateNodeDetail({ status: 'open', node: result.node });
          setRegenerateState({ kind: 'idle' });
        } else {
          setRegenerateState({ kind: 'error', message: result.message });
        }
      })
      .catch((error: unknown) => {
        const current = nodeDetailRef.current;
        if (current.status !== 'open' || current.node.id !== targetNode.id) {
          return;
        }
        setRegenerateState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [nodeDetail, graphServiceAvailable]);

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

  // FIX-1: the user's own pan/zoom gesture moves the view off the fitted
  // one. `event` is null for a programmatic move (`setViewport`/`setCenter`/
  // `fitBounds`), so the fit's own animation never clears the flag. The
  // `<Controls>` buttons move programmatically too, so they clear it through
  // their own callbacks instead.
  const handleMoveStart = useCallback<OnMove>(
    (event) => {
      if (event) {
        clearRouteClamp();
      }
    },
    [clearRouteClamp],
  );

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
      const previous = containerSizeRef.current;
      if (previous.width !== width || previous.height !== height) {
        // FIX-1: a resized view is no longer the fitted one.
        clearRouteClamp();
      }
      containerSizeRef.current = { width, height };
      setContainerSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [clearRouteClamp]);

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

  // Dev-only selection-to-detail latency: fires once the Node Detail panel
  // this activation started is actually open.
  //
  // P0-1 (2026-09-24) retargeted this from `sourceView` to `nodeDetail`,
  // following `activateNode`, so the measurement keeps measuring the thing
  // it names (AD-14: click-to-UI-response latency). It also simplifies:
  // `nodeDetail` has no async/terminal-state problem to work around. The
  // old comment here explained that the fixture's synthetic `file` paths
  // (`fixtures/module-N.ts`, from `devFixture.ts`) back no real file on
  // disk, so `readSourceRange` errored for every fixture Node and `'open'`
  // alone left this array permanently empty — that whole hazard is gone now
  // that what activation opens is rendered from already-fetched Node data
  // with no disk I/O in the path at all.
  useEffect(() => {
    if (!isDevFixtureMode || selectionStartRef.current === null) {
      return;
    }
    if (nodeDetail.status === 'closed') {
      return;
    }
    const elapsed = performance.now() - selectionStartRef.current;
    selectionStartRef.current = null;
    getDevPerfState().selectionToDetailMs.push(elapsed);
  }, [isDevFixtureMode, nodeDetail]);

  // Story 1.4 Code Map: "build a local adjacency map ... once per
  // `fetchState.status === 'ready'` ... reused by both edge-click
  // resolution and the affordance's counts/targets." Built directly from
  // the already-fetched `CodeMapEdge[]` — no new IPC surface.
  //
  // Three review-fix exclusions applied while building it:
  // - Self-loop edges (`source === target`, a recursive call) are skipped
  //   entirely — a Node showing itself as its own "called by"/"calls"
  //   target isn't a real traversal destination.
  // - A duplicate `(source, target)` pair (two call sites between the same
  //   two functions) is only counted once per direction — an `includes`
  //   check before pushing — so the affordance's `N` reflects distinct
  //   connected Nodes, not raw edge count.
  // - Either endpoint absent from this fetch's own node set (e.g. an edge
  //   pointing at a filtered external/library target) is skipped — an
  //   affordance must never be able to target an id `flowNodesById` (built
  //   from this same node set) can never resolve.
  const adjacency = useMemo<NodeAdjacency>(() => {
    const map: NodeAdjacency = new Map();
    if (fetchState.status !== 'ready') {
      return map;
    }
    const validNodeIds = new Set(fetchState.nodes.map((node) => node.id));
    const ensure = (id: string) => {
      let entry = map.get(id);
      if (!entry) {
        entry = { callers: [], callees: [] };
        map.set(id, entry);
      }
      return entry;
    };
    for (const edge of fetchState.edges) {
      if (edge.source === edge.target) {
        continue;
      }
      if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) {
        continue;
      }
      const sourceEntry = ensure(edge.source);
      if (!sourceEntry.callees.includes(edge.target)) {
        sourceEntry.callees.push(edge.target);
      }
      const targetEntry = ensure(edge.target);
      if (!targetEntry.callers.includes(edge.source)) {
        targetEntry.callers.push(edge.source);
      }
    }
    return map;
  }, [fetchState]);

  // Story 3.1 (Phase 2): the changed-Node id set threaded into `layoutNodes`
  // below — `EMPTY_ID_SET` (never a fresh `new Set()`, so this doesn't
  // defeat `flowNodes`' own memoization on every render) whenever the mode
  // isn't `'prReview'` or no `'resolved'` diff scope exists yet (Boundaries
  // & Constraints: "switching back to Code Map Mode ... no changed-Node
  // treatment ... anywhere" — gated on `mode` here rather than in
  // `layoutNodes` itself, so the underlying `diffScopeState.nodeIds` can
  // keep existing across a mode toggle per `CodeMapProps.mode`'s own doc
  // comment, while only its *rendering* is mode-gated).
  const changedNodeIds: ReadonlySet<string> =
    mode === 'prReview' && diffScopeState.status === 'resolved' ? diffScopeState.nodeIds : EMPTY_ID_SET;

  const flowNodes = useMemo(
    () =>
      fetchState.status === 'ready'
        ? layoutNodes(
            fetchState.nodes,
            activateNode,
            showNeighbors,
            openSourceForNode,
            adjacency,
            noSummaryBackendAvailable,
            cloudSelectedNoKey,
            showDeterministicSignals,
            showLlmJudgment,
            showIngestedFindings,
            changedNodeIds,
          )
        : [],
    [
      fetchState,
      activateNode,
      showNeighbors,
      openSourceForNode,
      adjacency,
      noSummaryBackendAvailable,
      cloudSelectedNoKey,
      showDeterministicSignals,
      showLlmJudgment,
      showIngestedFindings,
      changedNodeIds,
    ],
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

  // Shared with both the live render's `lodResult` (below) and
  // `centerOnNode`'s hypothetical-viewport resolution — the same
  // already-laid-out Node-ID/position set `computeLOD` needs (Boundaries &
  // Constraints: never by array index/position — this is the position
  // `layoutNodes` already computed for each content-stable Node id, not a
  // fresh derivation from list order).
  const lodInputNodes = useMemo<LODInputNode[]>(
    () => flowNodes.map((flowNode) => ({ id: flowNode.id, position: flowNode.position })),
    [flowNodes],
  );

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
  //
  // P0-2b: short-circuited entirely in Health Audit Mode, which mounts no
  // `<ReactFlow>` — this is an O(Nodes) pass, on the app's first-open landing
  // surface, for a canvas that never appears (AD-15's budgets). arc42 §8 now
  // says this mode does not consume the LOD module; this is what makes that
  // true. `computeLOD` and `Cluster` themselves are untouched (the spec's Ask
  // First) — only whether this caller calls them.
  //
  // `lodInputNodes` above is deliberately NOT gated with it: `centerOnNode`
  // reads the same list to resolve a reveal-zoom, and handing that an empty
  // list would be a silent wrong answer rather than a skipped one. It is a
  // projection of an array `flowNodes` already built, not a second traversal.
  const lodResult = useMemo(
    () =>
      mode === 'healthAudit'
        ? EMPTY_LOD_RESULT
        : computeLOD({
            nodes: lodInputNodes,
            zoom: zoomBand,
            threshold: LOD_ZOOM_THRESHOLD,
            viewportBounds: { x: boundsX, y: boundsY, width: worldWidth, height: worldHeight },
          }),
    // Depends on the individual quantized numbers, not a `viewportBounds`
    // object literal — a fresh object every render would defeat memoization
    // even when its numeric contents are unchanged.
    [mode, lodInputNodes, zoomBand, boundsX, boundsY, worldWidth, worldHeight],
  );

  // Story 1.9 (Phase 2): the `found` path's Node ids and its consecutive-pair
  // `CALLS` edges (Code Map: "compute a Set of path Node ids +
  // consecutive-pair edges") — the two Sets `renderedNodes`/`renderedEdges`
  // below consult to thread a distinguishing `className` onto matching
  // rendered nodes/edges. Empty (never recreated) outside `'found'` so the
  // highlight clears the instant a new search starts or a prior result is
  // superseded — no separate cleanup step needed.
  // P2-4: derived by the pure `pathTraceHighlight` (a `'neighbors'` trace
  // reads its stored snapshot, highlighted like `'found'`).
  const pathHighlight = useMemo(() => pathTraceHighlight(pathTrace), [pathTrace]);
  const pathHighlightNodeIds = pathHighlight.nodeIds;

  // Story 3.2 (Phase 2): the combined blast radius's own highlight Set —
  // mirrors `pathHighlightNodeIds`'s own Set-typed, `EMPTY_ID_SET`-outside-
  // its-happy-path precedent just above, sliced locally from the whole
  // already-fetched `hopDistances` at the stepper's current depth
  // (`nodeId → distance <= currentDepth`, Always) rather than a fresh IPC
  // call per step. Gated on `mode === 'prReview'` too, same reasoning as
  // `changedNodeIds` above — a resolved blast radius persists across a mode
  // toggle (Never: "no re-triggering ... on a bare mode toggle"), but only
  // PR Review Mode itself ever renders it.
  const blastRadiusNodeIds = useMemo<ReadonlySet<string>>(() => {
    if (mode !== 'prReview' || blastRadiusState.status !== 'resolved') {
      return EMPTY_ID_SET;
    }
    const ids = new Set<string>();
    for (const [nodeId, distance] of blastRadiusState.hopDistances) {
      if (distance <= blastRadiusDepth) {
        ids.add(nodeId);
      }
    }
    return ids;
  }, [mode, blastRadiusState, blastRadiusDepth]);

  /**
   * P0-2b: Health Audit Mode's cluster-card grid, grouped by P0-2a's pure
   * helper. Keyed only on `[mode, fetchState]` — never on `lodResult` — for
   * the same reason Story 4.1's deleted per-Node count scan was: `lodResult`
   * recomputes on every pan/zoom that crosses a quantization boundary, and
   * this O(total Nodes) grouping's own inputs never change on that cadence.
   * In this mode there is no canvas to pan at all, but the memo must still
   * not re-run for the other two modes' viewport traffic.
   *
   * `null` outside Health Audit Mode, or before the fetch is `ready`, so the
   * JSX gate below is a plain null check and the existing loading/empty/
   * degraded notices keep the surface to themselves (I/O Matrix: "Existing
   * notice only; no grid, no empty card frame").
   *
   * Deliberately NOT gated on the three signal-family toggles — those are
   * Code Map canvas rendering preferences, and this is Health Audit Mode's
   * own Risk Overlay reading of what a Node carries. `family: 'ingested'` is
   * excluded by `riskCountForNode` for the same reason: Epic 3's PR-bot
   * findings are not part of Epic 2's Risk Overlay.
   */
  const healthClusters = useMemo<HealthClusterGrouping | null>(() => {
    if (mode !== 'healthAudit' || fetchState.status !== 'ready') {
      return null;
    }
    return groupNodesIntoHealthClusters(fetchState.nodes);
  }, [mode, fetchState]);

  // P0-2b: likewise skipped in Health Audit Mode — see `lodResult` above.
  // Without this, every flow node and the whole `flowEdges` filter/map pass
  // would still be built for a canvas that never mounts.
  const { renderedNodes, renderedEdges } = useMemo(() => {
    if (mode === 'healthAudit') {
      return { renderedNodes: EMPTY_FLOW_NODES, renderedEdges: EMPTY_FLOW_EDGES };
    }
    const visibleNodeIds = new Set(lodResult.fullNodeIds);
    const nodes: CodeMapAnyFlowNode[] = [];

    // Story 1.9 (Phase 2): a highlighted path Node gets an additional
    // `className` on the `@xyflow/react` node wrapper itself (no existing
    // highlight mechanism to extend — Code Map) — never mutating the shared
    // `flowNode` object from `flowNodesById` in place, since that same
    // object is reused across renders/clusters.
    // Only applied to a full (non-clustered) rendered card — a path Node
    // still folded into an unexpanded LOD cluster has no card of its own to
    // mark. FIX-1: once a route fit settles, the zoom is at or above
    // `ROUTE_MIN_READABLE_ZOOM` (a sprawling route's fit — measured at 0.14
    // live — clamps to that floor on the route's first Node instead; the
    // unmeasured-viewport `fitBounds` fallback is lifted to it after its
    // animation), so the route's on-screen Nodes render as cards post-fit.
    //
    // Story 3.2 (Phase 2): renamed from `withPathHighlight` and extended to
    // also thread the blast-radius highlight's own `className` onto the same
    // wrapper — both classes can legitimately land on the same Node at once
    // (Boundaries & Constraints: "A Node CAN be both path-highlighted and
    // blast-radius-highlighted at once; that combination must stay visually
    // distinguishable ... via an explicit combined selector"), so this joins
    // whichever of the two apply into one space-separated `className` rather
    // than the two highlights fighting over a single value (only one branch
    // of a ternary could ever win). `styles.css`'s own
    // `.code-map__path-highlight.code-map__blast-radius-highlight` selector
    // is what resolves that combination once both classes are present here.
    const withHighlight = (flowNode: CodeMapFlowNode): CodeMapFlowNode => {
      const classNames: string[] = [];
      if (pathHighlightNodeIds.has(flowNode.id)) {
        classNames.push('code-map__path-highlight');
      }
      if (blastRadiusNodeIds.has(flowNode.id)) {
        classNames.push('code-map__blast-radius-highlight');
      }
      return classNames.length > 0 ? { ...flowNode, className: classNames.join(' ') } : flowNode;
    };

    for (const id of lodResult.fullNodeIds) {
      const flowNode = flowNodesById.get(id);
      if (flowNode) {
        nodes.push(withHighlight(flowNode));
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
            nodes.push(withHighlight(flowNode));
            visibleNodeIds.add(nodeId);
          }
        }
        continue;
      }
      // P3-11: PR Review's changed marker (`0` everywhere else).
      const changedCount = changedMemberCount(cluster.nodeIds, changedNodeIds);
      const clusterNode: CodeMapClusterFlowNode = {
        id: cluster.id,
        type: 'codeMapCluster',
        position: cluster.position,
        data: { cluster, onExpand: expandCluster, changedCount },
      };
      nodes.push(clusterNode);
    }

    // P3-11: see `assembleRenderedEdges` — card-to-card edges, plus a
    // changed Node's edges re-anchored on a cluster, all highlight-threaded.
    const edges = assembleRenderedEdges({
      flowEdges,
      clusters: lodResult.clusters,
      expandedClusterIds,
      visibleNodeIds,
      changedNodeIds,
      pathHighlight,
    });

    return { renderedNodes: nodes, renderedEdges: edges };
  }, [
    mode,
    lodResult,
    flowNodesById,
    expandedClusterIds,
    expandCluster,
    flowEdges,
    pathHighlightNodeIds,
    pathHighlight,
    blastRadiusNodeIds,
    changedNodeIds,
  ]);

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

  // The shared traversal primitive (Story 1.4 Code Map: `navigateToNode`)
  // both a fresh edge/affordance click and a Back/Forward replay funnel
  // through — everything except history bookkeeping, which only the
  // former does (see `navigateToNodeImpl` vs. `goBack`/`goForward` below).
  // Returns whether it actually moved the viewport (false if the target
  // Node or the `<ReactFlow>` instance can't be resolved — defensive; every
  // edge/affordance target is a real Node ID sourced from the already-
  // fetched map, so this should not happen in practice).
  const centerOnNode = useCallback(
    (id: string): boolean => {
      const flowNode = flowNodesById.get(id);
      const instance = reactFlowInstanceRef.current;
      if (!flowNode || !instance) {
        // Review fix: was a fully silent no-op — this is the one signal
        // that surfaces a stale/unresolvable traversal target during
        // development (e.g. a history entry left over from a discarded map
        // before fix #1, or an adjacency id that somehow still doesn't
        // resolve despite fix #10's validation).
        console.warn(
          `CodeMap: navigateToNode couldn't center on "${id}" — ${
            !flowNode ? 'no Node with that id in the current map' : 'the ReactFlow instance is not ready yet'
          }.`,
        );
        return false;
      }
      const currentZoom = instance.getViewport().zoom;
      // Boundaries & Constraints: "Re-centering onto a Node currently
      // inside a collapsed LOD cluster also zooms in enough to cross the
      // cluster threshold at that position — never a re-center that lands
      // on a still-clustered point." `resolveZoomToRevealNode` is a no-op
      // (returns `currentZoom` unchanged) when the target already resolves
      // full at the current zoom.
      const zoom = resolveZoomToRevealNode({
        targetId: id,
        targetPosition: flowNode.position,
        nodes: lodInputNodes,
        currentZoom,
        threshold: LOD_ZOOM_THRESHOLD,
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
      });
      instance.setCenter(flowNode.position.x, flowNode.position.y, { zoom, duration: 300 });
      focusedNodeIdRef.current = id;
      return true;
    },
    [flowNodesById, lodInputNodes, containerSize],
  );

  // Pure history-stack update (no side effects — safe under React's dev-
  // mode double-invocation of state updaters): truncates any forward
  // entries past the current position before appending, exactly like a
  // browser's own history stack.
  const pushHistory = useCallback((id: string) => {
    setHistory((previous) => {
      const truncated = previous.stack.slice(0, previous.index + 1);
      // Review fix: two navigations resolving to the same Node back-to-back
      // (an edge and an affordance both pointing at the same neighbor, or a
      // duplicate click) would otherwise push a second identical entry,
      // making a single Back click look like it did nothing. A no-op
      // navigation leaves history exactly as-is — including any forward
      // entries past it, the same way a browser doesn't clear forward
      // history just because you "navigated" to the page you're already on.
      if (truncated[truncated.length - 1] === id) {
        return previous;
      }
      let nextStack = [...truncated, id];
      let nextIndex = nextStack.length - 1;
      // Review fix: unlike `expandedClusterIds`, nothing here naturally
      // trims stale entries — cap and trim from the front (oldest first),
      // shifting `index` down by the same amount so it keeps pointing at
      // the same logical (now-renumbered) entry.
      if (nextStack.length > MAX_HISTORY_LENGTH) {
        const overflow = nextStack.length - MAX_HISTORY_LENGTH;
        nextStack = nextStack.slice(overflow);
        nextIndex -= overflow;
      }
      return { stack: nextStack, index: nextIndex };
    });
  }, []);

  const navigateToNodeImpl = useCallback(
    (id: string) => {
      if (centerOnNode(id)) {
        pushHistory(id);
      }
    },
    [centerOnNode, pushHistory],
  );

  // Keeps `navigateToNode`'s stable wrapper (see its declaration above)
  // pointed at the current implementation — see that declaration's comment
  // for why this indirection exists.
  useEffect(() => {
    navigateToNodeImplRef.current = navigateToNodeImpl;
  }, [navigateToNodeImpl]);

  const handleEdgeClick: EdgeMouseHandler<FlowEdge> = useCallback(
    (_event, edge) => {
      // P3-11: a synthetic cluster edge's rendered endpoints include a
      // cluster id, which must never reach `navigateToNode` — resolve on the
      // real Node pair it stands in for. `navigateToNode` → `centerOnNode`
      // is LOD-aware (`resolveZoomToRevealNode`), so a folded target is
      // zoomed into view as a card.
      navigateToNode(edgeClickTarget(edge, focusedNodeIdRef.current));
    },
    [navigateToNode],
  );

  // Back/Forward only move `history.index` and replay the viewport move via
  // `centerOnNode` — they never call `navigateToNode`/`pushHistory`, which
  // would truncate-and-append a fresh entry and make Forward permanently
  // unreachable after every Back.
  const goBack = useCallback(() => {
    if (history.index <= 0) {
      return;
    }
    const nextIndex = history.index - 1;
    const id = history.stack[nextIndex];
    if (id === undefined) {
      return;
    }
    // Review fix: only move `history.index` if `centerOnNode` actually
    // succeeded — a stale id (e.g. one somehow left over across a map
    // reload) or the ReactFlow instance not being ready would otherwise
    // move the toolbar's position without moving the viewport, permanently
    // desyncing that history slot. `centerOnNode` itself already logs a
    // `console.warn` on failure (fix #5).
    if (!centerOnNode(id)) {
      return;
    }
    setHistory((previous) => ({ ...previous, index: nextIndex }));
  }, [history, centerOnNode]);

  const goForward = useCallback(() => {
    if (history.index >= history.stack.length - 1) {
      return;
    }
    const nextIndex = history.index + 1;
    const id = history.stack[nextIndex];
    if (id === undefined) {
      return;
    }
    // Review fix: see `goBack`'s matching comment — only advance on success.
    if (!centerOnNode(id)) {
      return;
    }
    setHistory((previous) => ({ ...previous, index: nextIndex }));
  }, [history, centerOnNode]);

  // FIX-1: the map's measured size — this component's ResizeObserver first,
  // then `@xyflow/react`'s store — or 0×0 when neither has measured yet.
  // Reads refs only, so it is stable across renders.
  const measuredViewportSize = useCallback((): { width: number; height: number } => {
    const own = containerSizeRef.current;
    if (own.width > 0 && own.height > 0) {
      return own;
    }
    const store = reactFlowStoreRef.current?.getState();
    return { width: store?.width ?? 0, height: store?.height ?? 0 };
  }, []);

  /**
   * Story 1.9 (Phase 2): fits the viewport to show every Node in a `found`
   * path at once (Boundaries & Constraints: "an off-screen highlight isn't
   * one"). Computes the bounding box directly from `flowNodesById`'s own
   * laid-out positions — the same world-space source `centerOnNode`/
   * `resolveZoomToRevealNode` already read from above — rather than
   * `reactFlowInstance.fitView({ nodes })`, which can only resolve Nodes
   * currently registered in `@xyflow/react`'s own internal store (i.e.
   * already present in `renderedNodes`); a path Node still folded into an
   * unexpanded LOD cluster wouldn't be in that store yet, so `fitView`
   * alone could silently fail to include it. `fitBounds` has no such
   * requirement — it just needs the raw rectangle.
   *
   * FIX-1: `routeFitRequest` + `routeViewport` decide the target viewport,
   * applied with `setViewport` — a route that would only fit below
   * `ROUTE_MIN_READABLE_ZOOM` is clamped to that floor and anchored on the
   * centre of its first Node's card, and `routeFit` records the clamp for
   * the step panel. With no measured size at all it falls back to
   * `fitBounds`, then lifts that result to the floor once it settles.
   */
  const fitViewToPath = useCallback(
    (path: string[]) => {
      const instance = reactFlowInstanceRef.current;
      if (!instance) {
        console.warn('CodeMap: tracePath found a path but the ReactFlow instance is not ready yet.');
        return;
      }
      const seq = ++routeFitSeqRef.current;
      // Absolute positions: `internals.positionAbsolute` when the card is in
      // `@xyflow/react`'s store (it accounts for a `parentId`, though
      // `layoutNodes` never sets one), else the laid-out world position
      // (a card folded into an LOD cluster isn't in the store).
      const positionsById = new Map<string, { x: number; y: number }>();
      for (const id of path) {
        const position = instance.getInternalNode(id)?.internals.positionAbsolute ?? flowNodesById.get(id)?.position;
        if (position) {
          positionsById.set(id, position);
        }
      }
      const firstMeasured = path[0] !== undefined ? instance.getInternalNode(path[0])?.measured : undefined;
      const cardSize =
        firstMeasured?.width && firstMeasured.height
          ? { width: firstMeasured.width, height: firstMeasured.height }
          : { width: NODE_CARD_FALLBACK_WIDTH, height: NODE_CARD_FALLBACK_HEIGHT };
      const request = routeFitRequest(path, positionsById, cardSize, measuredViewportSize());
      if (request === null) {
        return;
      }
      if ('params' in request) {
        const next = routeViewport(request.params);
        setRouteFit({ route: path, clamped: next.clamped });
        void instance.setViewport({ x: next.x, y: next.y, zoom: next.zoom }, { duration: 300 });
        return;
      }
      // FIX-1 (I/O Matrix: viewport not measured yet): neither this
      // component's ResizeObserver nor `@xyflow/react`'s store has a size, so
      // fall back to the pre-FIX-1 `fitBounds` — then, once it settles, lift
      // its zoom to the readable floor on the anchor if it landed below.
      //
      // `console.warn` rather than `window.driller.logDiagnosticEvent`: that
      // AD-21 sink's `DiagnosticLogEntry` is a closed union with one member
      // (`'path-trace-dismissed'`) that main validates, so logging this would
      // mean a new IPC contract event type — out of FIX-1's scope.
      if (!routeFitFallbackWarnedRef.current) {
        routeFitFallbackWarnedRef.current = true;
        console.warn('CodeMap: fitting a traced route before the map viewport was measured; using fitBounds.');
      }
      const { bounds, anchor } = request.fallback;
      setRouteFit({ route: path, clamped: false });
      void instance.fitBounds(bounds, { duration: 300 }).then(() => {
        if (routeFitSeqRef.current !== seq || reactFlowInstanceRef.current !== instance) {
          return;
        }
        if (instance.getViewport().zoom >= ROUTE_MIN_READABLE_ZOOM) {
          return;
        }
        // Anchored as a clamped `routeViewport` result would be: the floor,
        // centred on the anchor in whatever size has been measured by now.
        const size = measuredViewportSize();
        const zoom = Math.min(ROUTE_MIN_READABLE_ZOOM, MAP_MAX_ZOOM);
        setRouteFit({ route: path, clamped: true });
        void instance.setViewport(
          { x: size.width / 2 - anchor.x * zoom, y: size.height / 2 - anchor.y * zoom, zoom },
          { duration: 300 },
        );
      });
    },
    // FIX-1: deliberately not `containerSize` — see `containerSizeRef`.
    [flowNodesById, measuredViewportSize],
  );

  /**
   * P2-4: a Node card pill's 1-hop neighbour trace. Replaces whatever Path
   * Trace state is showing (a search result, or another pill's trace) and
   * fits the view to the origin plus its neighbours, as `'found'` does.
   * Bumping `pathTraceRequestIdRef` means a search still in flight can't
   * land on top of it afterwards — the pill is the newer intent.
   */
  const showNeighborsImpl = useCallback(
    (originId: string, direction: NeighborDirection) => {
      const trace = neighborTrace(adjacency, originId, direction);
      if (trace.neighborIds.length === 0) {
        return;
      }
      pathTraceRequestIdRef.current += 1;
      setPathTrace({ status: 'neighbors', originId, direction, ...trace });
      fitViewToPath(trace.nodeIds);
    },
    [adjacency, fitViewToPath],
  );
  useEffect(() => {
    showNeighborsImplRef.current = showNeighborsImpl;
  }, [showNeighborsImpl]);

  /**
   * The shared "run a trace, apply the result" round trip (Story 1.9, Phase
   * 3 extraction — Phase 2 had this inlined directly in
   * `handlePathTraceSubmit` below, but a disambiguation-candidate click
   * needs the identical staleness-guarded round trip with a different query
   * source: the picked candidate's exact `id`, not the input field's typed
   * text). Boundaries & Constraints: transitions to `searching` before
   * `tracePath` resolves — which also clears any previous
   * highlight/step-list/notice, since those are all derived from
   * `pathTrace`, and setting it to `searching` moves it away from whatever
   * `'found'`/`'ambiguous'`/`'no-path-found'`/`'error'` it last held the
   * instant this fires — and no-ops entirely while already `searching`
   * (also belt-and-suspenders disabled on the input/button/candidate
   * buttons themselves below).
   *
   * Review fix (Phase 2, still applies): `pathTraceRequestIdRef` is bumped
   * and captured before the async call, then checked again once it
   * resolves/rejects — a Retry/reload in the meantime (`loadCodeMap`, which
   * bumps this same ref) must not let a since-superseded response apply a
   * highlight/step-list for a Node id that no longer belongs to the current
   * map.
   */
  const runPathTrace = useCallback(
    (query: string) => {
      if (pathTrace.status === 'searching') {
        return;
      }
      const requestId = ++pathTraceRequestIdRef.current;
      // Review fix (Phase 4): captured here, not from `pathQuery` state — see
      // `lastTracedQueryRef`'s own doc comment for why the two can diverge.
      lastTracedQueryRef.current = query;
      setPathTrace({ status: 'searching' });
      window.driller
        .tracePath(query)
        .then((result) => {
          if (pathTraceRequestIdRef.current !== requestId) {
            // Superseded by a Retry/reload (or another search) — discard
            // rather than let it clobber the map the user is now looking at.
            return;
          }
          setPathTrace(result);
          if (result.status === 'found') {
            fitViewToPath(result.path);
          }
        })
        .catch((error: unknown) => {
          if (pathTraceRequestIdRef.current !== requestId) {
            return;
          }
          setPathTrace({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [pathTrace.status, fitViewToPath],
  );

  /**
   * The search toolbar's submit handler (Story 1.9, Phase 2) — now a thin
   * wrapper around `runPathTrace` (Phase 3 extraction, see its doc comment
   * above).
   *
   * Review fix: a trimmed-empty query is rejected client-side before ever
   * calling `tracePath` — `traceCallPath`'s own substring-match tier
   * (`name.includes(normalizedQuery)`) is vacuously true for `''`, so an
   * empty/whitespace-only query would otherwise silently match every Node
   * and trace from whichever sorts first by id, rather than reaching
   * `'no-path-found'`. Mirrors the same trim+reject-empty guard Phase 1's
   * own `apps/desktop/main/index.ts` IPC handler already applies for this
   * exact reason. A disambiguation candidate's `id` (`runPathTrace`'s other
   * call site, in the JSX below) needs no such guard — it's always a real,
   * non-empty Node id, never user-typed free text.
   *
   * P0-2b: what to do — including whether to leave Health Audit Mode first,
   * and in which order — is `resolvePathTraceSubmit`'s, not this handler's.
   * This is only the interpreter that performs the effects it returns, so the
   * decision is pure, exported and directly testable rather than something a
   * test can only re-transcribe. Both the trimmed-empty rejection and the
   * "switch before you trace" ordering live there; see its doc comment.
   *
   * Only the submit path resolves effects, never `runPathTrace` itself: its
   * other caller is a disambiguation-candidate click, which now renders only
   * while the canvas does (`CodeMapSurfaces.pathTraceResult`).
   */
  const handlePathTraceSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // P0-3: belt-and-suspenders on top of the disabled submit button.
      if (!graphServiceAvailable) {
        return;
      }
      for (const effect of resolvePathTraceSubmit(mode, pathQuery)) {
        if (effect.kind === 'requestCodeMapMode') {
          onRequestCodeMapMode();
        } else {
          runPathTrace(effect.query);
        }
      }
    },
    [pathQuery, runPathTrace, mode, onRequestCodeMapMode, graphServiceAvailable],
  );

  /**
   * Story 1.9 (Phase 4): "Dismiss" — shown only on `found`/`no-path-found`/
   * `ambiguous` results (the AC's explicit list; never `searching`/`idle`/
   * `error`). Fires a fire-and-forget diagnostic-log write for driller's
   * first local-only signal-accuracy sink (AD-21) and unconditionally resets
   * the panel to `idle` — the reset never waits on the log write settling,
   * and a write failure (swallowed/console-logged in main only) never blocks
   * or surfaces here (Boundaries & Constraints). Also resolves Phase 2's
   * deferred "no clear-search affordance" gap as a side effect (Always).
   */
  const handleDismissPathTrace = useCallback(
    (resultStatus: 'found' | 'no-path-found' | 'ambiguous') => {
      window.driller
        .logDiagnosticEvent({
          eventType: 'path-trace-dismissed',
          timestamp: new Date().toISOString(),
          // Review fix: the query that actually produced the currently-
          // displayed result, not live `pathQuery` input-field state — see
          // `lastTracedQueryRef`'s own doc comment.
          query: lastTracedQueryRef.current,
          resultStatus,
        })
        .catch(() => {
          // Fire-and-forget (Boundaries & Constraints): a log-write failure
          // is already swallowed/console-logged in main; nothing further to
          // do here, and this must never block the reset below.
        });
      setPathTrace({ status: 'idle' });
    },
    [],
  );

  // P2-4: the neighbour trace's own Dismiss. Not a Path Trace search result,
  // so there is no traced query to log (Story 1.9 Phase 4's sink records
  // search dismissals only) — it just clears.
  const handleDismissNeighborTrace = useCallback(() => {
    setPathTrace({ status: 'idle' });
  }, []);

  const closeSourceView = useCallback(() => {
    // Invalidate any in-flight `openInEditor` request the same way a fresh
    // `openSourceForNode` call does — a late reply must never resurrect
    // `openInEditorState` after the overlay it belonged to is gone.
    openInEditorRequestIdRef.current += 1;
    setOpenInEditorState({ status: 'idle' });
    setSourceView({ status: 'closed' });
  }, []);

  /**
   * Wires the source overlay's "Open in external editor" button to
   * `window.driller.openInEditor` (Story 1.10, Phase 2) — main resolves
   * `node.file` to an absolute path and launches the Phase 1-configured
   * editor at `node.startLine`. Every failure surfaces as an explicit
   * Actionable Notice via `openInEditorState`, rendered next to the source
   * panel's own error convention — never a silent no-op.
   *
   * Review fix: the "Editor not found / handler unavailable... check
   * install or Settings" framing is only accurate for a `result.stage ===
   * 'launch'` failure (an `openExternal` rejection, or a non-empty
   * `openPath` result) — a `'validate'`/`'resolve'` failure (a malformed
   * request, no project open, or a containment violation) never even
   * reached the launch attempt, so those are shown plainly instead (same
   * convention as the source panel's own `Couldn't open source:` message
   * just above), rather than misattributing the cause and suggesting an
   * install/Settings fix that wouldn't address it.
   */
  const handleOpenInEditor = useCallback((node: CodeMapNode) => {
    const requestId = ++openInEditorRequestIdRef.current;
    setOpenInEditorState({ status: 'opening' });
    window.driller
      .openInEditor(node.file, node.startLine)
      .then((result) => {
        if (openInEditorRequestIdRef.current !== requestId) {
          // Superseded by closing the overlay or opening a different Node —
          // discard rather than let a stale reply clobber the current view.
          return;
        }
        if (result.status === 'ok') {
          setOpenInEditorState({ status: 'idle' });
        } else if (result.stage === 'launch') {
          setOpenInEditorState({
            status: 'error',
            message: `Editor not found / handler unavailable: ${result.message}. Check that it's installed, or change the editor in Settings.`,
          });
        } else {
          setOpenInEditorState({ status: 'error', message: result.message });
        }
      })
      .catch((error: unknown) => {
        if (openInEditorRequestIdRef.current !== requestId) {
          return;
        }
        // The IPC call itself rejected, rather than resolving with an
        // explicit `OpenInEditorResult` — an unexpected lower-level
        // failure with no `stage` to check, so this also uses the plain
        // framing rather than assuming the cause was a launch failure.
        setOpenInEditorState({
          status: 'error',
          message: `Couldn't open in editor: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }, []);

  // P2-7 + P2-8: the source overlay and Node Detail are layers on the
  // shared modal stack (`useModalLayer`) — one Escape closes only the top
  // layer, Tab stays inside it, focus returns to whatever opened it, and a
  // press on a layer's own dimmed backdrop closes that layer only.
  const sourceOverlayRef = useRef<HTMLDivElement | null>(null);
  const sourceScrimProps = useModalLayer({
    open: sourceOverlayOpen(sourceView),
    onClose: closeSourceView,
    containerRef: sourceOverlayRef,
  });
  const nodeDetailOverlayRef = useRef<HTMLDivElement | null>(null);
  const nodeDetailScrimProps = useModalLayer({
    open: nodeDetailOverlayOpen(nodeDetail),
    onClose: closeNodeDetail,
    containerRef: nodeDetailOverlayRef,
  });

  // Review fix: a plain boolean, computed once here rather than re-reading
  // `pathTrace.status === 'searching'` inline inside the `ambiguous` JSX
  // branch below — TS narrows `pathTrace` to its `'ambiguous'` member for
  // the whole of that branch (it's how `pathTrace.candidates` is accessible
  // there at all), so a literal `pathTrace.status === 'searching'` comparison
  // written inside it doesn't type-check (the two members never overlap).
  // Hoisting the read to here, before any narrowing, keeps the candidate
  // buttons' `disabled` belt-and-suspenders guard consistent with the
  // search input/submit button just below without fighting the type
  // checker — always `false` while the `ambiguous` panel is actually
  // rendered (searching moves `pathTrace` away from `'ambiguous'` and
  // unmounts it), same defense-in-depth reasoning as those two.
  const pathTraceIsSearching = pathTrace.status === 'searching';

  // The PR Review notice (if any) and which surfaces are on, from one pure
  // derivation (`resolvePrReviewView`) that a test pins. The canvas, the
  // history toolbar and Path Trace each read a named property of `surfaces`
  // rather than restating the condition, so no copy can drift. The notice
  // annotates the map; it never gates a surface. A diff-scope `'error'` is
  // not a notice status: it renders inline in the PR Review toolbar, same
  // convention as `pathTrace.status === 'error'`.
  const { noticeStatus: prReviewNoticeStatus, surfaces } = resolvePrReviewView(mode, fetchState, diffScopeState);

  // P0-2b: `reactFlowInstanceRef` is written once, in `handleInit`, and was
  // never cleared because before this spec the canvas only ever unmounted with
  // the whole component. It now unmounts on every switch into Health Audit
  // Mode, so without this the ref would keep a dead instance and the
  // `if (!instance)` guards in `fitViewToPath`/`centerOnNode` could never fire
  // again — they would call `fitBounds`/`setCenter` on an unmounted instance,
  // silently, with not even the warning those guards exist to print.
  useEffect(() => {
    if (!surfaces.canvas) {
      reactFlowInstanceRef.current = null;
    }
  }, [surfaces.canvas]);

  // Story 3.2 (Phase 2): the stepper's own upper bound — "its own 'further'"
  // (Always: "the stepper's upper bound is the maximum hop distance actually
  // present in the result"), `0` whenever there's no resolved blast radius to
  // bound at all. Hoisted here (mirrors `surfaces`' own
  // hoist-before-return reasoning) as a plain number so the "+" button's
  // `disabled` check and its `onClick` handler below can both close over it
  // without re-narrowing `blastRadiusState.status` inside a nested callback.
  const blastRadiusMaxDepth = blastRadiusState.status === 'resolved' ? blastRadiusState.maxDepth : 0;

  // P1-2: the Node Detail panel's summary action (Regenerate / Generate
  // summary / none) — hoisted here, like `blastRadiusMaxDepth`, rather than
  // computed in an IIFE inside the JSX below.
  const nodeDetailAction =
    nodeDetail.status === 'open' ? nodeDetailSummaryAction(nodeDetail.node.summaryStatus) : null;

  return (
    // P2-7 + P2-8: the id (and `tabIndex={-1}`) make this the modal layers'
    // focus fallback when a closed layer's opener has left the document.
    <div className="code-map" ref={containerRef} id={MODAL_FOCUS_FALLBACK_ID} tabIndex={-1}>
      {/* Story 3.1 (Phase 2): the base-ref input + trigger — rendered
          whenever `mode === 'prReview'`, independent of `fetchState`
          entirely (Boundaries & Constraints: "the base-ref input/trigger
          stays visible alongside the notice"), so it survives every
          notice/map state below it. The three diff-scope Actionable Notices
          render inside this block, under the input, so they sit above the
          map rather than in its place. Positioned top-center (its own
          `.code-map__pr-review`, absolute + `z-index: 5`, styles.css) —
          every other corner is already claimed (`.code-map__history-
          toolbar` top-right, `.code-map__path-trace` top-left,
          `.code-map__signal-toggle-panel` bottom-right via `@xyflow/react`'s
          own `Panel`, `<Controls>`'s default bottom-left) — and rendered as
          a plain absolutely-positioned sibling here, not inside `<ReactFlow>`
          via its own `Panel` the way the signal toggles are: a `Panel` only
          exists while `<ReactFlow>` itself is mounted, which the fetch-error
          and empty-map notices below replace. */}
      {mode === 'prReview' && (
        <div className="code-map__pr-review">
          <form
            className="code-map__pr-review-toolbar"
            role="toolbar"
            aria-label="PR Review base ref"
            onSubmit={handleDiffScopeSubmit}
          >
            <input
              type="text"
              className="code-map__pr-review-input"
              placeholder="Base ref (leave blank to auto-resolve)…"
              aria-label="Base ref"
              value={baseRefInput}
              onChange={(event) => setBaseRefInput(event.target.value)}
              disabled={projectPath === null || diffScopeState.status === 'loading'}
              aria-describedby={prReviewNoticeStatus !== null ? PR_REVIEW_NOTICE_ID : undefined}
            />
            <button
              type="submit"
              disabled={projectPath === null || diffScopeState.status === 'loading' || !graphServiceAvailable}
              title={graphServiceAvailable ? undefined : GRAPH_SERVICE_UNAVAILABLE_TITLE}
              className={graphServiceAvailable ? undefined : SERVICE_UNAVAILABLE_CLASS}
            >
              {diffScopeState.status === 'loading' ? 'Computing…' : 'Compute diff scope'}
            </button>
          </form>

          {/* Story 3.1 (Phase 2): the three non-happy-path diff-scope
              Actionable Notices — each its own distinct sentence
              (`formatDiffScopeNotice`), shown ABOVE the map, directly under
              the base-ref input that resolves it (which names it in
              `aria-describedby`), never in the map's place. The canvas,
              Back/Forward history and Path Trace all stay: a benign "no
              changes" must not look like the project was lost, and search is
              always reachable. "Never an empty map with no explanation"
              (UX-DR15) holds because the map is not empty; with no resolved
              scope it carries no changed-Node or blast-radius treatment.
              `prReviewNoticeStatus` is `null` without a showable map — a
              fetch failure/empty map has its own notice below. The live
              region is always mounted; only its content changes. The line
              uses the toolbar's status-line styling, not the full-canvas
              `.code-map__notice`, which would cover the canvas and swallow
              its clicks. */}
          <PrReviewDiffScopeNoticeRegion status={prReviewNoticeStatus} />

          {/* Review finding (Blind Hunter): the `'idle'` state (before the
              user's first trigger click) previously rendered nothing at
              all — the ordinary map, no hint that a diff hasn't been
              computed yet. One concrete next action, matching this file's
              own Actionable Notice convention. */}
          {diffScopeState.status === 'idle' && (
            <p className="code-map__pr-review-resolved" role="status">
              Enter a base ref (or leave it blank to auto-resolve) and compute the diff scope to see changed Nodes.
            </p>
          )}
          {/* Review finding (Blind Hunter): the button's own text changing
              to "Computing…" isn't reliably announced by assistive tech on
              its own — a dedicated `role="status"` (implicit `aria-live`)
              announcement, same convention as the resolved/idle messages
              here. */}
          {diffScopeState.status === 'loading' && (
            <p className="code-map__pr-review-resolved" role="status">
              Computing diff scope…
            </p>
          )}

          {diffScopeState.status === 'resolved' && (
            <p className="code-map__pr-review-resolved" role="status">
              Diffed against <code>{diffScopeState.resolvedBaseRef}</code> —{' '}
              {diffScopeState.nodeIds.size} changed Node{diffScopeState.nodeIds.size === 1 ? '' : 's'}.
            </p>
          )}

          {/* Story 3.2 (Phase 2): the combined blast radius's own status
              line + stepper — only ever relevant once a diff scope is
              actually `'resolved'` (nothing to expand otherwise), so every
              branch here is additionally gated on that. Mirrors the
              diff-scope status line's own idle/loading/resolved/error
              rendering convention immediately above rather than introducing
              a new pattern. */}
          {diffScopeState.status === 'resolved' && blastRadiusState.status === 'loading' && (
            <p className="code-map__pr-review-resolved" role="status">
              Computing blast radius…
            </p>
          )}
          {/* Review fix (Blind Hunter + Edge Case Hunter, Medium): a
              `'resolved'` result with an empty `hopDistances` (nothing
              reachable from any changed Node) previously still rendered the
              full stepper block — "Blast radius: 0 Nodes within 1-hop."
              with both `+`/`−` permanently disabled — indistinguishable in
              shape from a working, steppable result. `blastRadiusMaxDepth`
              is `0` exactly in this case (hoisted above), so it doubles as
              the "nothing reachable" check here — a distinct short message
              instead, mirroring this toolbar's own diff-scope notice tone,
              rather than a stepper with nothing to step through. */}
          {diffScopeState.status === 'resolved' &&
            blastRadiusState.status === 'resolved' &&
            blastRadiusMaxDepth === 0 && (
              <p className="code-map__pr-review-resolved" role="status">
                No Nodes found in the blast radius.
              </p>
            )}
          {diffScopeState.status === 'resolved' &&
            blastRadiusState.status === 'resolved' &&
            blastRadiusMaxDepth > 0 && (
              <div className="code-map__blast-radius-stepper">
                <p className="code-map__pr-review-resolved" role="status">
                  Blast radius: {blastRadiusNodeIds.size} Node{blastRadiusNodeIds.size === 1 ? '' : 's'} within{' '}
                  {blastRadiusDepth}-hop{blastRadiusDepth === 1 ? '' : 's'}.
                </p>
                {/* Always: "one shared depth stepper for the whole combined
                    result — never per-Node" — a single control pair, not
                    repeated per Node. Slices the already-fetched
                    `hopDistances` locally via `blastRadiusNodeIds` above —
                    never a new IPC call per click (Never: "No per-hop-depth
                    IPC re-request"). */}
                <div
                  className="code-map__blast-radius-stepper-controls"
                  role="group"
                  aria-label="Blast radius depth"
                >
                  <button
                    type="button"
                    onClick={() => setBlastRadiusDepth((depth) => Math.max(1, depth - 1))}
                    disabled={blastRadiusDepth <= 1}
                    aria-label="Show a shallower blast radius"
                  >
                    −
                  </button>
                  <span className="code-map__blast-radius-stepper-depth">
                    {blastRadiusDepth}-hop{blastRadiusDepth === 1 ? '' : 's'}
                  </span>
                  {/* I/O Matrix: "Stepper '+' at the result's max hop ...
                      '+' control disabled; no-op" — `blastRadiusMaxDepth` is
                      the maximum hop distance actually present in this
                      result (hoisted above, Always: "its own 'further'"),
                      not an arbitrary cap. */}
                  <button
                    type="button"
                    onClick={() => setBlastRadiusDepth((depth) => Math.min(blastRadiusMaxDepth, depth + 1))}
                    disabled={blastRadiusDepth >= blastRadiusMaxDepth}
                    aria-label="Expand the blast radius further"
                  >
                    +
                  </button>
                </div>
              </div>
            )}
          {/* `BlastRadiusExpansionResult['error']` renders as an inline
              error `ActionableNotice`, the same shape the
              `DiffScopeResult['error']` notice just below uses (I/O Matrix: "`expandBlastRadius`
              fails ... inline error notice in the PR Review toolbar, mirrors
              `diffScopeState`'s own error notice"). */}
          {diffScopeState.status === 'resolved' && blastRadiusState.status === 'error' && (
            <ActionableNotice tone="error" role="alert">
              {blastRadiusState.message}
            </ActionableNotice>
          )}

          {/* `DiffScopeResult['error']` renders as an inline error
              `ActionableNotice`, the same shape the `pathTrace.status ===
              'error'` notice further down this file uses, rather than the
              full-canvas `.code-map__notice` — a genuine subprocess/`git`
              failure here still needs to surface somewhere (NFR4: no silent
              failure), but never blocks the still-interactive map. */}
          {diffScopeState.status === 'error' && (
            <ActionableNotice tone="error" role="alert">
              {diffScopeState.message}
            </ActionableNotice>
          )}
        </div>
      )}

      {/* P0-3: a failed refresh keeps the last completed map (above) and
          says so here, with a Retry that re-runs only the refresh — never
          `loadCodeMap`'s full reset of viewport and history. */}
      {refreshError !== null && fetchState.status === 'ready' && (
        <div className="code-map__refresh-error" role="status">
          <RefreshErrorNotice
            graphServiceAvailable={graphServiceAvailable}
            message={refreshError}
            onRetry={refreshCodeMap}
          />
        </div>
      )}

      {fetchState.status === 'loading' && (
        <div className="code-map__notice" role="status">
          Loading Code Map…
        </div>
      )}

      {fetchState.status === 'error' && (
        <div className="code-map__notice code-map__notice--error" role="alert">
          <p>
            <span aria-hidden="true">{ACTIONABLE_NOTICE_GLYPHS.error}</span>{' '}
            <span className="visually-hidden">{`${ACTIONABLE_NOTICE_SPOKEN_PREFIX.error} `}</span>
            Couldn&rsquo;t load the Code Map: {fetchState.message}
          </p>
          <button type="button" onClick={loadCodeMap}>
            Retry
          </button>
        </div>
      )}

      {fetchState.status === 'ready' && fetchState.nodes.length === 0 && (
        <div className="code-map__notice" role="status">
          <EmptyMapNotice
            hiddenByScope={fetchState.hiddenByScope}
            appliedScope={fetchState.appliedScope}
            graphServiceAvailable={graphServiceAvailable}
            reindexPending={reindexPending}
            onOpenSettings={onOpenSettings}
            onReindex={handleReindex}
          />
        </div>
      )}

      {/* P0-2b: Health Audit Mode's own surface, rendered in place of the
          `<ReactFlow>` canvas below (and of the history toolbar further down)
          — a genuinely different surface, visible at the default zoom with no
          panning or zooming, rather than Story 4.1's cluster tint, which only
          ever appeared below `LOD_ZOOM_THRESHOLD` (0.2) and so was invisible
          at a real repo's `fitView`. */}
      {/* P0-2c: `openNodeDetail`, not `activateNode`. Calling the open path
          directly is what keeps the promise that a row activation is not a
          mode switch, a canvas mount or a Path Trace side effect — but be
          precise about what skipping `activateNode` costs, because neither of
          its two side effects is scoped to the canvas:

          - `focusedNodeIdRef` is component-wide and outlives a mode change.
            A grid activation deliberately does not write it, so after opening
            Nodes here and switching to Code Map Mode, `resolveEdgeClickTarget`
            still resolves against whatever was last activated ON THE CANVAS
            (or nothing). That is a degradation, not a defect: the resolver's
            final branch returns `edge.target` whenever the focused id matches
            neither endpoint, which is the same answer a fresh session gives.
            Writing it from here would be the worse option — it would claim a
            Node as the canvas's traversal origin without the user ever having
            been on the canvas.
          - The dev-fixture `selectionToDetailMs` timer is likewise skipped;
            see `DrillerDevPerfWindow`'s note on what that excludes. */}
      {surfaces.healthAuditGrid && healthClusters !== null && (
        <HealthAuditClusterGrid grouping={healthClusters} onActivateNode={openNodeDetail} />
      )}

      {surfaces.canvas && (
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
          // Story 1.4, FR4: clicking an edge re-centers the map on the
          // connected Node without leaving map context — additive to
          // Story 1.3's existing click-a-Node's-body-opens-source
          // behavior (`onNodeClick`), never a replacement for it.
          onEdgeClick={handleEdgeClick}
          onInit={handleInit}
          onMove={handleMove}
          onMoveStart={handleMoveStart}
          maxZoom={MAP_MAX_ZOOM}
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
          {/* DESIGN.md `canvas.grid`: a `{colors.border}` dot grid at the
              `{spacing.canvas-grid}` (40px) cell size — the "dot-grid canvas
              like a schematic notebook" Brand & Style calls out. `gap`/
              `color` are `@xyflow/react`'s own props for this (no CSS hook
              exists for either); the canvas background itself is set via
              `.code-map .react-flow` in styles.css, not here. */}
          <Background gap={40} color="var(--border)" />
          <Controls
            showInteractive={false}
            onZoomIn={clearRouteClamp}
            onZoomOut={clearRouteClamp}
            onFitView={clearRouteClamp}
          />
          <ReactFlowStoreBridge storeRef={reactFlowStoreRef} />
          {/* Story 2.1 (Phase 3): driller's first custom map-level control —
              a `Panel`-hosted checkbox toggling the whole deterministic
              `riskSignals` layer's visibility (Boundaries & Constraints:
              renderer-local `useState`, no persistence, no IPC — only the
              whole family toggles, never individual signal types within
              it). Review round (patch): `bottom-right`, not `top-right` —
              every other corner is already claimed by pre-existing chrome
              this phase doesn't touch: `.code-map__history-toolbar`
              (top-right, Story 1.4), `.code-map__path-trace` (top-left,
              Story 1.9), and React Flow's own `<Controls>` default
              (bottom-left) — `top-right` would have sat directly on top of
              the history toolbar (same corner, same `z-index: 5`, nearly
              identical offset). `bottom-right` is the one corner nothing
              else claims. Review round (patch): `role="group"
              aria-label="Risk signal layer controls"` — this Panel had
              neither, unlike `.code-map__history-toolbar`'s own
              `role="toolbar" aria-label=...` a few lines below, which this
              comment already cites as the chrome convention to match (Blind
              Hunter). Visible label reads "Risk signals", not "Deterministic
              signals" — `family: 'deterministic'` is this codebase's own
              internal taxonomy (distinguishing it from Story 2.2/2.3's
              future `llm-judgment`/`ingested` families), not end-user
              copy — a user with no visibility into that distinction
              couldn't infer what the checkbox does from the internal term
              alone (Blind Hunter). */}
          <Panel
            position="bottom-right"
            className="code-map__signal-toggle-panel"
            role="group"
            aria-label="Risk signal layer controls"
          >
            <label className="code-map__signal-toggle">
              <input
                type="checkbox"
                checked={showDeterministicSignals}
                onChange={(event) => setShowDeterministicSignals(event.target.checked)}
              />
              Risk signals
            </label>
            {/* Story 2.2 (Phase 3): the LLM-judgment layer's own checkbox —
                added to this same Panel rather than a new one (Boundaries &
                Constraints: "not a second floating Panel" — every remaining
                map corner is already claimed, per Story 2.1 Phase 3's own
                review-round finding cited on the Panel above). A fully
                independent `useState`/handler — never reads or writes
                `showDeterministicSignals`. Visible label reads "AI
                judgment", matching the callout's own "AI judgment:" framing
                (this story's Intent) rather than the internal `'llm-
                judgment'` family name. */}
            <label className="code-map__signal-toggle">
              <input
                type="checkbox"
                checked={showLlmJudgment}
                onChange={(event) => setShowLlmJudgment(event.target.checked)}
              />
              AI judgment
            </label>
            {/* Story 2.3 (Phase 4): the ingested-PR-bot-findings layer's own
                checkbox — added to this same Panel rather than a new one
                (same "not a second floating Panel" reasoning Story 2.2
                Phase 3's own comment above already cites), a fully
                independent `useState`/handler that never reads or writes
                `showDeterministicSignals`/`showLlmJudgment`. Visible label
                reads "PR-bot findings" — a user with no visibility into the
                internal `'ingested'` family name couldn't infer what the
                checkbox does from that term alone (same reasoning the
                Panel's own doc comment above applies to "Risk signals"/"AI
                judgment"). */}
            <label className="code-map__signal-toggle">
              <input
                type="checkbox"
                checked={showIngestedFindings}
                onChange={(event) => setShowIngestedFindings(event.target.checked)}
              />
              PR-bot findings
            </label>
          </Panel>
        </ReactFlow>
      )}

      {/* P0-2b: also gated off Health Audit Mode — this floats over the
          canvas, and there is no canvas there to traverse. */}
      {surfaces.canvas && (
        // Story 1.4 Code Map: "New lightweight Back/Forward toolbar ...
        // disabled at either end of history" — renderer-local chrome over
        // the ephemeral `history` state, never persisted/IPC'd (AD-2
        // restated). Gated on `surfaces.canvas`, the same flag as the
        // `<ReactFlow>` it floats over, so Back/Forward never renders
        // without a map underneath to traverse. A PR Review diff-scope
        // notice does not gate it: that notice sits above the map.
        <div className="code-map__history-toolbar" role="toolbar" aria-label="Map traversal history">
          <button type="button" onClick={goBack} disabled={history.index <= 0} aria-label="Back">
            ← Back
          </button>
          <button
            type="button"
            onClick={goForward}
            disabled={history.index >= history.stack.length - 1}
            aria-label="Forward"
          >
            Forward →
          </button>
        </div>
      )}

      {/* P0-2b: `pathTraceInput`, NOT `canvas` — search stays reachable in
          Health Audit Mode too; submitting there switches to Code Map Mode so
          the route lands on a canvas (`resolvePathTraceSubmit`). The RESULT
          surfaces inside this wrapper follow `pathTraceResult` instead, which
          does track the canvas — see `CodeMapSurfaces`. */}
      {surfaces.pathTraceInput && (
        // Story 1.9 (Phase 2): the always-reachable Path Trace search
        // affordance — persistent/non-modal, mirroring the history
        // toolbar's own `role="toolbar"`/absolute-over-canvas pattern just
        // above (Boundaries & Constraints: "never a `role="dialog"`
        // overlay ... must stay usable while the map is still interacted
        // with"). Positioned opposite the history toolbar (top-left vs.
        // top-right) so the two never overlap. A PR Review diff-scope notice
        // does not gate it — search stays reachable in exactly those
        // states.
        <div className="code-map__path-trace">
          <PathTraceSearchRow
            query={pathQuery}
            onQueryChange={setPathQuery}
            onSubmit={handlePathTraceSubmit}
            searching={pathTrace.status === 'searching'}
            graphServiceAvailable={graphServiceAvailable}
          />

          {/* P0-2b: the RESULT surfaces, gated on `pathTraceResult` — which
              tracks the canvas, not the input above. Every one of them
              describes or acts on a route drawn across that canvas (a step row
              re-centers it, a candidate row re-runs the trace and fits the
              viewport to it), so with no canvas mounted they would be controls
              for something that is not there. Nothing resets `pathTrace` on a
              mode change, so a user who traces and then switches to Health
              Audit Mode really would otherwise be left holding a live,
              clickable route list over the cluster grid. See `CodeMapSurfaces`. */}
          {surfaces.pathTraceResult && (
            <>
            {/* `no-path-found`/`error` use the shared `ActionableNotice`
                shape (P1-7) — the same one the Node Detail panel's own
                Regenerate error uses, rather than the full-canvas
                `.code-map__notice` reserved above for a whole-map-replacing
                state (loading/fetch-error/empty-map): this notice sits
                alongside a still-interactive map, never over it. */}
            {pathTrace.status === 'no-path-found' && (
              <div className="code-map__path-trace-dismissable-notice">
                <ActionableNotice tone="info" role="status">
                  No path found for that query.
                </ActionableNotice>
                {/* Story 1.9 (Phase 4): logs the dismissal (AD-21) and resets
                    the panel to `idle` — also driller's first clear-search
                    affordance, resolving Phase 2's deferred gap. */}
                <button
                  type="button"
                  className="code-map__path-trace-dismiss"
                  onClick={() => handleDismissPathTrace('no-path-found')}
                >
                  Dismiss
                </button>
              </div>
            )}
            {pathTrace.status === 'error' && (
              <ActionableNotice tone="error" role="alert">
                {pathTrace.message}
              </ActionableNotice>
            )}

            {pathTrace.status === 'ambiguous' && (
              // Story 1.9 (Phase 3): the disambiguation Actionable Notice —
              // one sentence plus one next action (pick a candidate), same
              // Actionable Notice shape every other "needs attention" state
              // in the app already uses (Epic 1 context, UX & Interaction
              // Patterns). Reuses the `code-map__path-trace-steps` list class
              // (the `<ol>` wrapper) from the `found` step list just below —
              // the row button itself no longer shares a class with that
              // list's own row (renamed to `code-map__path-trace-stack-row`,
              // this pass's DESIGN.md restyle) since candidates and traced
              // hops now have genuinely different visual shapes, not because
              // this list stopped reusing shared structure (Boundaries &
              // Constraints) — a clickable named list is still the same shape
              // either way, it's just candidates instead of path steps. Each
              // candidate's click
              // re-runs the trace pinned to that exact `id` via the shared
              // `runPathTrace` (resolves deterministically through the
              // untouched exact-id tier) — never a new "resume" IPC
              // parameter (Never).
              <div className="code-map__path-trace-steps-panel" role="region" aria-label="Multiple matches — pick one">
                <ActionableNotice tone="info" role="status">
                  Multiple matches found — pick one to trace:
                </ActionableNotice>
                <ol className="code-map__path-trace-steps">
                  {/* Review fix: render-layer cap (`MAX_RENDERED_AMBIGUOUS_CANDIDATES`,
                      see its own doc comment above) — `pathTrace.candidates`
                      itself is never truncated (the engine's own `ambiguous`
                      contract stays the full, honest match list), only what
                      gets rendered into this small fixed-width panel is. */}
                  {pathTrace.candidates.slice(0, MAX_RENDERED_AMBIGUOUS_CANDIDATES).map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className="code-map__path-trace-step code-map__path-trace-candidate"
                        disabled={pathTraceIsSearching}
                        onClick={() => runPathTrace(candidate.id)}
                      >
                        {/* Review fix: every candidate in one `ambiguous`
                            result shares the same `name` by construction —
                            `formatCandidateLocation` surfaces the
                            distinguishing file/location part of `candidate.id`
                            so two same-named candidates never render as
                            identical, unlabeled buttons. */}
                        <code>{candidate.name}</code>
                        <span className="code-map__path-trace-candidate-location">
                          {formatCandidateLocation(candidate)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                {pathTrace.candidates.length > MAX_RENDERED_AMBIGUOUS_CANDIDATES && (
                  <p className="code-map__path-trace-candidates-truncated">
                    Showing the first {MAX_RENDERED_AMBIGUOUS_CANDIDATES} of {pathTrace.candidates.length} matches —
                    refine your query for a shorter list.
                  </p>
                )}
                {/* Story 1.9 (Phase 4): logs the dismissal (AD-21) and resets
                    the panel to `idle` — also driller's first clear-search
                    affordance, resolving Phase 2's deferred gap. */}
                <button
                  type="button"
                  className="code-map__path-trace-dismiss"
                  onClick={() => handleDismissPathTrace('ambiguous')}
                >
                  Dismiss
                </button>
              </div>
            )}

            {pathTrace.status === 'found' && (
              <FoundTraceSteps
                path={pathTrace.path}
                resolveNode={(id) => {
                  const node = flowNodesById.get(id)?.data.node;
                  return { name: node?.name ?? id, file: node?.file };
                }}
                onNavigate={navigateToNode}
                onDismiss={() => handleDismissPathTrace('found')}
                routeClamped={routeClamped}
              />
            )}

            {pathTrace.status === 'neighbors' && (
              <NeighborTraceSteps
                originId={pathTrace.originId}
                originName={flowNodesById.get(pathTrace.originId)?.data.node.name ?? pathTrace.originId}
                direction={pathTrace.direction}
                neighborIds={pathTrace.neighborIds}
                resolveNode={(id) => {
                  const node = flowNodesById.get(id)?.data.node;
                  return { name: node?.name ?? id, file: node?.file };
                }}
                onNavigate={navigateToNode}
                onDismiss={handleDismissNeighborTrace}
                routeClamped={routeClamped}
              />
            )}
            </>
          )}
        </div>
      )}

      {sourceOverlayOpen(sourceView) && (
        <div
          ref={sourceOverlayRef}
          className="code-map__source-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Node source"
          tabIndex={-1}
          {...sourceScrimProps}
        >
          <div className="code-map__source-panel">
            <div className="code-map__source-header">
              <code>
                {sourceView.node.file}:{sourceView.node.startLine}-{sourceView.node.endLine}
              </code>
              <div className="code-map__source-header-actions">
                <button
                  type="button"
                  className="code-map__source-open-in-editor"
                  onClick={() => handleOpenInEditor(sourceView.node)}
                  disabled={openInEditorState.status === 'opening'}
                >
                  {openInEditorState.status === 'opening' ? 'Opening…' : 'Open in external editor'}
                </button>
                <button
                  type="button"
                  className="code-map__source-close"
                  onClick={closeSourceView}
                  aria-label="Close source view"
                >
                  ×
                </button>
              </div>
            </div>
            {sourceView.status === 'loading' && <p role="status">Loading source…</p>}
            {sourceView.status === 'error' && (
              <p role="alert" className="code-map__source-error">
                Couldn&rsquo;t open source: {sourceView.message}
              </p>
            )}
            {openInEditorState.status === 'error' && (
              <p role="alert" className="code-map__source-error">
                {openInEditorState.message}
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

      {/* Story 1.8 (Phase 4): the Node Detail panel — inline overlay JSX
          matching the source overlay's own pattern immediately above
          (Never: no shared Modal/Panel component extracted — no such
          component exists yet elsewhere in this codebase). Regenerate
          reuses Story 1.5/1.6's existing generation pipeline for this one
          Node via `window.driller.regenerateNode`.

          P0-1 (2026-09-24): this is now the Node's primary surface, opened
          by activating any Node card at all rather than only by a
          stale-Node-only "Details" pill — so it carries what the IA row
          promises: summary, staleness, risk signals and a one-click route
          to source. Its Coverage Gap state is reachable for the first time
          as a result (a `'coverage-gap'` Node is never stale, so the old
          entry point could never open it). */}
      {/* P0-1 (2026-09-24): the overlay's accessible name carries the Node's
          own identifier. A static "Node detail" was survivable while this
          opened from a per-Node "Details" pill the user had just aimed at;
          now that it is what every card click lands on, a screen-reader user
          would otherwise be told only that *a* detail dialog opened, with
          nothing saying which Node they hit. */}
      {/* P0-2c (2026-09-24): this gate reads `nodeDetail` and NOTHING else —
          verified, not assumed, when Health Audit's grid became a second
          caller. It is a sibling of the surface gates above, never nested
          inside `surfaces.canvas`, so a row activated on the cluster grid
          opens the panel over that grid exactly as a card click opens it over
          the canvas. Do not fold it under a surface flag: the grid and the
          canvas both open THIS panel, and gating it on either one silently
          turns the other surface's rows into controls that open nothing.
          Because it is a sibling rather than a replacement, the grid stays
          mounted underneath while the panel is open and still holds its own
          scroll offset when the panel closes. */}
      {nodeDetailOverlayOpen(nodeDetail) && (
        <div
          ref={nodeDetailOverlayRef}
          className="code-map__node-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Node detail: ${nodeDetail.node.name}`}
          tabIndex={-1}
          {...nodeDetailScrimProps}
        >
          <div className="code-map__node-detail-panel">
            <NodeDetailHead node={nodeDetail.node} onClose={closeNodeDetail} />
            {/* P2-12: the mockup's composition — labelled, divided sections
                scrolling between the head above and the pinned View source
                footer below. Presentation only (see `NodeDetailBody`). */}
            <NodeDetailBody
              node={nodeDetail.node}
              toggles={riskSignalToggles}
              cloudSelectedNoKey={cloudSelectedNoKey}
              noSummaryBackendAvailable={noSummaryBackendAvailable}
              summaryAction={nodeDetailAction}
              regenerateState={regenerateState}
              graphServiceAvailable={graphServiceAvailable}
              onRegenerate={handleRegenerate}
            />
            {/* P0-1: the one-click source action this panel's IA row
                promises — reuses `openSourceForNode` unchanged, at this
                Node's exact range. Closes the panel on the way: both
                overlays are `z-index: 10` and this one renders after the
                source overlay in the DOM, so leaving it open would hide the
                very source view the action just opened. P2-12: pinned as the
                panel's full-width footer, outside the scrolling body, so it
                stays one click away however long the summary. Still "View
                source" — it opens the in-app viewer, not the external
                editor the mockup's wording names. */}
            <button
              type="button"
              className="code-map__node-detail-source"
              onClick={() => {
                const target = nodeDetail.node;
                closeNodeDetail();
                openSourceForNode(target);
              }}
            >
              View source
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
