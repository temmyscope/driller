/**
 * P2-2: the header mode switcher is disabled (never hidden) until a project
 * is open, with a visible hint tied to the group and each radio via
 * `aria-describedby`.
 *
 * `ModeSwitcher` is hookless and rendered here by calling it and walking the
 * returned elements — the same `renderTree` approach as
 * `ActionableNotice.test.ts`, since the runner is `node --test` with no DOM.
 *
 * What this cannot reach: the muted visual treatment, the browser reverting a
 * keyboard arrow-press on a controlled radio, and a screen reader actually
 * announcing the hint — owed in-app checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapMode } from './CodeMap';
import { MODE_SWITCHER_HINT_ID, MODE_SWITCHER_LABELS, MODE_SWITCHER_OPTIONS, ModeSwitcher } from './ModeSwitcher';

type Mode = CodeMapMode;

interface RenderedElement {
  type: unknown;
  props: Record<string, unknown>;
}

function isRenderedElement(value: unknown): value is RenderedElement {
  return typeof value === 'object' && value !== null && '$$typeof' in value && 'type' in value && 'props' in value;
}

function childrenOf(element: RenderedElement): unknown {
  return typeof element.type === 'function'
    ? (element.type as (props: Record<string, unknown>) => unknown)(element.props)
    : element.props.children;
}

function renderTree(node: unknown, out: RenderedElement[] = []): RenderedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      renderTree(child, out);
    }
    return out;
  }
  if (!isRenderedElement(node)) {
    return out;
  }
  out.push(node);
  renderTree(childrenOf(node), out);
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  if (!isRenderedElement(node)) {
    return '';
  }
  return textOf(childrenOf(node));
}

const ALL_MODES = MODE_SWITCHER_OPTIONS.map((option) => option.value);

function render(enabled: boolean, mode: Mode, onChange: (mode: Mode) => void = () => {}) {
  const elements = renderTree(ModeSwitcher({ mode, enabled, onChange }));
  const group = elements.find((element) => element.props.role === 'radiogroup');
  const labels = elements.filter((element) => element.props.className === 'mode-switcher__option');
  const inputs = elements.filter((element) => element.type === 'input');
  const hint = elements.find((element) => element.props.className === 'mode-switcher__hint');
  assert.ok(group, 'the radiogroup renders');
  return { group, labels, inputs, hint };
}

function checkedValues(inputs: RenderedElement[]): unknown[] {
  return inputs.filter((input) => input.props.checked === true).map((input) => input.props.value);
}

describe('ModeSwitcher: options', () => {
  it('renders one radio per mode, each with its visible label, all sharing one name', () => {
    for (const enabled of [true, false]) {
      const { labels, inputs } = render(enabled, 'codeMap');
      assert.deepEqual(
        inputs.map((input) => input.props.value),
        ALL_MODES,
      );
      assert.deepEqual(
        labels.map((label) => textOf(label)),
        ['Code Map', 'PR Review Mode', 'Health Audit Mode'],
      );
      assert.deepEqual(
        labels.map((label) => textOf(label)),
        ALL_MODES.map((value) => MODE_SWITCHER_LABELS[value]),
      );
      assert.equal(new Set(inputs.map((input) => input.props.name)).size, 1);
      assert.equal(typeof inputs[0]?.props.name, 'string');
    }
  });
});

describe('ModeSwitcher: no project open', () => {
  it('marks every radio aria-disabled and described by the hint, keeping the checked one', () => {
    const { group, inputs, hint } = render(false, 'codeMap');
    assert.ok(hint, 'the hint is shown');
    assert.equal(textOf(hint), 'Open a project to switch views');
    assert.equal(hint.props.id, MODE_SWITCHER_HINT_ID);
    assert.equal(group.props['aria-describedby'], MODE_SWITCHER_HINT_ID);
    for (const input of inputs) {
      assert.equal(input.props['aria-disabled'], true, `${String(input.props.value)} is aria-disabled`);
      assert.equal(input.props['aria-describedby'], MODE_SWITCHER_HINT_ID);
      assert.notEqual(input.props.disabled, true, 'stays focusable (no native disabled)');
    }
    assert.deepEqual(checkedValues(inputs), ['codeMap']);
  });

  it('ignores a pick on any radio', () => {
    const picked: Mode[] = [];
    const { inputs } = render(false, 'codeMap', (mode) => picked.push(mode));
    for (const input of inputs) {
      (input.props.onChange as () => void)();
    }
    assert.deepEqual(picked, []);
  });
});

describe('ModeSwitcher: project open', () => {
  it('drops the hint and both aria attributes, and wires onChange to each value', () => {
    const picked: Mode[] = [];
    const { group, inputs, hint } = render(true, 'prReview', (mode) => picked.push(mode));
    assert.equal(hint, undefined);
    assert.equal(group.props['aria-describedby'], undefined);
    assert.deepEqual(checkedValues(inputs), ['prReview']);
    for (const input of inputs) {
      assert.equal(input.props['aria-disabled'], undefined);
      assert.equal(input.props['aria-describedby'], undefined);
      (input.props.onChange as () => void)();
    }
    assert.deepEqual(picked, ALL_MODES);
  });
});
