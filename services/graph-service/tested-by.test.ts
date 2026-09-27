/**
 * P4-2 phase 2: `attachTestedBy` and the evidence it reads. Only
 * import-resolved test→production `CALLS` with a reported confidence, and
 * `TESTS_FILE`, count; name-only matches and test helpers (e.g.
 * `testRender`) never do.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TESTED_BY_MAX_TESTS, type TestedBy } from '@driller/graph-contracts';

import {
  parseTestCallEvidenceRow,
  parseTestFileEvidenceRow,
  queryGraphTruncation,
  TEST_EVIDENCE_CALLS_QUERY,
  TEST_EVIDENCE_FILES_QUERY,
  type TestCallEvidence,
  type TestEvidence,
} from './mcp-client';
import { attachTestedBy, isImportResolvedCall, isTestEvidenceSource } from './tested-by';
import { IMPORT_RESOLVED_CALL_STRATEGIES, TEST_CALLER_PATH_FRAGMENTS } from './test-evidence-strategies';
import { isTestSupportPath } from './test-code';

interface Node {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  kind: string;
  isTest?: boolean;
}

function fn(id: string, file: string, startLine = 1, endLine = startLine + 4): Node {
  return { id, name: id, file, startLine, endLine, kind: 'Function' };
}

function mod(file: string, endLine = 500): Node {
  return { id: `mod:${file}`, name: file, file, startLine: 1, endLine, kind: 'Module' };
}

/** A CALLS evidence row from `caller` (its own details, as the query returns them) to `target`. */
function call(caller: Node, target: string, strategy = 'import_map', extra: Partial<TestCallEvidence> = {}): TestCallEvidence {
  return {
    source: caller.id,
    sourceName: caller.name,
    sourceFile: caller.file,
    sourceStartLine: caller.startLine,
    sourceEndLine: caller.endLine,
    sourceKind: caller.kind === 'Module' ? 'Module' : caller.kind === 'Method' ? 'Method' : 'Function',
    ...(caller.isTest === true ? { sourceIsTest: true } : {}),
    target,
    strategy,
    confidence: 0.95,
    ...extra,
  };
}

function evidence(calls: TestCallEvidence[], testFiles: TestEvidence['testFiles'] = []): TestEvidence {
  return { calls, testFiles };
}

function testedByOf(nodes: Node[], id: string): TestedBy | undefined {
  const node = nodes.find((candidate) => candidate.id === id) as (Node & { testedBy?: TestedBy }) | undefined;
  assert.ok(node, `${id} is present`);
  return node.testedBy;
}

/** The invariant the UI relies on: the full count is never below the carried list. */
function assertInvariant(nodes: Node[]): void {
  for (const node of nodes as (Node & { testedBy?: TestedBy })[]) {
    if (node.testedBy !== undefined) {
      assert.ok(node.testedBy.totalTests >= node.testedBy.tests.length, `${node.id}: totalTests < tests.length`);
      assert.ok(node.testedBy.tests.length <= TESTED_BY_MAX_TESTS, `${node.id}: more than the cap carried`);
    }
  }
}

const PROD = fn('formatSyncAge', 'src/format.ts', 10, 20);

