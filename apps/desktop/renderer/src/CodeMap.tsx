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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
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
  ChangedContract,
  CodeMapEdge,
  CodeMapResult,
  CodeMapNode,
  DeterministicRiskSignal,
  DeterministicRiskSignalType,
  DiffScopeResult,
  FileTopLevelUse,
  FoldedModule,
  FoldedType,
  FoldedTypeUserKindCount,
  IngestedRiskSignal,
  LlmJudgmentRiskSignal,
  PathTraceResult,
  RiskSignal,
  SimilarImplementation,
  SummaryStatus,
  TestedBy,
  TestedByFile,
  TestedByTest,
  TopLevelChangedFile,
  TypeUse,
  SectionNodeCount,
  SectionChangeCount,
  CrossSectionCall,
  CrossSectionEdgeCount,
  DiffScopeCarryResult,
  EntryCandidate,
  EntryCandidatesResult,
  UnknownSectionResult,
} from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';
import {
  ACTIONABLE_NOTICE_GLYPHS,
  ACTIONABLE_NOTICE_SPOKEN_PREFIX,
  ActionableNotice,
  type ActionableNoticeTone,
} from './ActionableNotice';
import { computeLOD, type Cluster, type ComputeLODResult, type LODInputNode } from '../map/lod';
import { resolveRefreshOutcome, type CodeMapFetchReply, type RefreshOutcome } from './sessionView';
import { diffScopeSyncTimeFor, mapFooterState, type MapFooterState } from './appFrame';
import { formatCount, formatCountNumber } from './format';
import { MODAL_FOCUS_FALLBACK_ID, nodeDetailOverlayOpen, sourceOverlayOpen } from './modalStack';
import { useModalLayer } from './useModalLayer';
import { SECTION_SWITCH_UNAVAILABLE_HINT, selectedSectionTabId } from './SectionBar';
import {
  loadEntryPins,
  PIN_BUTTON_TEXT,
  pinSaveOutcome,
  planPinToggle,
  PIN_LIMIT_TEXT,
  saveEntryPin,
} from './entryPins';
import {
  candidateAriaSuffix,
  candidateLoadedBy,
  candidatesById,
  isPinnedCandidate,
  PINNED_BADGE_TEXT,
  initialRevealState,
  rebaseRevealHistory,
  refreshRevealState,
  drawnRevealState,
  formatCandidateReason,
  hiddenNavigationTarget,
  layeredLayout,
  needsRevealListing,
  NODE_COLUMN_GAP,
  NODE_ROW_GAP,
  revealedPopulation,
  revealKey,
  revealListingReplyOutcome,
  revealNoticeFor,
  revealSwitchMessage,
  startRevealListing,
  decideRevealView,
  isCanvasRevealNotice,
  revealCapText,
  REVEAL_SWITCH_STATUS_MS,
  revealEndsFirstFitWait,
  revealRefitOnListing,
  revealStatusText,
  revealViewRequestForToggle,
  applyRevealTransition,
  announcementSteps,
  canGoBack,
  canGoForward,
  expandStub,
  formatRevealAnnouncement,
  formatRevealHistoryAnnouncement,
  historyMove,
  historyWithoutEntry,
  historyWithoutReveals,
  planRevealDrill,
  REVEAL_STEP_STALE_TEXT,
  revealFocusRescue,
  pushHistoryEntry,
  restoreRevealSnapshot,
  revealDrillKey,
  REVEAL_LAYER_CAP,
  revealAuxCards,
  revealCrossSectionNote,
  revealDrillButtonText,
  revealDrillControls,
  revealDrillGraphFor,
  revealRefText,
  revealStubText,
  type RevealDrillGraph,
  type HeldReveal,
  type HistoryEntry,
  type HistoryMove,
  type NavigationHistory,
  type RevealHistoryEntry,
  type RevealStep,
  type RevealAuxCard,
  type RevealDrillControl,
  type RevealNotice,
  type RevealState,
  type RevealViewMode,
  type RevealViewRequest,
  type SavedFullViewport,
  type Viewport,
} from './revealView';

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
      /** P4-2 phase 3b: the Type/Interface Nodes folded off this map (`CodeMapResult.foldedTypes`). */
      foldedTypes: readonly FoldedType[];
      /**
       * P4-2 phase 3c: the Module Nodes folded off this map
       * (`CodeMapResult.foldedModules`) — read only by the "Show types &
       * modules" canvas toggle. Absent means none (e.g. the dev fixture).
       */
      foldedModules?: readonly FoldedModule[];
      /**
       * P4-4 phase 1c: the section this map is for (`CodeMapResult.section`),
       * `null` for the whole scope. Absent means the whole scope (the dev fixture).
       */
      section?: string | null;
      /**
       * P4-4 phase 1c: the Section bar's tabs (`CodeMapResult.sections`) —
       * whole-scope counts per section, even in a section's reply. Absent means none.
       */
      sections?: readonly SectionNodeCount[];
      /**
       * P4-4 phase 3b: the reply's `crossSectionEdges` (P4-4g) — read only by
       * the footer line (`mapFooterState`). Absent means none.
       */
      crossSectionEdges?: readonly CrossSectionEdgeCount[];
    }
  | { status: 'error'; message: string };

/**
 * What the in-app source viewer opens: a file and line range. A Node is one;
 * P4-2 phase 2's "Tested by" rows open a test, which is not a map Node, and
 * name it with `label` (the test's name, or the test file for a file row)
 * so the viewer's header says what it is showing.
 */
export type SourceTarget = Pick<CodeMapNode, 'file' | 'startLine' | 'endLine'> & { label?: string };

export type SourceViewState =
  | { status: 'closed' }
  | { status: 'loading'; node: SourceTarget }
  | { status: 'open'; node: SourceTarget; content: string }
  | { status: 'error'; node: SourceTarget; message: string };

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
  // FIX-2: exactly the engine's `found` result — `path` (BFS visit order)
  // plus the BFS tree (`parents`/`depths`) the highlight and steps render.
  | FoundPathTrace
  // P2-4: a 1-hop trace drawn by a Node card's "called by"/"calls" pill —
  // renderer-local (no IPC), highlighted/fitted like `'found'`. It stores
  // `neighborTrace`'s whole snapshot, so the step panel and the highlight
  // (`pathTraceHighlight`) always read the same data, never live adjacency.
  | ({ status: 'neighbors'; originId: string; direction: NeighborDirection } & NeighborTrace)
  | { status: 'ambiguous'; candidates: { id: string; name: string }[] }
  | { status: 'no-path-found' }
  // P4-2 phase 3b: the query names a Type/Interface — folded off the map, so
  // it has no call path. Renderer-local (`resolvePathTraceQuery`), shown as
  // the "is a type — open its detail" notice instead of "No path found";
  // `types` (never empty, sorted by id) holds more than one when several
  // types match, for a chooser.
  | { status: 'folded-type'; query: string; types: FoldedType[] }
  | { status: 'error'; message: string };

/** FIX-2: a `'found'` Path Trace — `traceCallPath`'s result as-is, BFS tree included. */
export type FoundPathTrace = Extract<PathTraceResult, { status: 'found' }>;

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
  | {
      status: 'resolved';
      resolvedBaseRef: string;
      nodeIds: Set<string>;
      /** P4-2 phase 3a: `DiffScopeResult`'s `topLevelFiles`, `[]` when absent. */
      topLevelFiles: readonly TopLevelChangedFile[];
      /** P4-2 phase 3c: `DiffScopeResult`'s `changedContracts`, `[]` when absent. */
      changedContracts: readonly ChangedContract[];
      /** P4-2 phase 3c: `DiffScopeResult`'s `changedContractsApproximate`, `false` when absent. */
      changedContractsApproximate?: boolean;
      /**
       * P4-4 phase 3b: `DiffScopeResult`'s `changedInOtherSections` (P4-4g) —
       * what the diff changed in other sections of the same repository.
       * Absent (or `[]`) for none.
       */
      changedInOtherSections?: readonly SectionChangeCount[];
    }
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
 * P4-4 phase 1b: the error-state sentence for a Code Map fetch that did not
 * return a map. P4-4d: an `unknown-section` reply goes to the shell's
 * fallback (`handOffUnknownSection`) instead; this sentence is only for a
 * `CodeMap` rendered without one.
 */
export function codeMapFailureMessage(result: Exclude<CodeMapResult, { status: 'ok' }>): string {
  return result.status === 'unknown-section'
    ? `The section "${result.section}" is not in this project's included subfolders.`
    : result.message;
}

/**
 * P4-4 phase 2a: settles one section-scoped operation's reply (Path Trace,
 * diff scope or Blast Radius expansion) — the renderer's one rule for all
 * three, on top of each operation's own request-id guard:
 *  - a reply for a section other than the one on screen now (the section
 *    changed while it was in flight) is dropped — it never applies, even if
 *    nothing else bumped the request id;
 *  - `unknown-section` (the section left the allowlist) calls
 *    `unknownSection` — `CodeMap` resets the operation and hands the section
 *    to `onUnknownSection`, the same fallback to `all` as the Code Map fetch;
 *  - anything else is the operation's own result, for `apply`.
 * `requestedSection` is the section the request was sent with, `null` for
 * the whole scope. Hookless, so it's testable.
 */
export function settleSectionScopedReply<R extends { status: string }>(
  result: R | UnknownSectionResult,
  requestedSection: string | null,
  currentSection: string | null,
  handlers: { apply: (result: R) => void; unknownSection: (section: string) => void },
): void {
  if (requestedSection !== currentSection) {
    return;
  }
  if (isUnknownSectionResult(result)) {
    // P4-4d review round 1: the section the request was sent with, not the
    // reply's echo (only a whole-scope request, which can't be unknown,
    // falls back to the echo).
    handlers.unknownSection(requestedSection ?? result.section);
    return;
  }
  handlers.apply(result);
}

/**
 * P4-4e review round 1: the Blast Radius expansion's state after an
 * `unknown-section` reply. With a fallback (`onUnknownSection`, P4-4d) it is
 * called and the state is left to the reload it triggers (`null`: no
 * change). Without one, the expansion must not stay `loading` forever, and
 * can't go back to `idle` (the auto-trigger would re-send the same unknown
 * section), so it becomes the explicit error naming the section.
 */
export function blastRadiusStateOnUnknownSection(
  section: string,
  fallback: ((section: string) => void) | undefined,
): BlastRadiusState | null {
  if (fallback !== undefined) {
    fallback(section);
    return null;
  }
  return {
    status: 'error',
    message: codeMapFailureMessage({ status: 'unknown-section', section, knownSections: [] }),
  };
}

/**
 * P4-4 phase 1c: a Code Map fetch (load or refresh) that replied
 * `unknown-section` — the selected section left the allowlist — is handed to
 * the shell's fallback (`onUnknownSection`: back to `all`, announced as
 * status text), which reloads the map through the section change. Returns
 * whether it was handed off; without a fallback it is not, and the caller
 * shows its usual error state.
 *
 * P4-4d review round 1: the fallback is given `requestedSection`, the
 * section captured when the request was sent, never the reply's echoed
 * string. A whole-scope request (`null`) can't be unknown, so it is never
 * handed off.
 */
export function handOffUnknownSection(
  result: CodeMapResult,
  requestedSection: string | null,
  fallback: ((section: string) => void) | undefined,
): boolean {
  if (result.status !== 'unknown-section' || fallback === undefined || requestedSection === null) {
    return false;
  }
  fallback(requestedSection);
  return true;
}

/**
 * P4-4 phase 1c: the Node a successful `regenerateNode` patches in. In `all`
 * the reply is used as is. The reply is the whole-scope cached Node, so in a
 * section (`section !== null`) every structural field it carries —
 * `riskSignals` (severities cut over the whole scope), and the cross-section
 * links the section reply dropped (`fileTopLevel`, `fileTopLevelTypes`,
 * `usesTypes`, `calledAtLoadBy`, `similarTo`/`similarToTotal`, `testedBy`,
 * the test-coverage flags) — would overwrite the section's own.
 *
 * P4-4d review round 1: so in a section the on-screen Node is kept and only
 * what regeneration changes is taken from the reply: `summaryStatus`,
 * `summary` and `stale` (an absent optional field in the reply is absent in
 * the result, never left over from the old summary).
 */
export function regeneratedNodeForMap(
  onScreen: CodeMapNode,
  regenerated: CodeMapNode,
  section: string | null,
): CodeMapNode {
  if (section === null) {
    return regenerated;
  }
  const next: CodeMapNode = { ...onScreen, summaryStatus: regenerated.summaryStatus };
  delete next.summary;
  delete next.stale;
  if (regenerated.summary !== undefined) {
    next.summary = regenerated.summary;
  }
  if (regenerated.stale !== undefined) {
    next.stale = regenerated.stale;
  }
  return next;
}

function isUnknownSectionResult(result: { status: string }): result is UnknownSectionResult {
  return result.status === 'unknown-section';
}

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
export type BlastRadiusState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'resolved'; hopDistances: Map<string, number>; maxDepth: number }
  | { status: 'error'; message: string };

// The grid spacing (`NODE_COLUMN_GAP`×`NODE_ROW_GAP`) is declared in
// `revealView.ts` (P4-7d), shared by the Full grid and the Revealed columns,
// and re-exported from here unchanged.
export { NODE_COLUMN_GAP, NODE_ROW_GAP };

// FIX-1: a Node card's size when `@xyflow/react` hasn't measured it (a card
// still folded into an LOD cluster has no DOM, so no `measured` size). An
// estimate of the rendered `.code-map__node` card (min-width 160px plus
// padding, identifier + one-line summary + signal strip), used only to find
// the card's centre for `routeFitRequest`'s anchor; a measured size wins.
export const NODE_CARD_FALLBACK_WIDTH = 200;
export const NODE_CARD_FALLBACK_HEIGHT = 80;

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
export const MAP_MAX_ZOOM = 2;

// FIX-3: how many animation frames the first fit waits for a measured map
// size before revealing the canvas unfitted (~1s at 60fps). In practice the
// size arrives within a frame or two.
const INITIAL_FIT_MAX_RETRIES = 60;

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

// The Back/Forward `history.stack` cap (`MAX_HISTORY_LENGTH`, review finding,
// same spirit as `MAX_EXPANDED_CLUSTER_IDS` above) lives with the pure
// history update in `revealView.ts` since P4-7f (`pushHistoryEntry`).

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
 * `fitBounds`' zoom for `bounds` in `viewport` (padding already folded into
 * `bounds`), capped at `maxZoom`. Shared by `routeViewport` and FIX-3's
 * `initialViewport` so the two can't disagree. Zero-size bounds give
 * `Infinity`, which the cap turns into `maxZoom`.
 */
export function boundsFitZoom(bounds: Size, viewport: Size, maxZoom: number): number {
  return Math.min(maxZoom, viewport.width / bounds.width, viewport.height / bounds.height);
}

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
    const fitZoom = boundsFitZoom(bounds, viewport, maxZoom);
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

/**
 * FIX-3: the cluster the first view opens on when the whole map doesn't fit
 * at a readable zoom — the one standing in for the most Nodes. A tie goes to
 * the smaller `id` (plain code-unit order, not `localeCompare`), so the pick
 * never depends on `computeLOD`'s array order. `null` when there are none.
 */
export function densestCluster(clusters: readonly Cluster[]): Cluster | null {
  let best: Cluster | null = null;
  for (const cluster of clusters) {
    if (
      best === null ||
      cluster.nodeIds.length > best.nodeIds.length ||
      (cluster.nodeIds.length === best.nodeIds.length && cluster.id < best.id)
    ) {
      best = cluster;
    }
  }
  return best;
}

/** FIX-3: what the first-view effect should do this render. */
export type InitialFitDecision = 'fit' | 'wait' | 'done';

export interface InitialFitDecisionInput {
  /** This canvas mount (`onInit`) hasn't had its first fit yet. */
  pending: boolean;
  /** `onInit` has handed over a live React Flow instance. */
  instanceReady: boolean;
  /** The project this map is for. */
  projectPath: string | null;
  /** The project the last first-fit was applied for (`null` before any). */
  fittedProjectPath: string | null;
  /** P4-4 phase 1c: the section this map is for (`null` = `all`). */
  section: string | null;
  /** P4-4 phase 1c: the section the last first-fit was applied for. */
  fittedSection: string | null;
  /** Laid-out Nodes of the ready map (0 while loading, errored or empty). */
  nodesCount: number;
  /** The measured map size (`measuredViewportSize`: own ResizeObserver, else React Flow's store). */
  size: { width: number; height: number };
}

/**
 * FIX-3: the first-view effect's gate, as a pure decision. Armed while this
 * canvas mount is `pending` or the project — or, P4-4 phase 1c, the section —
 * differs from the one last fitted (a project or section change re-arms it,
 * so the viewport fits the new Node set); an armed fit `wait`s until the instance, a
 * non-empty laid-out map and a usable size all exist, then `fit`s once.
 * Otherwise `done`: the one-shot fit is spent, so a refresh, scope change or
 * resize keeps the user's own pan/zoom.
 */
export function initialFitDecision({
  pending,
  instanceReady,
  projectPath,
  fittedProjectPath,
  section,
  fittedSection,
  nodesCount,
  size,
}: InitialFitDecisionInput): InitialFitDecision {
  if (!pending && projectPath === fittedProjectPath && section === fittedSection) {
    return 'done';
  }
  const sized = isFiniteNumber(size.width) && isFiniteNumber(size.height) && size.width > 0 && size.height > 0;
  return instanceReady && nodesCount > 0 && sized ? 'fit' : 'wait';
}

/** FIX-3: the first-fit bookkeeping one canvas carries between renders. */
export interface InitialFitState {
  pending: boolean;
  fittedProjectPath: string | null;
  /** P4-4 phase 1c: the section of the last first-fit. */
  fittedSection: string | null;
}

export const INITIAL_FIT_STATE: InitialFitState = { pending: false, fittedProjectPath: null, fittedSection: null };

/** FIX-3: a canvas mount (`onInit`) owes a first fit. */
export function armInitialFit(state: InitialFitState): InitialFitState {
  return { ...state, pending: true };
}

/** FIX-3: the first fit landed for `projectPath` (and, P4-4 phase 1c, `section`) — spent until the next mount, project or section. */
export function completeInitialFit(projectPath: string | null, section: string | null): InitialFitState {
  return { pending: false, fittedProjectPath: projectPath, fittedSection: section };
}

export interface InitialViewportParams {
  /** Every laid-out Node (`lodInputNodes`): id plus top-left world position. */
  nodes: readonly LODInputNode[];
  /** A Node card's size, to turn top-left positions into a footprint and a centre. */
  cardSize: Size;
  /** The measured map container. */
  viewport: Size;
  minReadableZoom: number;
  maxZoom: number;
  /** `LOD_ZOOM_THRESHOLD` — the clustering the whole-map fit would have shown. */
  lodThreshold: number;
}

/**
 * FIX-3: the viewport a project's map first opens at — never below
 * `minReadableZoom`, so the first thing on screen is real Node cards rather
 * than a handful of cluster dots.
 *
 * The whole map's footprint (every card, with `fitView`'s own 10% padding)
 * goes through FIX-1's `routeViewport`. If that fits at a readable zoom it is
 * the plain whole-map fit. Otherwise the view opens at the readable floor,
 * anchored on the centre of the densest cluster (`densestCluster`) of the
 * clustering the whole-map fit would have produced — `computeLOD` at that
 * fit's banded zoom, the same banding the live render applies. With no
 * cluster at all it anchors on the map's centre. `Cluster.position` is the
 * centroid of its members' top-left positions, so the anchor adds half a card
 * to land on the centre of the average card. The floor is
 * `min(minReadableZoom, maxZoom)`, as in `routeViewport`, so a `maxZoom`
 * below the readable floor caps it rather than being exceeded.
 *
 * `null` when there is nothing to fit or the container isn't measured yet —
 * the caller waits rather than fitting to a 0×0 view.
 */
export function initialViewport({
  nodes,
  cardSize,
  viewport,
  minReadableZoom,
  maxZoom,
  lodThreshold,
}: InitialViewportParams): { x: number; y: number; zoom: number; clamped: boolean } | null {
  const first = nodes[0];
  const measured =
    isFiniteNumber(viewport.width) && isFiniteNumber(viewport.height) && viewport.width > 0 && viewport.height > 0;
  if (first === undefined || !measured) {
    return null;
  }
  // `.reduce()` rather than a `Math.min(...spread)` — see `routeFitRequest`.
  const minX = nodes.reduce((min, node) => Math.min(min, node.position.x), first.position.x);
  const maxX = nodes.reduce((max, node) => Math.max(max, node.position.x), first.position.x);
  const minY = nodes.reduce((min, node) => Math.min(min, node.position.y), first.position.y);
  const maxY = nodes.reduce((max, node) => Math.max(max, node.position.y), first.position.y);
  const footprint = { x: minX, y: minY, width: maxX - minX + cardSize.width, height: maxY - minY + cardSize.height };
  const paddedWidth = footprint.width * (1 + ROUTE_FIT_PADDING);
  const paddedHeight = footprint.height * (1 + ROUTE_FIT_PADDING);
  const bounds = {
    x: footprint.x - (paddedWidth - footprint.width) / 2,
    y: footprint.y - (paddedHeight - footprint.height) / 2,
    width: paddedWidth,
    height: paddedHeight,
  };
  const centre = { x: footprint.x + footprint.width / 2, y: footprint.y + footprint.height / 2 };
  const params = { bounds, viewport, minReadableZoom, maxZoom };
  const fit = routeViewport({ ...params, anchor: centre });
  if (!fit.clamped) {
    return fit;
  }
  // The whole-map fit's zoom — what `fitView` would have opened at — for the
  // clustering the user would have seen there. `routeViewport` clamped, so
  // it is below the floor (and is finite: the bounds include a card).
  const fitZoom = boundsFitZoom(bounds, viewport, maxZoom);
  const { clusters } = computeLOD({
    nodes: [...nodes],
    zoom: quantizeZoomBand(fitZoom, lodThreshold),
    threshold: lodThreshold,
    viewportBounds: bounds,
  });
  const densest = densestCluster(clusters);
  const anchor = densest
    ? { x: densest.position.x + cardSize.width / 2, y: densest.position.y + cardSize.height / 2 }
    : centre;
  return routeViewport({ ...params, anchor });
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
    /**
     * P4-2 phase 3c: the names of the changed contracts this Node depends on
     * (PR Review) — set only when there is one. The card shows a ⧉ marker
     * and its accessible name says "affected by changed contract X".
     */
    affectedByContracts?: readonly string[];
    /**
     * P4-7d: set only on an entry candidate's card in the Revealed view —
     * the "◎ candidate" badge, its reason line and the aria suffix.
     */
    candidate?: EntryCandidate;
    /**
     * P4-7e: set only on a revealed Node's card in Revealed — its
     * "▸ Expand callees (N)" / "▾ Collapse" button (none at N = 0) and what
     * pressing it does.
     */
    drill?: RevealDrillControl;
    onDrill?: (node: CodeMapNode, action: RevealDrillControl['kind']) => void;
    /** P4-7e: Revealed in a section only — "↗ Calls N Nodes in other sections (not shown in this section)" (`revealCrossSectionNote`). */
    crossSectionNote?: string;
  },
  'codeMapNode'
>;

/**
 * P4-7e: a Revealed ref card — "↺ `<name>` shown above" for a callee already
 * revealed elsewhere. Render-only, like a folded card: never a `CodeMapNode`,
 * never counted. Activating it navigates to the target.
 */
type CodeMapRevealRefFlowNode = FlowNode<
  {
    ref: Extract<RevealAuxCard, { kind: 'ref' }>;
    onActivate: (ref: Extract<RevealAuxCard, { kind: 'ref' }>) => void;
  },
  'codeMapRevealRef'
>;

/** P4-7e: a Revealed stub card — "+N more callees"; activating it reveals the next `REVEAL_LAYER_CAP`. Render-only. */
type CodeMapRevealStubFlowNode = FlowNode<
  {
    stub: Extract<RevealAuxCard, { kind: 'more' }>;
    onActivate: (stub: Extract<RevealAuxCard, { kind: 'more' }>) => void;
  },
  'codeMapRevealStub'
>;

/**
 * P4-2 phase 3c: a folded Type/Interface/Module card drawn by "Show types &
 * modules" — its own node type and card (`CodeMapFoldedCard`): no summary,
 * no neighbour pills, no caller counts, no risk signals.
 */
type CodeMapFoldedFlowNode = FlowNode<
  {
    folded: FoldedCanvasNode;
    onActivate: (folded: FoldedCanvasNode) => void;
    /** A changed contract's own card, in PR Review. */
    isChanged: boolean;
  },
  'codeMapFolded'
>;

/** A card on the canvas: a map Node's, a folded kind's, or (P4-7e, Revealed) a ref or stub. */
type CodeMapCardFlowNode = CodeMapFlowNode | CodeMapFoldedFlowNode | CodeMapRevealRefFlowNode | CodeMapRevealStubFlowNode;

