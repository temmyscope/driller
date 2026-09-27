/**
 * P2-12: Node Detail's composition — the helpers (module line, Location line,
 * callable `()` suffix, toggle-hidden signal count) and the hookless
 * `NodeDetailHead` / `NodeDetailBody`, rendered by calling them and walking
 * the returned elements (`./testRender`, since the runner is `node --test`
 * with no DOM).
 *
 * What this cannot reach: the panel's layout (scrolling body, pinned footer),
 * a screen reader actually announcing the staleness flip, and the mockup
 * side-by-side — owed in-app checks.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapNode, CodeMapNodeKind, RiskSignal, TestedBy, TestedByTest } from '@driller/ipc-contracts';

import { ActionableNotice } from './ActionableNotice';
import {
  countToggleHiddenSignals,
  formatNodeLocation,
  NO_TEST_LINK_FOUND,
  NODE_DETAIL_SECTION_HEADING_IDS,
  NODE_DETAIL_TESTED_BY_ROWS,
  NodeDetailBody,
  NodeDetailHead,
  nodeModuleLine,
  openTestFromDetail,
  testSourceTarget,
  type SourceTarget,
  nodeNameSuffix,
  type NodeDetailBodyProps,
  type RiskSignalFamilyToggles,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

const noop = () => {};

const ALL_ON: RiskSignalFamilyToggles = {
  showDeterministicSignals: true,
  showLlmJudgment: true,
  showIngestedFindings: true,
};
const ALL_OFF: RiskSignalFamilyToggles = {
  showDeterministicSignals: false,
  showLlmJudgment: false,
  showIngestedFindings: false,
};

const LOCATION = { file: 'billing/pay.ts', startLine: 42, endLine: 71 };

const BLAST: RiskSignal = {
  family: 'deterministic',
  type: 'blast-radius',
  value: 14,
  location: LOCATION,
  severity: 'moderate',
};
const COMPLEXITY: RiskSignal = {
  family: 'deterministic',
  type: 'complexity',
  value: 31,
  location: LOCATION,
  severity: 'severe',
};
const JUDGMENT: RiskSignal = { family: 'llm-judgment', judgment: 'Retries without backoff.', location: LOCATION };
const BLANK_JUDGMENT: RiskSignal = { family: 'llm-judgment', judgment: '   ', location: LOCATION };
const FINDING: RiskSignal = {
  family: 'ingested',
  severity: 'major',
  sourceTool: 'CodeRabbit',
  finding: 'possible null on retry path',
  location: LOCATION,
};

function makeNode(overrides: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id: 'billing/pay.ts::charge',
    name: 'charge',
    file: 'billing/pay.ts',
    startLine: 42,
    endLine: 71,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Charges the card.',
    riskSignals: [],
    ...overrides,
  };
}

function renderBody(overrides: Partial<NodeDetailBodyProps> = {}): RenderedElement[] {
  const props: NodeDetailBodyProps = {
    node: makeNode(),
    toggles: ALL_ON,
    cloudSelectedNoKey: false,
    noSummaryBackendAvailable: false,
    summaryAction: { label: 'Regenerate', busyLabel: 'Regenerating…' },
    regenerateState: { kind: 'idle' },
    graphServiceAvailable: true,
    onRegenerate: noop,
    onOpenTest: noop,
    ...overrides,
  };
  return renderTree(NodeDetailBody(props));
}

function byClass(elements: RenderedElement[], className: string): RenderedElement | undefined {
  return elements.find((element) => element.props.className === className);
}

/** Each `<section>`'s heading text, resolved through its `aria-labelledby`. */
function sectionHeadings(elements: RenderedElement[]): string[] {
  return elements
    .filter((element) => element.type === 'section')
    .map((section) => {
      const id = section.props['aria-labelledby'];
      assert.equal(typeof id, 'string', 'every section is named by aria-labelledby');
      assert.equal(section.props['aria-label'], undefined, 'no duplicated aria-label');
      const heading = elements.find((element) => element.type === 'h3' && element.props.id === id);
      assert.ok(heading, `a heading carries the id ${String(id)}`);
      assert.ok(renderTree(section.props.children).includes(heading), 'the heading is inside its section');
      return textOf(heading);
    });
}

