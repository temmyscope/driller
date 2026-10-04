/**
 * P2-3: the text of the one app-level frame both screens share — the
 * titlebar and the tmux-style footer bar (DESIGN.md, terminal-native
 * direction) — and the pure state rules that feed it. DOM-free so every
 * I/O-matrix row is testable under `node --test` (`appFrame.test.ts`).
 *
 * Every string here states a fact the app already has; nothing is invented
 * (EXPERIENCE.md: "never specify data the product cannot produce"). That is
 * why there is no git branch in the titlebar — nothing supplies it.
 */
import type {
  CrossSectionEdgeCount,
  DiffScopeResult,
  GraphServiceStatusMessage,
  SectionNodeCount,
} from '@driller/ipc-contracts';

import type { CodeMapMode } from './CodeMap';
import { formatCount, formatMapCounts } from './format';
import { deriveSessionView, isStatusForCurrentProject, type SessionAvailability } from './sessionView';

// ---------------------------------------------------------------------------
// The map's state, as reported by `CodeMap` (`onMapState`)
// ---------------------------------------------------------------------------

/**
 * What the footer needs of `CodeMap`'s fetch: whether a map is on screen, and
 * its totals. P4-4 phase 1c: a ready map also carries what the Section bar
 * needs of its reply — the scope the Graph Service applied and the
 * whole-scope Node count per section (`[]` for none).
 */
export type MapFooterState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      nodes: number;
      edges: number;
      appliedScope: readonly string[];
      sections: readonly SectionNodeCount[];
      /** P4-4d review round 1: the section the reply is for (`null` = `all`). */
      section: string | null;
      /**
       * P4-4 phase 3b: the reply's `crossSectionEdges` (P4-4g) — the edges the
       * section's filter dropped, per other section and direction. Absent for
       * none, and on every whole-scope reply.
       */
      crossSectionEdges?: readonly CrossSectionEdgeCount[];
    };

/**
 * `CodeMap`'s `FetchState` reduced to the footer's view of it — the ready
 * map's full Node and edge totals. Structurally typed so this module needn't
 * import `CodeMap`'s runtime. A failed *refresh* keeps `fetchState` `ready`
 * (the last completed map stays mounted), so it keeps its counts here too.
 * An absent `sections` (the dev fixture) is none.
 */
export function mapFooterState(
  fetchState:
    | { status: 'loading' }
    | { status: 'error' }
    | {
        status: 'ready';
        nodes: readonly unknown[];
        edges: readonly unknown[];
        appliedScope: readonly string[];
        sections?: readonly SectionNodeCount[];
        section?: string | null;
        crossSectionEdges?: readonly CrossSectionEdgeCount[];
      },
): MapFooterState {
  switch (fetchState.status) {
    case 'loading':
      return { status: 'loading' };
    case 'error':
      return { status: 'error' };
    case 'ready':
      return {
        status: 'ready',
        nodes: fetchState.nodes.length,
        edges: fetchState.edges.length,
        appliedScope: fetchState.appliedScope,
        sections: fetchState.sections ?? [],
        section: fetchState.section ?? null,
        ...(fetchState.crossSectionEdges !== undefined && fetchState.crossSectionEdges.length > 0
          ? { crossSectionEdges: fetchState.crossSectionEdges }
          : {}),
      };
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSections(a: readonly SectionNodeCount[], b: readonly SectionNodeCount[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => entry.path === b[index]?.path && entry.nodeCount === b[index]?.nodeCount)
  );
}

function sameCrossSectionEdges(
  a: readonly CrossSectionEdgeCount[] | undefined,
  b: readonly CrossSectionEdgeCount[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.section === right[index]?.section &&
        entry.outgoing === right[index]?.outgoing &&
        entry.incoming === right[index]?.incoming,
    )
  );
}

export function sameMapFooterState(a: MapFooterState, b: MapFooterState): boolean {
  if (a.status !== b.status) {
    return false;
  }
  return (
    a.status !== 'ready' ||
    (b.status === 'ready' &&
      a.nodes === b.nodes &&
      a.edges === b.edges &&
      a.section === b.section &&
      sameStrings(a.appliedScope, b.appliedScope) &&
      sameSections(a.sections, b.sections) &&
      sameCrossSectionEdges(a.crossSectionEdges, b.crossSectionEdges))
  );
}

