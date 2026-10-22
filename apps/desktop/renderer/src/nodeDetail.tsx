/**
 * The Node detail panel, and the folded Type/Interface detail it opens into.
 *
 * One module rather than two, because the two cannot be cut apart:
 * `NodeDetailBody` composes `NodeUsesTypes` and `NodeFileTopLevelTypes`,
 * while `TypeDetailBody` reuses Node detail's own section heading ids, its
 * row caps and its "not on the current map" wording. Splitting them would
 * have each importing values from the other — the one shape of cycle this
 * split exists to avoid.
 *
 * What the panel is for: every claim it shows is one action from the source
 * it describes (FR-17), and the two trust states are visually distinct from
 * risk — a Staleness Indicator is about whether the summary can be believed,
 * a Coverage Gap about whether driller had the data at all, and neither is a
 * statement about the code's risk. The sections are facts and never advice:
 * "Similar implementations" says the overlap is structural and not a claim
 * the two behave alike, and "Changes with" says in as many words that shared
 * commits do not mean one file uses the other.
 *
 * Hookless throughout, including `TypeDetailBody` and every section: the
 * tests call them as plain functions, since the runner is `node --test` with
 * no DOM. Only one Node detail panel is ever open, which is why the heading
 * ids are constants rather than `useId`.
 *
 * `CodeMap.tsx` re-exports everything this module owns, so the eight test
 * files reading these symbols from `./CodeMap` are untouched.
 */
import { Fragment, type ReactNode } from 'react';

import type {
  CoChangingFile,
  CodeMapNode,
  CrossSectionCall,
  FileTopLevelUse,
  FoldedType,
  FoldedTypeUserKindCount,
  PathTraceResult,
  SimilarImplementation,
  TestedBy,
  TestedByFile,
  TestedByTest,
  TypeUse,
  UnknownSectionResult,
} from '@driller/ipc-contracts';

import { ActionableNotice } from './ActionableNotice';
import {
  GRAPH_SERVICE_UNAVAILABLE_TITLE,
  sectionSwitchButtonProps,
  SERVICE_UNAVAILABLE_CLASS,
} from './actionAvailability';
import type { SourceTarget } from './codeMapTypes';
import type { PathTraceState, RegenerateState } from './CodeMap';
import type { RefreshOutcome } from './sessionView';
import { SECTION_SWITCH_UNAVAILABLE_HINT } from './SectionBar';
import { PIN_BUTTON_TEXT } from './entryPins';
import { foldedTypeNoun, formatCount, formatCountNumber, nodeModuleLine } from './format';
import {
  countToggleHiddenSignals,
  hasVisibleRiskSignals,
  NodeRiskSignalSections,
  type RiskSignalFamilyToggles,
} from './riskSignals';
import { formatSharedReachList, PINNED_BADGE_TEXT, type SharedReachPartner } from './revealView';

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
  coChange: 'code-map-node-detail-co-change-heading',
  crossSectionCalls: 'code-map-node-detail-cross-section-calls-heading',
  entryPin: 'code-map-node-detail-entry-pin-heading',
  sharedReach: 'code-map-node-detail-shared-reach-heading',
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
  /**
   * P4-7h: when this Node is an entry candidate shown in Revealed, every
   * other shown candidate it shares reach with, strongest first
   * (`sharedReachPartners`) — the accessible, uncapped form of the canvas's
   * "shares N" edges, which draw at most three. Absent: no section.
   */
  sharedReach?: readonly SharedReachPartner[];
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

export const NO_FOLDED_TYPES: readonly FoldedType[] = [];
export const IDLE_TRACE: PathTraceState = { status: 'idle' };
export const NO_MAP_NODES: readonly CodeMapNode[] = [];
export const CLOSED_TYPE: TypeDetailState = { status: 'closed' };

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

/** How many "Changes with" rows Node detail shows before "+N more". */
export const NODE_DETAIL_CO_CHANGE_ROWS = 5;

/**
 * The honest-copy line under "Changes with".
 *
 * It must not suggest a structural link. These two files have moved together
 * in git history; neither necessarily calls, imports or depends on the other,
 * and saying otherwise would invent a relationship the graph does not have.
 */
