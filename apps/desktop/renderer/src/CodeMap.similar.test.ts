/**
 * P4-2 phase 4: Node detail's "Similar implementations" section — present
 * only with `similarTo`, "Similar implementations (N)", rows naming the
 * Node, its file and "similarity 1.00", navigating the map, capped at 5 plus
 * "+N more", and always the honest-copy line. Hookless, rendered by calling
 * it (`./testRender`), since the runner is `node --test` with no DOM.
 *
 * What this cannot reach: the panel's layout and focus — owed in-app checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapNode, SimilarImplementation } from '@driller/ipc-contracts';

import {
  formatSimilarity,
  NODE_DETAIL_SECTION_HEADING_IDS,
  NODE_DETAIL_SIMILAR_ROWS,
  NodeDetailBody,
  NOT_ON_CURRENT_MAP,
  SIMILARITY_DISCLAIMER,
  type NodeDetailBodyProps,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

const noop = () => {};

function makeNode(overrides: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id: 'services/graph-service/mcp-client.withTimeout',
    name: 'withTimeout',
    file: 'services/graph-service/mcp-client.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Races a promise against a timer.',
    riskSignals: [],
    ...overrides,
  };
}

const WITH_TIMEOUT_COPIES: SimilarImplementation[] = [
  'cloud-summary-generator',
  'judgment-generator',
  'model-manager',
  'summary-generator',
].map((file) => ({
  id: `services/graph-service/${file}.withTimeout`,
  name: 'withTimeout',
  file: `services/graph-service/${file}.ts`,
  score: 1,
}));

function renderBody(overrides: Partial<NodeDetailBodyProps> = {}): RenderedElement[] {
  const props: NodeDetailBodyProps = {
    node: makeNode(),
    toggles: { showDeterministicSignals: true, showLlmJudgment: true, showIngestedFindings: true },
    cloudSelectedNoKey: false,
    noSummaryBackendAvailable: false,
    summaryAction: null,
    regenerateState: { kind: 'idle' },
    graphServiceAvailable: true,
    onRegenerate: noop,
    onOpenTest: noop,
    ...overrides,
  };
  return renderTree(NodeDetailBody(props));
}

const headings = (elements: RenderedElement[]) =>
  elements.filter((element) => element.type === 'h3').map((heading) => textOf(heading));

function section(elements: RenderedElement[]): RenderedElement[] {
  const found = elements.find(
    (element) => element.type === 'section' && element.props['aria-labelledby'] === NODE_DETAIL_SECTION_HEADING_IDS.similar,
  );
  assert.ok(found, 'the Similar implementations section renders');
  return renderTree(found.props.children);
}

/** The first list's elements — what shows before "+N more" is opened (the continued list sits inside `<details>`). */
function visible(elements: RenderedElement[]): RenderedElement[] {
  const list = elements.find((element) => element.type === 'ul' && element.props.className === 'code-map__node-detail-similar');
  assert.ok(list, 'the visible list');
  return renderTree(list.props.children);
}

const items = (elements: RenderedElement[]) =>
  elements.filter((element) => element.type === 'li').map((item) => textOf(item).replaceAll(` (${NOT_ON_CURRENT_MAP})`, ''));

const buttons = (elements: RenderedElement[]) => elements.filter((element) => element.type === 'button');

const onMap = (id: string) => (id.includes('model-manager') ? undefined : { name: 'withTimeout' });