/** P4-4 phase 1c: what the Section bar is drawn from — the last ready map's reply. */
export interface SectionBarSource {
  appliedScope: readonly string[];
  sections: readonly SectionNodeCount[];
}

/** App's copy of the last map report, tagged with the project it describes. */
export interface FrameMapState {
  projectPath: string | null;
  map: MapFooterState | null;
  /**
   * P4-4 phase 1c: the last READY report's scope and sections, for the
   * Section bar. Kept through a later loading or error report for the same
   * project, so a section switch (which reloads the map) never makes the bar
   * — and the focus on it — disappear mid-switch.
   */
  sectionBar: SectionBarSource | null;
}

export const INITIAL_FRAME_MAP_STATE: FrameMapState = { projectPath: null, map: null, sectionBar: null };

/**
 * A report from `CodeMap`. Ignored unless it is about the project currently
 * open — a late report from a previous project must never label this one.
 * Returns the same object when nothing changed, so React skips the render.
 */
export function applyMapReportToFrame(
  state: FrameMapState,
  currentProjectPath: string | null,
  reportPath: string | null,
  map: MapFooterState,
): FrameMapState {
  if (currentProjectPath === null || reportPath !== currentProjectPath) {
    return state;
  }
  if (state.projectPath === reportPath && state.map !== null && sameMapFooterState(state.map, map)) {
    return state;
  }
  const sectionBar =
    map.status === 'ready'
      ? { appliedScope: map.appliedScope, sections: map.sections }
      : state.projectPath === reportPath
        ? state.sectionBar
        : null;
  return { projectPath: reportPath, map, sectionBar };
}

/** Opening a different project drops the previous project's map state; re-opening the same one keeps it. */
export function applyProjectOpenedToFrame(state: FrameMapState, openedPath: string): FrameMapState {
  return state.projectPath === openedPath || state === INITIAL_FRAME_MAP_STATE ? state : INITIAL_FRAME_MAP_STATE;
}

/** Close always returns to no map. */
export function applyProjectClosedToFrame(state: FrameMapState): FrameMapState {
  return state === INITIAL_FRAME_MAP_STATE ? state : INITIAL_FRAME_MAP_STATE;
}

/** The map state for the open project, or `null` if what's held belongs to another. */
export function frameMapFor(state: FrameMapState, currentProjectPath: string | null): MapFooterState | null {
  return currentProjectPath !== null && state.projectPath === currentProjectPath ? state.map : null;
}

/** P4-4 phase 1c: the Section bar's source for the open project, or `null`. */
export function frameSectionBarFor(state: FrameMapState, currentProjectPath: string | null): SectionBarSource | null {
  return currentProjectPath !== null && state.projectPath === currentProjectPath ? state.sectionBar : null;
}

// ---------------------------------------------------------------------------
// P4-4 phase 1c: the selected section, and its one announcement
// ---------------------------------------------------------------------------

/**
 * App's section shell state: the selected allowlist entry (`null` = `all`),
 * the text of the one `role="status"` region that announces a switch, and
 * whether a switch is still waiting for its reply.
 */
export interface SectionShellState {
  section: string | null;
  announcement: string;
  /** P4-4d review round 1: a switch was announced as loading and its reply hasn't landed. */
  pending: boolean;
}

export const INITIAL_SECTION_SHELL_STATE: SectionShellState = { section: null, announcement: '', pending: false };

function sectionName(section: string | null): string {
  return section === null ? 'all sections' : `section ${section}`;
}

/** "Loading section api…" / "Loading all sections…" — said on activation. */
export function sectionLoadingAnnouncement(section: string | null): string {
  return `Loading ${sectionName(section)}…`;
}

/**
 * "Showing section api — 412 Nodes" / "Showing all sections — 1,204 Nodes" —
 * said when the switch's reply lands, with that reply's own Node count.
 */