/** P4-2 phase 3c: a canvas card's map Node — `undefined` for a folded card (not a map Node) or none. */
const mapNodeOf = (flowNode: CodeMapCardFlowNode | undefined): CodeMapNode | undefined =>
  flowNode?.type === 'codeMapNode' ? flowNode.data.node : undefined;

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
 * counts (`callsOnly`). A `'found'` trace is `traceCallPath`'s `CALLS`-only
 * walk, so only a `CALLS` edge highlights — and (FIX-2) exactly the true call
 * subgraph: every real `CALLS` edge in `callEdges` (the map's own edges)
 * whose two ends were both reached, self-loops excluded. That includes
 * non-tree edges on fan-in (serviceB→repository when repository was first
 * reached via serviceA), so nothing real is hidden. `path` is the reachable
 * set in visit order, NOT a chain: consecutive entries are often sibling
 * callees, so a consecutive-pair key would assert a call that doesn't exist.
 * Never build edge keys from `path` pairs. A `'neighbors'` trace reads its stored snapshot, and since
 * the adjacency it came from counts every edge kind, its connecting edges
 * highlight whatever their kind. Every other state highlights nothing (the
 * shared `EMPTY_ID_SET`, so memoized consumers don't see a new Set).
 */
export interface PathHighlight {
  nodeIds: ReadonlySet<string>;
  edgeKeys: ReadonlySet<string>;
  callsOnly: boolean;
}

/** FIX-2: one real `CALLS` edge of the fetched map, as `pathTraceHighlight` reads it. */
export interface CallEdge {
  source: string;
  target: string;
}

/**
 * FIX-2: the map's real `CALLS` edges, for `pathTraceHighlight` — any other
 * kind is dropped, since a `'found'` trace is `CALLS`-only.
 */
export function callEdgesOf(edges: readonly { source: string; target: string; kind: string }[]): CallEdge[] {
  return edges.filter((edge) => edge.kind === 'CALLS').map(({ source, target }) => ({ source, target }));
}

export function pathTraceHighlight(pathTrace: PathTraceState, callEdges: readonly CallEdge[]): PathHighlight {
  if (pathTrace.status === 'found') {
    const nodeIds = new Set(pathTrace.path);
    const edgeKeys = new Set<string>();
    for (const edge of callEdges) {
      if (edge.source !== edge.target && nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
        edgeKeys.add(pathEdgeKey(edge.source, edge.target));
      }
    }
    return { nodeIds, edgeKeys, callsOnly: true };
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

/** P4-2 phase 3a: the "↑at load" cue's title: "Called at load by a.ts, b.ts" (up to 3 files, then "+N more"). */
export function loadCallerPillTitle(files: readonly string[]): string {
  const more = files.length - 3;
  return `Called at load by ${files.slice(0, 3).join(', ')}${more > 0 ? ` +${more} more` : ''}`;
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
  node: { id: string; name: string; calledAtLoadBy?: string[] };
  callerCount: number;
  calleeCount: number;
  onShowNeighbors: (originId: string, direction: NeighborDirection) => void;
}) {
  const loadCallers = node.calledAtLoadBy ?? [];
  return (
    <>
      {/* P4-2 phase 3a: a Node whose only callers are files' top-level code
          (folded off the map) has no caller pill — this says it is still
          called, at load. Not a button: there is no map Node to trace to;
          Node detail's "File top-level" section names the files. */}
      {callerCount === 0 && loadCallers.length > 0 && (
        <span className="code-map__node-load-caller" title={loadCallerPillTitle(loadCallers)}>
          ↑at load<span className="visually-hidden"> — {loadCallerPillTitle(loadCallers)}</span>
        </span>
      )}
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
 * FIX-2: what `callTreeOrder` reads — a `'found'` trace's `path`, `parents`
 * and `depths`. `parents`/`depths` are typed optional on purpose: a result
 * from an older Graph Service (or any malformed one) may lack them, and the
 * step list must degrade rather than throw.
 */
export interface CallTreeInput {
  path: readonly string[];
  parents?: FoundPathTrace['parents'] | undefined;
  depths?: FoundPathTrace['depths'] | undefined;
}

/** FIX-2: one row of the `'found'` call tree — see `callTreeOrder`. */
export interface CallTreeRow {
  id: string;
  /** Depth in the BFS tree (root = 0) — drives the indent and the list nesting. */
  depth: number;
  /** The row's tree parent, `null` for a root. */
  parent: string | null;
  /**
   * The caller to NAME on this row: its parent whenever the parent isn't the
   * row directly above, or whenever the indent has hit its cap
   * (`CALL_TREE_INDENT_CAP_DEPTH`) and can no longer show nesting on its own.
   * `null` otherwise.
   */
  calledBy: string | null;
}

/** FIX-2: indent per tree level, and the depth at which it stops growing (64px). */
const CALL_TREE_INDENT_PX = 8;
export const CALL_TREE_INDENT_CAP_DEPTH = 8;

/** FIX-2: a row's indent in px — `depth * 8`, capped at 64px so a deep tree can't push text out of the fixed-width panel. */
export function callTreeIndentPx(depth: number): number {
  return Math.min(depth, CALL_TREE_INDENT_CAP_DEPTH) * CALL_TREE_INDENT_PX;
}

// Malformed-trace warnings fire once per trace object, not on every render.
const warnedCallTrees = new WeakSet<object>();
function warnCallTreeOnce(trace: CallTreeInput, message: string): void {
  if (warnedCallTrees.has(trace)) {
    return;
  }
  warnedCallTrees.add(trace);
  console.warn(`[path-trace] ${message}`);
}

/**
 * FIX-2: the `'found'` step list's rows, in depth-first pre-order of the BFS
 * tree (children in ascending id order, the engine's own sibling order), so
 * each row sits directly under its real caller and indentation alone is
 * truthful: for E→(A, B), A→C the rows are E, A, C, B. Never BFS order —
 * there, C would render under B, which doesn't call it.
 *
 * Pure. Robust to a malformed result, never throwing:
 *  - `parents` missing: every Node is a root, so the list is flat, in `path`
 *    order, with no caller notes (logged once).
 *  - a self-parent, a non-string parent, or a parent not in `path`: that
 *    Node is a root (logged once).
 *  - a parent cycle unreachable from any root: its Nodes are appended as
 *    roots, so every `path` Node still renders exactly once.
 *  - depth is always the tree depth — root 0, otherwise the parent's depth
 *    + 1 — which is exactly what the engine's `depths` holds by
 *    construction. A missing `depths`, or an entry that disagrees, is
 *    derived that way (logged once) rather than trusted, so the indent can
 *    never contradict the nesting.
 */
export function callTreeOrder(trace: CallTreeInput): CallTreeRow[] {
  const { parents, depths } = trace;
  if (!parents || !depths) {
    warnCallTreeOnce(trace, `found trace is missing ${!parents ? 'parents' : 'depths'}; rendering a degraded call tree.`);
  }
  const ids = [...new Set(trace.path)];
  const inPath = new Set(ids);

  const parentOf = new Map<string, string | null>();
  for (const id of ids) {
    const raw: unknown = parents && Object.hasOwn(parents, id) ? parents[id] : null;
    const valid = typeof raw === 'string' && raw !== id && inPath.has(raw);
    if (parents && raw !== null && !valid) {
      warnCallTreeOnce(trace, `found trace has an invalid parent for ${id}; treating it as a root.`);
    }
    parentOf.set(id, valid ? raw : null);
  }

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    if (parent === null) {
      roots.push(id);
      continue;
    }
    const siblings = childrenOf.get(parent);
    if (siblings) {
      siblings.push(id);
    } else {
      childrenOf.set(parent, [id]);
    }
  }
  for (const children of childrenOf.values()) {
    children.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const rows: CallTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (rootId: string) => {
    // Iterative pre-order DFS: a deep tree can't blow the call stack.
    const stack: { id: string; depth: number; parent: string | null }[] = [
      { id: rootId, depth: 0, parent: null },
    ];
    while (stack.length > 0) {
      const { id, depth, parent } = stack.pop()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      if (depths && depths[id] !== depth) {
        warnCallTreeOnce(trace, `found trace depth for ${id} disagrees with its parent chain; using the tree depth.`);
      }
      const previous = rows.at(-1)?.id;
      rows.push({
        id,
        depth,
        parent,
        calledBy:
          parent !== null && (parent !== previous || depth >= CALL_TREE_INDENT_CAP_DEPTH) ? parent : null,
      });
      const children = childrenOf.get(id) ?? [];
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({ id: children[i]!, depth: depth + 1, parent: id });
      }
    }
  };
  for (const root of roots) {
    walk(root);
  }
  for (const id of ids) {
    if (!visited.has(id)) {
      warnCallTreeOnce(trace, `found trace has a parent cycle at ${id}; treating it as a root.`);
      parentOf.set(id, null);
      walk(id);
    }
  }
  return rows;
}

/** FIX-2: a call-tree row plus its children, for the nested-list rendering. */
interface CallTreeNode {
  row: CallTreeRow;
  children: CallTreeNode[];
}

/** FIX-2: nests `callTreeOrder`'s pre-order rows by depth (each row's parent is the nearest shallower row above it). */
function nestCallTreeRows(rows: readonly CallTreeRow[]): CallTreeNode[] {
  const roots: CallTreeNode[] = [];
  const stack: CallTreeNode[] = [];
  for (const row of rows) {
    const node: CallTreeNode = { row, children: [] };
    while (stack.length > 0 && stack.at(-1)!.row.depth >= row.depth) {
      stack.pop();
    }
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** FIX-2: a step row's "called by X" note — this prefix, then the caller's identifier in `<code>`. */
export const CALLED_BY_PREFIX = 'called by ';

/**
 * Story 1.9 (Phase 2): the step panel for a `'found'` Path Trace state —
 * extracted (FIX-1) as a hookless component, like `NeighborTraceSteps`, so a
 * test can walk its element tree. `resolveNode` returns the id itself as the
 * name when a Node can't be resolved.
 *
 * FIX-2: renders the call tree (`callTreeOrder`) as nested `<ul>`s, so
 * assistive tech gets the real structure, not just the visual indent. No hop
 * numbers: rows are tree order, not a sequence. A row names its caller
 * ("called by X") when the caller isn't the row directly above.
 */
export function FoundTraceSteps({
  path,
  parents,
  depths,
  resolveNode,
  onNavigate,
  onDismiss,
  routeClamped = false,
}: {
  path: readonly string[];
  parents: FoundPathTrace['parents'];
  depths: FoundPathTrace['depths'];
  resolveNode: (id: string) => { name: string; file: string | undefined };
  onNavigate: (id: string) => void;
  onDismiss: () => void;
  /** FIX-1: `routeViewport` clamped the fit, so the route runs past the view. */
  routeClamped?: boolean;
}) {
  const renderNodes = (nodes: CallTreeNode[], nested: boolean) => (
    <ul className={nested ? 'code-map__path-trace-tree-children' : 'code-map__path-trace-steps code-map__path-trace-tree'}>
      {nodes.map(({ row: { id, depth, calledBy }, children }) => {
        const node = resolveNode(id);
        return (
          // `callTreeOrder` renders each Node exactly once, so `id` is a unique key.
          <li key={id}>
            <button type="button" className="code-map__path-trace-stack-row" onClick={() => onNavigate(id)}>
              {/* Roots (depth 0) carry no connector; every other row is
                  indented by its tree depth (`callTreeIndentPx`, capped at
                  64px — past the cap the caller is always named instead). */}
              {depth > 0 && (
                <span
                  className="code-map__path-trace-indent"
                  aria-hidden="true"
                  style={{ marginLeft: `${callTreeIndentPx(depth)}px` }}
                >
                  └─
                </span>
              )}
              <span className="code-map__path-trace-stack-row-text">
                <code className="code-map__path-trace-stack-row-name">{node.name}</code>
                {calledBy !== null && (
                  <span className="code-map__path-trace-stack-row-caller">
                    {CALLED_BY_PREFIX}
                    <code>{resolveNode(calledBy).name}</code>
                  </span>
                )}
                {node.file && <span className="code-map__path-trace-stack-row-module">{node.file}</span>}
              </span>
            </button>
            {children.length > 0 && renderNodes(children, true)}
          </li>
        );
      })}
    </ul>
  );
  return (
    // Boundaries & Constraints (UX-DR10): "leaves the
    // highlight/step list visible for further stepping" — clicking
    // an entry only re-centers the map via `navigateToNode`, it
    // never closes/collapses this panel.
    //
    // DESIGN.md `path-trace-stack-row`: dense-profiler's indented
    // call-stack visual — tree-indent glyph, identifier, module.
    // Deliberately no duration/timing field (Never: driller resolves
    // paths statically and never executes code).
    <div className="code-map__path-trace-steps-panel" role="region" aria-label="Call tree">
      {renderNodes(nestCallTreeRows(callTreeOrder({ path, parents, depths })), false)}
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

/**
 * The Code Map's grid layout: Node `index` of `nodeCount` at column
 * `index % columns`, row `index / columns`, `ceil(sqrt(nodeCount))` columns,
 * spaced `NODE_COLUMN_GAP`×`NODE_ROW_GAP`. The top-left of its card. Exported
 * (FIX-3) so tests lay maps out exactly as `layoutNodes` does.
 */
export function layoutPosition(index: number, nodeCount: number): { x: number; y: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodeCount)));
  return { x: (index % columns) * NODE_COLUMN_GAP, y: Math.floor(index / columns) * NODE_ROW_GAP };
}

export function layoutNodes(
  nodes: readonly CodeMapNode[],
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
  // P4-2 phase 3c: the "Show types & modules" toggle's render-only folded
  // cards (`canvasPopulation`), laid out after `nodes` — see
  // `canvasGridSize` — and activated through `onActivateFolded`.
  foldedNodes: readonly FoldedCanvasNode[] = [],
  onActivateFolded: (folded: FoldedCanvasNode) => void = () => {},
  // P4-2 phase 3c: map Node id → the changed contracts it depends on.
  contractDependents: ReadonlyMap<string, readonly string[]> = NO_CONTRACT_DEPENDENTS,
  // P4-7d: Revealed passes `layeredLayout`'s positions. Omitted (Full map),
  // every card is exactly `layoutPosition(index, gridSize)`, as before.
  positionOf?: (id: string, index: number) => { x: number; y: number },
  // P4-7d: Revealed's entry candidates by id — a candidate's card gets
  // `data.candidate` (badge, reason, aria suffix). Omitted, no card has it.
  candidates?: ReadonlyMap<string, EntryCandidate>,
  // P4-7e: Revealed's drill — each revealed Node's control, the ref and stub
  // cards (render-only, placed by `positionOf` like the folded cards), and
  // the cross-section note. Omitted (Full map), no card gets any of it.
  reveal?: LayoutRevealExtras,
): CodeMapCardFlowNode[] {
  const gridSize = canvasGridSize(nodes.length, foldedNodes.length);
  const place = positionOf ?? ((_id: string, index: number) => layoutPosition(index, gridSize));
  const cards: CodeMapCardFlowNode[] = nodes.map((node, index) => {
    const entry = adjacency.get(node.id);
    const affectedByContracts = contractDependents.get(node.id);
    const candidate = candidates?.get(node.id);
    return {
      id: node.id,
      type: 'codeMapNode',
      position: place(node.id, index),
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
        ...(affectedByContracts !== undefined ? { affectedByContracts } : {}),
        ...(candidate !== undefined ? { candidate } : {}),
        ...(reveal !== undefined ? revealCardData(reveal, node) : {}),
      },
    };
  });
  foldedNodes.forEach((folded, index) => {
    cards.push({
      id: folded.id,
      type: 'codeMapFolded',
      position: place(folded.id, nodes.length + index),
      data: { folded, onActivate: onActivateFolded, isChanged: changedNodeIds.has(folded.id) },
    });
  });
  reveal?.auxCards.forEach((aux, index) => {
    const position = place(aux.id, nodes.length + foldedNodes.length + index);
    cards.push(
      aux.kind === 'ref'
        ? { id: aux.id, type: 'codeMapRevealRef', position, data: { ref: aux, onActivate: reveal.onActivateRef } }
        : { id: aux.id, type: 'codeMapRevealStub', position, data: { stub: aux, onActivate: reveal.onActivateStub } },
    );
  });
  return cards;
}

/** P4-7e: what `layoutNodes` needs for Revealed's drill. */
export interface LayoutRevealExtras {
  controls: ReadonlyMap<string, RevealDrillControl>;
  onDrill: (node: CodeMapNode, action: RevealDrillControl['kind']) => void;
  auxCards: readonly RevealAuxCard[];
  onActivateRef: (ref: Extract<RevealAuxCard, { kind: 'ref' }>) => void;
  onActivateStub: (stub: Extract<RevealAuxCard, { kind: 'more' }>) => void;
}

/** P4-7e: a revealed Node card's drill data — its control (if any), the handler, and the cross-section note (if any). */
function revealCardData(
  reveal: LayoutRevealExtras,
  node: CodeMapNode,
): { drill?: RevealDrillControl; onDrill: LayoutRevealExtras['onDrill']; crossSectionNote?: string } {
  const drill = reveal.controls.get(node.id);
  // Review round 1: only on an expanded card — beside the callees it shows.
  const crossSectionNote = drill?.kind === 'collapse' ? revealCrossSectionNote(node) : null;
  return {
    ...(drill !== undefined ? { drill } : {}),
    onDrill: reveal.onDrill,
    ...(crossSectionNote !== null ? { crossSectionNote } : {}),
  };
}

/**
 * P4-2 phase 3c: the grid size the canvas is laid out with. Sized by the
 * map Nodes alone, so they keep their positions when "Show types &
 * modules" flips and the folded cards fill the rows below; a map with no
 * Nodes lays the folded cards out in the normal grid of their own count.
 */
export function canvasGridSize(mapNodeCount: number, foldedCount: number): number {
  return mapNodeCount > 0 ? mapNodeCount : foldedCount;
}

const NO_CONTRACT_DEPENDENTS: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * P4-2 phase 3c: a folded Type/Interface/Module as a render-only canvas
 * card ("Show types & modules"). Deliberately not a `CodeMapNode`: it has
 * no summary, no risk signals, no callers or callees — nothing that could
 * be mistaken for, or counted as, a map Node. `usedByTotal` is a type's
 * full user count (absent for a Module).
 */
export interface FoldedCanvasNode {
  folded: true;
  id: string;
  name: string;
  kind: 'Type' | 'Interface' | 'Module';
  file: string;
  startLine: number;
  endLine: number;
  usedByTotal?: number;
}

/**
 * P4-2 phase 3c: the folded kinds as render-only canvas elements. `edges`
 * are rebuilt from the folded indexes' real links only — a type's `usedBy`
 * and `refersTo` as `USAGE` edges, a Module's `uses` (with their own kind)
 * and `usesTypes` (`USAGE`) — and only where both ends are drawn. A type's
 * `usedBy` may be capped (`FOLDED_TYPE_IPC_MAX_USED_BY`), so a heavily used
 * type draws at most that many use edges.
 *
 * Nothing here feeds a number: see `canvasPopulation`.
 */
export interface FoldedCanvasElements {
  nodes: FoldedCanvasNode[];
  edges: CodeMapEdge[];
}

const NO_FOLDED_CANVAS: FoldedCanvasElements = { nodes: [], edges: [] };

/** P4-2 phase 3c: a folded Module's card name — its file's base name. */
const moduleName = (file: string): string => file.slice(file.lastIndexOf('/') + 1) || file;

/**
 * P4-2 phase 3c: builds `FoldedCanvasElements`. An id already on the map
 * (or drawn earlier) is never drawn twice; a Module is drawn under its
 * first `moduleIds` entry. Pure.
 */
export function foldedCanvasElements(
  mapNodes: readonly Pick<CodeMapNode, 'id'>[],
  foldedTypes: readonly FoldedType[],
  foldedModules: readonly FoldedModule[],
): FoldedCanvasElements {
  if (foldedTypes.length === 0 && foldedModules.length === 0) {
    return NO_FOLDED_CANVAS;
  }
  const mapIds = new Set(mapNodes.map((node) => node.id));
  const drawn = new Set(mapIds);
  const nodes: FoldedCanvasNode[] = [];
  const typeIds = new Set<string>();
  for (const type of foldedTypes) {
    if (drawn.has(type.id)) {
      continue;
    }
    drawn.add(type.id);
    typeIds.add(type.id);
    nodes.push({
      folded: true,
      id: type.id,
      name: type.name,
      kind: type.kind,
      file: type.file,
      startLine: type.startLine,
      endLine: type.endLine,
      usedByTotal: type.usedByTotal,
    });
  }
  const modules: { id: string; module: FoldedModule }[] = [];
  for (const module of foldedModules) {
    const id = module.moduleIds[0];
    if (id === undefined || drawn.has(id)) {
      continue;
    }
    drawn.add(id);
    modules.push({ id, module });
    nodes.push({
      folded: true,
      id,
      name: moduleName(module.file),
      kind: 'Module',
      file: module.file,
      startLine: module.startLine,
      endLine: module.endLine,
    });
  }

  const edges: CodeMapEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (source: string, target: string, kind: CodeMapEdge['kind']): void => {
    const key = `${source}\u0000${target}\u0000${kind}`;
    if (source !== target && drawn.has(source) && drawn.has(target) && !seen.has(key)) {
      seen.add(key);
      edges.push({ source, target, kind });
    }
  };
  for (const type of foldedTypes) {
    if (!typeIds.has(type.id)) {
      continue;
    }
    for (const user of type.usedBy) {
      if (mapIds.has(user)) {
        addEdge(user, type.id, 'USAGE');
      }
    }
    for (const target of type.refersTo) {
      if (typeIds.has(target)) {
        addEdge(type.id, target, 'USAGE');
      }
    }
  }
  for (const { id, module } of modules) {
    for (const use of module.uses) {
      if (mapIds.has(use.id)) {
        addEdge(id, use.id, use.kind);
      }
    }
    for (const use of module.usesTypes ?? []) {
      if (typeIds.has(use.id)) {
        addEdge(id, use.id, 'USAGE');
      }
    }
  }
  return { nodes, edges };
}

/**
 * P4-2 phase 3c: what the canvas draws versus what every number is
 * computed from. `riskNodes`/`riskEdges` are the fetched map as-is — the
 * only input to adjacency, Path Trace, Health Audit and anything else that
 * counts — whatever the toggle says. `canvasNodes`/`canvasEdges` add the
 * folded cards and their edges when `showFolded` is on; they feed only the
 * card layout, LOD (so folded cards cluster and un-cluster like any card)
 * and the rendered edges. Pure.
 */
export interface CanvasPopulation {
  riskNodes: readonly CodeMapNode[];
  riskEdges: readonly CodeMapEdge[];
  canvasNodes: readonly (CodeMapNode | FoldedCanvasNode)[];
  canvasEdges: readonly CodeMapEdge[];
  /** The folded cards drawn (`canvasNodes` minus `riskNodes`); `[]` with the toggle off. */
  foldedNodes: readonly FoldedCanvasNode[];
}

const EMPTY_CANVAS_POPULATION: CanvasPopulation = {
  riskNodes: [],
  riskEdges: [],
  canvasNodes: [],
  canvasEdges: [],
  foldedNodes: [],
};

export function canvasPopulation(
  fetchState: FetchState,
  foldedCanvas: FoldedCanvasElements,
  showFolded: boolean,
): CanvasPopulation {
  if (fetchState.status !== 'ready') {
    return EMPTY_CANVAS_POPULATION;
  }
  const riskNodes = fetchState.nodes;
  const riskEdges = fetchState.edges;
  if (!showFolded || (foldedCanvas.nodes.length === 0 && foldedCanvas.edges.length === 0)) {
    return { riskNodes, riskEdges, canvasNodes: riskNodes, canvasEdges: riskEdges, foldedNodes: [] };
  }
  return {
    riskNodes,
    riskEdges,
    canvasNodes: [...riskNodes, ...foldedCanvas.nodes],
    canvasEdges: [...riskEdges, ...foldedCanvas.edges],
    foldedNodes: foldedCanvas.nodes,
  };
}

/**
 * P4-2 phase 3c: what activating a canvas card does — a cluster expands; a
 * map Node's card calls its `onActivate` (Node detail); a folded card calls
 * its own (type detail, or a Module's top-level source). Hookless.
 */
export function activateCanvasCard(flowNode: CodeMapAnyFlowNode, expandCluster: (cluster: Cluster) => void): void {
  if (flowNode.type === 'codeMapCluster') {
    expandCluster(flowNode.data.cluster);
  } else if (flowNode.type === 'codeMapFolded') {
    flowNode.data.onActivate(flowNode.data.folded);
  } else if (flowNode.type === 'codeMapRevealRef') {
    // P4-7e: a ref navigates to its target; a stub reveals the next callees.
    flowNode.data.onActivate(flowNode.data.ref);
  } else if (flowNode.type === 'codeMapRevealStub') {
    flowNode.data.onActivate(flowNode.data.stub);
  } else {
    flowNode.data.onActivate(flowNode.data.node);
  }
}

/** P4-2 phase 3c: "changed contract CodeMapNode" / "changed contracts A and B" (names only). */
export function formatContractNames(names: readonly string[]): string {
  const shown = names.slice(0, 2);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(' and ');
  return `contract${names.length === 1 ? '' : 's'} ${list}`;
}

/** P4-2 phase 3c: a dependent card's accessible-name suffix — ", affected by changed contract X" — or `''`. */
export function contractDependentAriaSuffix(names: readonly string[] | undefined): string {
  return names === undefined || names.length === 0 ? '' : `, affected by changed ${formatContractNames(names)}`;
}

/** P4-2 phase 3c: the id of the toggle's hint, which the checkbox names in `aria-describedby`. */
export const SHOW_FOLDED_KINDS_HINT_ID = 'code-map-show-folded-kinds-hint';

/** P4-2 phase 3c: the "Show types & modules" toggle's hint — the toggle only draws; no number moves. */
export const SHOW_FOLDED_KINDS_HINT =
  'Draws folded Types, Interfaces and Modules on the canvas only. Blast radius, severity and Health Audit always use the folded map, so no risk number changes.';

/**
 * P4-2 phase 3c: a "latest request wins" guard: `begin()` supersedes every
 * earlier request; `isLatest(id)` says whether a reply may still apply.
 * Pure (no React), so it's testable.
 */
export function createLatestRequestGuard(): { begin(): number; isLatest(id: number): boolean } {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isLatest: (id) => id === latest,
  };
}

/**
 * P4-2 phase 3c: reads one project's "Show types & modules" value. `false`
 * with no project; `null` — keep what's shown — when the read fails or
 * resolves with a non-boolean. Never rejects. Hookless.
 */
export async function loadShowFoldedKinds(
  projectPath: string | null,
  get: (projectPath: string) => Promise<boolean>,
): Promise<boolean | null> {
  if (projectPath === null) {
    return false;
  }
  try {
    const show: unknown = await get(projectPath);
    return typeof show === 'boolean' ? show : null;
  } catch (error) {
    console.warn('CodeMap: could not read the "Show types & modules" setting.', error);
    return null;
  }
}

/**
 * P4-2 phase 3c: stores one project's "Show types & modules" value and
 * resolves with the value main says is now in effect (`null` when the call
 * fails or replies with a non-boolean). Never rejects. Hookless.
 */
export async function saveShowFoldedKinds(
  projectPath: string,
  show: boolean,
  set: (projectPath: string, show: boolean) => Promise<boolean>,
): Promise<boolean | null> {
  try {
    const stored: unknown = await set(projectPath, show);
    return typeof stored === 'boolean' ? stored : null;
  } catch (error) {
    console.warn('CodeMap: could not remember the "Show types & modules" setting.', error);
    return null;
  }
}

function toFlowEdges(edges: readonly CodeMapEdge[]): FlowEdge[] {
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
 * P4-7e: the faint parent → ref connector of each drawn ref card, labelled
 * "shown above" and styled apart from every real edge kind. It joins a Node
 * to the small card that stands for a callee already shown — never two
 * Nodes, so it is never mistaken for (or counted as) a fabricated edge.
 */
export function revealRefConnectorEdges(auxCards: readonly RevealAuxCard[]): FlowEdge[] {
  return auxCards
    .filter((card): card is Extract<RevealAuxCard, { kind: 'ref' }> => card.kind === 'ref')
    .map((card) => ({
      id: `${REVEAL_CONNECTOR_ID_PREFIX}${card.id}`,
      source: card.parentId,
      target: card.id,
      label: 'shown above',
      className: 'code-map__edge code-map__edge--reveal-ref',
      // Review round 1: decoration, not an edge to follow.
      selectable: false,
      focusable: false,
    }));
}

/** P4-7e: every ref connector's id starts with this; no real edge's does (`toFlowEdges` ids start with a Node id). */
const REVEAL_CONNECTOR_ID_PREFIX = 'reveal-connector:';

/** P4-7e review round 1: whether a canvas edge is a ref connector — `handleEdgeClick` ignores those. */
export function isRevealConnectorEdgeId(id: string): boolean {
  return id.startsWith(REVEAL_CONNECTOR_ID_PREFIX);
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
export function changedMemberCount(
  memberIds: readonly string[],
  changedNodeIds: { readonly size: number; has(id: string): boolean },
): number {
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
    return `${label}: ${formatCount(signal.value, 'Node', 'Nodes')} within ${hops} hop${hops === 1 ? '' : 's'} (callers and callees)${severe}`;
  }
  return `${label}: ${formatCountNumber(signal.value)}${severe}`;
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
                {formatCountNumber(signal.value)}
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
/**
 * P4-7d: a candidate card's badge and reason line — "◎ candidate · no callers
 * in indexed code · reaches N Nodes", plus "· run at load by `file`" when the
 * candidate is run by a file's top-level code. Hookless.
 */
export function CandidateReasonLine({ candidate }: { candidate: EntryCandidate }) {
  const loadedBy = candidateLoadedBy(candidate);
  // P4-7g: a pinned candidate says "⚑ pinned by you" instead of the
  // heuristic reason (glyph plus text, never colour alone); its reach stays.
  const pinned = isPinnedCandidate(candidate);
  return (
    <p className={`code-map__node-candidate${pinned ? ' code-map__node-candidate--pinned' : ''}`}>
      <span className="code-map__node-candidate-badge">
        {pinned ? (
          <>
            <span aria-hidden="true">⚑</span> {PINNED_BADGE_TEXT}
          </>
        ) : (
          <>
            <span aria-hidden="true">◎</span> candidate
          </>
        )}
      </span>{' '}
      <span className="code-map__node-candidate-reason">
        · {formatCandidateReason(candidate)}
        {loadedBy !== null && (
          <>
            {' '}
            · run at load by{' '}
            {loadedBy.files.map((file, index) => (
              <Fragment key={file}>
                {index > 0 && ', '}
                <code>{file}</code>
              </Fragment>
            ))}
            {loadedBy.more > 0 && ` and ${loadedBy.more} more`}
          </>
        )}
      </span>
    </p>
  );
}

/** P4-7d: the listing error for a dev-fixture session, which has no Graph Service map. */
const DEV_FIXTURE_NO_ENTRY_CANDIDATES = 'the dev fixture has no indexed map to list them from.';

/** P4-7d: a navigation to a hidden Node, replayed once the switch to Full has laid the full map out. */
type PendingFullNavigation =
  | { kind: 'navigate'; id: string }
  | { kind: 'history'; id: string; index: number }
  | { kind: 'fit'; ids: readonly string[] };

/**
 * P4-7d: the canvas Panel's "Revealed / Full map" control — two buttons in a
 * group, the active one `aria-pressed`. Code Map mode only (the caller
 * gates it). Hookless.
 */
export function RevealViewToggle({
  view,
  onChange,
}: {
  view: RevealViewMode;
  onChange: (view: RevealViewMode) => void;
}) {
  return (
    <div className="code-map__reveal-toggle" role="group" aria-label="Code Map view">
      <button
        type="button"
        className="code-map__reveal-toggle-option"
        aria-pressed={view === 'revealed'}
        onClick={() => onChange('revealed')}
      >
        Revealed
      </button>
      <button
        type="button"
        className="code-map__reveal-toggle-option"
        aria-pressed={view === 'full'}
        onClick={() => onChange('full')}
      >
        Full map
      </button>
    </div>
  );
}

/**
 * P4-7d: the Revealed view's notice for a `none`, `error` or `stale`
 * listing — the shared Actionable Notice with its one action (EXPERIENCE.md),
 * "Show full map", which flips the toggle. A new map fetch lists again, and
 * so does Full → Revealed after an error. `null` for any other state (the
 * loading line is the Panel's).
 * Hookless.
 */
export function RevealListingNotice({
  notice,
  onShowFullMap,
}: {
  notice: RevealNotice;
  onShowFullMap: () => void;
}) {
  if (!isCanvasRevealNotice(notice)) {
    return null;
  }
  // Review round 1: no live-region role — the Panel's one `role="status"`
  // line already announces this sentence (`revealStatusText`).
  return (
    <ActionableNotice
      tone={notice.tone}
      action={
        <button type="button" onClick={onShowFullMap}>
          Show full map
        </button>
      }
    >
      {notice.sentence}
    </ActionableNotice>
  );
}

/**
 * P4-7e: a revealed Node's "▸ Expand callees (N)" / "▾ Collapse" button —
 * a glyph plus text, `aria-expanded`, and an accessible name naming the
 * Node. Stops propagation on mousedown, click and keydown, like the
 * neighbour pills, so it never opens Node detail too. Hookless.
 */
export function RevealDrillButton({
  node,
  drill,
  onDrill,
}: {
  node: CodeMapNode;
  drill: RevealDrillControl;
  onDrill: (node: CodeMapNode, action: RevealDrillControl['kind']) => void;
}) {
  const label =
    drill.kind === 'expand'
      ? `Expand ${drill.count} callee${drill.count === 1 ? '' : 's'} of ${node.name}`
      : `Collapse the callees of ${node.name}`;
  return (
    <button
      type="button"
      className="code-map__node-affordance code-map__node-affordance--drill"
      aria-expanded={drill.kind === 'collapse'}
      aria-label={label}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onDrill(node, drill.kind);
      }}
    >
      {revealDrillButtonText(drill)}
    </button>
  );
}

/**
 * P4-7e: a ref card — "↺ `<name>` shown above" for a callee already revealed
 * elsewhere (a cycle, or fan-in). Render-only; activating it (click, Enter,
 * Space) navigates to the target. Hookless.
 */
export function CodeMapRevealRefCard({ data }: Pick<NodeProps<CodeMapRevealRefFlowNode>, 'data'>) {
  const { ref, onActivate } = data;
  return (
    <div
      className="code-map__reveal-ref"
      title={revealRefText(ref.targetName)}
      tabIndex={0}
      role="button"
      aria-label={`${ref.targetName} is shown above, go to it`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(ref);
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span aria-hidden="true">↺</span> <code>{ref.targetName}</code> shown above
    </div>
  );
}

/**
 * P4-7e: a stub card — "+N more callees"; activating it (click, Enter, Space)
 * reveals the next `REVEAL_LAYER_CAP`. Render-only. Hookless.
 */
export function CodeMapRevealStubCard({ data }: Pick<NodeProps<CodeMapRevealStubFlowNode>, 'data'>) {
  const { stub, onActivate } = data;
  const next = Math.min(stub.hiddenCount, REVEAL_LAYER_CAP);
  return (
    <div
      className="code-map__reveal-stub"
      tabIndex={0}
      role="button"
      aria-label={`${revealStubText(stub.hiddenCount)} of ${stub.parentName}, show the next ${next}`}
      onKeyDown={(event) => {
        // P4-7f: `+` (no Ctrl, Cmd or Alt) expands a stub too.
        if (event.key === 'Enter' || event.key === ' ' || revealDrillKey(event) === 'expand') {
          event.preventDefault();
          onActivate(stub);
        }
      }}
    >
      {revealStubText(stub.hiddenCount)}
    </div>
  );
}

export function CodeMapNodeCard({ data }: Pick<NodeProps<CodeMapFlowNode>, 'data'>) {
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
    affectedByContracts,
    candidate,
    drill,
    onDrill,
    crossSectionNote,
  } = data;
  const summaryStatus = node.summaryStatus;
  return (
    <div
      className={`code-map__node${isChanged ? ' code-map__node--changed' : ''}${
        crossSectionNote !== undefined ? ' code-map__node--cross-section-note' : ''
      }`}
      title={`${node.file}:${node.startLine}-${node.endLine}`}
      tabIndex={0}
      role="button"
      aria-label={`${node.kind} ${node.name}${isChanged ? ', changed' : ''}${contractDependentAriaSuffix(
        affectedByContracts,
      )}${candidateAriaSuffix(candidate)}, open Node detail`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(node);
          return;
        }
        // P4-7f: in Revealed only (`onDrill` is set only there, Code Map
        // mode), `+`/`=` expands and `−`/`-` collapses the focused card —
        // never with Ctrl, Cmd or Alt held, so app and browser zoom are
        // untouched. Enter above keeps opening Node detail.
        const drillKey = onDrill !== undefined ? revealDrillKey(event) : null;
        if (drillKey !== null) {
          event.preventDefault();
          onDrill?.(node, drillKey);
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="code-map__node-kind">{node.kind}</span>
      <code className="code-map__node-id">{node.name}</code>
      {/* P4-7d: an entry candidate (Revealed only) — a glyph plus the text
          "candidate", never colour alone, and its reason, qualified "in
          indexed code". */}
      {candidate !== undefined && <CandidateReasonLine candidate={candidate} />}
      {/* P4-7e (founder decision 2026-10-04, proposed): in a section, the
          drill follows that section's own edges only, so a callee in another
          section is never revealed — this says so, with P4-4g's count. */}
      {crossSectionNote !== undefined && (
        <p className="code-map__node-cross-section-note" title={crossSectionNote}>
          {crossSectionNote}
        </p>
      )}
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
      {/* P4-2 phase 3c: a changed contract's dependent — its own marker, not
          colour alone: the ⧉ glyph plus visible text naming the contract. */}
      {affectedByContracts !== undefined && affectedByContracts.length > 0 && (
        <p className="code-map__node-contract-dependent">
          <span aria-hidden="true">⧉</span> Uses changed {formatContractNames(affectedByContracts)}
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
      {summaryStatus === 'ready' && node.summary !== undefined && (
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
      {summaryStatus === 'ready' && node.summary !== undefined && node.stale === true && (
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
      {summaryStatus === 'pending' && cloudSelectedNoKey && (
        <p className="code-map__node-summary code-map__node-summary--notice" role="status">
          <span aria-hidden="true">☁</span> Cloud is selected but no API key is set — add one in
          Settings.
        </p>
      )}
      {summaryStatus === 'pending' && !cloudSelectedNoKey && noSummaryBackendAvailable && (
        <p className="code-map__node-summary code-map__node-summary--notice" role="status">
          <span aria-hidden="true">⚠</span> No summary backend is available — check Settings.
        </p>
      )}
      {summaryStatus === 'pending' && !cloudSelectedNoKey && !noSummaryBackendAvailable && (
        <p className="code-map__node-summary code-map__node-summary--pending" role="status">
          Summary pending…
        </p>
      )}
      {summaryStatus === 'coverage-gap' && (
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
        {/* P4-7e: Revealed's expand/collapse — the same three
            `stopPropagation` handlers as the pills below, so pressing it
            never also opens Node detail. No button at N = 0. */}
        {drill !== undefined && onDrill !== undefined && (
          <RevealDrillButton node={node} drill={drill} onDrill={onDrill} />
        )}
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
    /** P4-2 phase 3c: members that depend on a changed contract (PR Review). Absent or `0`: no marker. */
    affectedCount?: number;
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
  /**
   * P4-2 phase 3a: changed files whose only change is folded top-level code,
   * for the "Changed: top-level code in …" notice. Non-empty only in PR
   * Review Mode, with a showable map, for a resolved diff scope that has any.
   */
  topLevelFiles: readonly TopLevelChangedFile[];
  /**
   * P4-2 phase 3c: the changed contracts (folded types the diff changed),
   * for the "Contract changed: … → N dependents" lines. Same gating as
   * `topLevelFiles`.
   */
  changedContracts: readonly ChangedContract[];
  /**
   * P4-2 phase 3c: the changed contracts were found without line ranges
   * (`CHANGED_CONTRACTS_APPROXIMATE_NOTE`).
   */
  changedContractsApproximate: boolean;
  /**
   * P4-4 phase 3b: what the resolved diff changed in other sections of the
   * same repository, for the "changed elsewhere" line. Same gating as
   * `topLevelFiles`, and only for a section map — never in `all`.
   */
  changedInOtherSections: readonly SectionChangeCount[];
  /**
   * P4-3a: the changed-Node metrics table below the canvas, or `null` for
   * none. Non-null only in PR Review Mode, with a showable map, for a
   * resolved diff scope with at least one row — never an empty table.
   * P4-3c: with the blast radius's affected rows at the stepper's depth.
   * P4-3g: the gate is "at least one row OR at least one changed contract",
   * so a contract-only diff shows its contract rows, never an empty table.
   */
  metricsTable: PrReviewMetricsTableProps | null;
  /** Which surfaces are on — see `CodeMapSurfaces`. */
  surfaces: CodeMapSurfaces;
}

const NO_TOP_LEVEL_FILES: readonly TopLevelChangedFile[] = [];
const NO_SECTION_CHANGES: readonly SectionChangeCount[] = [];
const NO_CHANGED_CONTRACTS: readonly ChangedContract[] = [];

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
 *
 * P4-3c: `blastRadiusState` and `blastRadiusDepth` add the affected rows —
 * `hopDistances` sliced at the stepper's depth, locally, never a new IPC
 * call. A loading blast radius keeps the changed rows and says so in the
 * table's caption; an error, or nothing reachable, keeps the changed rows
 * only. Both survive a mode switch, as `diffScopeState` does.
 */
export function resolvePrReviewView(
  mode: CodeMapMode,
  fetchState: FetchState,
  diffScopeState: DiffScopeState,
  blastRadiusState: BlastRadiusState,
  blastRadiusDepth: number,
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
  const resolved = mode === 'prReview' && showable && diffScopeState.status === 'resolved' ? diffScopeState : null;
  const metricRows =
    resolved !== null && fetchState.status === 'ready'
      ? buildPrReviewMetricRows(
          fetchState.nodes,
          resolved.nodeIds,
          blastRadiusState.status === 'resolved' ? blastRadiusState.hopDistances : null,
          blastRadiusDepth,
        )
      : null;
  const changedContracts = resolved?.changedContracts ?? NO_CHANGED_CONTRACTS;
  const changedContractsApproximate = resolved?.changedContractsApproximate === true;
  const inSection = fetchState.status === 'ready' && (fetchState.section ?? null) !== null;
  return {
    noticeStatus,
    topLevelFiles: resolved?.topLevelFiles ?? NO_TOP_LEVEL_FILES,
    changedContracts,
    changedContractsApproximate,
    changedInOtherSections: (inSection ? resolved?.changedInOtherSections : undefined) ?? NO_SECTION_CHANGES,
    // P4-3g: the contracts come from the same resolved scope only — a
    // non-resolved state's leftover data never opens the table.
    metricsTable:
      metricRows !== null && (metricRows.rows.length > 0 || changedContracts.length > 0)
        ? { ...metricRows, blastRadiusStatus: blastRadiusState.status, changedContracts, changedContractsApproximate }
        : null,
    surfaces: resolveCodeMapSurfaces(mode, showable),
  };
}

/**
 * P4-3a: one changed Node's row in the PR Review metrics table. Every value
 * is read straight from the Node's own `riskSignals`; `null` means the Node
 * carries no such signal and renders `—`, never a zero. P4-3f: the tests
 * cell says "covered" only when LCOV lists the Node's file, its function
 * records prove a test entered it, and there is no gap (`metricTestsState`).
 */
export interface PrReviewMetricRow {
  id: string;
  /**
   * P4-3e: the Node itself — the row's activation hands THIS object to
   * `onActivateNode`, never a name or id the callee would resolve, so two
   * same-named rows each open their own Node (the Health Audit row pact).
   */
  node: CodeMapNode;
  /** The bare identifier, verbatim from source. */
  name: string;
  file: string;
  startLine: number;
  /** `nodeModuleLine(file)` — `null` for a file at the project root. */
  moduleLine: string | null;
  /** The index coverage gap (FR-2, `summaryStatus === 'coverage-gap'`), not test coverage. */
  coverageGap: boolean;
  /** `'changed'` for a changed Node; for an affected one (P4-3c), its hop distance from the change. */
  hop: 'changed' | number;
  complexity: DeterministicRiskSignal | null;
  blastRadius: DeterministicRiskSignal | null;
  /** A `test-coverage-gap` signal exists. `false` is "no gap signal", not "covered". */
  testCoverageGap: boolean;
  /**
   * P4-3f: `node.testCoverageAvailable === true` — LCOV line data exists for
   * the Node's file. Only with this and no gap does the tests cell say
   * `covered` (`metricTestsState`).
   */
  testCoverageAvailable: boolean;
  /**
   * P4-3f review round 1: `node.testCoverageHit === true` — LCOV's function
   * records prove a test entered this Node. `covered` needs this too: line
   * data alone can't tell a called function from a merely loaded one.
   */
  testCoverageHit: boolean;
  /** The ingested findings' count, highest severity and that finding's tool; `null` for none. */
  findings: PrReviewMetricFindings | null;
}

export interface PrReviewMetricFindings {
  count: number;
  highestSeverity: IngestedRiskSignal['severity'];
  sourceTool: string;
}

/** P4-3a: `buildPrReviewMetricRows`' result. */
export interface PrReviewMetricRows {
  /** The changed rows, then (P4-3c) at most `METRICS_TABLE_AFFECTED_ROW_CAP` affected rows. */
  rows: PrReviewMetricRow[];
  /** Changed ids that resolve to no Node on the current map — counted, never dropped silently. */
  missingChangedCount: number;
  /** P4-3c: affected rows past the cap — the "+N more affected Nodes" line. On-map Nodes only. */
  hiddenAffectedCount: number;
  /**
   * P4-3c review: ids in the blast-radius slice that are neither changed nor
   * on the current map — no rows, but counted, so every id in the slice is
   * accounted for: affected rows + `hiddenAffectedCount` + this + the slice's
   * changed ids = the slice (`nodesWithinDepth`), the toolbar's count.
   */
  missingAffectedCount: number;
}

/** P4-3c: `PrReviewMetricsTable`'s props — the rows, and the blast radius's status (for the caption). */
export interface PrReviewMetricsTableProps extends PrReviewMetricRows {
  blastRadiusStatus: BlastRadiusState['status'];
  /**
   * P4-3g: the resolved scope's `changedContracts`, as P4-2e found them —
   * one pinned summary row each, never capped, never sorted with the Node
   * rows. Nothing is recomputed: the row shows `dependentCount` as-is.
   */
  changedContracts: readonly ChangedContract[];
  /** P4-3g: the scope's `changedContractsApproximate` — the contract group then leads with the inert note. */
  changedContractsApproximate: boolean;
}

/**
 * P4-3c: how many affected rows the table lists (Decision 2, 2026-09-30) —
 * the nearest and widest-reaching, after ordering. Changed rows are never
 * capped. A 2-hop radius can pass 1,000 Nodes; this protects AD-14's budget.
 */
export const METRICS_TABLE_AFFECTED_ROW_CAP = 50;

/**
 * P4-3c: the blast radius at the stepper's depth — every id whose hop
 * distance is at most `depth`. The one slice both the canvas highlight
 * (`blastRadiusNodeIds`) and the table's affected rows read, so they can't
 * disagree.
 */
export function nodesWithinDepth(hopDistances: ReadonlyMap<string, number>, depth: number): Set<string> {
  const ids = new Set<string>();
  for (const [nodeId, distance] of hopDistances) {
    if (distance <= depth) {
      ids.add(nodeId);
    }
  }
  return ids;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * P4-3a: the resolved diff scope as one row per changed Node that is on the
 * current map, in a fixed order (file, then `startLine`, then id). Values
 * come from the same `selectDeterministicSignals`/`selectIngestedSignals`
 * the canvas card uses, so the table and the card can't disagree; the
 * highest-severity finding is `selectIngestedSignals`' first (it sorts by
 * `INGESTED_SEVERITY_RANK`). Changed ids with no Node on this map (a scope
 * filter, or a refresh since the diff) are counted in `missingChangedCount`.
 *
 * P4-3c: then one affected row per on-map Node in `nodesWithinDepth(
 * hopDistances, depth)` — hop ascending, then blast-radius value descending,
 * then id — capped at `METRICS_TABLE_AFFECTED_ROW_CAP` after that ordering,
 * the rest counted in `hiddenAffectedCount`. A changed id is never also an
 * affected row, even if `hopDistances` (seeds excluded by contract) lists
 * it. Affected ids not on this map are not rows; they are counted in
 * `missingAffectedCount`, never in `hiddenAffectedCount`.
 */
export function buildPrReviewMetricRows(
  nodes: readonly CodeMapNode[],
  changedIds: ReadonlySet<string>,
  hopDistances: ReadonlyMap<string, number> | null,
  depth: number,
): PrReviewMetricRows {
  const rows: PrReviewMetricRow[] = [];
  // P4-3c review: affected Nodes are sorted as light tuples; full rows are
  // built only for the ones the cap keeps (a 2-hop radius can pass 1,000).
  const affected: { node: CodeMapNode; hop: number; blast: number }[] = [];
  const within = hopDistances === null ? EMPTY_ID_SET : nodesWithinDepth(hopDistances, depth);
  const found = new Set<string>();
  for (const node of nodes) {
    if (found.has(node.id)) {
      continue;
    }
    if (changedIds.has(node.id)) {
      found.add(node.id);
      rows.push(prReviewMetricRow(node, 'changed'));
      continue;
    }
    const distance = hopDistances?.get(node.id);
    if (distance !== undefined && within.has(node.id)) {
      found.add(node.id);
      affected.push({ node, hop: distance, blast: blastRadiusSortValue(node) });
    }
  }
  rows.sort(defaultPrReviewMetricSort);
  // `defaultPrReviewMetricSort`'s own comparator, on the light tuples.
  affected.sort((a, b) => compareDefaultOrder(a.hop, a.blast, a.node.id, b.hop, b.blast, b.node.id));
  let missingChangedCount = 0;
  for (const id of changedIds) {
    if (!found.has(id)) {
      missingChangedCount += 1;
    }
  }
  let missingAffectedCount = 0;
  for (const id of within) {
    if (!found.has(id) && !changedIds.has(id)) {
      missingAffectedCount += 1;
    }
  }
  const shown = affected.slice(0, METRICS_TABLE_AFFECTED_ROW_CAP);
  return {
    rows: [...rows, ...shown.map((entry) => prReviewMetricRow(entry.node, entry.hop))],
    missingChangedCount,
    hiddenAffectedCount: affected.length - shown.length,
    missingAffectedCount,
  };
}

/**
 * P4-3c review: an affected Node's blast-radius value for ordering — the
 * same first `blast-radius` signal `selectDeterministicSignals` keeps for
 * the row, or -1 for none (after every present value).
 */
function blastRadiusSortValue(node: CodeMapNode): number {
  for (const signal of node.riskSignals) {
    if (signal.family === 'deterministic' && signal.type === 'blast-radius') {
      return signal.value;
    }
  }
  return -1;
}

function prReviewMetricRow(node: CodeMapNode, hop: PrReviewMetricRow['hop']): PrReviewMetricRow {
  const deterministic = selectDeterministicSignals(node.riskSignals);
  const ofType = (type: DeterministicRiskSignalType) => deterministic.find((signal) => signal.type === type) ?? null;
  const ingested = selectIngestedSignals(node.riskSignals);
  const highest = ingested[0];
  return {
    id: node.id,
    node,
    name: node.name,
    file: node.file,
    startLine: node.startLine,
    moduleLine: nodeModuleLine(node.file),
    coverageGap: node.summaryStatus === 'coverage-gap',
    hop,
    complexity: ofType('complexity'),
    blastRadius: ofType('blast-radius'),
    testCoverageGap: ofType('test-coverage-gap') !== null,
    testCoverageAvailable: node.testCoverageAvailable === true,
    testCoverageHit: node.testCoverageHit === true,
    findings:
      highest === undefined
        ? null
        : { count: ingested.length, highestSeverity: highest.severity, sourceTool: highest.sourceTool },
  };
}

/** P4-3a: the table's empty-cell text. Never "covered", never `0`. */
export const METRIC_CELL_EMPTY = '—';

/**
 * P4-3a: one numeric metric cell — the visible value (`—` for an absent
 * signal) and, for a present one, the accessible name ("42 (severe)", the
 * header names the metric) and the full `formatDeterministicSignalLabel`
 * wording as its tooltip.
 */
export function formatMetricSignalCell(signal: DeterministicRiskSignal | null): {
  text: string;
  label: string | null;
  /** The full signal wording (`formatDeterministicSignalLabel`), for the mouse's tooltip. */
  title: string | null;
  severe: boolean;
} {
  if (signal === null) {
    return { text: METRIC_CELL_EMPTY, label: null, title: null, severe: false };
  }
  return {
    text: formatCountNumber(signal.value),
    label: metricCellAccessibleName(signal),
    title: formatDeterministicSignalLabel(signal),
    severe: signal.severity === 'severe',
  };
}

/**
 * P4-3f: the tests cell's state, in precedence order: `gap` when the
 * `test-coverage-gap` signal exists; else `covered` only when LCOV lists the
 * Node's file (`testCoverageAvailable`) AND (review round 1) its function
 * records prove a test entered the Node (`testCoverageHit`); else
 * `unproven` (`—`: the file has LCOV data, but nothing proves this Node ran)
 * or `none` (`—`: no LCOV data for this file). `covered` never without both.
 */
export type PrReviewMetricTestsState = 'gap' | 'covered' | 'unproven' | 'none';

export function metricTestsState(
  row: Pick<PrReviewMetricRow, 'testCoverageGap' | 'testCoverageAvailable' | 'testCoverageHit'>,
): PrReviewMetricTestsState {
  if (row.testCoverageGap) {
    return 'gap';
  }
  if (!row.testCoverageAvailable) {
    return 'none';
  }
  return row.testCoverageHit ? 'covered' : 'unproven';
}

/** P4-3f: the `covered` cell's accessible name — literally what is proven; never a percentage. */
export const METRIC_TESTS_COVERED_LABEL = 'Test coverage: function entered at least once by tests (LCOV)';
/** P4-3f: the `—` tests cell's tooltip when LCOV doesn't list the file. */
export const METRIC_TESTS_NO_DATA_TITLE = 'No LCOV data for this file';
/** P4-3f review round 1: the `—` tests cell's tooltip when the file is listed but nothing proves this Node ran. */
export const METRIC_TESTS_UNPROVEN_TITLE = 'No function-level coverage proof for this Node (LCOV)';

/**
 * P4-3f: the tests cell — its visible text, the accessible name (`covered`
 * only; `gap` and `—` are named by their text) and the tooltip.
 */
export function formatMetricTestsCell(state: PrReviewMetricTestsState): {
  text: string;
  label: string | null;
  title: string | null;
  empty: boolean;
} {
  switch (state) {
    case 'gap':
      return { text: 'gap', label: null, title: null, empty: false };
    case 'covered':
      return { text: 'covered', label: METRIC_TESTS_COVERED_LABEL, title: METRIC_TESTS_COVERED_LABEL, empty: false };
    case 'unproven':
      return { text: METRIC_CELL_EMPTY, label: null, title: METRIC_TESTS_UNPROVEN_TITLE, empty: true };
    case 'none':
      return { text: METRIC_CELL_EMPTY, label: null, title: METRIC_TESTS_NO_DATA_TITLE, empty: true };
  }
}

/** P4-3f: the tests column's sort rank — `gap` < `—` (either kind) < `covered`, so ascending leads with gaps. */
const METRIC_TESTS_SORT_RANK: Record<PrReviewMetricTestsState, number> = { gap: 0, unproven: 1, none: 1, covered: 2 };

/** P4-3a: the findings cell — "3 · blocker · CodeRabbit", or `—` for none. */
export function formatMetricFindingsCell(findings: PrReviewMetricFindings | null): string {
  if (findings === null) {
    return METRIC_CELL_EMPTY;
  }
  return `${formatCountNumber(findings.count)} · ${findings.highestSeverity} · ${findings.sourceTool}`;
}

/**
 * P4-3c: the inert cap line — "+250 more affected Nodes — reduce depth", or
 * `null` when nothing is past the cap.
 */
export function formatHiddenAffectedNodes(count: number): string | null {
  return count > 0 ? `+${formatCount(count, 'more affected Node', 'more affected Nodes')} — reduce depth` : null;
}

/** P4-3c review: the inert line for affected ids not on this map, or `null` for none. */
export function formatMissingAffectedNodes(count: number): string | null {
  return count > 0 ? `${formatCount(count, 'affected Node', 'affected Nodes')} not on the current map` : null;
}

/**
 * P4-3c review: the table's caption. While the blast radius computes it
 * shows and says so, in the toolbar's wording; otherwise it is visually
 * hidden and names affected Nodes only when the table accounts for any.
 */
export function prReviewMetricsCaption(
  table: PrReviewMetricRows,
  blastRadiusStatus: BlastRadiusState['status'],
  contractCount = 0,
): { text: string; visible: boolean } {
  // P4-3g: a table with contract rows says so; a contract-only table (no
  // Node rows, nothing counted off the map) names the contracts alone.
  const contracts = contractCount > 0 ? ' and changed contracts' : '';
  if (blastRadiusStatus === 'loading') {
    return { text: `Changed Nodes' risk metrics${contracts}. Computing blast radius…`, visible: true };
  }
  const anyAffected =
    table.rows.some((row) => row.hop !== 'changed') || table.hiddenAffectedCount > 0 || table.missingAffectedCount > 0;
  if (contractCount > 0 && table.rows.length === 0 && !anyAffected && table.missingChangedCount === 0) {
    return { text: 'Changed contracts', visible: false };
  }
  return {
    text: `${anyAffected ? "Changed and affected Nodes' risk metrics" : "Changed Nodes' risk metrics"}${contracts}`,
    visible: false,
  };
}

/** P4-3a: the inert line for changed ids not on this map, or `null` for none. */
export function formatMissingChangedNodes(count: number): string | null {
  return count > 0 ? `${formatCount(count, 'changed Node', 'changed Nodes')} not on the current map` : null;
}

/**
 * P4-3a: the blast-radius column's header. The per-Node signal counts Nodes
 * within `BLAST_RADIUS_DEFAULT_HOPS`, not the stepper's depth, so the header
 * names that fixed bound.
 */
export function prReviewBlastRadiusHeader(): string {
  const hops: number = BLAST_RADIUS_DEFAULT_HOPS;
  return `blast radius (${hops} hop${hops === 1 ? '' : 's'})`;
}

/**
 * P4-3a: the canvas's height — `.code-map` minus the metrics table's band
 * (`--code-map-table-height`, 0 without the table), so nothing floats over
 * the table and the canvas resizes when the table appears or goes.
 */
export const CODE_MAP_CANVAS_HEIGHT = 'calc(100% - var(--code-map-table-height))';

/**
 * P4-3a review: the element that both HAS the canvas's size and is MEASURED
 * for it — `canvasRef` goes on the same div whose height is
 * `CODE_MAP_CANVAS_HEIGHT`, so the ResizeObserver behind route fits, the
 * initial fit, LOD bounds and zoom-to-reveal reads the canvas, never
 * `.code-map` (taller by the table). Hookless, so a test pins the pairing.
 */
export function CodeMapCanvasFrame({
  canvasRef,
  children,
}: {
  canvasRef: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return (
    // Review round 1: `tabIndex={-1}` — the fallback focus target after a
    // cross-section switch whose card never renders (`cardFocusStep`).
    <div className="code-map__canvas" ref={canvasRef} style={{ height: CODE_MAP_CANVAS_HEIGHT }} tabIndex={-1}>
      {children}
    </div>
  );
}

/**
 * P4-3a review: the metrics table's mount condition — the rows when
 * `resolvePrReviewView` produced a table AND the canvas it sits under is
 * mounted, else `null`.
 */
export function prReviewMetricsTableFor(
  view: Pick<PrReviewView, 'metricsTable' | 'surfaces'>,
): PrReviewMetricsTableProps | null {
  return view.surfaces.canvas ? view.metricsTable : null;
}

/**
 * P4-3a review: a metric cell's accessible name — the value and "(severe)",
 * without the metric's name, which the column header already gives.
 */
export function metricCellAccessibleName(signal: DeterministicRiskSignal): string {
  return `${formatCountNumber(signal.value)}${signal.severity === 'severe' ? ' (severe)' : ''}`;
}

/**
 * P4-3d: the table's sortable columns, in header order. `label` is the
 * column's name in the header and in the sort announcement; `firstDirection`
 * is where a click on an inactive column starts (numeric columns descending,
 * node and hop ascending); `bar` marks the two columns that draw a relative
 * bar (Decision 3 — no others without asking first).
 */
export type PrReviewMetricSortColumn = 'node' | 'hop' | 'complexity' | 'blastRadius' | 'tests' | 'findings';
export type PrReviewMetricSortDirection = 'ascending' | 'descending';
/** P4-3d: a user sort. `null` in its place is the default order (no column active). */
export interface PrReviewMetricSort {
  column: PrReviewMetricSortColumn;
  direction: PrReviewMetricSortDirection;
}

export const PR_REVIEW_METRIC_COLUMNS: readonly {
  column: PrReviewMetricSortColumn;
  label: string;
  firstDirection: PrReviewMetricSortDirection;
  bar: boolean;
}[] = [
  { column: 'node', label: 'node', firstDirection: 'ascending', bar: false },
  { column: 'hop', label: 'hop', firstDirection: 'ascending', bar: false },
  { column: 'complexity', label: 'complexity', firstDirection: 'descending', bar: true },
  { column: 'blastRadius', label: 'blast radius', firstDirection: 'descending', bar: true },
  // P4-3f: ascending first, so a first click still leads with `gap` (the
  // order is `gap` < `—` < `covered`), as it did when `gap` was the only value.
  { column: 'tests', label: 'tests', firstDirection: 'ascending', bar: false },
  { column: 'findings', label: 'findings', firstDirection: 'descending', bar: false },
];

/**
 * P4-3d: the default order's one comparator — changed first (hop `changed`
 * ranks -1), then hop ascending, then blast-radius value descending (absent
 * is -1, so last), then id. Shared by `defaultPrReviewMetricSort` and the
 * builder's affected tuples, so the cap follows exactly this order.
 */
function compareDefaultOrder(
  hopA: PrReviewMetricRow['hop'],
  blastA: number,
  idA: string,
  hopB: PrReviewMetricRow['hop'],
  blastB: number,
  idB: string,
): number {
  const rank = (hop: PrReviewMetricRow['hop']) => (hop === 'changed' ? -1 : hop);
  return rank(hopA) - rank(hopB) || blastB - blastA || compareStrings(idA, idB);
}

/**
 * P4-3d: the default order — changed rows first, then hop ascending, then
 * blast-radius value descending (none last), then id; changed rows among
 * themselves by blast radius, then id (review round 1: the frozen
 * comparator, replacing P4-3a's file/line order). `buildPrReviewMetricRows`
 * emits rows in this order and applies the affected cap to it, so a scope's
 * rows are already in it; `sortPrReviewMetricRows(rows, null)` restores it.
 */
export function defaultPrReviewMetricSort(a: PrReviewMetricRow, b: PrReviewMetricRow): number {
  return compareDefaultOrder(a.hop, a.blastRadius?.value ?? -1, a.id, b.hop, b.blastRadius?.value ?? -1, b.id);
}

type MetricSortKey = readonly (string | number)[];

/**
 * P4-3d: a row's key for a column, or `null` for a missing value (`—`),
 * which sorts last in both directions. Hop: `changed` is 0, before 1, 2, ….
 * Tests (P4-3f): never missing — `gap` < `—` < `covered`
 * (`METRIC_TESTS_SORT_RANK`); here `—` is a value ("no LCOV data for this
 * file"), not an absent one, so it sits between the two and flips with the
 * direction like them.
 * Findings: count, then severity (`INGESTED_SEVERITY_RANK`, negated so a
 * descending sort puts `blocker` first).
 */
function metricSortKey(row: PrReviewMetricRow, column: PrReviewMetricSortColumn): MetricSortKey | null {
  switch (column) {
    case 'node':
      return [row.name, row.file];
    case 'hop':
      return [row.hop === 'changed' ? 0 : row.hop];
    case 'complexity':
      return row.complexity === null ? null : [row.complexity.value];
    case 'blastRadius':
      return row.blastRadius === null ? null : [row.blastRadius.value];
    case 'tests':
      return [METRIC_TESTS_SORT_RANK[metricTestsState(row)]];
    case 'findings':
      return row.findings === null ? null : [row.findings.count, -INGESTED_SEVERITY_RANK[row.findings.highestSeverity]];
  }
}

/**
 * P4-3d review: the node column's collation — case-insensitive
 * (`sensitivity: 'base'`), with the code-unit order as the deterministic
 * fallback when two names collate equal ("Alpha"/"alpha").
 */
function collateMetricText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || compareStrings(a, b);
}

function compareMetricSortKeys(a: MetricSortKey, b: MetricSortKey): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : collateMetricText(String(x), String(y));
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/**
 * P4-3d: the rows in `sort`'s order — or the default order for `null`. A
 * missing value sorts last in both directions, and ties break on id
 * ascending in both, so the order is deterministic and stable across
 * re-sorts. Every row moves, changed ones too (their hop cell and rule stay
 * on the row). It sorts only the rows it is given: the affected cap was
 * applied to the default order before, so a sort never pulls a hidden row in.
 */
export function sortPrReviewMetricRows(
  rows: readonly PrReviewMetricRow[],
  sort: PrReviewMetricSort | null,
): PrReviewMetricRow[] {
  if (sort === null) {
    return [...rows].sort(defaultPrReviewMetricSort);
  }
  const sign = sort.direction === 'ascending' ? 1 : -1;
  return rows
    .map((row) => ({ row, key: metricSortKey(row, sort.column) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        if (a.key !== b.key) {
          return a.key === null ? 1 : -1;
        }
      } else {
        const order = compareMetricSortKeys(a.key, b.key) * sign;
        if (order !== 0) {
          return order;
        }
      }
      return compareStrings(a.row.id, b.row.id);
    })
    .map((entry) => entry.row);
}

/**
 * P4-3d: the sort after activating `column`'s header — the active column
 * flips direction; any other column starts at its `firstDirection`.
 */
export function nextPrReviewMetricSort(
  current: PrReviewMetricSort | null,
  column: PrReviewMetricSortColumn,
): PrReviewMetricSort {
  if (current !== null && current.column === column) {
    return { column, direction: current.direction === 'ascending' ? 'descending' : 'ascending' };
  }
  const first = PR_REVIEW_METRIC_COLUMNS.find((entry) => entry.column === column)?.firstDirection ?? 'ascending';
  return { column, direction: first };
}

/** P4-3d: the live region's text — "Sorted by blast radius, descending." — or empty for the default order. */
export function formatMetricSortAnnouncement(sort: PrReviewMetricSort | null): string {
  if (sort === null) {
    return '';
  }
  const label = PR_REVIEW_METRIC_COLUMNS.find((entry) => entry.column === sort.column)?.label ?? sort.column;
  return `Sorted by ${label}, ${sort.direction}.`;
}

/**
 * P4-3d: each bar column's max over the rows it is given — the rows the
 * table renders, so rows past the affected cap never count. 0 when no row
 * has the signal (or every value is 0): that column draws no bar.
 */
export function metricBarWidths(rows: readonly PrReviewMetricRow[]): { complexity: number; blastRadius: number } {
  let complexity = 0;
  let blastRadius = 0;
  for (const row of rows) {
    complexity = Math.max(complexity, row.complexity?.value ?? 0);
    blastRadius = Math.max(blastRadius, row.blastRadius?.value ?? 0);
  }
  return { complexity, blastRadius };
}

/**
 * P4-3d: a cell's bar — its width as a share of the column max, and its
 * fill from the signal's own `severity` only (never its value): neutral for
 * `moderate`, `--risk-red` for `severe`. `null` (no bar) for an absent
 * signal or a column max of 0.
 */
export function metricBar(
  signal: DeterministicRiskSignal | null,
  columnMax: number,
): { width: string; severe: boolean } | null {
  if (signal === null || !(columnMax > 0)) {
    return null;
  }
  const share = Math.min(Math.max(signal.value, 0), columnMax) / columnMax;
  return { width: `${Number((share * 100).toFixed(2))}%`, severe: signal.severity === 'severe' };
}

/**
 * P4-3d review: the note above the rows when a user sort is active on a
 * capped table — the sort covers only the rows shown, never the Nodes past
 * the cap. `null` in the default order or with nothing past the cap.
 */
export function formatSortedWithinCapNote(
  sort: PrReviewMetricSort | null,
  shownRows: number,
  hiddenAffected: number,
): string | null {
  if (sort === null || hiddenAffected <= 0) {
    return null;
  }
  const hidden =
    hiddenAffected === 1
      ? '1 more affected Node is'
      : `${formatCount(hiddenAffected, 'more affected Node', 'more affected Nodes')} are`;
  return `Sorted within the ${formatCount(shownRows, 'row', 'rows')} shown — ${hidden} past the cap; reduce depth to include them.`;
}

/** P4-3d: the bar columns' header note, visually hidden and as the header's `title`. */
export const METRIC_BAR_HEADER_NOTE = "(bar: relative to this table's max)";

/**
 * P4-3b: the metrics table's smallest height — its sticky header plus two
 * rows (11px text, 0.3–0.35rem vertical padding each).
 */
export const METRICS_TABLE_MIN_HEIGHT = 96;
/** P4-3b: the table's default height, as a share of the map height, before any resize. */
export const METRICS_TABLE_DEFAULT_HEIGHT = 0.35;
/** P4-3b: the table's largest share of the map height; the canvas keeps the rest (FR-11). */
export const METRICS_TABLE_MAX_SHARE = 0.6;
/** P4-3b: ArrowUp/ArrowDown's step, in px. */
export const METRICS_TABLE_KEY_STEP = 24;
/** P4-3b: PageUp/PageDown's step, as a share of the map height. */
export const METRICS_TABLE_PAGE_SHARE = 0.25;

/**
 * P4-3b: the table height's range for a map (`.code-map`) of `mapHeight`
 * px — `METRICS_TABLE_MIN_HEIGHT` to 60% of the map. On a map too short for
 * both, the max is the min; the min itself never passes the map, so the
 * canvas's share is never negative.
 */
export function metricsTableHeightBounds(mapHeight: number): { min: number; max: number } {
  const map = Number.isFinite(mapHeight) ? Math.max(0, mapHeight) : 0;
  const min = Math.min(METRICS_TABLE_MIN_HEIGHT, map);
  return { min, max: Math.max(min, Math.floor(map * METRICS_TABLE_MAX_SHARE)) };
}

/** P4-3b: `requested` held within `metricsTableHeightBounds(mapHeight)`, in whole px. */
export function clampMetricsTableHeight(requested: number, mapHeight: number): number {
  const { min, max } = metricsTableHeightBounds(mapHeight);
  if (!Number.isFinite(requested)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(requested)));
}

/**
 * P4-3b: the height to show — the user's last height (`null` before any
 * resize: `METRICS_TABLE_DEFAULT_HEIGHT` of the map), re-clamped against
 * the current map, so a window resize re-clamps it on the next render.
 */
export function metricsTableHeightFor(requested: number | null, mapHeight: number): number {
  return clampMetricsTableHeight(requested ?? mapHeight * METRICS_TABLE_DEFAULT_HEIGHT, mapHeight);
}

/**
 * P4-3b: the divider's keyboard steps — the next height for `key`, or `null`
 * for a key the divider doesn't handle (left to the browser: Tab, …).
 * ArrowUp/PageUp grow the table (the divider moves up).
 */
export function metricsTableKeyStep(key: string, height: number, mapHeight: number): number | null {
  const page = mapHeight * METRICS_TABLE_PAGE_SHARE;
  switch (key) {
    case 'ArrowUp':
      return clampMetricsTableHeight(height + METRICS_TABLE_KEY_STEP, mapHeight);
    case 'ArrowDown':
      return clampMetricsTableHeight(height - METRICS_TABLE_KEY_STEP, mapHeight);
    case 'PageUp':
      return clampMetricsTableHeight(height + page, mapHeight);
    case 'PageDown':
      return clampMetricsTableHeight(height - page, mapHeight);
    case 'Home':
      return metricsTableHeightBounds(mapHeight).min;
    case 'End':
      return metricsTableHeightBounds(mapHeight).max;
    default:
      return null;
  }
}

/** P4-3b: the height mid-drag — dragging up (smaller `clientY`) grows the table. */
export function metricsTableDragHeight(startHeight: number, startY: number, clientY: number, mapHeight: number): number {
  return clampMetricsTableHeight(startHeight + (startY - clientY), mapHeight);
}

/**
 * P4-3b: `.code-map`'s inline style — the table height as
 * `--code-map-table-height` while the table shows and the map is measured.
 * Otherwise nothing: the stylesheet's `0px`, or its `min(13rem, 40cqh)`
 * fallback until the first measurement.
 */
export function codeMapTableHeightStyle(tableShown: boolean, height: number, mapHeight: number): CSSProperties | undefined {
  return tableShown && mapHeight > 0 ? ({ '--code-map-table-height': `${height}px` } as CSSProperties) : undefined;
}

/**
 * P4-3b review: set on `.code-map` while the divider is dragged — the
 * canvas ResizeObserver defers its React state until release, and the
 * stylesheet turns off text selection.
 */
export const METRICS_TABLE_DRAGGING_ATTRIBUTE = 'data-metrics-table-dragging';

/** P4-3b review: the divider's `aria-valuetext` — "350 px, 35% of map". */
export function metricsTableValueText(height: number, mapHeight: number): string {
  return mapHeight > 0 ? `${height} px, ${Math.round((height / mapHeight) * 100)}% of map` : `${height} px`;
}

/**
 * P4-3b review: what a canvas size report does to React state.
 * - `'none'`: the committed size (`containerSize`) already matches;
 * - `'defer'`: a divider drag is on — only `containerSizeRef` takes it, so a
 *   drag never re-renders `CodeMap` (nor re-runs `computeLOD`) per move;
 * - `'commit'`: `setContainerSize` and `clearRouteClamp`.
 * A release re-asks with `dragging` false, flushing the deferred size once.
 */
export function canvasResizeEffect(
  dragging: boolean,
  committed: { width: number; height: number },
  next: { width: number; height: number },
): 'none' | 'defer' | 'commit' {
  if (committed.width === next.width && committed.height === next.height) {
    return 'none';
  }
  return dragging ? 'defer' : 'commit';
}

/** P4-3b: the slice of a pointer event the divider's drag handlers read. */
export interface MetricsTableDividerPointerEvent {
  pointerId: number;
  button: number;
  clientY: number;
  preventDefault(): void;
  currentTarget: {
    parentElement: {
      style: { setProperty(name: string, value: string): void };
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
    } | null;
    setAttribute(name: string, value: string): void;
    setPointerCapture(pointerId: number): void;
    hasPointerCapture(pointerId: number): boolean;
    releasePointerCapture(pointerId: number): void;
  };
}

interface MetricsTableDrag {
  pointerId: number;
  startY: number;
  startHeight: number;
  height: number;
}

// Keyed by the divider element, so the component stays hookless.
const metricsTableDrags = new WeakMap<object, MetricsTableDrag>();

/** P4-3b: a primary-button press starts a drag and captures the pointer. */
export function beginMetricsTableDrag(event: MetricsTableDividerPointerEvent, height: number): void {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.parentElement?.setAttribute(METRICS_TABLE_DRAGGING_ATTRIBUTE, '');
  metricsTableDrags.set(event.currentTarget, {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: height,
    height,
  });
}

/**
 * P4-3b: a drag step writes only the CSS variable on `.code-map` (the
 * divider's parent) and the divider's `aria-valuenow` — no React state, so a
 * drag never re-renders `CodeMap` per pointer move.
 */
export function moveMetricsTableDrag(event: MetricsTableDividerPointerEvent, mapHeight: number): void {
  const drag = metricsTableDrags.get(event.currentTarget);
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  const next = metricsTableDragHeight(drag.startHeight, drag.startY, event.clientY, mapHeight);
  if (next === drag.height) {
    return;
  }
  drag.height = next;
  event.currentTarget.parentElement?.style.setProperty('--code-map-table-height', `${next}px`);
  event.currentTarget.setAttribute('aria-valuenow', String(next));
  event.currentTarget.setAttribute('aria-valuetext', metricsTableValueText(next, mapHeight));
}

/**
 * P4-3b: release, cancel or a lost capture (a release outside the window)
 * ends the drag and commits its height to React state once, if it moved. Idempotent: the
 * `lostpointercapture` after a `pointerup` finds no drag.
 */
export function endMetricsTableDrag(event: MetricsTableDividerPointerEvent, onResize: (height: number) => void): void {
  const drag = metricsTableDrags.get(event.currentTarget);
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  metricsTableDrags.delete(event.currentTarget);
  event.currentTarget.parentElement?.removeAttribute(METRICS_TABLE_DRAGGING_ATTRIBUTE);
  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  // A click without movement commits nothing, so an untouched table keeps
  // tracking the default share of the map.
  if (drag.height !== drag.startHeight) {
    onResize(drag.height);
  }
}

/**
 * P4-3b: the separator between the canvas and the metrics table — Arrow keys
 * step 24px, PageUp/PageDown a quarter of the map, Home/End jump to the
 * bounds; a pointer drag resizes. `height` is the table's current height and
 * `mapHeight` `.code-map`'s; both in px.
 *
 * MUST STAY HOOKLESS: `CodeMap.prReviewMetrics.test.ts` renders it by calling
 * it as a plain function (no DOM runner).
 */
export function MetricsTableDivider({
  height,
  mapHeight,
  onResize,
}: {
  height: number;
  mapHeight: number;
  onResize: (height: number) => void;
}) {
  const { min, max } = metricsTableHeightBounds(mapHeight);
  return (
    <div
      className="code-map__metrics-divider"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize metrics table"
      aria-valuenow={height}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={metricsTableValueText(height, mapHeight)}
      onKeyDown={(event) => {
        const next = metricsTableKeyStep(event.key, height, mapHeight);
        if (next === null) {
          return;
        }
        // Handled keys never scroll the page, even at a bound.
        event.preventDefault();
        if (next !== height) {
          onResize(next);
        }
      }}
      onPointerDown={(event) => beginMetricsTableDrag(event, height)}
      onPointerMove={(event) => moveMetricsTableDrag(event, mapHeight)}
      onPointerUp={(event) => endMetricsTableDrag(event, onResize)}
      onPointerCancel={(event) => endMetricsTableDrag(event, onResize)}
      onLostPointerCapture={(event) => endMetricsTableDrag(event, onResize)}
    />
  );
}

const PR_REVIEW_METRICS_CAPTION_ID = 'code-map-metrics-table-caption';
/** P4-3c: the table's column count — node, hop, complexity, blast radius, tests, findings. */
const PR_REVIEW_METRICS_COLUMN_COUNT = 6;

/**
 * P4-3d: `columnMax` (`metricBarWidths`) adds the relative bar beside the
 * text value — `aria-hidden`, since the value, the `!` glyph and "(severe)"
 * already say everything; omit it for a column without bars.
 */
function MetricSignalCell({ signal, columnMax }: { signal: DeterministicRiskSignal | null; columnMax?: number }) {
  const cell = formatMetricSignalCell(signal);
  if (cell.label === null) {
    return <td className="code-map__metrics-table-cell code-map__metrics-table-cell--empty">{cell.text}</td>;
  }
  const bar = columnMax === undefined ? null : metricBar(signal, columnMax);
  return (
    <td
      className={
        cell.severe
          ? 'code-map__metrics-table-cell code-map__metrics-table-cell--severe'
          : 'code-map__metrics-table-cell'
      }
    >
      <span role="img" aria-label={cell.label} title={cell.title ?? undefined}>
        {cell.severe && <span aria-hidden="true">{`${SEVERE_SIGNAL_GLYPH} `}</span>}
        {cell.text}
      </span>
      {bar !== null && (
        <span className="code-map__metrics-bar-track" aria-hidden="true">
          <span
            className={bar.severe ? 'code-map__metrics-bar code-map__metrics-bar--severe' : 'code-map__metrics-bar'}
            style={{ width: bar.width }}
          />
        </span>
      )}
    </td>
  );
}

/**
 * P4-3f: the tests cell. `covered` is named by `METRIC_TESTS_COVERED_LABEL`
 * through the same `role="img"` span as a metric value; `—` carries its
 * "No LCOV data for this file" tooltip; `gap` is unchanged.
 */
function MetricTestsCell({ state }: { state: PrReviewMetricTestsState }) {
  const cell = formatMetricTestsCell(state);
  const className = cell.empty
    ? 'code-map__metrics-table-cell code-map__metrics-table-cell--empty'
    : 'code-map__metrics-table-cell';
  if (cell.label === null) {
    return (
      <td className={className} title={cell.title ?? undefined}>
        {cell.text}
      </td>
    );
  }
  return (
    <td className={className}>
      <span role="img" aria-label={cell.label} title={cell.title ?? undefined}>
        {cell.text}
      </span>
    </td>
  );
}

/** P4-3d: the table's sort, and the setter a header activation hands the next sort to. */
export interface PrReviewMetricsTableSortProps {
  sort: PrReviewMetricSort | null;
  onSort: (sort: PrReviewMetricSort) => void;
}

/** P4-3e: the table's activation — `CodeMap` passes `openNodeDetail`, as the Health Audit grid does. */
export interface PrReviewMetricsTableActivationProps {
  onActivateNode: (node: CodeMapNode) => void;
  /**
   * P4-3g: a contract row's button (P4-2e's `ChangedContractButton`) opens
   * the type detail by the contract's id — `CodeMap`'s `openType`, as the
   * toolbar's contract lines do.
   */
  onOpenType: (id: string) => void;
}

/** P4-3e: the one control in a metrics row — a native button in the node cell. */
export const METRICS_ROW_BUTTON_CLASS = 'code-map__metrics-row-button';

/** P4-3e: the row button, as the row's click delegate sees it. */
export interface MetricsRowButtonTarget {
  focus: (options?: FocusOptions) => void;
  contains: (other: Node | null) => boolean;
}

/**
 * P4-3e: a click anywhere on a metrics row runs the row button's action.
 * A click on (or inside) the button itself is left to the button's own
 * `onClick` — it bubbles here too, and must not open Node detail twice.
 * Anywhere else, the button takes focus first (without scrolling), so it is
 * what `useModalLayer` captures as the opener and returns focus to on close;
 * otherwise the opener would be the table's scroll region, which a press on
 * a plain cell focuses. The row is never a second tab stop. `textSelected`
 * is the document selection's state at click time (non-collapsed = the user
 * was selecting text), passed in so this stays pure.
 */
export function activateMetricsRowFromCell<T>(
  button: MetricsRowButtonTarget | null,
  target: Node | null,
  textSelected: boolean,
  node: T,
  onActivateNode: (node: T) => void,
): void {
  if (button !== null && button.contains(target)) {
    return;
  }
  // Review round 1: a drag or double-click that selects a cell's text also
  // ends in a click; selecting a value to copy it must not open Node detail.
  if (textSelected) {
    return;
  }
  button?.focus({ preventScroll: true });
  onActivateNode(node);
}

/**
 * P4-3g: how many rows lead the default order as changed rows — where the
 * contract group goes. Pure.
 */
export function leadingChangedRowCount(rows: readonly Pick<PrReviewMetricRow, 'hop'>[]): number {
  const index = rows.findIndex((row) => row.hop !== 'changed');
  return index === -1 ? rows.length : index;
}

/** P4-3g: a contract row's hop cell — a folded type has no hop distance. */
export const METRICS_CONTRACT_HOP = 'contract';

/**
 * P4-3g: one changed contract's summary row — the canvas's ⧉ marker, P4-2e's
 * `ChangedContractButton` and the type's noun; hop `contract`; then one cell
 * across the metric columns, "→ 59 dependents" (`formatContractDependents`,
 * the exact `dependentCount`). No bars, no severity, no tests or findings
 * value: a folded type carries no risk signals. Styled as a changed row (the
 * contract itself changed). A click on any cell runs the button's action
 * through the same delegate as a Node row (`activateMetricsRowFromCell`), so
 * `useModalLayer` captures the button as the opener and focus returns to it.
 * Hookless.
 */
export function MetricsContractRow({
  contract,
  onOpenType,
}: {
  contract: ChangedContract;
  onOpenType: (id: string) => void;
}) {
  return (
    <tr
      className="code-map__metrics-contract"
      onClick={(event) =>
        activateMetricsRowFromCell(
          event.currentTarget.querySelector<HTMLButtonElement>('button'),
          event.target as Node,
          !(window.getSelection()?.isCollapsed ?? true),
          contract.id,
          onOpenType,
        )
      }
    >
      <th scope="row" className="code-map__metrics-table-node" title={contract.id}>
        <span className="code-map__metrics-contract-marker" aria-hidden="true">
          ⧉
        </span>{' '}
        <ChangedContractButton contract={contract} onOpenType={onOpenType} />
        <span className="code-map__metrics-table-module">{foldedTypeNoun(contract.kind)}</span>
      </th>
      <td className="code-map__metrics-table-cell">{METRICS_CONTRACT_HOP}</td>
      <td className="code-map__metrics-contract-dependents" colSpan={PR_REVIEW_METRICS_COLUMN_COUNT - 2}>
        → {formatContractDependents(contract)}
      </td>
    </tr>
  );
}

/**
 * P4-3g: the changed contracts' pinned tbody — the inert approximate note
 * first when it applies, then one row per contract, uncapped (the toolbar
 * keeps its own cap of `CHANGED_CONTRACTS_SHOWN`). `null` for no contracts.
 * Hookless.
 */
export function MetricsContractGroup({
  contracts,
  approximate,
  onOpenType,
}: {
  contracts: readonly ChangedContract[];
  approximate: boolean;
  onOpenType: (id: string) => void;
}) {
  if (contracts.length === 0) {
    return null;
  }
  return (
    <tbody className="code-map__metrics-contracts">
      {approximate && (
        <tr className="code-map__metrics-contract-note">
          <td colSpan={PR_REVIEW_METRICS_COLUMN_COUNT}>
            <span aria-hidden="true">{ACTIONABLE_NOTICE_GLYPHS.warning}</span>{' '}
            <span className="visually-hidden">{`${ACTIONABLE_NOTICE_SPOKEN_PREFIX.warning} `}</span>
            {/* The toolbar's own sentence (`ChangedContractList`). */}
            Changed contracts are {CHANGED_CONTRACTS_APPROXIMATE_NOTE}.
          </td>
        </tr>
      )}
      {contracts.map((contract) => (
        <MetricsContractRow key={contract.id} contract={contract} onOpenType={onOpenType} />
      ))}
    </tbody>
  );
}

/**
 * P4-3a: the PR Review metrics table (DESIGN.md
 * `components.pr-review-metrics-table`) — a native `<table>` in a fixed-height
 * region below the canvas, one row per changed Node, then (P4-3c) the
 * affected rows at the stepper's depth up to the cap and the inert "+N more"
 * line. P4-3d: header buttons sort every row (`sort`, reset to the default
 * order with the diff scope by `CodeMap`), announced through an always-mounted
 * `role="status"`; complexity and blast radius carry relative bars.
 * Signal-family toggles don't hide columns, as with Health Audit rows.
 *
 * MUST STAY HOOKLESS: `CodeMap.prReviewMetrics.test.ts` renders it by calling
 * it as a plain function (no DOM runner).
 */
export function PrReviewMetricsTable({
  blastRadiusStatus,
  sort,
  onSort,
  onActivateNode,
  onOpenType,
  changedContracts,
  changedContractsApproximate,
  ...table
}: PrReviewMetricsTableProps & PrReviewMetricsTableSortProps & PrReviewMetricsTableActivationProps) {
  const { missingChangedCount, hiddenAffectedCount, missingAffectedCount } = table;
  // P4-3d: sorted here, from the rows already capped in the default order —
  // the cap line stays last, after every row, whatever the sort.
  const rows = sortPrReviewMetricRows(table.rows, sort);
  const barMax = metricBarWidths(table.rows);
  const sortedWithinCap = formatSortedWithinCapNote(sort, rows.length, hiddenAffectedCount);
  const missing = formatMissingChangedNodes(missingChangedCount);
  const hiddenAffected = formatHiddenAffectedNodes(hiddenAffectedCount);
  const missingAffected = formatMissingAffectedNodes(missingAffectedCount);
  const caption = prReviewMetricsCaption(table, blastRadiusStatus, changedContracts.length);
  // P4-3g: the changed contracts' pinned group — its own tbody, never
  // sorted (only Node rows sort), never capped. In the default order it
  // sits between the changed rows and the affected rows. Under a user sort
  // the Node rows are one interleaved block (P4-3d), so there is no
  // "between": the group is pinned above that block, before the
  // sorted-within-cap note, and stays put whatever the column.
  const contractGroup = (
    <MetricsContractGroup
      contracts={changedContracts}
      approximate={changedContractsApproximate}
      onOpenType={onOpenType}
    />
  );
  const hasContracts = changedContracts.length > 0;
  const changedCount = sort === null && hasContracts ? leadingChangedRowCount(rows) : 0;
  const leadingRows = rows.slice(0, changedCount);
  const trailingRows = rows.slice(changedCount);
  // Keyed rows keep their button across re-sorts and depth steps WITHIN one
  // tbody. P4-3g review: with contracts present, a row that moves between the
  // leading and trailing tbody (a sort toggle, or an async re-resolve that
  // changes the contract count) is remounted, so its button is a new element.
  // A sort can't happen while a modal is open, but an async re-resolve can;
  // then `useModalLayer` finds the opener disconnected and focus falls back
  // to `.code-map` (`MODAL_FOCUS_FALLBACK_ID`).
  const renderRow = (row: PrReviewMetricRow) => (
    <tr
      key={row.id}
      className={
        row.hop === 'changed'
          ? 'code-map__metrics-table-row code-map__metrics-table-row--changed'
          : 'code-map__metrics-table-row'
      }
      // P4-3e: a click on any cell runs the row button's action; the
      // row itself is no control and no tab stop.
      onClick={(event) =>
        activateMetricsRowFromCell(
          event.currentTarget.querySelector<HTMLButtonElement>(`.${METRICS_ROW_BUTTON_CLASS}`),
          event.target as Node,
          !(window.getSelection()?.isCollapsed ?? true),
          row.node,
          onActivateNode,
        )
      }
    >
      <th scope="row" className="code-map__metrics-table-node" title={row.id}>
        {/* P4-3e: the row's one control, as `HealthAuditClusterRow`'s
            button — Enter, Space, the tab stop and the role come from
            the platform. It hands over ITS OWN Node object. No
            `aria-label`: the name is the cell's content, then the
            visually hidden `HEALTH_ROW_AFFORDANCE`. Keyed rows keep
            this element across re-sorts and depth steps, so closing
            Node detail returns focus to it. */}
        <button type="button" className={METRICS_ROW_BUTTON_CLASS} onClick={() => onActivateNode(row.node)}>
          <code className="code-map__metrics-table-name">{row.name}</code>
          {row.moduleLine !== null && <span className="code-map__metrics-table-module">{row.moduleLine}</span>}
          {/* Same-name rows (two `handle`s in one file) differ here for
              assistive tech, not only in the `title`. */}
          <span className="visually-hidden">{`, ${row.file} line ${row.startLine}`}</span>
          {row.coverageGap && (
            <span
              className="code-map__metrics-table-coverage-gap"
              role="img"
              aria-label="Coverage gap"
              title="Coverage gap — no summary"
            >
              ⚠
            </span>
          )}
          <span className="visually-hidden">{`, ${HEALTH_ROW_AFFORDANCE}`}</span>
        </button>
      </th>
      <td className="code-map__metrics-table-cell">{String(row.hop)}</td>
      <MetricSignalCell signal={row.complexity} columnMax={barMax.complexity} />
      <MetricSignalCell signal={row.blastRadius} columnMax={barMax.blastRadius} />
      <MetricTestsCell state={metricTestsState(row)} />
      <td
        className={
          row.findings === null
            ? 'code-map__metrics-table-cell code-map__metrics-table-cell--empty'
            : 'code-map__metrics-table-cell'
        }
      >
        {formatMetricFindingsCell(row.findings)}
      </td>
    </tr>
  );
  return (
    // A scroll region, so it takes a focus stop for keyboard scrolling, like
    // `.code-map__health-grid`.
    <section className="code-map__metrics-table" aria-labelledby={PR_REVIEW_METRICS_CAPTION_ID} tabIndex={0}>
      <table>
        {/* P4-3c: while the blast radius computes, the caption shows and
            says so (the toolbar's wording); the changed rows are already here. */}
        <caption
          id={PR_REVIEW_METRICS_CAPTION_ID}
          className={caption.visible ? 'code-map__metrics-table-caption' : 'visually-hidden'}
        >
          {caption.text}
        </caption>
        <thead>
          <tr>
            {/* P4-3d: real sorting — only the active column carries
                `aria-sort`; a native button in each header. */}
            {PR_REVIEW_METRIC_COLUMNS.map(({ column, label, bar }) => {
              const direction = sort !== null && sort.column === column ? sort.direction : undefined;
              return (
                <th key={column} scope="col" aria-sort={direction}>
                  <button
                    type="button"
                    className="code-map__metrics-sort"
                    title={bar ? METRIC_BAR_HEADER_NOTE : undefined}
                    onClick={() => onSort(nextPrReviewMetricSort(sort, column))}
                  >
                    {column === 'blastRadius' ? prReviewBlastRadiusHeader() : label}
                    {bar && <span className="visually-hidden">{` ${METRIC_BAR_HEADER_NOTE}`}</span>}
                    {direction !== undefined && (
                      <span className="code-map__metrics-sort-indicator" aria-hidden="true">
                        {direction === 'ascending' ? '↑' : '↓'}
                      </span>
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        {sort !== null && hasContracts && contractGroup}
        {/* P4-3d review: a sort on a capped table says it covers only the
            rows shown. Inert; its own tbody, so the rows' zebra keeps its
            parity. */}
        {sortedWithinCap !== null && (
          <tbody>
            <tr className="code-map__metrics-sort-note">
              <td colSpan={PR_REVIEW_METRICS_COLUMN_COUNT}>{sortedWithinCap}</td>
            </tr>
          </tbody>
        )}
        {/* P4-3g: in the default order, with contracts, the changed rows
            get their own tbody so the contract group can sit after them. */}
        {leadingRows.length > 0 && <tbody>{leadingRows.map(renderRow)}</tbody>}
        {sort === null && hasContracts && contractGroup}
        {/* P4-3g review: no empty tbody (a contract-only table). */}
        {(trailingRows.length > 0 || hiddenAffected !== null) && (
          <tbody>
            {trailingRows.map(renderRow)}
            {/* P4-3c: the affected rows' cap. Inert: no handler, no focus
                stop — the only action is the depth stepper above. */}
            {hiddenAffected !== null && (
              <tr className="code-map__metrics-cap">
                <td colSpan={PR_REVIEW_METRICS_COLUMN_COUNT}>{hiddenAffected}</td>
              </tr>
            )}
          </tbody>
        )}
      </table>
      {missing !== null && <p className="code-map__metrics-table-missing">{missing}</p>}
      {missingAffected !== null && (
        <p className="code-map__metrics-table-missing code-map__metrics-table-missing--affected">{missingAffected}</p>
      )}
      {/* P4-3d: always mounted, so a sort change is announced, not missed as a new region. */}
      <p className="visually-hidden" role="status">
        {formatMetricSortAnnouncement(sort)}
      </p>
    </section>
  );
}

/** P4-2 phase 3a: how many files the top-level-change notice names before "+N more". */
export const TOP_LEVEL_CHANGE_FILES_SHOWN = 3;

/**
 * P4-2 phase 3a: the top-level-change notice's parts — "Changed: top-level
 * code in x.ts, y.ts", naming up to `TOP_LEVEL_CHANGE_FILES_SHOWN` files,
 * the rest behind "+N more". `null` for no files: there is nothing to say.
 */
export function formatTopLevelChangeNotice<T>(
  files: readonly T[],
): { lead: string; shown: readonly T[]; rest: readonly T[] } | null {
  if (files.length === 0) {
    return null;
  }
  return {
    lead: 'Changed: top-level code in ',
    shown: files.slice(0, TOP_LEVEL_CHANGE_FILES_SHOWN),
    rest: files.slice(TOP_LEVEL_CHANGE_FILES_SHOWN),
  };
}

/**
 * P4-2 phase 3a: the PR Review status line's count — "3 changed Nodes", or
 * for a diff whose top-level-only files changed too, "0 changed Nodes · top-
 * level code changed in 1 file", so a top-level-only diff never reads as a
 * bare "0 changed Nodes".
 */
export function formatDiffScopeChangeCount(nodeCount: number, topLevelFileCount: number, contractCount = 0): string {
  const parts: string[] = [];
  // P4-2 phase 3c: changed contracts lead, and with any, a zero Node count is
  // left out — a type-only diff reads "1 contract changed", never as a bare
  // "0 changed Nodes".
  if (contractCount > 0) {
    parts.push(`${contractCount} contract${contractCount === 1 ? '' : 's'} changed`);
  }
  if (nodeCount > 0 || contractCount === 0) {
    parts.push(`${nodeCount} changed Node${nodeCount === 1 ? '' : 's'}`);
  }
  if (topLevelFileCount > 0) {
    parts.push(`top-level code changed in ${topLevelFileCount} file${topLevelFileCount === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/** P4-4 phase 3b: one other section's "changed elsewhere" entry — its counts, its section, and the line both make. */
export interface ChangedElsewhereEntry {
  section: string;
  /** "3 changed Nodes", "1 contract changed · top-level code changed in 2 files" — zero counts left out. */
  counts: string;
  /** "api/: 3 changed Nodes" — the section first, then its counts (review round 1). */
  text: string;
}

/**
 * P4-4 phase 3b: PR Review's "changed elsewhere" line, from a resolved
 * section diff's `changedInOtherSections` (P4-4g; founder decision
 * 2026-10-03: changed Nodes, changed contracts and top-level-only files, for
 * other sections in the same git repository only). One entry per section,
 * in the field's order, section first: "api/: 1 changed Node · 1 contract
 * changed · top-level code changed in 1 file" — each with its own "Switch to
 * api". A 0 count is left out, and an entry with none is dropped. Every
 * number is the field's own. `null` for an absent or empty list.
 */
export function changedElsewhereLine(
  changedInOtherSections: readonly SectionChangeCount[] | undefined,
): ChangedElsewhereEntry[] | null {
  const entries: ChangedElsewhereEntry[] = [];
  for (const entry of changedInOtherSections ?? []) {
    const parts: string[] = [];
    if (entry.changedNodes > 0) {
      parts.push(formatCount(entry.changedNodes, 'changed Node', 'changed Nodes'));
    }
    if (entry.changedContracts > 0) {
      parts.push(`${formatCount(entry.changedContracts, 'contract', 'contracts')} changed`);
    }
    if (entry.topLevelFiles > 0) {
      parts.push(`top-level code changed in ${formatCount(entry.topLevelFiles, 'file', 'files')}`);
    }
    if (parts.length > 0) {
      const counts = parts.join(' · ');
      entries.push({ section: entry.section, counts, text: `${entry.section}/: ${counts}` });
    }
  }
  return entries.length > 0 ? entries : null;
}

/**
 * P4-4 review round 1: a cross-section switch button's availability props.
 * Never natively `disabled` while the session isn't live: `aria-disabled`
 * keeps it focusable and describes it by the Section bar's hint
 * (`SECTION_SWITCH_UNAVAILABLE_HINT`), and activating it does nothing — the
 * Section bar's own precedent.
 */
export function sectionSwitchButtonProps(
  graphServiceAvailable: boolean,
  hintId: string,
  onActivate: () => void,
): {
  className: string;
  'aria-disabled'?: true;
  'aria-describedby'?: string;
  onClick: () => void;
} {
  return graphServiceAvailable
    ? { className: 'code-map__link-button', onClick: onActivate }
    : {
        className: `code-map__link-button ${SERVICE_UNAVAILABLE_CLASS}`,
        'aria-disabled': true,
        'aria-describedby': hintId,
        onClick: () => {},
      };
}

/** P4-4 review round 1: the ids of the two switch surfaces' unavailable hints. */
export const CHANGED_ELSEWHERE_HINT_ID = 'code-map-changed-elsewhere-hint';
export const CROSS_SECTION_CALLS_HINT_ID = 'code-map-cross-section-calls-hint';

/**
 * P4-4 phase 3b: the "changed elsewhere" line under PR Review's change count
 * — "api/: 3 changed Nodes — Switch to api", one row per other section.
 * Informational: no ✓/⚠︎ Actionable Notice icon. Each button goes through
 * the Section bar's own switch (`onSwitchSection`, App's full reset and
 * announcements); the mode stays PR Review. While the Graph Service isn't
 * live the buttons are `aria-disabled` with the Section bar's hint. Nothing
 * for no entries. MUST STAY HOOKLESS.
 */
export function ChangedElsewhereLine({
  changedInOtherSections,
  onSwitchSection,
  graphServiceAvailable,
}: {
  changedInOtherSections: readonly SectionChangeCount[];
  onSwitchSection: (section: string) => void;
  graphServiceAvailable: boolean;
}) {
  const entries = changedElsewhereLine(changedInOtherSections);
  if (entries === null) {
    return null;
  }
  return (
    <>
      <ul className="code-map__changed-elsewhere" aria-label="Changed in other sections">
        {entries.map((entry) => (
          <li key={entry.section}>
            <code>{entry.section}/</code>: {entry.counts} —{' '}
            <button
              type="button"
              {...sectionSwitchButtonProps(graphServiceAvailable, CHANGED_ELSEWHERE_HINT_ID, () =>
                onSwitchSection(entry.section),
              )}
            >
              Switch to <code>{entry.section}</code>
            </button>
          </li>
        ))}
      </ul>
      {!graphServiceAvailable && (
        <span id={CHANGED_ELSEWHERE_HINT_ID} className="code-map__switch-hint">
          {SECTION_SWITCH_UNAVAILABLE_HINT}
        </span>
      )}
    </>
  );
}

/**
 * P4-4 phase 3b: what PR Review's change-count status line adds, for a
 * screen reader, about other sections — " Also changed in api/: 3 changed
 * Nodes." (several: "…; in docs/: …") — or `''` for none. The visible line
 * (`ChangedElsewhereLine`) sits outside the live region, so its buttons are
 * never read out on resolve.
 */
export function changedElsewhereAnnouncement(changedInOtherSections: readonly SectionChangeCount[]): string {
  const entries = changedElsewhereLine(changedInOtherSections);
  return entries === null
    ? ''
    : ` Also changed ${entries.map((entry) => `in ${entry.section}/: ${entry.counts}`).join('; ')}.`;
}

/** P4-2 phase 3c: what PR Review says when changed contracts were found without line ranges. */
export const CHANGED_CONTRACTS_APPROXIMATE_NOTE = "approximate: couldn't read line ranges";

/**
 * A rendered card's highlight classes: the Path Trace highlight (Story 1.9),
 * the blast radius's affected treatment (Story 3.2), and — P4-2 phase 3c —
 * `code-map__contract-dependent` for a changed contract's dependent (its
 * own class; the card also carries a ⧉ marker and an accessible-name
 * suffix, so it is never colour alone). Any can apply at once. `null` for
 * none. Pure.
 */
export function nodeHighlightClassName(
  id: string,
  pathHighlightNodeIds: ReadonlySet<string>,
  blastRadiusNodeIds: ReadonlySet<string>,
  contractDependentIds: { has(id: string): boolean },
): string | null {
  const classNames: string[] = [];
  if (pathHighlightNodeIds.has(id)) {
    classNames.push('code-map__path-highlight');
  }
  if (blastRadiusNodeIds.has(id)) {
    classNames.push('code-map__blast-radius-highlight');
  }
  if (contractDependentIds.has(id)) {
    classNames.push('code-map__contract-dependent');
  }
  return classNames.length > 0 ? classNames.join(' ') : null;
}

/** P4-2 phase 3c: how many changed-contract lines PR Review shows before "+N more". */
export const CHANGED_CONTRACTS_SHOWN = 5;

/** P4-2 phase 3c: "59 dependents" / "1 dependent" — a changed contract's dependent count. */
export function formatContractDependents(contract: Pick<ChangedContract, 'dependentCount'>): string {
  return formatCount(contract.dependentCount, 'dependent', 'dependents');
}

/**
 * P4-2 phase 3c: the map Nodes PR Review marks as affected by the changed
 * contracts — every contract's real dependents (`dependentIds`, from
 * `USAGE` edges only), each with the names of the contracts it uses, less
 * the changed Nodes themselves, which keep the changed treatment. Pure.
 */
export function contractDependents(
  contracts: readonly ChangedContract[],
  changedNodeIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  if (contracts.length === 0) {
    return NO_CONTRACT_DEPENDENTS;
  }
  const byNode = new Map<string, string[]>();
  for (const contract of contracts) {
    for (const id of contract.dependentIds) {
      if (changedNodeIds.has(id)) {
        continue;
      }
      const names = byNode.get(id) ?? [];
      if (!names.includes(contract.name)) {
        names.push(contract.name);
      }
      byNode.set(id, names);
    }
  }
  return byNode;
}

/**
 * P4-2 phase 3a: `DiffScopeResult` → `DiffScopeState`, as `CodeMap`'s
 * diff-scope request stores it (a resolved `nodeIds` becomes a `Set`, and
 * `topLevelFiles` is always present). Hookless, so it's testable.
 */
export function diffScopeStateFromResult(result: Exclude<DiffScopeResult, UnknownSectionResult>): DiffScopeState {
  switch (result.status) {
    case 'resolved':
      return {
        status: 'resolved',
        resolvedBaseRef: result.resolvedBaseRef,
        nodeIds: new Set(result.nodeIds),
        topLevelFiles: result.topLevelFiles ?? NO_TOP_LEVEL_FILES,
        changedContracts: result.changedContracts ?? NO_CHANGED_CONTRACTS,
        changedContractsApproximate: result.changedContractsApproximate === true,
        ...(result.changedInOtherSections !== undefined && result.changedInOtherSections.length > 0
          ? { changedInOtherSections: result.changedInOtherSections }
          : {}),
      };
    case 'error':
      return { status: 'error', message: result.message };
    default:
      return { status: result.status };
  }
}

/** P4-2 phase 3a: where a top-level-only changed file opens in the source viewer — its folded top-level code's range. */
export function topLevelFileSourceTarget(file: TopLevelChangedFile): SourceTarget {
  return { file: file.file, startLine: file.startLine, endLine: file.endLine, label: `${file.file} (top-level)` };
}

function TopLevelFileButton({
  file,
  onOpenFile,
}: {
  file: TopLevelChangedFile;
  onOpenFile: (target: SourceTarget) => void;
}) {
  return (
    <button
      type="button"
      className="code-map__link-button"
      onClick={() => onOpenFile(topLevelFileSourceTarget(file))}
      aria-label={`Open the top-level code of ${file.file}`}
    >
      <code>{file.file}</code>
    </button>
  );
}

function topLevelFileButtons(files: readonly TopLevelChangedFile[], onOpenFile: (target: SourceTarget) => void) {
  return files.map((file, index) => (
    <Fragment key={file.file}>
      {index > 0 && ', '}
      <TopLevelFileButton file={file} onOpenFile={onOpenFile} />
    </Fragment>
  ));
}

/**
 * P4-2 phase 3c: a changed contract's name, as the button that opens its
 * type detail. P4-3g: exported — the metrics table's contract rows reuse it.
 */
export function ChangedContractButton({ contract, onOpenType }: { contract: ChangedContract; onOpenType: (id: string) => void }) {
  return (
    <button
      type="button"
      className="code-map__link-button"
      onClick={() => onOpenType(contract.id)}
      aria-label={`Open the type detail of ${contract.name}`}
      title={contract.file}
    >
      <code>{contract.name}</code>
    </button>
  );
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
export function PrReviewDiffScopeNoticeRegion({
  status,
  topLevelFiles = NO_TOP_LEVEL_FILES,
  onOpenFile = () => {},
  changedContracts = NO_CHANGED_CONTRACTS,
  changedContractsApproximate = false,
  onOpenType = () => {},
}: {
  status: DiffScopeNoticeStatus | null;
  /** P4-2 phase 3a: see `PrReviewView.topLevelFiles`. */
  topLevelFiles?: readonly TopLevelChangedFile[];
  /** P4-2 phase 3a: opens a top-level-only changed file in the source viewer. */
  onOpenFile?: (target: SourceTarget) => void;
  /** P4-2 phase 3c: see `PrReviewView.changedContracts`. */
  changedContracts?: readonly ChangedContract[];
  /** P4-2 phase 3c: see `PrReviewView.changedContractsApproximate`. */
  changedContractsApproximate?: boolean;
  /** P4-2 phase 3c: opens a changed contract's type detail, by its id. */
  onOpenType?: (id: string) => void;
}) {
  const topLevel = formatTopLevelChangeNotice(topLevelFiles);
  const summary = formatChangedContractsSummary(changedContracts.length, changedContractsApproximate);
  // P4-2 phase 3c: the live region announces only a one-line contract
  // summary; the interactive contract lines sit beside it, outside it, so a
  // screen reader isn't read every button whenever the scope resolves.
  return [
    <div key="live" id={PR_REVIEW_NOTICE_ID} className="code-map__pr-review-notice-region" role="status">
      {status !== null && <PrReviewDiffScopeNotice status={status} />}
      {summary !== null && <span className="visually-hidden">{summary}</span>}
      {topLevel !== null && (
        <ActionableNotice tone="info">
          {topLevel.lead}
          {topLevelFileButtons(topLevel.shown, onOpenFile)}
          {topLevel.rest.length === 0 && '.'}
        </ActionableNotice>
      )}
      {topLevel !== null && topLevel.rest.length > 0 && (
        <details className="code-map__more">
          <summary>+{topLevel.rest.length} more</summary>
          <p className="code-map__more-list">{topLevelFileButtons(topLevel.rest, onOpenFile)}</p>
        </details>
      )}
    </div>,
    changedContracts.length > 0 && (
      <ChangedContractList
        key="contracts"
        contracts={changedContracts}
        approximate={changedContractsApproximate}
        onOpenType={onOpenType}
      />
    ),
  ];
}

/**
 * P4-2 phase 3c: the live region's one-line contract summary — "2 contracts
 * changed." (with the approximate note when it applies) — or `null` for none.
 */
export function formatChangedContractsSummary(count: number, approximate: boolean): string | null {
  if (count === 0) {
    return null;
  }
  const lead = `${count} contract${count === 1 ? '' : 's'} changed`;
  return approximate ? `${lead} (${CHANGED_CONTRACTS_APPROXIMATE_NOTE}).` : `${lead}.`;
}

/**
 * P4-2 phase 3c: one line per changed contract, "Contract changed:
 * CodeMapNode → 59 dependents", up to `CHANGED_CONTRACTS_SHOWN`, then "+N
 * more"; each name opens the type detail. Outside the live region. MUST
 * STAY HOOKLESS.
 */
export function ChangedContractList({
  contracts,
  approximate,
  onOpenType,
}: {
  contracts: readonly ChangedContract[];
  approximate: boolean;
  onOpenType: (id: string) => void;
}) {
  const shown = contracts.slice(0, CHANGED_CONTRACTS_SHOWN);
  const more = contracts.slice(CHANGED_CONTRACTS_SHOWN);
  return (
    <div className="code-map__changed-contracts" role="group" aria-label="Changed contracts">
      {approximate && (
        <ActionableNotice tone="warning">Changed contracts are {CHANGED_CONTRACTS_APPROXIMATE_NOTE}.</ActionableNotice>
      )}
      {shown.map((contract) => (
        <ActionableNotice key={contract.id} tone="info">
          Contract changed: <ChangedContractButton contract={contract} onOpenType={onOpenType} /> →{' '}
          {formatContractDependents(contract)}
        </ActionableNotice>
      ))}
      {more.length > 0 && (
        <details className="code-map__more">
          <summary>+{more.length} more</summary>
          <p className="code-map__more-list">
            {more.map((contract, index) => (
              <Fragment key={contract.id}>
                {index > 0 && ', '}
                <ChangedContractButton contract={contract} onOpenType={onOpenType} /> (
                {formatContractDependents(contract)})
              </Fragment>
            ))}
          </p>
        </details>
      )}
    </div>
  );
}

/**
 * PR Review's blast-radius line — "Blast radius: 1,204 Nodes within 2 hops."
 * FIX-3: the shared count formatter, and "2 hops" (was "2-hops") to match
 * `formatDeterministicSignalLabel`'s wording.
 */
export function blastRadiusSummary(nodeCount: number, depth: number): string {
  return `Blast radius: ${formatCount(nodeCount, 'Node', 'Nodes')} within ${formatCount(depth, 'hop', 'hops')}.`;
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
  return totalRiskCount === heatCount ? worst : `${worst}, ${formatCountNumber(totalRiskCount)} in the module`;
}

/** A Windows drive root (`C:/`) once backslashes are `/`. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;

/**
 * FIX-3: a Health Audit row's location line — the Node's project-relative
 * file path (`apps/desktop/renderer/src/CodeMap.tsx`), never the qualified id
 * (whose project-name prefix, "Users-eoyawale-Desktop-…", is what the
 * 2026-09-26 live run saw) and never a machine path.
 *
 * AD-19 promises `file` is POSIX-relative, but this is defensive anyway:
 * backslashes become `/`; empty and `.` segments are dropped (a leading
 * `./`, a `/./`, a doubled `/`); an absolute POSIX or Windows path is made
 * relative when it sits under `projectPath` (compared case-insensitively, as
 * `App.tsx` compares project paths). Anything that can't become a clean
 * project-relative path — absolute outside the project or with no project
 * given, one with a `..` segment, or one that normalises to nothing — falls
 * back to `formatCandidateLocation`, the qualified-id line, so a row never
 * loses its identity or shows `''`/`/`.
 */
export function healthRowLocation(
  node: Pick<CodeMapNode, 'id' | 'name' | 'file'>,
  projectPath: string | null,
): string {
  let file = node.file.replace(/\\/g, '/');
  if (file.startsWith('/') || WINDOWS_ABSOLUTE.test(file)) {
    const root = projectPath?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
    if (root === '' || !file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      return formatCandidateLocation(node);
    }
    file = file.slice(root.length + 1);
  }
  const segments = file.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) {
    return formatCandidateLocation(node);
  }
  return segments.join('/');
}

/**
 * FIX-3: `Class.method`-style name for a Node — its name plus the qualified
 * id's segment just before it (`…svc.A.handle` → `A.handle`), or the bare
 * name when the id doesn't end in `.${name}`.
 */
export function qualifiedSymbolName(node: Pick<CodeMapNode, 'id' | 'name'>): string {
  const suffix = `.${node.name}`;
  if (!node.id.endsWith(suffix)) {
    return node.name;
  }
  const prefix = node.id.slice(0, -suffix.length);
  const qualifier = prefix.slice(prefix.lastIndexOf('.') + 1);
  return qualifier === '' ? node.name : `${qualifier}.${node.name}`;
}

/**
 * FIX-3: the location line for each row of one Health Audit card, in order.
 * Normally `healthRowLocation`. Rows that would still read identically —
 * same name AND same location, e.g. two classes' `handle` in one file — get
 * the qualifying symbol appended ("api/a.ts (A.handle)"), and the start line
 * as well if even that collides, so every row on a card is distinguishable.
 */
export function healthRowLocations(
  nodes: readonly Pick<CodeMapNode, 'id' | 'name' | 'file' | 'startLine'>[],
  projectPath: string | null,
): string[] {
  const base = nodes.map((node) => healthRowLocation(node, projectPath));
  const keyOf = (index: number) => `${nodes[index]!.name}\u0000${base[index]!}`;
  const rowsByKey = new Map<string, number[]>();
  nodes.forEach((_, index) => {
    const key = keyOf(index);
    rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), index]);
  });
  const locations = [...base];
  for (const rows of rowsByKey.values()) {
    if (rows.length < 2) {
      continue;
    }
    const qualified = rows.map((index) => qualifiedSymbolName(nodes[index]!));
    rows.forEach((index, position) => {
      const symbol = qualified[position]!;
      const unique = qualified.filter((other) => other === symbol).length === 1;
      locations[index] = unique
        ? `${base[index]!} (${symbol})`
        : `${base[index]!} (${symbol}, line ${nodes[index]!.startLine})`;
    });
  }
  return locations;
}

/**
 * P0-2b: the per-cluster cap's explicit remainder (AD-13's
 * explicit-result-state pattern applied to truncation) — never silent
 * truncation. Pure and exported so the pluralization is pinned by a test
 * rather than by reading the JSX.
 */
export function formatRemainingNodes(remainingNodeCount: number): string {
  return `+${formatCount(remainingNodeCount, 'more Node', 'more Nodes')}`;
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
export const HEALTH_ROW_AFFORDANCE = 'open Node detail';

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
 * `location` is the row's second line: a directory cluster merges every
 * file under it, so `a.ts` and `b.ts` can both contribute a `handle` and
 * would otherwise render as two identical rows. FIX-3: it is the Node's
 * project-relative file (`healthRowLocation`), not the qualified id the Path
 * Trace candidate list's `formatCandidateLocation` shows, and the grid
 * computes it per card (`healthRowLocations`) so two same-named rows from
 * one file get their qualifying symbol appended.
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
  location = healthRowLocation(member.node, null),
}: {
  member: HealthClusterNode;
  onActivate: (node: CodeMapNode) => void;
  /** FIX-3: this row's line from `healthRowLocations` (the grid passes it); defaults to the row's own `healthRowLocation`. */
  location?: string;
}) {
  const heat = heatForRiskCount(member.riskCount);
  const judgment = member.llmJudgment;
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
                {formatCountNumber(signal.value)}
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
  projectPath = null,
}: {
  grouping: HealthClusterGrouping;
  onActivateNode: (node: CodeMapNode) => void;
  /** FIX-3: the open project's root, so `healthRowLocations` can make an absolute `file` project-relative. */
  projectPath?: string | null;
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
        {grouping.clusters.map((cluster) => {
          const locations = healthRowLocations(
            cluster.nodes.map((member) => member.node),
            projectPath,
          );
          return (
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
                  location={locations[index]}
                />
              ))}
            </ul>
            {cluster.remainingNodeCount > 0 && (
              <p className="code-map__health-more">{formatRemainingNodes(cluster.remainingNodeCount)}</p>
            )}
          </li>
          );
        })}
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
export function clusterAriaLabel(
  nodeCount: number,
  willZoomInsteadOfExpand: boolean,
  changedCount: number,
  affectedCount = 0,
): string {
  const base = willZoomInsteadOfExpand
    ? `Cluster of ${formatCount(nodeCount, 'Node', 'Nodes')}, too many to expand — zoom in`
    : `Cluster of ${formatCount(nodeCount, 'Node', 'Nodes')}, expand`;
  const changed = changedCount > 0 ? `${base}, ${formatCountNumber(changedCount)} changed` : base;
  // P4-2 phase 3c: members that depend on a changed contract.
  return affectedCount > 0 ? `${changed}, ${formatCountNumber(affectedCount)} affected by changed contracts` : changed;
}

export function CodeMapClusterCard({ data }: NodeProps<CodeMapClusterFlowNode>) {
  const { cluster, onExpand, changedCount, affectedCount = 0 } = data;
  const willZoomInsteadOfExpand = cluster.nodeIds.length > CLUSTER_EXPAND_MAX;
  const classNames = ['code-map__cluster'];
  if (willZoomInsteadOfExpand) {
    classNames.push('code-map__cluster--zoom');
  }
  if (changedCount > 0) {
    classNames.push('code-map__cluster--changed');
  }
  if (affectedCount > 0) {
    classNames.push('code-map__cluster--contract-dependent');
  }
  return (
    <div
      className={classNames.join(' ')}
      tabIndex={0}
      role="button"
      aria-label={clusterAriaLabel(cluster.nodeIds.length, willZoomInsteadOfExpand, changedCount, affectedCount)}
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
          {formatCountNumber(changedCount)} changed
        </span>
      )}
      {affectedCount > 0 && (
        <span className="code-map__cluster-affected" aria-hidden="true">
          ⧉ {formatCountNumber(affectedCount)} affected
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type CodeMapAnyFlowNode = CodeMapCardFlowNode | CodeMapClusterFlowNode;

/**
 * P4-2 phase 3c: a folded kind's card ("Show types & modules"): kind, name,
 * file, and for a type "used by N". Activating it opens the type detail or
 * the Module's top-level source. MUST STAY HOOKLESS (rendered in tests).
 */
export function CodeMapFoldedCard({ data }: Pick<NodeProps<CodeMapFoldedFlowNode>, 'data'>) {
  const { folded, onActivate, isChanged } = data;
  const action = folded.kind === 'Module' ? 'open its top-level code' : 'open type detail';
  return (
    <div
      className={`code-map__node code-map__node--folded${isChanged ? ' code-map__node--changed' : ''}`}
      title={`${folded.file}:${folded.startLine}-${folded.endLine}`}
      tabIndex={0}
      role="button"
      aria-label={`Folded ${folded.kind} ${folded.name}${isChanged ? ', changed' : ''}, ${action}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(folded);
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="code-map__node-kind">{folded.kind} · folded</span>
      <code className="code-map__node-id">{folded.name}</code>
      {isChanged && (
        <p className="code-map__node-changed-badge" role="status">
          Changed
        </p>
      )}
      <p className="code-map__node-folded-file">
        <code>{folded.file}</code>
      </p>
      <p className="code-map__node-folded-note">
        {folded.usedByTotal !== undefined ? `Used by ${formatCountNumber(folded.usedByTotal)}` : 'File top-level code'}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = {
  codeMapNode: CodeMapNodeCard,
  codeMapCluster: CodeMapClusterCard,
  codeMapFolded: CodeMapFoldedCard,
  codeMapRevealRef: CodeMapRevealRefCard,
  codeMapRevealStub: CodeMapRevealStubCard,
};

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
  /**
   * P4-4 phase 2a: the section on screen (one allowlist entry), or `null` /
   * omitted for the whole scope. Path Trace, diff scope and Blast Radius
   * expansion are sent with it (`section ?? undefined`), and a reply for any
   * other section is dropped (`settleSectionScopedReply`). P4-4d's Section
   * bar supplies it; until then it is always the whole scope.
   */
  section?: string | null;
  /**
   * P4-4 phase 2a: called with the section when one of those operations
   * replies `unknown-section` — the shell falls back to `all` (P4-4d), as
   * for the Code Map fetch. The operation itself is reset to idle here.
   */
  onUnknownSection?: (section: string) => void;
  /**
   * P4-4 phase 3b: asks App to switch to another section, through the
   * Section bar's own switch (the full reset and its announcements) — from
   * PR Review's "changed elsewhere" line, or, with `focusNodeId`, from Node
   * detail's "Calls into other sections" (the callee is then handed back as
   * `pendingFocusNodeId`).
   */
  onSwitchSection: (section: string, focusNodeId?: string) => void;
  /**
   * P4-4 phase 3b: one-shot — a Node to select once the map of `section` is
   * ready (`decidePendingFocus`), then reported via `onPendingFocusConsumed`.
   * `null`/omitted for none.
   */
  pendingFocusNodeId?: string | null;
  /** P4-4 phase 3b: `pendingFocusNodeId` was applied (or found missing): App clears it. */
  onPendingFocusConsumed?: () => void;
}

/**
 * P4-4 phase 3b: what to do with a `pendingFocusNodeId`:
 * - `none`: there is none;
 * - `wait`: the map of `section` isn't ready yet (still the previous
 *   section's, loading or failed), or its canvas hasn't had its first fit;
 * - `focus`: centre the canvas on it (`navigateToNode`) and focus its card;
 * - `open-detail`: no canvas (Health Audit's grid) — open its Node detail;
 * - `missing`: the ready map doesn't have it — say so (`NOT_ON_CURRENT_MAP`),
 *   never a silent no-op.
 * Pure.
 */
export type PendingFocusDecision =
  | { kind: 'none' }
  | { kind: 'wait' }
  | { kind: 'focus'; id: string }
  | { kind: 'open-detail'; node: CodeMapNode }
  | { kind: 'missing'; id: string };

export function decidePendingFocus({
  pendingFocusNodeId,
  section,
  fetchState,
  canvas,
  canvasReady,
  resolveMapNode,
}: {
  pendingFocusNodeId: string | null;
  /** The section prop — the one App switched to. */
  section: string | null;
  fetchState: FetchState;
  /** `surfaces.canvas`. */
  canvas: boolean;
  /** The canvas has its React Flow instance and its first fit has landed. */
  canvasReady: boolean;
  /** The rendered map Node with this id, if any (`mapNodeOf(flowNodesById.get(id))`). */
  resolveMapNode: (id: string) => CodeMapNode | undefined;
}): PendingFocusDecision {
  if (pendingFocusNodeId === null) {
    return { kind: 'none' };
  }
  if (fetchState.status !== 'ready' || (fetchState.section ?? null) !== section) {
    return { kind: 'wait' };
  }
  const node = resolveMapNode(pendingFocusNodeId);
  if (node === undefined) {
    return { kind: 'missing', id: pendingFocusNodeId };
  }
  if (!canvas) {
    return { kind: 'open-detail', node };
  }
  return canvasReady ? { kind: 'focus', id: pendingFocusNodeId } : { kind: 'wait' };
}

/** Review round 1: how many animation frames the card focus waits for a culled card before focusing the canvas. */
export const CARD_FOCUS_MAX_FRAMES = 60;

/**
 * Review round 1: one frame of the card-focus wait — focus the card once it
 * is rendered; keep waiting; or, once `CARD_FOCUS_MAX_FRAMES` frames have
 * passed without it, focus the canvas wrapper, so focus never falls to
 * `<body>`. Pure.
 */
export function cardFocusStep(cardFound: boolean, framesTried: number): 'focus-card' | 'retry' | 'focus-canvas' {
  if (cardFound) {
    return 'focus-card';
  }
  return framesTried + 1 >= CARD_FOCUS_MAX_FRAMES ? 'focus-canvas' : 'retry';
}

/**
 * Review round 1: after PR Review's "Switch to api", where focus lands once
 * the map of that section is ready: the base-ref input when it can take
 * focus (PR Review, not disabled by a running diff), else the selected
 * Section bar tab. `wait` until that map is ready; `cancel` when the user
 * has since switched elsewhere. Pure.
 */
export function prReviewSwitchFocusTarget({
  targetSection,
  section,
  fetchState,
  baseRefFocusable,
}: {
  targetSection: string;
  section: string | null;
  fetchState: FetchState;
  baseRefFocusable: boolean;
}): 'wait' | 'cancel' | 'base-ref' | 'section-tab' {
  if (section !== targetSection) {
    return 'cancel';
  }
  if (fetchState.status !== 'ready' || (fetchState.section ?? null) !== targetSection) {
    return 'wait';
  }
  return baseRefFocusable ? 'base-ref' : 'section-tab';
}

/**
 * P4-4 phase 3b (founder decision 2026-10-04): what a section switch carries
 * out of PR Review — the base-ref input to re-run with (`input`, possibly
 * blank: auto-resolve), and the ref the Graph Service checks in the target's
 * repository (`ref`: the input, or with a blank input the resolved diff's
 * base commit).
 */
export interface DiffScopeCarry {
  from: string | null;
  to: string | null;
  ref: string;
  input: string;
}

/**
 * P4-4 phase 3b: the switch's carry, or `null` for none — only out of PR
 * Review, only for a real switch, and only with a diff to carry: a base ref
 * entered, or a resolved diff. Pure.
 */
export function diffScopeCarryCandidate({
  mode,
  diffScopeState,
  baseRefInput,
  from,
  to,
}: {
  mode: CodeMapMode;
  diffScopeState: DiffScopeState;
  baseRefInput: string;
  from: string | null;
  to: string | null;
}): DiffScopeCarry | null {
  if (mode !== 'prReview' || from === to) {
    return null;
  }
  const input = baseRefInput.trim();
  const ref = input.length > 0 ? input : diffScopeState.status === 'resolved' ? diffScopeState.resolvedBaseRef : '';
  return ref.length > 0 ? { from, to, ref, input } : null;
}

/**
 * P4-4 phase 3b: the Graph Service's answer → re-run in the new section (same
 * repository, or the ref exists in the target's repository), or reset
 * (anything else, including an error). Pure.
 */
export function diffScopeCarryDecision(result: DiffScopeCarryResult): 'rerun' | 'reset' {
  return result.status === 'same-repository' || result.status === 'ref-exists' ? 'rerun' : 'reset';
}

/**
 * P4-4 phase 3b: a carry check's reply applies only while it is the latest
 * check (no later switch, load or refresh bumped the id) and its target
 * section is still the one on screen — an old section's reply is dropped.
 * Pure.
 */
export function diffScopeCarryReplyApplies(
  carryId: number,
  latestCarryId: number,
  carryTo: string | null,
  currentSection: string | null,
): boolean {
  return carryId === latestCarryId && carryTo === currentSection;
}

/** Carry review: what a carry check's reply does — see `diffScopeCarrySettleAction`. */
export type DiffScopeCarrySettle = 'ignore' | 'rerun' | 'skip' | 'reset';

/**
 * Carry review: a carry check's reply → `ignore` (stale:
 * `diffScopeCarryReplyApplies`), `rerun` (carried, still in PR Review),
 * `skip` (carried, but PR Review was left meanwhile: no diff is run), or
 * `reset` (not carried, or the check failed). Pure.
 */
export function diffScopeCarrySettleAction({
  carryId,
  latestCarryId,
  carryTo,
  currentSection,
  mode,
  result,
}: {
  carryId: number;
  latestCarryId: number;
  carryTo: string | null;
  currentSection: string | null;
  mode: CodeMapMode;
  result: DiffScopeCarryResult;
}): DiffScopeCarrySettle {
  if (!diffScopeCarryReplyApplies(carryId, latestCarryId, carryTo, currentSection)) {
    return 'ignore';
  }
  if (diffScopeCarryDecision(result) === 'reset') {
    return 'reset';
  }
  return mode === 'prReview' ? 'rerun' : 'skip';
}

/**
 * Carry review: carries out `diffScopeCarrySettleAction` through `effects`
 * — nothing for a stale reply; otherwise `done` (the check is over), then at
 * most one of `rerun` / `reset`. Returns the action. Pure apart from the
 * effects it is given.
 */
export function applyDiffScopeCarryReply(
  input: Parameters<typeof diffScopeCarrySettleAction>[0],
  effects: { done: () => void; rerun: () => void; reset: () => void },
): DiffScopeCarrySettle {
  const action = diffScopeCarrySettleAction(input);
  if (action === 'ignore') {
    return action;
  }
  effects.done();
  if (action === 'rerun') {
    effects.rerun();
  } else if (action === 'reset') {
    effects.reset();
  }
  return action;
}

/** Carry review: "Checking whether origin/main applies in api/…" — shown while the check runs. */
export function diffScopeCarryCheckingText(carry: Pick<DiffScopeCarry, 'ref' | 'to'>): string {
  // `ref` is the typed input, or with a blank input the resolved diff's base commit.
  return `Checking whether ${carry.ref} applies in ${carry.to === null ? 'all sections' : `${carry.to}/`}…`;
}

/** P4-4 phase 3b: "Recomputing the diff against origin/main in api/…" — the re-run's status text. */
export function diffScopeCarryAnnouncement(carry: Pick<DiffScopeCarry, 'input' | 'to'>): string {
  const against = carry.input.length > 0 ? `against ${carry.input}` : 'against the auto-resolved base ref';
  return `Recomputing the diff ${against} in ${carry.to === null ? 'all sections' : `${carry.to}/`}…`;
}

/** Review round 1: the ids of the missed-callee notice's text and its Dismiss button (focused when it appears). */
export const CROSS_SECTION_MISS_TEXT_ID = 'code-map-cross-section-miss-text';
export const CROSS_SECTION_MISS_DISMISS_ID = 'code-map-cross-section-miss-dismiss';

/**
 * P4-4 phase 3b: a cross-section switch landed on a map without its callee —
 * "render in web/ — Not on the current map (hidden by scope or filters)",
 * with Dismiss. Hookless.
 */
export function CrossSectionMissNotice({
  name,
  section,
  onDismiss,
}: {
  name: string;
  section: string;
  onDismiss: () => void;
}) {
  return (
    <div className="code-map__path-trace-dismissable-notice">
      <ActionableNotice tone="info" role="status">
        <span id={CROSS_SECTION_MISS_TEXT_ID}>
          <code>{name}</code> in <code>{section}/</code> — {NOT_ON_CURRENT_MAP}
        </span>
      </ActionableNotice>
      {/* Review round 1: focused when the notice appears, and described by
          its text, so the reason is heard there too. */}
      <button
        type="button"
        id={CROSS_SECTION_MISS_DISMISS_ID}
        className="code-map__path-trace-dismiss"
        onClick={onDismiss}
        aria-describedby={CROSS_SECTION_MISS_TEXT_ID}
      >
        Dismiss
      </button>
    </div>
  );
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
  testedBy: 'code-map-node-detail-tested-by-heading',
  fileTopLevel: 'code-map-node-detail-file-top-level-heading',
  uses: 'code-map-node-detail-uses-heading',
  similar: 'code-map-node-detail-similar-heading',
  crossSectionCalls: 'code-map-node-detail-cross-section-calls-heading',
  entryPin: 'code-map-node-detail-entry-pin-heading',
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
  /** P4-2 phase 2: opens a "Tested by" row's test or test file in the source viewer (tests aren't map Nodes, so this never navigates the map). */
  onOpenTest: (target: SourceTarget) => void;
  /**
   * P4-2 phase 3a: the rendered map Node with this id, if the map can
   * navigate to it — names a "File top-level" entry. Defaults to none, so
   * every entry shows as not on the map.
   */
  resolveMapNode?: (id: string) => Pick<CodeMapNode, 'name'> | undefined;
  /** P4-2 phase 3a: navigates the map to a "File top-level" entry. Defaults to a no-op. */
  onNavigateToNode?: (id: string) => void;
  /**
   * P4-2 phase 3b: the folded type with this id, if the current map has it —
   * a "Uses" entry opens its type detail only then. Defaults to none.
   */
  resolveFoldedType?: (id: string) => FoldedType | undefined;
  /** P4-2 phase 3b: opens a "Uses" entry's type detail. Defaults to a no-op. */
  onOpenType?: (id: string) => void;
  /**
   * P4-4 phase 3b: the section the map on screen is for (`null` = `all`).
   * "Calls into other sections" shows only on a section map. Defaults to `all`.
   */
  mapSection?: string | null;
  /**
   * P4-4 phase 3b: a "Calls into other sections" row's switch — the callee's
   * section, then its id to select once that map is ready. Defaults to a no-op.
   */
  onSwitchSection?: (section: string, focusNodeId: string) => void;
  /**
   * P4-7g (AD-5 "Entry pins"): the "⚑ Pin as entry point" toggle — whether
   * this Node is pinned, whether a save is in flight, the explicit message
   * of the last toggle on it (the pin limit, a failed save), and the toggle.
   * Absent: no "Entry point" section.
   */
  entryPin?: EntryPinControl;
}

/** P4-7g: Node detail's pin toggle (see `NodeDetailBodyProps.entryPin`). */
export interface EntryPinControl {
  pinned: boolean;
  busy: boolean;
  message: string | null;
  onToggle: () => void;
}

/**
 * P4-7g: Node detail's "Entry point" section — a toggle button, "⚑ Pin as
 * entry point", with `aria-pressed` (review round 1: one stable label; the
 * frozen text's "⚑ Unpin entry point" wording is a founder option), a
 * visible "⚑ pinned by you" note while pinned (glyph plus text, so the
 * state never rests on colour or the pressed style alone; hidden from
 * assistive tech, which hears `aria-pressed`), and one `role="status"` line
 * for its explicit messages ("Pin limit (50) reached…"). Pinning ranks the
 * Node first among Revealed's entry candidates. Hookless.
 */
export function NodeDetailEntryPin({ control }: { control: EntryPinControl }) {
  return (
    <>
      <button
        type="button"
        className={`code-map__node-detail-pin${control.pinned ? ' code-map__node-detail-pin--pinned' : ''}`}
        aria-pressed={control.pinned}
        disabled={control.busy}
        onClick={control.onToggle}
      >
        <span aria-hidden="true">⚑ </span>
        {PIN_BUTTON_TEXT}
      </button>
      {control.pinned && (
        <span className="code-map__node-detail-pin-state" aria-hidden="true">
          {' '}⚑ {PINNED_BADGE_TEXT}
        </span>
      )}
      <p className="code-map__node-detail-pin-status" role="status">
        {control.message ?? ''}
      </p>
    </>
  );
}

const RESOLVE_NO_MAP_NODE = (): undefined => undefined;
const NAVIGATE_NOWHERE = (): void => {};
const SWITCH_NOWHERE = (): void => {};

/**
 * P4-4 phase 3b: how many cross-section callees exist beyond the listed ones
 * — `crossSectionCallsTotal` (P4-4g, the count before the
 * `CROSS_SECTION_CALLS_MAX` cap) less the list's length, never below 0.
 */
export function crossSectionCallsMore(node: Pick<CodeMapNode, 'crossSectionCalls' | 'crossSectionCallsTotal'>): number {
  return crossSectionCallsCount(node) - (node.crossSectionCalls?.length ?? 0);
}

/**
 * P4-4 review round 1: how many cross-section callees a Node has —
 * `max(crossSectionCallsTotal, listed)`, so a total without rows still shows
 * the section (as "+N more").
 */
export function crossSectionCallsCount(node: Pick<CodeMapNode, 'crossSectionCalls' | 'crossSectionCallsTotal'>): number {
  return Math.max(node.crossSectionCallsTotal ?? 0, node.crossSectionCalls?.length ?? 0);
}

/**
 * P4-4 phase 3b: a "Calls into other sections" row's switch: closes Node
 * detail, then asks App to switch to the callee's section and select the
 * callee once the new map is ready. Hookless, so it's testable.
 */
export function switchSectionFromDetail(
  section: string,
  focusNodeId: string,
  {
    closeNodeDetail,
    onSwitchSection,
  }: { closeNodeDetail: () => void; onSwitchSection: (section: string, focusNodeId: string) => void },
): void {
  closeNodeDetail();
  onSwitchSection(section, focusNodeId);
}

/**
 * P4-4 phase 3b: Node detail's "Calls into other sections" — this Node's
 * callees in other sections (`crossSectionCalls`, P4-4g), each "render ·
 * web/" with the button "Switch to web" (accessible name "Switch to web and
 * show render"), then "+N more" from `crossSectionCallsTotal`. Disabled,
 * with the shared title, while the Graph Service isn't live. Hookless, like
 * `NodeDetailBody`.
 */
export function NodeCrossSectionCalls({
  node,
  graphServiceAvailable,
  onSwitchSection,
}: {
  node: Pick<CodeMapNode, 'crossSectionCalls' | 'crossSectionCallsTotal'>;
  graphServiceAvailable: boolean;
  onSwitchSection: (section: string, focusNodeId: string) => void;
}) {
  const calls: readonly CrossSectionCall[] = node.crossSectionCalls ?? [];
  const more = crossSectionCallsMore(node);
  return (
    <>
      <ul className="code-map__node-detail-cross-section" aria-label="Calls into other sections">
        {calls.map((call) => (
          <li key={call.id}>
            <code>{call.name}</code> · <code>{call.section}/</code>{' '}
            <button
              type="button"
              {...sectionSwitchButtonProps(graphServiceAvailable, CROSS_SECTION_CALLS_HINT_ID, () =>
                onSwitchSection(call.section, call.id),
              )}
              aria-label={`Switch to ${call.section} and show ${call.name}`}
            >
              Switch to <code>{call.section}</code>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="code-map__more-list">+{formatCountNumber(more)} more</p>}
      {!graphServiceAvailable && calls.length > 0 && (
        <p id={CROSS_SECTION_CALLS_HINT_ID} className="code-map__switch-hint">
          {SECTION_SWITCH_UNAVAILABLE_HINT}
        </p>
      )}
    </>
  );
}

/** P4-2 phase 3a: how many "File top-level" entries (and, separately, "Called at load by" files) Node detail names before "+N more". */
export const NODE_DETAIL_FILE_TOP_LEVEL_ROWS = 5;

/** P4-2 phase 3a: the title and screen-reader text of a "File top-level" entry the map can't navigate to. */
export const NOT_ON_CURRENT_MAP = 'Not on the current map (hidden by scope or filters)';

/**
 * P4-2 phase 3a: navigates from a "File top-level" entry: closes Node detail
 * (it would cover the map) and moves the map to that Node, with history.
 * Hookless, so it's testable.
 */
export function navigateFromDetail(
  id: string,
  { closeNodeDetail, navigateToNode }: { closeNodeDetail: () => void; navigateToNode: (id: string) => void },
): void {
  closeNodeDetail();
  navigateToNode(id);
}

/** P4-2 phase 3a: how a file's top-level code reaches a Node, for an entry's accessible name. */
function topLevelVerb(kind: FileTopLevelUse['kind']): string {
  switch (kind) {
    case 'CALLS':
      return 'called';
    case 'USAGE':
      return 'used';
    case 'IMPORTS':
      return 'imported';
  }
}

function FileTopLevelEntry({
  use,
  resolveMapNode,
  onNavigateToNode,
}: {
  use: FileTopLevelUse;
  resolveMapNode: (id: string) => Pick<CodeMapNode, 'name'> | undefined;
  onNavigateToNode: (id: string) => void;
}) {
  const mapNode = resolveMapNode(use.id);
  // A target the rendered map can't navigate to is named by its id, and
  // says why it isn't a link.
  if (mapNode === undefined) {
    return (
      <code className="code-map__node-detail-file-top-level-id" title={NOT_ON_CURRENT_MAP}>
        {use.id}
        <span className="visually-hidden"> ({NOT_ON_CURRENT_MAP})</span>
      </code>
    );
  }
  return (
    <button
      type="button"
      className="code-map__link-button"
      onClick={() => onNavigateToNode(use.id)}
      aria-label={`Go to ${mapNode.name} (${topLevelVerb(use.kind)} by this file's top-level code)`}
    >
      <code>{mapNode.name}</code>
    </button>
  );
}

/** Entries separated by ", ", keyed by id (each id is listed once). */
function fileTopLevelEntries(
  uses: readonly FileTopLevelUse[],
  resolveMapNode: (id: string) => Pick<CodeMapNode, 'name'> | undefined,
  onNavigateToNode: (id: string) => void,
) {
  return uses.map((use, index) => (
    <Fragment key={use.id}>
      {index > 0 && ', '}
      <FileTopLevelEntry use={use} resolveMapNode={resolveMapNode} onNavigateToNode={onNavigateToNode} />
    </Fragment>
  ));
}

/** "a.ts, b.ts" as monospace file names, keyed by file. */
function loadCallerFiles(files: readonly string[]) {
  return files.map((file, index) => (
    <Fragment key={file}>
      {index > 0 && ', '}
      <code>{file}</code>
    </Fragment>
  ));
}

/**
 * P4-2 phase 3a: the "File top-level" section's content, from the folded
 * Module Nodes' real edges:
 *  - "Top-level code in this file uses: A, B…" (`fileTopLevel`) — each
 *    entry on the rendered map navigates to it;
 *  - "Called at load by: x.ts" (`calledAtLoadBy`) — the files whose
 *    top-level code calls or uses this Node, which has no map caller for it.
 * Each line names its first `NODE_DETAIL_FILE_TOP_LEVEL_ROWS` entries, then
 * a native `<details>` "+N more" with the rest. Hookless, like
 * `NodeDetailBody`.
 */
export function NodeFileTopLevel({
  uses = [],
  calledAtLoadBy = [],
  resolveMapNode = RESOLVE_NO_MAP_NODE,
  onNavigateToNode = NAVIGATE_NOWHERE,
}: {
  uses?: readonly FileTopLevelUse[];
  calledAtLoadBy?: readonly string[];
  resolveMapNode?: (id: string) => Pick<CodeMapNode, 'name'> | undefined;
  onNavigateToNode?: (id: string) => void;
}) {
  const rows = NODE_DETAIL_FILE_TOP_LEVEL_ROWS;
  const restUses = uses.slice(rows);
  const restCallers = calledAtLoadBy.slice(rows);
  return (
    <>
      {uses.length > 0 && (
        <p className="code-map__node-detail-file-top-level">
          Top-level code in this file uses: {fileTopLevelEntries(uses.slice(0, rows), resolveMapNode, onNavigateToNode)}
        </p>
      )}
      {restUses.length > 0 && (
        <details className="code-map__more">
          <summary>+{restUses.length} more</summary>
          <p className="code-map__more-list">{fileTopLevelEntries(restUses, resolveMapNode, onNavigateToNode)}</p>
        </details>
      )}
      {calledAtLoadBy.length > 0 && (
        <p className="code-map__node-detail-file-top-level code-map__node-detail-called-at-load">
          Called at load by: {loadCallerFiles(calledAtLoadBy.slice(0, rows))}
        </p>
      )}
      {restCallers.length > 0 && (
        <details className="code-map__more">
          <summary>+{restCallers.length} more</summary>
          <p className="code-map__more-list">{loadCallerFiles(restCallers)}</p>
        </details>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// P4-2 phase 3b: folded Type/Interface Nodes — Node detail's "Uses" section
// and the type detail panel (the Node detail surface's type variant).
// ---------------------------------------------------------------------------

const RESOLVE_NO_TYPE = (): undefined => undefined;

/** P4-2 phase 3b: how many types Node detail's "Uses" list names before "+N more". */
export const NODE_DETAIL_USES_ROWS = 8;

/** P4-2 phase 3b: how many users type detail's "Used by" list shows before "+N more". */
export const TYPE_DETAIL_USED_BY_ROWS = 20;

/** P4-2 phase 3b: the title and screen-reader text of a type the current map doesn't have. */
export const TYPE_NOT_ON_CURRENT_MAP = 'Not on the current map';

/** P4-2 phase 3b: the notice shown when an "open this type" action finds the type gone. */
export const TYPE_GONE_NOTICE = 'That type is no longer on the map.';

/** P4-2 phase 3b: "interface" / "type", for accessible names and the type detail head. */
export function foldedTypeNoun(kind: FoldedType['kind']): string {
  return kind === 'Interface' ? 'interface' : 'type';
}

/** P4-2 phase 3b: a Node kind as a counted noun — "function"/"functions", "method"/"methods", … */
function kindNoun(kind: string, count: number): string {
  const singular = kind === 'Module' ? 'file top level' : kind.toLowerCase();
  return count === 1 ? singular : `${singular}s`;
}

/**
 * P4-2 phase 3b: type detail's user count, naming the counted kinds —
 * "Used by 59 functions", "Used by 59 (57 functions, 2 methods)" — or
 * neutral ("Used by 59") when the kinds aren't known. Users whose kind is
 * missing from `kinds` are counted as "other". "Used by nothing on the map"
 * for none.
 */
export function formatUsedByCount(total: number, kinds: readonly FoldedTypeUserKindCount[] = []): string {
  if (total === 0) {
    return 'Used by nothing on the map';
  }
  const counted = kinds.reduce((sum, entry) => sum + entry.count, 0);
  if (kinds.length === 0 || counted > total) {
    return `Used by ${total}`;
  }
  if (kinds.length === 1 && counted === total) {
    return `Used by ${total} ${kindNoun(kinds[0]!.kind, total)}`;
  }
  const parts = kinds.map((entry) => `${entry.count} ${kindNoun(entry.kind, entry.count)}`);
  if (counted < total) {
    parts.push(`${total - counted} other`);
  }
  return `Used by ${total} (${parts.join(', ')})`;
}

function TypeLink({
  use,
  resolveFoldedType,
  onOpenType,
}: {
  use: Pick<TypeUse, 'id' | 'name' | 'kind'>;
  resolveFoldedType: (id: string) => FoldedType | undefined;
  onOpenType: (id: string) => void;
}) {
  if (resolveFoldedType(use.id) === undefined) {
    return (
      <code className="code-map__node-detail-type-id" title={TYPE_NOT_ON_CURRENT_MAP}>
        {use.name}
        <span className="visually-hidden"> ({TYPE_NOT_ON_CURRENT_MAP})</span>
      </code>
    );
  }
  return (
    <button
      type="button"
      className="code-map__link-button"
      onClick={() => onOpenType(use.id)}
      aria-label={`Open ${foldedTypeNoun(use.kind)} ${use.name}`}
    >
      <code>{use.name}</code>
    </button>
  );
}

/** Types as inline, comma-separated links, keyed by id. */
function typeLinks(
  uses: readonly Pick<TypeUse, 'id' | 'name' | 'kind'>[],
  resolveFoldedType: (id: string) => FoldedType | undefined,
  onOpenType: (id: string) => void,
) {
  return uses.map((use, index) => (
    <Fragment key={use.id}>
      {index > 0 && ', '}
      <TypeLink use={use} resolveFoldedType={resolveFoldedType} onOpenType={onOpenType} />
    </Fragment>
  ));
}

/** Types as `<li>` links, keyed by id. */
function typeListItems(
  uses: readonly Pick<TypeUse, 'id' | 'name' | 'kind'>[],
  resolveFoldedType: (id: string) => FoldedType | undefined,
  onOpenType: (id: string) => void,
) {
  return uses.map((use) => (
    <li key={use.id}>
      <TypeLink use={use} resolveFoldedType={resolveFoldedType} onOpenType={onOpenType} />
    </li>
  ));
}

/**
 * P4-2 phase 3b: a list of types (`<ul>`), the first `rows`, then a native
 * `<details>` "+N more" holding the rest in a second `<ul>`. `label` names
 * the list for assistive tech. Hookless.
 */
function TypeList({
  uses,
  rows,
  label,
  className,
  resolveFoldedType,
  onOpenType,
}: {
  uses: readonly Pick<TypeUse, 'id' | 'name' | 'kind'>[];
  rows: number;
  label: string;
  className: string;
  resolveFoldedType: (id: string) => FoldedType | undefined;
  onOpenType: (id: string) => void;
}) {
  const rest = uses.slice(rows);
  return (
    <>
      <ul className={className} aria-label={label}>
        {typeListItems(uses.slice(0, rows), resolveFoldedType, onOpenType)}
      </ul>
      {rest.length > 0 && (
        <details className="code-map__more">
          <summary>+{rest.length} more</summary>
          <ul className={`${className} code-map__more-list`} aria-label={`${label}, continued`}>
            {typeListItems(rest, resolveFoldedType, onOpenType)}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * P4-2 phase 3b: Node detail's "Uses" list — the types this Node uses
 * through a real `USAGE` edge (`CodeMapNode.usesTypes`), never inferred
 * from its signature. The first `NODE_DETAIL_USES_ROWS`, then "+N more".
 * Each type the current map has opens its type detail. Hookless.
 */
export function NodeUsesTypes({
  uses = [],
  resolveFoldedType = RESOLVE_NO_TYPE,
  onOpenType = NAVIGATE_NOWHERE,
}: {
  uses?: readonly TypeUse[];
  resolveFoldedType?: (id: string) => FoldedType | undefined;
  onOpenType?: (id: string) => void;
}) {
  return (
    <TypeList
      uses={uses}
      rows={NODE_DETAIL_USES_ROWS}
      label="Types this Node uses"
      className="code-map__node-detail-uses"
      resolveFoldedType={resolveFoldedType}
      onOpenType={onOpenType}
    />
  );
}

/**
 * P4-2 phase 3a + 3b: the "File top-level" row's type line — "Top-level
 * code in this file uses types: A, B" (`CodeMapNode.fileTopLevelTypes`).
 * Hookless.
 */
export function NodeFileTopLevelTypes({
  types = [],
  resolveFoldedType = RESOLVE_NO_TYPE,
  onOpenType = NAVIGATE_NOWHERE,
}: {
  types?: readonly TypeUse[];
  resolveFoldedType?: (id: string) => FoldedType | undefined;
  onOpenType?: (id: string) => void;
}) {
  const rows = NODE_DETAIL_FILE_TOP_LEVEL_ROWS;
  const rest = types.slice(rows);
  if (types.length === 0) {
    return null;
  }
  return (
    <>
      <p className="code-map__node-detail-file-top-level code-map__node-detail-file-top-level-types">
        Top-level code in this file uses types: {typeLinks(types.slice(0, rows), resolveFoldedType, onOpenType)}
      </p>
      {rest.length > 0 && (
        <details className="code-map__more">
          <summary>+{rest.length} more</summary>
          <p className="code-map__more-list">{typeLinks(rest, resolveFoldedType, onOpenType)}</p>
        </details>
      )}
    </>
  );
}

/**
 * P4-2 phase 3b: opens a type's detail from Node detail, type detail or
 * Path Trace. Checks the type is still on the map BEFORE changing anything:
 * a gone type calls `onMissing` (the "no longer on the map" notice) and
 * leaves every open panel as it is. The type detail stacks over Node detail
 * (Escape returns to the Node) and, from another type, replaces the top
 * layer. Returns whether it opened. Hookless, so it's testable.
 */
export function openTypeFromDetail(
  id: string,
  {
    resolveFoldedType,
    openTypeDetail,
    onMissing,
  }: {
    resolveFoldedType: (id: string) => FoldedType | undefined;
    openTypeDetail: (type: FoldedType) => void;
    onMissing: () => void;
  },
): boolean {
  const type = resolveFoldedType(id);
  if (type === undefined) {
    onMissing();
    return false;
  }
  openTypeDetail(type);
  return true;
}

/**
 * P4-2 phase 3b: navigates from a type detail's "Used by" entry: closes the
 * type detail and any Node detail under it (both would cover the map), then
 * moves the map to that Node, with history. Hookless.
 */
export function navigateFromTypeDetail(
  id: string,
  {
    closeTypeDetail,
    closeNodeDetail,
    navigateToNode,
  }: { closeTypeDetail: () => void; closeNodeDetail: () => void; navigateToNode: (id: string) => void },
): void {
  closeTypeDetail();
  closeNodeDetail();
  navigateToNode(id);
}

const NO_FOLDED_TYPES: readonly FoldedType[] = [];
const IDLE_TRACE: PathTraceState = { status: 'idle' };
const NO_MAP_NODES: readonly CodeMapNode[] = [];
const CLOSED_TYPE: TypeDetailState = { status: 'closed' };

/** P4-2 phase 3b: the type detail panel's state — the Node detail surface's type variant. */
export type TypeDetailState = { status: 'closed' } | { status: 'open'; type: FoldedType };

/**
 * P4-2 phase 3b: an open type detail follows its type to fresh
 * `foldedTypes` (by id), or closes when the type is gone. Pure.
 */
export function refreshTypeDetail(state: TypeDetailState, foldedTypes: readonly FoldedType[]): TypeDetailState {
  if (state.status === 'closed') {
    return state;
  }
  const fresh = foldedTypes.find((type) => type.id === state.type.id);
  return fresh === undefined ? { status: 'closed' } : { status: 'open', type: fresh };
}

/**
 * P4-2 phase 3b: what a map refresh's outcome does to the type detail and
 * to a Path Trace "is a type" notice: new data re-points both at the fresh
 * types (a gone type closes the detail and drops out of the notice, which
 * clears when none is left); an error that replaces the map closes the
 * detail and clears the notice; anything else leaves both alone. Pure.
 */
export function foldedTypeStateAfterRefresh(
  outcome: Pick<RefreshOutcome, 'kind'> & { foldedTypes?: readonly FoldedType[] },
  typeDetail: TypeDetailState,
  pathTrace: PathTraceState,
): { typeDetail: TypeDetailState; pathTrace: PathTraceState } {
  if (outcome.kind === 'replace-with-error') {
    return {
      typeDetail: { status: 'closed' },
      pathTrace: pathTrace.status === 'folded-type' ? { status: 'idle' } : pathTrace,
    };
  }
  if (outcome.kind !== 'apply') {
    return { typeDetail, pathTrace };
  }
  const fresh = outcome.foldedTypes ?? NO_FOLDED_TYPES;
  let nextTrace = pathTrace;
  if (pathTrace.status === 'folded-type') {
    const byId = new Map(fresh.map((type) => [type.id, type]));
    const still = pathTrace.types.flatMap((type) => {
      const current = byId.get(type.id);
      return current === undefined ? [] : [current];
    });
    nextTrace = still.length === 0 ? { status: 'idle' } : { ...pathTrace, types: still };
  }
  return { typeDetail: refreshTypeDetail(typeDetail, fresh), pathTrace: nextTrace };
}

/** P4-2 phase 3b: the type detail panel's section heading ids (`aria-labelledby`). */
export const TYPE_DETAIL_SECTION_HEADING_IDS = {
  usedBy: 'code-map-type-detail-used-by-heading',
  implements: 'code-map-type-detail-implements-heading',
  implementedBy: 'code-map-type-detail-implemented-by-heading',
  refersTo: 'code-map-type-detail-refers-to-heading',
  referencedByTypes: 'code-map-type-detail-referenced-by-types-heading',
  location: 'code-map-type-detail-location-heading',
} as const;

/**
 * P4-2 phase 3b: the type detail head — module line, name and kind, and the
 * same "[esc] close" button as `NodeDetailHead`. Hookless.
 */
export function TypeDetailHead({ type, onClose }: { type: FoldedType; onClose: () => void }) {
  const moduleLine = nodeModuleLine(type.file);
  return (
    <div className="code-map__node-detail-head">
      <div className="code-map__node-detail-title">
        {moduleLine !== null && (
          <div className="code-map__node-detail-module" title={moduleLine}>
            {moduleLine}
          </div>
        )}
        <code className="code-map__node-detail-name">
          <span className="code-map__node-detail-name-text" title={type.name}>
            {type.name}
          </span>
          <span className="code-map__node-detail-paren"> {foldedTypeNoun(type.kind)}</span>
        </code>
      </div>
      <button type="button" className="code-map__node-detail-close" onClick={onClose}>
        [esc] close<span className="visually-hidden"> type detail</span>
      </button>
    </div>
  );
}

function UsedByEntry({
  id,
  typeName,
  resolveMapNode,
  onNavigateToNode,
}: {
  id: string;
  typeName: string;
  resolveMapNode: (id: string) => Pick<CodeMapNode, 'name'> | undefined;
  onNavigateToNode: (id: string) => void;
}) {
  const mapNode = resolveMapNode(id);
  if (mapNode === undefined) {
    return (
      <code className="code-map__node-detail-file-top-level-id" title={NOT_ON_CURRENT_MAP}>
        {id}
        <span className="visually-hidden"> ({NOT_ON_CURRENT_MAP})</span>
      </code>
    );
  }
  return (
    <button
      type="button"
      className="code-map__link-button"
      onClick={() => onNavigateToNode(id)}
      aria-label={`Go to ${mapNode.name} (uses ${typeName})`}
    >
      <code>{mapNode.name}</code>
    </button>
  );
}

function usedByItems(
  ids: readonly string[],
  typeName: string,
  resolveMapNode: (id: string) => Pick<CodeMapNode, 'name'> | undefined,
  onNavigateToNode: (id: string) => void,
) {
  return ids.map((id) => (
    <li key={id}>
      <UsedByEntry id={id} typeName={typeName} resolveMapNode={resolveMapNode} onNavigateToNode={onNavigateToNode} />
    </li>
  ));
}

export interface TypeDetailBodyProps {
  type: FoldedType;
  /** The rendered map Node with this id, if the map can navigate to it — names a "Used by" entry. */
  resolveMapNode?: (id: string) => Pick<CodeMapNode, 'name'> | undefined;
  /** Navigates the map to a "Used by" entry. */
  onNavigateToNode?: (id: string) => void;
  /** Resolves a linked type (Implements, Refers to, …) to its folded type. */
  resolveFoldedType?: (id: string) => FoldedType | undefined;
  /** Opens a linked type's detail. */
  onOpenType?: (id: string) => void;
}

/**
 * P4-2 phase 3b: the type detail body, every row from a real backend edge:
 *  - "Used by" — `formatUsedByCount` (kinds named), then the users (the
 *    first `TYPE_DETAIL_USED_BY_ROWS`, then "+N more"), each navigating to
 *    that Node; users beyond what the map reply carries are counted;
 *  - "Implements" / "Implemented by" — `IMPLEMENTS` edges, both ways;
 *  - "Refers to" / "Referenced by types" — `USAGE` edges between types;
 *  - Location.
 * A link row appears only when it has entries. Hookless.
 */
export function TypeDetailBody({
  type,
  resolveMapNode = RESOLVE_NO_MAP_NODE,
  onNavigateToNode = NAVIGATE_NOWHERE,
  resolveFoldedType = RESOLVE_NO_TYPE,
  onOpenType = NAVIGATE_NOWHERE,
}: TypeDetailBodyProps) {
  const ids = TYPE_DETAIL_SECTION_HEADING_IDS;
  const shown = type.usedBy.slice(0, TYPE_DETAIL_USED_BY_ROWS);
  const rest = type.usedBy.slice(TYPE_DETAIL_USED_BY_ROWS);
  const unlisted = Math.max(0, type.usedByTotal - type.usedBy.length);
  const countText = formatUsedByCount(type.usedByTotal, type.usedByKinds);
  const asUses = (typeIds: readonly string[]) =>
    typeIds.map((id) => {
      const target = resolveFoldedType(id);
      return { id, name: target?.name ?? id, kind: target?.kind ?? ('Type' as const) };
    });
  const linkRows: { key: keyof typeof ids; heading: string; label: string; typeIds: readonly string[] }[] = [
    { key: 'implements', heading: 'Implements', label: `Types ${type.name} implements or extends`, typeIds: type.implements },
    {
      key: 'implementedBy',
      heading: 'Implemented by / Extended by',
      label: `Types that implement or extend ${type.name}`,
      typeIds: type.implementedBy,
    },
    { key: 'refersTo', heading: 'Refers to', label: `Types ${type.name} refers to`, typeIds: type.refersTo },
    {
      key: 'referencedByTypes',
      heading: 'Referenced by types',
      label: `Types that refer to ${type.name}`,
      typeIds: type.referencedByTypes,
    },
  ];
  return (
    <div className="code-map__node-detail-body">
      <section className="code-map__node-detail-section" aria-labelledby={ids.usedBy}>
        <h3 id={ids.usedBy} className="code-map__node-detail-label">
          Used by
        </h3>
        <p className="code-map__type-detail-used-by-count">{countText}</p>
        {shown.length > 0 && (
          <ul className="code-map__type-detail-used-by" aria-label={countText}>
            {usedByItems(shown, type.name, resolveMapNode, onNavigateToNode)}
          </ul>
        )}
        {rest.length > 0 && (
          <details className="code-map__more">
            <summary>+{rest.length} more</summary>
            <ul className="code-map__type-detail-used-by code-map__more-list" aria-label={`${countText}, continued`}>
              {usedByItems(rest, type.name, resolveMapNode, onNavigateToNode)}
            </ul>
          </details>
        )}
        {unlisted > 0 && (
          <p className="code-map__type-detail-used-by-unlisted">
            {unlisted} more not listed here — the full list is on the agent surface (<code>lookup_node</code>).
          </p>
        )}
      </section>
      {linkRows
        .filter((row) => row.typeIds.length > 0)
        .map((row) => (
          <section key={row.key} className="code-map__node-detail-section" aria-labelledby={ids[row.key]}>
            <h3 id={ids[row.key]} className="code-map__node-detail-label">
              {row.heading}
            </h3>
            <TypeList
              uses={asUses(row.typeIds)}
              rows={NODE_DETAIL_USES_ROWS}
              label={row.label}
              className="code-map__node-detail-uses"
              resolveFoldedType={resolveFoldedType}
              onOpenType={onOpenType}
            />
          </section>
        ))}
      <section
        className="code-map__node-detail-section code-map__node-detail-section--location"
        aria-labelledby={ids.location}
      >
        <h3 id={ids.location} className="code-map__node-detail-label">
          Location
        </h3>
        <p className="code-map__node-detail-location">
          <code>{formatNodeLocation(type.file, type.startLine, type.endLine)}</code>
        </p>
      </section>
    </div>
  );
}

/** P4-2 phase 3b: where a folded type opens in the source viewer. */
export function foldedTypeSourceTarget(type: FoldedType): SourceTarget {
  return { file: type.file, startLine: type.startLine, endLine: type.endLine, label: type.name };
}

const compareTypeIds = (a: FoldedType, b: FoldedType): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** P4-2 phase 3b: `resolvePathTraceQuery`'s answer before a trace: show a type notice instead, or trace. */
export type PathTracePreCheck = { skipTrace: true; state: PathTraceState } | { skipTrace: false };

/**
 * P4-2 phase 3b: Path Trace's whole decision about folded types, pure.
 * Path Trace is CALLS-only and types are folded off the map, so a query
 * naming a type would otherwise read as "No path found".
 *
 * Before the trace (no `traceResult`): an exact (case-insensitive) type id,
 * then an exact type name, that no map Node matches the same way skips the
 * trace for the "is a type" notice (`status: 'folded-type'`) — every type
 * with that name, sorted by id, so two same-named types get a chooser, never
 * a silent first pick. A real function with that name still traces.
 *
 * After the trace (`traceResult` given): only a `'no-path-found'` is looked
 * at — in `traceCallPath` that means no entry resolved at any tier (not "an
 * entry with no calls", which is a one-Node `'found'`), so no map Node's
 * name even contains the query. Then the types whose name contains it are
 * offered the same way. `'found'`, `'ambiguous'` and `'error'` pass through
 * unchanged.
 */
export function resolvePathTraceQuery(
  query: string,
  mapNodes: readonly Pick<CodeMapNode, 'id' | 'name'>[],
  foldedTypes: readonly FoldedType[],
): PathTracePreCheck;
export function resolvePathTraceQuery(
  query: string,
  mapNodes: readonly Pick<CodeMapNode, 'id' | 'name'>[],
  foldedTypes: readonly FoldedType[],
  traceResult: Exclude<PathTraceResult, UnknownSectionResult>,
): PathTraceState;
export function resolvePathTraceQuery(
  query: string,
  mapNodes: readonly Pick<CodeMapNode, 'id' | 'name'>[],
  foldedTypes: readonly FoldedType[],
  traceResult?: Exclude<PathTraceResult, UnknownSectionResult>,
): PathTracePreCheck | PathTraceState {
  const q = query.trim().toLowerCase();
  const typeNotice = (types: FoldedType[]): PathTraceState => ({
    status: 'folded-type',
    query: query.trim(),
    types: [...types].sort(compareTypeIds),
  });
  if (traceResult !== undefined) {
    if (traceResult.status !== 'no-path-found' || q.length === 0) {
      return traceResult;
    }
    const matches = foldedTypes.filter((type) => type.name.toLowerCase().includes(q));
    return matches.length > 0 ? typeNotice(matches) : traceResult;
  }
  if (q.length === 0 || mapNodes.some((node) => node.id.toLowerCase() === q)) {
    return { skipTrace: false };
  }
  const byId = foldedTypes.filter((type) => type.id.toLowerCase() === q);
  if (byId.length > 0) {
    return { skipTrace: true, state: typeNotice(byId.slice(0, 1)) };
  }
  if (mapNodes.some((node) => node.name.toLowerCase() === q)) {
    return { skipTrace: false };
  }
  const byName = foldedTypes.filter((type) => type.name.toLowerCase() === q);
  return byName.length > 0 ? { skipTrace: true, state: typeNotice(byName) } : { skipTrace: false };
}

/**
 * P4-2 phase 3b: Path Trace's "is a type" notice. One type: "<name> is a
 * type — open its detail", with that action. Several (same name, or several
 * names containing the query): "N types match <query> — pick one", with one
 * open action per type, named by its file. Hookless.
 */
export function PathTraceFoldedTypeNotice({
  query,
  types,
  onOpenType,
  onDismiss,
}: {
  query: string;
  types: readonly FoldedType[];
  onOpenType: (id: string) => void;
  onDismiss: () => void;
}) {
  const [only] = types;
  if (types.length === 1 && only !== undefined) {
    const noun = foldedTypeNoun(only.kind);
    return (
      <div className="code-map__path-trace-dismissable-notice">
        <ActionableNotice
          tone="info"
          role="status"
          action={
            <button
              type="button"
              className="code-map__link-button"
              onClick={() => onOpenType(only.id)}
              aria-label={`Open its detail — ${only.name}`}
            >
              Open its detail
            </button>
          }
        >
          <code>{only.name}</code> is {noun === 'interface' ? 'an interface' : 'a type'} — open its detail.
        </ActionableNotice>
        <button type="button" className="code-map__path-trace-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div className="code-map__path-trace-dismissable-notice">
      <ActionableNotice tone="info" role="status">
        {types.length} types match <code>{query}</code> — pick one to open its detail.
      </ActionableNotice>
      <ul className="code-map__type-choices" aria-label={`Types matching ${query}`}>
        {types.map((type) => (
          <li key={type.id}>
            <button
              type="button"
              className="code-map__link-button"
              onClick={() => onOpenType(type.id)}
              aria-label={`Open ${foldedTypeNoun(type.kind)} ${type.name} in ${type.file}`}
            >
              <code>{type.name}</code> <span className="code-map__type-choice-file">{type.file}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="code-map__path-trace-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/** P4-2 phase 3b: the "no longer on the map" notice an open-type action shows when its type is gone. Hookless. */
export function TypeGoneNotice() {
  return (
    <ActionableNotice tone="warning" role="status">
      {TYPE_GONE_NOTICE}
    </ActionableNotice>
  );
}

/** P4-2 phase 2: how many "Tested by" test rows (and, separately, test files) Node detail shows before "+N more". */
export const NODE_DETAIL_TESTED_BY_ROWS = 5;

/** P4-2 phase 2: the copy for a Node with no test link. Never "untested": the backend's test links are incomplete. */
export const NO_TEST_LINK_FOUND = 'No test link found';

/** P4-2 phase 2: where a "Tested by" test row opens the source viewer, named for its header. */
export function testSourceTarget(test: TestedByTest): SourceTarget {
  return {
    file: test.file,
    startLine: test.startLine,
    endLine: test.endLine,
    label: test.topLevel === true ? `${test.file} (top-level)` : test.name,
  };
}

/** P4-2 phase 2: where a "Tests for this file" entry opens — the file's start — or `undefined` when the index gave it no range. */
export function testFileSourceTarget(file: TestedByFile): SourceTarget | undefined {
  if (file.startLine === undefined || file.endLine === undefined) {
    return undefined;
  }
  return { file: file.file, startLine: file.startLine, endLine: file.endLine, label: file.file };
}

/**
 * P4-2 phase 2: opens a "Tested by" row's source from Node detail. The
 * source viewer stacks over Node detail as the top modal layer (P2-7/8), so
 * Escape (or its close button) returns to the same Node detail. Node detail
 * is therefore deliberately left open: `closeNodeDetail` is taken only so
 * that choice is explicit, and is never called. Hookless, so it's testable.
 */
export function openTestFromDetail(
  target: SourceTarget,
  { openSourceForNode }: { closeNodeDetail: () => void; openSourceForNode: (target: SourceTarget) => void },
): void {
  openSourceForNode(target);
}

function TestedByTestRow({ test, onOpenTest }: { test: TestedByTest; onOpenTest: (target: SourceTarget) => void }) {
  const location = `${test.file}:${test.startLine}`;
  const topLevel = test.topLevel === true;
  return (
    <li>
      <button
        type="button"
        className="code-map__node-detail-test"
        onClick={() => onOpenTest(testSourceTarget(test))}
        aria-label={topLevel ? `Open top-level test code at ${location}` : `Open test ${test.name} at ${location}`}
      >
        {topLevel ? (
          <>
            <code className="code-map__node-detail-test-file">{location}</code>{' '}
            <span className="code-map__node-detail-test-top-level">(top-level)</span>
          </>
        ) : (
          <>
            <code className="code-map__node-detail-test-name">{test.name}</code>{' '}
            <code className="code-map__node-detail-test-file">{location}</code>
          </>
        )}
      </button>
    </li>
  );
}

function TestedByFileRow({ file, onOpenTest }: { file: TestedByFile; onOpenTest: (target: SourceTarget) => void }) {
  const target = testFileSourceTarget(file);
  return (
    <li>
      {target === undefined ? (
        <code className="code-map__node-detail-test-file">{file.file}</code>
      ) : (
        <button
          type="button"
          className="code-map__node-detail-test"
          onClick={() => onOpenTest(target)}
          aria-label={`Open test file ${file.file}`}
        >
          <code className="code-map__node-detail-test-file">{file.file}</code>
        </button>
      )}
    </li>
  );
}

/**
 * P4-2 phase 2: the "Tested by" section's content.
 *
 * - Direct tests: the first `NODE_DETAIL_TESTED_BY_ROWS` rows, then a
 *   native `<details>` expander ("+N more", N counted against the full
 *   `totalTests`) holding the rest of the carried tests (up to
 *   `TESTED_BY_MAX_TESTS`) and, as P2-4's capped lists do, a "Showing the
 *   first X of Y" line when the Graph Service carried fewer than exist.
 * - "Tests for this file": `TESTS_FILE` files not already listed as a direct
 *   test's file, each opening the file's start; capped the same way.
 * - No evidence at all: "No test link found", muted — never "untested", and
 *   never while `totalTests > 0`.
 *
 * Every row opens the source viewer via `onOpenTest`; tests are not map
 * Nodes, so nothing here navigates the map. Hookless, like `NodeDetailBody`.
 */
export function NodeTestedBy({
  testedBy,
  onOpenTest,
}: {
  testedBy: TestedBy | undefined;
  onOpenTest: (target: SourceTarget) => void;
}) {
  const tests = testedBy?.tests ?? [];
  // `totalTests < tests.length` must never happen; if it does, count what is carried.
  const total = Math.max(testedBy?.totalTests ?? 0, tests.length);
  const testFilesListed = new Set(tests.map((test) => test.file));
  const files = (testedBy?.files ?? []).filter((file) => !testFilesListed.has(file.file));
  if (total === 0 && files.length === 0) {
    return <p className="code-map__node-detail-tested-by-none">{NO_TEST_LINK_FOUND}</p>;
  }

  const shown = tests.slice(0, NODE_DETAIL_TESTED_BY_ROWS);
  const rest = tests.slice(NODE_DETAIL_TESTED_BY_ROWS);
  const more = total - shown.length;
  const shownFiles = files.slice(0, NODE_DETAIL_TESTED_BY_ROWS);
  const restFiles = files.slice(NODE_DETAIL_TESTED_BY_ROWS);
  return (
    <>
      {shown.length > 0 && (
        <ul className="code-map__node-detail-tests">
          {shown.map((test) => (
            <TestedByTestRow key={`${test.id}:${test.file}:${test.startLine}`} test={test} onOpenTest={onOpenTest} />
          ))}
        </ul>
      )}
      {more > 0 && (
        <details className="code-map__node-detail-tests-more">
          <summary>+{more} more</summary>
          {rest.length > 0 && (
            <ul className="code-map__node-detail-tests">
              {rest.map((test) => (
                <TestedByTestRow key={`${test.id}:${test.file}:${test.startLine}`} test={test} onOpenTest={onOpenTest} />
              ))}
            </ul>
          )}
          {tests.length < total && (
            <p className="code-map__node-detail-tests-truncated">
              Showing the first {tests.length} of {total}.
            </p>
          )}
        </details>
      )}
      {files.length > 0 && (
        <div className="code-map__node-detail-test-files">
          <p className="code-map__node-detail-test-files-label">Tests for this file:</p>
          <ul className="code-map__node-detail-tests">
            {shownFiles.map((file) => (
              <TestedByFileRow key={file.file} file={file} onOpenTest={onOpenTest} />
            ))}
          </ul>
          {restFiles.length > 0 && (
            <details className="code-map__node-detail-tests-more">
              <summary>+{restFiles.length} more</summary>
              <ul className="code-map__node-detail-tests">
                {restFiles.map((file) => (
                  <TestedByFileRow key={file.file} file={file} onOpenTest={onOpenTest} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </>
  );
}

/** P4-2 phase 4: how many "Similar implementations" rows Node detail shows before "+N more". */
export const NODE_DETAIL_SIMILAR_ROWS = 5;

/** P4-2 phase 4: the honest-copy line under "Similar implementations". */
export const SIMILARITY_DISCLAIMER = 'Similarity is structural (token overlap), not a claim they behave the same.';

/** P4-2 phase 4: a `SIMILAR_TO` jaccard as shown — "similarity 1.00". */
export function formatSimilarity(score: number): string {
  // Floored, so a 0.996 near-duplicate never reads as an identical "1.00".
  return `similarity ${(Math.floor(score * 100 + 1e-9) / 100).toFixed(2)}`;
}

/** P4-2 phase 4: the section heading — "Similar implementations (N)", N the full count. */
export function similarHeading(node: Pick<CodeMapNode, 'similarTo' | 'similarToTotal'>): string {
  return `Similar implementations (${similarTotal(node)})`;
}

/** The full count: `similarToTotal`, never below what is carried. */
function similarTotal(node: Pick<CodeMapNode, 'similarTo' | 'similarToTotal'>): number {
  return Math.max(node.similarToTotal ?? 0, node.similarTo?.length ?? 0);
}

function SimilarRow({
  similar,
  resolveMapNode,
  onNavigateToNode,
}: {
  similar: SimilarImplementation;
  resolveMapNode: (id: string) => Pick<CodeMapNode, 'name'> | undefined;
  onNavigateToNode: (id: string) => void;
}) {
  const score = formatSimilarity(similar.score);
  const details = (
    <>
      {' '}
      <span className="code-map__node-detail-similar-file">
        <code>{similar.file}</code>
      </span>{' '}
      <span className="code-map__node-detail-similar-score">{score}</span>
    </>
  );
  // A Node the rendered map can't navigate to is named, and says why it
  // isn't a link.
  if (resolveMapNode(similar.id) === undefined) {
    return (
      <li>
        <code className="code-map__node-detail-file-top-level-id" title={NOT_ON_CURRENT_MAP}>
          {similar.name}
          <span className="visually-hidden"> ({NOT_ON_CURRENT_MAP})</span>
        </code>
        {details}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className="code-map__link-button"
        onClick={() => onNavigateToNode(similar.id)}
        aria-label={`Go to ${similar.name} in ${similar.file} (${score})`}
      >
        <code>{similar.name}</code>
      </button>
      {details}
    </li>
  );
}

/**
 * P4-2 phase 4: the "Similar implementations" section's content — other
 * production Functions, in other files, that the backend's `SIMILAR_TO`
 * edge marks as near-duplicates (`CodeMapNode.similarTo`). Each row names
 * the Node, its file and "similarity 1.00", and navigates the map to it when
 * the map has it. The first `NODE_DETAIL_SIMILAR_ROWS`, then a native
 * `<details>` "+N more" (N counted against `similarToTotal`) with the rest
 * carried and, when the Graph Service carried fewer than exist, "Showing the
 * first X of Y". Always ends with the honest-copy line. Facts only: no
 * recommendation. Hookless, like `NodeDetailBody`.
 */
export function NodeSimilarImplementations({
  node,
  resolveMapNode = RESOLVE_NO_MAP_NODE,
  onNavigateToNode = NAVIGATE_NOWHERE,
}: {
  node: Pick<CodeMapNode, 'similarTo' | 'similarToTotal'>;
  resolveMapNode?: (id: string) => Pick<CodeMapNode, 'name'> | undefined;
  onNavigateToNode?: (id: string) => void;
}) {
  const similar = node.similarTo ?? [];
  const total = similarTotal(node);
  const shown = similar.slice(0, NODE_DETAIL_SIMILAR_ROWS);
  const rest = similar.slice(NODE_DETAIL_SIMILAR_ROWS);
  const more = total - shown.length;
  const rows = (entries: readonly SimilarImplementation[]) =>
    entries.map((entry) => (
      <SimilarRow key={entry.id} similar={entry} resolveMapNode={resolveMapNode} onNavigateToNode={onNavigateToNode} />
    ));
  return (
    <>
      <ul className="code-map__node-detail-similar" aria-label="Similar implementations">
        {rows(shown)}
      </ul>
      {more > 0 && (
        <details className="code-map__more">
          <summary>+{more} more</summary>
          {rest.length > 0 && (
            <ul className="code-map__node-detail-similar code-map__more-list" aria-label="Similar implementations, continued">
              {rows(rest)}
            </ul>
          )}
          {similar.length < total && (
            <p className="code-map__more-list">
              Showing the first {similar.length} of {total}.
            </p>
          )}
        </details>
      )}
      <p className="code-map__node-detail-similar-note">{SIMILARITY_DISCLAIMER}</p>
    </>
  );
}

/**
 * P2-12: Node Detail's scrolling body — the mockup's labelled, divided
 * sections in the order Summary → Risk Overlay → Tested by → (Uses) →
 * (File top-level) → (Similar implementations, P4-2 phase 4) → (Calls into
 * other sections, P4-4 phase 3b: section maps only) → Staleness → Location;
 * the parenthesized ones only when they have content.
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
  onOpenTest,
  resolveMapNode = RESOLVE_NO_MAP_NODE,
  onNavigateToNode = NAVIGATE_NOWHERE,
  resolveFoldedType = RESOLVE_NO_TYPE,
  onOpenType = NAVIGATE_NOWHERE,
  mapSection = null,
  onSwitchSection = SWITCH_NOWHERE,
  entryPin,
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
      {/* P4-2 phase 2: tests that provably exercise this Node — from real
          backend links only, never a name match. Always present; with no
          link it says so, and never claims the Node is untested. */}
      <section className="code-map__node-detail-section" aria-labelledby={ids.testedBy}>
        <h3 id={ids.testedBy} className="code-map__node-detail-label">
          Tested by
        </h3>
        <NodeTestedBy testedBy={node.testedBy} onOpenTest={onOpenTest} />
      </section>
      {/* P4-2 phase 3b: the types and interfaces this Node uses — folded off
          the map, from real USAGE edges only. Only when there are any. */}
      {(node.usesTypes?.length ?? 0) > 0 && (
        <section className="code-map__node-detail-section" aria-labelledby={ids.uses}>
          <h3 id={ids.uses} className="code-map__node-detail-label">
            Uses
          </h3>
          <NodeUsesTypes uses={node.usesTypes} resolveFoldedType={resolveFoldedType} onOpenType={onOpenType} />
        </section>
      )}
      {/* P4-2 phase 3a: folded top-level code — Module Nodes are not on the
          map, so what this file's top level uses, and which files' top
          level use this Node, are shown here. Only when there is either. */}
      {((node.fileTopLevel?.length ?? 0) > 0 ||
        (node.calledAtLoadBy?.length ?? 0) > 0 ||
        (node.fileTopLevelTypes?.length ?? 0) > 0) && (
        <section className="code-map__node-detail-section" aria-labelledby={ids.fileTopLevel}>
          <h3 id={ids.fileTopLevel} className="code-map__node-detail-label">
            File top-level
          </h3>
          <NodeFileTopLevel
            uses={node.fileTopLevel}
            calledAtLoadBy={node.calledAtLoadBy}
            resolveMapNode={resolveMapNode}
            onNavigateToNode={onNavigateToNode}
          />
          {/* P4-2 phase 3b: the types this file's top-level code uses. */}
          <NodeFileTopLevelTypes
            types={node.fileTopLevelTypes}
            resolveFoldedType={resolveFoldedType}
            onOpenType={onOpenType}
          />
        </section>
      )}
      {/* P4-2 phase 4: near-duplicate implementations in other files, from
          the backend's SIMILAR_TO edge only. Only when there are any (a
          backend without SIMILAR_TO shows no section). Facts, no advice. */}
      {(node.similarTo?.length ?? 0) > 0 && (
        <section className="code-map__node-detail-section" aria-labelledby={ids.similar}>
          <h3 id={ids.similar} className="code-map__node-detail-label">
            {similarHeading(node)}
          </h3>
          <NodeSimilarImplementations
            node={node}
            resolveMapNode={resolveMapNode}
            onNavigateToNode={onNavigateToNode}
          />
        </section>
      )}
      {/* P4-4 phase 3b: callees in other sections — real whole-scope CALLS
          edges the section's filter dropped (P4-4g). Only on a section map,
          and only when there are any. */}
      {mapSection !== null && crossSectionCallsCount(node) > 0 && (
        <section className="code-map__node-detail-section" aria-labelledby={ids.crossSectionCalls}>
          <h3 id={ids.crossSectionCalls} className="code-map__node-detail-label">
            Calls into other sections
          </h3>
          <NodeCrossSectionCalls
            node={node}
            graphServiceAvailable={graphServiceAvailable}
            onSwitchSection={onSwitchSection}
          />
        </section>
      )}
      {/* P4-7g: pin or unpin this Node as an entry point (AD-5 "Entry
          pins"); pins rank first among Revealed's entry candidates. */}
      {entryPin !== undefined && (
        <section className="code-map__node-detail-section" aria-labelledby={ids.entryPin}>
          <h3 id={ids.entryPin} className="code-map__node-detail-label">
            Entry point
          </h3>
          <NodeDetailEntryPin control={entryPin} />
        </section>
      )}
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
 *
 * P4-4 phase 1c: a section's empty map is its own case, decided first. A
 * section reply's `hiddenByScope` is the whole-scope count (Nodes the
 * allowlist removed), not this section's, so it can never say "the scope hid
 * everything" here.
 */
export type EmptyMapCase =
  | { kind: 'empty-section'; section: string }
  | { kind: 'scope-hid-everything'; hiddenCount: number }
  | { kind: 'no-map-eligible-nodes' };

export function chooseEmptyMapCase(hiddenByScope: number, section: string | null = null): EmptyMapCase {
  if (section !== null) {
    return { kind: 'empty-section', section };
  }
  return hiddenByScope > 0 ? { kind: 'scope-hid-everything', hiddenCount: hiddenByScope } : { kind: 'no-map-eligible-nodes' };
}

/**
 * P2-5: the scope case's one sentence. `appliedScope` is the scope the Graph
 * Service filtered this very map with (`CodeMapResult.appliedScope`), so it
 * never names a scope that didn't produce the map; `[]` omits the list.
 */
export function emptyMapScopeSentence(appliedScope: readonly string[], hiddenCount: number): string {
  const scope = appliedScope.length > 0 ? ` (${appliedScope.join(', ')})` : '';
  // FIX-3: the shared count formatter, so this reads "1,014 Nodes" like the footer.
  const nodes = formatCount(hiddenCount, 'Node', 'Nodes');
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
  section = null,
  graphServiceAvailable,
  reindexPending,
  onOpenSettings,
  onReindex,
}: {
  hiddenByScope: number;
  appliedScope: readonly string[];
  /** P4-4 phase 1c: the section this empty map is for (`null` = `all`). */
  section?: string | null;
  graphServiceAvailable: boolean;
  reindexPending: boolean;
  onOpenSettings: () => void;
  onReindex: () => void;
}) {
  const emptyCase = chooseEmptyMapCase(hiddenByScope, section);
  if (emptyCase.kind === 'empty-section') {
    // P4-4 phase 1c: names the section, with no action — the Section bar
    // above it is how to leave it, and neither the scope editor nor a
    // re-index is what an empty section asks for.
    return (
      <ActionableNotice tone="info">
        No map Nodes in <code>{emptyCase.section}</code>
      </ActionableNotice>
    );
  }
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
  section = null,
  onUnknownSection,
  onSwitchSection,
  pendingFocusNodeId = null,
  onPendingFocusConsumed,
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
  // P4-2 phase 3b: the type detail panel — the Node detail surface's type
  // variant, for a Type/Interface folded off the map.
  const [typeDetail, setTypeDetail] = useState<TypeDetailState>({ status: 'closed' });
  // P4-2 phase 3b: an "open this type" action found its type gone — shown as
  // a small notice on whichever surface is on top, until the next open,
  // close, search or refresh.
  const [typeGone, setTypeGone] = useState(false);
  // P4-4 phase 3b: a cross-section switch whose callee isn't on the new map
  // — shown until dismissed or the next load. The ref names the callee the
  // last Node detail switch asked for (App hands back only its id).
  const [crossSectionMiss, setCrossSectionMiss] = useState<{ name: string; section: string } | null>(null);
  const crossSectionTargetRef = useRef<{ id: string; name: string } | null>(null);
  // P4-4 phase 3b (founder decision 2026-10-04): the carried diff's
  // announcement, its check's request id, and the starter the section effect
  // calls (declared further down).
  const [diffCarryNote, setDiffCarryNote] = useState<string | null>(null);
  // Carry review: the check in flight, for the "Checking whether …" line.
  const [diffCarryPending, setDiffCarryPending] = useState<DiffScopeCarry | null>(null);
  const diffCarryRequestIdRef = useRef(0);
  const startDiffScopeCarryRef = useRef<(carry: DiffScopeCarry) => void>(() => {});
  // Review round 1: a PR Review "Switch to …" waits for its section's map
  // to focus the base-ref input (`prReviewSwitchFocusTarget`).
  const prReviewSwitchFocusRef = useRef<string | null>(null);
  const baseRefInputRef = useRef<HTMLInputElement | null>(null);
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
  // P4-2 phase 3c: "Show types & modules" — draws the folded kinds back on
  // the canvas, render only. Off by default; remembered per project in the
  // UI settings store (main). On a project change the previous value stays
  // until the new project's read lands (no off/on flicker); a user choice
  // supersedes a read in flight, and the value main stored wins.
  const [showFoldedKinds, setShowFoldedKinds] = useState(false);
  const showFoldedKindsRequests = useRef(createLatestRequestGuard()).current;
  useEffect(() => {
    const requestId = showFoldedKindsRequests.begin();
    void loadShowFoldedKinds(projectPath, (path) => window.driller.getShowFoldedKinds(path)).then((show) => {
      if (show !== null && showFoldedKindsRequests.isLatest(requestId)) {
        setShowFoldedKinds(show);
      }
    });
  }, [projectPath, showFoldedKindsRequests]);
  const changeShowFoldedKinds = useCallback(
    (show: boolean) => {
      const requestId = showFoldedKindsRequests.begin();
      setShowFoldedKinds(show);
      if (projectPath === null) {
        return;
      }
      void saveShowFoldedKinds(projectPath, show, (path, value) => window.driller.setShowFoldedKinds(path, value)).then(
        (stored) => {
          if (stored !== null && showFoldedKindsRequests.isLatest(requestId)) {
            setShowFoldedKinds(stored);
          }
        },
      );
    },
    [projectPath, showFoldedKindsRequests],
  );
  // P4-7g (AD-5 "Entry pins"): this project's pins, in pin order, as main
  // stored them — read on a project change, written whole on every toggle in
  // Node detail. `entryPinsRevision` counts the changes main stored this
  // session: each one owes Revealed a new listing (the Graph Service already
  // ranks the new pins). `entryPinMessage` is the last toggle's explicit
  // message, for the Node it was on.
  // Review round 1: `null` until this project's read lands — the toggle is
  // disabled meanwhile, so no change is ever based on a list not yet read.
  const [entryPins, setEntryPins] = useState<readonly string[] | null>(null);
  const entryPinsRef = useRef<readonly string[] | null>(null);
  entryPinsRef.current = entryPins;
  const [entryPinsRevision, setEntryPinsRevision] = useState(0);
  const [entryPinMessage, setEntryPinMessage] = useState<{ nodeId: string; text: string } | null>(null);
  const [entryPinBusy, setEntryPinBusy] = useState(false);
  const entryPinRequests = useRef(createLatestRequestGuard()).current;
  useEffect(() => {
    const requestId = entryPinRequests.begin();
    setEntryPins(null);
    setEntryPinMessage(null);
    setEntryPinBusy(false);
    void loadEntryPins(projectPath, (path) => window.driller.getEntryPins(path)).then((pins) => {
      if (pins !== null && entryPinRequests.isLatest(requestId)) {
        setEntryPins(pins);
      }
    });
  }, [projectPath, entryPinRequests]);
  const toggleEntryPin = useCallback(
    (nodeId: string) => {
      const previous = entryPinsRef.current;
      if (projectPath === null || previous === null) {
        return;
      }
      const plan = planPinToggle(previous, nodeId);
      if (plan.kind === 'limit') {
        setEntryPinMessage({ nodeId, text: PIN_LIMIT_TEXT });
        return;
      }
      const requestId = entryPinRequests.begin();
      setEntryPinBusy(true);
      setEntryPinMessage(null);
      // Review round 1: one id, applied by main to the list it stored.
      void saveEntryPin(projectPath, nodeId, plan.pinned, (path, id, pinned) =>
        window.driller.setEntryPins(path, id, pinned),
      ).then((result) => {
        if (!entryPinRequests.isLatest(requestId)) {
          return;
        }
        const outcome = pinSaveOutcome({ previous, result });
        setEntryPinBusy(false);
        setEntryPins(outcome.pins);
        setEntryPinMessage(outcome.message === null ? null : { nodeId, text: outcome.message });
        if (outcome.changed) {
          // Main has handed the stored pins to the Graph Service before
          // replying, so the listing this owes already ranks them.
          setEntryPinsRevision((revision) => revision + 1);
        }
      });
    },
    [projectPath, entryPinRequests],
  );
  // P4-7d: the "Revealed / Full map" view — renderer-session state, default
  // Full, reset to Full on a project change (never persisted: Ask First).
  // Applied only in Code Map mode: PR Review always renders Full.
  const [revealView, setRevealView] = useState<RevealViewMode>('full');
  // P4-7d: the held reveal state — keyed by project and section (`revealKey`)
  // and by the map fetch it was listed for. Switching to Full and back keeps
  // it; a section switch or a reload drops it (`loadCodeMap`). Mirrored in a
  // ref so a listing reply settles against the latest value.
  const [revealHeld, setRevealHeld] = useState<HeldReveal | null>(null);
  const revealHeldRef = useRef<HeldReveal | null>(null);
  revealHeldRef.current = revealHeld;
  // P4-7e: the drill graph of the map on screen (`revealDrillGraphFor`: the
  // candidates' own CALLS+USAGE adjacency and the lazy reach, one per map
  // fetch), and that fetch's Nodes for a listing reply's refresh rebase.
  const revealDrillGraphRef = useRef<RevealDrillGraph | null>(null);
  const revealMapNodesRef = useRef<readonly CodeMapNode[]>([]);
  // P4-7d: drops an out-of-order listing reply (with the section check in
  // `revealListingReplyOutcome`).
  const revealListingRequests = useRef(createLatestRequestGuard()).current;
  // P4-7d: "Showing the full map to reach `<name>`" after a navigation to a
  // hidden Node switched to Full; cleared by the next navigation, toggle,
  // mode change or reload, or after `REVEAL_SWITCH_STATUS_MS` (review round 1).
  const [revealSwitchStatus, setRevealSwitchStatus] = useState<string | null>(null);
  // Review round 1: set while a switched navigation is being replayed, so the
  // replay itself doesn't clear the status line it just set.
  const replayingFullNavigationRef = useRef(false);
  // P4-7f: the Node a Back/Forward over a reveal entry centres on once the
  // restored state is laid out (`id`, else the step's own `fallbackId`, if
  // still revealed), and the card that held keyboard focus before it
  // (review round 1: rescued if the restore removed it).
  const [revealFocusRequest, setRevealFocusRequest] = useState<{
    id: string;
    fallbackId: string;
    focusedCard: HTMLElement | null;
  } | null>(null);
  const historyBackButtonRef = useRef<HTMLButtonElement | null>(null);
  // P4-7f: the latest drill or Back/Forward announcement in the Panel's one
  // status line. Review round 1: it stays until the next event (a drill, a
  // navigation, a toggle, a mode change or a reload) — no 8 s clear, unlike
  // the switch-to-Full message — and an identical text is blanked and set
  // again on the next frame so it is announced again (`announcementSteps`).
  const [revealAnnouncement, setRevealAnnouncement] = useState<string | null>(null);
  const revealAnnouncementRef = useRef<string | null>(null);
  const revealAnnouncementFrameRef = useRef<number | null>(null);
  const clearRevealAnnouncement = useCallback(() => {
    if (revealAnnouncementFrameRef.current !== null) {
      cancelAnimationFrame(revealAnnouncementFrameRef.current);
      revealAnnouncementFrameRef.current = null;
    }
    revealAnnouncementRef.current = null;
    setRevealAnnouncement(null);
  }, []);
  const announceReveal = useCallback((text: string) => {
    if (revealAnnouncementFrameRef.current !== null) {
      cancelAnimationFrame(revealAnnouncementFrameRef.current);
      revealAnnouncementFrameRef.current = null;
    }
    setRevealSwitchStatus(null);
    const [first, then] = announcementSteps(revealAnnouncementRef.current, text);
    revealAnnouncementRef.current = first ?? text;
    setRevealAnnouncement(first ?? text);
    if (then !== undefined) {
      revealAnnouncementFrameRef.current = requestAnimationFrame(() => {
        revealAnnouncementFrameRef.current = null;
        revealAnnouncementRef.current = then;
        setRevealAnnouncement(then);
      });
    }
  }, []);
  useEffect(
    () => () => {
      if (revealAnnouncementFrameRef.current !== null) {
        cancelAnimationFrame(revealAnnouncementFrameRef.current);
      }
    },
    [],
  );
  // P4-7d: a navigation that switched to Full, replayed once Full is laid out.
  const pendingFullNavigationRef = useRef<PendingFullNavigation | null>(null);
  // P4-7d (review round 1: explicit toggles only — `revealViewRequestForToggle`
  // / `decideRevealView`): the view change still owed to the viewport — fit
  // the candidates on entering Revealed; on leaving it, restore the Full
  // viewport saved on entry (same map fetch) or fit the full map.
  const revealViewRequestRef = useRef<RevealViewRequest | null>(null);
  const fullViewportRef = useRef<SavedFullViewport | null>(null);
  // Review round 1: the user moved the view since Revealed last fitted (a
  // refresh's listing re-fits only when they haven't).
  const revealUserMovedRef = useRef(false);
  // The current view, project/section key and map fetch, for the toggle
  // handler below (synced each render, further down).
  const revealViewRef = useRef<RevealViewMode>('full');
  revealViewRef.current = revealView;
  const revealMapRef = useRef<{ key: string | null; mapStamp: readonly CodeMapEdge[] | null }>({
    key: null,
    mapStamp: null,
  });
  const changeRevealView = useCallback((next: RevealViewMode) => {
    pendingFullNavigationRef.current = null;
    setRevealSwitchStatus(null);
    clearRevealAnnouncement();
    const { request, saved } = revealViewRequestForToggle({
      from: revealViewRef.current,
      to: next,
      key: revealMapRef.current.key,
      mapStamp: revealMapRef.current.mapStamp,
      viewport: reactFlowInstanceRef.current?.getViewport() ?? null,
      saved: fullViewportRef.current,
    });
    if (request !== null) {
      revealViewRequestRef.current = request;
      fullViewportRef.current = saved;
      revealUserMovedRef.current = false;
      // Review round 1: cluster expansions belong to one view's layout.
      setExpandedClusterIds(new Set());
    }
    setRevealView(next);
  }, []);
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
  // P4-3d: the metrics table's user sort; `null` is the default order. Reset
  // beside the blast radius at each diff-scope reset point (project change,
  // `loadCodeMap`, `refreshCodeMap`, and the start of `handleComputeDiffScope`),
  // so a new diff scope opens in the default order. A mode toggle keeps it.
  const [prReviewMetricSort, setPrReviewMetricSort] = useState<PrReviewMetricSort | null>(null);
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
  // P4-4 phase 2a: the section on screen, read by Path Trace, diff scope and
  // Blast Radius expansion when they send a request (so the effect that
  // auto-triggers the expansion needs no new dependency) and again when the
  // reply settles (`settleSectionScopedReply`): a reply for a section that
  // is no longer on screen never applies. Synced in a layout effect, so it
  // is current before any reply can settle after the render that changed it.
  const sectionRef = useRef<string | null>(section);
  useLayoutEffect(() => {
    sectionRef.current = section;
  }, [section]);
  const onUnknownSectionRef = useRef(onUnknownSection);
  useEffect(() => {
    onUnknownSectionRef.current = onUnknownSection;
  }, [onUnknownSection]);
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
  // P4-3a review: the observed element is `CodeMapCanvasFrame`'s div (the
  // canvas itself), not `.code-map`, which is taller by the metrics table's
  // band. A callback ref into state, so the observer re-attaches whenever
  // the canvas remounts (e.g. back from Health Audit Mode).
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null);
  // P4-3b: `.code-map`'s own height — canvas plus metrics table — which the
  // divider's clamp is a share of. Measured separately from the canvas
  // (whose height already has the table taken off), so the table's own
  // height never feeds back into its bounds. `null` height: no resize yet
  // (the default share); kept for the session, across mode switches.
  const [mapElement, setMapElement] = useState<HTMLDivElement | null>(null);
  const [mapHeight, setMapHeight] = useState(0);
  const [requestedMetricsTableHeight, setRequestedMetricsTableHeight] = useState<number | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  // FIX-1: the same size as a ref, so `fitViewToPath` reads the latest value
  // without depending on it (a resize must never re-create — and so never
  // re-trigger — the route fit and throw away the user's own pan/zoom).
  const containerSizeRef = useRef({ width: 0, height: 0 });
  // P4-3b review: the size last written to `containerSize` — a divider drag
  // moves `containerSizeRef` ahead of it until `flushCanvasSize`.
  const committedContainerSizeRef = useRef({ width: 0, height: 0 });
  // Clusters the user has clicked/activated to expand (Boundaries &
  // Constraints: "Clicking a cluster removes it from the cluster set for
  // this render"). A cluster's `id` is derived from its current
  // zoom-band/grid-cell coordinates (see `map/lod/index.ts` and
  // `quantizeZoomBand`), which shift whenever the zoom band or pan position
  // changes enough — so this naturally trims on a real zoom-level change
  // rather than needing an explicit reset effect. `MAX_EXPANDED_CLUSTER_IDS`
  // is a defensive cap on top of that (review finding).
  const [expandedClusterIds, setExpandedClusterIds] = useState<Set<string>>(() => new Set());
  // FIX-3: set by `onInit` — this canvas mount hasn't had its first fit yet.
  // Replaces `<ReactFlow fitView>`, whose whole-map fit landed a real
  // ~1,000-Node map below `LOD_ZOOM_THRESHOLD` as a few cluster dots; the
  // effect after `measuredViewportSize` applies `initialViewport` once per
  // mount instead (Health Audit unmounts the canvas, so switching back fits
  // again, exactly as `fitView` did). `canvasInitCount` re-runs that effect.
  // `fittedProjectPath` is the project the last first-fit was for — a
  // project change re-arms the fit (`initialFitDecision`). `CodeMap` is in
  // practice remounted per project (App's `showMap`), so that is defensive.
  const initialFitRef = useRef<InitialFitState>(INITIAL_FIT_STATE);
  const [canvasInitCount, setCanvasInitCount] = useState(0);
  // FIX-3: the canvas stays `visibility: hidden` from `onInit` until its first
  // fit lands, so React Flow's default viewport (zoom 1 at the origin) never
  // paints first.
  const [awaitingFirstFit, setAwaitingFirstFit] = useState(false);
  // FIX-3: bounded per-frame retries while the size is still unmeasured by our
  // own ResizeObserver — React Flow's store may measure first, and nothing
  // else would re-run the effect when it does.
  const [initialFitRetry, setInitialFitRetry] = useState(0);
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
  // P4-7f: an entry is a Node (`{kind: 'node', id}`) or one Revealed drill
  // step (`{kind: 'reveal', before, after, focusId, …}`) — Back undoes the
  // step, Forward redoes it (`HistoryEntry`, `historyMove`).
  const [history, setHistory] = useState<NavigationHistory>({ stack: [], index: -1 });

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
    // P4-7d (founder decision 2026-10-04): the held reveal state belongs to
    // one project, section and map — a section switch (or a Retry) drops it,
    // so Revealed restarts from the new map's candidates; a listing still in
    // flight can't land. The toggle itself stays as it is.
    setRevealHeld(null);
    revealHeldRef.current = null;
    revealListingRequests.begin();
    pendingFullNavigationRef.current = null;
    setRevealSwitchStatus(null);
    clearRevealAnnouncement();
    // Review round 1: an owed view can't apply to another project or section.
    revealViewRequestRef.current = null;
    // P4-4 phase 3b: a "not on the current map" notice belongs to the map it
    // was about; a carried diff's check and announcement belong to the
    // switch that started them (a switch starts a fresh one after this).
    setCrossSectionMiss(null);
    setDiffCarryNote(null);
    diffCarryRequestIdRef.current += 1;
    setDiffCarryPending(null);
    // Story 1.8 (Phase 4): a Retry/reload swaps in an entirely different
    // Node set, same reasoning as the history reset just above — a Node
    // Detail panel left open for a Node from the previous map must not
    // survive into this one.
    updateNodeDetail({ status: 'closed' });
    setRegenerateState({ kind: 'idle' });
    // P4-2 phase 3b: the same for a type detail.
    setTypeDetail({ status: 'closed' });
    setTypeGone(false);
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
    setPrReviewMetricSort(null);
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
            foldedTypes: [],
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
    // P4-4 phase 1c: the map of the section on screen (`sectionRef`, synced
    // in a layout effect, so it is already the new section when the
    // section-keyed effect below calls this). Fast switching queues one
    // request per switch in main; only the latest one's reply applies (the
    // shared `refreshRequestIdRef` check below).
    const requestedSection = sectionRef.current;
    window.driller
      .getCodeMap(requestedSection ?? undefined)
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
            foldedTypes: result.foldedTypes,
            foldedModules: result.foldedModules,
            section: result.section,
            sections: result.sections,
            ...(result.crossSectionEdges !== undefined ? { crossSectionEdges: result.crossSectionEdges } : {}),
          });
          return;
        }
        // P4-4 phase 1c: the section left the allowlist — the shell falls
        // back to `all` (status text, never this error state), and the
        // section change reloads. The map stays `loading` until then.
        if (handOffUnknownSection(result, requestedSection, onUnknownSectionRef.current)) {
          return;
        }
        setFetchState({ status: 'error', message: codeMapFailureMessage(result) });
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

  // P4-4 phase 1c: `section` is a dependency so that a switch reloads the
  // map through this same full reset — history, Node and type detail, Path
  // Trace, the diff scope and base ref (and their sync), Blast Radius — and
  // the canvas remounts for the new Node set (its first fit re-arms).
  // P4-4 phase 3b (founder decision 2026-10-04): a switch out of a PR Review
  // with a diff to carry (`diffScopeCarryCandidate`, read from the render
  // that changed the section — before this reset) starts its carry check
  // right after the reset.
  const loadedSectionRef = useRef<string | null>(section);
  const diffCarrySourceRef = useRef({ mode, diffScopeState, baseRefInput });
  diffCarrySourceRef.current = { mode, diffScopeState, baseRefInput };
  useEffect(() => {
    const from = loadedSectionRef.current;
    loadedSectionRef.current = section;
    const carry = diffScopeCarryCandidate({ ...diffCarrySourceRef.current, from, to: section });
    loadCodeMap();
    if (carry !== null) {
      startDiffScopeCarryRef.current(carry);
    }
  }, [loadCodeMap, section]);

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
    // P4-4 phase 3b: a refresh resets the diff, so a carry still in flight
    // must not re-run it.
    setDiffCarryNote(null);
    diffCarryRequestIdRef.current += 1;
    setDiffCarryPending(null);
    setDiffScopeState({ status: 'idle' });
    clearDiffScopeSync();
    diffScopeRequestIdRef.current += 1;
    setBlastRadiusState({ status: 'idle' });
    setBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS);
    setPrReviewMetricSort(null);
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
          // P4-2 phase 3b: no map, so no type detail and no "is a type" notice.
          setTypeDetail((current) => foldedTypeStateAfterRefresh(outcome, current, IDLE_TRACE).typeDetail);
          setPathTrace((current) => foldedTypeStateAfterRefresh(outcome, CLOSED_TYPE, current).pathTrace);
          setTypeGone(false);
          return;
        case 'apply':
          setFetchState({
            status: 'ready',
            nodes: outcome.nodes,
            edges: outcome.edges,
            hiddenByScope: outcome.hiddenByScope,
            appliedScope: outcome.appliedScope,
            foldedTypes: outcome.foldedTypes,
            ...(outcome.foldedModules !== undefined ? { foldedModules: outcome.foldedModules } : {}),
            ...(outcome.section !== undefined ? { section: outcome.section } : {}),
            ...(outcome.sections !== undefined ? { sections: outcome.sections } : {}),
            ...(outcome.crossSectionEdges !== undefined ? { crossSectionEdges: outcome.crossSectionEdges } : {}),
          });
          // P4-2 phase 3b: an open type detail and an "is a type" notice
          // follow their types to the fresh map, or close/clear when gone.
          setTypeDetail((current) => foldedTypeStateAfterRefresh(outcome, current, IDLE_TRACE).typeDetail);
          setPathTrace((current) => foldedTypeStateAfterRefresh(outcome, CLOSED_TYPE, current).pathTrace);
          setTypeGone(false);
          if (outcome.nodeDetail.kind === 'close') {
            updateNodeDetail({ status: 'closed' });
            setRegenerateState({ kind: 'idle' });
          } else if (outcome.nodeDetail.kind === 'repoint') {
            updateNodeDetail({ status: 'open', node: outcome.nodeDetail.node });
          }
          return;
      }
    };
    const requestedSection = sectionRef.current;
    window.driller
      .getCodeMap(requestedSection ?? undefined)
      .then((result) => {
        // P4-4 phase 1c: a refresh (new index, e.g. after a scope change) can
        // find the section gone — the same fallback to `all` as a load.
        if (
          requestId === refreshRequestIdRef.current &&
          handOffUnknownSection(result, requestedSection, onUnknownSectionRef.current)
        ) {
          return;
        }
        settle(
          result.status === 'ok'
            ? {
                kind: 'ok',
                nodes: result.nodes,
                edges: result.edges,
                hiddenByScope: result.hiddenByScope,
                appliedScope: result.appliedScope,
                foldedTypes: result.foldedTypes,
                foldedModules: result.foldedModules,
                section: result.section,
                sections: result.sections,
                ...(result.crossSectionEdges !== undefined ? { crossSectionEdges: result.crossSectionEdges } : {}),
              }
            : { kind: 'failed', message: codeMapFailureMessage(result) },
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
    setPrReviewMetricSort(null);
    blastRadiusRequestIdRef.current += 1;
    // P4-7d: the Revealed / Full toggle is per session and per project — a
    // project change goes back to Full (its held state is dropped by
    // `loadCodeMap`'s reset).
    setRevealView('full');
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
  // P4-4 phase 3b (founder decision 2026-10-04): the diff-scope run itself,
  // for an explicit base-ref value — the button's path (`handleComputeDiffScope`)
  // and a section switch's automatic re-run (`startDiffScopeCarry`) alike, so
  // both share these stale-reply guards.
  const runDiffScope = useCallback((rawBaseRef: string) => {
    if (projectPath === null) {
      return;
    }
    const requestId = ++diffScopeRequestIdRef.current;
    const trimmedBaseRef = rawBaseRef.trim();
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
    setPrReviewMetricSort(null);
    blastRadiusRequestIdRef.current += 1;
    // P4-4 phase 2a: the diff is scoped to the section on screen.
    const requestedSection = sectionRef.current;
    window.driller
      .computeDiffScope(projectPath, trimmedBaseRef.length > 0 ? trimmedBaseRef : undefined, requestedSection ?? undefined)
      .then((reply: DiffScopeResult) => {
        if (diffScopeRequestIdRef.current !== requestId) {
          return;
        }
        settleSectionScopedReply(reply, requestedSection, sectionRef.current, {
          apply: (result) => {
            // P3-10: every settle but `error` is a completed sync; an error
            // keeps whatever time was held.
            const syncedAt = diffScopeSyncTimeFor(result, Date.now());
            if (syncedAt !== null) {
              diffScopeSyncHeldForRef.current = projectPath;
              onDiffScopeSyncedRef.current(projectPath, syncedAt);
            }
            setDiffScopeState(diffScopeStateFromResult(result));
          },
          unknownSection: (gone) => {
            // The section left the allowlist: no diff scope, no sync time;
            // the shell falls back to `all`.
            setDiffScopeState({ status: 'idle' });
            clearDiffScopeSync();
            onUnknownSectionRef.current?.(gone);
          },
        });
      })
      .catch((error: unknown) => {
        if (diffScopeRequestIdRef.current !== requestId || requestedSection !== sectionRef.current) {
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
  }, [projectPath, clearDiffScopeSync]);

  const handleComputeDiffScope = useCallback(() => {
    if (projectPath === null || diffScopeState.status === 'loading') {
      return;
    }
    // A manual run supersedes a carried one's announcement and check.
    setDiffCarryNote(null);
    diffCarryRequestIdRef.current += 1;
    setDiffCarryPending(null);
    runDiffScope(baseRefInput);
  }, [projectPath, baseRefInput, diffScopeState.status, runDiffScope]);

  // P4-4 phase 3b (founder decision 2026-10-04): a section switch with a
  // diff to carry keeps the base ref while the Graph Service checks whether
  // it applies in the new section (`checkDiffScopeCarry`), then re-runs the
  // diff there, announced — or clears the base ref (the diff is already
  // idle from `loadCodeMap`'s reset). A reply for a superseded switch, or
  // after a later load/refresh, is dropped.
  const startDiffScopeCarry = useCallback(
    (carry: DiffScopeCarry) => {
      if (projectPath === null) {
        return;
      }
      const carryId = ++diffCarryRequestIdRef.current;
      setBaseRefInput(carry.input);
      setDiffCarryPending(carry);
      // `applyDiffScopeCarryReply` decides (stale → ignored; PR Review left
      // → no re-run); this only carries it out.
      const settle = (result: DiffScopeCarryResult) =>
        applyDiffScopeCarryReply(
          {
            carryId,
            latestCarryId: diffCarryRequestIdRef.current,
            carryTo: carry.to,
            currentSection: sectionRef.current,
            mode: diffCarrySourceRef.current.mode,
            result,
          },
          {
            done: () => setDiffCarryPending(null),
            rerun: () => {
              setDiffCarryNote(diffScopeCarryAnnouncement(carry));
              runDiffScope(carry.input);
            },
            reset: () => setBaseRefInput(''),
          },
        );
      window.driller
        .checkDiffScopeCarry(projectPath, carry.from, carry.to, carry.ref)
        .then(settle)
        .catch((error: unknown) =>
          settle({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
        );
    },
    [projectPath, runDiffScope],
  );
  startDiffScopeCarryRef.current = startDiffScopeCarry;

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
    // P4-4 phase 2a: hop distances over the section on screen only (read
    // from the ref, so this effect's dependencies are unchanged).
    const requestedSection = sectionRef.current;
    setBlastRadiusState({ status: 'loading' });
    window.driller
      .expandBlastRadius(projectPath, seedNodeIds, requestedSection ?? undefined)
      .then((reply: BlastRadiusExpansionResult) => {
        if (blastRadiusRequestIdRef.current !== requestId) {
          // Superseded by a later reset/trigger (a project switch, a
          // Retry/reload, or a fresh diff-scope resolution) — discard rather
          // than let a stale reply apply a blast radius keyed to a Node set
          // that may no longer even be on screen.
          return;
        }
        settleSectionScopedReply(reply, requestedSection, sectionRef.current, {
          apply: (result) => {
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
          },
          unknownSection: (gone) => {
            // The section left the allowlist after the diff scope resolved in
            // it. Only the shell's fallback to `all` runs here: that reload
            // (`loadCodeMap`, P4-4d) resets the diff scope, this expansion
            // and the table sort together at one reset point. Resetting the
            // diff scope from this mode-keyed effect would add a reset point
            // a mode toggle re-runs. Until then the expansion stays
            // `loading`, which this effect never re-fires from. Review round
            // 1: with no fallback wired, it becomes an explicit error instead.
            const next = blastRadiusStateOnUnknownSection(gone, onUnknownSectionRef.current);
            if (next !== null) {
              setBlastRadiusState(next);
            }
          },
        });
      })
      .catch((error: unknown) => {
        if (blastRadiusRequestIdRef.current !== requestId || requestedSection !== sectionRef.current) {
          return;
        }
        setBlastRadiusState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [mode, projectPath, diffScopeState, blastRadiusState.status, graphServiceAvailable]);

  const openSourceForNode = useCallback((node: SourceTarget) => {
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
    setTypeGone(false);
  }, []);

  // P4-2 phase 3b: the folded types of the map on screen, and the one lookup
  // every "open a type" affordance resolves through.
  const foldedTypes = fetchState.status === 'ready' ? fetchState.foldedTypes : NO_FOLDED_TYPES;
  const foldedTypesById = useMemo(() => new Map(foldedTypes.map((type) => [type.id, type])), [foldedTypes]);
  const resolveFoldedType = useCallback((id: string) => foldedTypesById.get(id), [foldedTypesById]);
  // Read at call time by async paths (an in-flight Path Trace), so they see
  // the map on screen when they land, not the one they started on.
  const foldedTypesRef = useRef(foldedTypes);
  foldedTypesRef.current = foldedTypes;
  // Opens (or, from another type, replaces) the type detail — it stacks over
  // an open Node detail rather than closing it, so Escape returns to the
  // Node. Every way in goes through `openTypeFromDetail`, which checks the
  // type is still on the map first.
  const openType = useCallback(
    (id: string): boolean =>
      openTypeFromDetail(id, {
        resolveFoldedType,
        openTypeDetail: (type) => {
          setTypeGone(false);
          setTypeDetail({ status: 'open', type });
        },
        onMissing: () => setTypeGone(true),
      }),
    [resolveFoldedType],
  );
  const closeTypeDetail = useCallback(() => {
    setTypeDetail({ status: 'closed' });
    setTypeGone(false);
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
            // P4-4 phase 1c: the reply is the whole-scope Node; in a section
            // the on-screen Node's own severities are kept
            // (`regeneratedNodeForMap`), keyed on the section of the map
            // being patched.
            const mapSection = previous.section ?? null;
            const nodes = previous.nodes.map((candidate) =>
              candidate.id === result.node.id ? regeneratedNodeForMap(candidate, result.node, mapSection) : candidate,
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
          // P4-4 phase 1c: the panel keeps the section's severities too. The
          // open panel's Node is from the map on screen, whose section is
          // the one in `sectionRef` once its load landed.
          updateNodeDetail({
            status: 'open',
            node: regeneratedNodeForMap(current.node, result.node, sectionRef.current),
          });
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
    // FIX-3: this canvas mount owes its first fit (see the effect below).
    initialFitRef.current = armInitialFit(initialFitRef.current);
    setAwaitingFirstFit(true);
    setInitialFitRetry(0);
    setCanvasInitCount((count) => count + 1);
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
        // P4-7d review round 1: a refresh's listing won't re-fit over this.
        revealUserMovedRef.current = true;
      }
    },
    [clearRouteClamp],
  );

  // Tracks the `<ReactFlow>` container's own pixel size — the other input
  // (alongside `viewport`) `computeLOD`'s `viewportBounds` is derived from.
  useEffect(() => {
    const el = canvasElement;
    if (!el) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      const next = { width, height };
      containerSizeRef.current = next;
      // P4-3b review: mid-drag, only the ref follows the canvas (fits read
      // it); the state and the route-clamp reset wait for the release
      // (`flushCanvasSize`), so a divider drag never re-renders per move.
      const dragging = el.parentElement?.hasAttribute(METRICS_TABLE_DRAGGING_ATTRIBUTE) ?? false;
      if (canvasResizeEffect(dragging, committedContainerSizeRef.current, next) === 'commit') {
        // FIX-1: a resized view is no longer the fitted one.
        clearRouteClamp();
        committedContainerSizeRef.current = next;
        setContainerSize(next);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasElement, clearRouteClamp]);

  // P4-3b: tracks `.code-map`'s height for the metrics divider's clamp; a
  // window resize re-renders, and `metricsTableHeightFor` re-clamps.
  useEffect(() => {
    const el = mapElement;
    if (!el) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setMapHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mapElement]);

  // P4-3b review: on a divider release, commits the canvas size the drag
  // deferred (see the observer above) — one render, one route-clamp reset.
  const flushCanvasSize = useCallback(() => {
    const next = containerSizeRef.current;
    if (canvasResizeEffect(false, committedContainerSizeRef.current, next) === 'commit') {
      clearRouteClamp();
      committedContainerSizeRef.current = next;
      setContainerSize(next);
    }
  }, [clearRouteClamp]);
  const handleMetricsTableResize = useCallback(
    (height: number) => {
      setRequestedMetricsTableHeight(height);
      flushCanvasSize();
    },
    [flushCanvasSize],
  );

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
  // P4-2 phase 3c: the changed contracts' dependents — marked with their own
  // contract-dependent treatment (never the changed one). Same mode gate as
  // `changedNodeIds`.
  const changedContracts =
    mode === 'prReview' && diffScopeState.status === 'resolved' ? diffScopeState.changedContracts : NO_CHANGED_CONTRACTS;
  const contractDependentsById = useMemo(
    () => contractDependents(changedContracts, changedNodeIds),
    [changedContracts, changedNodeIds],
  );

  // P4-2 phase 3c: "Show types & modules" — the folded kinds as render-only
  // canvas cards. `canvasPopulation` keeps them out of everything that
  // counts: only the card layout, LOD and the rendered edges read
  // `canvasNodes`/`canvasEdges`; adjacency, Path Trace, the blast radius and
  // Health Audit read the fetched map.
  const foldedCanvas = useMemo(
    () =>
      showFoldedKinds && fetchState.status === 'ready'
        ? foldedCanvasElements(fetchState.nodes, fetchState.foldedTypes, fetchState.foldedModules ?? [])
        : NO_FOLDED_CANVAS,
    [showFoldedKinds, fetchState],
  );
  const population = useMemo(
    () => canvasPopulation(fetchState, foldedCanvas, showFoldedKinds),
    [fetchState, foldedCanvas, showFoldedKinds],
  );
  // With the folded kinds drawn, a changed contract's own card is marked
  // changed too (render only — `changedNodeIds` itself is untouched).
  const renderChangedIds = useMemo<ReadonlySet<string>>(() => {
    if (population.foldedNodes.length === 0 || changedContracts.length === 0) {
      return changedNodeIds;
    }
    const ids = new Set(changedNodeIds);
    for (const contract of changedContracts) {
      ids.add(contract.id);
    }
    return ids;
  }, [population, changedContracts, changedNodeIds]);
  // A folded card opens what it stands for: a type's detail, or a Module's
  // top-level code in the source viewer.
  const activateFoldedNodeRef = useRef<(folded: FoldedCanvasNode) => void>(() => {});
  activateFoldedNodeRef.current = (folded: FoldedCanvasNode) => {
    if (folded.kind === 'Module') {
      openSourceForNode({
        file: folded.file,
        startLine: folded.startLine,
        endLine: folded.endLine,
        label: `${folded.file} (top-level)`,
      });
      return;
    }
    openType(folded.id);
  };
  const activateFoldedNode = useCallback((folded: FoldedCanvasNode) => {
    activateFoldedNodeRef.current(folded);
  }, []);

  // P4-7d: the Revealed view — Code Map mode only (PR Review always renders
  // Full; Health Audit mounts no canvas). It filters what the canvas lays
  // out and hands to `computeLOD` (AD-2: before layout; `computeLOD` is
  // untouched); `population.riskNodes`/`riskEdges` — every number — never
  // change. `revealCanvas` is `null` in Full, which then takes exactly
  // today's path below.
  const revealDrawn = revealView === 'revealed' && mode === 'codeMap';
  const revealDrawnRef = useRef(revealDrawn);
  revealDrawnRef.current = revealDrawn;
  const revealMapStamp = fetchState.status === 'ready' ? fetchState.edges : null;
  const revealSection = fetchState.status === 'ready' ? (fetchState.section ?? null) : null;
  const currentRevealKey =
    projectPath !== null && revealMapStamp !== null ? revealKey(projectPath, revealSection) : null;
  revealMapRef.current = { key: currentRevealKey, mapStamp: revealMapStamp };
  revealMapNodesRef.current = fetchState.status === 'ready' ? fetchState.nodes : [];
  // P4-7e: built only while Revealed is drawn — Full never pays for it.
  const revealDrillGraph =
    revealDrawn && fetchState.status === 'ready'
      ? revealDrillGraphFor(revealDrillGraphRef.current, fetchState.nodes, fetchState.edges)
      : null;
  if (revealDrillGraph !== null) {
    revealDrillGraphRef.current = revealDrillGraph;
  }
  // P4-7e: one drill step — expand, collapse or a stub — applied to the held
  // state for the map on screen (`applyRevealTransition`), renderer-local:
  // no Graph Service call, no IPC (AD-14). Never touches what any number
  // reads (`population.riskNodes`/`riskEdges`, adjacency, Path Trace).
  // P4-7f: each step pushes exactly one reveal history entry (`before`/
  // `after` are immutable snapshots that share structure — O(1)) and is
  // announced in the Panel's one `role="status"` line. A request with nothing
  // to do (`+` on a leaf) only says so ("No more callees").
  const applyRevealDrill = useCallback(
    (
      focus: { id: string; name: string },
      plan: (state: RevealState, graph: RevealDrillGraph) => { step: RevealStep; next: RevealState } | { text: string } | null,
    ) => {
      const graph = revealDrillGraphRef.current;
      const { key, mapStamp } = revealMapRef.current;
      if (graph === null || graph.edges !== mapStamp || key === null) {
        return;
      }
      const outcome: { step: RevealStep | null; text: string | null } = { step: null, text: null };
      const applied = applyRevealTransition(revealHeldRef.current, key, (state) => {
        const planned = plan(state, graph);
        if (planned === null) {
          return state;
        }
        if ('text' in planned) {
          outcome.text = planned.text;
          return state;
        }
        outcome.step = planned.step;
        return planned.next;
      });
      const step = outcome.step;
      if (applied === null || step === null) {
        if (outcome.text !== null) {
          announceReveal(outcome.text);
        }
        return;
      }
      revealHeldRef.current = applied.held;
      setRevealHeld(applied.held);
      const entry: RevealHistoryEntry = {
        kind: 'reveal',
        before: applied.before,
        after: applied.after,
        focusId: focus.id,
        name: focus.name,
        step,
        key,
        mapStamp: applied.held.mapStamp,
      };
      setHistory((previous) => pushHistoryEntry(previous, entry));
      announceReveal(formatRevealAnnouncement(applied.before, applied.after, focus.name, { parentId: focus.id, step }));
    },
    [announceReveal],
  );
  const onRevealDrill = useCallback(
    (node: CodeMapNode, action: RevealDrillControl['kind']) =>
      applyRevealDrill(node, (state, graph) => {
        const planned = planRevealDrill(state, graph, node.id, action);
        return planned.kind === 'step' ? planned : planned.kind === 'none' ? { text: planned.text } : null;
      }),
    [applyRevealDrill],
  );
  const onActivateRevealStub = useCallback(
    (stub: Extract<RevealAuxCard, { kind: 'more' }>) =>
      applyRevealDrill({ id: stub.parentId, name: stub.parentName }, (state, graph) => {
        const next = expandStub(state, graph.adjacency, graph.reachById, stub.parentId);
        return next === state ? null : { step: 'stub', next };
      }),
    [applyRevealDrill],
  );
  // A ref card goes to the Node it stands for (drawn, so no switch to Full).
  const onActivateRevealRef = useCallback(
    (ref: Extract<RevealAuxCard, { kind: 'ref' }>) => navigateToNode(ref.targetId),
    [navigateToNode],
  );
  const revealCanvas = useMemo(() => {
    if (!revealDrawn || fetchState.status !== 'ready') {
      return null;
    }
    if (revealDrillGraph === null) {
      // Never while Revealed is drawn on a ready map (built just above).
      return null;
    }
    const state = drawnRevealState(revealHeld, currentRevealKey);
    const positions = layeredLayout(state);
    const drawn = revealedPopulation(population, state);
    const nameById = new Map(drawn.mapNodes.map((node) => [node.id, node.name]));
    const auxCards = revealAuxCards(state, (id) => nameById.get(id), revealDrillGraph.adjacency);
    return {
      population: drawn,
      positionOf: (id: string, index: number) =>
        positions.get(id) ?? layoutPosition(index, canvasGridSize(drawn.mapNodes.length, drawn.foldedNodes.length)),
      candidates: candidatesById(state),
      reveal: {
        controls: revealDrillControls(state, revealDrillGraph.adjacency),
        onDrill: onRevealDrill,
        auxCards,
        onActivateRef: onActivateRevealRef,
        onActivateStub: onActivateRevealStub,
      },
    };
  }, [
    revealDrawn,
    fetchState.status,
    revealHeld,
    currentRevealKey,
    population,
    revealDrillGraph,
    onRevealDrill,
    onActivateRevealRef,
    onActivateRevealStub,
  ]);
  // Review round 1: a ready listing that draws nothing here is the `stale`
  // notice — never an empty canvas without one.
  const revealNotice = revealDrawn
    ? revealNoticeFor(revealHeld, currentRevealKey, revealCanvas?.population.mapNodes.length ?? 0)
    : null;
  const revealStatus = revealStatusText({
    switchStatus: revealSwitchStatus,
    announcement: revealAnnouncement,
    notice: revealNotice,
    capText: revealDrawn ? revealCapText(revealHeld, currentRevealKey) : null,
  });

  const flowNodes = useMemo(
    () =>
      fetchState.status === 'ready'
        ? revealCanvas === null
          ? layoutNodes(
              population.riskNodes,
              activateNode,
              showNeighbors,
              openSourceForNode,
              adjacency,
              noSummaryBackendAvailable,
              cloudSelectedNoKey,
              showDeterministicSignals,
              showLlmJudgment,
              showIngestedFindings,
              renderChangedIds,
              population.foldedNodes,
              activateFoldedNode,
              contractDependentsById,
            )
          : layoutNodes(
              revealCanvas.population.mapNodes,
              activateNode,
              showNeighbors,
              openSourceForNode,
              adjacency,
              noSummaryBackendAvailable,
              cloudSelectedNoKey,
              showDeterministicSignals,
              showLlmJudgment,
              showIngestedFindings,
              renderChangedIds,
              revealCanvas.population.foldedNodes,
              activateFoldedNode,
              contractDependentsById,
              revealCanvas.positionOf,
              revealCanvas.candidates,
              revealCanvas.reveal,
            )
        : [],
    [
      fetchState.status,
      population,
      revealCanvas,
      activateNode,
      showNeighbors,
      openSourceForNode,
      adjacency,
      noSummaryBackendAvailable,
      cloudSelectedNoKey,
      showDeterministicSignals,
      showLlmJudgment,
      showIngestedFindings,
      renderChangedIds,
      activateFoldedNode,
      contractDependentsById,
    ],
  );
  // P4-7e: in Revealed, the real edges among revealed Nodes plus each ref
  // card's faint "shown above" connector — no other edge is drawn.
  const flowEdges = useMemo(
    () =>
      revealCanvas === null
        ? toFlowEdges(population.canvasEdges)
        : [
            ...toFlowEdges(revealCanvas.population.canvasEdges),
            ...revealRefConnectorEdges(revealCanvas.reveal.auxCards),
          ],
    [population, revealCanvas],
  );
  // FIX-2: the map's real `CALLS` edges, for the `'found'` trace highlight.
  const callEdges = useMemo(() => callEdgesOf(population.riskEdges), [population]);

  const flowNodesById = useMemo(() => {
    const byId = new Map<string, CodeMapCardFlowNode>();
    for (const flowNode of flowNodes) {
      byId.set(flowNode.id, flowNode);
    }
    return byId;
  }, [flowNodes]);

  // P4-7d: the entry-candidate listing for the map on screen, fetched with
  // its section while Revealed is shown — once per map fetch (a refresh's
  // new edges array starts a new one; a summary patch doesn't), never on a
  // toggle back to a state already held. The canvas is never blocked on it:
  // a refresh keeps the previous state drawn, and loading has a status line.
  // Out-of-order replies are dropped (`revealListingRequests` +
  // `revealListingReplyOutcome`'s section and held-state checks).
  useEffect(() => {
    if (!revealDrawn || projectPath === null || revealMapStamp === null || currentRevealKey === null) {
      return;
    }
    if (!needsRevealListing(revealHeldRef.current, currentRevealKey, revealMapStamp, entryPinsRevision)) {
      return;
    }
    const key = currentRevealKey;
    const mapStamp = revealMapStamp;
    const mapNodes = revealMapNodesRef.current;
    const requestedSection = revealSection;
    const pinsRevision = entryPinsRevision;
    // P4-7g: a re-listing for the map fetch already held is a pin change,
    // not a refresh — it never moves the view.
    const sameFetch = revealHeldRef.current?.key === key && revealHeldRef.current.mapStamp === mapStamp;
    const requestId = revealListingRequests.begin();
    const started = startRevealListing(revealHeldRef.current, key, mapStamp, pinsRevision);
    revealHeldRef.current = started;
    setRevealHeld(started);
    const settle = (result: EntryCandidatesResult) => {
      // P4-7e: a refresh keeps what was drilled, pruned to the new map.
      // P4-7g: a pin change does too — the new candidates in column 0,
      // the drill beneath those still listed kept.
      const drillGraph =
        started.listing.status === 'loading' && started.listing.previous !== null
          ? revealDrillGraphFor(revealDrillGraphRef.current, mapNodes, mapStamp)
          : null;
      const outcome = revealListingReplyOutcome({
        isLatest: revealListingRequests.isLatest(requestId),
        requestedSection,
        currentSection: sectionRef.current,
        held: revealHeldRef.current,
        key,
        mapStamp,
        result,
        pinsRevision,
        sameFetch,
        drillGraph,
      });
      if (outcome.kind === 'ignore') {
        return;
      }
      if (outcome.kind === 'unknown-section') {
        // The section left the allowlist: the shell falls back to `all`
        // (P4-4d), like every other section-scoped operation.
        const gone: HeldReveal = {
          key,
          mapStamp,
          listing: {
            status: 'error',
            message: codeMapFailureMessage({ status: 'unknown-section', section: outcome.section, knownSections: [] }),
          },
        };
        revealHeldRef.current = gone;
        setRevealHeld(gone);
        onUnknownSectionRef.current?.(outcome.section);
        return;
      }
      // Review round 1: a refresh's listing re-fits once, unless the user
      // has moved the view since Revealed last fitted. A first listing is
      // fitted by the toggle's own request (or the first fit).
      if (
        outcome.held.listing.status === 'ready' &&
        revealRefitOnListing({
          revealDrawn: revealDrawnRef.current,
          hadPrevious: started.listing.status === 'loading' && started.listing.previous !== null,
          userMoved: revealUserMovedRef.current,
          sameFetch,
        })
      ) {
        revealViewRequestRef.current = { target: 'revealed', key, mapStamp };
      }
      const settledFrom = revealHeldRef.current;
      revealHeldRef.current = outcome.held;
      setRevealHeld(outcome.held);
      const landed = outcome.held.listing;
      const drawnBefore =
        settledFrom !== null && settledFrom.listing.status === 'loading' ? settledFrom.listing.previous : null;
      if (landed.status === 'ready' && landed.pinsListingFailed !== undefined) {
        // P4-7g review round 1: a failed pin-change listing kept the drawn
        // state as it was, so every reveal step still applies.
        return;
      }
      if (sameFetch && landed.status === 'ready' && drawnBefore !== null && drillGraph !== null && drillGraph.edges === mapStamp) {
        // P4-7g review round 1: a pin change on the same map rebases the
        // reveal steps the way it rebased the drawn state; only the steps
        // that no longer apply leave history.
        const graph = drillGraph;
        const fresh = initialRevealState({ status: 'found', candidates: landed.state.candidates, totalQualifying: 0 });
        setHistory((previous) =>
          rebaseRevealHistory(previous, {
            key,
            mapStamp,
            previous: drawnBefore,
            landed: landed.state,
            rebase: (state) => refreshRevealState(state, fresh, graph),
          }),
        );
        return;
      }
      // P4-7f: a listing that lands replaces the state every reveal snapshot
      // was taken from (a refresh rebases the drill), so no reveal entry
      // survives it — Back never restores a pre-refresh state.
      setHistory((previous) => historyWithoutReveals(previous));
    };
    if (isDevFixtureMode) {
      // A synthetic fixture has no Graph Service map to list candidates from.
      settle({ status: 'error', message: DEV_FIXTURE_NO_ENTRY_CANDIDATES });
      return;
    }
    window.driller.listEntryCandidates(projectPath, requestedSection ?? undefined).then(settle, (error: unknown) =>
      settle({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
  }, [
    revealDrawn,
    projectPath,
    revealMapStamp,
    revealSection,
    currentRevealKey,
    revealListingRequests,
    isDevFixtureMode,
    entryPinsRevision,
  ]);

  // P4-7d: a navigation to a Node Revealed doesn't draw switches to Full
  // (keeping the reveal state), says so, and replays once Full is laid out —
  // never a silent no-op. Read through a ref by `navigateToNodeImpl`,
  // `goBack`/`goForward` and `fitViewToPath`, so their identities (and Full's
  // behaviour) don't change: outside Revealed it returns `false` at once.
  const routeThroughFullMapRef = useRef<(ids: readonly string[], action: PendingFullNavigation) => boolean>(
    () => false,
  );
  routeThroughFullMapRef.current = (ids, action) => {
    // P4-7f review round 1: any navigation (not a replay) ends a drill announcement.
    if (!replayingFullNavigationRef.current) {
      clearRevealAnnouncement();
    }
    if (!revealDrawn || fetchState.status !== 'ready') {
      // Review round 1: the next navigation clears the switch status line —
      // but not the replay of the navigation that set it.
      if (!replayingFullNavigationRef.current) {
        setRevealSwitchStatus(null);
      }
      return false;
    }
    const mapNodes = fetchState.nodes;
    const target = hiddenNavigationTarget(
      ids,
      (id) => flowNodesById.has(id),
      (id) => mapNodes.find((node) => node.id === id),
    );
    if (target === null) {
      return false;
    }
    pendingFullNavigationRef.current = action;
    setRevealSwitchStatus(revealSwitchMessage(target.name));
    setExpandedClusterIds(new Set());
    setRevealView('full');
    return true;
  };

  // Shared with both the live render's `lodResult` (below) and
  // `centerOnNode`'s hypothetical-viewport resolution — the same
  // already-laid-out Node-ID/position set `computeLOD` needs (Boundaries &
  // Constraints: never by array index/position — this is the position
  // `layoutNodes` already computed for each content-stable Node id, not a
  // fresh derivation from list order).
  // P4-2 phase 3c: `flowNodes` includes the "Show types & modules" folded
  // cards (canvas only), so they go through LOD — clustered and revealed —
  // and reach `visibleNodeIds` like any card; nothing that counts reads this.
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

  // Story 1.9 (Phase 2): the `found` trace's Node ids and (FIX-2) every real
  // `CALLS` edge among them — never consecutive `path` pairs — the two Sets
  // `renderedNodes`/`renderedEdges` below consult to thread a distinguishing
  // `className` onto matching rendered nodes/edges. Empty (never recreated) outside `'found'` so the
  // highlight clears the instant a new search starts or a prior result is
  // superseded — no separate cleanup step needed.
  // P2-4: derived by the pure `pathTraceHighlight` (a `'neighbors'` trace
  // reads its stored snapshot, highlighted like `'found'`).
  // FIX-2: the `'found'` highlight is every real `CALLS` edge among the
  // reached Nodes, so it reads the map's own edges (`callEdges`), passed in
  // rather than stored with the trace — the trace stays the engine's result.
  const pathHighlight = useMemo(() => pathTraceHighlight(pathTrace, callEdges), [pathTrace, callEdges]);
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
    // P4-3c: the same slice the metrics table's affected rows read.
    return nodesWithinDepth(blastRadiusState.hopDistances, blastRadiusDepth);
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
    const withHighlight = (flowNode: CodeMapCardFlowNode): CodeMapCardFlowNode => {
      const className = nodeHighlightClassName(flowNode.id, pathHighlightNodeIds, blastRadiusNodeIds, contractDependentsById);
      return className !== null ? { ...flowNode, className } : flowNode;
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
      const changedCount = changedMemberCount(cluster.nodeIds, renderChangedIds);
      // P4-2 phase 3c: and its changed-contract dependents marker.
      const affectedCount = changedMemberCount(cluster.nodeIds, contractDependentsById);
      const clusterNode: CodeMapClusterFlowNode = {
        id: cluster.id,
        type: 'codeMapCluster',
        position: cluster.position,
        data: { cluster, onExpand: expandCluster, changedCount, ...(affectedCount > 0 ? { affectedCount } : {}) },
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
      changedNodeIds: renderChangedIds,
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
    contractDependentsById,
    renderChangedIds,
  ]);

  const handleNodeClick: NodeMouseHandler<CodeMapAnyFlowNode> = useCallback(
    (_event, flowNode) => {
      // P4-2 phase 3c: see `activateCanvasCard` — a map card's `onActivate`
      // is `activateNode`; a folded card's is `activateFoldedNode`.
      activateCanvasCard(flowNode, expandCluster);
    },
    [expandCluster],
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
  // browser's own history stack. Review fixes kept in `pushHistoryEntry`:
  // a navigation to the Node already current is a no-op (forward entries
  // kept), and the stack is capped at `MAX_HISTORY_LENGTH`, oldest first.
  // P4-7f: it takes the entry union; a reveal entry is never deduped.
  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory((previous) => pushHistoryEntry(previous, entry));
  }, []);

  const navigateToNodeImpl = useCallback(
    (id: string) => {
      if (routeThroughFullMapRef.current([id], { kind: 'navigate', id })) {
        return;
      }
      if (centerOnNode(id)) {
        pushHistory({ kind: 'node', id });
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

  // P4-7f: Back/Forward over a reveal entry — restores the snapshot into the
  // held state (renderer-local: no IPC, never a re-listing), switches to
  // Revealed if Full is shown, centres on the step's Node once it is laid out
  // (if still revealed), and says what happened in the Panel's status line.
  // A snapshot that isn't for the map on screen is never applied: the stale
  // reveal entries leave history instead (`restoreRevealSnapshot`).
  const applyRevealHistoryMove = useCallback(
    (move: Extract<HistoryMove, { kind: 'reveal' }>) => {
      const { key, mapStamp } = revealMapRef.current;
      const expected = move.how === 'redo' ? move.entry.before : move.entry.after;
      if (mode !== 'codeMap') {
        // Review round 1: never touched from PR Review (`skipReveals`).
        return;
      }
      const restored = restoreRevealSnapshot(revealHeldRef.current, key, move.entry, expected, move.restore);
      if (restored === null) {
        // Review round 1: only this step leaves history, and it says so.
        console.warn('CodeMap: a reveal history step is not for the map on screen — dropped from history.');
        setHistory((previous) => historyWithoutEntry(previous, move.entry));
        announceReveal(REVEAL_STEP_STALE_TEXT);
        return;
      }
      const active = document.activeElement;
      const focusedCard =
        active instanceof HTMLElement && active.closest('.react-flow__node') !== null ? active : null;
      revealHeldRef.current = restored;
      setRevealHeld(restored);
      const at = move.how === 'undo' ? move.index + 1 : move.index;
      setHistory((previous) => (previous.stack[at] === move.entry ? { ...previous, index: move.index } : previous));
      pendingFullNavigationRef.current = null;
      if (revealViewRef.current !== 'revealed') {
        // Like an explicit toggle, keep the Full viewport to come back to —
        // but ask for no fit: the centring below moves the view.
        fullViewportRef.current = revealViewRequestForToggle({
          from: revealViewRef.current,
          to: 'revealed',
          key,
          mapStamp,
          viewport: reactFlowInstanceRef.current?.getViewport() ?? null,
          saved: fullViewportRef.current,
        }).saved;
        setExpandedClusterIds(new Set());
        setRevealView('revealed');
      }
      setRevealFocusRequest({ id: move.centerId, fallbackId: move.entry.focusId, focusedCard });
      announceReveal(formatRevealHistoryAnnouncement(move.how, move.entry));
    },
    [mode, announceReveal],
  );

  const handleEdgeClick: EdgeMouseHandler<FlowEdge> = useCallback(
    (_event, edge) => {
      // P4-7e review round 1: a ref connector joins a Node to a render-only
      // ref card — never a Node pair, so it never navigates (and no ref card
      // id ever enters history). Connectors are also non-interactive.
      if (isRevealConnectorEdgeId(edge.id)) {
        return;
      }
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
  // P4-7f: a reveal entry goes through `applyRevealHistoryMove` instead —
  // Back undoes the step (its `before`), Forward redoes it (its `after`).
  const goBack = useCallback(() => {
    const move = historyMove(history, 'back', { skipReveals: mode !== 'codeMap' });
    if (move.kind === 'reveal') {
      applyRevealHistoryMove(move);
      return;
    }
    if (move.kind !== 'center') {
      return;
    }
    const nextIndex = move.index;
    const id = move.id;
    if (routeThroughFullMapRef.current([id], { kind: 'history', id, index: nextIndex })) {
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
  }, [history, centerOnNode, applyRevealHistoryMove, mode]);

  const goForward = useCallback(() => {
    const move = historyMove(history, 'forward', { skipReveals: mode !== 'codeMap' });
    if (move.kind === 'reveal') {
      applyRevealHistoryMove(move);
      return;
    }
    if (move.kind !== 'center') {
      return;
    }
    const nextIndex = move.index;
    const id = move.id;
    if (routeThroughFullMapRef.current([id], { kind: 'history', id, index: nextIndex })) {
      return;
    }
    // Review fix: see `goBack`'s matching comment — only advance on success.
    if (!centerOnNode(id)) {
      return;
    }
    setHistory((previous) => ({ ...previous, index: nextIndex }));
  }, [history, centerOnNode, applyRevealHistoryMove, mode]);

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

  // FIX-3: the first view of a mounted canvas. `initialFitDecision` gates it
  // (instance, current project's laid-out map, measured size — own
  // ResizeObserver, else React Flow's store); `initialViewport` computes it.
  // A layout effect, so the fit is applied before the browser paints; the
  // canvas is also hidden until then (`awaitingFirstFit`). The component's own
  // `viewport` state is set explicitly too: React Flow does fire `onMove` for
  // a programmatic `setViewport` (its pan-zoom handler skips only `internal`
  // events), but the LOD pass must not depend on that to leave the pre-fit
  // zoom. Instant, like the `fitView` it replaces.
  // P4-4 phase 1c: keyed on the section of the map ON SCREEN (its reply's
  // `section`), not the prop — in the render where the prop has changed, the
  // previous section's Nodes are still laid out, and fitting those would
  // spend the fit the new section's Nodes are owed.
  const shownSection = fetchState.status === 'ready' ? (fetchState.section ?? null) : null;
  useLayoutEffect(() => {
    const instance = reactFlowInstanceRef.current;
    const size = measuredViewportSize();
    const decision = initialFitDecision({
      pending: initialFitRef.current.pending,
      instanceReady: instance !== null,
      projectPath,
      fittedProjectPath: initialFitRef.current.fittedProjectPath,
      section: shownSection,
      fittedSection: initialFitRef.current.fittedSection,
      nodesCount: lodInputNodes.length,
      size,
    });
    if (decision === 'done' || instance === null) {
      return undefined;
    }
    if (decision === 'wait') {
      // Review round 1: Revealed with nothing to draw yet shows the canvas
      // (and its Panel status) at once; the fit stays armed for the cards.
      if (initialFitRetry >= INITIAL_FIT_MAX_RETRIES || revealEndsFirstFitWait(revealDrawn, lodInputNodes.length)) {
        // Never became fittable: reveal what's there rather than leave the
        // canvas hidden. The fit stays armed, so it still lands if it can.
        setAwaitingFirstFit(false);
        return undefined;
      }
      const frame = requestAnimationFrame(() => setInitialFitRetry((retry) => retry + 1));
      return () => cancelAnimationFrame(frame);
    }
    const next = initialViewport({
      nodes: lodInputNodes,
      cardSize: { width: NODE_CARD_FALLBACK_WIDTH, height: NODE_CARD_FALLBACK_HEIGHT },
      viewport: size,
      minReadableZoom: ROUTE_MIN_READABLE_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      lodThreshold: LOD_ZOOM_THRESHOLD,
    });
    if (next === null) {
      return undefined;
    }
    initialFitRef.current = completeInitialFit(projectPath, shownSection);
    const nextViewport = { x: next.x, y: next.y, zoom: next.zoom };
    void instance.setViewport(nextViewport);
    setViewport(nextViewport);
    setAwaitingFirstFit(false);
    return undefined;
  }, [canvasInitCount, initialFitRetry, lodInputNodes, containerSize, measuredViewportSize, projectPath, shownSection, revealDrawn]);

  // P4-7d (review round 1): applies the view an explicit toggle owes
  // (`changeRevealView`, or a refresh's re-fit) once its cards are laid out,
  // after the first fit — `decideRevealView` decides. Entering PR Review never
  // moves the viewport (it waits); a request for another project or section
  // is dropped. Bumps `routeFitSeqRef`, so a route fit's late lift can't land
  // over it. A session that never toggles never gets a request.
  useLayoutEffect(() => {
    const instance = reactFlowInstanceRef.current;
    const decision = decideRevealView({
      request: revealViewRequestRef.current,
      codeMapMode: mode === 'codeMap',
      revealDrawn,
      key: currentRevealKey,
      mapStamp: revealMapStamp,
      canvasReady: instance !== null,
      nodesCount: lodInputNodes.length,
      awaitingFirstFit,
      saved: fullViewportRef.current,
    });
    if (decision.kind === 'none' || decision.kind === 'wait' || instance === null) {
      return;
    }
    if (decision.kind === 'drop') {
      revealViewRequestRef.current = null;
      return;
    }
    let next: Viewport | null = decision.kind === 'restore' ? decision.viewport : null;
    if (decision.kind === 'fit') {
      const fit = initialViewport({
        nodes: lodInputNodes,
        cardSize: { width: NODE_CARD_FALLBACK_WIDTH, height: NODE_CARD_FALLBACK_HEIGHT },
        viewport: measuredViewportSize(),
        minReadableZoom: ROUTE_MIN_READABLE_ZOOM,
        maxZoom: MAP_MAX_ZOOM,
        lodThreshold: LOD_ZOOM_THRESHOLD,
      });
      next = fit === null ? null : { x: fit.x, y: fit.y, zoom: fit.zoom };
    }
    if (next === null) {
      return;
    }
    revealViewRequestRef.current = null;
    revealUserMovedRef.current = false;
    routeFitSeqRef.current += 1;
    void instance.setViewport(next);
    setViewport(next);
  }, [mode, revealDrawn, revealHeld, currentRevealKey, lodInputNodes, revealMapStamp, awaitingFirstFit, measuredViewportSize]);

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
      // P4-7d: a route through a Node Revealed doesn't draw is fitted on Full.
      if (routeThroughFullMapRef.current(path, { kind: 'fit', ids: path })) {
        return;
      }
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

  // P4-7d: replays a navigation that switched to Full (`routeThroughFullMapRef`)
  // once Full is laid out — after the view effects above restored the Full
  // viewport, and after `navigateToNodeImplRef` is synced (both declared
  // earlier, so they run first in the same commit).
  useEffect(() => {
    if (revealDrawn) {
      return;
    }
    const pending = pendingFullNavigationRef.current;
    if (pending === null) {
      return;
    }
    pendingFullNavigationRef.current = null;
    replayingFullNavigationRef.current = true;
    try {
      switch (pending.kind) {
        case 'navigate':
          navigateToNodeImplRef.current(pending.id);
          break;
        case 'history':
          if (centerOnNode(pending.id)) {
            setHistory((previous) => {
              const entry = previous.stack[pending.index];
              return entry?.kind === 'node' && entry.id === pending.id ? { ...previous, index: pending.index } : previous;
            });
          }
          break;
        case 'fit':
          fitViewToPath([...pending.ids]);
          break;
      }
    } finally {
      replayingFullNavigationRef.current = false;
    }
  }, [revealDrawn, flowNodesById, centerOnNode, fitViewToPath]);
  // P4-7f: after a Back/Forward over a reveal entry, centre on its Node once
  // the restored state is laid out — only if it is still revealed, and only
  // while Revealed is drawn (PR Review never moves for it).
  useEffect(() => {
    if (revealFocusRequest === null) {
      return;
    }
    setRevealFocusRequest(null);
    if (!revealDrawn) {
      return;
    }
    const { id, fallbackId, focusedCard } = revealFocusRequest;
    const centreId = flowNodesById.has(id) ? id : flowNodesById.has(fallbackId) ? fallbackId : null;
    if (centreId !== null) {
      centerOnNode(centreId);
    }
    // Review round 1: a restore that removed the keyboard-focused card moves
    // focus to the step's Node card if shown, else the Back button.
    const stepCard =
      canvasElement?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(fallbackId)}"] .code-map__node`) ??
      null;
    switch (
      revealFocusRescue({
        focusWasOnCard: focusedCard !== null,
        focusedCardStillShown: focusedCard?.isConnected === true,
        stepCardShown: stepCard !== null,
      })
    ) {
      case 'step-card':
        stepCard?.focus({ preventScroll: true });
        break;
      case 'back-button':
        historyBackButtonRef.current?.focus();
        break;
      case 'none':
        break;
    }
  }, [revealFocusRequest, revealDrawn, flowNodesById, centerOnNode, canvasElement]);
  // P4-7f: a reveal step belongs to one map fetch — a new fetch (a refresh)
  // drops the reveal entries taken on another one (node entries stay: Node
  // ids are content-stable across re-index). A section switch, Retry or
  // project change already clears all of history (`loadCodeMap`).
  useEffect(() => {
    setHistory((previous) =>
      historyWithoutReveals(previous, (entry) => entry.key === currentRevealKey && entry.mapStamp === revealMapStamp),
    );
  }, [currentRevealKey, revealMapStamp]);
  // Review round 1: the switch status line clears itself after
  // `REVEAL_SWITCH_STATUS_MS`, and on any mode change.
  useEffect(() => {
    if (revealSwitchStatus === null) {
      return undefined;
    }
    const timer = setTimeout(() => setRevealSwitchStatus(null), REVEAL_SWITCH_STATUS_MS);
    return () => clearTimeout(timer);
  }, [revealSwitchStatus]);
  const revealStatusModeRef = useRef(mode);
  useEffect(() => {
    if (revealStatusModeRef.current !== mode) {
      revealStatusModeRef.current = mode;
      setRevealSwitchStatus(null);
      clearRevealAnnouncement();
    }
  }, [mode, clearRevealAnnouncement]);

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
  // P4-2 phase 3b: the Nodes `resolvePathTraceQuery` checks a query against.
  const mapNodesForTrace = fetchState.status === 'ready' ? fetchState.nodes : NO_MAP_NODES;
  const runPathTrace = useCallback(
    (query: string) => {
      if (pathTrace.status === 'searching') {
        return;
      }
      const requestId = ++pathTraceRequestIdRef.current;
      // Review fix (Phase 4): captured here, not from `pathQuery` state — see
      // `lastTracedQueryRef`'s own doc comment for why the two can diverge.
      lastTracedQueryRef.current = query;
      setTypeGone(false);
      // P4-2 phase 3b: a query naming a folded type (and no map Node) has no
      // call path — say it is a type, with a way to its detail, instead of
      // tracing to "No path found". The decision is `resolvePathTraceQuery`'s.
      const preCheck = resolvePathTraceQuery(query, mapNodesForTrace, foldedTypesRef.current);
      if (preCheck.skipTrace) {
        setPathTrace(preCheck.state);
        return;
      }
      setPathTrace({ status: 'searching' });
      // P4-4 phase 2a: the trace stays inside the section on screen.
      const requestedSection = sectionRef.current;
      window.driller
        .tracePath(query, requestedSection ?? undefined)
        .then((reply) => {
          if (pathTraceRequestIdRef.current !== requestId) {
            // Superseded by a Retry/reload (or another search) — discard
            // rather than let it clobber the map the user is now looking at.
            return;
          }
          settleSectionScopedReply(reply, requestedSection, sectionRef.current, {
            apply: (result) => {
              // P4-2 phase 3b: a "no-path-found" whose query a folded type's
              // name contains becomes the "is a type" notice (current map's types).
              const state = resolvePathTraceQuery(query, mapNodesForTrace, foldedTypesRef.current, result);
              setPathTrace(state);
              if (result.status === 'found') {
                fitViewToPath(result.path);
              }
            },
            unknownSection: (gone) => {
              // The section left the allowlist: no trace; the shell falls
              // back to `all`.
              setPathTrace({ status: 'idle' });
              onUnknownSectionRef.current?.(gone);
            },
          });
        })
        .catch((error: unknown) => {
          if (pathTraceRequestIdRef.current !== requestId || requestedSection !== sectionRef.current) {
            return;
          }
          setPathTrace({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [pathTrace.status, fitViewToPath, mapNodesForTrace],
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
  const handleOpenInEditor = useCallback((node: SourceTarget) => {
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
  // P4-2 phase 3b: the type detail is a layer of its own on the same stack.
  const typeDetailOverlayRef = useRef<HTMLDivElement | null>(null);
  const typeDetailScrimProps = useModalLayer({
    open: typeDetail.status === 'open',
    onClose: closeTypeDetail,
    containerRef: typeDetailOverlayRef,
  });
  // Following a link to another type replaces the open layer, so the hook's
  // open-time focus move doesn't run again: move focus into the dialog here,
  // so it never stays on the link that just unmounted. (Closing still
  // returns focus to whatever opened the layer first.)
  const shownTypeIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = typeDetail.status === 'open' ? typeDetail.type.id : null;
    const previous = shownTypeIdRef.current;
    shownTypeIdRef.current = id;
    if (id !== null && previous !== null && previous !== id) {
      typeDetailOverlayRef.current?.focus();
    }
  }, [typeDetail]);

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
  // P4-3a: memoised — the metrics rows are an O(Nodes) pass over the map.
  // P4-3c: the blast radius and the stepper's depth give the affected rows,
  // so a step re-derives them locally — no IPC call.
  const prReviewView = useMemo(
    () => resolvePrReviewView(mode, fetchState, diffScopeState, blastRadiusState, blastRadiusDepth),
    [mode, fetchState, diffScopeState, blastRadiusState, blastRadiusDepth],
  );
  const {
    noticeStatus: prReviewNoticeStatus,
    topLevelFiles: prReviewTopLevelFiles,
    changedContracts: prReviewChangedContracts,
    changedContractsApproximate: prReviewChangedContractsApproximate,
    changedInOtherSections: prReviewChangedInOtherSections,
    surfaces,
  } = prReviewView;
  const prReviewMetricsTableProps = prReviewMetricsTableFor(prReviewView);
  const metricsTableHeight = metricsTableHeightFor(requestedMetricsTableHeight, mapHeight);

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

  // P4-4 phase 3b: Node detail's cross-section switch — App switched the
  // section and hands the callee back as `pendingFocusNodeId`. It is applied
  // only once the map of THAT section is ready (and its canvas has had its
  // first fit, so the fit can't move the view off it): `decidePendingFocus`.
  // Then App is told, once, so it never re-applies.
  const onPendingFocusConsumedRef = useRef(onPendingFocusConsumed);
  useEffect(() => {
    onPendingFocusConsumedRef.current = onPendingFocusConsumed;
  }, [onPendingFocusConsumed]);
  const focusCardFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (focusCardFrameRef.current !== null) {
        cancelAnimationFrame(focusCardFrameRef.current);
      }
    },
    [],
  );
  // Carry review: on unmount, a carry check or diff run still in flight must
  // never apply (nor re-run a diff) — their request ids move on.
  useEffect(() => {
    const carryIds = diffCarryRequestIdRef;
    const diffIds = diffScopeRequestIdRef;
    return () => {
      carryIds.current += 1;
      diffIds.current += 1;
    };
  }, []);
  // P4-7d: a map Node the Revealed view doesn't draw (`undefined` in Full,
  // where every map Node is drawn).
  const revealHiddenMapNode = (id: string): CodeMapNode | undefined =>
    revealDrawn && fetchState.status === 'ready' ? fetchState.nodes.find((node) => node.id === id) : undefined;
  useEffect(() => {
    const decision = decidePendingFocus({
      pendingFocusNodeId,
      section,
      fetchState,
      canvas: surfaces.canvas,
      canvasReady: reactFlowInstanceRef.current !== null && !awaitingFirstFit,
      // P4-7d: in Revealed, a Node it doesn't draw is still on the map —
      // `navigateToNode` switches to Full to reach it.
      resolveMapNode: (id) => mapNodeOf(flowNodesById.get(id)) ?? revealHiddenMapNode(id),
    });
    if (decision.kind === 'none' || decision.kind === 'wait') {
      return;
    }
    onPendingFocusConsumedRef.current?.();
    switch (decision.kind) {
      case 'focus': {
        navigateToNode(decision.id);
        // Keyboard users land on the selected card: focus it once React Flow
        // has rendered it (it can be culled until the centring brings it into
        // view), for at most ~1s of frames.
        if (focusCardFrameRef.current !== null) {
          cancelAnimationFrame(focusCardFrameRef.current);
        }
        let frames = 0;
        const selector = `.react-flow__node[data-id="${CSS.escape(decision.id)}"] .code-map__node`;
        const tryFocus = () => {
          focusCardFrameRef.current = null;
          const card = canvasElement?.querySelector<HTMLElement>(selector) ?? null;
          // Review round 1: never left on <body> — the canvas wrapper takes
          // focus when the card never renders (`cardFocusStep`).
          switch (cardFocusStep(card !== null, frames)) {
            case 'focus-card':
              card?.focus({ preventScroll: true });
              return;
            case 'focus-canvas':
              canvasElement?.focus({ preventScroll: true });
              return;
            case 'retry':
              frames += 1;
              focusCardFrameRef.current = requestAnimationFrame(tryFocus);
              return;
          }
        };
        focusCardFrameRef.current = requestAnimationFrame(tryFocus);
        return;
      }
      case 'open-detail': {
        // Review round 1: the panel returns focus to whatever held it when it
        // opened — the selected Section bar tab, never <body>.
        const tabId =
          fetchState.status === 'ready' ? selectedSectionTabId(fetchState.sections ?? [], section) : undefined;
        if (tabId !== undefined) {
          document.getElementById(tabId)?.focus();
        }
        focusedNodeIdRef.current = decision.node.id;
        openNodeDetail(decision.node);
        return;
      }
      case 'missing': {
        const target = crossSectionTargetRef.current;
        setCrossSectionMiss({
          name: target !== null && target.id === decision.id ? target.name : decision.id,
          section: section ?? '',
        });
        return;
      }
    }
  }, [
    pendingFocusNodeId,
    section,
    fetchState,
    revealDrawn,
    surfaces.canvas,
    awaitingFirstFit,
    canvasInitCount,
    flowNodesById,
    navigateToNode,
    openNodeDetail,
    canvasElement,
  ]);
  // Review round 1: the missed-callee notice takes focus (its Dismiss button,
  // described by the notice's text) when it appears.
  useEffect(() => {
    if (crossSectionMiss !== null) {
      document.getElementById(CROSS_SECTION_MISS_DISMISS_ID)?.focus();
    }
  }, [crossSectionMiss]);
  // Review round 1: PR Review's "Switch to …" — once that section's map is
  // ready, focus lands on the base-ref input (or the selected Section bar
  // tab), never <body> (`prReviewSwitchFocusTarget`).
  useEffect(() => {
    const targetSection = prReviewSwitchFocusRef.current;
    if (targetSection === null) {
      return;
    }
    const input = baseRefInputRef.current;
    const target = prReviewSwitchFocusTarget({
      targetSection,
      section,
      fetchState,
      baseRefFocusable: mode === 'prReview' && input !== null && !input.disabled,
    });
    if (target === 'wait') {
      return;
    }
    prReviewSwitchFocusRef.current = null;
    if (target === 'base-ref') {
      input?.focus();
    } else if (target === 'section-tab' && fetchState.status === 'ready') {
      const tabId = selectedSectionTabId(fetchState.sections ?? [], section);
      if (tabId !== undefined) {
        document.getElementById(tabId)?.focus();
      }
    }
  }, [section, fetchState, mode, diffScopeState.status]);
  // Review round 1: dismissing the missed-callee notice hands focus to the
  // selected Section bar tab (the notice, and its button, unmount).
  const dismissCrossSectionMiss = useCallback(() => {
    setCrossSectionMiss(null);
    const tabId = fetchState.status === 'ready' ? selectedSectionTabId(fetchState.sections ?? [], section) : undefined;
    if (tabId !== undefined) {
      document.getElementById(tabId)?.focus();
    }
  }, [fetchState, section]);
  const handleSwitchSectionFromPrReview = useCallback(
    (targetSection: string) => {
      prReviewSwitchFocusRef.current = targetSection;
      onSwitchSection(targetSection);
    },
    [onSwitchSection],
  );
  // P4-4 phase 3b: a "Calls into other sections" row's switch. Remembers the
  // callee's name for a "not on the current map" notice.
  const handleSwitchSectionFromDetail = useCallback(
    (targetSection: string, focusNodeId: string) => {
      const call = nodeDetailRef.current.status === 'open'
        ? nodeDetailRef.current.node.crossSectionCalls?.find((entry) => entry.id === focusNodeId)
        : undefined;
      crossSectionTargetRef.current = { id: focusNodeId, name: call?.name ?? focusNodeId };
      switchSectionFromDetail(targetSection, focusNodeId, { closeNodeDetail, onSwitchSection });
    },
    [closeNodeDetail, onSwitchSection],
  );

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
    // P4-3b: the inline `--code-map-table-height` is the divider's height;
    // the canvas frame, bottom clearance and refresh error all follow it.
    <div
      className="code-map"
      id={MODAL_FOCUS_FALLBACK_ID}
      tabIndex={-1}
      ref={setMapElement}
      style={codeMapTableHeightStyle(prReviewMetricsTableProps !== null, metricsTableHeight, mapHeight)}
    >
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
          own `Panel`, `<Controls>`'s default bottom-left). FIX-4: on a map
          narrower than 1040px it moves top-right and the history toolbar
          drops below the search row (styles.css container queries) — and rendered as
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
              ref={baseRefInputRef}
              placeholder="Base ref (leave blank to auto-resolve)…"
              aria-label="Base ref"
              value={baseRefInput}
              onChange={(event) => {
                // Carry review: typing cancels a carry check in flight — its
                // late reply must never wipe or override what was typed.
                diffCarryRequestIdRef.current += 1;
                setDiffCarryPending(null);
                setBaseRefInput(event.target.value);
              }}
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
          <PrReviewDiffScopeNoticeRegion
            status={prReviewNoticeStatus}
            topLevelFiles={prReviewTopLevelFiles}
            onOpenFile={openSourceForNode}
            changedContracts={prReviewChangedContracts}
            changedContractsApproximate={prReviewChangedContractsApproximate}
            onOpenType={openType}
          />

          {/* Review finding (Blind Hunter): the `'idle'` state (before the
              user's first trigger click) previously rendered nothing at
              all — the ordinary map, no hint that a diff hasn't been
              computed yet. One concrete next action, matching this file's
              own Actionable Notice convention. */}
          {diffScopeState.status === 'idle' && (
            <p className="code-map__pr-review-resolved" role="status">
              {/* Carry review: a section switch's base-ref check says so. */}
              {diffCarryPending !== null
                ? diffScopeCarryCheckingText(diffCarryPending)
                : 'Enter a base ref (or leave it blank to auto-resolve) and compute the diff scope to see changed Nodes.'}
            </p>
          )}
          {/* Review finding (Blind Hunter): the button's own text changing
              to "Computing…" isn't reliably announced by assistive tech on
              its own — a dedicated `role="status"` (implicit `aria-live`)
              announcement, same convention as the resolved/idle messages
              here. */}
          {diffScopeState.status === 'loading' && (
            <p className="code-map__pr-review-resolved" role="status">
              {/* P4-4 phase 3b: a section switch's automatic re-run says so. */}
              {diffCarryNote ?? 'Computing diff scope…'}
            </p>
          )}

          {diffScopeState.status === 'resolved' && (
            <p className="code-map__pr-review-resolved" role="status">
              Diffed against <code>{diffScopeState.resolvedBaseRef}</code> —{' '}
              {formatDiffScopeChangeCount(
                diffScopeState.nodeIds.size,
                diffScopeState.topLevelFiles.length,
                diffScopeState.changedContracts.length,
              )}
              .
              {/* P4-4 phase 3b: the "changed elsewhere" line below sits
                  outside this live region (its buttons aren't read out); its
                  text is announced here. */}
              <span className="visually-hidden">{changedElsewhereAnnouncement(prReviewChangedInOtherSections)}</span>
            </p>
          )}
          {/* P4-4 phase 3b: what the diff changed in other sections of the
              same repository, beneath the change count — "3 changed Nodes in
              `api/` — Switch to `api`". Only on a section map; absent for
              none. The switch keeps PR Review. */}
          <ChangedElsewhereLine
            changedInOtherSections={prReviewChangedInOtherSections}
            onSwitchSection={handleSwitchSectionFromPrReview}
            graphServiceAvailable={graphServiceAvailable}
          />

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
                  {blastRadiusSummary(blastRadiusNodeIds.size, blastRadiusDepth)}
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
            section={fetchState.section ?? null}
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
        <HealthAuditClusterGrid grouping={healthClusters} onActivateNode={openNodeDetail} projectPath={projectPath} />
      )}

      {surfaces.canvas && (
        // React Flow does not size itself from CSS alone — the parent
        // `.code-map` div is sized via `position: absolute; inset: 0`
        // (styles.css), but `<ReactFlow>`'s own root element still needs an
        // explicit width/height or it collapses to 0×0 and renders nothing.
        // P4-3a: the frame is the canvas's size — `.code-map` minus the
        // metrics table's band — and the element the ResizeObserver
        // measures, so fits, LOD bounds and zoom-to-reveal all see the canvas
        // the user sees, and `<Controls>`/the signal toggles sit above the table.
        <CodeMapCanvasFrame canvasRef={setCanvasElement}>
          <ReactFlow<CodeMapAnyFlowNode>
            style={{ width: '100%', height: '100%', visibility: awaitingFirstFit ? 'hidden' : undefined }}
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
            // FIX-3: no `fitView` — the first view comes from `initialViewport`
            // (the effect after `measuredViewportSize`), which never opens
            // below `ROUTE_MIN_READABLE_ZOOM`.
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
              {/* P4-2 phase 3c: "Show types & modules" — draws the folded
                  Types/Interfaces/Modules back on the canvas, render only; off
                  by default and remembered per project. The hint says what it
                  doesn't do: no risk number moves. */}
              <label className="code-map__signal-toggle" title={SHOW_FOLDED_KINDS_HINT}>
                <input
                  type="checkbox"
                  checked={showFoldedKinds}
                  onChange={(event) => changeShowFoldedKinds(event.target.checked)}
                  aria-describedby={SHOW_FOLDED_KINDS_HINT_ID}
                />
                Show types &amp; modules
              </label>
              <span id={SHOW_FOLDED_KINDS_HINT_ID} className="code-map__signal-toggle-hint">
                Risk numbers unchanged
                <span className="visually-hidden">: {SHOW_FOLDED_KINDS_HINT}</span>
              </span>
              {/* P4-7d: "Revealed / Full map" — Code Map mode only (PR Review
                  always renders Full; Health Audit has no canvas). The status
                  line is always mounted with it, so its text is announced:
                  the listing's loading line, or the switch to Full a
                  navigation to a hidden Node made. */}
              {mode === 'codeMap' && (
                <>
                  <RevealViewToggle view={revealView} onChange={changeRevealView} />
                  <p className="code-map__reveal-status" role="status">
                    {revealStatus}
                  </p>
                </>
              )}
            </Panel>
          </ReactFlow>
        </CodeMapCanvasFrame>
      )}

      {/* P4-7d: a Revealed listing with no candidates, or a failed one — the
          shared Actionable Notice with "Show full map", over the canvas that
          has nothing to draw. Never an empty canvas without it. */}
      {surfaces.canvas && revealDrawn && isCanvasRevealNotice(revealNotice) && (
        <div className="code-map__notice code-map__notice--reveal">
          <RevealListingNotice
            notice={revealNotice}
            onShowFullMap={() => changeRevealView('full')}
          />
        </div>
      )}

      {/* P0-2b: `pathTraceInput`, NOT `canvas` — search stays reachable in
          Health Audit Mode too; submitting there switches to Code Map Mode so
          the route lands on a canvas (`resolvePathTraceSubmit`). The RESULT
          surfaces inside this wrapper follow `pathTraceResult` instead, which
          does track the canvas — see `CodeMapSurfaces`. */}
      {/* Review round 1: with no showable map (an empty section) the Path
          Trace wrapper below isn't rendered — the missed-callee notice still
          is, in the same corner. */}
      {!surfaces.pathTraceInput && crossSectionMiss !== null && (
        <div className="code-map__path-trace">
          <CrossSectionMissNotice
            name={crossSectionMiss.name}
            section={crossSectionMiss.section}
            onDismiss={dismissCrossSectionMiss}
          />
        </div>
      )}
      {surfaces.pathTraceInput && (
        // Story 1.9 (Phase 2): the always-reachable Path Trace search
        // affordance — persistent/non-modal, mirroring the history
        // toolbar's own `role="toolbar"`/absolute-over-canvas pattern just
        // below (Boundaries & Constraints: "never a `role="dialog"`
        // overlay ... must stay usable while the map is still interacted
        // with"). Positioned opposite the history toolbar (top-left vs.
        // top-right); on a narrow map (FIX-4, styles.css container queries)
        // the history toolbar drops below this search row instead, so the
        // two never overlap — which is why the history toolbar follows this
        // block in the DOM: Tab order then matches that narrow visual order
        // (search, results, history). A PR Review diff-scope notice
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

          {/* P4-4 phase 3b: a cross-section switch's callee isn't on the new
              map — said, never a silent no-op. Outside the result gate, so it
              shows over Health Audit's grid too. */}
          {crossSectionMiss !== null && (
            <CrossSectionMissNotice
              name={crossSectionMiss.name}
              section={crossSectionMiss.section}
              onDismiss={dismissCrossSectionMiss}
            />
          )}

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
            {pathTrace.status === 'folded-type' && (
              <PathTraceFoldedTypeNotice
                query={pathTrace.query}
                types={pathTrace.types}
                onOpenType={(id) => {
                  // The notice has done its job once the detail opens.
                  if (openType(id)) {
                    setPathTrace({ status: 'idle' });
                  }
                }}
                onDismiss={() => setPathTrace({ status: 'idle' })}
              />
            )}
            {typeGone && typeDetail.status === 'closed' && nodeDetail.status === 'closed' && <TypeGoneNotice />}
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
                parents={pathTrace.parents}
                depths={pathTrace.depths}
                resolveNode={(id) => {
                  const node = mapNodeOf(flowNodesById.get(id));
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
                originName={mapNodeOf(flowNodesById.get(pathTrace.originId))?.name ?? pathTrace.originId}
                direction={pathTrace.direction}
                neighborIds={pathTrace.neighborIds}
                resolveNode={(id) => {
                  const node = mapNodeOf(flowNodesById.get(id));
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

      {/* P0-2b: also gated off Health Audit Mode — this floats over the
          canvas, and there is no canvas there to traverse. */}
      {surfaces.canvas && (
        // Story 1.4 Code Map: "New lightweight Back/Forward toolbar ...
        // disabled at either end of history" — renderer-local chrome over
        // the ephemeral `history` state, never persisted/IPC'd (AD-2
        // restated). Gated on `surfaces.canvas`, the same flag as the
        // `<ReactFlow>` it floats over, so Back/Forward never renders
        // without a map underneath to traverse. A PR Review diff-scope
        // notice does not gate it: that notice sits above the map. FIX-4:
        // rendered after the Path Trace block so Tab order follows the
        // narrow-map layout, where this drops below the search row; its
        // wide-map placement (top-right) is absolute, so order doesn't move it.
        <div className="code-map__history-toolbar" role="toolbar" aria-label="Map traversal history">
          <button
            type="button"
            ref={historyBackButtonRef}
            onClick={goBack}
            disabled={!canGoBack(history, { skipReveals: mode !== 'codeMap' })}
            aria-label="Back"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={goForward}
            disabled={!canGoForward(history, { skipReveals: mode !== 'codeMap' })}
            aria-label="Forward"
          >
            Forward →
          </button>
        </div>
      )}

      {/* P4-3a: the changed-Node metrics table, in the fixed-height band
          `--code-map-table-height` (styles.css) keeps free below the canvas.
          `prReviewMetricsTableFor` gates it: PR Review, a showable map with
          its canvas, a resolved diff scope and at least one row. After the
          history toolbar and before the overlays, so Tab order follows the
          layout: the top toolbars first, then the table at the bottom.
          P4-3b: its divider comes right before it, in the DOM and Tab order,
          and only with it.
          P4-3e: a row opens Node detail through `openNodeDetail`, never
          `activateNode` — no mode switch, no Path Trace side effect, no
          viewport move, and no `focusedNodeIdRef` write (P0-2c's accepted
          degradation, above). `useModalLayer` returns focus to the row's
          button on close, or to `.code-map` if the row has gone.
          P4-3g: the gate also opens for changed contracts alone; a contract
          row opens its type detail through `openType`, as the toolbar's
          contract lines (`PrReviewDiffScopeNoticeRegion`) do. */}
      {prReviewMetricsTableProps !== null && (
        <>
          <MetricsTableDivider
            height={metricsTableHeight}
            mapHeight={mapHeight}
            onResize={handleMetricsTableResize}
          />
          <PrReviewMetricsTable
            {...prReviewMetricsTableProps}
            sort={prReviewMetricSort}
            onSort={setPrReviewMetricSort}
            onActivateNode={openNodeDetail}
            onOpenType={openType}
          />
        </>
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
                {sourceView.node.label !== undefined && (
                  <span className="code-map__source-label">{sourceView.node.label} — </span>
                )}
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
              onOpenTest={(target) => openTestFromDetail(target, { closeNodeDetail, openSourceForNode })}
              // P4-2 phase 3a: the rendered population `navigateToNode`
              // centres on, so only a navigable Node becomes a button.
              resolveMapNode={(id) => mapNodeOf(flowNodesById.get(id))}
              onNavigateToNode={(id) => navigateFromDetail(id, { closeNodeDetail, navigateToNode })}
              // P4-2 phase 3b: a "Uses" entry opens its type's detail in
              // place of this panel.
              resolveFoldedType={resolveFoldedType}
              onOpenType={openType}
              // P4-4 phase 3b: "Calls into other sections" — only on a
              // section map; a row's switch closes this panel, switches
              // through App and selects the callee on the new map.
              mapSection={fetchState.status === 'ready' ? (fetchState.section ?? null) : null}
              onSwitchSection={handleSwitchSectionFromDetail}
              // P4-7g: pin or unpin this Node as an entry point.
              entryPin={
                projectPath === null
                  ? undefined
                  : {
                      pinned: entryPins?.includes(nodeDetail.node.id) ?? false,
                      busy: entryPinBusy || entryPins === null,
                      message: entryPinMessage?.nodeId === nodeDetail.node.id ? entryPinMessage.text : null,
                      onToggle: () => toggleEntryPin(nodeDetail.node.id),
                    }
              }
            />
            {typeGone && typeDetail.status === 'closed' && <TypeGoneNotice />}
            {/* P0-1: the one-click source action this panel's IA row
                promises — reuses `openSourceForNode` unchanged, at this
                Node's exact range. Closes the panel on the way (P0-1's
                behaviour, kept: the Node's own source replaces its detail).
                P4-2 phase 2's "Tested by" rows instead stack the source
                viewer (z-index 11) over this panel. P2-12: pinned as the
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
      {/* P4-2 phase 3b: the type detail — the Node detail surface's type
          variant, for a Type/Interface folded off the map. Opened from Node
          detail's "Uses" / "File top-level", another type's links or Path
          Trace's "is a type" notice; a sibling of the Node detail overlay for
          the same reason that one is a sibling of the surface gates. It is
          its own modal layer, STACKED over an open Node detail (z-index
          above it), so Escape returns to the Node and focus to the link that
          opened it. Following a link to another type REPLACES this top layer
          (no deeper stack): Escape from there still returns to the Node
          detail (or the map) beneath. */}
      {typeDetail.status === 'open' && (
        <div
          ref={typeDetailOverlayRef}
          className="code-map__node-detail-overlay code-map__node-detail-overlay--type"
          role="dialog"
          aria-modal="true"
          aria-label={`Type detail: ${typeDetail.type.name}`}
          tabIndex={-1}
          {...typeDetailScrimProps}
        >
          <div className="code-map__node-detail-panel">
            <TypeDetailHead type={typeDetail.type} onClose={closeTypeDetail} />
            <TypeDetailBody
              type={typeDetail.type}
              resolveMapNode={(id) => mapNodeOf(flowNodesById.get(id))}
              onNavigateToNode={(id) =>
                navigateFromTypeDetail(id, { closeTypeDetail, closeNodeDetail, navigateToNode })
              }
              resolveFoldedType={resolveFoldedType}
              onOpenType={openType}
            />
            {typeGone && <TypeGoneNotice />}
            <button
              type="button"
              className="code-map__node-detail-source"
              onClick={() => {
                const target = foldedTypeSourceTarget(typeDetail.type);
                closeTypeDetail();
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
