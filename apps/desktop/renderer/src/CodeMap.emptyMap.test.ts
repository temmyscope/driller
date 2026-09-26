/**
 * P2-5: an empty map says why, and offers the one action that fixes it —
 * "Edit indexing scope" when the scope filter hid every Node, "Re-index"
 * when the project genuinely has none.
 *
 * `EmptyMapNotice` is hookless and rendered here by calling it and walking
 * the returned elements — the same `renderTree` approach as
 * `ActionableNotice.test.ts`, since the runner is `node --test` with no DOM.
 *
 * What this cannot reach: CodeMap's wiring of the pending snapshot and the
 * Settings focus on open — owed in-app checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_MAP_NO_NODES_SENTENCE,
  EmptyMapNotice,
  chooseEmptyMapCase,
  emptyMapScopeSentence,
  isReindexPending,
  reindexButtonState,
  type FetchState,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

function byClass(elements: RenderedElement[], className: string): RenderedElement | undefined {
  return elements.find((element) => element.props.className === className);
}

const noop = () => {};

function render(props: Partial<Parameters<typeof EmptyMapNotice>[0]>) {
  const elements = renderTree(
    EmptyMapNotice({
      hiddenByScope: 0,
      appliedScope: [],
      graphServiceAvailable: true,
      reindexPending: false,
      onOpenSettings: noop,
      onReindex: noop,
      ...props,
    }),
  );
  return {
    elements,
    notice: byClass(elements, 'actionable-notice actionable-notice--info'),
    sentence: textOf(byClass(elements, 'actionable-notice__text')?.props.children),
    buttons: elements.filter((element) => element.type === 'button'),
  };
}

describe('chooseEmptyMapCase', () => {
  it('a scope that removed Nodes is the scope case, carrying the count', () => {
    assert.deepEqual(chooseEmptyMapCase(229), { kind: 'scope-hid-everything', hiddenCount: 229 });
  });

  it('nothing removed by a scope is the genuinely-empty case', () => {
    assert.deepEqual(chooseEmptyMapCase(0), { kind: 'no-map-eligible-nodes' });
  });
});

describe('emptyMapScopeSentence', () => {
  it('names the applied scope and the hidden count', () => {
    assert.equal(
      emptyMapScopeSentence(['web', 'app'], 229),
      "The indexing scope (web, app) matches none of this project's 229 Nodes.",
    );
    assert.equal(emptyMapScopeSentence(['wbe'], 229), "The indexing scope (wbe) matches none of this project's 229 Nodes.");
  });

  it('omits the list for an empty scope, and says "1 Node" in the singular', () => {
    assert.equal(emptyMapScopeSentence([], 1), "The indexing scope matches none of this project's 1 Node.");
  });
});

describe('EmptyMapNotice: scope hid everything', () => {
  it('is an info notice naming the applied scope, with one "Edit indexing scope" action that opens Settings', () => {
    const onOpenSettings = () => {};
    const { notice, sentence, buttons } = render({ hiddenByScope: 229, appliedScope: ['wbe'], onOpenSettings });
    assert.ok(notice);
    assert.equal(sentence, "The indexing scope (wbe) matches none of this project's 229 Nodes.");
    assert.equal(buttons.length, 1);
    assert.equal(textOf(buttons[0]?.props.children), 'Edit indexing scope');
    assert.equal(buttons[0]?.props.onClick, onOpenSettings);
  });

  it('stays enabled while the Graph Service is down — Settings needs no Graph Service', () => {
    const { buttons } = render({ hiddenByScope: 3, graphServiceAvailable: false });
    assert.equal(buttons[0]?.props.disabled, undefined);
  });
});

describe('EmptyMapNotice: the project genuinely has none', () => {
  it('keeps the existing sentence and offers one "Re-index" action', () => {
    const onReindex = () => {};
    const { notice, sentence, buttons } = render({ hiddenByScope: 0, onReindex });
    assert.ok(notice);
    assert.equal(sentence, EMPTY_MAP_NO_NODES_SENTENCE);
    assert.equal(
      EMPTY_MAP_NO_NODES_SENTENCE,
      'This project has no map-eligible Nodes (no Function/Interface/Type/Module found).',
    );
    assert.equal(buttons.length, 1);
    assert.equal(textOf(buttons[0]?.props.children), 'Re-index');
    assert.equal(buttons[0]?.props.onClick, onReindex);
    assert.equal(buttons[0]?.props.disabled, false);
    assert.equal(buttons[0]?.props.title, undefined);
  });

  it('disables Re-index with the unavailable treatment while the Graph Service is down', () => {
    const { buttons } = render({ hiddenByScope: 0, graphServiceAvailable: false });
    assert.equal(buttons[0]?.props.disabled, true);
    assert.equal(buttons[0]?.props.className, 'code-map__action--service-unavailable');
    assert.ok(typeof buttons[0]?.props.title === 'string' && (buttons[0]?.props.title as string).length > 0);
  });

  it('shows "Re-indexing…" and is disabled while a Re-index is pending', () => {
    const { buttons } = render({ hiddenByScope: 0, reindexPending: true });
    assert.equal(textOf(buttons[0]?.props.children), 'Re-indexing…');
    assert.equal(buttons[0]?.props.disabled, true);
  });
});

describe('EmptyMapNotice: live regions', () => {
  it('carries no role of its own in either case — its call site is the role="status" region', () => {
    for (const hiddenByScope of [0, 5]) {
      const { elements } = render({ hiddenByScope });
      assert.ok(elements.every((element) => element.props.role === undefined));
    }
  });
});

describe('reindexButtonState', () => {
  it('is enabled only when the Graph Service is live and no Re-index is pending', () => {
    assert.equal(reindexButtonState({ graphServiceAvailable: true, reindexPending: false }).disabled, false);
    assert.equal(reindexButtonState({ graphServiceAvailable: true, reindexPending: true }).disabled, true);
    assert.equal(reindexButtonState({ graphServiceAvailable: false, reindexPending: false }).disabled, true);
    assert.equal(reindexButtonState({ graphServiceAvailable: false, reindexPending: true }).disabled, true);
  });
});

describe('isReindexPending', () => {
  const empty: FetchState = { status: 'ready', nodes: [], edges: [], hiddenByScope: 0, appliedScope: [] };

  it('is pending while the screen still shows what it showed at the click', () => {
    const click = { fetchState: empty, refreshError: null };
    assert.equal(isReindexPending(click, { fetchState: empty, refreshError: null }), true);
  });

  it('ends on the next fetchState change', () => {
    const next: FetchState = { ...empty };
    assert.equal(isReindexPending({ fetchState: empty, refreshError: null }, { fetchState: next, refreshError: null }), false);
  });

  it('ends on a refresh error', () => {
    assert.equal(
      isReindexPending({ fetchState: empty, refreshError: null }, { fetchState: empty, refreshError: 'timed out' }),
      false,
    );
  });

  it('is not pending with no click (or after a failed restart cleared it)', () => {
    assert.equal(isReindexPending(null, { fetchState: empty, refreshError: null }), false);
  });
});
