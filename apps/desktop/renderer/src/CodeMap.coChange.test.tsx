/**
 * Node detail's "Changes with" section — the files this Node's file has a
 * history of moving alongside.
 *
 * The section exists to answer a question structure cannot: which file should
 * have changed too. So it has to name the files, say how much history is
 * behind each, and say plainly that this is history and not a call. The
 * scenario is driller's own measured coupling: `packages/ipc-contracts`
 * moves with main, preload and the Graph Service.
 *
 * Hookless, rendered by calling it (`./testRender`), since the runner is
 * `node --test` with no DOM.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CoChangingFile, CodeMapNode } from '@driller/ipc-contracts';

import {
  CO_CHANGE_DISCLAIMER,
  coChangeHeading,
  formatCoChange,
  NODE_DETAIL_CO_CHANGE_ROWS,
  NodeDetailBody,
  NODE_DETAIL_SECTION_HEADING_IDS,
  type NodeDetailBodyProps,
} from './CodeMap';
import { renderTree, textOf } from './testRender';

const noop = () => {};

const MAIN = 'apps/desktop/main/index.ts';
const PRELOAD = 'apps/desktop/preload/index.ts';
const SERVICE = 'services/graph-service/index.ts';

const BOUNDARY: CoChangingFile[] = [
  { file: SERVICE, coChanges: 34, score: 0.74 },
  { file: MAIN, coChanges: 32, score: 0.89 },
  { file: PRELOAD, coChanges: 27, score: 1 },
];

function makeNode(overrides: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id: 'packages/ipc-contracts/src/index.ts::IpcChannels',
    name: 'IpcChannels',
    file: 'packages/ipc-contracts/src/index.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'The IPC channel names.',
    riskSignals: [],
    ...overrides,
  };
}

const body = (node: CodeMapNode) =>
  renderTree(
    NodeDetailBody({
      node,
      toggles: { showDeterministicSignals: true, showLlmJudgment: true, showIngestedFindings: true },
      onOpenSource: noop,
      onRegenerate: noop,
      regenerateState: { kind: 'idle' },
    } as unknown as NodeDetailBodyProps),
  );

describe('Node detail says which files this one moves with', () => {
  it('names each file, strongest coupling first', () => {
    const text = textOf(body(makeNode({ coChangesWith: BOUNDARY, coChangesWithTotal: 3 })));
    for (const file of [SERVICE, MAIN, PRELOAD]) {
      assert.ok(text.includes(file), `names ${file}`);
    }
    assert.ok(text.indexOf(SERVICE) < text.indexOf(PRELOAD), 'most shared commits first');
  });

  it('heads the section with the full count', () => {
    assert.equal(coChangeHeading({ coChangesWith: BOUNDARY, coChangesWithTotal: 3 }), 'Changes with (3)');
    assert.equal(coChangeHeading({ coChangesWith: BOUNDARY.slice(0, 2), coChangesWithTotal: 9 }), 'Changes with (9)');
  });

  it('states the history behind each file, never a bare score', () => {
    const shown = formatCoChange({ file: MAIN, coChanges: 32, score: 0.89 });
    assert.match(shown, /32/, 'says how many commits touched both');
    assert.doesNotMatch(shown, /%/, 'never a percentage driller did not compute');
  });

  it('says plainly that this is history, not a call', () => {
    assert.match(CO_CHANGE_DISCLAIMER, /histor/i);
    assert.doesNotMatch(CO_CHANGE_DISCLAIMER, /depend|import|call(s|ed)\b/i, 'must not imply a structural link');
    assert.ok(textOf(body(makeNode({ coChangesWith: BOUNDARY, coChangesWithTotal: 3 }))).includes(CO_CHANGE_DISCLAIMER));
  });

  it('is absent entirely when the file moves with nothing', () => {
    const text = textOf(body(makeNode()));
    assert.ok(!text.includes('Changes with'), 'no empty section, no "0"');
  });

  it('has its own heading id, like every other section', () => {
    assert.equal(typeof NODE_DETAIL_SECTION_HEADING_IDS.coChange, 'string');
    assert.ok(NODE_DETAIL_SECTION_HEADING_IDS.coChange.length > 0);
  });

  it('caps the rows and offers the rest behind one control', () => {
    const many: CoChangingFile[] = Array.from({ length: NODE_DETAIL_CO_CHANGE_ROWS + 3 }, (_unused, index) => ({
      file: `apps/desktop/other${index}.ts`,
      coChanges: 20 - index,
      score: 0.9,
    }));
    const text = textOf(body(makeNode({ coChangesWith: many, coChangesWithTotal: many.length })));
    assert.ok(text.includes('+3 more'), `expected a "+3 more" control, got: ${text.slice(0, 400)}`);
  });
});
