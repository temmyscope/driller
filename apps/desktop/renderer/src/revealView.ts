/**
 * P4-7d: the Code Map's Revealed view, as pure functions (no React), so every
 * decision is unit-tested (`revealView.test.ts`) and `CodeMap.tsx` only wires
 * them up.
 *
 * Revealed draws only the reveal set: the entry candidates
 * (`listEntryCandidates`, AD-13 (f)) and, from phase 3, the Nodes drilled
 * into from them, laid out in columns by hop depth (`layeredLayout`). It is
 * a filter on what the canvas lays out and hands to `computeLOD`, before
 * layout (AD-2) — never a new kind of clustering, and never an input to a
 * number: risk, the blast radius, adjacency, Path Trace and Health Audit keep
 * reading the full fetched map (`CanvasPopulation.riskNodes`/`riskEdges`).
 * Full map is today's code path, untouched.
 *
 * Copy rule (EXPERIENCE.md "Code Map | Revealed"): a candidate is always
 * called a "candidate", and every claim is qualified "in indexed code".
 */
import {
  entryReachAdjacency,
  type BidirectionalAdjacency,
  type CodeMapEdge,
  type CodeMapNode,
  type EntryCandidate,
  type EntryCandidatesResult,
} from '@driller/ipc-contracts';

import type { CanvasPopulation } from './CodeMap';

// No LOD/layout library yet (Design Notes: acceptable at this phase's real
// scale) — a plain deterministic grid, roughly square, is enough to lay the
// full fetched Node set out without overlap. P4-7d: declared here (and
// re-exported by `CodeMap.tsx`, where every existing importer reads them) so
// this pure module needs no value import from the React component module —
// the Full grid (`layoutPosition`) and the Revealed columns (`layeredLayout`)
// share one spacing.
export const NODE_COLUMN_GAP = 260;
export const NODE_ROW_GAP = 110;

/** The two views of the Code Map canvas. Session state, default `'full'` (never persisted — Ask First). */
export type RevealViewMode = 'full' | 'revealed';

/** One revealed Node: its hop depth from a candidate (0 for a candidate) and the Node it was revealed from. */
export interface RevealedEntry {
  depth: number;
  parentId: string | null;
}

/**
 * P4-7e: one entry of the reveal tree.
 *  - `node`: a revealed Node — its card. `reach` is its distinct forward reach
 *    in the drill adjacency (a candidate's is the server's), kept for ordering.
 *  - `ref`: a callee of `parentId` already revealed elsewhere — a small
 *    "↺ `<name>` shown above" card, never a second card for `targetId`.
 *  - `more`: the stub for `parentId`'s callees past `REVEAL_LAYER_CAP` —
 *    "+N more callees".
 * `depth` is the column; a ref or stub sits in its parent's child column.
 * Refs and stubs are render-only (like `FoldedCanvasNode`): never a
 * `CodeMapNode`, never in `revealed`, never counted.
 */
export type RevealEntry =
  | { kind: 'node'; id: string; depth: number; parentId: string | null; reach: number }
  | { kind: 'ref'; parentId: string; targetId: string; depth: number }
  | { kind: 'more'; parentId: string; hiddenCount: number; depth: number };

/**
 * What Revealed shows: the candidates it started from, every revealed Node
 * id (`revealed`, an index of the `node` entries), and the reveal tree
 * (`entries`: nodes, refs and stubs). Immutable: every transition returns a
 * new state and never edits the one it was given (P4-7f's history keeps
 * before/after snapshots).
 */
export interface RevealState {
  candidates: EntryCandidate[];
  revealed: ReadonlyMap<string, RevealedEntry>;
  entries: readonly RevealEntry[];
}

/** P4-7e: a state from its candidates and entries — `revealed` indexes the `node` entries (the first one per id). */
export function revealStateOf(candidates: EntryCandidate[], entries: readonly RevealEntry[]): RevealState {
  const revealed = new Map<string, RevealedEntry>();
  for (const entry of entries) {
    if (entry.kind === 'node' && !revealed.has(entry.id)) {
      revealed.set(entry.id, { depth: entry.depth, parentId: entry.parentId });
    }
  }
  return { candidates, revealed, entries };
}

export const EMPTY_REVEAL_STATE: RevealState = { candidates: [], revealed: new Map(), entries: [] };

/** The start state for a `found` listing: every candidate revealed, in column 0. */
export function initialRevealState(result: Extract<EntryCandidatesResult, { status: 'found' }>): RevealState {
  return revealStateOf(
    result.candidates,
    result.candidates.map((candidate) => ({
      kind: 'node' as const,
      id: candidate.id,
      depth: 0,
      parentId: null,
      reach: candidate.reach,
    })),
  );
}

/** P4-7e: a ref card's canvas id — never a Node id (no Node id starts with `reveal:`). */
export function revealRefCardId(parentId: string, targetId: string): string {
  return `reveal:ref:${JSON.stringify([parentId, targetId])}`;
}

/** P4-7e: a stub card's canvas id (one stub per parent). */
export function revealStubCardId(parentId: string): string {
  return `reveal:more:${JSON.stringify(parentId)}`;
}

/** P4-7e: an entry's canvas id — the Node id for a `node`, the render-only card id otherwise. */
export function revealEntryCardId(entry: RevealEntry): string {
  switch (entry.kind) {
    case 'node':
      return entry.id;
    case 'ref':
      return revealRefCardId(entry.parentId, entry.targetId);
    case 'more':
      return revealStubCardId(entry.parentId);
  }
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Within one parent's children: Nodes first, then refs, then the stub. */
const ENTRY_KIND_RANK: Record<RevealEntry['kind'], number> = { node: 0, ref: 1, more: 2 };

/**
 * The layered layout: column = depth × `NODE_COLUMN_GAP`; within a column,
 * row index × `NODE_ROW_GAP`, ordered by the parent's row (a Node with no
 * parent — a candidate — first), then Nodes before refs before the stub,
 * then reach descending (a candidate's reach is the server's; a drilled
 * Node's is the one it was revealed with), then id. Never depends on the
 * order of `entries` or `candidates`. Parents are laid out first (shallower
 * columns), so a parent's row is known when its children are ordered.
 * P4-7e: ref and stub cards are placed too, under their own card ids
 * (`revealEntryCardId`); a depth past the canvas just adds columns.
 */
export function layeredLayout(state: RevealState): Map<string, { x: number; y: number }> {
  const reachById = new Map<string, number>();
  for (const candidate of state.candidates) {
    reachById.set(candidate.id, candidate.reach);
  }
  const byDepth = new Map<number, { cardId: string; entry: RevealEntry }[]>();
  const seen = new Set<string>();
  for (const entry of state.entries) {
    const cardId = revealEntryCardId(entry);
    if (seen.has(cardId)) {
      continue;
    }
    seen.add(cardId);
    if (entry.kind === 'node' && !reachById.has(entry.id)) {
      reachById.set(entry.id, entry.reach);
    }
    const column = byDepth.get(entry.depth);
    if (column === undefined) {
      byDepth.set(entry.depth, [{ cardId, entry }]);
    } else {
      column.push({ cardId, entry });
    }
  }
  const rowOf = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  const parentRow = (entry: RevealEntry): number => {
    const parentId = entry.parentId;
    return parentId === null ? -1 : (rowOf.get(parentId) ?? -1);
  };
  const reachOf = (entry: RevealEntry): number => (entry.kind === 'node' ? (reachById.get(entry.id) ?? 0) : 0);
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const column = [...(byDepth.get(depth) ?? [])].sort(
      (a, b) =>
        parentRow(a.entry) - parentRow(b.entry) ||
        ENTRY_KIND_RANK[a.entry.kind] - ENTRY_KIND_RANK[b.entry.kind] ||
        reachOf(b.entry) - reachOf(a.entry) ||
        compareIds(a.cardId, b.cardId),
    );
    column.forEach(({ cardId }, row) => {
      rowOf.set(cardId, row);
      positions.set(cardId, { x: depth * NODE_COLUMN_GAP, y: row * NODE_ROW_GAP });
    });
  }
  return positions;
}

