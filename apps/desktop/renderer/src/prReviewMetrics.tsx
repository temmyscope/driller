/**
 * PR Review Mode's metrics table: the audit surface beside the canvas.
 *
 * The canvas stays purely structural and spatial; this table is where an
 * engineer compares many changed Nodes' signals at once instead of reading
 * one card's badge strip at a time. Additive, never a replacement — the
 * canvas keeps its own signal strips.
 *
 * The sort rules are founder decisions and deliberately not uniform, so each
 * is documented where it lives rather than normalised away. The tests column
 * is the exception on purpose: it orders gap < none < covered and a first
 * click sorts ASCENDING, so the first view leads with untested changed code,
 * which is the reason to sort that column at all. There a dash is a value
 * ("no LCOV data" / "no function-level proof"), not a missing one, so it sits
 * between the two and flips with the direction — unlike every other column,
 * where a dash sorts last in both directions.
 *
 * A row's accessible name is composed from its own content plus
 * `HEALTH_ROW_AFFORDANCE`, never an `aria-label`: an `aria-label` REPLACES an
 * element's text as its accessible name, which would silently delete every
 * chip's own label from what a screen reader announces. That phrase is
 * imported from `healthAudit.tsx` deliberately — both surfaces are
 * activatable rows that open Node detail, and sharing the wording is how they
 * stay alike.
 */
import type { CSSProperties } from 'react';

import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';
import type {
  ChangedContract,
  CodeMapNode,
  DeterministicRiskSignal,
  DeterministicRiskSignalType,
  IngestedRiskSignal,
} from '@driller/ipc-contracts';

import { ACTIONABLE_NOTICE_GLYPHS, ACTIONABLE_NOTICE_SPOKEN_PREFIX } from './ActionableNotice';
import { EMPTY_ID_SET } from './codeMapSentinels';
import { foldedTypeNoun, formatContractDependents, formatCount, formatCountNumber, nodeModuleLine } from './format';
import { HEALTH_ROW_AFFORDANCE } from './healthAudit';
import {
  formatDeterministicSignalLabel,
  INGESTED_SEVERITY_RANK,
  selectDeterministicSignals,
  selectIngestedSignals,
  SEVERE_SIGNAL_GLYPH,
} from './riskSignals';
import type { BlastRadiusState, PrReviewView } from './CodeMap';

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
  // P5-g (founder 1.7): with no Node rows (a contract-only table) there is
  // nothing to sort, so the table renders as if unsorted — no `aria-sort`,
  // no indicator, an empty announcement, no sorted-within-cap note — and the
  // headers are `aria-disabled` no-ops. The caller's `sort` is kept, so it
  // applies again when rows return.
  const sortInert = table.rows.length === 0;
  const effectiveSort = sortInert ? null : sort;
  // P4-3d: sorted here, from the rows already capped in the default order —
  // the cap line stays last, after every row, whatever the sort.
  const rows = sortPrReviewMetricRows(table.rows, effectiveSort);
  const barMax = metricBarWidths(table.rows);
  const sortedWithinCap = formatSortedWithinCapNote(effectiveSort, rows.length, hiddenAffectedCount);
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
  const changedCount = effectiveSort === null && hasContracts ? leadingChangedRowCount(rows) : 0;
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
              const direction = effectiveSort !== null && effectiveSort.column === column ? effectiveSort.direction : undefined;
              return (
                <th key={column} scope="col" aria-sort={direction}>
                  <button
                    type="button"
                    className="code-map__metrics-sort"
                    title={bar ? METRIC_BAR_HEADER_NOTE : undefined}
                    // P5-g: `aria-disabled`, never native `disabled`, so a
                    // focused header keeps focus when the rows go (P2-2).
                    aria-disabled={sortInert ? 'true' : undefined}
                    onClick={() => {
                      if (sortInert) return;
                      onSort(nextPrReviewMetricSort(sort, column));
                    }}
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
        {effectiveSort !== null && hasContracts && contractGroup}
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
        {effectiveSort === null && hasContracts && contractGroup}
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
        {formatMetricSortAnnouncement(effectiveSort)}
      </p>
    </section>
  );
}

/** P4-2 phase 3c: what PR Review says when changed contracts were found without line ranges. */
export const CHANGED_CONTRACTS_APPROXIMATE_NOTE = "approximate: couldn't read line ranges";

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
