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

import type { CodeMapNode, DeterministicRiskSignal, RiskSignal } from '@driller/ipc-contracts';
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
  PrReviewMetricsTable,
  type PrReviewMetricRows,
  resolvePrReviewView,
  SEVERE_SIGNAL_GLYPH,
} from './CodeMap';
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

  it('orders by file, then startLine, then id', () => {
    assert.deepEqual(
      rows.map((r) => r.id),
      ['src/a.ts::load', 'src/b.ts::refund', 'src/b.ts::pay'],
    );
    const tie = buildPrReviewMetricRows(
      [node('z', { startLine: 3 }), node('m', { startLine: 3 }), node('a', { startLine: 9 })],
      new Set(['z', 'm', 'a']), null, 0,
    );
    assert.deepEqual(
      tie.rows.map((r) => r.id),
      ['m', 'z', 'a'],
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
      [false, true, false],
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
      const stray = { ...state, nodeIds: new Set(THREE.map((n) => n.id)) } as unknown as DiffScopeState;
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

  it('no table for 0 changed Nodes (contract-only / top-level-only diff), or only off-map ids', () => {
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

function render(table: PrReviewMetricRows, blastRadiusStatus: BlastRadiusState['status'] = 'idle'): RenderedElement[] {
  return renderTree(PrReviewMetricsTable({ ...table, blastRadiusStatus }));
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
    assert.deepEqual(
      headers.map((h) => textOf(h)),
      ['node', 'hop', 'complexity', `blast radius (${BLAST_RADIUS_DEFAULT_HOPS} hops)`, 'tests', 'findings'],
    );
    assert.ok(headers.every((h) => h.props.scope === 'col'));
  });

  it('renders one row per changed Node, with the changed modifier', () => {
    const rows = rowsOf(elements);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => String(r.props.className).includes('code-map__metrics-table-row--changed')));
  });

  it('cells: identifier, module, hop, values, tests gap and findings', () => {
    const pay = rowsOf(elements)[2]!;
    const cells = cellsOf(pay).map((c) => textOf(c));
    assert.deepEqual(cells, [
      'paysrc/billing/, src/billing/b.ts line 40',
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
    assert.deepEqual(nodeCells, ['handlesrc/, src/a.ts line 3', 'handlesrc/, src/a.ts line 30']);
  });

  it('absent signals render —, and nothing anywhere says "covered"', () => {
    const load = rowsOf(elements)[0]!;
    assert.deepEqual(
      cellsOf(load).map((c) => textOf(c)),
      ['loadsrc/, src/a.ts line 10', 'changed', '3', METRIC_CELL_EMPTY, METRIC_CELL_EMPTY, METRIC_CELL_EMPTY],
    );
    assert.equal(METRIC_CELL_EMPTY, '—');
    const allText = textOf(PrReviewMetricsTable({ ...table, blastRadiusStatus: 'idle' })).toLowerCase();
    assert.ok(!allText.includes('covered'), allText);
    assert.ok(!allText.includes('%'), allText);
  });

  it('shows the index coverage-gap glyph on a coverage-gap Node', () => {
    const refund = rowsOf(elements)[1]!;
    const glyph = renderTree(refund.props.children).find(
      (e) => e.props.className === 'code-map__metrics-table-coverage-gap',
    );
    assert.equal(textOf(glyph), '⚠');
    assert.equal(
      rowsOf(elements)[0] && renderTree(rowsOf(elements)[0]!.props.children).some(
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
      /\{prReviewMetricsTableProps !== null && \(\s*<>\s*<MetricsTableDivider\s[^>]*\/>\s*<PrReviewMetricsTable \{\.\.\.prReviewMetricsTableProps\} \/>\s*<\/>\s*\)\}/,
    );
  });
  it('.code-map carries the height style and the measured ref', () => {
    assert.match(
      src,
      /className="code-map"\s+id=\{MODAL_FOCUS_FALLBACK_ID\}\s+tabIndex=\{-1\}\s+ref=\{setMapElement\}\s+style=\{codeMapTableHeightStyle\(prReviewMetricsTableProps !== null, metricsTableHeight, mapHeight\)\}/,
    );
  });
  it('onResize sets the requested height and flushes the deferred canvas size', () => {
    assert.match(src, /<MetricsTableDivider\s+height=\{metricsTableHeight\}\s+mapHeight=\{mapHeight\}\s+onResize=\{handleMetricsTableResize\}/);
    assert.match(src, /\(height: number\) => \{\s*setRequestedMetricsTableHeight\(height\);\s*flushCanvasSize\(\);\s*\}/);
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

  it('changed rows keep phase 1a order and lead; affected rows: hop ascending, blast radius descending, then id', () => {
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
      ['src/a.ts::load', 'src/b.ts::refund', 'src/b.ts::pay', 'j-high', 'k-high', 'm-low', 'a-none', 'b-none', 'z-far'],
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

/**
 * The hooks at the top level of `CodeMap` (2-space indent): each
 * `useEffect`/`useLayoutEffect`/`useCallback`, its name (callbacks only),
 * its text and its dependency list.
 */
function topLevelHooks(src: string): { name: string | null; text: string; deps: string[] }[] {
  const lines = src.split('\n');
  const hooks: { name: string | null; text: string; deps: string[] }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = /^ {2}(?:useEffect\(|useLayoutEffect\(|const (\w+) = useCallback\()/.exec(lines[i]!);
    if (!start) {
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !/^ {2}[})]/.test(lines[end]!)) {
      end += 1;
    }
    const text = lines.slice(i, end + 1).join('\n');
    const deps = /\[([^[\]]*)\],?\s*\);\s*$/.exec(text)?.[1] ?? '';
    hooks.push({
      name: start[1] ?? null,
      text,
      deps: deps
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
    });
  }
  return hooks;
}

describe('CodeMap source: the affected-row wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');
  it('the table and the canvas highlight read one slice', () => {
    assert.match(
      src,
      /const blastRadiusNodeIds = useMemo<ReadonlySet<string>>\(\(\) => \{[\s\S]{0,300}return nodesWithinDepth\(blastRadiusState\.hopDistances, blastRadiusDepth\);\s*\}, \[mode, blastRadiusState, blastRadiusDepth\]\);/,
    );
    assert.equal(src.match(/\(distance <= /g)?.length, 1, 'one depth comparison, in nodesWithinDepth');
  });
  it('the view gets the blast radius and the depth, re-deriving on a step with no IPC call', () => {
    const memo = /const prReviewView = useMemo\(\s*\(\) => resolvePrReviewView\(mode, fetchState, diffScopeState, blastRadiusState, blastRadiusDepth\),\s*\[mode, fetchState, diffScopeState, blastRadiusState, blastRadiusDepth\],\s*\);/.exec(src);
    assert.ok(memo);
    assert.doesNotMatch(memo[0], /window\.driller|expandBlastRadius|getCodeMap/);
  });
  it('the loading caption matches the toolbar wording', () => {
    assert.ok(src.includes('>\n              Computing blast radius…\n'), 'toolbar wording');
    assert.ok(src.includes('Computing blast radius…"'), 'caption wording');
  });

  // Mode switched away and back keeps the same rows at the same depth only
  // if nothing a mode toggle re-runs resets the blast radius or its depth.
  const hooks = topLevelHooks(src);
  const RESETS = ["setBlastRadiusState({ status: 'idle' })", 'setBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS)'];
  it('no hook that depends on `mode` resets the blast radius or its depth, directly or through a callback', () => {
    const resetting = new Set<string>();
    const resets = (text: string) =>
      RESETS.some((r) => text.includes(r)) || [...resetting].some((name) => new RegExp(`\\b${name}\\(`).test(text));
    // Close over callbacks that call resetting callbacks.
    for (let grew = true; grew; ) {
      grew = false;
      for (const hook of hooks) {
        if (hook.name !== null && !resetting.has(hook.name) && resets(hook.text)) {
          resetting.add(hook.name);
          grew = true;
        }
      }
    }
    assert.ok(resetting.size >= 3, `found the reset callbacks: ${[...resetting].join(', ')}`);
    const resettingHooks = hooks.filter((hook) => resets(hook.text));
    // The project-switch effect plus the reset callbacks and their callers.
    assert.ok(resettingHooks.some((hook) => hook.name === null && hook.deps.includes('projectPath')));
    for (const hook of resettingHooks) {
      assert.ok(!hook.deps.includes('mode'), `${hook.name ?? 'an effect'} resets the blast radius on [${hook.deps.join(', ')}]`);
    }
  });
  it('the auto-trigger effect re-runs on a mode toggle but not on a step, and fires only from idle', () => {
    const trigger = hooks.filter((hook) => hook.text.includes('.expandBlastRadius('));
    assert.equal(trigger.length, 1);
    assert.deepEqual(trigger[0]!.deps, ['mode', 'projectPath', 'diffScopeState', 'blastRadiusState.status', 'graphServiceAvailable']);
    assert.ok(!trigger[0]!.deps.includes('blastRadiusDepth'));
    assert.match(trigger[0]!.text, /blastRadiusState\.status !== 'idle'\n\s*\) \{\n\s*return;/);
  });
});
