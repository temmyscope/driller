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
 * Story 1.8 (Phase 4) adds the on-demand single-Node regenerate action: a
 * "Details" affordance next to the caller/callee ones, shown only when a
 * Node is `summaryStatus === 'ready' && stale === true`, opening an inline
 * Node Detail overlay (matching the existing source-view overlay's own
 * pattern — no shared Modal component) with a Regenerate button wired to
 * `window.driller.regenerateNode` — this app's first id-keyed mutating IPC
 * round-trip. On success, patches `fetchState.nodes` in place by id, the
 * same idiom `onSummaryProgress` already uses, rather than refetching.
 *
 * Story 1.9 (Phase 2) adds the first search affordance: a persistent,
 * non-modal toolbar (never `App.tsx`'s header — Phase 1's frozen boundary)
 * that calls Phase 1's `window.driller.tracePath(query)`. On `found`, the
 * path's Nodes/edges get a distinct highlight treatment threaded into the
 * `renderedNodes`/`renderedEdges` memo below, the view fits to show the
 * whole route (`reactFlowInstanceRef`), and an ordered, clickable step list
 * renders alongside it — each entry re-using `navigateToNode` (Story 1.4),
 * never a new traversal mechanism. `no-path-found`/`error` reuse this
 * file's existing ad hoc notice conventions rather than a new shared Notice
 * component (Design Notes).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
} from '@driller/ipc-contracts';
import { computeLOD, type Cluster, type LODInputNode } from '../map/lod';

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; nodes: CodeMapNode[]; edges: CodeMapEdge[] }
  | { status: 'error'; message: string };

type SourceViewState =
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
type NodeDetailState = { status: 'closed' } | { status: 'open'; node: CodeMapNode };

/**
 * The Node Detail panel's Regenerate button state — mirrors Settings.tsx's
 * `KeyEntryState` shape (a similar "idle/in-flight/error" async-action
 * pattern), simplified: no `'warning'` state exists for this action.
 */
type RegenerateState = { kind: 'idle' | 'regenerating' } | { kind: 'error'; message: string };

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
type PathTraceState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'found'; path: string[] }
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
type DiffScopeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'resolved'; resolvedBaseRef: string; nodeIds: Set<string> }
  | { status: 'no-changes' }
  | { status: 'not-a-git-repo' }
  | { status: 'no-base-ref-resolvable' }
  | { status: 'error'; message: string };

/**
 * The three non-happy-path `DiffScopeState` statuses that each replace the
 * map with their own distinct Actionable Notice (Boundaries & Constraints) —
 * named here once so both the notice-gating check and `formatDiffScopeNotice`
 * below share one literal list rather than risking the two drifting apart.
 */
