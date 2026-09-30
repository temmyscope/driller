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
  formatMissingChangedNodes,
  METRIC_CELL_EMPTY,
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

const unchanged = node('src/c.ts::other', { file: 'src/c.ts', riskSignals: [det('complexity', 99, 'severe')] });

// ---------------------------------------------------------------------------
// buildPrReviewMetricRows
// ---------------------------------------------------------------------------

describe('buildPrReviewMetricRows', () => {
  const ids = THREE.map((n) => n.id);
  const { rows, missingChangedCount } = buildPrReviewMetricRows([unchanged, ...THREE], new Set(ids));

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
      new Set(['z', 'm', 'a']),
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
      new Set(['c']),
    );
    assert.equal(cognitiveOnly.rows[0]?.complexity, null);
  });

  it('findings: the count, the highest severity and that finding\'s tool', () => {
    const pay = rows.find((r) => r.id === 'src/b.ts::pay');
    assert.deepEqual(pay?.findings, { count: 3, highestSeverity: 'blocker', sourceTool: 'CodeRabbit' });
    const infoFirst = buildPrReviewMetricRows(
      [node('f', { riskSignals: [finding('info', 'A'), finding('major', 'B'), finding('minor', 'C')] })],
      new Set(['f']),
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
    const result = buildPrReviewMetricRows(THREE, new Set([...ids, 'gone::one', 'gone::two']));
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
    const table = resolvePrReviewView('prReview', map, scope).metricsTable;
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
      assert.equal(resolvePrReviewView('prReview', map, state).metricsTable, null, state.status);
      // A stray `nodeIds` (a leftover from an earlier resolved scope) must not
      // open the table either: the gate is the status, not the data.
      const stray = { ...state, nodeIds: new Set(THREE.map((n) => n.id)) } as unknown as DiffScopeState;
      assert.equal(resolvePrReviewView('prReview', map, stray).metricsTable, null, `${state.status} + stray nodeIds`);
    }
  });

  it('no table outside PR Review, or without a showable map', () => {
    for (const mode of ['codeMap', 'healthAudit'] as CodeMapMode[]) {
      assert.equal(resolvePrReviewView(mode, map, scope).metricsTable, null, mode);
    }
    assert.equal(resolvePrReviewView('prReview', { status: 'loading' }, scope).metricsTable, null);
    assert.equal(resolvePrReviewView('prReview', ready([]), scope).metricsTable, null);
    assert.equal(resolvePrReviewView('prReview', { status: 'error', message: 'x' }, scope).metricsTable, null);
  });

  it('no table for 0 changed Nodes (contract-only / top-level-only diff), or only off-map ids', () => {
    assert.equal(resolvePrReviewView('prReview', map, resolved([])).metricsTable, null);
    assert.equal(resolvePrReviewView('prReview', map, resolved(['gone::x'])).metricsTable, null);
  });

  it('mounts only with the canvas: prReviewMetricsTableFor', () => {
    const view = resolvePrReviewView('prReview', map, scope);
    assert.equal(prReviewMetricsTableFor(view), view.metricsTable);
    assert.notEqual(view.metricsTable, null);
    assert.equal(prReviewMetricsTableFor({ ...view, surfaces: { ...view.surfaces, canvas: false } }), null);
    assert.equal(prReviewMetricsTableFor(resolvePrReviewView('codeMap', map, scope)), null);
  });

  it('keeps the off-map count alongside real rows', () => {
    const table = resolvePrReviewView('prReview', map, resolved([THREE[0]!.id, 'gone::x'])).metricsTable;
    assert.deepEqual([table?.rows.length, table?.missingChangedCount], [1, 1]);
  });
});

// ---------------------------------------------------------------------------
// PrReviewMetricsTable
// ---------------------------------------------------------------------------

function render(table: PrReviewMetricRows): RenderedElement[] {
  return renderTree(PrReviewMetricsTable(table));
}

const byType = (elements: RenderedElement[], type: string) => elements.filter((e) => e.type === type);
const rowsOf = (elements: RenderedElement[]) =>
  byType(elements, 'tr').filter((tr) => String(tr.props.className ?? '').includes('code-map__metrics-table-row'));
const cellsOf = (row: RenderedElement) =>
  renderTree(row.props.children).filter((e) => e.type === 'td' || e.type === 'th');

describe('PrReviewMetricsTable', () => {
  const table = buildPrReviewMetricRows(THREE, new Set(THREE.map((n) => n.id)));
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
      new Set(['a::handle', 'b::handle']),
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
    const allText = textOf(PrReviewMetricsTable(table)).toLowerCase();
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