describe('attachTestedBy', () => {
  it('lists a function called by 3 tests through imports', () => {
    const rendersAge = fn('rendersAge', 'src/format.test.ts', 5);
    const handlesZero = { ...fn('handlesZero', 'src/other.test.ts', 40), isTest: true };
    const appFrame = mod('src/appFrame.test.ts');
    const result = attachTestedBy([PROD, rendersAge, handlesZero, appFrame], {
      calls: [
        call(rendersAge, 'formatSyncAge'),
        call(handlesZero, 'formatSyncAge', 'lsp_ts_import'),
        call(appFrame, 'formatSyncAge', 'import_map', { line: 381 }),
      ],
      testFiles: [],
    });
    assert.deepEqual(testedByOf(result, 'formatSyncAge'), {
      tests: [
        // A test file's top level: named after the file, opened at the call's own line.
        {
          id: 'mod:src/appFrame.test.ts',
          name: 'appFrame.test.ts',
          file: 'src/appFrame.test.ts',
          startLine: 381,
          endLine: 381,
          topLevel: true,
        },
        { id: 'rendersAge', name: 'rendersAge', file: 'src/format.test.ts', startLine: 5, endLine: 9 },
        { id: 'handlesZero', name: 'handlesZero', file: 'src/other.test.ts', startLine: 40, endLine: 44 },
      ],
      totalTests: 3,
      files: [],
    });
    assertInvariant(result);
  });

  it('credits a Method caller that is not a map Node (class-based test frameworks)', () => {
    const method: Node = { ...fn('FormatTest.testAge', 'src/test/FormatTest.java', 12), kind: 'Method' };
    // The Method is not in `nodes`: callers come from the evidence rows themselves.
    const result = attachTestedBy([PROD], evidence([call(method, 'formatSyncAge')]));
    assert.deepEqual(testedByOf(result, 'formatSyncAge')?.tests, [
      { id: 'FormatTest.testAge', name: 'FormatTest.testAge', file: 'src/test/FormatTest.java', startLine: 12, endLine: 16 },
    ]);
  });

  it('never admits a name-only, low-confidence or confidence-less CALLS edge', () => {
    const t = fn('t', 'src/format.test.ts');
    const nodes = [PROD, t];
    for (const strategy of ['unique_name', 'suffix_match', 'callee_suffix', 'import_map_suffix', 'fuzzy', 'same_module', 'lsp_ts_local', 'lsp_import_alias', 'lsp_static_import']) {
      const result = attachTestedBy(nodes, evidence([call(t, 'formatSyncAge', strategy)]));
      assert.equal(testedByOf(result, 'formatSyncAge'), undefined, strategy);
    }
    const lowConfidence = attachTestedBy(nodes, evidence([call(t, 'formatSyncAge', 'import_map', { confidence: 0.5 })]));
    assert.equal(testedByOf(lowConfidence, 'formatSyncAge'), undefined);
    const { confidence: _dropped, ...noConfidence } = call(t, 'formatSyncAge');
    assert.equal(testedByOf(attachTestedBy(nodes, evidence([noConfidence])), 'formatSyncAge'), undefined);
    // Every allowed strategy does count.
    for (const strategy of IMPORT_RESOLVED_CALL_STRATEGIES) {
      const result = attachTestedBy(nodes, evidence([call(t, 'formatSyncAge', strategy)]));
      assert.equal(testedByOf(result, 'formatSyncAge')?.totalTests, 1, strategy);
    }
  });

  it('never lists a test helper such as testRender, as a caller or a TESTS_FILE source', () => {
    const helpers = [
      fn('renderTree', 'apps/desktop/renderer/src/testRender.ts'),
      fn('helper', 'src/test-utils.tsx'),
      fn('fixture', 'tests/conftest.py'),
      fn('mocked', 'src/__mocks__/format.ts'),
    ];
    const result = attachTestedBy(
      [PROD, ...helpers],
      evidence(
        helpers.map((helper) => call(helper, 'formatSyncAge')),
        [{ testFile: 'apps/desktop/renderer/src/testRender.ts', file: 'src/format.ts' }],
      ),
    );
    assert.equal(testedByOf(result, 'formatSyncAge'), undefined);
    assert.ok(isTestSupportPath('apps/desktop/renderer/src/testRender.ts'));
    assert.ok(!isTestSupportPath('src/format.test.ts'));
  });

  it('classifies callers and TESTS_FILE sources the same way: backend flag or path', () => {
    // A flagged caller outside any test path counts; so does a flagless one on a test path.
    const flagged = { ...fn('flagged', 'src/checks/fmt.ts'), isTest: true };
    const byPath = fn('byPath', 'src/__tests__/fmt.ts');
    const result = attachTestedBy([PROD], evidence([call(flagged, 'formatSyncAge'), call(byPath, 'formatSyncAge')]));
    assert.equal(testedByOf(result, 'formatSyncAge')?.totalTests, 2);
    assert.equal(isTestEvidenceSource({ file: 'src/__tests__/fmt.ts' }), true);
    assert.equal(isTestEvidenceSource({ file: 'src/checks/fmt.ts', isTest: true }), true);
    assert.equal(isTestEvidenceSource({ file: 'src/checks/fmt.ts' }), false);
    const byFile = attachTestedBy([PROD], evidence([], [{ testFile: 'src/__tests__/format.ts', file: 'src/format.ts' }]));
    assert.deepEqual(testedByOf(byFile, 'formatSyncAge')?.files, [{ file: 'src/__tests__/format.ts' }]);
  });

  it('never credits a call whose caller or target id is shared by a test and a production Node', () => {
    const shared = fn('shared', 'src/shared.test.ts');
    const sharedProd = fn('shared', 'src/shared.ts');
    const t = fn('t', 'src/format.test.ts');
    const sharedTarget = fn('formatSyncAge', 'src/format.test.ts', 100);
    const byCaller = attachTestedBy([PROD, shared, sharedProd], evidence([call(shared, 'formatSyncAge')]));
    assert.equal(testedByOf(byCaller, 'formatSyncAge'), undefined);
    const byTarget = attachTestedBy([PROD, t, sharedTarget], evidence([call(t, 'formatSyncAge')]));
    assert.equal(testedByOf(byTarget, 'formatSyncAge'), undefined);
  });

  it("attaches a TESTS_FILE link at file level, with the test file's range from its Module", () => {
    const nodes = [PROD, fn('parseAge', 'src/format.ts', 30), fn('other', 'src/other.ts'), mod('src/format.test.ts', 120)];
    const result = attachTestedBy(nodes, evidence([], [{ testFile: 'src/format.test.ts', file: 'src/format.ts' }]));
    for (const id of ['formatSyncAge', 'parseAge']) {
      assert.deepEqual(testedByOf(result, id), {
        tests: [],
        totalTests: 0,
        files: [{ file: 'src/format.test.ts', startLine: 1, endLine: 120 }],
      });
    }
    assert.equal(testedByOf(result, 'other'), undefined);
  });

  it('carries direct rows and TESTS_FILE files together', () => {
    const t = fn('t', 'src/format.test.ts', 7);
    const result = attachTestedBy(
      [PROD, t, mod('src/format.test.ts', 60)],
      evidence([call(t, 'formatSyncAge')], [{ testFile: 'src/format.test.ts', file: 'src/format.ts' }]),
    );
    assert.deepEqual(testedByOf(result, 'formatSyncAge'), {
      tests: [{ id: 't', name: 't', file: 'src/format.test.ts', startLine: 7, endLine: 11 }],
      totalTests: 1,
      files: [{ file: 'src/format.test.ts', startLine: 1, endLine: 60 }],
    });
  });

  it('ignores a TESTS_FILE edge whose source is not a test file, or whose target is', () => {
    const nodes = [PROD];
    const result = attachTestedBy(
      nodes,
      evidence([], [
        { testFile: 'src/format.ts', file: 'src/format.ts' },
        { testFile: 'src/a.test.ts', file: 'src/b.test.ts' },
      ]),
    );
    assert.equal(testedByOf(result, 'formatSyncAge'), undefined);
    assert.equal(result, nodes, 'nothing gained evidence: the input array itself comes back');
  });

  it(`caps tests at ${TESTED_BY_MAX_TESTS} with the full count for 30 direct tests`, () => {
    const tests = Array.from({ length: 30 }, (_, i) => fn(`t${String(i).padStart(2, '0')}`, 'src/format.test.ts', 10 + i * 10));
    const result = attachTestedBy([PROD, ...tests], evidence(tests.map((test) => call(test, 'formatSyncAge'))));
    const testedBy = testedByOf(result, 'formatSyncAge');
    assert.equal(testedBy?.tests.length, 20);
    assert.equal(testedBy?.totalTests, 30);
    assert.deepEqual(
      testedBy?.tests.map((test) => test.id),
      tests.slice(0, 20).map((test) => test.id),
      'sorted by line, first 20 kept',
    );
    assertInvariant(result);
  });

  it('sorts across files by path, then line', () => {
    const callers = [
      fn('z1', 'src/z.test.ts', 5),
      fn('a2', 'src/a.test.ts', 50),
      fn('m1', 'src/m.test.ts', 1),
      fn('a1', 'src/a.test.ts', 3),
    ];
    const result = attachTestedBy([PROD, ...callers], evidence(callers.map((caller) => call(caller, 'formatSyncAge'))));
    assert.deepEqual(testedByOf(result, 'formatSyncAge')?.tests.map((test) => test.id), ['a1', 'a2', 'm1', 'z1']);
  });

  it('sorts TESTS_FILE files by path, deduplicated, with the invariant kept', () => {
    const result = attachTestedBy(
      [PROD, mod('src/z.test.ts', 9), mod('src/a.test.ts', 8)],
      evidence([], [
        { testFile: 'src/z.test.ts', file: 'src/format.ts' },
        { testFile: 'src/m.test.ts', file: 'src/format.ts' },
        { testFile: 'src/a.test.ts', file: 'src/format.ts' },
        { testFile: 'src/z.test.ts', file: 'src/format.ts' },
      ]),
    );
    assert.deepEqual(testedByOf(result, 'formatSyncAge')?.files, [
      { file: 'src/a.test.ts', startLine: 1, endLine: 8 },
      { file: 'src/m.test.ts' },
      { file: 'src/z.test.ts', startLine: 1, endLine: 9 },
    ]);
    assertInvariant(result);
  });

  it('works with direct evidence only when the backend has no TESTS_FILE', () => {
    const t = fn('t', 'src/format.test.ts');
    const result = attachTestedBy([PROD, t], evidence([call(t, 'formatSyncAge')], []));
    assert.deepEqual(testedByOf(result, 'formatSyncAge')?.files, []);
    assert.equal(testedByOf(result, 'formatSyncAge')?.totalTests, 1);
  });

  it('counts a test once however often it calls, preferring a real call line', () => {
    const top = mod('src/format.test.ts');
    const result = attachTestedBy(
      [PROD, top],
      evidence([
        // No reported line: would open at the Module's first line, a fallback.
        call(top, 'formatSyncAge'),
        call(top, 'formatSyncAge', 'import_map', { line: 90 }),
        call(top, 'formatSyncAge', 'import_map', { line: 12 }),
      ]),
    );
    const testedBy = testedByOf(result, 'formatSyncAge');
    assert.equal(testedBy?.totalTests, 1);
    assert.equal(testedBy?.tests[0]?.startLine, 12);
  });

  it('ignores production→production and test→test calls, and unknown targets', () => {
    const caller = fn('caller', 'src/app.ts');
    const t = fn('t', 'src/format.test.ts');
    const t2 = fn('t2', 'src/format.test.ts', 50);
    const nodes = [PROD, caller, t, t2];
    const result = attachTestedBy(nodes, evidence([call(caller, 'formatSyncAge'), call(t, 't2'), call(t, 'ghost')]));
    for (const node of result) {
      assert.equal((node as { testedBy?: unknown }).testedBy, undefined, node.id);
    }
  });
});

