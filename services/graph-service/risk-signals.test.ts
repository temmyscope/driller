/**
 * P1-1: `assignDeterministicSeverities` and the fetch path's
 * `attachProjectRiskSignals` — every row of the spec's I/O matrix, the
 * per-file hotspot population, floor boundaries, non-finite values,
 * determinism under input reordering (FR-7), and `lookup_node` parity.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BidirectionalAdjacency } from '@driller/graph-contracts';
import type { CodeMapNode, DeterministicRiskSignalType, RiskSignal } from '@driller/ipc-contracts';

import { deriveLiveNode } from './live-node';
import type { CodeMapNodeWithSignalSources } from './mcp-client';
import {
  BLAST_RADIUS_SEVERE_FLOOR,
  HOTSPOT_SEVERE_FLOOR,
  SEVERE_COGNITIVE_COMPLEXITY_MIN,
  SEVERE_COMPLEXITY_MIN,
  assignDeterministicSeverities,
  attachProjectRiskSignals,
  type UnratedRiskSignal,
} from './risk-signals';

function signal(type: DeterministicRiskSignalType, value: number, file = 'src/a.ts'): UnratedRiskSignal {
  return { family: 'deterministic', type, value, location: { file, startLine: 1, endLine: 2 } };
}

/**
 * One Node per value, each carrying a single `type` signal in its OWN file
 * (so hotspot's per-file population has one entry per value); returns each
 * Node's severity.
 */
function severitiesFor(type: DeterministicRiskSignalType, values: number[]): string[] {
  return assignDeterministicSeverities(values.map((value, i) => [signal(type, value, `src/f${i}.ts`)])).map(
    (signals) => {
      const [only] = signals;
      assert.ok(only !== undefined && only.family === 'deterministic');
      return only.severity;
    },
  );
}

