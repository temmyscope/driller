/**
 * P4-2 phase 1: `isTestPath` / `excludeTestCode`, and parity of blast radius
 * and the severe cut for production Nodes with and without test Nodes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBidirectionalAdjacency } from '@driller/graph-contracts';
import type { CodeMapEdge, CodeMapNode, RiskSignal } from '@driller/ipc-contracts';

import { joinHotspotChangeCounts, type CodeMapNodeWithSignalSources } from './mcp-client';
import { attachProjectRiskSignals } from './risk-signals';
import { excludeTestCode, isTestNode, isTestPath } from './test-code';

describe('isTestPath', () => {
  const cases: [string, boolean][] = [
    // `*.test.*` / `*.spec.*`, any case
    ['services/graph-service/risk-signals.test.ts', true],
    ['apps/desktop/renderer/src/CodeMap.healthAuditRow.test.tsx', true],
    ['src/widget.spec.ts', true],
    ['src/Widget.SPEC.js', true],
    ['src/Widget.Test.ts', true],
    // Go
    ['pkg/server/handler_test.go', true],
    ['pkg/server/Handler_TEST.go', true],
    // Python
    ['app/test_models.py', true],
    ['app/Test_Models.py', true],
    ['app/models_test.py', true],
    ['conftest.py', true],
    ['app/ConfTest.py', true],
    // Ruby
    ['lib/user_spec.rb', true],
    ['lib/User_SPEC.rb', true],
    // Java / Kotlin (CamelCase suffix; extension any case)
    ['src/main/java/com/x/UserServiceTest.java', true],
    ['src/main/java/com/x/UserServiceTests.java', true],
    ['src/main/java/com/x/UserServiceIT.java', true],
    ['src/main/kotlin/x/UserServiceTest.kt', true],
    ['src/main/kotlin/x/UserServiceTests.kt', true],
    ['src/main/kotlin/x/UserServiceIT.KT', true],
    // .NET
    ['src/App/UserServiceTests.cs', true],
    // directory segments, any case
    ['src/__tests__/widget.ts', true],
    ['test/helpers.ts', true],
    ['Test/helpers.ts', true],
    ['packages/core/TESTS/fixtures/data.ts', true],
    ['spec/models/user.rb', true],
    ['src/__mocks__/fs.ts', true],
    ['e2e/login.ts', true],
    ['E2E/login.ts', true],
    ['cypress/support/commands.ts', true],
    ['playwright/fixtures.ts', true],
    ['src/MyApp.Tests/UserService.cs', true],
    ['src/myapp.tests/UserService.cs', true],
    // test-support files, any JS/TS extension
    ['apps/desktop/renderer/src/testRender.ts', true],
    ['src/testrender.tsx', true],
    ['src/test-utils.js', true],
    ['src/testUtils.mts', true],
    ['src/setupTests.ts', true],
    ['jest.setup.js', true],
    ['vitest.setup.cjs', true],
    ['scripts/ts-test-loader.mjs', true],
    ['scripts/register-ts-test-loader.mjs', true],
    ['scripts/build/testloader.js', true],
    ['Scripts/TS-Test-Loader.mjs', true],
    // Windows separators, `.` and in-project `..` segments
    ['src\\__tests__\\widget.ts', true],
    ['./src/./__tests__/widget.ts', true],
    ['src/lib/../tests/x.ts', true],
    // production code, including near misses
    ['services/graph-service/risk-signals.ts', false],
    ['services/graph-service/test-code.ts', false],
    ['src/contest.ts', false],
    ['src/testing/index.ts', false],
    ['pkg/attest.go', false],
    ['app/latest.py', false],
    ['lib/inspect.rb', false],
    ['src/fixtures/data.ts', false],
    ['src/Button.stories.tsx', false],
    ['src/main/java/com/x/Latest.java', false],
    ['src/main/java/com/x/Audit.java', false],
    ['src/main/kotlin/x/Contest.kt', false],
    ['src/App/Contests.cs', false],
    ['src/latest/index.ts', false],
    ['src/attestation.test-utils.ts', false],
    ['src/specification.ts', false],
    ['src/test', false],
    ['scripts/find-tests.mjs', false],
    ['tools/ts-test-loader.mjs', false],
    ['src/testRender.py', false],
    ['src/test-utils.go', false],
    ['', false],
    // absolute / escaping paths: ancestor segments above the project never count
    ['/home/u/tests/myproj/src/app.ts', false],
    ['C:\\Users\\u\\test\\myproj\\src\\app.ts', false],
    ['../tests/myproj/src/app.ts', false],
    ['src/../../tests/app.ts', false],
    // … but file-name rules still apply to them
    ['/home/u/tests/myproj/src/app.test.ts', true],
    ['../other/handler_test.go', true],
  ];
  for (const [file, expected] of cases) {
    it(`${JSON.stringify(file)} → ${expected}`, () => {
      assert.equal(isTestPath(file), expected);
    });
  }
});

describe('isTestNode', () => {
  it('counts the backend is_test flag even when the path looks like production code', () => {
    assert.equal(isTestNode({ file: 'src/helpers.ts', isTest: true }), true);
  });
  it('counts the path rule when the flag is false (Interface inside a .test.ts file)', () => {
    assert.equal(isTestNode({ file: 'src/a.test.ts', isTest: false }), true);
    assert.equal(isTestNode({ file: 'src/a.test.ts' }), true);
  });
  it('production path with no flag is not test code', () => {
    assert.equal(isTestNode({ file: 'src/a.ts' }), false);
  });
});

function node(id: string, file: string, extra: Partial<CodeMapNodeWithSignalSources> = {}): CodeMapNodeWithSignalSources {
  return {
    id,
    name: id,
    file,
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: [],
    ...extra,
  };
}

/**
 * Production Nodes `p0`..`p19` (`p0` is the hub: every other one calls it,
 * plus a small chain so blast radii differ), and test Nodes whose fake USAGE
 * edges make a test local the map's highest in-degree Node — the shape the
 * P4-2 investigation found on driller/app.
 */