function section(elements: RenderedElement[], id: string): RenderedElement[] {
  const found = elements.find((element) => element.type === 'section' && element.props['aria-labelledby'] === id);
  assert.ok(found, `section ${id} renders`);
  return renderTree(found.props.children);
}

function stalenessStatus(elements: RenderedElement[]): RenderedElement {
  const statuses = section(elements, NODE_DETAIL_SECTION_HEADING_IDS.staleness).filter(
    (element) => element.props.role === 'status',
  );
  assert.equal(statuses.length, 1, 'exactly one persistent status element');
  const [status] = statuses;
  assert.ok(status);
  return status;
}

function regenerateButton(elements: RenderedElement[]): RenderedElement | undefined {
  return section(elements, NODE_DETAIL_SECTION_HEADING_IDS.staleness).find((element) => element.type === 'button');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('nodeModuleLine', () => {
  it('is the directory of a nested file, with its trailing slash', () => {
    assert.equal(nodeModuleLine('billing/pay.ts'), 'billing/');
    assert.equal(nodeModuleLine('src/billing/pay.ts'), 'src/billing/');
  });

  it('is null for a file at the project root', () => {
    assert.equal(nodeModuleLine('main.ts'), null);
  });

  it('ignores a leading ./ or /, so a root file never yields "./" or "/"', () => {
    assert.equal(nodeModuleLine('./main.ts'), null);
    assert.equal(nodeModuleLine('/main.ts'), null);
    assert.equal(nodeModuleLine('./billing/pay.ts'), 'billing/');
    assert.equal(nodeModuleLine('/billing/pay.ts'), 'billing/');
  });

  it('normalizes backslashes to /', () => {
    assert.equal(nodeModuleLine('billing\\pay.ts'), 'billing/');
    assert.equal(nodeModuleLine('src\\billing\\pay.ts'), 'src/billing/');
  });

  it('ignores a trailing slash rather than returning the whole path', () => {
    assert.equal(nodeModuleLine('billing/'), null);
    assert.equal(nodeModuleLine('src/billing/'), 'src/');
  });
});

describe('formatNodeLocation', () => {
  it('formats a multi-line range with an en dash', () => {
    assert.equal(formatNodeLocation('billing/pay.ts', 42, 71), 'billing/pay.ts — lines 42–71');
  });

  it('formats a one-line range as a single line', () => {
    assert.equal(formatNodeLocation('main.ts', 7, 7), 'main.ts — line 7');
  });

  it('orders an inverted range min–max', () => {
    assert.equal(formatNodeLocation('billing/pay.ts', 71, 42), 'billing/pay.ts — lines 42–71');
  });

  it('falls back to just the file for non-positive or non-finite lines', () => {
    assert.equal(formatNodeLocation('main.ts', 0, 5), 'main.ts');
    assert.equal(formatNodeLocation('main.ts', 3, -1), 'main.ts');
    assert.equal(formatNodeLocation('main.ts', Number.NaN, 5), 'main.ts');
    assert.equal(formatNodeLocation('main.ts', 1, Number.POSITIVE_INFINITY), 'main.ts');
  });
});

describe('nodeNameSuffix', () => {
  const cases: Array<[CodeMapNodeKind, string]> = [
    ['Function', '()'],
    ['Interface', ''],
    ['Type', ''],
    ['Module', ''],
  ];
  for (const [kind, suffix] of cases) {
    it(`gives a ${kind} Node ${suffix === '' ? 'no suffix' : suffix}`, () => {
      assert.equal(nodeNameSuffix(kind), suffix);
    });
  }

  it('gives an unknown kind arriving over IPC no suffix', () => {
    assert.equal(nodeNameSuffix('Class' as unknown as CodeMapNodeKind), '');
  });
});

describe('countToggleHiddenSignals', () => {
  it('counts nothing while every toggle is on', () => {
    assert.equal(countToggleHiddenSignals([BLAST, JUDGMENT, FINDING], ALL_ON), 0);
  });

  it('counts each signal in a family whose toggle is off', () => {
    assert.equal(countToggleHiddenSignals([BLAST, COMPLEXITY, JUDGMENT, FINDING], ALL_OFF), 4);
    assert.equal(
      countToggleHiddenSignals([BLAST, COMPLEXITY, FINDING], { ...ALL_ON, showDeterministicSignals: false }),
      2,
    );
  });

  it('does not count a blank LLM judgment, which never renders anyway', () => {
    assert.equal(countToggleHiddenSignals([BLANK_JUDGMENT], ALL_OFF), 0);
  });
});

// ---------------------------------------------------------------------------
// NodeDetailHead
// ---------------------------------------------------------------------------

describe('NodeDetailHead', () => {
  it('renders the module line, the name with a muted () and the close button', () => {
    const onClose = () => {};
    const elements = renderTree(NodeDetailHead({ node: makeNode(), onClose }));

    const moduleLine = byClass(elements, 'code-map__node-detail-module');
    assert.equal(textOf(moduleLine), 'billing/');
    assert.equal(moduleLine?.props.title, 'billing/');
    assert.equal(textOf(byClass(elements, 'code-map__node-detail-name')), 'charge()');
    assert.equal(textOf(byClass(elements, 'code-map__node-detail-paren')), '()');

    const close = elements.find((element) => element.type === 'button');
    assert.ok(close);
    assert.equal(close.props.onClick, onClose);
  });

  it('keeps the () outside the truncating name span, which carries the full name as title', () => {
    const longName = 'processEveryPendingInvoiceForTheCurrentBillingCycle';
    const elements = renderTree(NodeDetailHead({ node: makeNode({ name: longName }), onClose: noop }));
    const nameText = byClass(elements, 'code-map__node-detail-name-text');
    assert.ok(nameText);
    assert.equal(textOf(nameText), longName);
    assert.equal(nameText.props.title, longName);
    const paren = byClass(elements, 'code-map__node-detail-paren');
    assert.ok(paren);
    assert.ok(!renderTree(nameText.props.children).includes(paren), 'the () is not inside the truncating span');
  });

  it('names the close button with its visible text plus a hidden " Node detail" (label-in-name)', () => {
    const elements = renderTree(NodeDetailHead({ node: makeNode(), onClose: noop }));
    const close = elements.find((element) => element.type === 'button');
    assert.ok(close);
    assert.equal(close.props['aria-label'], undefined, 'no aria-label replacing the visible text');
    assert.equal(textOf(close), '[esc] close Node detail');
    const hidden = renderTree(close.props.children).find((element) => element.props.className === 'visually-hidden');
    assert.ok(hidden);
    assert.equal(textOf(hidden), ' Node detail');
  });

  it('omits the module line for a root-level file', () => {
    const elements = renderTree(NodeDetailHead({ node: makeNode({ file: 'main.ts' }), onClose: noop }));
    assert.equal(byClass(elements, 'code-map__node-detail-module'), undefined);
  });

  for (const kind of ['Type', 'Interface', 'Module'] as const) {
    it(`omits the () for a ${kind} Node`, () => {
      const elements = renderTree(NodeDetailHead({ node: makeNode({ name: 'Invoice', kind }), onClose: noop }));
      assert.equal(textOf(byClass(elements, 'code-map__node-detail-name')), 'Invoice');
      assert.equal(byClass(elements, 'code-map__node-detail-paren'), undefined);
    });
  }
});

// ---------------------------------------------------------------------------
// NodeDetailBody
// ---------------------------------------------------------------------------

describe('NodeDetailBody: sections', () => {
  it('renders Summary, Risk Overlay, Tested by, Staleness, Location in that order, each named by its heading', () => {
    assert.deepEqual(sectionHeadings(renderBody()), ['Summary', 'Risk Overlay', 'Tested by', 'Staleness', 'Location']);
  });

  it('keeps the same five sections for a pending, coverage-gap or stale Node', () => {
    for (const node of [
      makeNode({ summaryStatus: 'pending', summary: undefined }),
      makeNode({ summaryStatus: 'coverage-gap', summary: undefined }),
      makeNode({ stale: true }),
    ]) {
      assert.deepEqual(sectionHeadings(renderBody({ node })), [
        'Summary',
        'Risk Overlay',
        'Tested by',
        'Staleness',
        'Location',
      ]);
    }
  });

  it('formats Location from the Node\'s own file and line fields', () => {
    const location = section(renderBody(), NODE_DETAIL_SECTION_HEADING_IDS.location);
    assert.equal(textOf(byClass(location, 'code-map__node-detail-location')), 'billing/pay.ts — lines 42–71');
  });

  it('shows a one-line Node as "line N"', () => {
    const location = section(
      renderBody({ node: makeNode({ file: 'main.ts', startLine: 7, endLine: 7 }) }),
      NODE_DETAIL_SECTION_HEADING_IDS.location,
    );
    assert.equal(textOf(byClass(location, 'code-map__node-detail-location')), 'main.ts — line 7');
  });
});

describe('NodeDetailBody: Summary', () => {
  it('shows a ready summary', () => {
    const summary = section(renderBody(), NODE_DETAIL_SECTION_HEADING_IDS.summary);
    assert.equal(textOf(byClass(summary, 'code-map__node-detail-summary')), 'Charges the card.');
  });

  it('says "No summary text." for a ready Node with no summary, never an empty box', () => {
    const summary = section(
      renderBody({ node: makeNode({ summary: undefined }) }),
      NODE_DETAIL_SECTION_HEADING_IDS.summary,
    );
    assert.equal(byClass(summary, 'code-map__node-detail-summary'), undefined);
    assert.equal(textOf(byClass(summary, 'code-map__node-detail-empty')), 'No summary text.');
  });

  it('keeps the coverage-gap and pending notices', () => {
    const gap = section(
      renderBody({ node: makeNode({ summaryStatus: 'coverage-gap', summary: undefined }) }),
      NODE_DETAIL_SECTION_HEADING_IDS.summary,
    );
    assert.equal(
      textOf(byClass(gap, 'code-map__node-summary code-map__node-summary--coverage-gap')),
      '⚠ Coverage gap — no summary',
    );

    const pending = section(
      renderBody({ node: makeNode({ summaryStatus: 'pending', summary: undefined }) }),
      NODE_DETAIL_SECTION_HEADING_IDS.summary,
    );
    assert.equal(textOf(byClass(pending, 'code-map__node-summary code-map__node-summary--pending')), 'Summary pending…');
  });
});

describe('NodeDetailBody: Risk Overlay', () => {
  it('renders the shared signal sections when a signal is visible', () => {
    const risk = section(renderBody({ node: makeNode({ riskSignals: [BLAST] }) }), NODE_DETAIL_SECTION_HEADING_IDS.riskOverlay);
    assert.ok(byClass(risk, 'code-map__node-detail-signals'));
    assert.equal(byClass(risk, 'code-map__node-detail-empty'), undefined);
  });

  it('says "No risk signals shown." for a Node with no signals', () => {
    const risk = section(renderBody(), NODE_DETAIL_SECTION_HEADING_IDS.riskOverlay);
    assert.equal(textOf(byClass(risk, 'code-map__node-detail-empty')), 'No risk signals shown.');
  });

  it('says one signal is hidden by the overlay toggles (singular)', () => {
    const risk = section(
      renderBody({ node: makeNode({ riskSignals: [BLAST] }), toggles: ALL_OFF }),
      NODE_DETAIL_SECTION_HEADING_IDS.riskOverlay,
    );
    assert.equal(textOf(byClass(risk, 'code-map__node-detail-empty')), '1 signal hidden by the overlay toggles.');
  });

  it('says how many signals are hidden by the overlay toggles (plural)', () => {
    const risk = section(
      renderBody({ node: makeNode({ riskSignals: [BLAST, COMPLEXITY, FINDING] }), toggles: ALL_OFF }),
      NODE_DETAIL_SECTION_HEADING_IDS.riskOverlay,
    );
    assert.equal(textOf(byClass(risk, 'code-map__node-detail-empty')), '3 signals hidden by the overlay toggles.');
  });

  it('does not blame the toggles for a blank judgment that never renders', () => {
    const risk = section(
      renderBody({ node: makeNode({ riskSignals: [BLANK_JUDGMENT] }) }),
      NODE_DETAIL_SECTION_HEADING_IDS.riskOverlay,
    );
    assert.equal(textOf(byClass(risk, 'code-map__node-detail-empty')), 'No risk signals shown.');
  });
});

describe('NodeDetailBody: Staleness', () => {
  it('shows the stale line when the summary is stale', () => {
    const status = stalenessStatus(renderBody({ node: makeNode({ stale: true }) }));
    assert.equal(textOf(status), '⏳ Summary may be stale — source changed since generation');
    assert.match(String(status.props.className), /code-map__node-detail-staleness--stale/);
  });

  it('says "Not stale." only for a ready summary that is not stale', () => {
    assert.equal(textOf(stalenessStatus(renderBody())), 'Not stale.');
    assert.equal(textOf(stalenessStatus(renderBody({ node: makeNode({ stale: false }) }))), 'Not stale.');
  });

  it('says "No summary yet." for a pending or coverage-gap Node, never "Not stale."', () => {
    for (const summaryStatus of ['pending', 'coverage-gap'] as const) {
      const status = stalenessStatus(renderBody({ node: makeNode({ summaryStatus, summary: undefined }) }));
      assert.equal(textOf(status), 'No summary yet.');
      assert.match(String(status.props.className), /code-map__node-detail-staleness--none/);
    }
  });

  it('keeps one status element of the same type across the three states, so the flip is announced', () => {
    const types = [makeNode({ stale: true }), makeNode(), makeNode({ summaryStatus: 'pending', summary: undefined })].map(
      (node) => stalenessStatus(renderBody({ node })).type,
    );
    assert.deepEqual(types, ['p', 'p', 'p']);
  });
});

describe('NodeDetailBody: summary action', () => {
  it('renders the chip with a decorative ↻ and wires onRegenerate', () => {
    const onRegenerate = () => {};
    const button = regenerateButton(renderBody({ onRegenerate }));
    assert.ok(button);
    assert.equal(textOf(button), '↻ Regenerate');
    const glyph = renderTree(button.props.children).find((element) => element.props['aria-hidden'] === 'true');
    assert.equal(textOf(glyph), '↻ ');
    assert.equal(button.props.onClick, onRegenerate);
    assert.equal(button.props.disabled, false);
  });

  it('shows the busy label and disables while regenerating', () => {
    const button = regenerateButton(renderBody({ regenerateState: { kind: 'regenerating' } }));
    assert.equal(textOf(button), '↻ Regenerating…');
    assert.equal(button?.props.disabled, true);
  });

  it('disables with the unavailable class and title while the Graph Service is down', () => {
    const button = regenerateButton(renderBody({ graphServiceAvailable: false }));
    assert.equal(button?.props.disabled, true);
    assert.match(String(button?.props.className), /code-map__action--service-unavailable/);
    assert.equal(typeof button?.props.title, 'string');
  });

  it('offers no chip when there is no action (coverage gap)', () => {
    assert.equal(regenerateButton(renderBody({ summaryAction: null })), undefined);
  });

  it('shows the regenerate error as an alert notice in the Staleness section', () => {
    const staleness = section(
      renderBody({ regenerateState: { kind: 'error', message: 'Backend failed.' } }),
      NODE_DETAIL_SECTION_HEADING_IDS.staleness,
    );
    const notice = staleness.find((element) => element.type === ActionableNotice);
    assert.ok(notice);
    assert.equal(notice.props.role, 'alert');
    assert.equal(notice.props.children, 'Backend failed.');
  });
});

// ---------------------------------------------------------------------------
// NodeDetailBody: Tested by (P4-2 phase 2)
// ---------------------------------------------------------------------------

function testEntry(i: number, file = 'billing/pay.test.ts'): TestedByTest {
  return { id: `t${i}`, name: `charges card ${i}`, file, startLine: 10 * i, endLine: 10 * i + 5 };
}

function testedBySection(testedBy: TestedBy | undefined, onOpenTest: (target: SourceTarget) => void = noop): RenderedElement[] {
  return section(renderBody({ node: makeNode({ testedBy }), onOpenTest }), NODE_DETAIL_SECTION_HEADING_IDS.testedBy);
}

/** Row buttons outside any "+N more" expander. */
function visibleButtons(elements: RenderedElement[]): RenderedElement[] {
  // Function components re-render into fresh element objects, so buttons are
  // matched by their (unique per row) accessible name, not by identity.
  const hidden = new Set(
    elements
      .filter((element) => element.type === 'details')
      .flatMap((details) => renderTree(details.props.children))
      .filter((element) => element.type === 'button')
      .map((button) => button.props['aria-label']),
  );
  return elements.filter((element) => element.type === 'button' && !hidden.has(element.props['aria-label']));
}

function expanders(elements: RenderedElement[]): RenderedElement[] {
  return elements.filter((element) => element.type === 'details');
}

function click(button: RenderedElement | undefined): void {
  assert.ok(button);
  (button.props.onClick as () => void)();
}

describe('NodeDetailBody: Tested by', () => {
  it('lists each direct test with its file and line, and an accessible name', () => {
    const elements = testedBySection({ tests: [testEntry(1), testEntry(2), testEntry(3)], totalTests: 3, files: [] });
    const rows = visibleButtons(elements);
    assert.deepEqual(rows.map(textOf), [
      'charges card 1 billing/pay.test.ts:10',
      'charges card 2 billing/pay.test.ts:20',
      'charges card 3 billing/pay.test.ts:30',
    ]);
    assert.equal(rows[0]?.props['aria-label'], 'Open test charges card 1 at billing/pay.test.ts:10');
    assert.deepEqual(expanders(elements), []);
    assert.equal(byClass(elements, 'code-map__node-detail-tested-by-none'), undefined);
  });

  it('a top-level row reads "<file>:<line> (top-level)", not the file name twice', () => {
    const top: TestedByTest = { ...testEntry(4), name: 'pay.test.ts', topLevel: true };
    const [row] = visibleButtons(testedBySection({ tests: [top], totalTests: 1, files: [] }));
    assert.equal(textOf(row), 'billing/pay.test.ts:40 (top-level)');
    assert.equal(row?.props['aria-label'], 'Open top-level test code at billing/pay.test.ts:40');
  });

  it('clicking a row opens that test in the source viewer, labelled, never a map Node', () => {
    const opened: SourceTarget[] = [];
    const tests = [testEntry(1), { ...testEntry(2), topLevel: true as const }];
    click(visibleButtons(testedBySection({ tests, totalTests: 2, files: [] }, (target) => opened.push(target)))[1]);
    assert.deepEqual(opened, [
      { file: 'billing/pay.test.ts', startLine: 20, endLine: 25, label: 'billing/pay.test.ts (top-level)' },
    ]);
    assert.deepEqual(testSourceTarget(testEntry(1)), {
      file: 'billing/pay.test.ts',
      startLine: 10,
      endLine: 15,
      label: 'charges card 1',
    });
  });

  it(`shows ${NODE_DETAIL_TESTED_BY_ROWS} rows, then a "+25 more" expander with every carried test and the capped-list line`, () => {
    // 30 direct tests: the Graph Service carries 20 and the full count.
    const tests = Array.from({ length: 20 }, (_, i) => testEntry(i + 1));
    const elements = testedBySection({ tests, totalTests: 30, files: [] });
    assert.equal(visibleButtons(elements).length, 5);
    const [expander] = expanders(elements);
    assert.ok(expander);
    const inside = renderTree(expander.props.children);
    assert.equal(textOf(inside.find((element) => element.type === 'summary')), '+25 more');
    assert.equal(inside.filter((element) => element.type === 'button').length, 15, 'the other 15 carried tests');
    assert.equal(textOf(byClass(inside, 'code-map__node-detail-tests-truncated')), 'Showing the first 20 of 30.');
  });

  it('an expander holding every test omits the capped-list line', () => {
    const tests = Array.from({ length: 8 }, (_, i) => testEntry(i + 1));
    const [expander] = expanders(testedBySection({ tests, totalTests: 8, files: [] }));
    assert.ok(expander);
    const inside = renderTree(expander.props.children);
    assert.equal(textOf(inside.find((element) => element.type === 'summary')), '+3 more');
    assert.equal(byClass(inside, 'code-map__node-detail-tests-truncated'), undefined);
  });

  it('shows TESTS_FILE files as buttons opening the file at its start', () => {
    const opened: SourceTarget[] = [];
    const elements = testedBySection(
      { tests: [], totalTests: 0, files: [{ file: 'billing/pay.test.ts', startLine: 1, endLine: 88 }, { file: 'billing/norange.test.ts' }] },
      (target) => opened.push(target),
    );
    assert.equal(textOf(byClass(elements, 'code-map__node-detail-test-files-label')), 'Tests for this file:');
    const [button] = visibleButtons(elements);
    assert.equal(button?.props['aria-label'], 'Open test file billing/pay.test.ts');
    click(button);
    assert.deepEqual(opened, [{ file: 'billing/pay.test.ts', startLine: 1, endLine: 88, label: 'billing/pay.test.ts' }]);
    // A file the index gave no range for is listed, but not a button.
    assert.equal(visibleButtons(elements).length, 1);
    assert.match(textOf(elements), /billing\/norange\.test\.ts/);
    assert.equal(byClass(elements, 'code-map__node-detail-tested-by-none'), undefined);
  });

  it('shows rows and files together, merging a file already listed as a direct test', () => {
    const elements = testedBySection({
      tests: [testEntry(1)],
      totalTests: 1,
      files: [
        { file: 'billing/pay.test.ts', startLine: 1, endLine: 80 },
        { file: 'billing/refund.test.ts', startLine: 1, endLine: 40 },
      ],
    });
    assert.deepEqual(visibleButtons(elements).map(textOf), ['charges card 1 billing/pay.test.ts:10', 'billing/refund.test.ts']);
  });

  it(`caps test files at ${NODE_DETAIL_TESTED_BY_ROWS} with a "+N more" expander`, () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ file: `billing/f${i}.test.ts`, startLine: 1, endLine: 9 }));
    const elements = testedBySection({ tests: [], totalTests: 0, files });
    assert.equal(visibleButtons(elements).length, 5);
    const [expander] = expanders(elements);
    assert.ok(expander);
    const inside = renderTree(expander.props.children);
    assert.equal(textOf(inside.find((element) => element.type === 'summary')), '+2 more');
    assert.equal(inside.filter((element) => element.type === 'button').length, 2);
  });

  it('says "No test link found", muted, with no evidence, and never "untested"', () => {
    for (const testedBy of [undefined, { tests: [], totalTests: 0, files: [] }]) {
      const elements = testedBySection(testedBy);
      assert.equal(textOf(byClass(elements, 'code-map__node-detail-tested-by-none')), NO_TEST_LINK_FOUND);
      assert.equal(NO_TEST_LINK_FOUND, 'No test link found');
      assert.doesNotMatch(textOf(elements), /untested|not tested/i);
    }
  });

  it('never says "No test link found" while totalTests > 0', () => {
    const elements = testedBySection({ tests: [], totalTests: 4, files: [] });
    assert.equal(byClass(elements, 'code-map__node-detail-tested-by-none'), undefined);
    assert.equal(textOf(elements.find((element) => element.type === 'summary')), '+4 more');
  });

  it('survives a broken totalTests < tests.length (an invariant violation) by counting what is carried', () => {
    const tests = Array.from({ length: 7 }, (_, i) => testEntry(i + 1));
    const elements = testedBySection({ tests, totalTests: 2, files: [] });
    const summary = elements.find((element) => element.type === 'summary');
    assert.equal(textOf(summary), '+2 more', 'never a negative or missing count');
    assert.doesNotMatch(textOf(elements), /-\d+ more/);
  });
});

describe('openTestFromDetail', () => {
  it('opens the source viewer over Node detail, leaving Node detail open', () => {
    const calls: string[] = [];
    const target: SourceTarget = { file: 'billing/pay.test.ts', startLine: 10, endLine: 15, label: 'charges card 1' };
    let opened: SourceTarget | undefined;
    openTestFromDetail(target, {
      closeNodeDetail: () => calls.push('closeNodeDetail'),
      openSourceForNode: (t) => {
        calls.push('openSourceForNode');
        opened = t;
      },
    });
    assert.deepEqual(calls, ['openSourceForNode']);
    assert.equal(opened, target);
  });
});
