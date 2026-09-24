/**
 * P0-2a: unit tests for `groupNodesIntoHealthClusters` — one case per row of
 * the spec's I/O & Edge-Case Matrix, plus the repeat-call determinism and
 * count-parity acceptance criteria.
 *
 * Run by `npm test` (`node --test`) through `scripts/ts-test-loader.mjs`,
 * which is what lets a `.ts` test import the helper from its `.tsx` home.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CodeMapNode,
  DeterministicRiskSignalType,
  RiskSignal,
} from '@driller/ipc-contracts';

import {
  HEALTH_CLUSTER_LIMIT,
  HEALTH_CLUSTER_NODE_LIMIT,
  HEALTH_CLUSTER_ROOT_KEY,
  HEALTH_CLUSTER_ROOT_LABEL,
  buildRiskCountByNodeId,
  groupNodesIntoHealthClusters,
  riskCountForNode,
} from './CodeMap';

const LOCATION = { file: 'unused.ts', startLine: 1, endLine: 2 };

function deterministic(type: DeterministicRiskSignalType, value = 1): RiskSignal {
  return { family: 'deterministic', type, value, location: LOCATION };
}

function judgment(text: string): RiskSignal {
  return { family: 'llm-judgment', judgment: text, location: LOCATION };
}

function ingested(): RiskSignal {
  return {
    family: 'ingested',
    severity: 'blocker',
    sourceTool: 'coderabbit',
    finding: 'ignored by the Risk Overlay',
    location: LOCATION,
  };
}

/**
 * The five-member deterministic union, used to build a Node with an exact
 * signal count. Ordered so `signalsOfCount(n)` is a stable prefix.
 */
const ALL_DETERMINISTIC_TYPES: DeterministicRiskSignalType[] = [
  'complexity',
  'cognitive-complexity',
  'hotspot',
  'blast-radius',
  'test-coverage-gap',
];

/** `count` distinct deterministic signals, topped up with a judgment past five. */
function signalsOfCount(count: number): RiskSignal[] {
  assert.ok(count <= ALL_DETERMINISTIC_TYPES.length + 1, 'max representable count is 6');
  const signals: RiskSignal[] = ALL_DETERMINISTIC_TYPES.slice(
    0,
    Math.min(count, ALL_DETERMINISTIC_TYPES.length),
  ).map((type) => deterministic(type));
  if (count > ALL_DETERMINISTIC_TYPES.length) {
    signals.push(judgment('risky'));
  }
  return signals;
}

function node(overrides: Partial<CodeMapNode> & Pick<CodeMapNode, 'id' | 'file'>): CodeMapNode {
  return {
    name: overrides.id,
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'ready',
    riskSignals: [],
    ...overrides,
  };
}

describe('riskCountForNode', () => {
  it('counts deterministic signals plus one non-whitespace judgment, never ingested', () => {
    assert.equal(riskCountForNode(node({ id: 'a', file: 'x/a.ts' })), 0);
    assert.equal(
      riskCountForNode(
        node({ id: 'a', file: 'x/a.ts', riskSignals: [deterministic('complexity')] }),
      ),
      1,
    );
    assert.equal(
      riskCountForNode(
        node({
          id: 'a',
          file: 'x/a.ts',
          riskSignals: [deterministic('complexity'), judgment('bad'), ingested()],
        }),
      ),
      2,
    );
  });

  it('does not count a whitespace-only judgment, matching what the renderer shows', () => {
    assert.equal(
      riskCountForNode(node({ id: 'a', file: 'x/a.ts', riskSignals: [judgment('   \n\t')] })),
      0,
    );
  });
});