export const CO_CHANGE_DISCLAIMER =
  'From git history: these files have changed in the same commits. It does not mean one uses the other.';

/** A co-changing file's history as shown — "32 commits together, 0.89 of the time". */
export function formatCoChange(entry: CoChangingFile): string {
  // Floored, so a 0.996 never reads as a flat 1.00; the score is a ratio the
  // backend computed, never a percentage driller derived.
  const score = (Math.floor(entry.score * 100 + 1e-9) / 100).toFixed(2);
  return `${formatCount(entry.coChanges, 'commit', 'commits')} together, ${score} of the time`;
}

/** The full count: `coChangesWithTotal`, never below what is carried. */
function coChangeTotal(node: Pick<CodeMapNode, 'coChangesWith' | 'coChangesWithTotal'>): number {
  return Math.max(node.coChangesWithTotal ?? 0, node.coChangesWith?.length ?? 0);
}

/** The section heading — "Changes with (N)", N the full count. */
export function coChangeHeading(node: Pick<CodeMapNode, 'coChangesWith' | 'coChangesWithTotal'>): string {
  return `Changes with (${coChangeTotal(node)})`;
}

/**
 * The files this Node's file moves with. The first
 * `NODE_DETAIL_CO_CHANGE_ROWS`, then a native `<details>` for the rest, and
 * always the honest-copy line. Paths only: a file is not a map Node, so
 * there is nothing to navigate to and no link is offered. Hookless.
 */
export function NodeCoChanges({ node }: { node: Pick<CodeMapNode, 'coChangesWith' | 'coChangesWithTotal'> }) {
  const entries = node.coChangesWith ?? [];
  const total = coChangeTotal(node);
  const shown = entries.slice(0, NODE_DETAIL_CO_CHANGE_ROWS);
  const rest = entries.slice(NODE_DETAIL_CO_CHANGE_ROWS);
  const more = total - shown.length;
  const rows = (list: readonly CoChangingFile[]) =>
    list.map((entry) => (
      <li key={entry.file} className="code-map__node-detail-co-change-row">
        <code className="code-map__node-detail-co-change-file">{entry.file}</code>
        <span className="code-map__node-detail-co-change-history">{formatCoChange(entry)}</span>
      </li>
    ));
  return (
    <>
      <ul className="code-map__node-detail-co-change" aria-label="Changes with">
        {rows(shown)}
      </ul>
      {more > 0 && (
        <details className="code-map__more">
          <summary>+{more} more</summary>
          {rest.length > 0 && (
            <ul className="code-map__node-detail-co-change code-map__more-list" aria-label="Changes with, continued">
              {rows(rest)}
            </ul>
          )}
          {entries.length < total && (
            <p className="code-map__more-list">
              Showing the first {entries.length} of {total}.
            </p>
          )}
        </details>
      )}
      <p className="code-map__node-detail-co-change-note">{CO_CHANGE_DISCLAIMER}</p>
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
  sharedReach,
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
      {/* The files this one moves with, from the index's FILE_CHANGES_WITH
          edges only. Only when there are any, so a project with no git
          history shows no section. History, not structure. */}
      {(node.coChangesWith?.length ?? 0) > 0 && (
        <section className="code-map__node-detail-section" aria-labelledby={ids.coChange}>
          <h3 id={ids.coChange} className="code-map__node-detail-label">
            {coChangeHeading(node)}
          </h3>
          <NodeCoChanges node={node} />
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
      {/* P4-7h: every candidate this one shares reach with — one line of
          text, read only when the engineer opens a candidate's detail. */}
      {sharedReach !== undefined && (
        <section className="code-map__node-detail-section" aria-labelledby={ids.sharedReach}>
          <h3 id={ids.sharedReach} className="code-map__node-detail-label">
            Shared reach
          </h3>
          <p className="code-map__node-detail-shared-reach">{formatSharedReachList(sharedReach)}</p>
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

export const CROSS_SECTION_CALLS_HINT_ID = 'code-map-cross-section-calls-hint';
