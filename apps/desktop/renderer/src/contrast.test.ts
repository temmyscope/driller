/**
 * P3-13: `contrastRatio` against known WCAG values, then `styles.css` itself:
 * every definition of `--border-control` must hold 3:1 (WCAG 1.4.11) against
 * every definition of the surfaces a control sits on; every control whose
 * edge is its only cue must edge with it (and no state rule may walk it back
 * to a decorative token); no other pointer/input/button rule may edge with a
 * decorative token; and hover never goes dimmer than the resting edge.
 *
 * What this cannot reach: native checkbox/radio edges, which Chromium draws
 * itself rather than from a token. Measured once from a headless-Chrome
 * render of the real `styles.css` (Chrome 153, dark `color-scheme`, 2x; the
 * edge colour is the ring's outermost full-strength pixel):
 *
 *   control (settings `accent-color: --accent`) | on --bg | --panel | --panel-alt
 *   unchecked checkbox, edge #858585           |  5.24   |  4.98   |  5.13
 *   unchecked radio,    edge #858585           |  5.24   |  4.98   |  5.13
 *   checked checkbox,   fill #39d98a (accent)  | 10.55   | 10.03   | 10.33
 *   checked radio,      ring #39d98a (accent)  | 10.55   | 10.03   | 10.33
 *   mode-switcher unchecked radio, #858585     |    —    |    —    |  5.13
 *   mode-switcher checked radio, ring #0a0f0d on the tab's #39d98a fill:
 *     10.55 (`accent-color: var(--bg)`; the default system-blue ring was
 *     1.07:1 against that fill)
 *
 * At 1x, anti-aliasing softens the radio ring to ~#6f6f6f (3.70-3.84:1).
 * Re-measure in-app if the platform's control theme changes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { contrastRatio, parseHex, relativeLuminance } from './contrast';

const STYLES = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// A small CSS reader: enough for this one stylesheet (no nested rules beyond
// `@media`/`@supports`/`@container`, no braces inside values).
// ---------------------------------------------------------------------------

interface CssRule {
  /** Top-level comma-separated selectors, whitespace-normalised. */
  selectors: string[];
  declarations: Array<[property: string, value: string]>;
  /** Enclosing at-rule preludes, outermost first (`[]` at top level). */
  atRules: string[];
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced brace at ${open}`);
}

/** Splits on commas outside parentheses, so `:is(a, b)` stays whole. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim().replace(/\s+/g, ' ')).filter((part) => part !== '');
}

function parseDeclarations(body: string): Array<[string, string]> {
  return body
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.includes(':'))
    .map((declaration) => {
      const colon = declaration.indexOf(':');
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
    });
}

function parseRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const walk = (start: number, end: number, atRules: string[]): void => {
    let preludeStart = start;
    let i = start;
    while (i < end) {
      if (text[i] === '{') {
        const prelude = text.slice(preludeStart, i).trim();
        const close = matchingBrace(text, i);
        if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@container')) {
          walk(i + 1, close, [...atRules, prelude.replace(/\s+/g, ' ')]);
        } else if (!prelude.startsWith('@')) {
          rules.push({
            selectors: splitTopLevel(prelude),
            declarations: parseDeclarations(text.slice(i + 1, close)),
            atRules,
          });
        }
        i = close + 1;
        preludeStart = i;
      } else {
        if (text[i] === ';') preludeStart = i + 1;
        i += 1;
      }
    }
  };
  walk(0, text.length, []);
  return rules;
}

const RULES = parseRules(STYLES);

/** Every value any rule anywhere in `styles.css` assigns to custom property `name`. */
function definitionsOf(name: string): string[] {
  return RULES.flatMap((rule) =>
    rule.declarations.filter(([property]) => property === name).map(([, value]) => value),
  );
}

/** Every definition of `name`, each required to be a measurable hex literal. */
function hexDefinitionsOf(name: string): string[] {
  const values = definitionsOf(name);
  assert.ok(values.length > 0, `${name} is defined in styles.css`);
  for (const value of values) {
    assert.match(value, /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, `${name}: ${value} is a hex literal`);
  }
  return values;
}

/** A border declaration: the shorthand, a side shorthand, or a `*-color`. */
const BORDER_PROPERTY = /^border(-(top|right|bottom|left))?(-color)?$/;
/** Decorative tokens — never a control's only edge. `(?![\w-])` keeps `--border-control` out. */
const DECORATIVE_EDGE = /var\(--(border|border-strong|accent-dim)(?![\w-])\)/;
const DISABLED_STATE = /:disabled|\[aria-disabled/;

describe('contrastRatio', () => {
  const table: Array<[string, string, number]> = [
    ['#000000', '#ffffff', 21],
    ['#ffffff', '#ffffff', 1],
    ['#767676', '#ffffff', 4.54], // the classic AA-grey on white
    ['#777777', '#ffffff', 4.48],
    ['#0000ff', '#ffffff', 8.59],
    ['#ff0000', '#000000', 5.25],
    ['#1e2b26', '#0e1613', 1.25], // `--border` on `--panel`: why P3-13 exists
  ];
  for (const [a, b, expected] of table) {
    it(`${a} vs ${b} is ${expected}:1`, () => {
      assert.equal(Number(contrastRatio(a, b).toFixed(2)), expected);
    });
  }

  it('is symmetric', () => {
    assert.equal(contrastRatio('#39d98a', '#0a0f0d'), contrastRatio('#0a0f0d', '#39d98a'));
  });

  it('accepts #rgb shorthand and either case', () => {
    assert.deepEqual(parseHex('#fA0'), [255, 170, 0]);
    assert.equal(relativeLuminance('#FFF'), 1);
    assert.equal(relativeLuminance('#000'), 0);
  });

  it('throws on anything that is not #rgb/#rrggbb', () => {
    for (const bad of ['fff', '#ffff', '#gggggg', 'var(--bg)', '']) {
      assert.throws(() => parseHex(bad), /Not a #rgb\/#rrggbb colour/);
    }
  });
});

const SURFACES = ['--bg', '--panel', '--panel-alt'];

// The controls whose edge is their only cue (spec P3-13, Boundaries, plus
// what the audit found). Decorative hairlines stay on `--border`/`--border-strong`.
const CONTROLS = [
  '.app__settings-button',
  '.app__close-project-button',
  '.mode-switcher__option',
  '.recent-projects__open',
  '.settings-panel__field-label input',
  '.settings-panel__action',
  '.graph-service-status__retry',
  '.model-status__retry',
  '.code-map__notice > button',
  '.code-map__node-affordance',
  '.code-map__history-toolbar button',
  '.code-map__path-trace-field',
  '.code-map__path-trace-toolbar button',
  '.code-map__path-trace-dismiss',
  '.code-map__pr-review-input',
  '.code-map__pr-review-toolbar button',
  '.code-map__blast-radius-stepper-controls button',
  '.code-map__source-open-in-editor',
  '.code-map__node-detail-regenerate',
  // P4-7g: Node detail's pin toggle.
  '.code-map__node-detail-pin',
];

// Clickable or interactive-looking surfaces that are cards or frames, not
// controls: each already carries a background step or a richer edge (the
// Node's own card edge, a dashed cluster card, a health card, a panel frame,
// a list row's divider),
// so its hairline is decorative (spec P3-13: "card edges already carrying a
// background step"). Anything else with `cursor: pointer`, or that targets
// `input`/`button`, must not edge with a decorative token.
const DECORATIVE_CARDS = new Set([
  '.code-map__node', // Node card: `--panel` fill + `--border-strong` card edge
  '.code-map__cluster', // cluster card: `--panel` fill, dashed edge
  '.code-map__health-card', // Health Audit cluster card
  '.settings-panel', // modal frame
  '.code-map__node-detail-panel', // side-panel frame
  '.code-map__source-panel', // side-panel frame
  '.code-map__path-trace-steps-panel', // floated list frame
  '.code-map__signal-toggle-panel', // floated toolbar frame
  '.code-map__path-trace-stack-row', // a list row: its `border-bottom` is the row divider inside the bordered steps panel (DESIGN.md `path-trace-stack-row`)
]);

describe('styles.css control-boundary token', () => {
  it('every --border-control definition is at least 3:1 against every --bg/--panel/--panel-alt definition', () => {
    const controls = hexDefinitionsOf('--border-control');
    const failures: string[] = [];
    for (const surface of SURFACES) {
      for (const background of hexDefinitionsOf(surface)) {
        for (const control of controls) {
          const ratio = contrastRatio(control, background);
          if (ratio < 3) failures.push(`--border-control ${control} on ${surface} ${background} is ${ratio.toFixed(3)}:1`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  for (const selector of CONTROLS) {
    it(`\`${selector}\` edges with --border-control, never walked back later in its rule`, () => {
      const exact = RULES.filter((rule) => rule.selectors.includes(selector));
      assert.ok(exact.length > 0, `styles.css has a \`${selector}\` rule`);
      const base = exact.find((rule) => rule.declarations.some(([property]) => property === 'border'));
      assert.ok(base, `\`${selector}\` declares a border`);
      const borderAt = base.declarations.findIndex(
        ([property, value]) => property === 'border' && /^1px solid var\(--border-control\)$/.test(value),
      );
      assert.ok(borderAt >= 0, `\`${selector}\`: border is 1px solid var(--border-control)`);
      const later = base.declarations
        .slice(borderAt + 1)
        .filter(([property, value]) => BORDER_PROPERTY.test(property) && /var\(--border(?!-control)/.test(value));
      assert.deepEqual(later, [], `\`${selector}\`: no later border override to a decorative token`);
    });

    it(`no \`${selector}…\` state rule edges with a decorative token`, () => {
      const offenders = RULES.flatMap((rule) =>
        rule.selectors
          .filter((part) => part.startsWith(selector) && !DISABLED_STATE.test(part))
          .flatMap((part) =>
            rule.declarations
              .filter(([property, value]) => BORDER_PROPERTY.test(property) && DECORATIVE_EDGE.test(value))
              .map(([property, value]) => `${part} { ${property}: ${value} }`),
          ),
      );
      assert.deepEqual(offenders, []);
    });

    it(`\`${selector}\` hover is never dimmer than its resting edge`, () => {
      const resting = hexDefinitionsOf('--border-control');
      const panels = hexDefinitionsOf('--panel');
      const hoverEdges = RULES.flatMap((rule) =>
        rule.selectors
          .filter((part) => part.startsWith(selector) && part.includes(':hover'))
          .flatMap(() => rule.declarations.filter(([property]) => BORDER_PROPERTY.test(property))),
      );
      for (const [property, value] of hoverEdges) {
        const token = /var\((--[\w-]+)\)/.exec(value)?.[1];
        assert.ok(token !== undefined, `${selector}:hover ${property}: ${value} names a colour token`);
        for (const hover of hexDefinitionsOf(token)) {
          for (const panel of panels) {
            for (const rest of resting) {
              assert.ok(
                contrastRatio(hover, panel) >= contrastRatio(rest, panel),
                `${selector}:hover ${token} ${hover} is dimmer on --panel than --border-control ${rest}`,
              );
            }
          }
        }
      }
    });
  }
});

