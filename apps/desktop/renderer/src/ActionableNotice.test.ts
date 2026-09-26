/**
 * P1-7: the one Actionable Notice shape — a per-tone glyph (never colour
 * alone), one sentence, at most one action.
 *
 * `ActionableNotice` is hookless and rendered here by calling it and walking
 * the returned elements — the same `renderTree` approach as
 * `CodeMap.prReviewNotice.test.ts`, since the runner is `node --test` with no
 * DOM (`docs/agent.md`).
 *
 * What this cannot reach: the visual pass (light/dark, greyscale, minimum
 * width) and VoiceOver actually reading the prefix — owed in-app checks.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

import {
  ACTIONABLE_NOTICE_GLYPHS,
  ACTIONABLE_NOTICE_SPOKEN_PREFIX,
  ActionableNotice,
  type ActionableNoticeTone,
} from './ActionableNotice';
import { DegradedSessionNotice } from './App';
import { DETERMINISTIC_SIGNAL_ICONS, RefreshErrorNotice, SEVERE_SIGNAL_GLYPH } from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

const TONES: ActionableNoticeTone[] = ['progress', 'info', 'warning', 'error'];

function byClass(elements: RenderedElement[], className: string): RenderedElement | undefined {
  return elements.find((element) => element.props.className === className);
}

describe('ActionableNotice: each tone', () => {
  for (const tone of TONES) {
    it(`"${tone}" renders its class, its aria-hidden glyph and its spoken prefix`, () => {
      const elements = renderTree(ActionableNotice({ tone, children: 'Something happened.' }));
      const root = elements[0];
      assert.ok(root);
      assert.equal(root.props.className, `actionable-notice actionable-notice--${tone}`);

      const glyph = byClass(elements, 'actionable-notice__glyph');
      assert.ok(glyph, 'glyph');
      assert.equal(glyph.props['aria-hidden'], 'true');
      assert.equal(textOf(glyph), ACTIONABLE_NOTICE_GLYPHS[tone]);

      const text = byClass(elements, 'actionable-notice__text');
      assert.ok(text, 'sentence');
      const hidden = byClass(elements, 'visually-hidden');
      const prefix = ACTIONABLE_NOTICE_SPOKEN_PREFIX[tone];
      if (prefix === null) {
        assert.equal(hidden, undefined, 'no spoken prefix');
        assert.equal(textOf(text), 'Something happened.');
      } else {
        assert.ok(hidden, 'spoken prefix');
        assert.equal(textOf(text), `${prefix} Something happened.`);
      }
    });
  }

  it('speaks "Warning:" and "Error:", and nothing for info/progress', () => {
    assert.equal(ACTIONABLE_NOTICE_SPOKEN_PREFIX.warning, 'Warning:');
    assert.equal(ACTIONABLE_NOTICE_SPOKEN_PREFIX.error, 'Error:');
    assert.equal(ACTIONABLE_NOTICE_SPOKEN_PREFIX.info, null);
    assert.equal(ACTIONABLE_NOTICE_SPOKEN_PREFIX.progress, null);
  });

  it('renders the warning glyph in text presentation (U+FE0E)', () => {
    assert.ok(ACTIONABLE_NOTICE_GLYPHS.warning.endsWith('\uFE0E'));
  });
});

describe('ActionableNotice: the action slot', () => {
  it('is absent when no action is given', () => {
    const elements = renderTree(ActionableNotice({ tone: 'info', children: 'No path found for that query.' }));
    assert.equal(byClass(elements, 'actionable-notice__action'), undefined);
  });

  for (const [name, action] of [
    ['null', null],
    ['false', false],
    ['true', true],
    ["''", ''],
  ] as const) {
    it(`is absent for an empty action (${name})`, () => {
      const elements = renderTree(ActionableNotice({ tone: 'warning', children: 'Unavailable.', action }));
      assert.equal(byClass(elements, 'actionable-notice__action'), undefined);
    });
  }

  it('is absent for a stray number, which the type also rejects', () => {
    // @ts-expect-error — `0` is not an action (a leaked `count && <button>`).
    const elements = renderTree(ActionableNotice({ tone: 'warning', children: 'Unavailable.', action: 0 }));
    assert.equal(byClass(elements, 'actionable-notice__action'), undefined);
  });

  it('holds the one action, after the sentence', () => {
    const action = createElement('button', { type: 'button', 'aria-label': 'Retry the Graph Service' }, 'Retry');
    const elements = renderTree(ActionableNotice({ tone: 'warning', children: 'Unavailable.', action }));
    const slot = byClass(elements, 'actionable-notice__action');
    assert.ok(slot);
    assert.equal(slot.props.children, action);
    const order = elements.map((element) => element.props.className);
    assert.ok(order.indexOf('actionable-notice__text') < order.indexOf('actionable-notice__action'));
  });

  it('passes the call site role through to the root', () => {
    const [root] = renderTree(ActionableNotice({ tone: 'error', children: 'boom', role: 'alert' }));
    assert.equal(root?.props.role, 'alert');
  });

  it('gives the root no role when none is given', () => {
    const [root] = renderTree(ActionableNotice({ tone: 'error', children: 'boom' }));
    assert.equal(root?.props.role, undefined);
  });

  it('wraps the sentence in a span, so the notice holds only valid phrasing content', () => {
    const text = byClass(renderTree(ActionableNotice({ tone: 'info', children: 'x' })), 'actionable-notice__text');
    assert.equal(text?.type, 'span');
  });
});

// ---------------------------------------------------------------------------
// The two Retry notices whose names must never collide (P0-3 follow-up)
// ---------------------------------------------------------------------------

function buttonsIn(node: unknown): RenderedElement[] {
  return renderTree(node).filter((element) => element.type === 'button');
}

describe('DegradedSessionNotice', () => {
  const noop = () => {};

  it('is a warning whose Retry is named "Retry the Graph Service"', () => {
    const elements = renderTree(DegradedSessionNotice({ showRetry: true, onRetry: noop }));
    assert.equal(elements[1]?.props.className, 'actionable-notice actionable-notice--warning');
    const buttons = buttonsIn(DegradedSessionNotice({ showRetry: true, onRetry: noop }));
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]?.props['aria-label'], 'Retry the Graph Service');
    assert.equal(buttons[0]?.props.onClick, noop);
  });

  it('has no Retry and no action slot when showRetry is false', () => {
    const elements = renderTree(DegradedSessionNotice({ showRetry: false, onRetry: noop }));
    assert.equal(buttonsIn(DegradedSessionNotice({ showRetry: false, onRetry: noop })).length, 0);
    assert.equal(byClass(elements, 'actionable-notice__action'), undefined);
  });
});

describe('RefreshErrorNotice', () => {
  const noop = () => {};

  it('names its Retry "Retry the map refresh" and carries the message', () => {
    const node = RefreshErrorNotice({ graphServiceAvailable: true, message: 'timed out', onRetry: noop });
    const [button] = buttonsIn(node);
    assert.equal(button?.props['aria-label'], 'Retry the map refresh');
    assert.equal(button?.props.onClick, noop);
    assert.equal(button?.props.disabled, false);
    assert.equal(button?.props.title, undefined);
    assert.ok(textOf(node).includes('(timed out)'));
  });

  it('disables the Retry, with a title, while the Graph Service is unavailable', () => {
    const [button] = buttonsIn(RefreshErrorNotice({ graphServiceAvailable: false, message: 'x', onRetry: noop }));
    assert.equal(button?.props.disabled, true);
    assert.equal(typeof button?.props.title, 'string');
    assert.ok((button?.props.title as string).length > 0);
    assert.equal(button?.props.className, 'code-map__action--service-unavailable');
  });

  it('never shares an accessible name with the degraded-session Retry', () => {
    const [refresh] = buttonsIn(RefreshErrorNotice({ graphServiceAvailable: true, message: 'x', onRetry: noop }));
    const [session] = buttonsIn(DegradedSessionNotice({ showRetry: true, onRetry: noop }));
    assert.notEqual(refresh?.props['aria-label'], session?.props['aria-label']);
  });
});

describe('ACTIONABLE_NOTICE_GLYPHS', () => {
  const glyphs = TONES.map((tone) => ACTIONABLE_NOTICE_GLYPHS[tone]);

  it('gives every tone a distinct glyph', () => {
    assert.equal(new Set(glyphs).size, TONES.length);
  });

  it('never matches a deterministic signal icon or the severe glyph', () => {
    const taken = new Set<string>([...Object.values(DETERMINISTIC_SIGNAL_ICONS), SEVERE_SIGNAL_GLYPH]);
    for (const glyph of glyphs) {
      assert.equal(taken.has(glyph), false, `${glyph} collides`);
      assert.equal(taken.has(glyph.replace('\uFE0E', '')), false, `${glyph} collides without its selector`);
    }
  });
});

// ---------------------------------------------------------------------------
// The grep gate, automated: no hand-built notice markup comes back
// ---------------------------------------------------------------------------

describe('renderer source', () => {
  it('has no `notice notice--` markup left in any .tsx file', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir).filter((name) => name.endsWith('.tsx'));
    assert.ok(files.length > 0, 'found the renderer .tsx files');
    const offenders = files.filter((name) => readFileSync(`${dir}/${name}`, 'utf8').includes('notice notice--'));
    assert.deepEqual(offenders, []);
  });
});
