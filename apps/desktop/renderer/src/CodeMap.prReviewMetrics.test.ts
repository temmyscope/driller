/**
 * P4-3a: the PR Review metrics table — one row per changed Node below the
 * canvas, text values read straight from each Node's `riskSignals`.
 *
 * `buildPrReviewMetricRows` and `resolvePrReviewView` are pure; the table is
 * hookless and rendered by calling it and walking the returned elements
 * (`testRender.ts` — the runner is `node --test` with no DOM). The layout
 * variables are pinned by reading `styles.css` itself.
 *
 * What this cannot reach: `<ReactFlow>`'s inline height, the table actually
 * sitting below the canvas with `<Controls>` and the signal toggles above it,
 * and the changed rows' accent rule on screen — the spec's owed live check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ChangedContract, CodeMapNode, DeterministicRiskSignal, RiskSignal } from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';

import {
  beginMetricsTableDrag,
  buildPrReviewMetricRows,
  canvasResizeEffect,
  clampMetricsTableHeight,
  CODE_MAP_CANVAS_HEIGHT,
  CodeMapCanvasFrame,
  codeMapTableHeightStyle,
  endMetricsTableDrag,
  METRICS_TABLE_DEFAULT_HEIGHT,
  METRICS_TABLE_DRAGGING_ATTRIBUTE,
  METRICS_TABLE_KEY_STEP,
  METRICS_TABLE_MIN_HEIGHT,
  metricsTableDragHeight,
  metricsTableHeightBounds,
  metricsTableHeightFor,
  metricsTableKeyStep,
  metricsTableValueText,
  MetricsTableDivider,
  type MetricsTableDividerPointerEvent,
  moveMetricsTableDrag,
  prReviewMetricsTableFor,
  type CodeMapMode,
  type DiffScopeState,
  type FetchState,
  formatDeterministicSignalLabel,
  formatHiddenAffectedNodes,
  formatMissingAffectedNodes,
  formatMissingChangedNodes,
  METRIC_CELL_EMPTY,
  METRICS_TABLE_AFFECTED_ROW_CAP,
  nodesWithinDepth,
  type BlastRadiusState,
  defaultPrReviewMetricSort,
  formatMetricSortAnnouncement,
  formatSortedWithinCapNote,
  METRIC_BAR_HEADER_NOTE,
  metricBar,
  metricBarWidths,
  nextPrReviewMetricSort,
  PR_REVIEW_METRIC_COLUMNS,
  PrReviewMetricsTable,
  type PrReviewMetricRow,
  type PrReviewMetricRows,
  type PrReviewMetricSort,
  type PrReviewMetricSortColumn,
  sortPrReviewMetricRows,
  resolvePrReviewView,
  activateMetricsRowFromCell,
  HEALTH_ROW_AFFORDANCE,
  METRICS_ROW_BUTTON_CLASS,
  type MetricsRowButtonTarget,
  SEVERE_SIGNAL_GLYPH,
  formatMetricTestsCell,
  METRIC_TESTS_COVERED_LABEL,
  METRIC_TESTS_NO_DATA_TITLE,
  METRIC_TESTS_UNPROVEN_TITLE,
  metricTestsState,
  CHANGED_CONTRACTS_APPROXIMATE_NOTE,
  CHANGED_CONTRACTS_SHOWN,
  ChangedContractButton,
  ChangedContractList,
  foldedTypeNoun,
  formatContractDependents,
  leadingChangedRowCount,
  METRICS_CONTRACT_HOP,
  MetricsContractRow,
  prReviewMetricsCaption,
} from './CodeMap';
import { ACTIONABLE_NOTICE_GLYPHS } from './ActionableNotice';
import { renderTree, textOf, type RenderedElement } from './testRender';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const loc = { file: 'src/x.ts', startLine: 1, endLine: 2 };

const det = (
  type: 'complexity' | 'cognitive-complexity' | 'hotspot' | 'blast-radius' | 'test-coverage-gap',
  value: number,
  severity: 'moderate' | 'severe' = 'moderate',
): DeterministicRiskSignal => ({ family: 'deterministic', type, value, severity, location: loc });

const finding = (severity: 'blocker' | 'major' | 'minor' | 'info', sourceTool: string): RiskSignal => ({
  family: 'ingested',
  severity,
  sourceTool,
  finding: 'x',
  location: loc,
});

const node = (id: string, overrides: Partial<CodeMapNode> = {}): CodeMapNode => ({
  id,
  name: id.split('::').pop() ?? id,
  file: 'src/a.ts',
  startLine: 1,
  endLine: 5,
  kind: 'Function',
  summaryStatus: 'ready',
  summary: 'Does a thing.',
  riskSignals: [],
  ...overrides,
});

const ready = (nodes: CodeMapNode[]): FetchState => ({
  status: 'ready',
  nodes,
  edges: [],
  hiddenByScope: 0,
  appliedScope: [],
  foldedTypes: [],
});

const resolved = (nodeIds: string[]): DiffScopeState => ({
  status: 'resolved',
  resolvedBaseRef: 'abc123',
  nodeIds: new Set(nodeIds),
  topLevelFiles: [],
  changedContracts: [],
});

const THREE = [
  node('src/b.ts::pay', {
    file: 'src/billing/b.ts',
    startLine: 40,
    riskSignals: [
      det('complexity', 42, 'severe'),
      det('cognitive-complexity', 7),
      det('blast-radius', 9),
      det('test-coverage-gap', 1),
      finding('minor', 'Qodo'),
      finding('blocker', 'CodeRabbit'),
      finding('major', 'Qodo'),
    ],
  }),
  node('src/a.ts::load', { file: 'src/a.ts', startLine: 10, riskSignals: [det('complexity', 3)] }),
  node('src/b.ts::refund', {
    file: 'src/billing/b.ts',
    startLine: 5,
    summaryStatus: 'coverage-gap',
    summary: undefined,
    riskSignals: [det('blast-radius', 120, 'severe')],
  }),
];

/** P4-3g: a changed contract, as `CodeMap.changedContracts.test.ts`'s fixture builds one. */
const contractFixture = (
  name: string,
  dependentIds: string[],
  dependentCount = dependentIds.length,
  kind: ChangedContract['kind'] = 'Interface',
): ChangedContract => ({
  id: `src/types.ts::${name}`,
  name,
  kind,
  file: 'src/types.ts',
  dependentCount,
  dependentIds,
});

/** P4-3g: a table with no changed contracts — what every pre-P4-3g render test passes. */
const NO_CONTRACT_PROPS = {
  changedContracts: [] as readonly ChangedContract[],
  changedContractsApproximate: false,
  onOpenType: (_id: string) => {},
};

/** P4-3a cases: no blast radius. */
const IDLE_BLAST_RADIUS: BlastRadiusState = { status: 'idle' };

const unchanged = node('src/c.ts::other', { file: 'src/c.ts', riskSignals: [det('complexity', 99, 'severe')] });

// ---------------------------------------------------------------------------
// buildPrReviewMetricRows
// ---------------------------------------------------------------------------

describe('buildPrReviewMetricRows', () => {
  const ids = THREE.map((n) => n.id);
  const { rows, missingChangedCount } = buildPrReviewMetricRows([unchanged, ...THREE], new Set(ids), null, 0);

  it('one row per changed Node, hop "changed", unchanged Nodes left out', () => {
    assert.equal(rows.length, 3);
    assert.deepEqual(new Set(rows.map((r) => r.id)), new Set(ids));
    assert.ok(rows.every((r) => r.hop === 'changed'));
    assert.equal(missingChangedCount, 0);
  });

  it('orders by blast radius descending (none last), then id — P4-3d review: the default comparator, not file/line', () => {
    assert.deepEqual(
      rows.map((r) => r.id),
      ['src/b.ts::refund', 'src/b.ts::pay', 'src/a.ts::load'],
    );
    // No blast radius anywhere: file and line no longer matter, id decides.
    const tie = buildPrReviewMetricRows(
      [node('z', { startLine: 3 }), node('m', { startLine: 3 }), node('a', { startLine: 9 })],
      new Set(['z', 'm', 'a']), null, 0,
    );
    assert.deepEqual(
      tie.rows.map((r) => r.id),
      ['a', 'm', 'z'],
    );
  });

  it('changed rows with differing blast values: highest first, equal ones by id, absent last', () => {
    const table = buildPrReviewMetricRows(
      [
        node('src/a.ts::first', { file: 'src/a.ts', startLine: 1, riskSignals: [det('blast-radius', 2)] }),
        node('src/z.ts::wide', { file: 'src/z.ts', startLine: 99, riskSignals: [det('blast-radius', 70, 'severe')] }),
        node('src/m.ts::none', { file: 'src/m.ts' }),
        node('src/q.ts::tieB', { file: 'src/q.ts', riskSignals: [det('blast-radius', 30)] }),
        node('src/b.ts::tieA', { file: 'src/b.ts', riskSignals: [det('blast-radius', 30)] }),
      ],
      new Set(['src/a.ts::first', 'src/z.ts::wide', 'src/m.ts::none', 'src/q.ts::tieB', 'src/b.ts::tieA']),
      null,
      0,
    );
    assert.deepEqual(
      table.rows.map((r) => r.id),
      ['src/z.ts::wide', 'src/b.ts::tieA', 'src/q.ts::tieB', 'src/a.ts::first', 'src/m.ts::none'],
    );
  });

  it('values equal each Node\'s riskSignals — complexity, never cognitive complexity', () => {
    const pay = rows.find((r) => r.id === 'src/b.ts::pay');
    assert.deepEqual(pay?.complexity, det('complexity', 42, 'severe'));
    assert.deepEqual(pay?.blastRadius, det('blast-radius', 9));
    assert.equal(pay?.testCoverageGap, true);
    assert.equal(pay?.moduleLine, 'src/billing/');
    assert.equal(pay?.name, 'pay');
    const load = rows.find((r) => r.id === 'src/a.ts::load');
    assert.deepEqual(load?.complexity, det('complexity', 3));
    assert.equal(load?.blastRadius, null);
    assert.equal(load?.testCoverageGap, false);
    assert.equal(load?.findings, null);
    const cognitiveOnly = buildPrReviewMetricRows(
      [node('c', { riskSignals: [det('cognitive-complexity', 11)] })],
      new Set(['c']), null, 0,
    );
    assert.equal(cognitiveOnly.rows[0]?.complexity, null);
  });

  it('findings: the count, the highest severity and that finding\'s tool', () => {
    const pay = rows.find((r) => r.id === 'src/b.ts::pay');
    assert.deepEqual(pay?.findings, { count: 3, highestSeverity: 'blocker', sourceTool: 'CodeRabbit' });
    const infoFirst = buildPrReviewMetricRows(
      [node('f', { riskSignals: [finding('info', 'A'), finding('major', 'B'), finding('minor', 'C')] })],
      new Set(['f']), null, 0,
    );
    assert.deepEqual(infoFirst.rows[0]?.findings, { count: 3, highestSeverity: 'major', sourceTool: 'B' });
  });

  it('flags the index coverage gap from summaryStatus', () => {
    assert.deepEqual(
      rows.map((r) => r.coverageGap),
      [true, false, false],
    );
  });

  it('counts changed ids that are not on the current map instead of dropping them', () => {
    const result = buildPrReviewMetricRows(THREE, new Set([...ids, 'gone::one', 'gone::two']), null, 0);
    assert.equal(result.rows.length, 3);
    assert.equal(result.missingChangedCount, 2);
    assert.equal(formatMissingChangedNodes(1), '1 changed Node not on the current map');
    assert.equal(formatMissingChangedNodes(2), '2 changed Nodes not on the current map');
    assert.equal(formatMissingChangedNodes(0), null);
  });
});

// ---------------------------------------------------------------------------
// resolvePrReviewView: the table's gate
// ---------------------------------------------------------------------------