/** `revealedPopulation`'s result: the population to draw, plus its map Nodes (the cards `layoutNodes` lays out). */
export interface RevealedPopulation extends CanvasPopulation {
  /** `canvasNodes` without the folded cards, in fetched order. */
  mapNodes: readonly CodeMapNode[];
}

/**
 * Filters what the canvas draws to the revealed ids: `canvasNodes` (and the
 * folded cards in it) to revealed ids only, `canvasEdges` to edges with both
 * ends revealed. `riskNodes`/`riskEdges` are passed through untouched — the
 * same arrays — because every number reads them, never the drawing.
 */
export function revealedPopulation(population: CanvasPopulation, state: RevealState): RevealedPopulation {
  const isRevealed = (id: string) => state.revealed.has(id);
  const canvasNodes = population.canvasNodes.filter((node) => isRevealed(node.id));
  const mapNodes = canvasNodes.filter((node): node is CodeMapNode => !('folded' in node));
  return {
    riskNodes: population.riskNodes,
    riskEdges: population.riskEdges,
    canvasNodes,
    canvasEdges: population.canvasEdges.filter((edge) => isRevealed(edge.source) && isRevealed(edge.target)),
    foldedNodes: population.foldedNodes.filter((node) => isRevealed(node.id)),
    mapNodes,
  };
}

/** "reaches 1 Node" / "reaches 4 Nodes". */
function reachPhrase(reach: number): string {
  return `reaches ${reach} Node${reach === 1 ? '' : 's'}`;
}

/** A candidate's reason, without the load-time files: "no callers in indexed code · reaches N Nodes". */
export function formatCandidateReason(candidate: EntryCandidate): string {
  return `no callers in indexed code · ${reachPhrase(candidate.reach)}`;
}

/**
 * The files whose top-level code runs the candidate at load (`reason.loadedBy`,
 * at most 3, sorted) and how many more there are, or `null` when none.
 */
export function candidateLoadedBy(candidate: EntryCandidate): { files: readonly string[]; more: number } | null {
  const files = candidate.reason.loadedBy ?? [];
  if (files.length === 0) {
    return null;
  }
  return { files, more: Math.max(0, (candidate.reason.loadedByTotal ?? files.length) - files.length) };
}

/** The whole reason line as text: the reason, plus "· run at load by a.ts, b.ts and 2 more" when present. */
export function formatCandidateReasonLine(candidate: EntryCandidate): string {
  const loadedBy = candidateLoadedBy(candidate);
  const base = formatCandidateReason(candidate);
  if (loadedBy === null) {
    return base;
  }
  const more = loadedBy.more > 0 ? ` and ${loadedBy.more} more` : '';
  return `${base} · run at load by ${loadedBy.files.join(', ')}${more}`;
}

/** A candidate card's accessible-name suffix: ", entry candidate, reaches N Nodes" — or `''` for any other card. */
export function candidateAriaSuffix(candidate: EntryCandidate | undefined): string {
  return candidate === undefined ? '' : `, entry candidate, ${reachPhrase(candidate.reach)}`;
}

// ---------------------------------------------------------------------------
// The listing and its held state
// ---------------------------------------------------------------------------

/**
 * One map fetch's candidate listing, as Revealed shows it. `loading` may
 * carry the previous listing's state for the same project and section (a
 * refresh), which stays drawn until the new one lands — the canvas is never
 * blocked on the listing.
 */
export type RevealListing =
  | { status: 'loading'; previous: RevealState | null }
  | { status: 'ready'; state: RevealState; totalQualifying: number }
  | { status: 'none' }
  | { status: 'error'; message: string };

/**
 * The held reveal state: which project and section it is for (`key`), which
 * map fetch it was listed for (`mapStamp`: that fetch's edges array, whose
 * identity changes only with a new fetch — never with a summary patch), and
 * the listing. Switching to Full and back keeps it; a section switch or a
 * new project drops it (`heldRevealFor`).
 */
export interface HeldReveal {
  key: string;
  mapStamp: readonly CodeMapEdge[];
  listing: RevealListing;
}

/** The held state's key: one project and one section (`null` = the whole scope). */
export function revealKey(projectPath: string, section: string | null): string {
  return JSON.stringify([projectPath, section]);
}

/** The held state for `key`, or `null` — a state held for another project or section is dropped, never restored. */
export function heldRevealFor(held: HeldReveal | null, key: string): HeldReveal | null {
  return held !== null && held.key === key ? held : null;
}

/**
 * Whether the map on screen (`key`, `mapStamp`) still needs a listing: none
 * held for it, one for an earlier fetch, or a failed one (so coming back to
 * Revealed retries it — e.g. after "The map is refreshing…").
 */
export function needsRevealListing(held: HeldReveal | null, key: string, mapStamp: readonly CodeMapEdge[]): boolean {
  const current = heldRevealFor(held, key);
  return current === null || current.mapStamp !== mapStamp || current.listing.status === 'error';
}

/** The held state while a listing for (`key`, `mapStamp`) is in flight: a refresh keeps the previous state drawn. */
export function startRevealListing(
  held: HeldReveal | null,
  key: string,
  mapStamp: readonly CodeMapEdge[],
): HeldReveal {
  const current = heldRevealFor(held, key);
  const previous =
    current === null
      ? null
      : current.listing.status === 'ready'
        ? current.listing.state
        : current.listing.status === 'loading'
          ? current.listing.previous
          : null;
  return { key, mapStamp, listing: { status: 'loading', previous } };
}