export function sectionAnnouncement(section: string | null, nodes: number): string {
  return `Showing ${sectionName(section)} — ${formatCount(nodes, 'Node', 'Nodes')}`;
}

/** The failed switch's status text; the map's own error notice carries the reason and Retry. */
export function sectionFailedAnnouncement(section: string | null): string {
  return `Couldn’t load ${sectionName(section)}`;
}

/** The fallback's status text — never an error notice. */
export function unknownSectionAnnouncement(section: string): string {
  return `${section} is no longer in the indexing scope — showing all sections`;
}

/**
 * A tab was activated. Activating the section already selected changes
 * nothing (no refetch, no announcement); any other switches and says it is
 * loading — the result is announced from the reply (`applyMapReportToSectionShell`).
 */
export function applySectionActivated(state: SectionShellState, next: string | null): SectionShellState {
  if (next === state.section) {
    return state;
  }
  return { section: next, announcement: sectionLoadingAnnouncement(next), pending: true };
}

/**
 * A map report for the open project.
 * - A ready reply whose applied scope has fewer than 2 distinct entries,
 *   with a section selected: back to `all`, silently — the bar is hidden and
 *   the section's content is the whole scope, so nothing on screen changes,
 *   and a section the user can no longer see must not stay selected.
 * - While a switch is pending: its ready reply (keyed on the reply's own
 *   section) announces what is shown, with that reply's Node count; an error
 *   announces the failure. Anything else (a loading report, or a ready one
 *   for another section) changes nothing.
 */
export function applyMapReportToSectionShell(state: SectionShellState, map: MapFooterState): SectionShellState {
  if (map.status === 'ready' && state.section !== null && new Set(map.appliedScope).size < 2) {
    return { section: null, announcement: '', pending: false };
  }
  if (!state.pending) {
    return state;
  }
  if (map.status === 'ready' && map.section === state.section) {
    return { ...state, announcement: sectionAnnouncement(map.section, map.nodes), pending: false };
  }
  if (map.status === 'error') {
    return { ...state, announcement: sectionFailedAnnouncement(state.section), pending: false };
  }
  return state;
}

/**
 * A reply said `section` is no longer in the allowlist: fall back to `all`
 * and say so. Ignored unless it is the section still selected — a late
 * report about a section the user already left must not undo their choice.
 */
export function applyUnknownSection(state: SectionShellState, section: string): SectionShellState {
  if (state.section !== section) {
    return state;
  }
  return { section: null, announcement: unknownSectionAnnouncement(section), pending: false };
}

// ---------------------------------------------------------------------------
// P4-4 phase 3b: cross-section honesty — the footer line, and the switch that
// lands on a Node in another section
// ---------------------------------------------------------------------------

/**
 * One section's directions, a 0 direction left out, each with its own noun
 * (review round 1): "1 edge into web/, 3 edges from web/".
 */