describe('resolvePrReviewView: the metrics table gate', () => {
  const map = ready([unchanged, ...THREE]);
  const scope = resolved(THREE.map((n) => n.id));

  it('shows the table in PR Review with a showable map and a resolved scope', () => {
    const table = resolvePrReviewView('prReview', map, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable;
    assert.equal(table?.rows.length, 3);
  });

  it('no table for any other scope status', () => {
    const others: DiffScopeState[] = [
      { status: 'idle' },
      { status: 'loading' },
      { status: 'no-changes' },
      { status: 'not-a-git-repo' },
      { status: 'no-base-ref-resolvable' },
      { status: 'error', message: 'boom' },
    ];
    for (const state of others) {
      assert.equal(resolvePrReviewView('prReview', map, state, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null, state.status);
      // A stray `nodeIds` (a leftover from an earlier resolved scope) must not
      // open the table either: the gate is the status, not the data.
      // P4-3g: nor a stray `changedContracts` — the contract gate is the
      // status too.
      const stray = {
        ...state,
        nodeIds: new Set(THREE.map((n) => n.id)),
        changedContracts: [contractFixture('CodeMapNode', ['src/a.ts::load'], 59)],
        changedContractsApproximate: true,
      } as unknown as DiffScopeState;
      assert.equal(resolvePrReviewView('prReview', map, stray, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null, `${state.status} + stray nodeIds`);
    }
  });

  it('no table outside PR Review, or without a showable map', () => {
    for (const mode of ['codeMap', 'healthAudit'] as CodeMapMode[]) {
      assert.equal(resolvePrReviewView(mode, map, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null, mode);
    }
    assert.equal(resolvePrReviewView('prReview', { status: 'loading' }, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
    assert.equal(resolvePrReviewView('prReview', ready([]), scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
    assert.equal(resolvePrReviewView('prReview', { status: 'error', message: 'x' }, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
  });

  it('no table for 0 changed Nodes and no contracts (top-level-only diff), or only off-map ids — P4-3g: a contract-only diff is tested below', () => {
    assert.equal(resolvePrReviewView('prReview', map, resolved([]), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
    assert.equal(resolvePrReviewView('prReview', map, resolved(['gone::x']), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
  });

  it('mounts only with the canvas: prReviewMetricsTableFor', () => {
    const view = resolvePrReviewView('prReview', map, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS);
    assert.equal(prReviewMetricsTableFor(view), view.metricsTable);
    assert.notEqual(view.metricsTable, null);
    assert.equal(prReviewMetricsTableFor({ ...view, surfaces: { ...view.surfaces, canvas: false } }), null);
    assert.equal(prReviewMetricsTableFor(resolvePrReviewView('codeMap', map, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS)), null);
  });

  it('keeps the off-map count alongside real rows', () => {
    const table = resolvePrReviewView('prReview', map, resolved([THREE[0]!.id, 'gone::x']), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable;
    assert.deepEqual([table?.rows.length, table?.missingChangedCount], [1, 1]);
  });
});

// ---------------------------------------------------------------------------
// PrReviewMetricsTable
// ---------------------------------------------------------------------------

function render(
  table: PrReviewMetricRows,
  blastRadiusStatus: BlastRadiusState['status'] = 'idle',
  sort: PrReviewMetricSort | null = null,
  onSort: (sort: PrReviewMetricSort) => void = () => {},
  onActivateNode: (node: CodeMapNode) => void = () => {},
): RenderedElement[] {
  return renderTree(PrReviewMetricsTable({ ...NO_CONTRACT_PROPS, ...table, blastRadiusStatus, sort, onSort, onActivateNode }));
}

const byType = (elements: RenderedElement[], type: string) => elements.filter((e) => e.type === type);
const rowsOf = (elements: RenderedElement[]) =>
  byType(elements, 'tr').filter((tr) => String(tr.props.className ?? '').includes('code-map__metrics-table-row'));
const cellsOf = (row: RenderedElement) =>
  renderTree(row.props.children).filter((e) => e.type === 'td' || e.type === 'th');

describe('PrReviewMetricsTable', () => {
  const table = buildPrReviewMetricRows(THREE, new Set(THREE.map((n) => n.id)), null, 0);
  const elements = render(table);

  it('is a native table with six scope="col" headers, blast radius naming its fixed bound', () => {
    assert.equal(byType(elements, 'table').length, 1);
    const headers = renderTree(byType(elements, 'thead')[0]?.props.children).filter((e) => e.type === 'th');
    // P4-3d: the bar columns add their visually hidden "relative" note.
    assert.deepEqual(
      headers.map((h) => textOf(h)),
      [
        'node',
        'hop',
        `complexity ${METRIC_BAR_HEADER_NOTE}`,
        `blast radius (${BLAST_RADIUS_DEFAULT_HOPS} hops) ${METRIC_BAR_HEADER_NOTE}`,
        'tests',
        'findings',
      ],
    );
    assert.ok(headers.every((h) => h.props.scope === 'col'));
  });

  it('renders one row per changed Node, with the changed modifier', () => {
    const rows = rowsOf(elements);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => String(r.props.className).includes('code-map__metrics-table-row--changed')));
  });

  it('cells: identifier, module, hop, values, tests gap and findings', () => {
    const pay = rowsOf(elements)[1]!;
    const cells = cellsOf(pay).map((c) => textOf(c));
    assert.deepEqual(cells, [
      'paysrc/billing/, src/billing/b.ts line 40, open Node detail',
      'changed',
      `${SEVERE_SIGNAL_GLYPH} 42`,
      '9',
      'gap',
      '3 · blocker · CodeRabbit',
    ]);
    const name = renderTree(pay.props.children).find((e) => e.type === 'code');
    assert.equal(textOf(name), 'pay');
  });

  it('a severe value carries the ! glyph and "(severe)" in its accessible name, which never repeats the header', () => {
    const labelled = elements.filter((e) => e.props.role === 'img' && typeof e.props['aria-label'] === 'string');
    const complexity = labelled.find((e) => e.props['aria-label'] === '42 (severe)');
    assert.ok(complexity, 'the severe complexity cell is labelled "42 (severe)"');
    assert.equal(textOf(complexity), `${SEVERE_SIGNAL_GLYPH} 42`);
    assert.equal(complexity.props.title, formatDeterministicSignalLabel(det('complexity', 42, 'severe')));
    const moderate = labelled.find((e) => e.props['aria-label'] === '3');
    assert.ok(moderate);
    assert.equal(textOf(moderate), '3');
    assert.ok(
      labelled.every((e) => !/complexity|blast radius/i.test(String(e.props['aria-label']))),
      'no cell name repeats its column header',
    );
  });

  it('same-name rows differ in their accessible text by file and line', () => {
    const twins = buildPrReviewMetricRows(
      [node('a::handle', { name: 'handle', startLine: 3 }), node('b::handle', { name: 'handle', startLine: 30 })],
      new Set(['a::handle', 'b::handle']), null, 0,
    );
    const nodeCells = rowsOf(render(twins)).map((row) => textOf(cellsOf(row)[0]));
    assert.deepEqual(nodeCells, ['handlesrc/, src/a.ts line 3, open Node detail', 'handlesrc/, src/a.ts line 30, open Node detail']);
  });

  it('absent signals render —, and nothing anywhere says "covered"', () => {
    const load = rowsOf(elements)[2]!;
    assert.deepEqual(
      cellsOf(load).map((c) => textOf(c)),
      ['loadsrc/, src/a.ts line 10, open Node detail', 'changed', '3', METRIC_CELL_EMPTY, METRIC_CELL_EMPTY, METRIC_CELL_EMPTY],
    );
    assert.equal(METRIC_CELL_EMPTY, '—');
    const allText = textOf(PrReviewMetricsTable({ ...NO_CONTRACT_PROPS, ...table, blastRadiusStatus: 'idle', sort: null, onSort: () => {}, onActivateNode: () => {} })).toLowerCase();
    assert.ok(!allText.includes('covered'), allText);
    assert.ok(!allText.includes('%'), allText);
  });

  it('shows the index coverage-gap glyph on a coverage-gap Node', () => {
    const refund = rowsOf(elements)[0]!;
    const glyph = renderTree(refund.props.children).find(
      (e) => e.props.className === 'code-map__metrics-table-coverage-gap',
    );
    assert.equal(textOf(glyph), '⚠');
    assert.equal(
      rowsOf(elements)[2] && renderTree(rowsOf(elements)[2]!.props.children).some(
        (e) => e.props.className === 'code-map__metrics-table-coverage-gap',
      ),
      false,
    );
  });

  it('the off-map line is inert text, and absent with nothing missing', () => {
    const missingLine = (els: RenderedElement[]) =>
      els.find((e) => e.props.className === 'code-map__metrics-table-missing');
    assert.equal(missingLine(elements), undefined);
    const withMissing = render({ ...table, missingChangedCount: 1 });
    const line = missingLine(withMissing);
    assert.equal(line?.type, 'p');
    assert.equal(textOf(line), '1 changed Node not on the current map');
    assert.equal(line?.props.onClick, undefined);
  });
});

// ---------------------------------------------------------------------------
// Layout variables (styles.css)
// ---------------------------------------------------------------------------

describe('styles.css: the table band below the canvas', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('\n}', start));
  };

  it('.code-map defaults the table height to 0 and adds it to the bottom clearance', () => {
    const codeMap = block('.code-map');
    assert.match(codeMap, /--code-map-table-height: 0px;/);
    assert.match(codeMap, /--code-map-bottom-clearance: calc\([^;]*var\(--code-map-table-height\)\);/);
  });

  it('the table sets a non-zero height, capped for short windows; the refresh error and the table use it', () => {
    // `block` finds the selector verbatim, so this also pins the `> ` child combinator.
    assert.match(
      block('.code-map:has(> .code-map__metrics-table)'),
      /--code-map-table-height: min\(13rem, 40cqh\);/,
    );
    assert.match(block('.code-map__refresh-error'), /bottom: calc\(1rem \+ var\(--code-map-table-height\)\);/);
    assert.match(block('.code-map__metrics-table'), /height: var\(--code-map-table-height\);/);
  });
});

// ---------------------------------------------------------------------------
// The canvas frame: the measured element is the sized one
// ---------------------------------------------------------------------------

describe('CodeMapCanvasFrame', () => {
  it('puts the ResizeObserver ref on the div whose height leaves the table band free', () => {
    const canvasRef = () => {};
    const child = { marker: true };
    const frame = renderTree(CodeMapCanvasFrame({ canvasRef, children: child as never }))[0]!;
    assert.equal(frame.type, 'div');
    assert.equal(frame.props.ref, canvasRef);
    assert.deepEqual(frame.props.style, { height: CODE_MAP_CANVAS_HEIGHT });
    assert.equal(CODE_MAP_CANVAS_HEIGHT, 'calc(100% - var(--code-map-table-height))');
    assert.equal(frame.props.children, child);
  });
});

// ---------------------------------------------------------------------------
// P4-3b: the resizable divider
// ---------------------------------------------------------------------------

describe('clampMetricsTableHeight', () => {
  it('holds a height between the min and 60% of the map', () => {
    assert.equal(METRICS_TABLE_MIN_HEIGHT, 96);
    assert.equal(clampMetricsTableHeight(200, 1000), 200);
    assert.equal(clampMetricsTableHeight(10, 1000), METRICS_TABLE_MIN_HEIGHT);
    assert.equal(clampMetricsTableHeight(900, 1000), 600);
    assert.equal(clampMetricsTableHeight(601, 1000), 600);
    assert.deepEqual(metricsTableHeightBounds(1000), { min: 96, max: 600 });
  });

  it('a tiny map: the table stays at the min, never more than the map', () => {
    // 120 * 0.6 = 72 < 96: the min wins over the 60% cap.
    assert.deepEqual(metricsTableHeightBounds(120), { min: 96, max: 96 });
    assert.equal(clampMetricsTableHeight(10, 120), 96);
    assert.equal(clampMetricsTableHeight(500, 120), 96);
    // Shorter than the min itself: the table takes the map, the canvas 0 — never negative.
    assert.equal(clampMetricsTableHeight(500, 50), 50);
    assert.equal(clampMetricsTableHeight(500, 0), 0);
    assert.equal(clampMetricsTableHeight(Number.NaN, 1000), 96);
  });

  it('defaults to 35% of the map, and re-clamps the last height when the map shrinks', () => {
    assert.equal(METRICS_TABLE_DEFAULT_HEIGHT, 0.35);
    assert.equal(metricsTableHeightFor(null, 1000), 350);
    assert.equal(metricsTableHeightFor(null, 200), 96);
    assert.equal(metricsTableHeightFor(500, 1000), 500);
    assert.equal(metricsTableHeightFor(500, 600), 360);
  });

  it('a drag up grows the table, down shrinks it, within the bounds', () => {
    assert.equal(metricsTableDragHeight(300, 500, 400, 1000), 400);
    assert.equal(metricsTableDragHeight(300, 500, 600, 1000), 200);
    assert.equal(metricsTableDragHeight(300, 500, -1000, 1000), 600);
    assert.equal(metricsTableDragHeight(300, 500, 2000, 1000), 96);
  });
});

describe('metricsTableKeyStep', () => {
  it('ArrowUp grows and ArrowDown shrinks by 24px', () => {
    assert.equal(METRICS_TABLE_KEY_STEP, 24);
    assert.equal(metricsTableKeyStep('ArrowUp', 300, 1000), 324);
    assert.equal(metricsTableKeyStep('ArrowDown', 300, 1000), 276);
  });

  it('PageUp/PageDown step 25% of the map', () => {
    assert.equal(metricsTableKeyStep('PageUp', 300, 1000), 550);
    assert.equal(metricsTableKeyStep('PageDown', 350, 1000), 100);
  });

  it('Home/End jump to the min and max', () => {
    assert.equal(metricsTableKeyStep('Home', 300, 1000), 96);
    assert.equal(metricsTableKeyStep('End', 300, 1000), 600);
  });

  it('steps stay within the bounds: ArrowDown at min stays at min', () => {
    assert.equal(metricsTableKeyStep('ArrowDown', 96, 1000), 96);
    assert.equal(metricsTableKeyStep('ArrowUp', 590, 1000), 600);
    assert.equal(metricsTableKeyStep('PageDown', 150, 1000), 96);
  });

  it('an unknown key is not handled', () => {
    for (const key of ['Tab', 'Enter', ' ', 'ArrowLeft', 'a']) {
      assert.equal(metricsTableKeyStep(key, 300, 1000), null, key);
    }
  });
});

describe('codeMapTableHeightStyle', () => {
  it('writes the height as the CSS variable only with the table and a measured map', () => {
    assert.deepEqual(codeMapTableHeightStyle(true, 350, 1000), { '--code-map-table-height': '350px' });
    assert.equal(codeMapTableHeightStyle(false, 350, 1000), undefined);
    assert.equal(codeMapTableHeightStyle(true, 0, 0), undefined);
  });
});

describe('MetricsTableDivider', () => {
  const renderDivider = (height: number, mapHeight: number, onResize: (h: number) => void = () => {}) =>
    renderTree(MetricsTableDivider({ height, mapHeight, onResize }))[0]!;

  it('is a focusable horizontal separator carrying the table height and its bounds', () => {
    const divider = renderDivider(350, 1000);
    assert.equal(divider.type, 'div');
    assert.equal(divider.props.role, 'separator');
    assert.equal(divider.props.tabIndex, 0);
    assert.equal(divider.props['aria-orientation'], 'horizontal');
    assert.equal(divider.props['aria-label'], 'Resize metrics table');
    assert.equal(divider.props['aria-valuenow'], 350);
    assert.equal(divider.props['aria-valuemin'], 96);
    assert.equal(divider.props['aria-valuemax'], 600);
    assert.equal(divider.props.className, 'code-map__metrics-divider');
    assert.equal(divider.props['aria-valuetext'], '350 px, 35% of map');
    assert.equal(metricsTableValueText(96, 0), '96 px');
  });

  const key = (divider: RenderedElement, name: string) => {
    let prevented = false;
    (divider.props.onKeyDown as (e: unknown) => void)({
      key: name,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };

  it('a key step commits the new height and never scrolls the page', () => {
    const resized: number[] = [];
    const divider = renderDivider(300, 1000, (h) => resized.push(h));
    assert.equal(key(divider, 'ArrowUp'), true);
    assert.equal(key(divider, 'End'), true);
    assert.deepEqual(resized, [324, 600]);
  });

  it('ArrowDown at min: prevented, but no resize', () => {
    const resized: number[] = [];
    assert.equal(key(renderDivider(96, 1000, (h) => resized.push(h)), 'ArrowDown'), true);
    assert.deepEqual(resized, []);
  });

  it('an unknown key is left to the browser and resizes nothing', () => {
    const resized: number[] = [];
    assert.equal(key(renderDivider(300, 1000, (h) => resized.push(h)), 'Tab'), false);
    assert.deepEqual(resized, []);
  });
});

describe('the divider drag', () => {
  const fakeDivider = () => {
    const writes: Array<[string, string]> = [];
    const attributes: Record<string, string> = {};
    const captured = new Set<number>();
    const parentAttributes = new Set<string>();
    const target = {
      parentElement: {
        style: { setProperty: (name: string, value: string) => writes.push([name, value]) },
        setAttribute: (name: string) => parentAttributes.add(name),
        removeAttribute: (name: string) => parentAttributes.delete(name),
      },
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    };
    const event = (clientY: number, overrides: Partial<MetricsTableDividerPointerEvent> = {}): MetricsTableDividerPointerEvent => ({
      pointerId: 1,
      button: 0,
      clientY,
      preventDefault: () => {},
      currentTarget: target,
      ...overrides,
    });
    return { writes, attributes, captured, parentAttributes, event };
  };

  it('captures the pointer, writes only the CSS variable while moving, and commits once on release', () => {
    const d = fakeDivider();
    const resized: number[] = [];
    beginMetricsTableDrag(d.event(500), 300);
    assert.ok(d.captured.has(1));
    assert.ok(d.parentAttributes.has(METRICS_TABLE_DRAGGING_ATTRIBUTE));
    moveMetricsTableDrag(d.event(450), 1000);
    moveMetricsTableDrag(d.event(-5000), 1000);
    assert.deepEqual(d.writes, [
      ['--code-map-table-height', '350px'],
      ['--code-map-table-height', '600px'],
    ]);
    assert.equal(d.attributes['aria-valuenow'], '600');
    assert.equal(d.attributes['aria-valuetext'], '600 px, 60% of map');
    assert.equal(resized.length, 0);
    endMetricsTableDrag(d.event(-5000), (h) => resized.push(h));
    assert.deepEqual(resized, [600]);
    assert.equal(d.captured.size, 0);
    assert.equal(d.parentAttributes.size, 0);
    // The lostpointercapture after pointerup finds no drag.
    endMetricsTableDrag(d.event(-5000), (h) => resized.push(h));
    moveMetricsTableDrag(d.event(0), 1000);
    assert.deepEqual(resized, [600]);
    assert.equal(d.writes.length, 2);
  });

  it('a lost capture (release outside the window) ends the drag', () => {
    const d = fakeDivider();
    const resized: number[] = [];
    beginMetricsTableDrag(d.event(500), 300);
    moveMetricsTableDrag(d.event(600), 1000);
    d.captured.clear();
    endMetricsTableDrag(d.event(600), (h) => resized.push(h));
    assert.deepEqual(resized, [200]);
  });

  it('a click without movement, or a drag back to the start, commits nothing', () => {
    const d = fakeDivider();
    const resized: number[] = [];
    beginMetricsTableDrag(d.event(500), 350);
    endMetricsTableDrag(d.event(500), (h) => resized.push(h));
    beginMetricsTableDrag(d.event(500), 350);
    moveMetricsTableDrag(d.event(400), 1000);
    moveMetricsTableDrag(d.event(500), 1000);
    endMetricsTableDrag(d.event(500), (h) => resized.push(h));
    assert.equal(resized.length, 0);
    assert.equal(d.parentAttributes.size, 0);
  });

  it('a move or release from another pointer is ignored', () => {
    const d = fakeDivider();
    const resized: number[] = [];
    beginMetricsTableDrag(d.event(500), 300);
    moveMetricsTableDrag(d.event(400, { pointerId: 2 }), 1000);
    assert.deepEqual(d.writes, []);
    endMetricsTableDrag(d.event(400, { pointerId: 2 }), (h) => resized.push(h));
    assert.equal(resized.length, 0);
    assert.ok(d.captured.has(1));
    assert.ok(d.parentAttributes.has(METRICS_TABLE_DRAGGING_ATTRIBUTE));
    moveMetricsTableDrag(d.event(400), 1000);
    endMetricsTableDrag(d.event(400), (h) => resized.push(h));
    assert.deepEqual(resized, [400]);
  });

  it("the divider's pointer props: cancel and lost capture both end and commit", () => {
    for (const prop of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture']) {
      const d = fakeDivider();
      const resized: number[] = [];
      const divider = renderTree(MetricsTableDivider({ height: 300, mapHeight: 1000, onResize: (h) => resized.push(h) }))[0]!;
      const call = (name: string, e: MetricsTableDividerPointerEvent) => (divider.props[name] as (e: unknown) => void)(e);
      call('onPointerDown', d.event(500));
      call('onPointerMove', d.event(450));
      call(prop, d.event(450));
      assert.deepEqual(resized, [350], prop);
      assert.equal(d.parentAttributes.size, 0, prop);
    }
  });

  it('ignores a non-primary button', () => {
    const d = fakeDivider();
    beginMetricsTableDrag(d.event(500, { button: 2 }), 300);
    moveMetricsTableDrag(d.event(400), 1000);
    assert.equal(d.captured.size, 0);
    assert.deepEqual(d.writes, []);
  });
});

describe('styles.css: the divider', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('\n}', start));
  };

  it('a 1px border rule inside the table band, border-strong on hover, focus ring, row-resize, flat', () => {
    const divider = block('.code-map__metrics-divider');
    assert.match(divider, /bottom: calc\(var\(--code-map-table-height\) - 6px\);/);
    assert.match(divider, /height: 6px;/);
    assert.match(divider, /border-top: 1px solid var\(--border\);/);
    assert.match(divider, /cursor: row-resize;/);
    assert.doesNotMatch(divider, /shadow/);
    assert.match(block('.code-map__metrics-divider:hover'), /border-top-color: var\(--border-strong\);/);
    assert.match(block('.code-map__metrics-divider:focus-visible'), /outline: 2px solid var\(--accent\);/);
  });
});

describe('canvasResizeEffect: a divider drag defers the canvas size', () => {
  const a = { width: 800, height: 400 };
  const b = { width: 800, height: 300 };
  it('commits a changed size when no drag is on, defers it mid-drag, ignores an unchanged one', () => {
    assert.equal(canvasResizeEffect(false, a, b), 'commit');
    assert.equal(canvasResizeEffect(true, a, b), 'defer');
    assert.equal(canvasResizeEffect(true, a, { ...a }), 'none');
    assert.equal(canvasResizeEffect(false, a, { ...a }), 'none');
  });
});

describe('styles.css: short maps and drags', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  it('the floated columns keep a floor under a tall table band', () => {
    assert.match(css, /--code-map-column-min-height: 6rem;/);
    for (const selector of ['.code-map__path-trace', '.code-map__pr-review']) {
      const start = css.indexOf(`\n${selector} {`);
      assert.ok(start >= 0, selector);
      const rule = css.slice(start, css.indexOf('\n}', start));
      assert.match(rule, /max-height: max\(\s*var\(--code-map-column-min-height\),\s*calc\(100cqh - 0\.75rem - var\(--code-map-bottom-clearance\)/, selector);
    }
  });
  it('no text selection on the map while dragging', () => {
    assert.match(css, /\n\.code-map\[data-metrics-table-dragging\] \{\s*user-select: none;/);
    assert.equal(METRICS_TABLE_DRAGGING_ATTRIBUTE, 'data-metrics-table-dragging');
  });
});

// ---------------------------------------------------------------------------
// Wiring inside the hooked `CodeMap` — pinned on its source text, as it
// can't be rendered without a DOM.
// ---------------------------------------------------------------------------

describe('CodeMap source: the divider wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');
  it('the divider renders only with the table, directly before it', () => {
    assert.equal(src.split('<MetricsTableDivider').length - 1, 1);
    assert.match(
      src,
      /\{prReviewMetricsTableProps !== null && \(\s*<>\s*<MetricsTableDivider\s[^>]*\/>\s*<PrReviewMetricsTable\s+\{\.\.\.prReviewMetricsTableProps\}\s+sort=\{prReviewMetricSort\}\s+onSort=\{setPrReviewMetricSort\}\s+onActivateNode=\{openNodeDetail\}\s+onOpenType=\{openType\}\s+\/>\s*<\/>\s*\)\}/,
    );
  });
  it('.code-map carries the height style and the measured ref', () => {
    assert.match(
      src,
      /className="code-map"\s+id=\{MODAL_FOCUS_FALLBACK_ID\}\s+tabIndex=\{-1\}\s+ref=\{setMapElement\}\s+style=\{codeMapTableHeightStyle\(prReviewMetricsTableProps !== null, metricsTableHeight, mapHeight\)\}/,
    );
  });
  it('the canvas observer defers while the dragging attribute is on .code-map', () => {
    assert.match(
      src,
      /el\.parentElement\?\.hasAttribute\(METRICS_TABLE_DRAGGING_ATTRIBUTE\)[\s\S]{0,40}\n\s*if \(canvasResizeEffect\(dragging, committedContainerSizeRef\.current, next\) === 'commit'\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// P4-3c: affected rows by hop, live with the depth stepper, capped at 50
// ---------------------------------------------------------------------------

/** `count` affected on-map Nodes `prefix-00`…, each at `hop`. */
const affectedNodes = (prefix: string, count: number, blast?: (i: number) => number) =>
  Array.from({ length: count }, (_, i) =>
    node(`${prefix}-${String(i).padStart(3, '0')}`, blast === undefined ? {} : { riskSignals: [det('blast-radius', blast(i))] }),
  );
const hops = (entries: [CodeMapNode[], number][]): Map<string, number> =>
  new Map(entries.flatMap(([ns, hop]) => ns.map((n): [string, number] => [n.id, hop])));
const affectedOf = (table: PrReviewMetricRows) => table.rows.filter((r) => r.hop !== 'changed');

describe('nodesWithinDepth', () => {
  it('keeps every id at most `depth` hops away — the depth itself included', () => {
    const distances = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    assert.deepEqual(nodesWithinDepth(distances, 2), new Set(['a', 'b']));
    assert.deepEqual(nodesWithinDepth(distances, 1), new Set(['a']));
    assert.deepEqual(nodesWithinDepth(distances, 3), new Set(['a', 'b', 'c']));
    assert.deepEqual(nodesWithinDepth(distances, 0), new Set());
  });
});

describe('buildPrReviewMetricRows: affected rows', () => {
  const changed = THREE.map((n) => n.id);
  const oneHop = affectedNodes('one', 12);
  const twoHop = affectedNodes('two', 28);
  const map = [...THREE, ...oneHop, ...twoHop, unchanged];
  const distances = hops([
    [oneHop, 1],
    [twoHop, 2],
  ]);

  it('3 changed, 12 within 1 hop, 40 within 2: depth 1 → 3 + 12, depth 2 → 3 + 40', () => {
    const atOne = buildPrReviewMetricRows(map, new Set(changed), distances, 1);
    assert.equal(atOne.rows.length, 15);
    assert.deepEqual(
      atOne.rows.slice(0, 3).map((r) => r.hop),
      ['changed', 'changed', 'changed'],
    );
    assert.ok(affectedOf(atOne).every((r) => r.hop === 1));
    const atTwo = buildPrReviewMetricRows(map, new Set(changed), distances, 2);
    assert.equal(atTwo.rows.length, 43);
    assert.equal(atTwo.hiddenAffectedCount, 0);
    assert.equal(affectedOf(atTwo).filter((r) => r.hop === 2).length, 28);
  });

  it('the affected rows are exactly the canvas highlight at that depth (one slice, nodesWithinDepth)', () => {
    for (const depth of [1, 2]) {
      const table = buildPrReviewMetricRows(map, new Set(changed), distances, depth);
      assert.deepEqual(new Set(affectedOf(table).map((r) => r.id)), nodesWithinDepth(distances, depth), `depth ${depth}`);
    }
  });

  it('changed rows lead (blast radius descending, then id); affected rows: hop ascending, blast radius descending, then id', () => {
    const nodes = [
      node('z-far', { riskSignals: [det('blast-radius', 500)] }),
      node('b-none'),
      node('a-none'),
      node('m-low', { riskSignals: [det('blast-radius', 2)] }),
      node('k-high', { riskSignals: [det('blast-radius', 90, 'severe')] }),
      node('j-high', { riskSignals: [det('blast-radius', 90)] }),
      ...THREE,
    ];
    const distances = new Map([
      ['z-far', 2],
      ['b-none', 1],
      ['a-none', 1],
      ['m-low', 1],
      ['k-high', 1],
      ['j-high', 1],
    ]);
    const table = buildPrReviewMetricRows(nodes, new Set(changed), distances, 2);
    assert.deepEqual(
      table.rows.map((r) => r.id),
      ['src/b.ts::refund', 'src/b.ts::pay', 'src/a.ts::load', 'j-high', 'k-high', 'm-low', 'a-none', 'b-none', 'z-far'],
    );
    assert.deepEqual(
      table.rows.map((r) => r.hop),
      ['changed', 'changed', 'changed', 1, 1, 1, 1, 1, 2],
    );
  });

  it('an id both changed and in hopDistances (malformed reply) appears once, as changed', () => {
    const table = buildPrReviewMetricRows(THREE, new Set(changed), new Map([[changed[0]!, 1]]), 2);
    assert.equal(table.rows.length, 3);
    assert.deepEqual(
      table.rows.filter((r) => r.id === changed[0]).map((r) => r.hop),
      ['changed'],
    );
  });

  it('caps affected rows at 50: 50 shows all, 51 hides 1, 300 hides 250 (the remainder, not the total)', () => {
    assert.equal(METRICS_TABLE_AFFECTED_ROW_CAP, 50);
    for (const [count, hidden] of [
      [50, 0],
      [51, 1],
      [300, 250],
    ] as const) {
      const many = affectedNodes('n', count);
      const table = buildPrReviewMetricRows([...THREE, ...many], new Set(changed), hops([[many, 2]]), 2);
      assert.equal(table.rows.length, 3 + Math.min(count, 50), `${count}`);
      assert.equal(table.hiddenAffectedCount, hidden, `${count}`);
    }
    assert.equal(formatHiddenAffectedNodes(250), '+250 more affected Nodes — reduce depth');
    assert.equal(formatHiddenAffectedNodes(1), '+1 more affected Node — reduce depth');
    assert.equal(formatHiddenAffectedNodes(1000), '+1,000 more affected Nodes — reduce depth');
    assert.equal(formatHiddenAffectedNodes(0), null);
  });

  it('caps after ordering, so the nearest and widest-reaching Nodes survive', () => {
    // The map lists the far and the narrow Nodes first; a cap before the sort
    // would keep them.
    const far = node('a-far', { riskSignals: [det('blast-radius', 999)] });
    const narrow = affectedNodes('a-narrow', 5, () => 1);
    const wide = affectedNodes('z-wide', 50, (i) => 100 + i);
    const table = buildPrReviewMetricRows(
      [far, ...narrow, ...wide],
      new Set(),
      hops([
        [[far], 2],
        [narrow, 1],
        [wide, 1],
      ]),
      2,
    );
    assert.equal(table.rows.length, 50);
    assert.equal(table.hiddenAffectedCount, 6);
    assert.deepEqual(new Set(table.rows.map((r) => r.id)), new Set(wide.map((n) => n.id)));
    assert.equal(table.rows[0]?.id, 'z-wide-049');
  });

  it('never caps changed rows', () => {
    const manyChanged = affectedNodes('c', 55);
    const few = affectedNodes('f', 3);
    const table = buildPrReviewMetricRows(
      [...manyChanged, ...few],
      new Set(manyChanged.map((n) => n.id)),
      hops([[few, 1]]),
      1,
    );
    assert.equal(table.rows.length, 58);
    assert.equal(table.rows.filter((r) => r.hop === 'changed').length, 55);
    assert.equal(table.hiddenAffectedCount, 0);
  });

  it('leaves affected ids that are not on the current map out of the rows and the cap count, counting them apart', () => {
    const onMap = affectedNodes('n', 50);
    const distances = hops([[onMap, 1]]);
    for (let i = 0; i < 5; i += 1) {
      distances.set(`gone::${i}`, 1);
    }
    const table = buildPrReviewMetricRows([...THREE, ...onMap], new Set(changed), distances, 1);
    assert.equal(table.rows.length, 53);
    assert.equal(table.hiddenAffectedCount, 0);
    assert.equal(table.missingAffectedCount, 5);
    assert.equal(table.missingChangedCount, 0);
    assert.equal(formatMissingAffectedNodes(5), '5 affected Nodes not on the current map');
    assert.equal(formatMissingAffectedNodes(1), '1 affected Node not on the current map');
    assert.equal(formatMissingAffectedNodes(0), null);
  });

  it('accounts for every id in the slice: affected rows + "+N more" + off-map + the slice\'s changed ids', () => {
    const onMapNear = affectedNodes('near', 30);
    const onMapFar = affectedNodes('far', 40);
    const offChanged = 'gone::changed';
    const distances = hops([
      [onMapNear, 1],
      [onMapFar, 2],
    ]);
    // Malformed seeds (one on the map, one off it), off-map affected ids at
    // both depths, and one beyond any depth asked for.
    distances.set(changed[0]!, 1);
    distances.set(offChanged, 1);
    distances.set('gone::a', 1);
    distances.set('gone::b', 2);
    distances.set('gone::c', 3);
    const changedIds = new Set([...changed, offChanged]);
    for (const depth of [1, 2, 3]) {
      const slice = nodesWithinDepth(distances, depth);
      const table = buildPrReviewMetricRows([...THREE, ...onMapNear, ...onMapFar], changedIds, distances, depth);
      const changedInSlice = [...slice].filter((id) => changedIds.has(id)).length;
      assert.equal(
        affectedOf(table).length + table.hiddenAffectedCount + table.missingAffectedCount + changedInSlice,
        slice.size,
        `depth ${depth}`,
      );
      assert.ok(affectedOf(table).length <= METRICS_TABLE_AFFECTED_ROW_CAP);
    }
    const atTwo = buildPrReviewMetricRows([...THREE, ...onMapNear, ...onMapFar], changedIds, distances, 2);
    assert.deepEqual(
      [affectedOf(atTwo).length, atTwo.hiddenAffectedCount, atTwo.missingAffectedCount, atTwo.missingChangedCount],
      [50, 20, 2, 1],
    );
  });

  it('without a blast radius (null), changed rows only', () => {
    const table = buildPrReviewMetricRows(map, new Set(changed), null, 2);
    assert.equal(table.rows.length, 3);
    assert.equal(table.hiddenAffectedCount, 0);
  });
});

describe('resolvePrReviewView: blast radius states', () => {
  const oneHop = affectedNodes('one', 4);
  const map = ready([...THREE, ...oneHop]);
  const scope = resolved(THREE.map((n) => n.id));
  const resolvedRadius: BlastRadiusState = { status: 'resolved', hopDistances: hops([[oneHop, 1]]), maxDepth: 1 };

  it('resolved: changed and affected rows, with the blast radius status', () => {
    const table = resolvePrReviewView('prReview', map, scope, resolvedRadius, 1).metricsTable;
    assert.equal(table?.rows.length, 7);
    assert.equal(table?.blastRadiusStatus, 'resolved');
  });

  it('loading: the changed rows, with the loading status for the caption', () => {
    const table = resolvePrReviewView('prReview', map, scope, { status: 'loading' }, 2).metricsTable;
    assert.equal(table?.rows.length, 3);
    assert.equal(table?.blastRadiusStatus, 'loading');
  });

  it('error, idle, or nothing reachable (maxDepth 0): changed rows only', () => {
    const states: BlastRadiusState[] = [
      { status: 'error', message: 'boom' },
      { status: 'idle' },
      { status: 'resolved', hopDistances: new Map(), maxDepth: 0 },
    ];
    for (const state of states) {
      const table = resolvePrReviewView('prReview', map, scope, state, 2).metricsTable;
      assert.equal(table?.rows.length, 3, state.status);
      assert.equal(table?.hiddenAffectedCount, 0, state.status);
      assert.equal(table?.missingAffectedCount, 0, state.status);
    }
  });
});

describe('PrReviewMetricsTable: hop column, cap line, off-map line and caption', () => {
  const changed = THREE.map((n) => n.id);
  const many = affectedNodes('n', 52);
  const capped = buildPrReviewMetricRows([...THREE, ...many], new Set(changed), hops([[many, 2]]), 2);
  const elements = render(capped);
  const capLines = (els: RenderedElement[]) => byType(els, 'tr').filter((tr) => tr.props.className === 'code-map__metrics-cap');
  const offMapLines = (els: RenderedElement[]) =>
    els.filter((e) => e.props.className === 'code-map__metrics-table-missing code-map__metrics-table-missing--affected');

  it('affected rows show their hop and the plain zebra, never the changed rule', () => {
    const rows = rowsOf(elements);
    assert.equal(rows.length, 53);
    const affected = rows.slice(3);
    assert.ok(affected.every((r) => r.props.className === 'code-map__metrics-table-row'));
    assert.ok(affected.every((r) => textOf(cellsOf(r)[1]) === '2'));
    assert.ok(rows.slice(0, 3).every((r) => String(r.props.className).includes('--changed')));
  });

  it('the cap line is one inert cell spanning every column: no handler, no focus stop, no button', () => {
    const [line, ...rest] = capLines(elements);
    assert.ok(line);
    assert.equal(rest.length, 0);
    const cells = renderTree(line.props.children).filter((e) => e.type === 'td' || e.type === 'th');
    assert.equal(cells.length, 1);
    const headers = renderTree(byType(elements, 'thead')[0]?.props.children).filter((e) => e.type === 'th');
    assert.equal(cells[0]?.props.colSpan, headers.length);
    assert.equal(textOf(line), '+2 more affected Nodes — reduce depth');
    for (const element of [line, ...renderTree(line.props.children)]) {
      assert.equal(element.props.onClick, undefined);
      assert.equal(element.props.onKeyDown, undefined);
      assert.equal(element.props.tabIndex, undefined);
      assert.notEqual(element.type, 'button');
    }
  });

  it('no cap line when nothing is past the cap', () => {
    assert.equal(capLines(render({ ...capped, hiddenAffectedCount: 0 })).length, 0);
  });

  it('the off-map affected line is inert text, and absent with nothing off the map', () => {
    assert.equal(offMapLines(elements).length, 0);
    const [line] = offMapLines(render({ ...capped, missingAffectedCount: 3 }));
    assert.equal(line?.type, 'p');
    assert.equal(textOf(line), '3 affected Nodes not on the current map');
    assert.equal(line?.props.onClick, undefined);
    assert.equal(line?.props.tabIndex, undefined);
  });

  it('caption: shown with "Computing blast radius…" while loading, else hidden and naming affected Nodes only when there are any', () => {
    const caption = (els: RenderedElement[]) => byType(els, 'caption')[0];
    const loading = caption(render(capped, 'loading'));
    assert.equal(textOf(loading), "Changed Nodes' risk metrics. Computing blast radius…");
    assert.equal(loading?.props.className, 'code-map__metrics-table-caption');
    const withAffected = caption(elements);
    assert.equal(textOf(withAffected), "Changed and affected Nodes' risk metrics");
    assert.equal(withAffected?.props.className, 'visually-hidden');
    const changedOnly = buildPrReviewMetricRows(THREE, new Set(changed), null, 2);
    for (const status of ['idle', 'error', 'resolved'] as const) {
      const hidden = caption(render(changedOnly, status));
      assert.equal(textOf(hidden), "Changed Nodes' risk metrics", status);
      assert.equal(hidden?.props.className, 'visually-hidden', status);
    }
    assert.equal(
      textOf(caption(render({ ...changedOnly, missingAffectedCount: 1 }))),
      "Changed and affected Nodes' risk metrics",
    );
    assert.equal(
      textOf(caption(render({ ...changedOnly, hiddenAffectedCount: 1 }))),
      "Changed and affected Nodes' risk metrics",
    );
  });
});

describe('styles.css: the cap line and the caption', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  const rule = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('\n}', start));
  };
  it('the cap line is muted text', () => {
    assert.match(rule('.code-map__metrics-cap'), /color: var\(--text-mute\);/);
  });
  it('the zebra stripes data rows only, never the cap line', () => {
    assert.ok(!css.includes('\n.code-map__metrics-table tbody tr:nth-child(even) {'), 'no bare-tr zebra');
    assert.match(rule('.code-map__metrics-table tbody tr.code-map__metrics-table-row:nth-child(even)'), /background: var\(--panel-alt\);/);
  });
  it('the visible caption is muted and its top padding clears the divider\'s 6px grab strip', () => {
    const caption = rule('.code-map__metrics-table-caption');
    assert.match(caption, /color: var\(--text-mute\);/);
    assert.match(caption, /padding: calc\(6px \+ 0\.35rem\) /);
    assert.match(rule('.code-map__metrics-divider'), /height: 6px;/);
  });
});

// ---------------------------------------------------------------------------
// P4-3d: real column sorting, the announcement, and the relative bars
// ---------------------------------------------------------------------------

/**
 * Two changed and three affected rows, built so every column has ties and
 * missing values: complexity 5 twice, blast radius 50 twice, two `alpha`s.
 */
const SORTABLE_NODES = [
  node('src/a.ts::alpha', {
    file: 'src/a.ts',
    riskSignals: [det('complexity', 5), det('blast-radius', 10), det('test-coverage-gap', 1), finding('major', 'A')],
  }),
  node('src/b.ts::beta', { file: 'src/b.ts', riskSignals: [det('blast-radius', 3, 'severe')] }),
  node('x::gamma', { file: 'src/x.ts', riskSignals: [det('complexity', 5), finding('minor', 'B'), finding('info', 'C')] }),
  node('x::delta', {
    file: 'src/x.ts',
    riskSignals: [det('complexity', 20, 'severe'), det('blast-radius', 50), det('test-coverage-gap', 1)],
  }),
  node('y::alpha', { file: 'src/y.ts', riskSignals: [det('complexity', 1), det('blast-radius', 50), finding('blocker', 'D')] }),
];
const SORTABLE = buildPrReviewMetricRows(
  SORTABLE_NODES,
  new Set(['src/a.ts::alpha', 'src/b.ts::beta']),
  new Map([
    ['x::gamma', 1],
    ['x::delta', 1],
    ['y::alpha', 2],
  ]),
  2,
);
const idsOf = (rows: readonly PrReviewMetricRow[]) => rows.map((r) => r.id);
/** A rendered row's Node id — its node cell's `title`. */
const rowIdOf = (row: RenderedElement) => cellsOf(row)[0]?.props.title;
const sortBy = (column: PrReviewMetricSortColumn, direction: PrReviewMetricSort['direction']) => ({ column, direction });

describe('sortPrReviewMetricRows', () => {
  const EXPECTED: Record<PrReviewMetricSortColumn, Record<PrReviewMetricSort['direction'], string[]>> = {
    node: {
      // name, then file; id breaks nothing here (names and files differ).
      ascending: ['src/a.ts::alpha', 'y::alpha', 'src/b.ts::beta', 'x::delta', 'x::gamma'],
      descending: ['x::gamma', 'x::delta', 'src/b.ts::beta', 'y::alpha', 'src/a.ts::alpha'],
    },
    hop: {
      // `changed` before 1, 2; ties by id ascending in both directions.
      ascending: ['src/a.ts::alpha', 'src/b.ts::beta', 'x::delta', 'x::gamma', 'y::alpha'],
      descending: ['y::alpha', 'x::delta', 'x::gamma', 'src/a.ts::alpha', 'src/b.ts::beta'],
    },
    complexity: {
      // 5 twice → id; `—` (beta) last in both directions.
      descending: ['x::delta', 'src/a.ts::alpha', 'x::gamma', 'y::alpha', 'src/b.ts::beta'],
      ascending: ['y::alpha', 'src/a.ts::alpha', 'x::gamma', 'x::delta', 'src/b.ts::beta'],
    },
    blastRadius: {
      // 50 twice → id; `—` (gamma) last in both directions.
      descending: ['x::delta', 'y::alpha', 'src/a.ts::alpha', 'src/b.ts::beta', 'x::gamma'],
      ascending: ['src/b.ts::beta', 'src/a.ts::alpha', 'x::delta', 'y::alpha', 'x::gamma'],
    },
    tests: {
      // P4-3f: `gap` < `—` < `covered`; `—` is a value here, so it flips
      // with the direction (no `covered` row in this fixture — see the P4-3f
      // suite). Ties by id ascending in both directions.
      ascending: ['src/a.ts::alpha', 'x::delta', 'src/b.ts::beta', 'x::gamma', 'y::alpha'],
      descending: ['src/b.ts::beta', 'x::gamma', 'y::alpha', 'src/a.ts::alpha', 'x::delta'],
    },
    findings: {
      // count, then the highest finding's severity (blocker over major).
      descending: ['x::gamma', 'y::alpha', 'src/a.ts::alpha', 'src/b.ts::beta', 'x::delta'],
      ascending: ['src/a.ts::alpha', 'y::alpha', 'x::gamma', 'src/b.ts::beta', 'x::delta'],
    },
  };

  for (const { column } of PR_REVIEW_METRIC_COLUMNS) {
    for (const direction of ['ascending', 'descending'] as const) {
      it(`${column} ${direction}`, () => {
        assert.deepEqual(idsOf(sortPrReviewMetricRows(SORTABLE.rows, sortBy(column, direction))), EXPECTED[column][direction]);
      });
    }
  }

  it('equal values break on id ascending, whatever order the rows come in (stable across re-sorts)', () => {
    const reversed = [...SORTABLE.rows].reverse();
    for (const { column } of PR_REVIEW_METRIC_COLUMNS) {
      for (const direction of ['ascending', 'descending'] as const) {
        const sort = sortBy(column, direction);
        const once = sortPrReviewMetricRows(SORTABLE.rows, sort);
        assert.deepEqual(idsOf(sortPrReviewMetricRows(reversed, sort)), idsOf(once), `${column} ${direction}`);
        assert.deepEqual(idsOf(sortPrReviewMetricRows(once, sort)), idsOf(once), `${column} ${direction} re-sorted`);
      }
    }
  });

  it('`—` sorts last in both directions, for every column that can be missing (not tests: P4-3f)', () => {
    for (const column of ['complexity', 'blastRadius', 'findings'] as const) {
      for (const direction of ['ascending', 'descending'] as const) {
        const sorted = sortPrReviewMetricRows(SORTABLE.rows, sortBy(column, direction));
        const missing = (r: PrReviewMetricRow) =>
          column === 'complexity' ? r.complexity === null
          : column === 'blastRadius' ? r.blastRadius === null
          : r.findings === null;
        const firstMissing = sorted.findIndex(missing);
        assert.ok(firstMissing > 0, `${column} ${direction}`);
        assert.ok(sorted.slice(firstMissing).every(missing), `${column} ${direction}: ${idsOf(sorted).join(', ')}`);
      }
    }
  });

  it('the default order: changed first, then hop, blast radius descending, id — the builder\'s own order, restored by null', () => {
    // The builder's affected tuples and the comparator agree on every row.
    const many = buildPrReviewMetricRows(
      [...THREE, ...affectedNodes('b', 30, (i) => (i * 7) % 11), ...affectedNodes('c', 30)],
      new Set(THREE.map((n) => n.id)),
      hops([[affectedNodes('b', 30), 1], [affectedNodes('c', 30), 2]]),
      2,
    );
    assert.deepEqual(idsOf([...many.rows].sort(defaultPrReviewMetricSort)), idsOf(many.rows));
    assert.deepEqual(idsOf(SORTABLE.rows), ['src/a.ts::alpha', 'src/b.ts::beta', 'x::delta', 'x::gamma', 'y::alpha']);
    const shuffled = sortPrReviewMetricRows(SORTABLE.rows, sortBy('findings', 'descending'));
    assert.deepEqual(idsOf(sortPrReviewMetricRows(shuffled, null)), idsOf(SORTABLE.rows));
    assert.deepEqual(idsOf([...shuffled].sort(defaultPrReviewMetricSort)), idsOf(SORTABLE.rows));
  });

  it('sorting reorders every row — changed rows too, keeping their hop — and never pulls in a row past the cap', () => {
    const changed = THREE.map((n) => n.id);
    // 52 affected: the two past the cap have the largest complexity.
    const many = Array.from({ length: 52 }, (_, i) =>
      node(`n-${String(i).padStart(3, '0')}`, {
        riskSignals: [det('blast-radius', 100 - i), det('complexity', i >= 50 ? 999 : i)],
      }),
    );
    const capped = buildPrReviewMetricRows([...THREE, ...many], new Set(changed), hops([[many, 1]]), 1);
    assert.equal(capped.hiddenAffectedCount, 2);
    const sorted = sortPrReviewMetricRows(capped.rows, sortBy('complexity', 'descending'));
    assert.deepEqual(new Set(idsOf(sorted)), new Set(idsOf(capped.rows)));
    assert.ok(!sorted.some((r) => r.id === 'n-050' || r.id === 'n-051'));
    assert.equal(sorted[0]?.id, 'n-049');
    // THREE's `pay` (complexity 42) sits among the affected rows, still changed.
    const pay = sorted.findIndex((r) => r.id === 'src/b.ts::pay');
    assert.ok(pay > 0 && sorted[pay]?.hop === 'changed');
    const rendered = render(capped, 'resolved', sortBy('complexity', 'descending'));
    const bodyRows = byType(rendered, 'tr').filter((tr) => byType(renderTree(tr.props.children), 'td').length > 0);
    assert.equal(bodyRows.at(-1)?.props.className, 'code-map__metrics-cap', 'the cap line stays last');
    assert.equal(textOf(bodyRows.at(-1)), '+2 more affected Nodes — reduce depth');
  });
});

describe('nextPrReviewMetricSort and the announcement', () => {
  it('numeric columns start descending, node, hop and (P4-3f) tests ascending; the active column flips', () => {
    for (const column of ['complexity', 'blastRadius', 'findings'] as const) {
      assert.deepEqual(nextPrReviewMetricSort(null, column), sortBy(column, 'descending'));
      assert.deepEqual(nextPrReviewMetricSort(sortBy(column, 'descending'), column), sortBy(column, 'ascending'));
      assert.deepEqual(nextPrReviewMetricSort(sortBy(column, 'ascending'), column), sortBy(column, 'descending'));
    }
    for (const column of ['node', 'hop', 'tests'] as const) {
      assert.deepEqual(nextPrReviewMetricSort(null, column), sortBy(column, 'ascending'));
      assert.deepEqual(nextPrReviewMetricSort(sortBy(column, 'ascending'), column), sortBy(column, 'descending'));
    }
    // Another column starts at its own first direction, not the current one's.
    assert.deepEqual(nextPrReviewMetricSort(sortBy('complexity', 'ascending'), 'hop'), sortBy('hop', 'ascending'));
    assert.deepEqual(nextPrReviewMetricSort(sortBy('node', 'descending'), 'findings'), sortBy('findings', 'descending'));
  });

  it('says the column and the direction, and nothing for the default order', () => {
    assert.equal(formatMetricSortAnnouncement(sortBy('blastRadius', 'descending')), 'Sorted by blast radius, descending.');
    assert.equal(formatMetricSortAnnouncement(sortBy('complexity', 'descending')), 'Sorted by complexity, descending.');
    assert.equal(formatMetricSortAnnouncement(sortBy('complexity', 'ascending')), 'Sorted by complexity, ascending.');
    assert.equal(formatMetricSortAnnouncement(null), '');
  });
});

describe('PrReviewMetricsTable: sort headers and the live region', () => {
  const headersOf = (els: RenderedElement[]) =>
    renderTree(byType(els, 'thead')[0]?.props.children).filter((e) => e.type === 'th');
  const statusOf = (els: RenderedElement[]) => els.filter((e) => e.props.role === 'status');

  it('every header is a scope="col" th holding one native button', () => {
    const headers = headersOf(render(SORTABLE));
    assert.equal(headers.length, PR_REVIEW_METRIC_COLUMNS.length);
    for (const th of headers) {
      assert.equal(th.props.scope, 'col');
      const buttons = byType(renderTree(th.props.children), 'button');
      assert.equal(buttons.length, 1);
      assert.equal(buttons[0]?.props.type, 'button');
    }
  });

  it('only the active column carries aria-sort; the default order carries none', () => {
    assert.ok(headersOf(render(SORTABLE)).every((th) => th.props['aria-sort'] === undefined));
    for (const direction of ['ascending', 'descending'] as const) {
      const headers = headersOf(render(SORTABLE, 'idle', sortBy('complexity', direction)));
      assert.deepEqual(
        headers.map((th) => th.props['aria-sort']),
        [undefined, undefined, direction, undefined, undefined, undefined],
      );
      assert.ok(!('aria-sort' in headers[0]!.props) || headers[0]!.props['aria-sort'] === undefined);
    }
  });

  it('activating a header hands the next sort to onSort: descending, then ascending', () => {
    const sorts: PrReviewMetricSort[] = [];
    const click = (sort: PrReviewMetricSort | null, index: number) => {
      const th = headersOf(render(SORTABLE, 'idle', sort, (next) => sorts.push(next)))[index]!;
      (byType(renderTree(th.props.children), 'button')[0]!.props.onClick as () => void)();
    };
    click(null, 2);
    click(sorts[0]!, 2);
    click(null, 0);
    assert.deepEqual(sorts, [sortBy('complexity', 'descending'), sortBy('complexity', 'ascending'), sortBy('node', 'ascending')]);
  });

  it('renders rows in the sorted order, with the changed rule still on changed rows', () => {
    const rows = rowsOf(render(SORTABLE, 'idle', sortBy('complexity', 'descending')));
    assert.deepEqual(
      rows.map(rowIdOf),
      ['x::delta', 'src/a.ts::alpha', 'x::gamma', 'y::alpha', 'src/b.ts::beta'],
    );
    assert.deepEqual(
      rows.map((r) => String(r.props.className).includes('--changed')),
      [false, true, false, false, true],
    );
  });

  it('the visually hidden status region is always mounted and follows the sort and its direction', () => {
    const [idle, ...more] = statusOf(render(SORTABLE));
    assert.equal(more.length, 0);
    assert.equal(idle?.props.className, 'visually-hidden');
    assert.equal(textOf(idle), '');
    assert.equal(textOf(statusOf(render(SORTABLE, 'idle', sortBy('complexity', 'descending')))[0]), 'Sorted by complexity, descending.');
    assert.equal(textOf(statusOf(render(SORTABLE, 'idle', sortBy('complexity', 'ascending')))[0]), 'Sorted by complexity, ascending.');
    assert.equal(textOf(statusOf(render(SORTABLE, 'idle', sortBy('blastRadius', 'descending')))[0]), 'Sorted by blast radius, descending.');
  });

  it('the bar columns say the bar is relative, hidden and as a title; the others carry no note', () => {
    const headers = headersOf(render(SORTABLE));
    PR_REVIEW_METRIC_COLUMNS.forEach(({ column, bar }, i) => {
      const button = byType(renderTree(headers[i]!.props.children), 'button')[0]!;
      const note = renderTree(button.props.children).find((e) => e.props.className === 'visually-hidden');
      assert.equal(bar, column === 'complexity' || column === 'blastRadius', column);
      assert.equal(button.props.title, bar ? METRIC_BAR_HEADER_NOTE : undefined, column);
      assert.equal(note === undefined ? null : textOf(note), bar ? ` ${METRIC_BAR_HEADER_NOTE}` : null, column);
    });
    assert.equal(METRIC_BAR_HEADER_NOTE, "(bar: relative to this table's max)");
  });

  it('the active header shows a direction arrow, hidden from assistive tech (aria-sort says it)', () => {
    const headers = headersOf(render(SORTABLE, 'idle', sortBy('hop', 'ascending')));
    const arrows = headers.map((th) =>
      renderTree(th.props.children).find((e) => e.props.className === 'code-map__metrics-sort-indicator'),
    );
    assert.equal(textOf(arrows[1]), '↑');
    assert.equal(arrows[1]?.props['aria-hidden'], 'true');
    assert.ok(arrows.filter((a, i) => i !== 1).every((a) => a === undefined));
    const down = headersOf(render(SORTABLE, 'idle', sortBy('hop', 'descending')))[1]!;
    assert.equal(textOf(renderTree(down.props.children).find((e) => e.props.className === 'code-map__metrics-sort-indicator')), '↓');
  });
});

describe('the relative bars', () => {
  const barsIn = (cell: RenderedElement) =>
    renderTree(cell.props.children).filter((e) => String(e.props.className ?? '').startsWith('code-map__metrics-bar'));
  const rowById = (els: RenderedElement[], id: string) => rowsOf(els).find((r) => rowIdOf(r) === id)!;

  it('metricBarWidths: each bar column\'s max over the rows given; 0 without values', () => {
    assert.deepEqual(metricBarWidths(SORTABLE.rows), { complexity: 20, blastRadius: 50 });
    assert.deepEqual(metricBarWidths([]), { complexity: 0, blastRadius: 0 });
  });

  it('metricBar: width relative to the column max; no bar for a missing signal or a 0 max', () => {
    assert.deepEqual(metricBar(det('complexity', 5), 20), { width: '25%', severe: false });
    assert.deepEqual(metricBar(det('complexity', 20, 'severe'), 20), { width: '100%', severe: true });
    assert.deepEqual(metricBar(det('complexity', 1), 3), { width: '33.33%', severe: false });
    assert.equal(metricBar(null, 20), null);
    assert.equal(metricBar(det('complexity', 0), 0), null);
  });

  it('colour comes from severity only: a small severe value is red, a large moderate one neutral', () => {
    assert.equal(metricBar(det('blast-radius', 1, 'severe'), 1000)?.severe, true);
    assert.equal(metricBar(det('blast-radius', 1000), 1000)?.severe, false);
    const els = render(
      buildPrReviewMetricRows(
        [node('small', { riskSignals: [det('blast-radius', 1, 'severe')] }), node('big', { riskSignals: [det('blast-radius', 1000)] })],
        new Set(['small', 'big']),
        null,
        0,
      ),
    );
    const fill = (id: string) => barsIn(cellsOf(rowById(els, id))[3]!).find((e) => e.type === 'span' && !String(e.props.className).includes('track'));
    assert.equal(fill('small')?.props.className, 'code-map__metrics-bar code-map__metrics-bar--severe');
    assert.deepEqual(fill('small')?.props.style, { width: '0.1%' });
    assert.equal(fill('big')?.props.className, 'code-map__metrics-bar');
    assert.deepEqual(fill('big')?.props.style, { width: '100%' });
  });

  it('a severe bar keeps its text value, the ! glyph and "(severe)"; the bar is aria-hidden', () => {
    const els = render(SORTABLE);
    const delta = cellsOf(rowById(els, 'x::delta'))[2]!;
    const [track, fill] = barsIn(delta);
    assert.equal(track?.props.className, 'code-map__metrics-bar-track');
    assert.equal(track?.props['aria-hidden'], 'true');
    assert.equal(fill?.props.className, 'code-map__metrics-bar code-map__metrics-bar--severe');
    assert.equal(textOf(delta), `${SEVERE_SIGNAL_GLYPH} 20`);
    assert.ok(renderTree(delta.props.children).some((e) => e.props['aria-label'] === '20 (severe)'));
  });

  it('bars only on complexity and blast radius; a missing value has none', () => {
    const els = render(SORTABLE);
    const alpha = cellsOf(rowById(els, 'src/a.ts::alpha'));
    assert.deepEqual(alpha.map((c) => barsIn(c).length), [0, 0, 2, 2, 0, 0]);
    const beta = cellsOf(rowById(els, 'src/b.ts::beta'));
    assert.deepEqual(beta.map((c) => barsIn(c).length), [0, 0, 0, 2, 0, 0]);
  });

  it('every complexity value 0: no bars, and the values still show 0', () => {
    const els = render(
      buildPrReviewMetricRows(
        [node('p', { riskSignals: [det('complexity', 0)] }), node('q', { riskSignals: [det('complexity', 0)] })],
        new Set(['p', 'q']),
        null,
        0,
      ),
    );
    for (const row of rowsOf(els)) {
      const complexity = cellsOf(row)[2]!;
      assert.equal(barsIn(complexity).length, 0);
      assert.equal(textOf(complexity), '0');
    }
  });

  it('the max is over the rendered rows only — a larger value past the affected cap never shrinks the bars', () => {
    const many = Array.from({ length: 52 }, (_, i) =>
      node(`n-${String(i).padStart(3, '0')}`, {
        riskSignals: [det('blast-radius', 100 - i), det('complexity', i >= 50 ? 999 : i)],
      }),
    );
    const capped = buildPrReviewMetricRows(many, new Set(), hops([[many, 1]]), 1);
    assert.equal(metricBarWidths(capped.rows).complexity, 49);
    const els = render(capped);
    const fill = barsIn(cellsOf(rowById(els, 'n-049'))[2]!)[1];
    assert.deepEqual(fill?.props.style, { width: '100%' });
  });
});

describe('styles.css: the sort buttons and the bars', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  const rule = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('\n}', start));
  };
  it('the bar track is --border, the fill neutral --text-dim, severe --risk-red — no green, no amber', () => {
    assert.match(rule('.code-map__metrics-bar-track'), /background: var\(--border\);/);
    assert.match(rule('.code-map__metrics-bar'), /background: var\(--text-dim\);/);
    assert.match(rule('.code-map__metrics-bar--severe'), /background: var\(--risk-red\);/);
    for (const selector of ['.code-map__metrics-bar-track', '.code-map__metrics-bar', '.code-map__metrics-bar--severe']) {
      assert.doesNotMatch(rule(selector), /healthy|amber|radius/, selector);
    }
  });
  it('the header button takes the toolbar buttons\' focus-visible ring', () => {
    const toolbar = rule('.code-map__pr-review-toolbar button:focus-visible');
    assert.equal(rule('.code-map__metrics-sort:focus-visible').split('{')[1], toolbar.split('{')[1]);
  });
});

// ---------------------------------------------------------------------------
// P4-3d review round 1
// ---------------------------------------------------------------------------

describe('P4-3d review: node collation', () => {
  it('sorts names case-insensitively, punctuation first; code-unit order breaks a case-only tie', () => {
    const table = buildPrReviewMetricRows(
      [node('m::Zeta'), node('m::alpha'), node('m::_private'), node('n::Alpha')],
      new Set(['m::Zeta', 'm::alpha', 'm::_private', 'n::Alpha']),
      null,
      0,
    );
    assert.deepEqual(
      sortPrReviewMetricRows(table.rows, sortBy('node', 'ascending')).map((r) => r.name),
      ['_private', 'Alpha', 'alpha', 'Zeta'],
    );
    assert.deepEqual(
      sortPrReviewMetricRows(table.rows, sortBy('node', 'descending')).map((r) => r.name),
      ['Zeta', 'alpha', 'Alpha', '_private'],
    );
  });
});

describe('P4-3d review: the sorted-within-cap note', () => {
  const changed = THREE.map((n) => n.id);
  const many = affectedNodes('n', 52);
  const capped = buildPrReviewMetricRows([...THREE, ...many], new Set(changed), hops([[many, 1]]), 1);
  const notes = (els: RenderedElement[]) =>
    byType(els, 'tr').filter((tr) => tr.props.className === 'code-map__metrics-sort-note');

  it('formats the rows shown and the Nodes past the cap; null in the default order or without a cap', () => {
    assert.equal(
      formatSortedWithinCapNote(sortBy('complexity', 'descending'), 53, 2),
      'Sorted within the 53 rows shown — 2 more affected Nodes are past the cap; reduce depth to include them.',
    );
    assert.equal(
      formatSortedWithinCapNote(sortBy('node', 'ascending'), 51, 1),
      'Sorted within the 51 rows shown — 1 more affected Node is past the cap; reduce depth to include them.',
    );
    assert.equal(formatSortedWithinCapNote(null, 53, 2), null);
    assert.equal(formatSortedWithinCapNote(sortBy('hop', 'ascending'), 53, 0), null);
  });

  it('shows only for a user sort on a capped table, inert, in its own tbody above the rows', () => {
    const els = render(capped, 'resolved', sortBy('complexity', 'descending'));
    const [note, ...rest] = notes(els);
    assert.ok(note);
    assert.equal(rest.length, 0);
    assert.equal(textOf(note), formatSortedWithinCapNote(sortBy('complexity', 'descending'), 53, 2));
    const bodies = byType(els, 'tbody');
    assert.equal(bodies.length, 2);
    assert.equal(renderTree(bodies[0]!.props.children).filter((e) => e.type === 'tr').length, 1, 'the note alone');
    const cells = byType(renderTree(note.props.children), 'td');
    assert.equal(cells[0]?.props.colSpan, PR_REVIEW_METRIC_COLUMNS.length);
    for (const element of [note, ...renderTree(note.props.children)]) {
      assert.equal(element.props.onClick, undefined);
      assert.equal(element.props.tabIndex, undefined);
    }
    // The announcement, the caption and the cap line are unchanged.
    assert.equal(textOf(els.find((e) => e.props.role === 'status')), 'Sorted by complexity, descending.');
    assert.equal(textOf(byType(els, 'caption')[0]), "Changed and affected Nodes' risk metrics");
    assert.equal(textOf(byType(els, 'tr').find((tr) => tr.props.className === 'code-map__metrics-cap')), '+2 more affected Nodes — reduce depth');
    // Default order on a capped table, or a sort with nothing past the cap: no note.
    assert.equal(notes(render(capped, 'resolved', null)).length, 0);
    assert.equal(notes(render({ ...capped, hiddenAffectedCount: 0 }, 'resolved', sortBy('complexity', 'descending'))).length, 0);
    assert.equal(byType(render(capped, 'resolved', null), 'tbody').length, 1);
  });

  it('is muted, like the cap line', () => {
    const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
    const start = css.indexOf('\n.code-map__metrics-sort-note {');
    assert.ok(start >= 0);
    assert.match(css.slice(start, css.indexOf('\n}', start)), /color: var\(--text-mute\);/);
  });
});

describe('P4-3d review: an active sort persists across a depth step', () => {
  const changed = THREE.map((n) => n.id);
  const near = affectedNodes('near', 3, (i) => i + 1);
  const far = [node('far', { riskSignals: [det('complexity', 500), det('blast-radius', 1)] })];
  const distances = hops([
    [near, 1],
    [far, 2],
  ]);
  const sort = sortBy('complexity', 'descending');

  it('the same sort applies to the rows at the new depth', () => {
    const atOne = rowsOf(render(buildPrReviewMetricRows([...THREE, ...near, ...far], new Set(changed), distances, 1), 'resolved', sort));
    const atTwo = rowsOf(render(buildPrReviewMetricRows([...THREE, ...near, ...far], new Set(changed), distances, 2), 'resolved', sort));
    assert.equal(atTwo.length, atOne.length + 1);
    assert.equal(rowIdOf(atTwo[0]!), 'far', 'the new row lands where the sort puts it, not at the end');
    assert.equal(rowIdOf(atOne[0]!), 'src/b.ts::pay');
  });
});

// ---------------------------------------------------------------------------
// P4-3e: row activation — a row opens Node detail
// ---------------------------------------------------------------------------

/** Anything a user could activate or tab to: a native control, an interactive role, a focus stop or a handler. */
function isActivatable(element: RenderedElement): boolean {
  const { props } = element;
  if (typeof element.type === 'string' && ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(element.type)) {
    return true;
  }
  if (typeof props.role === 'string' && ['button', 'link', 'row', 'gridcell'].includes(props.role)) {
    return true;
  }
  if (props.href !== undefined || props.tabIndex !== undefined) {
    return true;
  }
  return ['onClick', 'onKeyDown', 'onKeyUp', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp'].some(
    (handler) => typeof props[handler] === 'function',
  );
}

const rowButtonsOf = (row: RenderedElement) =>
  renderTree(row.props.children).filter((e) => e.type === 'button');

/** A fake row button for the click delegate: records focus calls; `inside` are the targets it contains. */
function fakeButton(inside: readonly unknown[] = []): MetricsRowButtonTarget & { focused: unknown[] } {
  const focused: unknown[] = [];
  return {
    focused,
    focus: (options?: FocusOptions) => {
      focused.push(options);
    },
    contains: (other) => inside.includes(other),
  };
}

/**
 * Clicks a rendered `<tr>` as if on `target`, with `button` as its row button
 * and the document selection collapsed or not (`window` stubbed: no DOM here).
 */
function clickRow(row: RenderedElement, button: MetricsRowButtonTarget | null, target: unknown, textSelected = false): void {
  const onClick = row.props.onClick as (event: unknown) => void;
  assert.equal(typeof onClick, 'function', 'the row carries the click delegate');
  const global = globalThis as unknown as { window?: unknown };
  const had = 'window' in global;
  const previous = global.window;
  global.window = { getSelection: () => ({ isCollapsed: !textSelected }) };
  try {
    onClick({ target, currentTarget: { querySelector: (selector: string) => (selector === `.${METRICS_ROW_BUTTON_CLASS}` ? button : null) } });
  } finally {
    if (had) {
      global.window = previous;
    } else {
      delete global.window;
    }
  }
}

describe('PrReviewMetricsTable: row activation (P4-3e)', () => {
  const table = buildPrReviewMetricRows(THREE, new Set(THREE.map((n) => n.id)), null, 0);

  it('each row has exactly one control: a native button in its node cell; the row is no tab stop', () => {
    const rows = rowsOf(render(table));
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const buttons = rowButtonsOf(row);
      assert.equal(buttons.length, 1, 'one button per row');
      const button = buttons[0]!;
      assert.equal(button.props.type, 'button');
      assert.equal(button.props.className, METRICS_ROW_BUTTON_CLASS);
      assert.equal(button.props.tabIndex, undefined);
      const nodeCell = cellsOf(row)[0]!;
      assert.equal(nodeCell.type, 'th');
      assert.ok(renderTree(nodeCell.props.children).includes(button), 'the button sits in the node cell');
      // Inside the row, the button is the only activatable element.
      assert.deepEqual(renderTree(row.props.children).filter(isActivatable), [button]);
      // The row itself: a click delegate only — no role, no tab stop, no key handler.
      assert.equal(row.props.tabIndex, undefined);
      assert.equal(row.props.role, undefined);
      assert.equal(row.props.onKeyDown, undefined);
    }
  });

  it("the button's name is the node cell's content, then the reused HEALTH_ROW_AFFORDANCE, with no aria-label", () => {
    assert.equal(HEALTH_ROW_AFFORDANCE, 'open Node detail');
    for (const row of rowsOf(render(table))) {
      const button = rowButtonsOf(row)[0]!;
      assert.equal(button.props['aria-label'], undefined);
      const name = textOf(button);
      assert.ok(name.endsWith(`, ${HEALTH_ROW_AFFORDANCE}`), name);
      assert.equal(name, textOf(cellsOf(row)[0]), 'the whole node cell is the button');
    }
    const refund = rowButtonsOf(rowsOf(render(table))[0]!)[0]!;
    assert.equal(textOf(refund), `refundsrc/billing/, src/billing/b.ts line 5⚠, ${HEALTH_ROW_AFFORDANCE}`);
  });

  it('Enter/Space/click on the button hands over that row\'s own Node object, and nothing else runs', () => {
    const opened: CodeMapNode[] = [];
    const sorts: PrReviewMetricSort[] = [];
    const rows = rowsOf(render(table, 'idle', null, (s) => sorts.push(s), (n) => opened.push(n)));
    for (const row of rows) {
      (rowButtonsOf(row)[0]!.props.onClick as () => void)();
    }
    const byId = new Map(THREE.map((n) => [n.id, n]));
    assert.equal(opened.length, 3);
    rows.forEach((row, i) => assert.equal(opened[i], byId.get(rowIdOf(row) as string), 'the same object, not a copy'));
    assert.deepEqual(sorts, [], 'activation never touches the sort');
  });

  it('two same-named Nodes each open their own Node', () => {
    const a = node('a::handle', { name: 'handle', startLine: 3 });
    const b = node('b::handle', { name: 'handle', startLine: 30 });
    const opened: CodeMapNode[] = [];
    const rows = rowsOf(render(buildPrReviewMetricRows([a, b], new Set([a.id, b.id]), null, 0), 'idle', null, () => {}, (n) => opened.push(n)));
    for (const row of rows) {
      (rowButtonsOf(row)[0]!.props.onClick as () => void)();
    }
    assert.equal(opened.length, 2);
    assert.equal(opened[0], a);
    assert.equal(opened[1], b);
    // …and by the row click delegate too.
    opened.length = 0;
    clickRow(rows[1]!, fakeButton(), { cell: 'findings' });
    assert.deepEqual(opened, [b]);
    assert.equal(opened[0], b);
  });

  it('a click on another cell focuses the row button first (the modal layer\'s opener), then opens its Node once', () => {
    const opened: CodeMapNode[] = [];
    const row = rowsOf(render(table, 'idle', null, () => {}, (n) => opened.push(n)))[1]!;
    const button = fakeButton();
    clickRow(row, button, { cell: 'findings' });
    assert.deepEqual(button.focused, [{ preventScroll: true }]);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], THREE[0], 'pay');
  });

  it("a click on the button itself is left to the button's own handler — bubbling never opens twice", () => {
    const opened: CodeMapNode[] = [];
    const row = rowsOf(render(table, 'idle', null, () => {}, (n) => opened.push(n)))[1]!;
    const nameInsideButton = { part: 'the <code> name' };
    const button = fakeButton([nameInsideButton]);
    // The browser runs the button's onClick, then the bubbled row onClick.
    (rowButtonsOf(row)[0]!.props.onClick as () => void)();
    clickRow(row, button, nameInsideButton);
    assert.equal(opened.length, 1);
    assert.deepEqual(button.focused, []);
  });

  it('activateMetricsRowFromCell: with no button found, it still opens the Node', () => {
    const opened: CodeMapNode[] = [];
    activateMetricsRowFromCell(null, null, false, THREE[1]!, (n) => opened.push(n));
    assert.deepEqual(opened, [THREE[1]]);
  });

  it('selecting a cell\'s text (drag or double-click) never opens Node detail, nor moves focus', () => {
    const opened: CodeMapNode[] = [];
    const row = rowsOf(render(table, 'idle', null, () => {}, (n) => opened.push(n)))[1]!;
    const button = fakeButton();
    clickRow(row, button, { cell: 'complexity' }, true);
    assert.equal(opened.length, 0);
    assert.equal(button.focused.length, 0);
    activateMetricsRowFromCell(button, null, true, THREE[0]!, (n) => opened.push(n));
    assert.equal(opened.length, 0);
    // A collapsed selection (a plain click) still opens it.
    clickRow(row, button, { cell: 'complexity' }, false);
    assert.equal(opened.length, 1);
  });

  it('the cap line, the sorted-within-cap note, the off-map lines and the caption never activate', () => {
    const capped: PrReviewMetricRows = { ...table, hiddenAffectedCount: 4, missingChangedCount: 1, missingAffectedCount: 2 };
    const elements = render(capped, 'loading', sortBy('complexity', 'descending'));
    const cap = elements.find((e) => e.props.className === 'code-map__metrics-cap');
    const note = elements.find((e) => e.props.className === 'code-map__metrics-sort-note');
    const missing = elements.filter((e) => String(e.props.className ?? '').includes('code-map__metrics-table-missing'));
    const caption = byType(elements, 'caption');
    assert.ok(cap && note);
    assert.equal(missing.length, 2);
    assert.equal(caption.length, 1);
    for (const inert of [cap, note, ...missing, ...caption]) {
      assert.deepEqual([inert, ...renderTree(inert.props.children)].filter(isActivatable), [], String(inert.props.className));
    }
    // Everything activatable in the table: the region, the six sort buttons, and one row + one button per data row.
    const activatable = elements.filter(isActivatable);
    const rows = rowsOf(elements);
    assert.equal(activatable.length, 1 + 6 + rows.length * 2);
  });

  it('rows are keyed by Node id, so a re-sort or depth step keeps each row (and its button) for focus return', () => {
    const keysOf = (elements: RenderedElement[]) =>
      rowsOf(elements).map((row) => (row as unknown as { key: string | null }).key);
    const unsorted = keysOf(render(table));
    const sorted = keysOf(render(table, 'idle', sortBy('node', 'ascending')));
    assert.deepEqual(unsorted, rowsOf(render(table)).map(rowIdOf));
    assert.deepEqual(new Set(sorted), new Set(unsorted));
    assert.notDeepEqual(sorted, unsorted, 'the sort really reorders');
  });
});

describe('styles.css: row activation (P4-3e)', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };

  it('the row button reads as the cell text, with a pointer', () => {
    const rule = block('.code-map__metrics-row-button');
    for (const decl of ['border: none;', 'background: transparent;', 'font: inherit;', 'color: inherit;', 'cursor: pointer;']) {
      assert.ok(rule.includes(decl), decl);
    }
  });

  it("hover follows the Health Audit row's accent 15% fill, on the cells, over the zebra", () => {
    const rule = block('.code-map__metrics-table tbody tr.code-map__metrics-table-row:hover > *');
    assert.match(rule, /background: color-mix\(in srgb, var\(--accent\) 15%, transparent\);/);
    assert.match(block('.code-map__health-row-button:hover'), /color-mix\(in srgb, var\(--accent\) 15%, transparent\)/);
  });

  it('focus draws the focus ring inset around the row on its cells (no tr outline), keeping the changed rule', () => {
    const focused = '.code-map__metrics-table tbody tr.code-map__metrics-table-row:has(.code-map__metrics-row-button:focus-visible)';
    const shadows = (rule: string) => (rule.match(/inset [^,;]+/g) ?? []).map((x) => x.trim()).sort();
    const top = 'inset 0 2px 0 var(--accent)';
    const bottom = 'inset 0 -2px 0 var(--accent)';
    const changedRule = 'inset 2px 0 0 var(--accent)';
    assert.deepEqual(shadows(block(`${focused} > *`)), [top, bottom].sort());
    assert.deepEqual(shadows(block(`${focused} > :first-child`)), [changedRule, top, bottom].sort());
    assert.deepEqual(shadows(block(`${focused} > :last-child`)), ['inset -2px 0 0 var(--accent)', top, bottom].sort());
    for (const cell of ['> *', '> :first-child', '> :last-child']) {
      assert.ok(!/background|outline/.test(block(`${focused} ${cell}`)), 'backgrounds untouched; no outline');
    }
    assert.ok(!css.includes(`${focused} {`), 'no outline on the tr itself');
    // The changed rule is the first cell's left shadow, in both states.
    assert.match(block('.code-map__metrics-table-row--changed > :first-child'), /box-shadow: inset 2px 0 0 var\(--accent\);/);
  });

  it('the scroll region pads its top, so a focused row clears the sticky header', () => {
    assert.match(block('.code-map__metrics-table'), /scroll-padding-top: 2rem;/);
  });
});

// ---------------------------------------------------------------------------
// P4-3f: honest coverage — `covered` only with the LCOV flag
// ---------------------------------------------------------------------------

describe('the tests column: gap, covered, — (P4-3f)', () => {
  /**
   * Every combination of the gap signal, the file flag and (review round 1)
   * the per-Node hit proof, including malformed values the main process
   * would strip.
   */
  const COMBOS = [
    { id: 'c::gapFlagHit', gap: true, flag: true, hit: true, expected: 'gap' },
    { id: 'c::gapFlag', gap: true, flag: true, hit: undefined, expected: 'gap' },
    { id: 'c::gapNoFlag', gap: true, flag: undefined, hit: undefined, expected: 'gap' },
    { id: 'c::hit', gap: false, flag: true, hit: true, expected: 'covered' },
    { id: 'c::loaded', gap: false, flag: true, hit: undefined, expected: 'unproven' },
    { id: 'c::hitNoFlag', gap: false, flag: undefined, hit: true, expected: 'none' },
    { id: 'c::none', gap: false, flag: undefined, hit: undefined, expected: 'none' },
    { id: 'c::bogus', gap: false, flag: 'yes', hit: 'yes', expected: 'none' },
    { id: 'c::false', gap: false, flag: true, hit: false, expected: 'unproven' },
  ] as const;
  const comboNodes = COMBOS.map(({ id, gap, flag, hit }) =>
    node(id, {
      riskSignals: gap ? [det('test-coverage-gap', 1)] : [],
      ...(flag === undefined ? {} : { testCoverageAvailable: flag as unknown as true }),
      ...(hit === undefined ? {} : { testCoverageHit: hit as unknown as true }),
    }),
  );
  const table = buildPrReviewMetricRows(comboNodes, new Set(COMBOS.map((c) => c.id)), null, 0);
  const byId = new Map(table.rows.map((row) => [row.id, row]));

  it('metricTestsState: gap first; covered only with both flags exactly true; else unproven or none', () => {
    for (const { id, expected } of COMBOS) {
      assert.equal(metricTestsState(byId.get(id)!), expected, id);
    }
    for (const gap of [true, false]) {
      for (const available of [true, false]) {
        for (const hit of [true, false]) {
          const state = metricTestsState({ testCoverageGap: gap, testCoverageAvailable: available, testCoverageHit: hit });
          const expected = gap ? 'gap' : !available ? 'none' : hit ? 'covered' : 'unproven';
          assert.equal(state, expected, JSON.stringify({ gap, available, hit }));
        }
      }
    }
  });

  it('the row reads both flags strictly: only `true` counts', () => {
    assert.equal(byId.get('c::hit')?.testCoverageAvailable, true);
    assert.equal(byId.get('c::hit')?.testCoverageHit, true);
    assert.equal(byId.get('c::none')?.testCoverageAvailable, false);
    assert.equal(byId.get('c::bogus')?.testCoverageAvailable, false);
    assert.equal(byId.get('c::bogus')?.testCoverageHit, false);
    assert.equal(byId.get('c::false')?.testCoverageHit, false);
  });

  it('formatMetricTestsCell: covered names exactly what is proven; each — says why', () => {
    assert.deepEqual(formatMetricTestsCell('gap'), { text: 'gap', label: null, title: null, empty: false });
    assert.deepEqual(formatMetricTestsCell('covered'), {
      text: 'covered',
      label: METRIC_TESTS_COVERED_LABEL,
      title: METRIC_TESTS_COVERED_LABEL,
      empty: false,
    });
    assert.equal(METRIC_TESTS_COVERED_LABEL, 'Test coverage: function entered at least once by tests (LCOV)');
    assert.deepEqual(formatMetricTestsCell('unproven'), {
      text: METRIC_CELL_EMPTY,
      label: null,
      title: METRIC_TESTS_UNPROVEN_TITLE,
      empty: true,
    });
    assert.equal(METRIC_TESTS_UNPROVEN_TITLE, 'No function-level coverage proof for this Node (LCOV)');
    assert.deepEqual(formatMetricTestsCell('none'), {
      text: METRIC_CELL_EMPTY,
      label: null,
      title: METRIC_TESTS_NO_DATA_TITLE,
      empty: true,
    });
    assert.equal(METRIC_TESTS_NO_DATA_TITLE, 'No LCOV data for this file');
  });

  it('renders each combination: covered only on the proven, gap-free row; never a percentage', () => {
    const elements = render(table);
    const TITLES = { none: METRIC_TESTS_NO_DATA_TITLE, unproven: METRIC_TESTS_UNPROVEN_TITLE } as Record<string, string>;
    for (const row of rowsOf(elements)) {
      const id = String(cellsOf(row)[0]?.props.title);
      const testsCell = cellsOf(row)[4]!;
      const expected = COMBOS.find((c) => c.id === id)!.expected;
      const empty = expected === 'none' || expected === 'unproven';
      assert.equal(textOf(testsCell), empty ? METRIC_CELL_EMPTY : expected, id);
      const named = renderTree(testsCell.props.children).find((e) => e.props.role === 'img');
      if (expected === 'covered') {
        assert.equal(named?.props['aria-label'], METRIC_TESTS_COVERED_LABEL, id);
        assert.equal(testsCell.props.className, 'code-map__metrics-table-cell');
      } else {
        assert.equal(named, undefined, id);
      }
      if (empty) {
        assert.equal(testsCell.props.title, TITLES[expected], id);
        assert.match(String(testsCell.props.className), /code-map__metrics-table-cell--empty/);
      } else {
        assert.equal(testsCell.props.title, undefined, id);
      }
    }
    const allText = textOf(PrReviewMetricsTable({ ...NO_CONTRACT_PROPS, ...table, blastRadiusStatus: 'idle', sort: null, onSort: () => {}, onActivateNode: () => {} }));
    assert.equal(allText.split('covered').length - 1, 1, 'exactly one covered cell');
    assert.ok(!allText.includes('%'), allText);
  });

  it('no LCOV at all (no Node flagged): no cell says covered', () => {
    const plain = buildPrReviewMetricRows(
      comboNodes.map(({ testCoverageAvailable: _flag, testCoverageHit: _hit, ...rest }) => rest),
      new Set(COMBOS.map((c) => c.id)),
      null,
      0,
    );
    const text = textOf(PrReviewMetricsTable({ ...NO_CONTRACT_PROPS, ...plain, blastRadiusStatus: 'idle', sort: null, onSort: () => {}, onActivateNode: () => {} }));
    assert.ok(!text.toLowerCase().includes('covered'), text);
  });

  it('sorts gap < — (either kind) < covered: ascending leads with gaps, descending with covered; ties by id', () => {
    const gaps = ['c::gapFlag', 'c::gapFlagHit', 'c::gapNoFlag'];
    const dashes = ['c::bogus', 'c::false', 'c::hitNoFlag', 'c::loaded', 'c::none'];
    assert.deepEqual(idsOf(sortPrReviewMetricRows(table.rows, sortBy('tests', 'ascending'))), [...gaps, ...dashes, 'c::hit']);
    assert.deepEqual(idsOf(sortPrReviewMetricRows(table.rows, sortBy('tests', 'descending'))), ['c::hit', ...dashes, ...gaps]);
    // A first click on the header leads with the gaps, as before P4-3f.
    assert.deepEqual(nextPrReviewMetricSort(null, 'tests'), sortBy('tests', 'ascending'));
  });
});

// ---------------------------------------------------------------------------
// P4-3g: a pinned summary row per changed contract
// ---------------------------------------------------------------------------

/** P4-3g: a resolved scope that also carries changed contracts. */
const resolvedWith = (nodeIds: string[], contracts: ChangedContract[], approximate = false): DiffScopeState => ({
  status: 'resolved',
  resolvedBaseRef: 'abc123',
  nodeIds: new Set(nodeIds),
  topLevelFiles: [],
  changedContracts: contracts,
  changedContractsApproximate: approximate,
});

/** 59 dependents, but only 3 ids carried — as when `dependentIds` hits its cap. */
const CODE_MAP_NODE = contractFixture('CodeMapNode', ['src/a.ts::load', 'src/b.ts::pay', 'src/b.ts::refund'], 59);
const RESULT_TYPE = contractFixture('Result', ['src/a.ts::load'], 1, 'Type');

function renderWithContracts(
  table: PrReviewMetricRows,
  contracts: readonly ChangedContract[],
  {
    approximate = false,
    sort = null,
    onOpenType = () => {},
  }: { approximate?: boolean; sort?: PrReviewMetricSort | null; onOpenType?: (id: string) => void } = {},
): RenderedElement[] {
  return renderTree(
    PrReviewMetricsTable({
      ...table,
      blastRadiusStatus: 'idle',
      changedContracts: contracts,
      changedContractsApproximate: approximate,
      sort,
      onSort: () => {},
      onActivateNode: () => {},
      onOpenType,
    }),
  );
}

const contractRowsOf = (elements: RenderedElement[]) =>
  byType(elements, 'tr').filter((tr) => tr.props.className === 'code-map__metrics-contract');

/** Every body row in document order, as a kind: changed / affected Node row, contract row, or an inert line. */
function bodyRowKinds(elements: RenderedElement[]): string[] {
  const kinds: string[] = [];
  for (const body of byType(elements, 'tbody')) {
    for (const tr of renderTree(body.props.children).filter((e) => e.type === 'tr')) {
      const cls = String(tr.props.className ?? '');
      if (cls === 'code-map__metrics-contract') {
        kinds.push(`contract:${String(cellsOf(tr)[0]?.props.title)}`);
      } else if (cls.includes('code-map__metrics-table-row--changed')) {
        kinds.push('changed');
      } else if (cls.includes('code-map__metrics-table-row')) {
        kinds.push('affected');
      } else {
        kinds.push(cls);
      }
    }
  }
  return kinds;
}

describe('P4-3g: the table gate opens for changed rows OR changed contracts', () => {
  const map = ready([unchanged, ...THREE]);

  it('a contract-only diff (0 changed Nodes) shows a table of contract rows only', () => {
    const view = resolvePrReviewView('prReview', map, resolvedWith([], [CODE_MAP_NODE]), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS);
    assert.notEqual(view.metricsTable, null);
    assert.equal(view.metricsTable?.rows.length, 0);
    assert.deepEqual(view.metricsTable?.changedContracts, [CODE_MAP_NODE]);
    assert.equal(view.metricsTable?.changedContractsApproximate, false);
    assert.equal(prReviewMetricsTableFor(view), view.metricsTable);
    const rows = bodyRowKinds(renderWithContracts(view.metricsTable!, view.metricsTable!.changedContracts));
    assert.deepEqual(rows, [`contract:${CODE_MAP_NODE.id}`]);
  });

  it('neither changed rows nor contracts: no table (never an empty one)', () => {
    assert.equal(resolvePrReviewView('prReview', map, resolvedWith([], []), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
    assert.equal(resolvePrReviewView('prReview', map, resolvedWith([], [], true), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null, 'the approximate flag alone opens nothing');
    assert.equal(resolvePrReviewView('prReview', map, resolvedWith(['gone::x'], []), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
  });

  it('off-map changed ids plus a contract: the table, with its off-map line', () => {
    const table = resolvePrReviewView('prReview', map, resolvedWith(['gone::x'], [CODE_MAP_NODE]), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable;
    assert.deepEqual([table?.rows.length, table?.missingChangedCount, table?.changedContracts.length], [0, 1, 1]);
  });

  it('a contract-only scope still shows nothing outside PR Review, without a showable map, or without the canvas', () => {
    const scope = resolvedWith([], [CODE_MAP_NODE]);
    for (const mode of ['codeMap', 'healthAudit'] as CodeMapMode[]) {
      assert.equal(resolvePrReviewView(mode, map, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null, mode);
    }
    assert.equal(resolvePrReviewView('prReview', { status: 'loading' }, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).metricsTable, null);
    const view = resolvePrReviewView('prReview', map, scope, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS);
    assert.equal(prReviewMetricsTableFor({ ...view, surfaces: { ...view.surfaces, canvas: false } }), null);
  });

  it('the table carries the same contracts and flag the toolbar list reads — nothing recomputed', () => {
    const view = resolvePrReviewView('prReview', map, resolvedWith([THREE[0]!.id], [CODE_MAP_NODE, RESULT_TYPE], true), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS);
    assert.equal(view.metricsTable?.changedContracts, view.changedContracts, 'the very same array');
    assert.equal(view.metricsTable?.changedContractsApproximate, true);
    assert.equal(view.changedContractsApproximate, true);
  });
});

describe('P4-3g: the contract row', () => {
  const empty = buildPrReviewMetricRows([], new Set(), null, 0);

  it('node cell: the ⧉ marker, P4-2e\'s ChangedContractButton and the type noun; hop "contract"; one colSpan dependents cell', () => {
    const elements = renderWithContracts(empty, [CODE_MAP_NODE]);
    const [row] = contractRowsOf(elements);
    assert.ok(row);
    const cells = cellsOf(row);
    assert.equal(cells.length, 3);
    const [nodeCell, hop, dependents] = cells as [RenderedElement, RenderedElement, RenderedElement];
    assert.equal(nodeCell.type, 'th');
    assert.equal(nodeCell.props.scope, 'row');
    assert.equal(nodeCell.props.title, CODE_MAP_NODE.id);
    assert.equal(textOf(nodeCell), `⧉ CodeMapNode${foldedTypeNoun('Interface')}`);
    const marker = renderTree(nodeCell.props.children).find((e) => e.props.className === 'code-map__metrics-contract-marker');
    assert.equal(marker?.props['aria-hidden'], 'true');
    // P4-2e's own button component, with its own accessible name.
    const contractButton = renderTree(nodeCell.props.children).find((e) => e.type === ChangedContractButton);
    assert.ok(contractButton, 'the node cell reuses ChangedContractButton');
    const button = renderTree(nodeCell.props.children).find((e) => e.type === 'button');
    assert.equal(button?.props['aria-label'], 'Open the type detail of CodeMapNode');
    assert.equal(textOf(hop), METRICS_CONTRACT_HOP);
    assert.equal(METRICS_CONTRACT_HOP, 'contract');
    assert.equal(textOf(dependents), '→ 59 dependents');
    assert.equal(dependents.props.className, 'code-map__metrics-contract-dependents');
    const headers = renderTree(byType(elements, 'thead')[0]?.props.children).filter((e) => e.type === 'th');
    assert.equal(2 + Number(dependents.props.colSpan), headers.length, 'the cells span exactly the table');
    // A Type reads "type".
    const result = cellsOf(contractRowsOf(renderWithContracts(empty, [RESULT_TYPE]))[0]!);
    assert.equal(textOf(result[0]), '⧉ Resulttype');
    assert.equal(textOf(result[2]), '→ 1 dependent');
  });

  it('shows the exact dependentCount (formatContractDependents), never the capped dependentIds.length', () => {
    assert.equal(CODE_MAP_NODE.dependentIds.length, 3);
    const elements = renderWithContracts(empty, [CODE_MAP_NODE]);
    const text = textOf(cellsOf(contractRowsOf(elements)[0]!)[2]);
    assert.equal(text, `→ ${formatContractDependents(CODE_MAP_NODE)}`);
    assert.ok(text.includes('59'));
    assert.ok(!text.includes('3 dependents'));
  });

  it('carries no risk values: no bars, no severity, no tests or findings value', () => {
    const elements = renderWithContracts(empty, [CODE_MAP_NODE]);
    const parts = renderTree(contractRowsOf(elements)[0]!.props.children);
    assert.ok(!parts.some((e) => /metrics-bar|severe|coverage-gap/.test(String(e.props.className ?? ''))));
    assert.ok(!parts.some((e) => e.props.role === 'img'));
    const text = textOf(contractRowsOf(elements)[0]);
    for (const word of ['gap', 'covered', SEVERE_SIGNAL_GLYPH, METRIC_CELL_EMPTY, '%']) {
      assert.ok(!text.includes(word), word);
    }
  });

  it('activation: the button calls onOpenType with the contract\'s id, never its name', () => {
    const opened: string[] = [];
    const elements = renderWithContracts(empty, [CODE_MAP_NODE], { onOpenType: (id) => opened.push(id) });
    const button = renderTree(contractRowsOf(elements)[0]!.props.children).find((e) => e.type === 'button');
    (button?.props.onClick as () => void)();
    assert.deepEqual(opened, [CODE_MAP_NODE.id]);
  });

  it('a click on another cell focuses the button, then opens the type detail once; a click on the button bubbles without a second open', () => {
    const opened: string[] = [];
    const row = contractRowsOf(renderWithContracts(empty, [CODE_MAP_NODE], { onOpenType: (id) => opened.push(id) }))[0]!;
    const inner = { inside: 'the button' };
    const button = fakeButton([inner]);
    const clickContractRow = (target: unknown, textSelected = false) => {
      const global = globalThis as unknown as { window?: unknown };
      const had = 'window' in global;
      const previous = global.window;
      global.window = { getSelection: () => ({ isCollapsed: !textSelected }) };
      try {
        (row.props.onClick as (event: unknown) => void)({ target, currentTarget: { querySelector: () => button } });
      } finally {
        if (had) {
          global.window = previous;
        } else {
          delete global.window;
        }
      }
    };
    clickContractRow({ cell: 'dependents' });
    assert.deepEqual(opened, [CODE_MAP_NODE.id]);
    assert.deepEqual(button.focused, [{ preventScroll: true }], 'the button is the opener focus returns to');
    clickContractRow(inner);
    assert.deepEqual(opened, [CODE_MAP_NODE.id], 'the button\'s own click is not doubled');
    clickContractRow({ cell: 'hop' }, true);
    assert.deepEqual(opened, [CODE_MAP_NODE.id], 'selecting text opens nothing');
  });

  it('the contract row has one control (its button) and no extra tab stop', () => {
    const row = contractRowsOf(renderWithContracts(empty, [CODE_MAP_NODE]))[0]!;
    assert.equal(row.props.tabIndex, undefined);
    const controls = renderTree(row.props.children).filter((e) => typeof e.type === 'string' && isActivatable(e));
    assert.deepEqual(controls.map((e) => e.type), ['button']);
  });

  it('MetricsContractRow is hookless and renders on its own', () => {
    const elements = renderTree(MetricsContractRow({ contract: RESULT_TYPE, onOpenType: () => {} }));
    assert.equal(elements[0]?.type, 'tr');
  });
});

describe('P4-3g: the contract group — placement, cap, approximate note', () => {
  const affectedOne = affectedNodes('one', 2);
  const map = [...THREE, ...affectedOne];
  const changedIds = new Set([THREE[0]!.id]);
  const table = buildPrReviewMetricRows(map, changedIds, hops([[affectedOne, 1]]), 1);

  it('function + type changed: changed rows, then the contract rows, then affected rows', () => {
    assert.deepEqual(bodyRowKinds(renderWithContracts(table, [CODE_MAP_NODE, RESULT_TYPE])), [
      'changed',
      `contract:${CODE_MAP_NODE.id}`,
      `contract:${RESULT_TYPE.id}`,
      'affected',
      'affected',
    ]);
  });

  it('the group is its own tbody, and without contracts the Node rows keep one tbody as before', () => {
    const groups = byType(renderWithContracts(table, [CODE_MAP_NODE]), 'tbody');
    assert.equal(groups.filter((g) => g.props.className === 'code-map__metrics-contracts').length, 1);
    const plain = byType(renderWithContracts(table, []), 'tbody');
    assert.equal(plain.length, 1);
    assert.ok(!bodyRowKinds(renderWithContracts(table, [])).some((k) => k.startsWith('contract')));
  });

  it('under every user sort the group stays one pinned block, before the sorted Node rows, never sorted with them', () => {
    const contracts = [RESULT_TYPE, CODE_MAP_NODE]; // given order, not alphabetical
    for (const { column } of PR_REVIEW_METRIC_COLUMNS) {
      for (const direction of ['ascending', 'descending'] as const) {
        const sort = sortBy(column, direction);
        const elements = renderWithContracts(SORTABLE, contracts, { sort });
        const kinds = bodyRowKinds(elements);
        assert.deepEqual(kinds.slice(0, 2), [`contract:${RESULT_TYPE.id}`, `contract:${CODE_MAP_NODE.id}`], `${column} ${direction}`);
        assert.ok(kinds.slice(2).every((k) => !k.startsWith('contract')), `${column} ${direction}`);
        // The Node rows are exactly P4-3d's sort, untouched by the group.
        assert.deepEqual(rowsOf(elements).map(rowIdOf), idsOf(sortPrReviewMetricRows(SORTABLE.rows, sort)), `${column} ${direction}`);
      }
    }
    // Back in the default order, between changed and affected again.
    const kinds = bodyRowKinds(renderWithContracts(SORTABLE, contracts));
    assert.deepEqual(kinds, ['changed', 'changed', `contract:${RESULT_TYPE.id}`, `contract:${CODE_MAP_NODE.id}`, 'affected', 'affected', 'affected']);
  });

  it('a sorted capped table: the group, then the sorted-within-cap note, then the rows, then the cap line; the note counts Node rows only', () => {
    const many = affectedNodes('many', METRICS_TABLE_AFFECTED_ROW_CAP + 2);
    const capped = buildPrReviewMetricRows([...THREE, ...many], new Set(THREE.map((n) => n.id)), hops([[many, 1]]), 1);
    const sort = sortBy('complexity', 'descending');
    const kinds = bodyRowKinds(renderWithContracts(capped, [CODE_MAP_NODE], { sort }));
    assert.equal(kinds[0], `contract:${CODE_MAP_NODE.id}`);
    assert.equal(kinds[1], 'code-map__metrics-sort-note');
    assert.equal(kinds.at(-1), 'code-map__metrics-cap');
    const note = byType(renderWithContracts(capped, [CODE_MAP_NODE], { sort }), 'tr').find((tr) => tr.props.className === 'code-map__metrics-sort-note');
    assert.equal(textOf(note), formatSortedWithinCapNote(sort, capped.rows.length, 2));
    // Default order: the cap line still closes the table, after the affected rows.
    const plainKinds = bodyRowKinds(renderWithContracts(capped, [CODE_MAP_NODE]));
    assert.equal(plainKinds.at(-1), 'code-map__metrics-cap');
    assert.equal(plainKinds.indexOf(`contract:${CODE_MAP_NODE.id}`), THREE.length);
  });

  it('bars stay relative to the Node rows only', () => {
    const elements = renderWithContracts(table, [CODE_MAP_NODE]);
    const plain = renderWithContracts(table, []);
    const widths = (els: RenderedElement[]) =>
      els.filter((e) => e.props.className === 'code-map__metrics-bar' || e.props.className === 'code-map__metrics-bar code-map__metrics-bar--severe').map((e) => JSON.stringify(e.props.style));
    assert.deepEqual(widths(elements), widths(plain));
  });

  it('7 contracts: 7 contract rows (uncapped), while the toolbar list keeps 5 + "+2 more"', () => {
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => contractFixture(name, [], 2));
    assert.equal(contractRowsOf(renderWithContracts(emptyNodeTable(), seven)).length, 7);
    const toolbar = renderTree(ChangedContractList({ contracts: seven, approximate: false, onOpenType: () => {} }));
    assert.equal(CHANGED_CONTRACTS_SHOWN, 5);
    assert.equal(toolbar.filter((e) => e.type === 'summary').map((e) => textOf(e)).join(), '+2 more');
  });

  it('approximate: the group leads with an inert note — the warning glyph and CHANGED_CONTRACTS_APPROXIMATE_NOTE', () => {
    const elements = renderWithContracts(table, [CODE_MAP_NODE], { approximate: true });
    const group = byType(elements, 'tbody').find((g) => g.props.className === 'code-map__metrics-contracts')!;
    const groupRows = renderTree(group.props.children).filter((e) => e.type === 'tr');
    const note = groupRows[0]!;
    assert.equal(note.props.className, 'code-map__metrics-contract-note');
    assert.equal(groupRows[1]?.props.className, 'code-map__metrics-contract');
    const text = textOf(note);
    assert.ok(text.startsWith(ACTIONABLE_NOTICE_GLYPHS.warning), text);
    assert.ok(text.includes(CHANGED_CONTRACTS_APPROXIMATE_NOTE), text);
    const glyph = renderTree(note.props.children).find((e) => textOf(e) === ACTIONABLE_NOTICE_GLYPHS.warning && e.type === 'span');
    assert.equal(glyph?.props['aria-hidden'], 'true');
    const cell = cellsOf(note)[0]!;
    const headers = renderTree(byType(elements, 'thead')[0]?.props.children).filter((e) => e.type === 'th');
    assert.equal(cell.props.colSpan, headers.length);
    assert.ok(!renderTree(note.props.children).concat(note).some(isActivatable), 'the note is inert');
    // Not approximate: no note.
    const plain = renderWithContracts(table, [CODE_MAP_NODE]);
    assert.equal(byType(plain, 'tr').filter((tr) => tr.props.className === 'code-map__metrics-contract-note').length, 0);
  });

  it('leadingChangedRowCount: where the group goes in the default order', () => {
    assert.equal(leadingChangedRowCount([]), 0);
    assert.equal(leadingChangedRowCount([{ hop: 'changed' }, { hop: 'changed' }]), 2);
    assert.equal(leadingChangedRowCount([{ hop: 'changed' }, { hop: 1 }, { hop: 2 }]), 1);
    assert.equal(leadingChangedRowCount([{ hop: 1 }]), 0);
  });
});

/** An empty Node table, for contract-only renders. */
function emptyNodeTable(): PrReviewMetricRows {
  return buildPrReviewMetricRows([], new Set(), null, 0);
}

describe('P4-3g: the caption names the contracts', () => {
  const empty = buildPrReviewMetricRows([], new Set(), null, 0);
  const changedOnly = buildPrReviewMetricRows(THREE, new Set(THREE.map((n) => n.id)), null, 0);

  it('contract-only: "Changed contracts"; with Node rows: the P4-3c wording plus "and changed contracts"', () => {
    assert.deepEqual(prReviewMetricsCaption(empty, 'idle', 1), { text: 'Changed contracts', visible: false });
    assert.deepEqual(prReviewMetricsCaption(changedOnly, 'idle', 2), { text: "Changed Nodes' risk metrics and changed contracts", visible: false });
    assert.deepEqual(prReviewMetricsCaption(changedOnly, 'loading', 1), {
      text: "Changed Nodes' risk metrics and changed contracts. Computing blast radius…",
      visible: true,
    });
    // Without contracts the P4-3c captions are unchanged.
    assert.deepEqual(prReviewMetricsCaption(changedOnly, 'idle'), { text: "Changed Nodes' risk metrics", visible: false });
    assert.deepEqual(prReviewMetricsCaption(changedOnly, 'loading', 0), { text: "Changed Nodes' risk metrics. Computing blast radius…", visible: true });
  });

  it('the rendered caption follows it', () => {
    const caption = byType(renderWithContracts(empty, [CODE_MAP_NODE]), 'caption')[0];
    assert.equal(textOf(caption), 'Changed contracts');
  });
});

describe('styles.css: the contract rows (P4-3g)', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };

  it('a contract row takes row-changed-background and row-changed-rule, as a changed Node row', () => {
    assert.match(block('.code-map__metrics-contract'), /background: color-mix\(in srgb, var\(--accent\) 8%, transparent\);/);
    assert.match(block('.code-map__metrics-contract > :first-child'), /box-shadow: inset 2px 0 0 var\(--accent\);/);
  });

  it('the dependents cell is text-dim; the approximate note is muted', () => {
    assert.match(block('.code-map__metrics-contract-dependents'), /color: var\(--text-dim\);/);
    assert.match(block('.code-map__metrics-contract-note'), /color: var\(--text-mute\);/);
  });
});

describe('P4-3g review round 1', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  /** Every selector list (text before a `{`) that styles the metrics table's body rows. */
  const rowSelectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter((sel) => sel.includes('tbody tr'));

  it('a contract-only table renders no empty Node-row tbody', () => {
    const empty = buildPrReviewMetricRows([], new Set(), null, 0);
    const bodies = byType(renderWithContracts(empty, [CODE_MAP_NODE]), 'tbody');
    assert.deepEqual(bodies.map((b) => b.props.className), ['code-map__metrics-contracts']);
    // Sorted too: the group alone.
    const sorted = byType(renderWithContracts(empty, [CODE_MAP_NODE], { sort: sortBy('complexity', 'descending') }), 'tbody');
    assert.deepEqual(sorted.map((b) => b.props.className), ['code-map__metrics-contracts']);
    // With Node rows, or only a cap line, the trailing tbody is still there.
    const withRows = buildPrReviewMetricRows(THREE, new Set(THREE.map((n) => n.id)), null, 0);
    assert.equal(byType(renderWithContracts(withRows, []), 'tbody').length, 1);
    const capOnly = byType(renderWithContracts({ ...empty, hiddenAffectedCount: 3 }, [CODE_MAP_NODE]), 'tbody');
    assert.equal(capOnly.length, 2);
  });

  it('contract rows carry neither the Node-row class nor its changed modifier, so the zebra and the row focus ring never match them', () => {
    const empty = buildPrReviewMetricRows([], new Set(), null, 0);
    const row = contractRowsOf(renderWithContracts(empty, [CODE_MAP_NODE]))[0]!;
    const classes = String(row.props.className).split(/\s+/);
    assert.ok(!classes.includes('code-map__metrics-table-row'));
    assert.ok(!classes.includes('code-map__metrics-table-row--changed'));
    const zebra = rowSelectors.filter((sel) => sel.includes(':nth-child(even)'));
    const ring = rowSelectors.filter((sel) => sel.includes(':has(') && sel.includes('focus-visible'));
    assert.ok(zebra.length > 0 && ring.length > 0);
    for (const sel of [...zebra, ...ring]) {
      assert.match(sel, /tbody tr\.code-map__metrics-table-row/, sel);
      assert.ok(!sel.includes('metrics-contract'), sel);
      assert.ok(!/tbody tr(:|\s|$)/.test(sel), `unqualified tr: ${sel}`);
    }
  });
});
