/**
 * P0-4: unit tests for live-node.ts — one case per row of the spec's I/O &
 * Edge-Case Matrix, shape cases, and a parity suite: for a given record
 * state, `deriveLiveNode` applied to an OLDER fetch's cached Node must equal
 * what the real Code Map fetch path (`annotateNodesWithSummaryState` + the
 * real `buildRiskSignals`) produces now.
 *
 * The matrix's "unknown id / no project" row is `mcp-server.ts`'s
 * `lookupNode`, whose not-found/error branches this change leaves untouched;
 * it isn't imported here because `mcp-server.ts` imports `index.ts`, whose
 * module-load side effects bind the MCP server's port.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBidirectionalAdjacency } from '@driller/graph-contracts';
import type { CodeMapNode, IngestedRiskSignal, RiskSignal } from '@driller/ipc-contracts';

import { deriveLiveNode } from './live-node';
import type { LcovCoverage } from './lcov';
import type { CodeMapNodeWithSignalSources } from './mcp-client';
import { getNodeRecord, mergeNodeRecord, type NodeRecord } from './node-record-store';
import { attachProjectRiskSignals } from './risk-signals';
import { annotateNodesWithSummaryState } from './summary-generator';

const location = { file: 'src/a.ts', startLine: 1, endLine: 10 };

const deterministic: RiskSignal[] = [
  { family: 'deterministic', type: 'complexity', value: 7, location, severity: 'moderate' },
  { family: 'deterministic', type: 'blast-radius', value: 3, location, severity: 'severe' },
];

const finding: IngestedRiskSignal = {
  family: 'ingested',
  severity: 'major',
  sourceTool: 'CodeRabbit',
  finding: 'Unchecked null.',
  location,
};

function cachedNode(overrides: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id: 'src/a.ts::a',
    name: 'a',
    file: location.file,
    startLine: location.startLine,
    endLine: location.endLine,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: deterministic,
    ...overrides,
  };
}

function sourcesFor(record: NodeRecord | undefined, gapFiles: string[] = []) {
  return {
    getRecord: (id: string) => (id === 'src/a.ts::a' ? record : undefined),
    coverageGapFiles: new Set(gapFiles),
  };
}

const summary = (text: string) => ({ text, model: 'm', generatedAt: '2026-09-24T00:00:00.000Z' });

const BASE_KEYS = ['endLine', 'file', 'id', 'kind', 'name', 'riskSignals', 'startLine', 'summaryStatus'];

describe('deriveLiveNode', () => {
  it('summary generated after fetch: pending cache becomes ready with the record text', () => {
    const live = deriveLiveNode(cachedNode(), sourcesFor({ summary: summary('Does A.') }));
    assert.equal(live.summaryStatus, 'ready');
    assert.equal(live.summary, 'Does A.');
  });

  it('regenerated after staleness: stale cache becomes fresh ready text, not stale', () => {
    const cached = cachedNode({ summaryStatus: 'ready', summary: 'Old.', stale: true });
    const live = deriveLiveNode(cached, sourcesFor({ summary: summary('New.'), stale: false }));
    assert.equal(live.summaryStatus, 'ready');
    assert.equal(live.summary, 'New.');
    assert.equal(live.stale, false);
  });

  it('backend switch cleared summaries: ready cache becomes pending with no summary/stale keys', () => {
    const cached = cachedNode({ summaryStatus: 'ready', summary: 'Old.', stale: true });
    const live = deriveLiveNode(cached, sourcesFor({}));
    assert.equal(live.summaryStatus, 'pending');
    assert.deepEqual(Object.keys(live).sort(), BASE_KEYS);
  });

  it('judgment/ingested added after fetch: appended after the cached deterministic signals', () => {
    const live = deriveLiveNode(
      cachedNode(),
      sourcesFor({ llmJudgment: { ...summary('Risky.') }, ingestedFindings: [finding] }),
    );
    assert.deepStrictEqual(live.riskSignals, [
      ...deterministic,
      { family: 'llm-judgment', judgment: 'Risky.', location },
      finding,
    ]);
  });

  it('drops cached record-backed signals the record no longer has', () => {
    const cached = cachedNode({
      riskSignals: [...deterministic, { family: 'llm-judgment', judgment: 'Gone.', location }, finding],
    });
    const live = deriveLiveNode(cached, sourcesFor({}));
    assert.deepStrictEqual(live.riskSignals, deterministic);
  });

  it('coverage-gap Node: coverage-gap with no summary, even when the record has one', () => {
    const cached = cachedNode({ summaryStatus: 'ready', summary: 'Old.' });
    const live = deriveLiveNode(cached, sourcesFor({ summary: summary('Text.') }, [location.file]));
    assert.equal(live.summaryStatus, 'coverage-gap');
    assert.deepEqual(Object.keys(live).sort(), BASE_KEYS);
  });

  it('record with a summary but no stale field: ready, and stale stays undefined (never defaulted)', () => {
    const live = deriveLiveNode(cachedNode(), sourcesFor({ summary: summary('S.') }));
    assert.equal(live.summaryStatus, 'ready');
    assert.equal(live.summary, 'S.');
    assert.equal(live.stale, undefined);
    // Same as `classifyNode` on the fetch path: the key is carried, its value
    // undefined (dropped on the JSON wire) — never a default `false`.
    assert.deepEqual(Object.keys(live).sort(), [...BASE_KEYS, 'stale', 'summary'].sort());
  });

  it('cached Node without summary/stale whose record now has both: exactly those keys added', () => {
    const cached = cachedNode();
    assert.deepEqual(Object.keys(cached).sort(), BASE_KEYS);
    const live = deriveLiveNode(cached, sourcesFor({ summary: summary('S.'), stale: true }));
    assert.deepEqual(Object.keys(live).sort(), [...BASE_KEYS, 'stale', 'summary'].sort());
    assert.equal(live.summary, 'S.');
    assert.equal(live.stale, true);
  });
});

describe('parity with the Code Map fetch path', () => {
  /**
   * The fetch path's assembly, in `handleGetCodeMapRequest`'s own order:
   * `annotateNodesWithSummaryState`, then the real `attachProjectRiskSignals`
   * (build, rate across the whole population, strip the raw FR7 fields).
   * Both read the real record store through their default `getNodeRecord`,
   * exactly as `getCodeMap` does. P1-1: run over a MULTI-Node population —
   * severity is project-relative, so a one-Node population would not match
   * production. Returns the Node under test.
   */
  function fetchPath(raw: CodeMapNodeWithSignalSources, gaps: ReadonlySet<string>, coverage?: LcovCoverage) {
    const population = [raw, ...PEERS];
    const adjacency = buildBidirectionalAdjacency(population, []);
    const annotated = annotateNodesWithSummaryState(population, gaps);
    const node = attachProjectRiskSignals(annotated, population, adjacency, coverage).find((n) => n.id === raw.id);
    assert.ok(node !== undefined);
    return node;
  }

  /**
   * 20 peers, each alone in its own file, with hotspot 13..32. The per-file
   * hotspot population is then 21 files, whose top 10% (3 files) cuts at 30
   * — so the Node under test (hotspot 12, ≥ the floor) is `moderate` here,
   * but would be `severe` rated alone.
   */
  const PEERS: CodeMapNodeWithSignalSources[] = Array.from({ length: 20 }, (_, i) => ({
    ...cachedNode({ id: `parity-peer-${i}`, file: `src/peer-${i}.ts`, summaryStatus: 'pending', riskSignals: [] }),
    hotspotChangeCount: 13 + i,
  }));

  const EMPTY: NodeRecord = { summary: undefined, stale: undefined, llmJudgment: undefined, ingestedFindings: undefined };

  const cases: Array<{ label: string; before: NodeRecord; after: NodeRecord; gaps?: string[]; coverage?: LcovCoverage }> = [
    { label: 'generated after fetch', before: {}, after: { summary: summary('S.'), llmJudgment: summary('J.') } },
    {
      label: 'regenerated after staleness',
      before: { summary: summary('Old.'), stale: true },
      after: { summary: summary('New.'), stale: false, ingestedFindings: [finding] },
    },
    {
      label: 'backend switch cleared summaries',
      before: { summary: summary('Old.'), stale: false, llmJudgment: summary('J.') },
      after: { llmJudgment: summary('J.') },
    },
    {
      label: 'coverage gap, with an LCOV test-coverage-gap signal',
      before: {},
      after: { summary: summary('S.'), llmJudgment: summary('J.'), ingestedFindings: [finding] },
      gaps: [location.file],
      coverage: new Map([[location.file, new Set<number>()]]),
    },
  ];

  for (const { label, before, after, gaps = [], coverage } of cases) {
    it(`matches the fetch path for: ${label}`, () => {
      const id = `parity::${label}`;
      const gapSet = new Set(gaps);
      const raw: CodeMapNodeWithSignalSources = {
        ...cachedNode({ id, summaryStatus: 'pending', riskSignals: [] }),
        complexity: 4,
        cognitiveComplexity: 2,
        hotspotChangeCount: 12,
      };

      mergeNodeRecord(id, { ...EMPTY, ...before });
      const cached = fetchPath(raw, gapSet, coverage);
      mergeNodeRecord(id, { ...EMPTY, ...after });
      const fresh = fetchPath(raw, gapSet, coverage);

      const live = deriveLiveNode(cached, { getRecord: getNodeRecord, coverageGapFiles: gapSet });
      assert.deepStrictEqual(live, fresh);
      // Rated against the whole population, not alone (see PEERS).
      const hotspot = live.riskSignals.find((s) => s.family === 'deterministic' && s.type === 'hotspot');
      assert.ok(hotspot?.family === 'deterministic');
      assert.equal(hotspot.severity, 'moderate');
    });
  }
});
