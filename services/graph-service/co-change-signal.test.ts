/**
 * The `co-change` deterministic risk signal: a Node carrying how many files
 * its own file has a history of changing alongside.
 *
 * The scenario is driller's own: `packages/ipc-contracts/src/index.ts` moves
 * with main, preload and the Graph Service, so a Node in it is risky to
 * change in a way no structural measure reports. A Node in a file that moves
 * with nothing carries no signal at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BidirectionalAdjacency } from '@driller/graph-contracts';
import type { CoChangingFile, DeterministicRiskSignal, RiskSignal } from '@driller/ipc-contracts';

import type { CodeMapNodeWithSignalSources } from './mcp-client';
import {
  assignDeterministicSeverities,
  buildRiskSignals,
  CO_CHANGE_SEVERE_FLOOR,
  type UnratedRiskSignal,
} from './risk-signals';

const NO_ADJACENCY: BidirectionalAdjacency = { validNodeIds: new Set(), forward: new Map(), backward: new Map() };

const partners = (count: number): CoChangingFile[] =>
  Array.from({ length: count }, (_unused, index) => ({
    file: `apps/desktop/other${index}.ts`,
    coChanges: 10 + index,
    score: 0.9,
  }));

function nodeWith(coChangesWith: CoChangingFile[] | undefined, total?: number): CodeMapNodeWithSignalSources {
  return {
    id: 'packages/ipc-contracts/src/index.ts::IpcChannels',
    name: 'IpcChannels',
    file: 'packages/ipc-contracts/src/index.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: [],
    ...(coChangesWith === undefined
      ? {}
      : { coChangesWith, coChangesWithTotal: total ?? coChangesWith.length }),
  };
}

const coChangeOf = (signals: readonly UnratedRiskSignal[]): UnratedRiskSignal | undefined =>
  signals.find((entry) => entry.family === 'deterministic' && entry.type === 'co-change');

describe('a Node in a file that moves with others carries a co-change signal', () => {
  it('reports how many files it moves with', () => {
    const signals = buildRiskSignals(nodeWith(partners(3)), NO_ADJACENCY, undefined, () => undefined);
    const found = coChangeOf(signals);
    assert.ok(found !== undefined && found.family === 'deterministic', 'the signal is present');
    assert.equal(found.value, 3);
  });

  it('reports the true count, not the capped list it carries', () => {
    const signals = buildRiskSignals(nodeWith(partners(2), 17), NO_ADJACENCY, undefined, () => undefined);
    const found = coChangeOf(signals);
    assert.ok(found !== undefined && found.family === 'deterministic');
    assert.equal(found.value, 17);
  });

  it('carries no signal when the file moves with nothing', () => {
    assert.equal(coChangeOf(buildRiskSignals(nodeWith(undefined), NO_ADJACENCY, undefined, () => undefined)), undefined);
  });

  it('carries no signal for an empty partner list rather than a zero', () => {
    assert.equal(coChangeOf(buildRiskSignals(nodeWith([]), NO_ADJACENCY, undefined, () => undefined)), undefined);
  });

  it('points at the Node’s own source range, like every other deterministic signal', () => {
    const found = coChangeOf(buildRiskSignals(nodeWith(partners(3)), NO_ADJACENCY, undefined, () => undefined));
    assert.deepEqual(found?.location, {
      file: 'packages/ipc-contracts/src/index.ts',
      startLine: 1,
      endLine: 9,
    });
  });
});

describe('co-change severity is judged against the project, by file', () => {
  const rate = (counts: number[]): string[] => {
    const perNode: UnratedRiskSignal[][] = counts.map((count, index) => [
      {
        family: 'deterministic',
        type: 'co-change',
        value: count,
        location: { file: `src/f${index}.ts`, startLine: 1, endLine: 2 },
      },
    ]);
    return assignDeterministicSeverities(perNode).map((signals) => {
      const [only] = signals;
      assert.ok(only !== undefined && only.family === 'deterministic');
      return only.severity;
    });
  };

  it('calls out the most entangled files in a project of many', () => {
    const counts = Array.from({ length: 20 }, (_unused, index) => 20 - index);
    const severities = rate(counts);
    assert.equal(severities[0], 'severe', 'the most entangled file is severe');
    assert.equal(severities.at(-1), 'moderate', 'the least entangled is not');
  });

  it('never calls a file severe for moving with fewer than the floor, however quiet the project', () => {
    const below = CO_CHANGE_SEVERE_FLOOR - 1;
    const severities = rate(Array.from({ length: 20 }, () => below));
    assert.ok(
      severities.every((severity) => severity === 'moderate'),
      `${below} partners is below the floor, so no percentile should make it severe`,
    );
  });

  it('is deterministic whatever order the Nodes arrive in', () => {
    const counts = [12, 3, 8, 1, 20, 5];
    const forward = rate(counts);
    const reversed = rate([...counts].reverse()).reverse();
    assert.deepEqual(reversed, forward);
  });

  it('counts one value per file, so a many-Node file cannot fill the top band alone', () => {
    // Twenty Nodes in ONE heavily-coupled file, plus ten quiet files. If the
    // population were per Node, the one file would be the whole top decile.
    const perNode: UnratedRiskSignal[][] = [
      ...Array.from({ length: 20 }, () => [
        {
          family: 'deterministic' as const,
          type: 'co-change' as const,
          value: 9,
          location: { file: 'src/busy.ts', startLine: 1, endLine: 2 },
        },
      ]),
      ...Array.from({ length: 10 }, (_unused, index) => [
        {
          family: 'deterministic' as const,
          type: 'co-change' as const,
          value: 40 + index,
          location: { file: `src/q${index}.ts`, startLine: 1, endLine: 2 },
        },
      ]),
    ];
    const rated: RiskSignal[][] = assignDeterministicSeverities(perNode);
    const busy = rated[0]![0] as DeterministicRiskSignal;
    assert.equal(busy.severity, 'moderate', 'the busy file is judged on its own value, not its Node count');
  });
});