type DiffScopeNoticeStatus = 'no-changes' | 'not-a-git-repo' | 'no-base-ref-resolvable';

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
// `onNavigate`/the adjacency-derived counts+first-ids are threaded through
// node `data` the same way `onActivate` already is (Story 1.4 Code Map:
// "reused by both edge-click resolution and the affordance's counts/
// targets") — the custom Node card's caller/callee affordances call
// `onNavigate` directly, sharing the exact same `navigateToNode` path an
// edge click resolves to.
type CodeMapFlowNode = FlowNode<
  {
    node: CodeMapNode;
    onActivate: (node: CodeMapNode) => void;
    onNavigate: (id: string) => void;
    // Story 1.8 (Phase 4): threaded through the same way `onActivate`/
    // `onNavigate` already are — the "Details" affordance (rendered only on
    // a stale Node) calls this to open the Node Detail panel.
    onOpenDetail: (node: CodeMapNode) => void;
    callerCount: number;
    firstCallerId: string | undefined;
    calleeCount: number;
    firstCalleeId: string | undefined;
    // Story 1.6 (Phase 2): threaded through the same way `onActivate`/
    // `onNavigate` already are — a `'pending'` Node renders one of these two
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
type NodeAdjacency = Map<string, { callers: string[]; callees: string[] }>;

function layoutNodes(
  nodes: CodeMapNode[],
  onActivate: (node: CodeMapNode) => void,
  onNavigate: (id: string) => void,
  onOpenDetail: (node: CodeMapNode) => void,
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
        onNavigate,
        onOpenDetail,
        callerCount: entry?.callers.length ?? 0,
        firstCallerId: entry?.callers[0],
        calleeCount: entry?.callees.length ?? 0,
        firstCalleeId: entry?.callees[0],
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
// `pathHighlightNodeIds`/`pathHighlightEdgeKeys` outside a `'found'` result
// — a fresh `new Set()` every render would still be referentially new each
// time (defeating the `useMemo`s that return it), so it's declared once at
// module scope instead.
const EMPTY_ID_SET: ReadonlySet<string> = new Set();

/** Consecutive-pair key for `pathHighlightEdgeKeys` (Story 1.9, Phase 2) — matches `toFlowEdges`'s own `id` separator. */
function pathEdgeKey(source: string, target: string): string {
  return `${source}→${target}`;
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
const DETERMINISTIC_SIGNAL_ICONS: Record<DeterministicRiskSignalType, string> = {
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
 * The custom Node component: identifier verbatim, monospace (Always),
 * plus its one-line summary/pending/coverage-gap state (Story 1.5 Phase 2 —
 * see this file's module doc comment). `tabIndex`/`role="button"`/
 * `onKeyDown` give one-click-to-source a keyboard path (Enter/Space)
 * alongside the mouse click `<ReactFlow>`'s
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
  const {
    node,
    onActivate,
    onNavigate,
    onOpenDetail,
    callerCount,
    firstCallerId,
    calleeCount,
    firstCalleeId,
    noSummaryBackendAvailable,
    cloudSelectedNoKey,
    showDeterministicSignals,
    showLlmJudgment,
    showIngestedFindings,
    isChanged,
  } = data;
  // Story 1.8 (Phase 4): the "Details" affordance is shown only on a stale
  // Node (Always) — mirroring the caller/callee affordances' own
  // shown-only-when-relevant treatment, never on a Node that's merely
  // `'pending'`/`'coverage-gap'` (staleness is only meaningful once a
  // summary actually exists).
  const showDetailsAffordance = node.summaryStatus === 'ready' && node.stale === true;
  // Story 2.1 (Phase 3): filtered, not assumed — Story 2.2 (Phase 1) turned
  // `RiskSignal` into a real discriminated union (`llm-judgment` now exists
  // as a sibling shape with no `type`/`value`; Story 2.3's `ingested` family
  // still to come), and this same loop must never render a non-deterministic
  // signal through this one unfiltered (Boundaries & Constraints, epics.md
  // Phase 3 AC). A Node with none (or every entry filtered out) renders no
  // strip at all — never an empty row — enforced by the `.length > 0` gate
  // below, not by this filter alone. Review round (patch): also drops a
  // repeat `type` defensively — see the signal-strip JSX's own comment below
  // for why. Written as an explicit type-predicate (rather than a plain
  // boolean-returning callback) so `deterministicSignals` below is actually
  // typed as `DeterministicRiskSignal[]`, not still the wider `RiskSignal[]`
  // union — `Array.prototype.filter` only narrows the element type with a
  // predicate, and without it `signal.type`/`signal.value` below would no
  // longer compile now that not every union member has those fields.
  // Review round (patch): typed against `DeterministicRiskSignalType`
  // specifically (not a bare `Set<string>`) — this Set exists purely to
  // guard `signal.type` below, so the narrower type catches a typo/drift
  // against that union at compile time instead of silently accepting any
  // string.
  const seenDeterministicSignalTypes = new Set<DeterministicRiskSignalType>();
  const deterministicSignals = node.riskSignals.filter((signal): signal is DeterministicRiskSignal => {
    if (signal.family !== 'deterministic' || seenDeterministicSignalTypes.has(signal.type)) {
      return false;
    }
    seenDeterministicSignalTypes.add(signal.type);
    return true;
  });
  // Story 2.2 (Phase 3): at most one `'llm-judgment'` signal per Node (Phase
  // 1/2's own construction invariant — `buildRiskSignals`/the judgment
  // generator never emit more than one), so `find` (not `filter`) is enough
  // here — unlike the deterministic strip above, there's no per-type
  // de-duplication concern since this family carries no `type` discriminant
  // to de-dupe by. `undefined` when the Node carries none: the callout below
  // is gated on this being defined, never an empty/placeholder callout
  // (Boundaries & Constraints).
  const llmJudgmentSignal = node.riskSignals.find(
    (signal): signal is LlmJudgmentRiskSignal => signal.family === 'llm-judgment',
  );
  // Story 2.3 (Phase 4): the ingested-PR-bot-findings callout — filtered
  // the same explicit-type-predicate way `deterministicSignals` is above
  // (unlike `llmJudgmentSignal`, this family is genuinely multi-valued per
  // Node — `NodeRecord.ingestedFindings`' own doc comment: "multiple bots
  // ... can legitimately coexist on one Node"), no de-duplication (unlike
  // the deterministic strip, this family carries no `type` discriminant to
  // de-dupe by — two distinct findings from the same tool at the same
  // location are both real). Sorted by severity (`blocker` > `major` >
  // `minor` > `info`, ties by array order — `Array.prototype.sort`'s own
  // stability guarantee, see `INGESTED_SEVERITY_RANK`'s doc comment) before
  // capping, so the 3 findings actually rendered are always the highest-
  // severity ones, never just the first 3 in whatever order
  // `buildRiskSignals` happened to push them.
  const ingestedSignals = node.riskSignals
    .filter((signal): signal is IngestedRiskSignal => signal.family === 'ingested')
    .sort((a, b) => INGESTED_SEVERITY_RANK[a.severity] - INGESTED_SEVERITY_RANK[b.severity]);
  const visibleIngestedSignals = ingestedSignals.slice(0, MAX_RENDERED_INGESTED_FINDINGS);
  const hiddenIngestedSignalCount = ingestedSignals.length - visibleIngestedSignals.length;
  return (
    <div
      className={`code-map__node${isChanged ? ' code-map__node--changed' : ''}`}
      title={`${node.file}:${node.startLine}-${node.endLine}`}
      tabIndex={0}
      role="button"
      aria-label={`${node.kind} ${node.name}${isChanged ? ', changed' : ''}, open source`}
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
      {/* Story 2.1 (Phase 3): the deterministic risk-signal strip — one chip
          per `riskSignals` entry with `family === 'deterministic'`, gated on
          the map-level toggle (`showDeterministicSignals`) AND on actually
          having at least one such signal (Boundaries & Constraints: "A Node
          with `riskSignals: []` ... renders no signal strip at all — never
          an empty row"). Keyed by `type` — a Node carries at most one
          `RiskSignal` per `DeterministicRiskSignalType` by construction
          (AD-9 corrected), but review round (patch): that invariant lives in
          a different module (`graph-service/index.ts`'s `buildRiskSignals`)
          this file can't see, so `deterministicSignals` above additionally
          drops a repeat `type` defensively rather than trusting the
          invariant blind — a future bug there would otherwise produce
          colliding React keys here (Blind Hunter + Edge Case Hunter,
          independently). Each chip: `role="img"` (review round, patch) —
          `aria-label` alone on a bare, non-interactive `<span>` (implicit
          role `generic`) is not reliably exposed to assistive technology,
          unlike `.code-map__node-affordance`'s own `aria-label` convention
          this comment originally (incorrectly) claimed to mirror — that
          convention only holds for a real `<button>`, which is unambiguously
          interactive; `role="img"` is the standard fix for a static
          icon+label combination (Verification Gap review, confirmed my own
          pre-review suspicion). `title` (review round, patch) gives sighted
          mouse users — who never see `aria-label` — the same glyph→meaning
          mapping via the native hover tooltip (Blind Hunter). An unrecognized
          `signal.type` (review round, patch: Edge Case Hunter) — e.g. a
          runtime value from a future backend build that doesn't match this
          renderer's still-five-member union — falls back to `'?'`/the raw
          type string rather than rendering a literal "undefined". */}
      {showDeterministicSignals && deterministicSignals.length > 0 && (
        <div className="code-map__node-signal-strip">
          {deterministicSignals.map((signal) => {
            const label = DETERMINISTIC_SIGNAL_LABELS[signal.type] ?? signal.type;
            const icon = DETERMINISTIC_SIGNAL_ICONS[signal.type] ?? '?';
            return (
              <span
                key={signal.type}
                className="code-map__signal-chip"
                role="img"
                aria-label={`${label}: ${signal.value}`}
                title={`${label}: ${signal.value}`}
              >
                <span aria-hidden="true">{icon}</span>
                {signal.value}
              </span>
            );
          })}
        </div>
      )}
      {/* Story 2.2 (Phase 3): the LLM-judgment risk-signal callout — rendered
          after the deterministic strip above, gated on its own independent
          `showLlmJudgment` toggle AND on the Node actually carrying an
          `'llm-judgment'` signal (never an empty/placeholder callout,
          Boundaries & Constraints). Deliberately never
          `.code-map__signal-chip`'s classes — dashed border, icon+full
          sentence, not a solid-border pill (FR8/UX-DR7: "no shared visual
          language between the two families"). The visible copy leads with
          "AI judgment:" so it reads as an inference, never with a
          deterministic signal's unqualified-measurement confidence (this
          story's own Intent). Accessibility: the judgment text itself is
          real, visible text (not an `aria-label`-only summary of icon+number
          the way the deterministic chips are) — this alone satisfies the
          "real visible text" branch of the same accessibility treatment
          those chips established; `title` still mirrors their own convention
          for sighted mouse users who never see the DOM text node be
          announced as anything special. Review round (patch): also guards
          against a blank/whitespace-only `judgment` — Phase 2's own
          generation logic already treats an empty model response as
          `'degenerate'` and never persists it, so this can't happen given
          the current codebase, but the guard is trivial and directly closes
          the gap between "never an empty/placeholder callout" and what the
          JSX actually checked (only `!== undefined`, not blank-ness). */}
      {showLlmJudgment && llmJudgmentSignal !== undefined && llmJudgmentSignal.judgment.trim().length > 0 && (
        <p className="code-map__llm-judgment" title={`AI judgment: ${llmJudgmentSignal.judgment}`}>
          <span aria-hidden="true">✦</span> AI judgment: {llmJudgmentSignal.judgment}
        </p>
      )}
      {/* Story 2.3 (Phase 4): the ingested-PR-bot-findings callout — its own
          distinct visual treatment (Boundaries & Constraints: "never
          `.code-map__signal-chip`'s classes, never llm-judgment's callout
          classes" — a solid-border list block, not deterministic's inline
          pills or llm-judgment's dashed single-sentence box), gated on its
          own independent `showIngestedFindings` toggle AND on the Node
          actually carrying at least one `'ingested'` signal (never an
          empty/placeholder callout — mirrors llm-judgment's own
          Boundaries). Each finding is its own row, always naming its
          severity as real visible text — never color/icon alone
          (Accessibility Floor) — plus the originating tool and finding
          text (FR9, AD-12). `visibleIngestedSignals`/
          `hiddenIngestedSignalCount` (computed above, already sorted
          highest-severity-first) cap the rendered rows at
          `MAX_RENDERED_INGESTED_FINDINGS` plus an explicit "+N more" line
          when more exist — never an unbounded wall of inline comments
          (UX-DR27, Design Notes). `key={index}` (review-pattern
          precedent: `toFlowEdges` above keys on index too) since a raw
          ingested finding carries no identifier of its own to key by. */}
      {showIngestedFindings && ingestedSignals.length > 0 && (
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
      {/* Caller/callee affordances (Story 1.4): a lightweight alternative to
          precisely clicking a thin edge line — hidden/inert entirely (not
          just visually) when the count is 0, per this story's Code Map
          section. `stopPropagation` on mousedown, click, AND keydown keeps
          this nested control from also being read as an interaction with
          the Node card itself: without it on keydown too (review finding —
          a concrete bug, not just a style nit), pressing Enter/Space while
          a button is focused still bubbles the keydown up to the card's own
          `onKeyDown` below, firing `onActivate` (open source) at the same
          time as `onNavigate` — the keydown that activates a native
          `<button>` propagates regardless of the button's own click
          response to it. Also initiating React Flow's own node-drag/
          selection handling is what the mousedown stop guards against. */}
      {(callerCount > 0 || calleeCount > 0 || showDetailsAffordance) && (
        <div className="code-map__node-affordances">
          {callerCount > 0 && firstCallerId !== undefined && (
            <button
              type="button"
              className="code-map__node-affordance"
              aria-label={`${callerCount} called by, go to a caller`}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onNavigate(firstCallerId);
              }}
            >
              ↑{callerCount} called by
            </button>
          )}
          {calleeCount > 0 && firstCalleeId !== undefined && (
            <button
              type="button"
              className="code-map__node-affordance"
              aria-label={`${calleeCount} calls, go to a callee`}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onNavigate(firstCalleeId);
              }}
            >
              ↓{calleeCount} calls
            </button>
          )}
          {/* Story 1.8 (Phase 4): the Regenerate entry point — shown only on
              a stale Node (Always), same `stopPropagation` discipline
              (mousedown/click/keydown) as the caller/callee affordances
              above, so opening the Node Detail panel never also fires the
              card's own click-to-source (Story 1.7's whole-card click is
              never altered). */}
          {showDetailsAffordance && (
            <button
              type="button"
              className="code-map__node-affordance code-map__node-affordance--details"
              aria-label={`Open Node detail for ${node.name}`}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onOpenDetail(node);
              }}
            >
              Details
            </button>
          )}
        </div>
      )}
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
   */
  mode: 'codeMap' | 'prReview';
}

export function CodeMap({ projectPath, noSummaryBackendAvailable, cloudSelectedNoKey, mode }: CodeMapProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });
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
  // Story 3.2 (Phase 2): the combined blast-radius expansion's own result
  // state and the stepper's current depth — CodeMap-owned, same division-of-
  // responsibility reasoning as `baseRefInput`/`diffScopeState` just above.
  // `blastRadiusDepth` defaults to 1 (Design Notes: "Default depth = 1-hop"),
  // reset to 1 alongside `blastRadiusState` at each of its own three reset
  // points (never left stale at a deeper depth from a previous diff scope).
  const [blastRadiusState, setBlastRadiusState] = useState<BlastRadiusState>({ status: 'idle' });
  const [blastRadiusDepth, setBlastRadiusDepth] = useState(1);
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
  // position — but every Node's `data.onNavigate` (the caller/callee
  // affordance) is itself threaded through that same `layoutNodes` call,
  // a direct circular dependency. Broken the same way `sourceRequestIdRef`
  // breaks its own timing race: a ref holding the real implementation,
  // synced via an effect below, behind a stable wrapper (identity never
  // changes) so neither `flowNodes`' memoization nor `onEdgeClick`/the
  // toolbar need the real implementation in their dependency arrays.
  const navigateToNodeImplRef = useRef<(id: string) => void>(() => {});
  const navigateToNode = useCallback((id: string) => {
    navigateToNodeImplRef.current(id);
  }, []);

  const loadCodeMap = useCallback(() => {
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
    setBlastRadiusDepth(1);
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
    });
    return unsubscribe;
  }, [projectPath]);

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
    diffScopeRequestIdRef.current += 1;
    // Story 3.2 (Phase 2, Always): same "resets whenever ... the project
    // changes" reasoning as the `diffScopeState` reset just above — a project
    // switch swaps in an entirely different Node set, so a blast radius
    // computed against the previous project's Node ids must not survive
    // into the new one. Also deliberately does NOT depend on `mode`, same
    // reasoning as the reset above.
    setBlastRadiusState({ status: 'idle' });
    setBlastRadiusDepth(1);
    blastRadiusRequestIdRef.current += 1;
  }, [projectPath]);

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
    setBlastRadiusDepth(1);
    blastRadiusRequestIdRef.current += 1;
    window.driller
      .computeDiffScope(projectPath, trimmedBaseRef.length > 0 ? trimmedBaseRef : undefined)
      .then((result: DiffScopeResult) => {
        if (diffScopeRequestIdRef.current !== requestId) {
          return;
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
      handleComputeDiffScope();
    },
    [handleComputeDiffScope],
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
          setBlastRadiusDepth(1);
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
  }, [mode, projectPath, diffScopeState, blastRadiusState.status]);

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

  // Wraps `openSourceForNode` to start the dev-only selection-to-detail
  // timer right at the click/activation, before the (async) source read —
  // this is the "around the click handler" measurement point the Code
  // Map's Profiling methodology calls for.
  const activateNode = useCallback(
    (node: CodeMapNode) => {
      // Design Notes: a click/keyboard activation counts as "focusing" a
      // Node for the purpose of resolving a later edge click's endpoint.
      focusedNodeIdRef.current = node.id;
      if (isDevFixtureMode) {
        selectionStartRef.current = performance.now();
      }
      openSourceForNode(node);
    },
    [openSourceForNode, isDevFixtureMode],
  );

  // Story 1.8 (Phase 4): opens the Node Detail panel for a stale Node
  // (the "Details" affordance's own `onClick`) — resets any leftover
  // Regenerate state from a previously-viewed Node so a fresh open never
  // shows a stale error/"Regenerating…" from a different Node.
  const openNodeDetail = useCallback((node: CodeMapNode) => {
    updateNodeDetail({ status: 'open', node });
    setRegenerateState({ kind: 'idle' });
  }, []);

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
    if (nodeDetail.status !== 'open') {
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
  }, [nodeDetail]);

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
            navigateToNode,
            openNodeDetail,
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
      navigateToNode,
      openNodeDetail,
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
  const lodResult = useMemo(
    () =>
      computeLOD({
        nodes: lodInputNodes,
        zoom: zoomBand,
        threshold: LOD_ZOOM_THRESHOLD,
        viewportBounds: { x: boundsX, y: boundsY, width: worldWidth, height: worldHeight },
      }),
    // Depends on the individual quantized numbers, not a `viewportBounds`
    // object literal — a fresh object every render would defeat memoization
    // even when its numeric contents are unchanged.
    [lodInputNodes, zoomBand, boundsX, boundsY, worldWidth, worldHeight],
  );

  // Story 1.9 (Phase 2): the `found` path's Node ids and its consecutive-pair
  // `CALLS` edges (Code Map: "compute a Set of path Node ids +
  // consecutive-pair edges") — the two Sets `renderedNodes`/`renderedEdges`
  // below consult to thread a distinguishing `className` onto matching
  // rendered nodes/edges. Empty (never recreated) outside `'found'` so the
  // highlight clears the instant a new search starts or a prior result is
  // superseded — no separate cleanup step needed.
  const pathHighlightNodeIds = useMemo<ReadonlySet<string>>(
    () => (pathTrace.status === 'found' ? new Set(pathTrace.path) : EMPTY_ID_SET),
    [pathTrace],
  );
  const pathHighlightEdgeKeys = useMemo<ReadonlySet<string>>(() => {
    if (pathTrace.status !== 'found') {
      return EMPTY_ID_SET;
    }
    const keys = new Set<string>();
    for (let i = 0; i < pathTrace.path.length - 1; i += 1) {
      keys.add(pathEdgeKey(pathTrace.path[i]!, pathTrace.path[i + 1]!));
    }
    return keys;
  }, [pathTrace]);

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

  const { renderedNodes, renderedEdges } = useMemo(() => {
    const visibleNodeIds = new Set(lodResult.fullNodeIds);
    const nodes: CodeMapAnyFlowNode[] = [];

    // Story 1.9 (Phase 2): a highlighted path Node gets an additional
    // `className` on the `@xyflow/react` node wrapper itself (no existing
    // highlight mechanism to extend — Code Map) — never mutating the shared
    // `flowNode` object from `flowNodesById` in place, since that same
    // object is reused across renders/clusters.
    // Only applied to a full (non-clustered) rendered card — a path Node
    // still folded into an unexpanded LOD cluster has no card of its own to
    // mark. `fitViewToPath` zooming in on just the path's own tight bounding
    // box makes this a non-issue in practice (a real repo's default view
    // already exceeds `LOD_ZOOM_THRESHOLD` per this file's own live-verified
    // numbers above, and fitting to a small path subset only zooms in
    // further); the 10,000-Node dev fixture is the only case where a path
    // Node could plausibly still be clustered post-fit.
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
    const edges = flowEdges
      .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
      .map((edge) => {
        // Story 1.9 (Phase 2): only a `CALLS` edge can be part of a traced
        // path (`traceCallPath` walks `CALLS` only) — `edge.label` carries
        // the same `CodeMapEdgeKind` `toFlowEdges` set it from, so checking
        // it here (rather than re-deriving from `className`) keeps a
        // same-pair `IMPORTS`/`USAGE` edge from getting highlighted just
        // because it happens to share (source, target) with a real path
        // step.
        if (edge.label === 'CALLS' && pathHighlightEdgeKeys.has(pathEdgeKey(edge.source, edge.target))) {
          return { ...edge, className: `${edge.className ?? ''} code-map__edge--path-highlight`.trim() };
        }
        return edge;
      });

    return { renderedNodes: nodes, renderedEdges: edges };
  }, [
    lodResult,
    flowNodesById,
    expandedClusterIds,
    expandCluster,
    flowEdges,
    pathHighlightNodeIds,
    pathHighlightEdgeKeys,
    blastRadiusNodeIds,
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
      navigateToNode(resolveEdgeClickTarget(edge, focusedNodeIdRef.current));
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
   */
  const fitViewToPath = useCallback(
    (path: string[]) => {
      const instance = reactFlowInstanceRef.current;
      if (!instance) {
        console.warn('CodeMap: tracePath found a path but the ReactFlow instance is not ready yet.');
        return;
      }
      const positions = path
        .map((id) => flowNodesById.get(id)?.position)
        .filter((position): position is { x: number; y: number } => position !== undefined);
      if (positions.length === 0) {
        return;
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
      instance.fitBounds(
        {
          x: minX - NODE_COLUMN_GAP / 2,
          y: minY - NODE_ROW_GAP / 2,
          width: maxX - minX + NODE_COLUMN_GAP,
          height: maxY - minY + NODE_ROW_GAP,
        },
        { duration: 300 },
      );
    },
    [flowNodesById],
  );

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
   */
  const handlePathTraceSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedQuery = pathQuery.trim();
      if (trimmedQuery.length === 0) {
        return;
      }
      runPathTrace(trimmedQuery);
    },
    [pathQuery, runPathTrace],
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

  // Story 1.8 (Phase 4): same Escape-dismissal pattern as the source
  // overlay's own effect just above — only listens while the Node Detail
  // panel is actually open.
  useEffect(() => {
    if (nodeDetail.status === 'closed') {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeNodeDetail();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nodeDetail.status, closeNodeDetail]);

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

  // Story 3.1 (Phase 2): which (if any) of the three non-happy-path
  // Actionable Notice states currently applies — `null` whenever the map
  // itself should render normally (not in PR Review Mode at all, or a
  // `'resolved'`/`'idle'`/`'loading'`/`'error'` diff scope, none of which
  // replace the map: `'error'` renders inline in the toolbar instead, same
  // convention `pathTrace.status === 'error'` already uses just above).
  // Hoisted here (mirrors `pathTraceIsSearching`'s own hoist-before-return
  // reasoning) so both the notice-gating and the `<ReactFlow>`-gating checks
  // below share one derivation.
  const prReviewNoticeStatus: DiffScopeNoticeStatus | null =
    mode === 'prReview' &&
    (diffScopeState.status === 'no-changes' ||
      diffScopeState.status === 'not-a-git-repo' ||
      diffScopeState.status === 'no-base-ref-resolvable')
      ? diffScopeState.status
      : null;

  // Review finding (Blind Hunter): `fetchState.status === 'ready' &&
  // fetchState.nodes.length > 0 && prReviewNoticeStatus === null` was
  // repeated verbatim across three separate gates (the `<ReactFlow>` canvas
  // itself, the history toolbar, the Path Trace toolbar) — a future edit to
  // one copy could silently drift from the other two. Named once here,
  // mirroring `pathTraceIsSearching`/`prReviewNoticeStatus`'s own
  // hoist-before-return convention just above.
  const mapIsRenderable =
    fetchState.status === 'ready' && fetchState.nodes.length > 0 && prReviewNoticeStatus === null;

  // Story 3.2 (Phase 2): the stepper's own upper bound — "its own 'further'"
  // (Always: "the stepper's upper bound is the maximum hop distance actually
  // present in the result"), `0` whenever there's no resolved blast radius to
  // bound at all. Hoisted here (mirrors `mapIsRenderable`'s own
  // hoist-before-return reasoning) as a plain number so the "+" button's
  // `disabled` check and its `onClick` handler below can both close over it
  // without re-narrowing `blastRadiusState.status` inside a nested callback.
  const blastRadiusMaxDepth = blastRadiusState.status === 'resolved' ? blastRadiusState.maxDepth : 0;

  return (
    <div className="code-map" ref={containerRef}>
      {/* Story 3.1 (Phase 2): the base-ref input + trigger — rendered
          whenever `mode === 'prReview'`, independent of `fetchState`
          entirely (Boundaries & Constraints: "the base-ref input/trigger
          stays visible alongside the notice"), so it survives every
          notice/map state below it, including the three Actionable Notices
          that replace the map further down. Positioned top-center (its own
          `.code-map__pr-review`, absolute + `z-index: 5`, styles.css) —
          every other corner is already claimed (`.code-map__history-
          toolbar` top-right, `.code-map__path-trace` top-left,
          `.code-map__signal-toggle-panel` bottom-right via `@xyflow/react`'s
          own `Panel`, `<Controls>`'s default bottom-left) — and rendered as
          a plain absolutely-positioned sibling here, not inside `<ReactFlow>`
          via its own `Panel` the way the signal toggles are: a `Panel` only
          exists while `<ReactFlow>` itself is mounted, which the three
          failure-state notices below deliberately replace instead of
          rendering alongside. */}
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
            />
            <button type="submit" disabled={projectPath === null || diffScopeState.status === 'loading'}>
              {diffScopeState.status === 'loading' ? 'Computing…' : 'Compute diff scope'}
            </button>
          </form>

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
          {/* `BlastRadiusExpansionResult['error']` reuses the same inline
              `notice notice--error` convention `DiffScopeResult['error']`
              just above already uses (I/O Matrix: "`expandBlastRadius`
              fails ... inline error notice in the PR Review toolbar, mirrors
              `diffScopeState`'s own error notice"). */}
          {diffScopeState.status === 'resolved' && blastRadiusState.status === 'error' && (
            <p className="notice notice--error" role="alert">
              {blastRadiusState.message}
            </p>
          )}

          {/* `DiffScopeResult['error']` reuses the same inline
              `notice notice--error` convention `pathTrace.status ===
              'error'` already uses just below in this file, rather than the
              full-canvas `.code-map__notice` reserved for the three
              enumerated non-happy-path states above (Boundaries &
              Constraints only names those three as map-replacing) — a
              genuine subprocess/`git` failure here still needs to surface
              somewhere (NFR4: no silent failure), but never blocks the
              still-otherwise-interactive map the way the three explicit
              result states do. */}
          {diffScopeState.status === 'error' && (
            <p className="notice notice--error" role="alert">
              {diffScopeState.message}
            </p>
          )}
        </div>
      )}

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

      {/* Story 3.1 (Phase 2): the three non-happy-path diff-scope Actionable
          Notices — each its own distinct sentence (`formatDiffScopeNotice`),
          replacing the map in place (Boundaries & Constraints: "never an
          empty map with no explanation", UX-DR15) exactly the way the
          empty-map notice just above already does for its own condition.
          Gated on `fetchState.status === 'ready' && ... > 0` too — an
          underlying fetch failure/empty map already has its own, more
          fundamental notice above; this one only applies once there's a
          real map that PR Review Mode is choosing not to show. */}
      {mode === 'prReview' && fetchState.status === 'ready' && fetchState.nodes.length > 0 && prReviewNoticeStatus !== null && (
        <div className="code-map__notice" role="status">
          <p>{formatDiffScopeNotice(prReviewNoticeStatus)}</p>
        </div>
      )}

      {mapIsRenderable && (
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

      {mapIsRenderable && (
        // Story 1.4 Code Map: "New lightweight Back/Forward toolbar ...
        // disabled at either end of history" — renderer-local chrome over
        // the ephemeral `history` state, never persisted/IPC'd (AD-2
        // restated). Story 3.1 (Phase 2): also gated on `prReviewNoticeStatus
        // === null` — this floats over the canvas `<ReactFlow>` itself
        // renders, which one of the three PR-Review Actionable Notices above
        // replaces entirely; without this gate, Back/Forward would float
        // over a notice with no map underneath it to traverse.
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

      {mapIsRenderable && (
        // Story 1.9 (Phase 2): the always-reachable Path Trace search
        // affordance — persistent/non-modal, mirroring the history
        // toolbar's own `role="toolbar"`/absolute-over-canvas pattern just
        // above (Boundaries & Constraints: "never a `role="dialog"`
        // overlay ... must stay usable while the map is still interacted
        // with"). Positioned opposite the history toolbar (top-left vs.
        // top-right) so the two never overlap. Story 3.1 (Phase 2): also
        // gated on `prReviewNoticeStatus === null`, same reasoning as the
        // history toolbar's own matching gate just above.
        <div className="code-map__path-trace">
          <form
            className="code-map__path-trace-toolbar"
            role="toolbar"
            aria-label="Search a traced path"
            onSubmit={handlePathTraceSubmit}
          >
            <input
              type="text"
              className="code-map__path-trace-input"
              placeholder="Trace a path from an entry point…"
              aria-label="Path Trace query"
              value={pathQuery}
              onChange={(event) => setPathQuery(event.target.value)}
              disabled={pathTrace.status === 'searching'}
            />
            {/* I/O Matrix: "Second submit while a search is in flight ...
                No-op — input/button disabled until the first resolves" —
                the `disabled` attributes here are belt-and-suspenders on
                top of `handlePathTraceSubmit`'s own no-op guard. */}
            <button type="submit" disabled={pathTrace.status === 'searching'}>
              {pathTrace.status === 'searching' ? 'Searching…' : 'Trace'}
            </button>
          </form>

          {/* `no-path-found`/`error` reuse this file's existing ad hoc
              notice convention (Design Notes) — the same compact
              `notice`/`notice--*` treatment the Node Detail panel's own
              Regenerate error already uses, rather than the full-canvas
              `.code-map__notice` reserved above for a whole-map-replacing
              state (loading/fetch-error/empty-map): this notice sits
              alongside a still-interactive map, never over it. */}
          {pathTrace.status === 'no-path-found' && (
            <div className="code-map__path-trace-dismissable-notice">
              <p className="notice notice--warning" role="status">
                No path found for that query.
              </p>
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
            <p className="notice notice--error" role="alert">
              {pathTrace.message}
            </p>
          )}

          {pathTrace.status === 'ambiguous' && (
            // Story 1.9 (Phase 3): the disambiguation Actionable Notice —
            // one sentence plus one next action (pick a candidate), same
            // Actionable Notice shape every other "needs attention" state
            // in the app already uses (Epic 1 context, UX & Interaction
            // Patterns). Reuses the `code-map__path-trace-steps`/`-step`
            // list classes from the `found` step list just below rather
            // than a new shared component (Boundaries & Constraints) — a
            // clickable named list is the same shape either way, it's just
            // candidates instead of path steps. Each candidate's click
            // re-runs the trace pinned to that exact `id` via the shared
            // `runPathTrace` (resolves deterministically through the
            // untouched exact-id tier) — never a new "resume" IPC
            // parameter (Never).
            <div className="code-map__path-trace-steps-panel" role="region" aria-label="Multiple matches — pick one">
              <p className="notice notice--warning" role="status">
                Multiple matches found — pick one to trace:
              </p>
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
            // Boundaries & Constraints (UX-DR10): "leaves the
            // highlight/step list visible for further stepping" — clicking
            // an entry only re-centers the map via `navigateToNode`, it
            // never closes/collapses this panel.
            <div className="code-map__path-trace-steps-panel" role="region" aria-label="Traced path steps">
              <ol className="code-map__path-trace-steps">
                {pathTrace.path.map((id, index) => {
                  const node = flowNodesById.get(id)?.data.node;
                  return (
                    // Review fix: `id` alone isn't guaranteed unique — nothing
                    // rules out a real graph shape producing a path that
                    // revisits the same Node id twice — so the index is
                    // folded into the key too.
                    <li key={`${id}-${index}`}>
                      <button
                        type="button"
                        className="code-map__path-trace-step"
                        onClick={() => navigateToNode(id)}
                      >
                        <span className="code-map__path-trace-step-index" aria-hidden="true">
                          {index + 1}
                        </span>
                        <code>{node?.name ?? id}</code>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {/* Story 1.9 (Phase 4): logs the dismissal (AD-21) and resets
                  the panel to `idle` — also driller's first clear-search
                  affordance, resolving Phase 2's deferred gap. */}
              <button
                type="button"
                className="code-map__path-trace-dismiss"
                onClick={() => handleDismissPathTrace('found')}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {sourceView.status !== 'closed' && (
        <div className="code-map__source-overlay" role="dialog" aria-modal="true" aria-label="Node source">
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
          component exists yet elsewhere in this codebase). Opened only via
          the "Details" affordance (shown only on a stale Node); Regenerate
          reuses Story 1.5/1.6's existing generation pipeline for this one
          Node via `window.driller.regenerateNode`. */}
      {nodeDetail.status === 'open' && (
        <div className="code-map__node-detail-overlay" role="dialog" aria-modal="true" aria-label="Node detail">
          <div className="code-map__node-detail-panel">
            <div className="code-map__node-detail-header">
              <code>{nodeDetail.node.name}</code>
              <button type="button" onClick={closeNodeDetail} aria-label="Close Node detail">
                ×
              </button>
            </div>
            <div className="code-map__node-detail-body">
              <p className="code-map__node-detail-location">
                <code>
                  {nodeDetail.node.file}:{nodeDetail.node.startLine}-{nodeDetail.node.endLine}
                </code>
              </p>
              {nodeDetail.node.summaryStatus === 'ready' && nodeDetail.node.summary !== undefined && (
                <p className="code-map__node-detail-summary">{nodeDetail.node.summary}</p>
              )}
              {/* Same "never color-only" treatment as the card's own
                  staleness note (Accessibility Floor) — the icon and exact
                  copy carry the signal, not color alone. Disappears the
                  moment a successful regenerate replaces `nodeDetail.node`
                  with one that has `stale: false`. */}
              {nodeDetail.node.stale === true && (
                <p className="code-map__node-staleness" role="status">
                  <span aria-hidden="true">⏳</span> Summary may be stale — source changed since generation
                </p>
              )}
              <button
                type="button"
                className="code-map__node-detail-regenerate"
                onClick={handleRegenerate}
                disabled={regenerateState.kind === 'regenerating'}
              >
                {regenerateState.kind === 'regenerating' ? 'Regenerating…' : 'Regenerate'}
              </button>
              {regenerateState.kind === 'error' && (
                <p className="notice notice--error" role="alert">
                  {regenerateState.message}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