function fixture(): { nodes: CodeMapNodeWithSignalSources[]; edges: CodeMapEdge[] } {
  const prod = Array.from({ length: 20 }, (_, i) => node(`p${i}`, `src/p${i}.ts`, { complexity: i }));
  const edges: CodeMapEdge[] = [];
  for (let i = 1; i < 20; i++) {
    edges.push({ source: `p${i}`, target: 'p0', kind: 'CALLS' });
  }
  for (let i = 1; i < 19; i++) {
    edges.push({ source: `p${i}`, target: `p${i + 1}`, kind: 'CALLS' });
  }
  const tests = [
    node('t.local', 'src/p.test.ts'),
    node('t.iface', 'src/p.test.ts', { kind: 'Interface' }),
    node('t.helper', 'apps/r/src/testRender.ts'),
    node('t.flagged', 'src/fixtures.ts', { isTest: true }),
    node('t.dir', 'src/__tests__/x.ts'),
  ];
  // Name-resolution noise: every production Node "uses" the test local and
  // the test Interface, and test code calls production code.
  for (let i = 0; i < 20; i++) {
    edges.push({ source: `p${i}`, target: 't.local', kind: 'USAGE' });
    edges.push({ source: `p${i}`, target: 't.iface', kind: 'USAGE' });
  }
  edges.push({ source: 't.helper', target: 'p5', kind: 'CALLS' });
  edges.push({ source: 't.flagged', target: 'p7', kind: 'CALLS' });
  edges.push({ source: 't.dir', target: 't.local', kind: 'CALLS' });
  edges.push({ source: 'p3', target: 't.dir', kind: 'CALLS' });
  return { nodes: [...prod, ...tests], edges };
}

function topInDegree(edges: readonly CodeMapEdge[]): string {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function severityOf(signals: readonly RiskSignal[], type: string): string | undefined {
  const found = signals.find((s) => s.family === 'deterministic' && s.type === type);
  return found && found.family === 'deterministic' ? found.severity : undefined;
}

function signalsOf(nodes: readonly CodeMapNode[], id: string): RiskSignal[] {
  return nodes.find((n) => n.id === id)!.riskSignals;
}

function riskFor(nodes: CodeMapNodeWithSignalSources[], edges: CodeMapEdge[]): CodeMapNode[] {
  const adjacency = buildBidirectionalAdjacency(nodes, edges);
  return attachProjectRiskSignals(
    nodes.map((n) => ({ ...n })),
    nodes,
    adjacency,
    undefined,
    () => undefined,
  );
}

describe('excludeTestCode', () => {
  it('removes test Nodes and every edge touching one; the top in-degree Node is production code', () => {
    const { nodes, edges } = fixture();
    assert.equal(topInDegree(edges), 't.local');
    const filtered = excludeTestCode(nodes, edges);
    assert.deepEqual(
      filtered.nodes.map((n) => n.id),
      Array.from({ length: 20 }, (_, i) => `p${i}`),
    );
    assert.ok(filtered.edges.every((e) => e.source.startsWith('p') && e.target.startsWith('p')));
    assert.equal(filtered.edges.length, 19 + 18);
    assert.equal(topInDegree(filtered.edges), 'p0');
  });

  it('a project with no tests is returned unchanged', () => {
    const nodes = [node('a', 'src/a.ts'), node('b', 'src/b.ts')];
    const edges: CodeMapEdge[] = [{ source: 'a', target: 'b', kind: 'CALLS' }];
    const result = excludeTestCode(nodes, edges);
    assert.equal(result.nodes, nodes);
    assert.equal(result.edges, edges);
  });

  it('blast radius and the severe cut for production Nodes are identical with and without test Nodes present', () => {
    const base = fixture();
    // Plus a dense test-only block: 30 tests each calling the same 30 test
    // helpers, so each of those 60 Nodes reaches 30 others. That drags the
    // project's top-10% blast-radius cut above every production value.
    const star: CodeMapNodeWithSignalSources[] = [];
    const starEdges: CodeMapEdge[] = [];
    for (let i = 0; i < 30; i++) {
      star.push(node(`t.case${i}`, 'src/big.test.ts'), node(`t.helper${i}`, 'src/big.test.ts'));
    }
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 30; j++) {
        starEdges.push({ source: `t.case${i}`, target: `t.helper${j}`, kind: 'CALLS' });
      }
    }
    const nodes = [...base.nodes, ...star];
    const edges = [...base.edges, ...starEdges];
    const productionOnly = {
      nodes: nodes.filter((n) => n.id.startsWith('p')),
      edges: edges.filter((e) => e.source.startsWith('p') && e.target.startsWith('p')),
    };
    const expected = riskFor(productionOnly.nodes, productionOnly.edges);
    const filtered = excludeTestCode(nodes, edges);
    const actual = riskFor(filtered.nodes, filtered.edges);
    for (let i = 0; i < 20; i++) {
      assert.deepStrictEqual(signalsOf(actual, `p${i}`), signalsOf(expected, `p${i}`), `p${i}`);
    }
    // Not vacuous: without the exclusion, the test Nodes change production
    // blast-radius values AND which production Nodes pass the severe cut.
    const polluted = riskFor(nodes, edges);
    const blast = (ns: CodeMapNode[], id: string) =>
      signalsOf(ns, id).find((s) => s.family === 'deterministic' && s.type === 'blast-radius');
    assert.notDeepStrictEqual(blast(polluted, 'p10'), blast(expected, 'p10'));
    const severeProduction = (ns: CodeMapNode[]) =>
      ns.filter((n) => n.id.startsWith('p') && severityOf(n.riskSignals, 'blast-radius') === 'severe').map((n) => n.id);
    assert.ok(severeProduction(expected).length > 0);
    assert.notDeepStrictEqual(severeProduction(polluted), severeProduction(expected));
  });

  it('a test Node sharing an id with a production Node never removes the production Node or its edges', () => {
    const nodes = [node('dup', 'src/a.ts'), node('dup', 'src/a.test.ts'), node('b', 'src/b.ts'), node('t', 'src/b.test.ts')];
    const edges: CodeMapEdge[] = [
      { source: 'b', target: 'dup', kind: 'CALLS' },
      { source: 'dup', target: 't', kind: 'USAGE' },
      { source: 't', target: 'b', kind: 'CALLS' },
    ];
    const result = excludeTestCode(nodes, edges);
    assert.deepEqual(result.nodes, [nodes[0], nodes[2]]);
    assert.deepEqual(result.edges, [edges[0]]);
  });
});