describe('styles.css reverse sweep', () => {
  it('no pointer, input or button rule edges with --border/--border-strong unless it is a listed decorative card', () => {
    const targetsControlElement = /(^|[\s>+~(])(input|button)(?![\w-])/;
    const decorative = /var\(--(border|border-strong)(?![\w-])\)/;
    const offenders = RULES.flatMap((rule) => {
      const interactive =
        rule.declarations.some(([property, value]) => property === 'cursor' && value === 'pointer') ||
        rule.selectors.some((part) => targetsControlElement.test(part));
      if (!interactive || rule.selectors.every((part) => DECORATIVE_CARDS.has(part))) return [];
      return rule.declarations
        .filter(([property, value]) => BORDER_PROPERTY.test(property) && decorative.test(value))
        .map(([property, value]) => `${rule.selectors.join(', ')} { ${property}: ${value} }`);
    });
    assert.deepEqual(offenders, []);
  });
});

// FIX-4: controls floated over the canvas. An `opacity` fade on one of them
// fades its opaque background too, so dense Node cards show through the
// label; disabled dims only the text (and, where there is one, the edge).
// Every `:disabled`/`[aria-disabled]` rule whose selector names one of these
// is scanned, wherever it sits (including inside `@container`).
const FLOATED_CONTROL =
  /\.code-map__(history-toolbar|path-trace|pr-review|blast-radius-stepper|refresh-error|action--service-unavailable)/;
const FLOATED_BUTTONS = [
  '.code-map__history-toolbar button',
  '.code-map__path-trace-toolbar button',
  '.code-map__pr-review-toolbar button',
  '.code-map__blast-radius-stepper-controls button',
  '.code-map__refresh-error .actionable-notice__action button',
];
/** A background that lets what is under it show through. */
const SEE_THROUGH =
  /transparent|rgba\(|hsla\(|\/\s*[\d.]+%?\s*\)|#([0-9a-fA-F]{4}|[0-9a-fA-F]{8})\b|color-mix\([^)]*transparent|^none$/;

/** The merged declarations of every rule with exactly `selector` among its selectors. */
function declarationsFor(selector: string): Map<string, string> {
  const matching = RULES.filter((rule) => rule.selectors.includes(selector));
  assert.ok(matching.length > 0, `styles.css has a \`${selector}\` rule`);
  return new Map(matching.flatMap((rule) => rule.declarations));
}

describe('styles.css floated-control disabled state (FIX-4)', () => {
  it('no disabled rule for a control floated over the canvas fades or sees through', () => {
    const offenders = RULES.flatMap((rule) =>
      rule.selectors
        .filter((part) => FLOATED_CONTROL.test(part) && DISABLED_STATE.test(part.replace(/:not\([^)]*\)/g, '')))
        .flatMap((part) =>
          rule.declarations
            .filter(
              ([property, value]) =>
                (property === 'opacity' && value !== '1') ||
                (property === 'filter' && /opacity\(/.test(value)) ||
                (/^background(-color)?$/.test(property) && SEE_THROUGH.test(value)),
            )
            .map(([property, value]) => `${[...rule.atRules, part].join(' ')} { ${property}: ${value} }`),
        ),
    );
    assert.deepEqual(offenders, []);
  });

  it('the scan sees every floated disabled rule, including the refresh-error Retry', () => {
    const scanned = RULES.flatMap((rule) =>
      rule.selectors.filter((part) => FLOATED_CONTROL.test(part) && DISABLED_STATE.test(part.replace(/:not\([^)]*\)/g, ''))),
    );
    for (const expected of [
      '.code-map__history-toolbar button:disabled',
      '.code-map__path-trace-toolbar button:disabled',
      '.code-map__path-trace-step:disabled',
      '.code-map__path-trace-input:disabled',
      '.code-map__pr-review-input:disabled',
      '.code-map__pr-review-toolbar button:disabled',
      '.code-map__blast-radius-stepper-controls button:disabled',
      '.code-map__refresh-error .actionable-notice__action button:disabled',
      '.code-map__action--service-unavailable:disabled',
    ]) {
      assert.ok(scanned.includes(expected), `scanned: ${expected}`);
    }
  });

  for (const selector of FLOATED_BUTTONS) {
    it(`\`${selector}:disabled\` keeps its background and dims text and edge`, () => {
      const declarations = declarationsFor(`${selector}:disabled`);
      assert.equal(declarations.get('color'), 'var(--text-mute)');
      assert.equal(declarations.get('border-style'), 'dashed');
      assert.ok(!declarations.has('background') && !declarations.has('background-color'), 'background left as is');
    });
  }

  it('the refresh-error Retry resets the shared notice button\'s disabled opacity', () => {
    const shared = declarationsFor('.actionable-notice__action button:disabled');
    if (shared.has('opacity') && shared.get('opacity') !== '1') {
      assert.equal(declarationsFor('.code-map__refresh-error .actionable-notice__action button:disabled').get('opacity'), '1');
    }
  });

  it('the disabled Path Trace field and PR Review input keep their opaque background and dim text and edge', () => {
    assert.equal(declarationsFor('.code-map__path-trace-field').get('background'), 'var(--panel-alt)');
    assert.equal(declarationsFor('.code-map__pr-review-input').get('background'), 'var(--panel-alt)');
    assert.equal(
      declarationsFor('.code-map__path-trace-field:has(.code-map__path-trace-input:disabled)').get('border-style'),
      'dashed',
    );
    assert.equal(declarationsFor('.code-map__path-trace-input:disabled').get('color'), 'var(--text-mute)');
    const input = declarationsFor('.code-map__pr-review-input:disabled');
    assert.equal(input.get('border-style'), 'dashed');
    assert.equal(input.get('color'), 'var(--text-mute)');
  });

  it('ambiguous-candidate rows mute when disabled and only highlight on hover while enabled', () => {
    const disabled = declarationsFor('.code-map__path-trace-step:disabled');
    assert.equal(disabled.get('color'), 'var(--text-mute)');
    assert.equal(disabled.get('cursor'), 'default');
    assert.ok(declarationsFor('.code-map__path-trace-step:hover:not(:disabled)').has('background'));
    assert.ok(
      !RULES.some((rule) => rule.selectors.includes('.code-map__path-trace-step:hover')),
      'no hover rule that also fires while disabled',
    );
  });

  it('--text-mute is at least 4.5:1 on every --panel-alt definition', () => {
    for (const text of hexDefinitionsOf('--text-mute')) {
      for (const surface of hexDefinitionsOf('--panel-alt')) {
        const ratio = contrastRatio(text, surface);
        assert.ok(ratio >= 4.5, `--text-mute ${text} on --panel-alt ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  });
});

describe('styles.css floated-toolbar collision layout (FIX-4)', () => {
  it('`.code-map` is the `code-map` size container', () => {
    const declarations = declarationsFor('.code-map');
    assert.equal(declarations.get('container'), 'code-map / size');
  });

  it('both `@container code-map` breakpoints exist', () => {
    const preludes = new Set(RULES.flatMap((rule) => rule.atRules).filter((prelude) => prelude.startsWith('@container')));
    assert.deepEqual([...preludes].sort(), [
      '@container code-map (width < 1040px)',
      '@container code-map (width < 600px)',
    ]);
  });
});
