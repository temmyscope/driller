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
import type { CodeMapEdge, CodeMapNode, EntryCandidate, EntryCandidatesResult } from '@driller/ipc-contracts';

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

/** What Revealed shows: the candidates it started from, and every revealed Node id. */
export interface RevealState {
  candidates: EntryCandidate[];
  revealed: ReadonlyMap<string, RevealedEntry>;
}

export const EMPTY_REVEAL_STATE: RevealState = { candidates: [], revealed: new Map() };

/** The start state for a `found` listing: every candidate revealed, in column 0. */
export function initialRevealState(result: Extract<EntryCandidatesResult, { status: 'found' }>): RevealState {
  const revealed = new Map<string, RevealedEntry>();
  for (const candidate of result.candidates) {
    revealed.set(candidate.id, { depth: 0, parentId: null });
  }
  return { candidates: result.candidates, revealed };
}

/**
 * The layered layout: column = depth × `NODE_COLUMN_GAP`; within a column,
 * row index × `NODE_ROW_GAP`, ordered by the parent's row (a Node with no
 * parent — a candidate — first), then reach descending (a non-candidate has
 * none yet: 0), then id. Never depends on the order of `revealed` or
 * `candidates`. Parents are laid out first (shallower columns), so a parent's
 * row is known when its children are ordered.
 */
export function layeredLayout(state: RevealState): Map<string, { x: number; y: number }> {
  const reachById = new Map<string, number>();
  for (const candidate of state.candidates) {
    reachById.set(candidate.id, candidate.reach);
  }
  const byDepth = new Map<number, string[]>();
  for (const [id, entry] of state.revealed) {
    const column = byDepth.get(entry.depth);
    if (column === undefined) {
      byDepth.set(entry.depth, [id]);
    } else {
      column.push(id);
    }
  }
  const rowOf = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const parentRow = (id: string): number => {
      const parentId = state.revealed.get(id)?.parentId ?? null;
      return parentId === null ? -1 : (rowOf.get(parentId) ?? -1);
    };
    const ids = [...(byDepth.get(depth) ?? [])].sort(
      (a, b) =>
        parentRow(a) - parentRow(b) ||
        (reachById.get(b) ?? 0) - (reachById.get(a) ?? 0) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    ids.forEach((id, row) => {
      rowOf.set(id, row);
      positions.set(id, { x: depth * NODE_COLUMN_GAP, y: row * NODE_ROW_GAP });
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
}): RevealReplyOutcome {
  const { isLatest, requestedSection, currentSection, held, key, mapStamp, result } = input;
  if (!isLatest || requestedSection !== currentSection) {
    return { kind: 'ignore' };
  }
  if (held === null || held.key !== key || held.mapStamp !== mapStamp) {
    return { kind: 'ignore' };
  }
  if (result.status === 'unknown-section') {
    return { kind: 'unknown-section', section: requestedSection ?? result.section };
  }
  return { kind: 'apply', held: { key, mapStamp, listing: revealListingOf(result) } };
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