describe('NodeDetailBody: Similar implementations', () => {
  it('withTimeout in 5 files: the section lists the 4 others at 1.00, with the honest-copy line', () => {
    const elements = renderBody({
      node: makeNode({ similarTo: WITH_TIMEOUT_COPIES, similarToTotal: 4 }),
      resolveMapNode: onMap,
    });
    assert.deepEqual(headings(elements), [
      'Summary',
      'Risk Overlay',
      'Tested by',
      'Similar implementations (4)',
      'Staleness',
      'Location',
    ]);
    const inside = section(elements);
    assert.deepEqual(items(inside), [
      'withTimeout services/graph-service/cloud-summary-generator.ts similarity 1.00',
      'withTimeout services/graph-service/judgment-generator.ts similarity 1.00',
      'withTimeout services/graph-service/model-manager.ts similarity 1.00',
      'withTimeout services/graph-service/summary-generator.ts similarity 1.00',
    ]);
    assert.ok(inside.some((element) => element.type === 'p' && textOf(element) === SIMILARITY_DISCLAIMER));
    assert.equal(SIMILARITY_DISCLAIMER, 'Similarity is structural (token overlap), not a claim they behave the same.');
    // Facts only: no recommendation wording anywhere in the section.
    assert.doesNotMatch(inside.map(textOf).join(' '), /abstraction|refactor|should|could share|merge/i);
  });

  it('is absent without similarTo (an old index) or with an empty list', () => {
    for (const node of [makeNode(), makeNode({ similarTo: [], similarToTotal: 0 })]) {
      assert.ok(!headings(renderBody({ node })).some((heading) => heading.startsWith('Similar implementations')));
    }
  });

  it('each row on the map navigates to that Node; one the map lacks is named, not a link', () => {
    const navigated: string[] = [];
    const inside = section(
      renderBody({
        node: makeNode({ similarTo: WITH_TIMEOUT_COPIES, similarToTotal: 4 }),
        resolveMapNode: onMap,
        onNavigateToNode: (id) => navigated.push(id),
      }),
    );
    const links = buttons(inside);
    assert.equal(links.length, 3, 'model-manager is not on the map');
    assert.equal(
      links[0]?.props['aria-label'],
      'Go to withTimeout in services/graph-service/cloud-summary-generator.ts (similarity 1.00)',
    );
    (links[1]?.props.onClick as () => void)();
    assert.deepEqual(navigated, ['services/graph-service/judgment-generator.withTimeout']);
    const unlinked = inside.find((element) => element.props.title === NOT_ON_CURRENT_MAP);
    assert.equal(textOf(unlinked).replace(` (${NOT_ON_CURRENT_MAP})`, ''), 'withTimeout');
  });

  it(`shows ${NODE_DETAIL_SIMILAR_ROWS} rows, then "+N more" counted against the full total`, () => {
    const many = Array.from({ length: 20 }, (_, i): SimilarImplementation => ({
      id: `f${i}`,
      name: `f${i}`,
      file: `src/f${i}.ts`,
      score: 0.9,
    }));
    const elements = section(renderBody({ node: makeNode({ similarTo: many, similarToTotal: 27 }) }));
    assert.equal(headings(renderBody({ node: makeNode({ similarTo: many, similarToTotal: 27 }) }))[3], 'Similar implementations (27)');
    assert.deepEqual(
      items(visible(elements)),
      ['f0', 'f1', 'f2', 'f3', 'f4'].map((name) => `${name} src/${name}.ts similarity 0.90`),
    );
    const details = elements.find((element) => element.type === 'details');
    assert.ok(details);
    const hidden = renderTree(details.props.children);
    assert.equal(textOf(hidden.find((element) => element.type === 'summary')), '+22 more');
    assert.equal(items(hidden).length, 15);
    assert.ok(hidden.some((element) => textOf(element) === 'Showing the first 20 of 27.'));
  });

  it('no "+N more" at exactly 5; the total never reads below what is carried', () => {
    const five = WITH_TIMEOUT_COPIES.concat({ ...WITH_TIMEOUT_COPIES[0]!, id: 'x', file: 'src/x.ts', score: 0.95 });
    const elements = renderBody({ node: makeNode({ similarTo: five, similarToTotal: 1 }) });
    assert.ok(headings(elements).includes('Similar implementations (5)'));
    assert.equal(section(elements).filter((element) => element.type === 'details').length, 0);
  });

  it('formats the score to two decimals', () => {
    assert.equal(formatSimilarity(1), 'similarity 1.00');
    assert.equal(formatSimilarity(0.953), 'similarity 0.95');
    assert.equal(formatSimilarity(0.998), 'similarity 0.99');
    assert.equal(formatSimilarity(0.9), 'similarity 0.90');
  });
});