function crossSectionEdgeText(entry: CrossSectionEdgeCount): string | null {
  const parts: string[] = [];
  for (const [count, preposition] of [
    [entry.outgoing, 'into'],
    [entry.incoming, 'from'],
  ] as const) {
    if (count > 0) {
      parts.push(`${formatCount(count, 'edge', 'edges')} ${preposition} ${entry.section}/`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * P4-4 phase 3b: the footer line for a section map's `crossSectionEdges`
 * (P4-4g, split by direction — founder decision 2026-10-03): "9 edges into
 * web/, 3 edges from web/ — not shown in this section". Several sections are
 * joined with " · " in the reply's order ("… · 3 edges into docs/ — …"); a
 * direction with a 0 count is left out; every count carries its own
 * "edge"/"edges". Every number is the field's own, never computed here.
 * `null` for an absent or empty list, or one with no count above 0.
 */
export function crossSectionEdgesLine(crossSectionEdges: readonly CrossSectionEdgeCount[] | undefined): string | null {
  const texts = (crossSectionEdges ?? [])
    .map(crossSectionEdgeText)
    .filter((text): text is string => text !== null);
  return texts.length === 0 ? null : `${texts.join(' · ')} — not shown in this section`;
}

/**
 * P4-4 review round 1: the footer line's text from one render to the next.
 * While a section switch is pending, or the map is reloading, the previous
 * text is kept — so the polite status region never announces a half-way
 * state, and a full reload landing the same counts changes no text (nothing
 * is re-announced). Otherwise it is `footerCrossSectionLine`.
 */
export function nextFooterCrossSectionLine(
  previous: string | null,
  map: MapFooterState | null,
  switchPending: boolean,
): string | null {
  if (switchPending || map?.status === 'loading') {
    return previous;
  }
  return footerCrossSectionLine(map);
}

/**
 * P4-4 phase 3b: the footer line for the map on screen — only a ready
 * section map's (never `all`, never while loading), else `null`.
 */
export function footerCrossSectionLine(map: MapFooterState | null): string | null {
  if (map?.status !== 'ready' || map.section === null) {
    return null;
  }
  return crossSectionEdgesLine(map.crossSectionEdges);
}

/**
 * P4-4 phase 3b: a switch asked to land on a Node of the target section once
 * its map is ready (Node detail's "Calls into other sections").
 */
export interface PendingSectionFocus {
  section: string;
  nodeId: string;
}

/**
 * The switch's pending focus: one for a `focusNodeId`, none without (the
 * PR Review line's switch, or a Section bar tab, cancels an earlier one).
 */
export function pendingFocusForSwitch(section: string, focusNodeId?: string): PendingSectionFocus | null {
  return focusNodeId === undefined ? null : { section, nodeId: focusNodeId };
}

/**
 * The one-shot `pendingFocusNodeId` `CodeMap` receives: the pending Node only
 * while its section is the selected one — a later switch elsewhere (or the
 * fallback to `all`) never lands it on the wrong map.
 */
export function pendingFocusNodeIdFor(pending: PendingSectionFocus | null, section: string | null): string | null {
  return pending !== null && pending.section === section ? pending.nodeId : null;
}

// ---------------------------------------------------------------------------
// P3-10: when the diff scope last synced, as reported by `CodeMap`
// (`onDiffScopeSynced`)
// ---------------------------------------------------------------------------

/**
 * App's copy of the last diff-scope sync time (epoch ms), tagged with the
 * project it belongs to. Session-only — never persisted across launches.
 */
export interface FrameSyncState {
  projectPath: string | null;
  lastSyncedAt: number | null;
}

export const INITIAL_FRAME_SYNC_STATE: FrameSyncState = { projectPath: null, lastSyncedAt: null };

/**
 * The sync time a settled `computeDiffScope` result records: `now` for every
 * completed sync — `resolved`, `no-changes`, `not-a-git-repo`,
 * `no-base-ref-resolvable` — and `null` for `error` (or any status this
 * build doesn't know), which records nothing, so the previous time is kept.
 */
export function diffScopeSyncTimeFor(result: { status: DiffScopeResult['status'] }, now: number): number | null {
  const status = result.status;
  switch (status) {
    case 'resolved':
    case 'no-changes':
    case 'not-a-git-repo':
    case 'no-base-ref-resolvable':
      return now;
    // P4-4 phase 2a: `unknown-section` — the section left the allowlist, so
    // nothing was synced.
    case 'error':
    case 'unknown-section':
      return null;
    default: {
      const unknownStatus: never = status;
      void unknownStatus;
      return null;
    }
  }
}

/**
 * A report from `CodeMap`: `at` is the settle time of a completed sync, or
 * `null` when the diff scope was reset (a map refresh after re-index, a
 * reload, a project change). Ignored unless it is about the project currently
 * open, and a `null` report is a no-op unless a time is held for that
 * project. An errored computation is never reported (`diffScopeSyncTimeFor`),
 * so it keeps whatever time was held. Returns the same object when nothing
 * changed.
 */
export function applyDiffScopeSyncToFrame(
  state: FrameSyncState,
  currentProjectPath: string | null,
  reportPath: string | null,
  at: number | null,
): FrameSyncState {
  if (currentProjectPath === null || reportPath !== currentProjectPath) {
    return state;
  }
  if (at === null && frameSyncFor(state, reportPath) === null) {
    return state;
  }
  if (state.projectPath === reportPath && state.lastSyncedAt === at) {
    return state;
  }
  return { projectPath: reportPath, lastSyncedAt: at };
}

/** Opening a different project drops the previous project's sync time; re-opening the same one keeps it. */
export function applyProjectOpenedToFrameSync(state: FrameSyncState, openedPath: string): FrameSyncState {
  return state.projectPath === openedPath || state === INITIAL_FRAME_SYNC_STATE ? state : INITIAL_FRAME_SYNC_STATE;
}

/** Close always clears the sync time. */
export function applyProjectClosedToFrameSync(state: FrameSyncState): FrameSyncState {
  return state === INITIAL_FRAME_SYNC_STATE ? state : INITIAL_FRAME_SYNC_STATE;
}

/** The sync time for the open project, or `null` if what's held belongs to another. */
export function frameSyncFor(state: FrameSyncState, currentProjectPath: string | null): number | null {
  return currentProjectPath !== null && state.projectPath === currentProjectPath ? state.lastSyncedAt : null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Ages of more than this many whole days read "over a year ago". */
const MAX_DAYS = 365;

/**
 * P3-10: plain relative time for the footer's "synced …" — under a minute is
 * "just now", then whole minutes, hours, days (floored), capped at "over a
 * year ago" past 365 days (which also covers `Infinity`). A negative age (a
 * render clock that lags the settle time by a moment), `-Infinity` or `NaN`
 * reads "just now".
 */
export function formatSyncAge(ms: number): string {
  if (!(ms >= MINUTE_MS)) {
    return 'just now';
  }
  if (ms >= (MAX_DAYS + 1) * DAY_MS) {
    return 'over a year ago';
  }
  if (ms < HOUR_MS) {
    return `${Math.floor(ms / MINUTE_MS)} min ago`;
  }
  if (ms < DAY_MS) {
    return `${Math.floor(ms / HOUR_MS)} h ago`;
  }
  return `${Math.floor(ms / DAY_MS)} d ago`;
}

/** The longest the footer waits between sync-age re-renders, so a missed or late tick recovers. */
export const SYNC_AGE_MAX_TICK_MS = 60_000;

/**
 * P3-10: how long until `formatSyncAge`'s text can next change for an age of
 * `ageMs` — the next minute boundary under an hour, the next hour boundary
 * under a day, the next day boundary after — capped at
 * `SYNC_AGE_MAX_TICK_MS`, never below 1 ms. A negative age waits until it
 * reaches one minute; a non-finite one just waits the cap.
 */
export function nextSyncAgeTickMs(ageMs: number): number {
  if (!Number.isFinite(ageMs)) {
    return SYNC_AGE_MAX_TICK_MS;
  }
  let delay: number;
  if (ageMs < MINUTE_MS) {
    delay = MINUTE_MS - ageMs;
  } else if (ageMs < HOUR_MS) {
    delay = MINUTE_MS - (ageMs % MINUTE_MS);
  } else if (ageMs < DAY_MS) {
    delay = HOUR_MS - (ageMs % HOUR_MS);
  } else {
    delay = DAY_MS - (ageMs % DAY_MS);
  }
  return Math.max(1, Math.min(SYNC_AGE_MAX_TICK_MS, delay));
}

// ---------------------------------------------------------------------------
// The Graph Service availability the footer reports
// ---------------------------------------------------------------------------

/**
 * `degraded` only after a real error/exit that belongs to the open project.
 * No status yet (a fresh open) is "not failed" — `deriveSessionView` reads it
 * as `degraded` without a map, which is moot for its notice but would make
 * the footer say "stopped" here. A status for another project (the one just
 * switched away from) is equally not this project's failure.
 */
export function footerAvailability(
  status: GraphServiceStatusMessage | null,
  currentProjectPath: string | null,
): SessionAvailability {
  if (status === null || !isStatusForCurrentProject(status, currentProjectPath)) {
    return 'refreshing';
  }
  return deriveSessionView({ currentProjectPath, loadedProjectPath: currentProjectPath, status }).availability;
}

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

export interface FooterBarInput {
  currentProjectPath: string | null;
  /** True while an open is in flight (folder picker or Recent Projects). */
  isOpening: boolean;
  /** From `footerAvailability`. */
  availability: SessionAvailability;
  /** From `frameMapFor`: `null` until the open project's map reports. */
  map: MapFooterState | null;
  mode: CodeMapMode;
  /** P3-10: from `frameSyncFor` — when the diff scope last synced (epoch ms), or `null`. */
  lastSyncedAt: number | null;
  /** P3-10: the render clock (epoch ms) the sync age is measured against. */
  now: number;
}

export interface FooterBar {
  left: string;
  right: string;
}

/** The mode's status-line name — tmux's upper-case mode indicator idiom. */
export const FOOTER_BAR_MODE_NAMES = {
  codeMap: 'CODE MAP',
  prReview: 'PR REVIEW',
  healthAudit: 'HEALTH AUDIT',
} as const satisfies Record<CodeMapMode, string>;

export const NO_PROJECT_OPEN = 'no project open';

/**
 * The project folder's display name — mirrors `apps/desktop/main/settings.ts`'s
 * `pathBasename` (the Recent Projects `name`), duplicated because the renderer
 * can't import across the main/renderer process boundary. A root (`/`,
 * `C:\`) falls back to the trimmed path, or the path itself, never `''`.
 */
export function projectFolderName(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed || projectPath;
}

/** `driller — <project folder name>`, or `driller — no project open`. */
export function deriveTitle({ currentProjectPath }: { currentProjectPath: string | null }): string {
  return `driller — ${currentProjectPath === null ? NO_PROJECT_OPEN : projectFolderName(currentProjectPath)}`;
}

/** FIX-3: the map-eligible Node count the status line may cite — only a ready map's, else `null`. */
export function mapNodesForStatusLine(map: MapFooterState | null): number | null {
  return map?.status === 'ready' ? map.nodes : null;
}

/**
 * The right span's tooltip: the absolute sync time, whenever the right span
 * states one (PR Review, a project open, a sync held); `undefined` otherwise.
 */
export function footerBarRightTitle({
  currentProjectPath,
  mode,
  lastSyncedAt,
}: Pick<FooterBarInput, 'currentProjectPath' | 'mode' | 'lastSyncedAt'>): string | undefined {
  if (currentProjectPath === null || mode !== 'prReview' || lastSyncedAt === null) {
    return undefined;
  }
  return `synced ${new Date(lastSyncedAt).toLocaleString()}`;
}

/**
 * The right span: the mode's name, plus — in PR Review only, once a diff
 * scope has synced — how recent that scope is ("PR REVIEW · synced 2 min ago").
 */
function footerBarRight(mode: CodeMapMode, lastSyncedAt: number | null, now: number): string {
  const name = FOOTER_BAR_MODE_NAMES[mode];
  if (mode !== 'prReview' || lastSyncedAt === null) {
    return name;
  }
  return `${name} · synced ${formatSyncAge(now - lastSyncedAt)}`;
}

export function deriveFooterBar({
  currentProjectPath,
  isOpening,
  availability,
  map,
  mode,
  lastSyncedAt,
  now,
}: FooterBarInput): FooterBar {
  if (currentProjectPath === null) {
    return { left: isOpening ? 'opening…' : NO_PROJECT_OPEN, right: '' };
  }
  const right = footerBarRight(mode, lastSyncedAt, now);
  if (map?.status === 'ready') {
    // A map is on screen: its counts stay visible whatever the service is doing.
    const counts = formatMapCounts(map.nodes, map.edges);
    switch (availability) {
      case 'live':
        return { left: counts, right };
      case 'refreshing':
        return { left: `${counts} · re-indexing…`, right };
      case 'degraded':
        return { left: `${counts} · last completed index`, right };
    }
  }
  if (map?.status === 'error') {
    return { left: 'couldn’t load the map — use Retry', right };
  }
  // No map yet (not reported, or loading).
  const name = projectFolderName(currentProjectPath);
  return { left: availability === 'degraded' ? `indexing ${name} stopped` : `indexing ${name}…`, right };
}
