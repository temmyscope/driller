/**
 * P3-8: the Path Trace search row's `trace>` prompt and block cursor.
 *
 * Renders the hookless `PathTraceSearchRow` by calling it as a plain function
 * (see `testRender.ts`). What this pins: the field is a `<label>` wrapping the
 * input; its children read prompt, cursor, input (`trace> █ placeholder`);
 * both decorations are `aria-hidden`; the cursor is not rendered while the
 * Graph Service is down; the input keeps its accessible name and its
 * no-autocorrect attributes; and the search wiring (value, change, submit,
 * disabled rules, button label and unavailable title/class) is the pre-P3-8
 * form's.
 *
 * What it cannot reach (no DOM, no CSS engine): that the cursor actually
 * blinks, hides on focus / when non-empty / when disabled, or holds still
 * under `prefers-reduced-motion` — those live in styles.css and were checked
 * with a static headless-Chrome render instead.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PATH_TRACE_PLACEHOLDER, PathTraceSearchRow } from './CodeMap';
import { isRenderedElement, renderTree, textOf, type RenderedElement } from './testRender';

type RowProps = Parameters<typeof PathTraceSearchRow>[0];

function render(overrides: Partial<RowProps> = {}): RenderedElement[] {
  const props: RowProps = {
    query: '',
    onQueryChange: () => {},
    onSubmit: () => {},
    searching: false,
    graphServiceAvailable: true,
    ...overrides,
  };
  return renderTree(PathTraceSearchRow(props));
}

/** True when `className` contains `token` as a whole class, not a substring. */
function hasClass(element: RenderedElement, token: string): boolean {
  const className = element.props.className;
  return typeof className === 'string' && className.split(/\s+/).includes(token);
}

function findByClass(tree: RenderedElement[], token: string): RenderedElement | undefined {
  return tree.find((el) => hasClass(el, token));
}

function byClass(tree: RenderedElement[], token: string): RenderedElement {
  const found = findByClass(tree, token);
  assert.ok(found, `expected an element with class ${token}`);
  return found;
}

function byType(tree: RenderedElement[], type: string): RenderedElement {
  const found = tree.find((el) => el.type === type);
  assert.ok(found, `expected a <${type}>`);
  return found;
}

/** An element's direct element children, flattened, with `false`/`null` holes dropped. */
function elementChildren(element: RenderedElement): RenderedElement[] {
  const children = element.props.children;
  return (Array.isArray(children) ? children.flat(Infinity) : [children]).filter(isRenderedElement);
}

describe('PathTraceSearchRow', () => {
  it('reads `trace> █ input` inside one <label> field, decorations aria-hidden', () => {
    const tree = render();
    const field = byClass(tree, 'code-map__path-trace-field');
    assert.equal(field.type, 'label');

    const [prompt, cursor, input, ...rest] = elementChildren(field);
    assert.equal(rest.length, 0);
    assert.ok(prompt && hasClass(prompt, 'code-map__path-trace-prompt'));
    assert.equal(textOf(prompt), 'trace>');
    assert.equal(prompt.props['aria-hidden'], 'true');
    assert.ok(cursor && hasClass(cursor, 'code-map__path-trace-cursor'));
    assert.equal(cursor.props['aria-hidden'], 'true');
    assert.equal(input?.type, 'input');
  });

  it('is a labelled search landmark, not a toolbar', () => {
    const form = byType(render(), 'form');
    assert.equal(form.props.role, 'search');
    assert.equal(form.props['aria-label'], 'Search a traced path');
  });

  it('keeps the input’s accessible name and turns off spellcheck/autocorrect', () => {
    const input = byType(render(), 'input');
    assert.equal(input.props['aria-label'], 'Path Trace query');
    assert.equal(input.props.placeholder, PATH_TRACE_PLACEHOLDER);
    assert.equal(input.props.spellCheck, false);
    assert.equal(input.props.autoComplete, 'off');
    assert.equal(input.props.autoCapitalize, 'off');
    assert.equal(input.props.autoCorrect, 'off');
  });

  it('keeps the search wiring: value, change, submit, and disabled-while-searching', () => {
    let changed = '';
    const onSubmit = () => {};
    const tree = render({ query: 'charge', onQueryChange: (q) => (changed = q), onSubmit });
    assert.equal(byType(tree, 'form').props.onSubmit, onSubmit);
    const input = byType(tree, 'input');
    assert.equal(input.props.value, 'charge');
    (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'x' } });
    assert.equal(changed, 'x');
    assert.equal(input.props.disabled, false);
    assert.equal(textOf(byType(tree, 'button')), 'Trace');

    const searchingTree = render({ searching: true });
    assert.equal(byType(searchingTree, 'input').props.disabled, true);
    const button = byType(searchingTree, 'button');
    assert.equal(button.props.disabled, true);
    assert.equal(textOf(button), 'Searching…');
  });

  it('with the Graph Service down: button disabled with its unavailable title/class, input enabled, no cursor', () => {
    const tree = render({ graphServiceAvailable: false });
    const button = byType(tree, 'button');
    assert.equal(button.props.disabled, true);
    assert.equal(textOf(button), 'Trace');
    assert.equal(typeof button.props.title, 'string');
    assert.match(button.props.title as string, /Graph Service is not live/);
    assert.ok(hasClass(button, 'code-map__action--service-unavailable'));
    assert.equal(byType(tree, 'input').props.disabled, false);
    assert.equal(findByClass(tree, 'code-map__path-trace-cursor'), undefined);
  });

  it('with the Graph Service live: the button carries no unavailable title/class', () => {
    const button = byType(render(), 'button');
    assert.equal(button.props.title, undefined);
    assert.equal(button.props.className, undefined);
  });
});