/** A settled listing (never `unknown-section`, which the caller hands to the section fallback). */
export function revealListingOf(result: Exclude<EntryCandidatesResult, { status: 'unknown-section' }>): RevealListing {
  switch (result.status) {
    case 'found':
      return { status: 'ready', state: initialRevealState(result), totalQualifying: result.totalQualifying };
    case 'none':
      return { status: 'none' };
    case 'error':
      return { status: 'error', message: result.message };
  }
}

/**
 * What a listing reply does. Dropped (`ignore`) unless it is the latest
 * request (`isLatest`, from `createLatestRequestGuard`), was sent for the
 * section on screen now (the renderer's form of the reply's echoed section —
 * main already settles a mismatched echo as an error), and the held state is
 * still the one it was started for (same key and map fetch). Otherwise an
 * `unknown-section` reply goes to the section fallback, and anything else
 * becomes the held listing.
 */
export type RevealReplyOutcome =
  | { kind: 'ignore' }
  | { kind: 'unknown-section'; section: string }
  | { kind: 'apply'; held: HeldReveal };

export function revealListingReplyOutcome(input: {
  isLatest: boolean;
  requestedSection: string | null;
  currentSection: string | null;
  held: HeldReveal | null;
  key: string;
  mapStamp: readonly CodeMapEdge[];
  result: EntryCandidatesResult;
  /**
   * P4-7e: the drill graph of the map the listing was for. With it, a
   * refresh's listing keeps what was drilled (`refreshRevealState`): ids
   * still on the map stay, vanished ones go with their subtrees.
   */
  drillGraph?: RevealDrillGraph | null;
}): RevealReplyOutcome {
  const { isLatest, requestedSection, currentSection, held, key, mapStamp, result, drillGraph = null } = input;
  if (!isLatest || requestedSection !== currentSection) {
    return { kind: 'ignore' };
  }
  if (held === null || held.key !== key || held.mapStamp !== mapStamp) {
    return { kind: 'ignore' };
  }
  if (result.status === 'unknown-section') {
    return { kind: 'unknown-section', section: requestedSection ?? result.section };
  }
  const listing = revealListingOf(result);
  const previous = held.listing.status === 'loading' ? held.listing.previous : null;
  if (listing.status === 'ready' && previous !== null && drillGraph !== null && drillGraph.edges === mapStamp) {
    return {
      kind: 'apply',
      held: { key, mapStamp, listing: { ...listing, state: refreshRevealState(previous, listing.state, drillGraph) } },
    };
  }
  return { kind: 'apply', held: { key, mapStamp, listing } };
}

/**
 * The reveal state to draw for the map on screen: the held listing's state,
 * or a refresh's previous state while loading; otherwise nothing (an empty
 * reveal set — with the loading line, or the none/error notice, beside it).
 */
export function drawnRevealState(held: HeldReveal | null, key: string | null): RevealState {
  const current = key === null ? null : heldRevealFor(held, key);
  if (current === null) {
    return EMPTY_REVEAL_STATE;
  }
  if (current.listing.status === 'ready') {
    return current.listing.state;
  }
  if (current.listing.status === 'loading' && current.listing.previous !== null) {
    return current.listing.previous;
  }
  return EMPTY_REVEAL_STATE;
}

/** The none notice's sentence (EXPERIENCE.md "Code Map | No entry candidates"). */
export const NO_ENTRY_CANDIDATES_SENTENCE =
  'No entry candidates found in indexed code (every Node has a caller, or reaches fewer than 3 Nodes).';

/** The loading line, beside the canvas (never over it). */
export const ENTRY_CANDIDATES_LOADING_TEXT = 'Finding entry candidates in indexed code…';

/** Review round 1: a ready listing none of whose candidates is on the map on screen (never an empty canvas without a notice). */
export const ENTRY_CANDIDATES_NOT_ON_MAP_SENTENCE =
  'Couldn’t show the entry candidates: none of them is on the map on screen.';

/**
 * Which notice Revealed shows for the held listing: `none` → the warning
 * notice; `error` → the error notice with its message; `stale` → a ready
 * listing that draws nothing on this map (`drawnCount` 0, review round 1);
 * all three offer one action, "Show full map".
 * `loading` → the loading line (with or without a refresh's previous state);
 * `ready` with cards drawn → nothing. With no listing held for the map on
 * screen yet, `loading` (the fetch effect starts one).
 */
export type RevealNotice =
  | { kind: 'none'; tone: 'warning'; sentence: string }
  | { kind: 'error'; tone: 'error'; sentence: string }
  | { kind: 'stale'; tone: 'error'; sentence: string }
  | { kind: 'loading'; text: string }
  | null;

export function revealNoticeFor(held: HeldReveal | null, key: string | null, drawnCount: number): RevealNotice {
  const current = key === null ? null : heldRevealFor(held, key);
  if (current === null) {
    return { kind: 'loading', text: ENTRY_CANDIDATES_LOADING_TEXT };
  }
  switch (current.listing.status) {
    case 'loading':
      return { kind: 'loading', text: ENTRY_CANDIDATES_LOADING_TEXT };
    case 'none':
      return { kind: 'none', tone: 'warning', sentence: NO_ENTRY_CANDIDATES_SENTENCE };
    case 'error':
      return { kind: 'error', tone: 'error', sentence: `Couldn’t list entry candidates: ${current.listing.message}` };
    case 'ready':
      return drawnCount === 0 ? { kind: 'stale', tone: 'error', sentence: ENTRY_CANDIDATES_NOT_ON_MAP_SENTENCE } : null;
  }
}

/** Whether a notice is one of the over-the-canvas ones (with "Show full map"). */
export function isCanvasRevealNotice(
  notice: RevealNotice,
): notice is Extract<RevealNotice, { kind: 'none' | 'error' | 'stale' }> {
  return notice !== null && (notice.kind === 'none' || notice.kind === 'error' || notice.kind === 'stale');
}

/** Review round 1: the honest cap line — "Showing 12 of 20 candidates (most reach first)" — or `null` when nothing was cut. */
export function revealCapText(held: HeldReveal | null, key: string | null): string | null {
  const current = key === null ? null : heldRevealFor(held, key);
  if (current === null || current.listing.status !== 'ready') {
    return null;
  }
  const shown = current.listing.state.candidates.length;
  const total = current.listing.totalQualifying;
  return total > shown ? `Showing ${shown} of ${total} candidates (most reach first)` : null;
}

