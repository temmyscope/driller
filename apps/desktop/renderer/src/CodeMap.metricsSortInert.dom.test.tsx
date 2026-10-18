/**
 * P5-g (founder 1.7): a contract-only PR Review metrics table's sort headers
 * are inert — `aria-disabled`, never native `disabled` — so a focused header
 * keeps focus when the table's Node rows go (the P2-2 precedent), rendered
 * for real (jsdom). jsdom keeps focus on a natively disabled button, so the
 * focus check is paired with "still a focusable, enabled control".
 */
import './test/domEnv';
import { assertSameElement, cleanupAfterEach } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChangedContract, CodeMapNode } from '@driller/ipc-contracts';
import {
  buildPrReviewMetricRows,
  PrReviewMetricsTable,
  type PrReviewMetricRows,
  type PrReviewMetricSort,
} from './CodeMap';

afterEach(cleanupAfterEach);

const node = (id: string, complexity: number): CodeMapNode => ({
  id,
  name: id.split('::').pop() ?? id,
  file: 'src/a.ts',
  startLine: 1,
  endLine: 5,
  kind: 'Function',
  summaryStatus: 'ready',
  summary: 'Does a thing.',
  riskSignals: [
    { family: 'deterministic', type: 'complexity', value: complexity, severity: 'moderate', location: { file: 'src/a.ts', startLine: 1, endLine: 5 } },
  ],
});

const NODES = [node('src/a.ts::load', 3), node('src/a.ts::pay', 9)];
const WITH_ROWS = buildPrReviewMetricRows(NODES, new Set(NODES.map((n) => n.id)), null, 0);
const NO_ROWS = buildPrReviewMetricRows([], new Set(), null, 0);

const CONTRACT: ChangedContract = {
  id: 'src/types.ts::CodeMapNode',
  name: 'CodeMapNode',
  kind: 'Interface',
  file: 'src/types.ts',
  dependentCount: 2,
  dependentIds: NODES.map((n) => n.id),
};

function table(rows: PrReviewMetricRows, sort: PrReviewMetricSort | null, onSort: (sort: PrReviewMetricSort) => void) {
  return (
    <PrReviewMetricsTable
      {...rows}
      blastRadiusStatus="idle"
      changedContracts={[CONTRACT]}
      changedContractsApproximate={false}
      sort={sort}
      onSort={onSort}
      onActivateNode={() => {}}
      onOpenType={() => {}}
    />
  );
}

const complexityHeader = () => screen.getByRole('button', { name: /^complexity/ });

describe('P5-g: inert sort headers keep focus', () => {
  it('a focused header stays focused (and focusable) when the rows go, does nothing on click, and sorts again when rows return', () => {
    const sort: PrReviewMetricSort = { column: 'complexity', direction: 'descending' };
    const calls: PrReviewMetricSort[] = [];
    const { rerender } = render(table(WITH_ROWS, sort, (s) => calls.push(s)));
    const header = complexityHeader();
    act(() => header.focus());
    assertSameElement(document.activeElement, header, 'focused header');
    assert.equal(header.closest('th')?.getAttribute('aria-sort'), 'descending');

    rerender(table(NO_ROWS, sort, (s) => calls.push(s)));
    assertSameElement(complexityHeader(), header, 'the same header element');
    assertSameElement(document.activeElement, header, 'focus stays on the header');
    assert.equal(header.getAttribute('aria-disabled'), 'true');
    assert.equal(header.matches(':disabled'), false, 'never natively disabled');
    assert.equal(header.tabIndex, 0, 'still in the tab order');
    assert.equal(header.closest('th')?.hasAttribute('aria-sort'), false);
    assert.equal(screen.getByRole('status').textContent, '');
    fireEvent.click(header);
    assert.equal(calls.length, 0, 'an inert header never calls onSort');

    rerender(table(WITH_ROWS, sort, (s) => calls.push(s)));
    assertSameElement(document.activeElement, header, 'focus kept as rows return');
    assert.equal(header.hasAttribute('aria-disabled'), false);
    assert.equal(header.closest('th')?.getAttribute('aria-sort'), 'descending');
    assert.equal(screen.getByRole('status').textContent, 'Sorted by complexity, descending.');
    fireEvent.click(header);
    assert.deepEqual(calls, [{ column: 'complexity', direction: 'ascending' }]);
  });
});
