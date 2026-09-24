/**
 * P1-1: severe deterministic chips — the "(severe)" label, and both chip sites
 * (the canvas strip shared with Node Detail, and the Health Audit row)
 * rendering their `--severe` class, the `!` glyph and the label, while a
 * moderate chip stays exactly as it was.
 *
 * Same no-DOM approach as `CodeMap.blastRadius.test.ts`: both components are
 * hookless and their chips are plain host elements, so calling them and
 * walking `props.children` reaches the chips.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CodeMapNode,
  DeterministicRiskSeverity,
  DeterministicRiskSignal,
  DeterministicRiskSignalType,
} from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';

import {
  DETERMINISTIC_SIGNAL_ICONS,
  HealthAuditClusterRow,
  NodeRiskSignalSections,
  SEVERE_SIGNAL_GLYPH,
  formatDeterministicSignalLabel,
  groupNodesIntoHealthClusters,
} from './CodeMap';

interface Element {
  props: Record<string, unknown>;
}

function elementsOf(node: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      elementsOf(child, out);
    }
    return out;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return out;
  }
  const element = node as Element;
  out.push(element);
  elementsOf(element.props.children, out);
  return out;
}

/** Visible text of an element, aria-hidden glyphs included. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return textOf((node as Element).props.children);
  }
  return '';
}

const location = { file: 'api/svc.ts', startLine: 1, endLine: 2 };
const hops: number = BLAST_RADIUS_DEFAULT_HOPS;
const hopText = `${hops} hop${hops === 1 ? '' : 's'}`;

function det(type: DeterministicRiskSignalType, value: number, severity: DeterministicRiskSeverity): DeterministicRiskSignal {
  return { family: 'deterministic', type, value, location, severity };
}

/** The severe chips every site must render — including hotspot, whose own icon was the old `▲` glyph. */
const SEVERE_CASES: Array<{ signal: DeterministicRiskSignal; label: string }> = [
  { signal: det('complexity', 21, 'severe'), label: 'Complexity: 21 (severe)' },
  { signal: det('hotspot', 14, 'severe'), label: 'Hotspot: 14 (severe)' },
  {
    signal: det('blast-radius', 12, 'severe'),
    label: `Blast radius: 12 Nodes within ${hopText} (callers and callees) (severe)`,
  },
];
const MODERATE_CASES: Array<{ signal: DeterministicRiskSignal; label: string }> = [
  { signal: det('cognitive-complexity', 3, 'moderate'), label: 'Cognitive complexity: 3' },
  { signal: det('test-coverage-gap', 1, 'moderate'), label: 'Test coverage gap: 1' },
];

function chipLabelled(tree: Element[], label: string): Element | undefined {
  return tree.find((element) => element.props['aria-label'] === label);
}

function glyphSpans(chip: Element): Element[] {
  return elementsOf(chip.props.children).filter((element) => element.props['aria-hidden'] === 'true');
}

function assertSevereChip(tree: Element[], { signal, label }: (typeof SEVERE_CASES)[number], baseClass: string) {
  const chip = chipLabelled(tree, label);
  assert.ok(chip !== undefined, `the severe ${signal.type} chip renders with label "${label}"`);
  assert.deepEqual(String(chip.props.className).split(' '), [baseClass, `${baseClass}--severe`]);
  assert.equal(chip.props.title, label);
  // `!` comes first, BEFORE the type icon; both are aria-hidden decoration.
  const icon = DETERMINISTIC_SIGNAL_ICONS[signal.type];
  assert.deepEqual(glyphSpans(chip).map(textOf), [SEVERE_SIGNAL_GLYPH, icon]);
  assert.equal(textOf(chip), `${SEVERE_SIGNAL_GLYPH}${icon}${signal.value}`);
}

function assertModerateChip(tree: Element[], { signal, label }: (typeof MODERATE_CASES)[number], baseClass: string) {
  const chip = chipLabelled(tree, label);
  assert.ok(chip !== undefined, `the moderate ${signal.type} chip renders with label "${label}"`);
  assert.equal(chip.props.className, baseClass);
  assert.deepEqual(glyphSpans(chip).map(textOf), [DETERMINISTIC_SIGNAL_ICONS[signal.type]]);
  assert.equal(textOf(chip).includes(SEVERE_SIGNAL_GLYPH), false);
}

const ALL_SIGNALS = [...SEVERE_CASES, ...MODERATE_CASES].map(({ signal }) => signal);

describe('SEVERE_SIGNAL_GLYPH', () => {
  it('is "!" and differs from every deterministic type icon', () => {
    assert.equal(SEVERE_SIGNAL_GLYPH, '!');
    for (const [type, icon] of Object.entries(DETERMINISTIC_SIGNAL_ICONS)) {
      assert.notEqual(icon, SEVERE_SIGNAL_GLYPH, `${type}'s icon collides with the severe glyph`);
      assert.equal(icon.includes(SEVERE_SIGNAL_GLYPH), false, `${type}'s icon contains the severe glyph`);
    }
  });
});

describe('formatDeterministicSignalLabel severity', () => {
  for (const { signal, label } of [...SEVERE_CASES, ...MODERATE_CASES]) {
    it(`${signal.severity} ${signal.type} reads "${label}"`, () => {
      assert.equal(formatDeterministicSignalLabel(signal), label);
    });
  }
});

describe('canvas chip severity', () => {
  const tree = elementsOf(
    NodeRiskSignalSections({
      signals: ALL_SIGNALS,
      toggles: { showDeterministicSignals: true, showLlmJudgment: true, showIngestedFindings: true },
    }),
  );
  for (const severe of SEVERE_CASES) {
    it(`renders a severe ${severe.signal.type} chip with the class, "!" and "(severe)"`, () => {
      assertSevereChip(tree, severe, 'code-map__signal-chip');
    });
  }
  for (const moderate of MODERATE_CASES) {
    it(`renders a moderate ${moderate.signal.type} chip unchanged`, () => {
      assertModerateChip(tree, moderate, 'code-map__signal-chip');
    });
  }
});

describe('Health Audit row chip severity', () => {
  const only: CodeMapNode = {
    id: 'api/svc.ts.charge',
    name: 'charge',
    file: 'api/svc.ts',
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'ready',
    riskSignals: ALL_SIGNALS,
  };
  const member = groupNodesIntoHealthClusters([only]).clusters[0]?.nodes[0];
  assert.ok(member !== undefined);
  const tree = elementsOf(HealthAuditClusterRow({ member, onActivate: () => {} }));
  for (const severe of SEVERE_CASES) {
    it(`renders a severe ${severe.signal.type} value with the row's own --severe modifier, "!" and "(severe)"`, () => {
      assertSevereChip(tree, severe, 'code-map__health-row-signal');
    });
  }
  for (const moderate of MODERATE_CASES) {
    it(`renders a moderate ${moderate.signal.type} value unchanged`, () => {
      assertModerateChip(tree, moderate, 'code-map__health-row-signal');
    });
  }
});