/**
 * Review round 1: the Panel's one `role="status"` line (EXPERIENCE.md: one
 * status region) — the switch-to-Full message first, then the notice's
 * sentence (none, error, stale) or the loading line, then the cap line;
 * `''` when there's nothing to say. The notices over the canvas carry no
 * live-region role of their own, so nothing is announced twice.
 */
export function revealStatusText(input: {
  switchStatus: string | null;
  notice: RevealNotice;
  capText: string | null;
}): string {
  const { switchStatus, notice, capText } = input;
  if (switchStatus !== null) {
    return switchStatus;
  }
  if (notice !== null) {
    return notice.kind === 'loading' ? notice.text : notice.sentence;
  }
  return capText ?? '';
}

/** The candidates of the drawn state by id, for their cards. */
export function candidatesById(state: RevealState): ReadonlyMap<string, EntryCandidate> {
  return new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
}

// ---------------------------------------------------------------------------
// Navigating to a hidden Node
// ---------------------------------------------------------------------------

/**
 * The first of `ids` that is on the fetched map but not drawn — the Node a
 * navigation (Path Trace, a Node-detail link, an edge, history) would fail to
 * reach in Revealed — or `null` when every target is drawn (or not on the
 * map at all, which the navigation itself reports as before).
 */
export function hiddenNavigationTarget(
  ids: readonly string[],
  isDrawn: (id: string) => boolean,
  mapNodeById: (id: string) => CodeMapNode | undefined,
): CodeMapNode | null {
  for (const id of ids) {
    if (isDrawn(id)) {
      continue;
    }
    const node = mapNodeById(id);
    if (node !== undefined) {
      return node;
    }
  }
  return null;
}

/** The status line after switching to Full to reach a hidden Node. */
export function revealSwitchMessage(name: string): string {
  return `Showing the full map to reach ${name}`;
}

/** Review round 1: how long "Showing the full map to reach X" stays before it clears itself. */
export const REVEAL_SWITCH_STATUS_MS = 8000;

// ---------------------------------------------------------------------------
// The viewport (review round 1: explicit toggles only)
// ---------------------------------------------------------------------------

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** A view change owed to the viewport, for the map it was asked on (`key`, `mapStamp`). */
export interface RevealViewRequest {
  target: RevealViewMode;
  key: string | null;
  mapStamp: readonly CodeMapEdge[] | null;
}

/** The Full viewport saved on an explicit switch into Revealed. */
export interface SavedFullViewport {
  key: string | null;
  mapStamp: readonly CodeMapEdge[] | null;
  viewport: Viewport;
}

/**
 * An explicit toggle (the Panel control, or a notice's "Show full map") from
 * `from` to `to`: entering Revealed saves the current Full viewport and owes
 * a fit to the candidates; leaving it owes the Full view back. No change → no
 * request. Nothing else (a mode change, a navigation's switch to Full, a
 * section switch) asks for a view.
 */
export function revealViewRequestForToggle(input: {
  from: RevealViewMode;
  to: RevealViewMode;
  key: string | null;
  mapStamp: readonly CodeMapEdge[] | null;
  viewport: Viewport | null;
  saved: SavedFullViewport | null;
}): { request: RevealViewRequest | null; saved: SavedFullViewport | null } {
  const { from, to, key, mapStamp, viewport, saved } = input;
  if (from === to) {
    return { request: null, saved };
  }
  if (to === 'revealed') {
    return {
      request: { target: 'revealed', key, mapStamp },
      saved: viewport === null ? null : { key, mapStamp, viewport },
    };
  }
  return { request: { target: 'full', key, mapStamp }, saved };
}

/**
 * Whether a listing that just landed owes a re-fit: only a refresh's listing
 * (a previous state was drawn), in Revealed, when the user hasn't moved the
 * view since Revealed last fitted. A first listing is fitted by the toggle's
 * own request or by the first fit.
 */
export function revealRefitOnListing(input: { revealDrawn: boolean; hadPrevious: boolean; userMoved: boolean }): boolean {
  return input.revealDrawn && input.hadPrevious && !input.userMoved;
}

/**
 * What to do with an owed view now:
 *  - `drop`: it was asked on another project, section or map fetch (it can
 *    never apply), or for the other view while that view is not shown in Code
 *    Map mode (a later toggle replaces it);
 *  - `wait`: the canvas, its cards or the first fit aren't there yet, or
 *    another mode is shown (entering PR Review never moves the viewport);
 *  - `restore` the saved Full viewport (same map fetch), or `fit` what is drawn.
 */
export type RevealViewDecision =
  | { kind: 'none' }
  | { kind: 'drop' }
  | { kind: 'wait' }
  | { kind: 'restore'; viewport: Viewport }
  | { kind: 'fit' };

export function decideRevealView(input: {
  request: RevealViewRequest | null;
  codeMapMode: boolean;
  revealDrawn: boolean;
  key: string | null;
  mapStamp: readonly CodeMapEdge[] | null;
  canvasReady: boolean;
  nodesCount: number;
  awaitingFirstFit: boolean;
  saved: SavedFullViewport | null;
}): RevealViewDecision {
  const { request, codeMapMode, revealDrawn, key, mapStamp, canvasReady, nodesCount, awaitingFirstFit, saved } = input;
  if (request === null) {
    return { kind: 'none' };
  }
  if (request.key !== key) {
    return { kind: 'drop' };
  }
  if (!codeMapMode) {
    return { kind: 'wait' };
  }
  if (request.target !== (revealDrawn ? 'revealed' : 'full')) {
    return { kind: 'drop' };
  }
  if (!canvasReady || nodesCount === 0 || awaitingFirstFit) {
    return { kind: 'wait' };
  }
  if (request.target === 'full' && saved !== null && saved.key === key && saved.mapStamp === mapStamp) {
    return { kind: 'restore', viewport: saved.viewport };
  }
  return { kind: 'fit' };
}

/**
 * Review round 1: the first fit is waiting for cards, but Revealed has none to
 * draw yet (loading, none, error) — show the canvas (and its Panel status)
 * at once instead of holding it hidden for the retry window. The fit stays
 * armed, so it lands when the candidates do. Never in Full.
 */
export function revealEndsFirstFitWait(revealDrawn: boolean, nodesCount: number): boolean {
  return revealDrawn && nodesCount === 0;
}


// ---------------------------------------------------------------------------
// P4-7e: drilling — expand, collapse, the stub, and a refresh
// ---------------------------------------------------------------------------

/**
 * Decision 3: when an expand's first layer adds this many Nodes or fewer, the
 * layer beneath them opens in the same step (two layers); otherwise one.
 * Changing it is Ask First.
 */
export const REVEAL_TWO_LAYER_MAX = 12;

/**
 * Decision 3: a parent's newly revealed child list longer than this shows the
 * top `REVEAL_LAYER_CAP` by reach plus a "+N more callees" stub — per parent,
 * in either layer. Changing it is Ask First.
 */