describe('isImportResolvedCall', () => {
  it('requires an allowed strategy and a reported confidence at or above the floor', () => {
    assert.equal(isImportResolvedCall({ strategy: 'import_map', confidence: 0.95 }), true);
    assert.equal(isImportResolvedCall({ strategy: 'import_map', confidence: 0.9 }), true);
    assert.equal(isImportResolvedCall({ strategy: 'import_map' }), false);
    assert.equal(isImportResolvedCall({ strategy: 'import_map', confidence: 0.89 }), false);
    assert.equal(isImportResolvedCall({ strategy: 'unique_name', confidence: 0.95 }), false);
  });
});

describe('Tested by evidence queries and rows', () => {
  it('the CALLS query limits callers to test code and strategies to the import-resolved ones', () => {
    assert.ok(TEST_EVIDENCE_CALLS_QUERY.includes('(a:Function|Method|Module)'));
    assert.ok(TEST_EVIDENCE_CALLS_QUERY.includes('a.is_test = true'));
    for (const fragment of TEST_CALLER_PATH_FRAGMENTS) {
      assert.ok(TEST_EVIDENCE_CALLS_QUERY.includes(`a.file_path CONTAINS '${fragment}'`), fragment);
    }
    for (const strategy of IMPORT_RESOLVED_CALL_STRATEGIES) {
      assert.ok(TEST_EVIDENCE_CALLS_QUERY.includes(`r.strategy = '${strategy}'`), strategy);
    }
    // Both OR groups are parenthesized and joined by AND, so neither can widen the other.
    assert.match(TEST_EVIDENCE_CALLS_QUERY, /WHERE \(a\.is_test = true OR [^)]*\) AND \(r\.strategy = /);
    assert.doesNotMatch(TEST_EVIDENCE_CALLS_QUERY, /unique_name|suffix|fuzzy/);
    for (const column of ['source', 'sourceName', 'sourceFile', 'sourceStartLine', 'sourceEndLine', 'sourceIsTest', 'sourceKind', 'target', 'strategy', 'confidence', 'line']) {
      assert.ok(TEST_EVIDENCE_CALLS_QUERY.includes(` AS ${column}`), column);
    }
    assert.match(TEST_EVIDENCE_FILES_QUERY, /\[r:TESTS_FILE\]/);
  });

  it('parses a live-shaped CALLS row (quoted numbers), and drops a malformed one', () => {
    const row = {
      source: 'p.appFrame.test',
      sourceName: 'apps/x/appFrame.test.ts',
      sourceFile: 'apps/x/appFrame.test.ts',
      sourceStartLine: '1',
      sourceEndLine: '519',
      sourceIsTest: 'true',
      sourceKind: 'Module',
      target: 'p.appFrame.formatSyncAge',
      strategy: 'import_map',
      confidence: '0.95',
      line: '381',
    };
    assert.deepEqual(parseTestCallEvidenceRow(row), {
      source: 'p.appFrame.test',
      sourceName: 'apps/x/appFrame.test.ts',
      sourceFile: 'apps/x/appFrame.test.ts',
      sourceStartLine: 1,
      sourceEndLine: 519,
      sourceKind: 'Module',
      sourceIsTest: true,
      target: 'p.appFrame.formatSyncAge',
      strategy: 'import_map',
      confidence: 0.95,
      line: 381,
    });
    const absent = parseTestCallEvidenceRow({ ...row, sourceIsTest: '-', confidence: '-', line: '-' });
    assert.ok(absent);
    assert.equal('confidence' in absent, false);
    assert.equal('line' in absent, false);
    assert.equal('sourceIsTest' in absent, false);
    assert.equal(parseTestCallEvidenceRow({ ...row, source: '' }), undefined);
    assert.equal(parseTestCallEvidenceRow({ ...row, sourceKind: 'Class' }), undefined);
    assert.equal(parseTestCallEvidenceRow({ ...row, sourceStartLine: '-' }), undefined);
    assert.equal(parseTestCallEvidenceRow({ ...row, strategy: '' }), undefined);
  });

  it('parses a TESTS_FILE row', () => {
    assert.deepEqual(parseTestFileEvidenceRow({ testFile: 'x.test.ts', file: 'x.ts' }), { testFile: 'x.test.ts', file: 'x.ts' });
    assert.equal(parseTestFileEvidenceRow({ testFile: 'x.test.ts' }), undefined);
  });

  it('detects a possibly truncated query_graph result', () => {
    assert.equal(queryGraphTruncation('rows: 2  (cols: a)\n  x\n  y\ntotal: 2\n'), undefined);
    assert.equal(queryGraphTruncation('rows: 0  (cols: a)\ntotal: 0\nhint: "none"\n'), undefined);
    assert.match(queryGraphTruncation('rows: 2  (cols: a)\n  x\n  y\ntotal: 5\n') ?? '', /2 of 5/);
    assert.match(queryGraphTruncation('rows: 100000  (cols: a)\ntotal: 100000\n') ?? '', /ceiling/);
    assert.ok(queryGraphTruncation('rows: 2  (cols: a)\n  x\n  y\nhas_more: true\n'));
    assert.ok(queryGraphTruncation('rows: 2  (cols: a)\n  x\n  y\nnext_cursor: abc\n'));
  });
});