function severityOf(node: readonly RiskSignal[], type: DeterministicRiskSignalType): string | undefined {
  for (const s of node) {
    if (s.family === 'deterministic' && s.type === type) {
      return s.severity;
    }
  }
  return undefined;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe('assignDeterministicSeverities — absolute thresholds', () => {
  it('complexity 20 is moderate, 21 is severe', () => {
    assert.equal(SEVERE_COMPLEXITY_MIN, 21);
    assert.deepEqual(severitiesFor('complexity', [20, 21]), ['moderate', 'severe']);
  });

  it('cognitive complexity 14 is moderate, 15 is severe', () => {
    assert.equal(SEVERE_COGNITIVE_COMPLEXITY_MIN, 15);
    assert.deepEqual(severitiesFor('cognitive-complexity', [14, 15]), ['moderate', 'severe']);
  });

  it('a coverage gap is always moderate', () => {
    assert.deepEqual(severitiesFor('test-coverage-gap', [1, 1, 1]), ['moderate', 'moderate', 'moderate']);
  });
});

describe('assignDeterministicSeverities — percentile thresholds', () => {
  it('both floors default to 10', () => {
    assert.equal(BLAST_RADIUS_SEVERE_FLOOR, 10);
    assert.equal(HOTSPOT_SEVERE_FLOOR, 10);
  });

  for (const type of ['blast-radius', 'hotspot'] as const) {
    it(`${type}: top 10% of a tiny repo but below the floor stays moderate`, () => {
      assert.ok(severitiesFor(type, range(1, 6)).every((s) => s === 'moderate'));
    });

    it(`${type}: 9 vs 10 at the top of the population — the floor is inclusive`, () => {
      // 20 Nodes: top 10% = 2 slots, both taken by the 9 and the 10.
      const values = [9, 10, ...Array<number>(18).fill(1)];
      assert.deepEqual(severitiesFor(type, values).slice(0, 2), ['moderate', 'severe']);
    });

    it(`${type}: ≥ 10 but outside the top 10% of a large repo stays moderate`, () => {
      // 100 Nodes valued 1..100: the top 10% is 91..100.
      const severities = severitiesFor(type, range(1, 100));
      assert.equal(severities[49], 'moderate', 'value 50 is ≥ 10 but not in the top 10%');
      assert.equal(severities[89], 'moderate', 'value 90 is just outside the cut');
      assert.equal(severities[90], 'severe', 'value 91 is the cut');
      assert.equal(severities.filter((s) => s === 'severe').length, 10);
    });

    it(`${type}: every Node tied at the cut shares one severity`, () => {
      // 20 Nodes, top 10% = 2 slots, but 18 tie at the top value: the cut is
      // inclusive, so all 18 are severe, not an arbitrary 2 of them.
      const severities = severitiesFor(type, [...Array<number>(18).fill(40), 11, 12]);
      assert.ok(severities.slice(0, 18).every((s) => s === 'severe'));
      assert.deepEqual(severities.slice(18), ['moderate', 'moderate']);

      // A tie the cut falls inside of.
      const spanning = severitiesFor(type, [50, ...Array<number>(19).fill(20)]);
      assert.equal(spanning[0], 'severe');
      assert.equal(new Set(spanning.slice(1)).size, 1, 'the tied 20s all agree');
    });
  }

  it('blast-radius and hotspot cuts are computed independently', () => {
    const nodes = range(1, 10).map((i) => [
      signal('blast-radius', i * 10, `src/f${i}.ts`),
      signal('hotspot', 110 - i * 10, `src/f${i}.ts`),
    ]);
    const rated = assignDeterministicSeverities(nodes);
    assert.equal(severityOf(rated[9]!, 'blast-radius'), 'severe');
    assert.equal(severityOf(rated[9]!, 'hotspot'), 'moderate');
    assert.equal(severityOf(rated[0]!, 'hotspot'), 'severe');
    assert.equal(severityOf(rated[0]!, 'blast-radius'), 'moderate');
  });
});

describe('assignDeterministicSeverities — hotspot population is per file', () => {
  // `hotspotChangeCount` is `File.change_count` copied onto every Node in the
  // file (`mcp-client.ts`'s `fetchCodeMap`), so the population is one value
  // per distinct file.
  it('one many-Node churned file does not crowd the top 10%', () => {
    // One file (`big.ts`) with 30 Nodes at 50, plus 19 single-Node files at
    // 11..29. Per file: 20 values, top 10% = 2 files → cut 29. Per Node it
    // would have been 49 values, top 10% = 5 slots all at 50 → cut 50, and
    // the 29 file would have been moderate.
    const big = Array.from({ length: 30 }, () => [signal('hotspot', 50, 'src/big.ts')]);
    const singles = range(11, 29).map((value) => [signal('hotspot', value, `src/single-${value}.ts`)]);
    const rated = assignDeterministicSeverities([...big, ...singles]);

    // Every Node in a severe file is severe.
    assert.ok(rated.slice(0, 30).every((node) => severityOf(node, 'hotspot') === 'severe'));
    const singleSeverities = rated.slice(30).map((node) => severityOf(node, 'hotspot'));
    assert.equal(singleSeverities.at(-1), 'severe', 'the 29 file is in the per-file top 10%');
    assert.ok(singleSeverities.slice(0, -1).every((s) => s === 'moderate'));
  });

  it('is independent of how many Nodes a file has', () => {
    const singles = range(11, 29).map((value) => [signal('hotspot', value, `src/single-${value}.ts`)]);
    const withOneBigNode = assignDeterministicSeverities([[signal('hotspot', 50, 'src/big.ts')], ...singles]);
    const withManyBigNodes = assignDeterministicSeverities([
      ...Array.from({ length: 30 }, () => [signal('hotspot', 50, 'src/big.ts')]),
      ...singles,
    ]);
    assert.deepStrictEqual(withManyBigNodes.slice(30), withOneBigNode.slice(1));
  });
});

describe('assignDeterministicSeverities — non-finite values', () => {
  for (const type of ['blast-radius', 'hotspot'] as const) {
    it(`${type}: NaN/±Infinity are ignored by the cut and never reorder it`, () => {
      const finite = range(1, 20);
      const withNonFinite = [...finite, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
      const severities = severitiesFor(type, withNonFinite);
      // The finite Nodes rate exactly as they would without the non-finite ones.
      assert.deepStrictEqual(severities.slice(0, 20), severitiesFor(type, finite));

      // Determinism: any order gives the same per-value severity.
      const reversed = severitiesFor(type, [...withNonFinite].reverse()).reverse();
      assert.deepStrictEqual(reversed, severities);
      const nanFirst = severitiesFor(type, [Number.NaN, ...finite]);
      assert.deepStrictEqual(nanFirst.slice(1), severitiesFor(type, finite));
      assert.equal(nanFirst[0], 'moderate', 'NaN is never severe');
    });
  }
});

describe('assignDeterministicSeverities — shape and determinism', () => {
  const judgment: UnratedRiskSignal = {
    family: 'llm-judgment',
    judgment: 'Risky.',
    location: { file: 'src/a.ts', startLine: 1, endLine: 2 },
  };

  function project(): UnratedRiskSignal[][] {
    return range(0, 39).map((i) => {
      const file = `src/f${i % 7}.ts`;
      return [
        signal('complexity', (i * 7) % 30, file),
        signal('cognitive-complexity', (i * 5) % 20, file),
        signal('hotspot', ((i % 7) * 13) % 25, file),
        signal('blast-radius', (i * 3) % 17, file),
        ...(i % 4 === 0 ? [signal('test-coverage-gap', 1, file)] : []),
        ...(i % 5 === 0 ? [judgment] : []),
      ];
    });
  }

  it('stamps every deterministic signal and leaves values and other families unchanged', () => {
    const input = project();
    const rated = assignDeterministicSeverities(input);
    assert.equal(rated.length, input.length);
    rated.forEach((node, i) => {
      assert.equal(node.length, input[i]!.length);
      node.forEach((s, j) => {
        const original = input[i]![j]!;
        if (s.family === 'deterministic') {
          assert.ok(s.severity === 'moderate' || s.severity === 'severe');
          const { severity: _severity, ...rest } = s;
          assert.deepStrictEqual(rest, original);
        } else {
          assert.strictEqual(s, original);
        }
      });
    });
  });

  it('gives every signal the same severity when the Nodes (and their signals) are reordered', () => {
    const input = project();
    const forward = assignDeterministicSeverities(input);
    const reversedInput = [...input].reverse().map((node) => [...node].reverse());
    const reversed = assignDeterministicSeverities(reversedInput)
      .reverse()
      .map((node) => [...node].reverse());
    assert.deepStrictEqual(reversed, forward);

    // A non-trivial shuffle (fixed permutation — no randomness in a test).
    const order = input.map((_, i) => (i * 17) % input.length);
    assert.equal(new Set(order).size, input.length);
    const shuffled = assignDeterministicSeverities(order.map((i) => input[i]!));
    order.forEach((original, position) => {
      assert.deepStrictEqual(shuffled[position], forward[original]);
    });
  });

  it('an empty project yields nothing', () => {
    assert.deepEqual(assignDeterministicSeverities([]), []);
  });
});

describe('attachProjectRiskSignals — the fetch path', () => {
  /**
   * 20 Nodes `n1`..`n20`, each in its own file, where `nK` reaches K
   * off-map ids in one hop — so its blast radius is exactly K. Hand-built
   * adjacency keeps the population to the 20 Nodes under test.
   */
  function population() {
    const ids = range(1, 20).map((k) => `n${k}`);
    const forward = new Map(ids.map((id, i) => [id, range(1, i + 1).map((j) => `${id}-callee-${j}`)]));
    const adjacency: BidirectionalAdjacency = { validNodeIds: new Set(ids), forward, backward: new Map() };
    const sources: CodeMapNodeWithSignalSources[] = ids.map((id, i) => ({
      id,
      name: id,
      file: `src/${id}.ts`,
      startLine: 1,
      endLine: 2,
      kind: 'Function',
      summaryStatus: 'pending',
      riskSignals: [],
      complexity: i + 1,
    }));
    // What `annotateNodesWithSummaryState` hands over: same order, raw
    // fields still present at runtime.
    const annotated: CodeMapNode[] = sources.map((source) => ({ ...source }));
    return { adjacency, sources, annotated };
  }

  const noRecord = () => undefined;

  it('rates blast radius across the whole project: only top 10% ∩ ≥ floor is severe', () => {
    const { adjacency, sources, annotated } = population();
    const nodes = attachProjectRiskSignals(annotated, sources, adjacency, undefined, noRecord);
    const severeIds = nodes.filter((node) => severityOf(node.riskSignals, 'blast-radius') === 'severe').map((n) => n.id);
    // Values 1..20: top 10% = 2 Nodes (19, 20), both ≥ 10. Rating each Node
    // alone would also make n10..n18 severe.
    assert.deepEqual(severeIds, ['n19', 'n20']);
  });

  it("keeps each Node's signals attached to its own id and strips the raw fields", () => {
    const { adjacency, sources, annotated } = population();
    const nodes = attachProjectRiskSignals(annotated, sources, adjacency, undefined, noRecord);
    nodes.forEach((node, i) => {
      const k = i + 1;
      assert.equal(node.id, `n${k}`);
      const values = Object.fromEntries(
        node.riskSignals.flatMap((s) => (s.family === 'deterministic' ? [[s.type, s.value]] : [])),
      );
      assert.deepEqual(values, { complexity: k, 'blast-radius': k });
      assert.ok(node.riskSignals.every((s) => s.location.file === `src/n${k}.ts`));
      assert.equal('complexity' in node, false);
      assert.equal('cognitiveComplexity' in node, false);
      assert.equal('hotspotChangeCount' in node, false);
    });
  });

  it('throws rather than misattaching when the two lists are not parallel', () => {
    const { adjacency, sources, annotated } = population();
    assert.throws(() => attachProjectRiskSignals(annotated.slice(1), sources, adjacency, undefined, noRecord));
    assert.throws(() =>
      attachProjectRiskSignals([...annotated].reverse(), sources, adjacency, undefined, noRecord),
    );
  });
});

describe('lookup_node carries the same severity as the renderer', () => {
  it('a severe Node keeps its severity through deriveLiveNode', () => {
    const [ratedSignals] = assignDeterministicSeverities([[signal('complexity', 40), signal('blast-radius', 0)]]);
    const cached: CodeMapNode = {
      id: 'src/a.ts::severe',
      name: 'severe',
      file: 'src/a.ts',
      startLine: 1,
      endLine: 2,
      kind: 'Function',
      summaryStatus: 'pending',
      riskSignals: ratedSignals!,
    };
    const live = deriveLiveNode(cached, { getRecord: () => undefined, coverageGapFiles: new Set() });
    assert.equal(severityOf(live.riskSignals, 'complexity'), 'severe');
    assert.deepStrictEqual(
      live.riskSignals.filter((s) => s.family === 'deterministic'),
      cached.riskSignals.filter((s) => s.family === 'deterministic'),
    );
  });
});