export const REVEAL_LAYER_CAP = 30;

/** A Node's distinct forward reach in the drill adjacency, itself excluded. */
export interface ReachById {
  get(id: string): number;
}

/**
 * The distinct forward reach of each Node over `adjacency` (the candidates'
 * own `entryReachAdjacency`, so a candidate's agrees with the server's
 * `reach` — tested), itself excluded.
 *
 * Review round 1 (an expand on a 50k map took ~1.5 s with a string-keyed
 * walk per callee): on the first `get`, once per drill graph (one per map
 * fetch), the graph is indexed by integer and condensed into its strongly
 * connected components (iterative Tarjan). A Node's reach is its
 * component's: the sizes of every component reachable from it in the
 * condensation, minus itself — one int-indexed walk per component, memoized,
 * so every Node of a big cycle shares one walk.
 */
export function computeReachById(adjacency: BidirectionalAdjacency): ReachById {
  let index: ComponentReachIndex | null = null;
  return {
    get(id: string): number {
      index ??= new ComponentReachIndex(adjacency);
      return index.reachOf(id);
    },
  };
}

/** The condensation of the drill adjacency, with a memoized reach per component. */
class ComponentReachIndex {
  private readonly indexOf = new Map<string, number>();
  private readonly componentOf: Int32Array;
  private readonly componentSize: Int32Array;
  private readonly componentOffsets: Int32Array;
  private readonly componentTargets: Int32Array;
  private readonly componentReach: Int32Array;
  private readonly visitedStamp: Uint32Array;
  private readonly queue: Int32Array;
  private stamp = 0;

  constructor(adjacency: BidirectionalAdjacency) {
    const ids = [...adjacency.validNodeIds];
    const count = ids.length;
    ids.forEach((id, i) => this.indexOf.set(id, i));
    // Compressed forward adjacency over Node indices.
    const offsets = new Int32Array(count + 1);
    const targetList: number[] = [];
    ids.forEach((id, i) => {
      for (const target of adjacency.forward.get(id) ?? []) {
        const t = this.indexOf.get(target);
        if (t !== undefined) {
          targetList.push(t);
        }
      }
      offsets[i + 1] = targetList.length;
    });
    const targets = Int32Array.from(targetList);

    // Iterative Tarjan: components are numbered in completion order, so every
    // component's successors have smaller numbers.
    const componentOf = new Int32Array(count).fill(-1);
    const order = new Int32Array(count).fill(-1);
    const low = new Int32Array(count);
    const onStack = new Uint8Array(count);
    const stack = new Int32Array(count);
    const callNode = new Int32Array(count);
    const callEdge = new Int32Array(count);
    let stackTop = 0;
    let nextOrder = 0;
    let components = 0;
    for (let root = 0; root < count; root += 1) {
      if (order[root] !== -1) {
        continue;
      }
      let depth = 0;
      callNode[0] = root;
      callEdge[0] = offsets[root]!;
      order[root] = low[root] = nextOrder++;
      stack[stackTop++] = root;
      onStack[root] = 1;
      while (depth >= 0) {
        const v = callNode[depth]!;
        const edgeAt = callEdge[depth]!;
        if (edgeAt < offsets[v + 1]!) {
          callEdge[depth] = edgeAt + 1;
          const w = targets[edgeAt]!;
          if (order[w] === -1) {
            order[w] = low[w] = nextOrder++;
            stack[stackTop++] = w;
            onStack[w] = 1;
            depth += 1;
            callNode[depth] = w;
            callEdge[depth] = offsets[w]!;
          } else if (onStack[w] === 1 && order[w]! < low[v]!) {
            low[v] = order[w]!;
          }
          continue;
        }
        if (low[v] === order[v]) {
          let w: number;
          do {
            w = stack[--stackTop]!;
            onStack[w] = 0;
            componentOf[w] = components;
          } while (w !== v);
          components += 1;
        }
        depth -= 1;
        if (depth >= 0) {
          const parent = callNode[depth]!;
          if (low[v]! < low[parent]!) {
            low[parent] = low[v]!;
          }
        }
      }
    }

    // The condensation: distinct successor components per component.
    const componentSize = new Int32Array(components);
    for (let v = 0; v < count; v += 1) {
      componentSize[componentOf[v]!]! += 1;
    }
    const membersStart = new Int32Array(components + 1);
    for (let c = 0; c < components; c += 1) {
      membersStart[c + 1] = membersStart[c]! + componentSize[c]!;
    }
    const members = new Int32Array(count);
    const fill = membersStart.slice(0, components);
    for (let v = 0; v < count; v += 1) {
      const c = componentOf[v]!;
      members[fill[c]!++] = v;
    }
    const seen = new Int32Array(components).fill(-1);
    const componentOffsets = new Int32Array(components + 1);
    const componentTargetList: number[] = [];
    for (let c = 0; c < components; c += 1) {
      for (let m = membersStart[c]!; m < membersStart[c + 1]!; m += 1) {
        const v = members[m]!;
        for (let e = offsets[v]!; e < offsets[v + 1]!; e += 1) {
          const d = componentOf[targets[e]!]!;
          if (d !== c && seen[d] !== c) {
            seen[d] = c;
            componentTargetList.push(d);
          }
        }
      }
      componentOffsets[c + 1] = componentTargetList.length;
    }
    this.componentOf = componentOf;
    this.componentSize = componentSize;
    this.componentOffsets = componentOffsets;
    this.componentTargets = Int32Array.from(componentTargetList);
    this.componentReach = new Int32Array(components).fill(-1);
    this.visitedStamp = new Uint32Array(components);
    this.queue = new Int32Array(components);
  }

  /** `id`'s distinct forward reach, itself excluded; 0 for an id not in the graph. */
  reachOf(id: string): number {
    const v = this.indexOf.get(id);
    if (v === undefined) {
      return 0;
    }
    const component = this.componentOf[v]!;
    const known = this.componentReach[component]!;
    if (known >= 0) {
      return known;
    }
    this.stamp += 1;
    const { componentOffsets, componentTargets, componentSize, visitedStamp, queue, stamp } = this;
    visitedStamp[component] = stamp;
    queue[0] = component;
    let tail = 1;
    let total = 0;
    for (let head = 0; head < tail; head += 1) {
      const c = queue[head]!;
      total += componentSize[c]!;
      for (let e = componentOffsets[c]!; e < componentOffsets[c + 1]!; e += 1) {
        const d = componentTargets[e]!;
        if (visitedStamp[d] !== stamp) {
          visitedStamp[d] = stamp;
          queue[tail++] = d;
        }
      }
    }
    const reach = total - 1;
    this.componentReach[component] = reach;
    return reach;
  }
}

