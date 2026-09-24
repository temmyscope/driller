/**
 * P0-5: unit tests for the renderer's Blast Radius helpers —
 * `initialBlastRadiusDepth` (PR Review's initial stepper depth) and the
 * chip label that spells out the badge's hop bound.
 *
 * Every expectation is written against `BLAST_RADIUS_DEFAULT_HOPS`, never a
 * literal, so the badge's bound and the default highlight depth cannot drift
 * apart.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`, which is what lets a
 * `.ts` test import from a `.tsx` module.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeterministicRiskSignalType } from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';

import { NodeRiskSignalSections, formatDeterministicSignalLabel, initialBlastRadiusDepth } from './CodeMap';

interface Element {
  props: Record<string, unknown>;
}

/**
 * Every element under `node`, depth first. `NodeRiskSignalSections` is
 * hookless and its chips are plain host elements, so walking `props.children`
 * reaches them without a renderer (same approach as
 * `CodeMap.healthAuditRow.test.ts`'s `renderTree`).
 */
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

describe('initialBlastRadiusDepth', () => {
  it('defaults to the shared badge bound when the result reaches at or past it', () => {
    assert.equal(initialBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS), BLAST_RADIUS_DEFAULT_HOPS);
    assert.equal(initialBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS + 3), BLAST_RADIUS_DEFAULT_HOPS);
  });

  it('clamps to the resolved max depth when the farthest Node is closer than the bound', () => {
    assert.equal(initialBlastRadiusDepth(1), Math.min(1, BLAST_RADIUS_DEFAULT_HOPS));
  });

  it('never drops below the stepper floor of 1 (nothing reachable, or negative)', () => {
    assert.equal(initialBlastRadiusDepth(0), 1);
    assert.equal(initialBlastRadiusDepth(-2), 1);
  });

  it('returns 1 for a non-finite max depth', () => {
    assert.equal(initialBlastRadiusDepth(Number.NaN), 1);
    assert.equal(initialBlastRadiusDepth(Number.POSITIVE_INFINITY), 1);
    assert.equal(initialBlastRadiusDepth(Number.NEGATIVE_INFINITY), 1);
  });

  it('floors a fractional max depth before clamping', () => {
    assert.equal(initialBlastRadiusDepth(1.9), 1);
    assert.equal(initialBlastRadiusDepth(0.5), 1);
    assert.equal(initialBlastRadiusDepth(BLAST_RADIUS_DEFAULT_HOPS + 0.7), BLAST_RADIUS_DEFAULT_HOPS);
  });
});

describe('formatDeterministicSignalLabel', () => {
  const bound: number = BLAST_RADIUS_DEFAULT_HOPS;
  const hops = `${bound} hop${bound === 1 ? '' : 's'}`;

  it('says the Blast Radius count is within the shared hop bound', () => {
    assert.equal(
      formatDeterministicSignalLabel({ type: 'blast-radius', value: 4, severity: 'moderate' }),
      `Blast radius: 4 Nodes within ${hops} (callers and callees)`,
    );
    assert.equal(
      formatDeterministicSignalLabel({ type: 'blast-radius', value: 1, severity: 'moderate' }),
      `Blast radius: 1 Node within ${hops} (callers and callees)`,
    );
  });

  it('pluralises zero', () => {
    assert.equal(
      formatDeterministicSignalLabel({ type: 'blast-radius', value: 0, severity: 'moderate' }),
      `Blast radius: 0 Nodes within ${hops} (callers and callees)`,
    );
  });

  it('falls back to the raw type string for an unknown signal type', () => {
    const unknownType = 'future-signal' as DeterministicRiskSignalType;
    assert.equal(formatDeterministicSignalLabel({ type: unknownType, value: 3, severity: 'moderate' }), 'future-signal: 3');
  });

  it('keeps "Label: value" for every other deterministic signal', () => {
    assert.equal(formatDeterministicSignalLabel({ type: 'complexity', value: 21, severity: 'moderate' }), 'Complexity: 21');
    assert.equal(formatDeterministicSignalLabel({ type: 'hotspot', value: 3, severity: 'moderate' }), 'Hotspot: 3');
  });
});

// The canvas card's chip strip (shared with Node Detail). Reverting this call
// site to a bare "label: value" fails here.
describe('canvas Blast Radius chip', () => {
  it('labels the chip with the bounded count', () => {
    const location = { file: 'a.ts', startLine: 1, endLine: 2 };
    const tree = elementsOf(
      NodeRiskSignalSections({
        signals: [{ family: 'deterministic', type: 'blast-radius', value: 4, location, severity: 'moderate' }],
        toggles: { showDeterministicSignals: true, showLlmJudgment: true, showIngestedFindings: true },
      }),
    );
    const expected = formatDeterministicSignalLabel({ type: 'blast-radius', value: 4, severity: 'moderate' });
    const chip = tree.find((element) => element.props.className === 'code-map__signal-chip');
    assert.ok(chip !== undefined, 'the strip renders a chip');
    assert.equal(chip.props['aria-label'], expected);
    assert.equal(chip.props.title, expected);
    assert.ok(expected.includes('within'));
    assert.ok(expected.includes(String(BLAST_RADIUS_DEFAULT_HOPS)));
  });
});