describe('test files never feed the hotspot population', () => {
  /**
   * Production files `src/p0.ts`..`src/p19.ts` with change counts 0..19 (so
   * `p18`/`p19` are the top 10%, both ≥ the floor), plus three heavily
   * churned test files that would push the cut above them.
   */
  function hotspotFixture() {
    const prod = Array.from({ length: 20 }, (_, i) => node(`p${i}`, `src/p${i}.ts`));
    const tests = [node('t1', 'src/a.test.ts'), node('t2', 'src/__tests__/b.ts'), node('t3', 'src/testRender.ts')];
    const fileRows = [
      ...prod.map((n, i) => ({ file: n.file, changeCount: i })),
      { file: 'src/a.test.ts', changeCount: 100 },
      { file: 'src/__tests__/b.ts', changeCount: 90 },
      { file: 'src/testRender.ts', changeCount: 80 },
    ];
    return { prod, tests, fileRows };
  }

  const severeHotspots = (ns: CodeMapNode[]) =>
    ns.filter((n) => n.id.startsWith('p') && severityOf(n.riskSignals, 'hotspot') === 'severe').map((n) => n.id);

  it('drops excluded files before the join', () => {
    const { prod, tests, fileRows } = hotspotFixture();
    const joined = joinHotspotChangeCounts([...prod, ...tests], fileRows, isTestPath);
    assert.deepEqual(
      joined.filter((n) => n.id.startsWith('t')).map((n) => n.hotspotChangeCount),
      [undefined, undefined, undefined],
    );
    assert.equal(joined.find((n) => n.id === 'p7')!.hotspotChangeCount, 7);
  });

  it('the hotspot severe cut for production files is identical with and without test files present', () => {
    const { prod, tests, fileRows } = hotspotFixture();
    const productionOnly = joinHotspotChangeCounts(
      prod,
      fileRows.filter((row) => row.file.startsWith('src/p')),
    );
    const expected = riskFor(productionOnly, []);
    const filtered = excludeTestCode(joinHotspotChangeCounts([...prod, ...tests], fileRows, isTestPath), []);
    const actual = riskFor(filtered.nodes, filtered.edges);
    for (let i = 0; i < 20; i++) {
      assert.deepStrictEqual(signalsOf(actual, `p${i}`), signalsOf(expected, `p${i}`), `p${i}`);
    }
    assert.deepEqual(severeHotspots(expected), ['p18', 'p19']);
    // Not vacuous: with the test files in the population, the cut moves.
    const polluted = riskFor(joinHotspotChangeCounts([...prod, ...tests], fileRows), []);
    assert.notDeepStrictEqual(severeHotspots(polluted), severeHotspots(expected));
  });
});