/** One map fetch's drill inputs: the adjacency every reveal step walks and the reach that orders it. */
export interface RevealDrillGraph {
  /** The fetch's edges array — its identity (`mapStamp`). */
  edges: readonly CodeMapEdge[];
  adjacency: BidirectionalAdjacency;
  reachById: ReachById;
}

/**
 * The drill graph for the map on screen — reused while the fetch is the same
 * (same `edges` array: a summary patch keeps it), rebuilt on a new fetch.
 * Walks `entryReachAdjacency`: `CALLS` and `USAGE`, never `IMPORTS`, so a
 * reveal matches its candidate's stated reach. A section's map holds only
 * that section's Nodes and edges, so the drill never leaves the section.
 */
export function revealDrillGraphFor(
  cached: RevealDrillGraph | null,
  nodes: readonly Pick<CodeMapNode, 'id' | 'name'>[],
  edges: readonly CodeMapEdge[],
): RevealDrillGraph {
  if (cached !== null && cached.edges === edges) {
    return cached;
  }
  const adjacency = entryReachAdjacency([...nodes], [...edges]);
  return { edges, adjacency, reachById: computeReachById(adjacency) };
}

/** `id`'s distinct callees in the drill adjacency, in adjacency order. */
function calleesOf(adjacency: BidirectionalAdjacency, id: string): string[] {
  return [...new Set(adjacency.forward.get(id) ?? [])];
}

/** Reach descending, then id — the order a parent's fresh callees are revealed in. */
function byReachThenId(reachById: ReachById): (a: string, b: string) => number {
  return (a, b) => reachById.get(b) - reachById.get(a) || compareIds(a, b);
}

/**
 * Reveals `parentId`'s callees into `entries` (mutated; a working copy):
 * those not yet revealed become cards (the top `REVEAL_LAYER_CAP` by reach,
 * then id, plus a stub for the rest), and those already revealed become refs.
 * `skip` holds callees already represented under this parent (a stub
 * expansion). Returns the ids of the new cards.
 */
function revealChildren(
  entries: RevealEntry[],
  revealedIds: Set<string>,
  adjacency: BidirectionalAdjacency,
  reachById: ReachById,
  parentId: string,
  depth: number,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const callees = calleesOf(adjacency, parentId).filter((id) => !skip.has(id));
  const fresh = callees.filter((id) => !revealedIds.has(id)).sort(byReachThenId(reachById));
  const already = callees.filter((id) => revealedIds.has(id)).sort(compareIds);
  const shown = fresh.slice(0, REVEAL_LAYER_CAP);
  for (const id of shown) {
    revealedIds.add(id);
    entries.push({ kind: 'node', id, depth, parentId, reach: reachById.get(id) });
  }
  for (const targetId of already) {
    entries.push({ kind: 'ref', parentId, targetId, depth });
  }
  const hiddenCount = fresh.length - shown.length;
  if (hiddenCount > 0) {
    entries.push({ kind: 'more', parentId, hiddenCount, depth });
  }
  return shown;
}

/** Whether `id` has anything revealed beneath it (a card, a ref or a stub) — it is expanded. */
function isExpanded(state: RevealState, id: string): boolean {
  return state.entries.some((entry) => entry.parentId === id);
}

/**
 * Expands a revealed Node: its callees not yet revealed open as the first
 * layer, sorted by reach descending, then id; a callee already revealed
 * becomes a "↺ shown above" ref, never a second card. When the first layer
 * adds `REVEAL_TWO_LAYER_MAX` Nodes or fewer, the layer beneath those Nodes
 * opens in the same step. Each parent's new list is capped at
 * `REVEAL_LAYER_CAP` with a stub. Pure: no IPC, never edits `state`; an
 * unrevealed or already-expanded Node returns `state` unchanged.
 */
export function expandNode(
  state: RevealState,
  adjacency: BidirectionalAdjacency,
  reachById: ReachById,
  id: string,
): RevealState {
  const at = state.revealed.get(id);
  if (at === undefined || isExpanded(state, id)) {
    return state;
  }
  const entries = [...state.entries];
  const revealedIds = new Set(state.revealed.keys());
  const firstLayer = revealChildren(entries, revealedIds, adjacency, reachById, id, at.depth + 1);
  if (firstLayer.length <= REVEAL_TWO_LAYER_MAX) {
    for (const childId of firstLayer) {
      revealChildren(entries, revealedIds, adjacency, reachById, childId, at.depth + 2);
    }
  }
  return entries.length === state.entries.length ? state : revealStateOf(state.candidates, entries);
}

/** The callees of `parentId` already represented beneath it (a child card or a ref). */
function representedUnder(state: RevealState, parentId: string): Set<string> {
  const represented = new Set<string>();
  for (const entry of state.entries) {
    if (entry.parentId !== parentId) {
      continue;
    }
    if (entry.kind === 'node') {
      represented.add(entry.id);
    } else if (entry.kind === 'ref') {
      represented.add(entry.targetId);
    }
  }
  return represented;
}

/**
 * Activates `parentId`'s "+N more callees" stub: the next `REVEAL_LAYER_CAP`
 * of its hidden callees open (reach descending, then id) in the stub's
 * column, keeping a stub while more remain. A hidden callee revealed
 * elsewhere since becomes a ref. One layer only. No stub → `state`.
 */
export function expandStub(
  state: RevealState,
  adjacency: BidirectionalAdjacency,
  reachById: ReachById,
  parentId: string,
): RevealState {
  const stub = state.entries.find((entry) => entry.kind === 'more' && entry.parentId === parentId);
  if (stub === undefined) {
    return state;
  }
  const entries = state.entries.filter((entry) => entry !== stub);
  const revealedIds = new Set(state.revealed.keys());
  revealChildren(entries, revealedIds, adjacency, reachById, parentId, stub.depth, representedUnder(state, parentId));
  return revealStateOf(state.candidates, entries);
}

/**
 * Collapses `id`: every Node whose reveal-tree ancestry passes through `id`
 * is removed, with every ref and stub beneath a removed Node (or `id`). `id`
 * itself stays, and a candidate always stays.
 *
 * Review round 1 (a diamond): a removed Node that a surviving parent showed
 * as a ref is re-homed as a plain card (no subtree) under the first such
 * parent, in place of that ref — so collapsing restores the view from before
 * the expand, and that parent's callees stay complete. Any other ref to it
 * stays (its target is shown again). Never an orphaned ref.
 */