describe('groupNodesIntoHealthClusters', () => {
  // Matrix: "Mixed repo".
  it('keys clusters by the full containing directory and ranks them by max, then total, then path', () => {
    const { clusters, remainingClusterCount } = groupNodesIntoHealthClusters([
      node({ id: 'quiet', file: 'api/internal/util/quiet.ts', riskSignals: signalsOfCount(1) }),
      node({ id: 'hot', file: 'api/internal/service/hot.ts', riskSignals: signalsOfCount(6) }),
      node({ id: 'mild', file: 'api/internal/service/mild.ts', riskSignals: signalsOfCount(2) }),
      node({ id: 'mid', file: 'web/mid.ts', riskSignals: signalsOfCount(4) }),
    ]);

    assert.equal(remainingClusterCount, 0);
    assert.deepEqual(
      clusters.map((cluster) => cluster.directory),
      ['api/internal/service', 'web', 'api/internal/util'],
    );
    const [service, web, util] = clusters;
    assert.equal(service?.label, 'api/internal/service');
    assert.equal(service?.heat, 'hot');
    assert.equal(service?.heatCount, 6);
    // Max, never the sum: one bad Node makes the cluster hot.
    assert.equal(service?.totalRiskCount, 8);
    assert.equal(web?.heat, 'warm');
    assert.equal(web?.heatCount, 4);
    assert.equal(util?.heat, 'cool');
    assert.equal(util?.heatCount, 1);
  });

  it('exposes each Node with its own count and its de-duplicated, type-ordered signals', () => {
    const { clusters } = groupNodesIntoHealthClusters([
      node({
        id: 'svc',
        file: 'api/svc.ts',
        riskSignals: [deterministic('hotspot', 3), deterministic('blast-radius', 14), judgment('x')],
      }),
    ]);

    const member = clusters[0]?.nodes[0];
    assert.equal(member?.riskCount, 3);
    assert.deepEqual(
      member?.deterministicSignals.map((signal) => signal.type),
      ['blast-radius', 'hotspot'],
    );
    // The real `value`s survive — no derived percentage anywhere.
    assert.deepEqual(
      member?.deterministicSignals.map((signal) => signal.value),
      [14, 3],
    );
    assert.equal(member?.llmJudgment?.judgment, 'x');
  });

  // Matrix: "Clean repo".
  it('returns populated healthy clusters for a repo with zero signals', () => {
    const { clusters, remainingClusterCount } = groupNodesIntoHealthClusters([
      node({ id: 'a', file: 'src/a.ts' }),
      node({ id: 'b', file: 'lib/b.ts' }),
    ]);

    assert.equal(remainingClusterCount, 0);
    assert.equal(clusters.length, 2);
    for (const cluster of clusters) {
      assert.equal(cluster.heat, 'healthy');
      assert.equal(cluster.heatCount, 0);
      assert.equal(cluster.totalRiskCount, 0);
      assert.equal(cluster.remainingNodeCount, 0);
    }
    // All-zero heat, so the path tiebreak is the only thing ordering these.
    assert.deepEqual(
      clusters.map((cluster) => cluster.directory),
      ['lib', 'src'],
    );
  });

  // Matrix: "Root-level file".
  it('groups a root-level file under a stable sentinel key with a renderable label', () => {
    const { clusters } = groupNodesIntoHealthClusters([
      node({ id: 'main', file: 'main.ts' }),
      node({ id: 'index', file: 'index.ts' }),
    ]);

    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.directory, HEALTH_CLUSTER_ROOT_KEY);
    assert.notEqual(clusters[0]?.directory, '');
    assert.equal(clusters[0]?.label, HEALTH_CLUSTER_ROOT_LABEL);
    assert.equal(clusters[0]?.nodes.length, 2);
  });

  // Matrix: "Dense directory". Asserts WHICH Nodes survive, not just how
  // many: a cap that kept the right count but the wrong Nodes would be the
  // more damaging bug, since the card would then hide the worst offenders.
  it('caps a cluster to its highest-count Nodes, by count desc then name asc', () => {
    // 11 Nodes, three interleaved count tiers, inserted in reverse id order
    // so any leak of input order into the result is visible.
    const dense = Array.from({ length: HEALTH_CLUSTER_NODE_LIMIT + 3 }, (_unused, index) =>
      node({
        id: `n${String(index).padStart(2, '0')}`,
        file: 'pkg/dense.ts',
        riskSignals: signalsOfCount(index % 3),
      }),
    ).reverse();

    const cluster = groupNodesIntoHealthClusters(dense).clusters[0];

    assert.deepEqual(cluster?.nodes.map((member) => member.node.id), [
      // count 2, name asc
      'n02',
      'n05',
      'n08',
      // count 1, name asc
      'n01',
      'n04',
      'n07',
      'n10',
      // count 0, name asc — the cap falls here
      'n00',
    ]);
    assert.equal(cluster?.nodes.length, HEALTH_CLUSTER_NODE_LIMIT);
    assert.equal(cluster?.remainingNodeCount, 3);
    // n03/n06/n09 are the dropped ones; they still count toward the totals.
    assert.equal(cluster?.heatCount, 2);
    assert.equal(
      cluster?.totalRiskCount,
      dense.reduce((sum, member) => sum + riskCountForNode(member), 0),
    );
  });

  // Matrix: "Wide repo". Same reasoning as above — identity, not just count.
  it('caps the cluster list to the highest-ranked clusters and reports the remainder', () => {
    // 17 single-Node directories across four count tiers. The top 12 are
    // exactly the non-zero ones, so the cap lands on a real boundary.
    const wide = Array.from({ length: HEALTH_CLUSTER_LIMIT + 5 }, (_unused, index) =>
      node({
        id: `n${index}`,
        file: `dir${String(index).padStart(2, '0')}/f.ts`,
        riskSignals: signalsOfCount(index % 4),
      }),
    ).reverse();

    const { clusters, remainingClusterCount } = groupNodesIntoHealthClusters(wide);

    assert.deepEqual(clusters.map((cluster) => cluster.directory), [
      // heatCount 3, path asc
      'dir03',
      'dir07',
      'dir11',
      'dir15',
      // heatCount 2, path asc
      'dir02',
      'dir06',
      'dir10',
      'dir14',
      // heatCount 1, path asc
      'dir01',
      'dir05',
      'dir09',
      'dir13',
    ]);
    assert.equal(clusters.length, HEALTH_CLUSTER_LIMIT);
    // The five dropped clusters are exactly the zero-signal ones.
    assert.equal(remainingClusterCount, 5);
    assert.ok(
      clusters.every((cluster) => cluster.heat !== 'healthy'),
      'a healthy cluster must never outrank one carrying signals',
    );
  });

  // Matrix: "Empty input".
  it('returns an empty list and zero remainders for no Nodes', () => {
    assert.deepEqual(groupNodesIntoHealthClusters([]), {
      clusters: [],
      remainingClusterCount: 0,
    });
  });

  // Matrix: "Identical counts".
  it('breaks a full max-and-total tie by directory path ascending', () => {
    const tied = [
      node({ id: 'z', file: 'zebra/z.ts', riskSignals: signalsOfCount(2) }),
      node({ id: 'a', file: 'alpha/a.ts', riskSignals: signalsOfCount(2) }),
      node({ id: 'm', file: 'middle/m.ts', riskSignals: signalsOfCount(2) }),
    ];

    assert.deepEqual(
      groupNodesIntoHealthClusters(tied).clusters.map((cluster) => cluster.directory),
      ['alpha', 'middle', 'zebra'],
    );
    // Same set, different input order — same output order.
    assert.deepEqual(
      groupNodesIntoHealthClusters([...tied].reverse()).clusters.map((c) => c.directory),
      ['alpha', 'middle', 'zebra'],
    );
  });

  // Matrix: "Duplicate signal types".
  it('counts a repeated deterministic type once', () => {
    const { clusters } = groupNodesIntoHealthClusters([
      node({
        id: 'dup',
        file: 'pkg/dup.ts',
        riskSignals: [
          deterministic('complexity', 21),
          deterministic('complexity', 99),
          deterministic('hotspot', 2),
        ],
      }),
    ]);

    assert.equal(clusters[0]?.heatCount, 2);
    assert.equal(clusters[0]?.nodes[0]?.riskCount, 2);
    assert.deepEqual(
      clusters[0]?.nodes[0]?.deterministicSignals.map((signal) => signal.value),
      // First occurrence wins, matching `selectDeterministicSignals`.
      [21, 2],
    );
  });

  // Acceptance: repeat-call determinism.
  it('produces deeply equal results, array order included, when run twice', () => {
    const repo = [
      node({ id: 'b', file: 'pkg/b.ts', riskSignals: signalsOfCount(3) }),
      node({ id: 'a', file: 'pkg/a.ts', riskSignals: signalsOfCount(3) }),
      node({ id: 'root', file: 'root.ts', riskSignals: signalsOfCount(3) }),
      node({ id: 'c', file: 'other/c.ts' }),
      node({ id: 'd', file: 'other/d.ts', riskSignals: [judgment(' ')] }),
    ];

    assert.deepEqual(groupNodesIntoHealthClusters(repo), groupNodesIntoHealthClusters(repo));
    assert.deepEqual(
      groupNodesIntoHealthClusters(repo),
      groupNodesIntoHealthClusters([...repo].reverse()),
      'output must not depend on input order',
    );
  });

  // Acceptance: parity with the Code Map cluster tint's per-Node count.
  //
  // `buildRiskCountByNodeId` IS `riskCountByNodeId`'s body — the `useMemo`
  // is now that call plus its mode/fetch-state gating — so this compares the
  // helper against the real production map, not against a re-derivation of
  // it. The fixture deliberately contains each case where a re-implemented
  // counter would drift: an ingested signal (excluded), a repeated
  // deterministic `type` (counted once) and a whitespace-only judgment (not
  // counted).
  it('reports per-Node counts identical to the Code Map cluster tint count', () => {
    const repo = [
      node({ id: 'a', file: 'pkg/a.ts', riskSignals: [deterministic('hotspot'), judgment('x')] }),
      node({ id: 'b', file: 'pkg/b.ts', riskSignals: [judgment('\t ')] }),
      node({ id: 'c', file: 'other/c.ts', riskSignals: [ingested(), ingested()] }),
      node({ id: 'd', file: 'other/d.ts', riskSignals: signalsOfCount(5) }),
      node({
        id: 'e',
        file: 'other/e.ts',
        riskSignals: [deterministic('complexity', 3), deterministic('complexity', 9), ingested()],
      }),
    ];

    const tintCounts = buildRiskCountByNodeId(repo);

    assert.deepEqual(
      [...tintCounts.entries()],
      repo.map((member) => [member.id, riskCountForNode(member)]),
    );
    for (const cluster of groupNodesIntoHealthClusters(repo).clusters) {
      for (const member of cluster.nodes) {
        assert.equal(member.riskCount, tintCounts.get(member.node.id));
      }
    }
    assert.deepEqual([...tintCounts.values()], [2, 0, 0, 5, 1]);
  });

  // The terminal tiebreak. Two Nodes sharing a cluster, a count AND a name,
  // so `name` cannot decide it and the `id` comparison actually runs.
  it('breaks a Node tie on equal count and equal name by id ascending', () => {
    const sameName = [
      node({ id: 'pkg/z.ts::handle', name: 'handle', file: 'pkg/z.ts', riskSignals: signalsOfCount(2) }),
      node({ id: 'pkg/a.ts::handle', name: 'handle', file: 'pkg/a.ts', riskSignals: signalsOfCount(2) }),
    ];

    for (const ordering of [sameName, [...sameName].reverse()]) {
      assert.deepEqual(
        groupNodesIntoHealthClusters(ordering).clusters[0]?.nodes.map((m) => m.node.id),
        ['pkg/a.ts::handle', 'pkg/z.ts::handle'],
      );
    }
  });

  // The band cut points themselves, so an off-by-one in `HEAT_BY_BUCKET` or
  // a re-banding of `riskCountBucket` cannot pass. 0 -> healthy is covered
  // by the clean-repo case above.
  it('bands heat at riskCountBucket\'s own cut points', () => {
    const heatAtCount = (count: number) =>
      groupNodesIntoHealthClusters([
        node({ id: 'n', file: 'pkg/n.ts', riskSignals: signalsOfCount(count) }),
      ]).clusters[0]?.heat;

    assert.equal(heatAtCount(0), 'healthy');
    assert.equal(heatAtCount(1), 'cool');
    assert.equal(heatAtCount(2), 'cool');
    assert.equal(heatAtCount(3), 'warm');
    assert.equal(heatAtCount(5), 'warm');
    assert.equal(heatAtCount(6), 'hot');
  });

  // Exactly at both caps: nothing is dropped and both remainders are 0.
  it('reports zero remainders when the input lands exactly on the caps', () => {
    const exact = Array.from({ length: HEALTH_CLUSTER_LIMIT }, (_unused, cluster) =>
      Array.from({ length: HEALTH_CLUSTER_NODE_LIMIT }, (_ignored, member) =>
        node({
          id: `d${cluster}-n${member}`,
          file: `dir${String(cluster).padStart(2, '0')}/f${member}.ts`,
          riskSignals: signalsOfCount(member % 4),
        }),
      ),
    ).flat();

    const { clusters, remainingClusterCount } = groupNodesIntoHealthClusters(exact);
    assert.equal(clusters.length, HEALTH_CLUSTER_LIMIT);
    assert.equal(remainingClusterCount, 0);
    for (const cluster of clusters) {
      assert.equal(cluster.nodes.length, HEALTH_CLUSTER_NODE_LIMIT);
      assert.equal(cluster.remainingNodeCount, 0);
    }
  });
});