export function collapseNode(state: RevealState, id: string): RevealState {
  if (!state.revealed.has(id)) {
    return state;
  }
  const candidateIds = new Set(state.candidates.map((candidate) => candidate.id));
  const children = new Map<string, string[]>();
  for (const entry of state.entries) {
    if (entry.kind === 'node' && entry.parentId !== null) {
      const list = children.get(entry.parentId);
      if (list === undefined) {
        children.set(entry.parentId, [entry.id]);
      } else {
        list.push(entry.id);
      }
    }
  }
  const removed = new Set<string>();
  const queue = [id];
  for (let head = 0; head < queue.length; head += 1) {
    for (const child of children.get(queue[head]!) ?? []) {
      if (!removed.has(child) && !candidateIds.has(child) && child !== id) {
        removed.add(child);
        queue.push(child);
      }
    }
  }
  if (removed.size === 0 && !state.entries.some((entry) => entry.parentId === id)) {
    return state;
  }
  const under = (parentId: string | null) => parentId === id || (parentId !== null && removed.has(parentId));
  const removedReach = new Map<string, number>();
  for (const entry of state.entries) {
    if (entry.kind === 'node' && removed.has(entry.id)) {
      removedReach.set(entry.id, entry.reach);
    }
  }
  const rehomed = new Set<string>();
  const entries: RevealEntry[] = [];
  for (const entry of state.entries) {
    if (entry.kind === 'node') {
      if (!removed.has(entry.id)) {
        entries.push(entry);
      }
    } else if (!under(entry.parentId)) {
      if (entry.kind === 'ref' && removed.has(entry.targetId) && !rehomed.has(entry.targetId)) {
        rehomed.add(entry.targetId);
        entries.push({
          kind: 'node',
          id: entry.targetId,
          depth: entry.depth,
          parentId: entry.parentId,
          reach: removedReach.get(entry.targetId) ?? 0,
        });
      } else {
        entries.push(entry);
      }
    }
  }
  return revealStateOf(state.candidates, entries);
}

/**
 * A map refresh: drops every revealed Node no longer on the map
 * (`nodeIds`), with its subtree; every ref whose parent or target is gone;
 * every stub whose parent is gone. A candidate on the map always stays.
 * Depths are re-based from the kept parent (review round 1: a Node promoted
 * to candidate brings its subtree to columns 1, 2, …).
 *
 * With the new fetch's `adjacency`, a Node, ref or stub beneath a parent that
 * no longer calls it is dropped too (never a fabricated edge), and every
 * expanded parent is made complete again (review round 1): a callee it
 * gained that is shown elsewhere becomes a ref, and its callees still hidden
 * are counted into its stub (a new one, or none at 0).
 */
export function pruneRevealState(
  state: RevealState,
  nodeIds: ReadonlySet<string>,
  adjacency?: BidirectionalAdjacency,
): RevealState {
  const calls = (parentId: string, id: string) =>
    adjacency === undefined || (adjacency.forward.get(parentId) ?? []).includes(id);
  const depthOf = new Map<string, number>();
  const nodeEntries = state.entries
    .filter((entry): entry is Extract<RevealEntry, { kind: 'node' }> => entry.kind === 'node')
    .sort((a, b) => a.depth - b.depth);
  for (const entry of nodeEntries) {
    if (!nodeIds.has(entry.id) || depthOf.has(entry.id)) {
      continue;
    }
    if (entry.parentId === null) {
      depthOf.set(entry.id, 0);
    } else {
      const parentDepth = depthOf.get(entry.parentId);
      if (parentDepth !== undefined && calls(entry.parentId, entry.id)) {
        depthOf.set(entry.id, parentDepth + 1);
      }
    }
  }
  const entries: RevealEntry[] = [];
  const placed = new Set<string>();
  const rebased = <T extends RevealEntry>(entry: T, depth: number): T =>
    entry.depth === depth ? entry : { ...entry, depth };
  for (const entry of state.entries) {
    if (entry.kind === 'node') {
      const depth = depthOf.get(entry.id);
      if (depth !== undefined && !placed.has(entry.id) && (entry.parentId === null || depthOf.has(entry.parentId))) {
        placed.add(entry.id);
        entries.push(rebased(entry, depth));
      }
      continue;
    }
    const parentDepth = depthOf.get(entry.parentId);
    if (parentDepth === undefined) {
      continue;
    }
    if (entry.kind === 'ref') {
      if (depthOf.has(entry.targetId) && calls(entry.parentId, entry.targetId)) {
        entries.push(rebased(entry, parentDepth + 1));
      }
    } else {
      entries.push(rebased(entry, parentDepth + 1));
    }
  }
  const completed = adjacency === undefined ? entries : completeExpandedParents(entries, depthOf, adjacency);
  const unchanged =
    completed.length === state.entries.length && completed.every((entry, i) => entry === state.entries[i]);
  return unchanged ? state : revealStateOf(state.candidates, completed);
}

/**
 * Review round 1: after a refresh, every expanded parent (anything beneath
 * it) represents all its callees again — a callee shown elsewhere but not
 * beneath it becomes a ref; its callees not shown anywhere are its stub's
 * count (the stub added, updated, or dropped at 0).
 */
function completeExpandedParents(
  entries: readonly RevealEntry[],
  depthOf: ReadonlyMap<string, number>,
  adjacency: BidirectionalAdjacency,
): RevealEntry[] {
  const represented = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.parentId === null || entry.kind === 'more') {
      if (entry.parentId !== null && !represented.has(entry.parentId)) {
        represented.set(entry.parentId, new Set());
      }
      continue;
    }
    const set = represented.get(entry.parentId) ?? new Set<string>();
    set.add(entry.kind === 'node' ? entry.id : entry.targetId);
    represented.set(entry.parentId, set);
  }
  const hiddenOf = new Map<string, number>();
  const added: RevealEntry[] = [];
  for (const [parentId, shown] of represented) {
    const depth = (depthOf.get(parentId) ?? 0) + 1;
    let hidden = 0;
    for (const callee of calleesOf(adjacency, parentId)) {
      if (shown.has(callee)) {
        continue;
      }
      if (depthOf.has(callee)) {
        added.push({ kind: 'ref', parentId, targetId: callee, depth });
      } else {
        hidden += 1;
      }
    }
    hiddenOf.set(parentId, hidden);
  }
  const out: RevealEntry[] = [];
  const stubbed = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'more') {
      out.push(entry);
      continue;
    }
    stubbed.add(entry.parentId);
    const hiddenCount = hiddenOf.get(entry.parentId) ?? 0;
    if (hiddenCount === entry.hiddenCount) {
      out.push(entry);
    } else if (hiddenCount > 0) {
      out.push({ ...entry, hiddenCount });
    }
  }
  out.push(...added);
  for (const [parentId, hiddenCount] of hiddenOf) {
    if (hiddenCount > 0 && !stubbed.has(parentId)) {
      out.push({ kind: 'more', parentId, hiddenCount, depth: (depthOf.get(parentId) ?? 0) + 1 });
    }
  }
  return out;
}

/**
 * A refresh's listing landing on a drilled state: the new candidates in
 * column 0, plus what was drilled beneath candidates that are still
 * candidates, pruned to the new map (`pruneRevealState`). A Node that is no
 * longer a candidate leaves with its subtree — column 0 is the listing.
 */
export function refreshRevealState(previous: RevealState, fresh: RevealState, graph: RevealDrillGraph): RevealState {
  const candidateIds = new Set(fresh.candidates.map((candidate) => candidate.id));
  const carried = previous.entries.filter((entry) =>
    entry.kind === 'node' ? entry.parentId !== null && !candidateIds.has(entry.id) : true,
  );
  const merged = revealStateOf(fresh.candidates, [...fresh.entries, ...carried]);
  return pruneRevealState(merged, graph.adjacency.validNodeIds, graph.adjacency);
}

/** The control on a revealed Node's card: "▸ Expand callees (N)", "▾ Collapse", or none (`null`). */
export type RevealDrillControl = { kind: 'expand'; count: number } | { kind: 'collapse' };

/**
 * Each revealed Node's control: `collapse` when anything is revealed beneath
 * it; otherwise `expand` with N = its callees not yet revealed anywhere;
 * none at N = 0 (a leaf, or every callee already shown).
 */
export function revealDrillControls(
  state: RevealState,
  adjacency: BidirectionalAdjacency,
): ReadonlyMap<string, RevealDrillControl> {
  const parents = new Set<string>();
  for (const entry of state.entries) {
    if (entry.parentId !== null) {
      parents.add(entry.parentId);
    }
  }
  const controls = new Map<string, RevealDrillControl>();
  for (const id of state.revealed.keys()) {
    if (parents.has(id)) {
      controls.set(id, { kind: 'collapse' });
      continue;
    }
    const count = calleesOf(adjacency, id).filter((callee) => !state.revealed.has(callee)).length;
    if (count > 0) {
      controls.set(id, { kind: 'expand', count });
    }
  }
  return controls;
}

/** A render-only card for a ref or a stub — drawn beside the revealed Nodes, never one of them. */
export type RevealAuxCard =
  | { kind: 'ref'; id: string; parentId: string; targetId: string; targetName: string }
  | { kind: 'more'; id: string; parentId: string; parentName: string; hiddenCount: number };

/**
 * The ref and stub cards to draw: those whose parent (and, for a ref, target)
 * is a drawn Node (`nameOf` resolves it) — so a refresh still landing never
 * draws "shown above" for a Node that isn't. Review round 1: with
 * `adjacency`, a stub's count is the parent's callees not shown anywhere now
 * (some may have been revealed elsewhere since); a stub with none left isn't
 * drawn.
 */
export function revealAuxCards(
  state: RevealState,
  nameOf: (id: string) => string | undefined,
  adjacency?: BidirectionalAdjacency,
): RevealAuxCard[] {
  const cards: RevealAuxCard[] = [];
  const seen = new Set<string>();
  for (const entry of state.entries) {
    if (entry.kind === 'node') {
      continue;
    }
    const id = revealEntryCardId(entry);
    const parentName = nameOf(entry.parentId);
    if (seen.has(id) || parentName === undefined) {
      continue;
    }
    if (entry.kind === 'ref') {
      const targetName = nameOf(entry.targetId);
      if (targetName !== undefined) {
        seen.add(id);
        cards.push({ kind: 'ref', id, parentId: entry.parentId, targetId: entry.targetId, targetName });
      }
    } else {
      const hiddenCount =
        adjacency === undefined
          ? entry.hiddenCount
          : calleesOf(adjacency, entry.parentId).filter((callee) => !state.revealed.has(callee)).length;
      if (hiddenCount > 0) {
        seen.add(id);
        cards.push({ kind: 'more', id, parentId: entry.parentId, parentName, hiddenCount });
      }
    }
  }
  return cards;
}

/** "↺ repository shown above" — a ref card's text. */
export function revealRefText(targetName: string): string {
  return `↺ ${targetName} shown above`;
}

/** "+15 more callees" — a stub card's text. */
export function revealStubText(hiddenCount: number): string {
  return `+${hiddenCount} more callee${hiddenCount === 1 ? '' : 's'}`;
}

/** The expand/collapse button's visible text: "▸ Expand callees (3)" / "▾ Collapse". */
export function revealDrillButtonText(control: RevealDrillControl): string {
  return control.kind === 'expand' ? `▸ Expand callees (${control.count})` : '▾ Collapse';
}

/**
 * P4-7e (founder decision 2026-10-04, open point — proposed, for sign-off):
 * a drilled Node in a section whose callees in other sections the drill
 * doesn't follow says so, from P4-4g's `crossSectionCalls` count (the
 * server's number, never one computed here): "↗ Calls 2 Nodes in other
 * sections (not shown in this section)" — shown only on an expanded card
 * (review round 1). P4-4g counts outgoing CALLS only (the drill also follows
 * USAGE). `null` when there are none (and always in
 * the whole scope, where the field is absent). Node detail's "Calls into
 * other sections" (P4-4h) lists them, with the switch.
 */
export function revealCrossSectionNote(
  node: Pick<CodeMapNode, 'crossSectionCalls' | 'crossSectionCallsTotal'>,
): string | null {
  const count = node.crossSectionCallsTotal ?? node.crossSectionCalls?.length ?? 0;
  if (count <= 0) {
    return null;
  }
  return `↗ Calls ${count} Node${count === 1 ? '' : 's'} in other sections (not shown in this section)`;
}

/**
 * Applies a drill transition to the held state for the map on screen: to a
 * ready listing's state, or to a refresh's previous state still drawn while
 * the new listing loads. `null` when there's nothing to apply it to, or the
 * transition changed nothing. Returns both snapshots (P4-7f: the history
 * entry's `before`/`after`).
 */
export function applyRevealTransition(
  held: HeldReveal | null,
  key: string | null,
  transition: (state: RevealState) => RevealState,
): { held: HeldReveal; before: RevealState; after: RevealState } | null {
  const current = key === null ? null : heldRevealFor(held, key);
  if (current === null) {
    return null;
  }
  const listing = current.listing;
  if (listing.status === 'ready') {
    const after = transition(listing.state);
    return after === listing.state
      ? null
      : { held: { ...current, listing: { ...listing, state: after } }, before: listing.state, after };
  }
  if (listing.status === 'loading' && listing.previous !== null) {
    const after = transition(listing.previous);
    return after === listing.previous
      ? null
      : { held: { ...current, listing: { ...listing, previous: after } }, before: listing.previous, after };
  }
  return null;
}
