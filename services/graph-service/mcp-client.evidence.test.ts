/**
 * P4-2 phase 2 (review round 1): the Code Map's `query_graph` sequence,
 * driven through `runCodeMapQueries` with a stub `callTool`. Test evidence is
 * fetched only when asked for, both evidence queries go out together, rows
 * reach `testEvidence`, and an evidence query that errors, throws or hangs
 * leaves the map's nodes and edges intact.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  IMPLEMENTS_QUERY,
  parseImplementsRow,
  parseSimilarPairRow,
  runCodeMapQueries,
  SIMILAR_TO_QUERY,
  TEST_EVIDENCE_CALLS_QUERY,
  TEST_EVIDENCE_FILES_QUERY,
  type QueryGraphClient,
} from './mcp-client';

const text = (body: string) => ({ content: [{ type: 'text', text: body }] });

const NODES = text(
  'rows: 1  (cols: id name file startLine endLine kind complexity cognitive isTest)\n' +
    '  p.a.f f src/a.ts "1" "5" Function "1" "0" "false"\n' +
    'total: 1\n',
);
const EDGES = text('rows: 1  (cols: source target kind)\n  p.a.f p.a.f CALLS\ntotal: 1\n');
const FILES = text('rows: 1  (cols: file changeCount)\n  src/a.ts "3"\ntotal: 1\n');
const CALLS = text(
  'rows: 1  (cols: source sourceName sourceFile sourceStartLine sourceEndLine sourceIsTest sourceKind target strategy confidence line)\n' +
    '  p.a.test src/a.test.ts src/a.test.ts "1" "40" "true" Module p.a.f import_map "0.95" "12"\n' +
    'total: 1\n',
);
const TESTS_FILE = text('rows: 1  (cols: testFile file)\n  src/a.test.ts src/a.ts\ntotal: 1\n');

type Reply = unknown | (() => Promise<unknown>);

/** A `callTool` stub answering by query; records every query it was sent. */
function stubClient(overrides: Partial<Record<'calls' | 'files', Reply>> = {}) {
  const sent: string[] = [];
  const replies = new Map<string, Reply>([
    [TEST_EVIDENCE_CALLS_QUERY, overrides.calls ?? CALLS],
    [TEST_EVIDENCE_FILES_QUERY, overrides.files ?? TESTS_FILE],
  ]);
  const client = {
    callTool: async ({ arguments: args }: { arguments?: Record<string, unknown> }) => {
      const query = String(args?.query);
      sent.push(query);
      const reply = replies.get(query);
      if (reply !== undefined) {
        return typeof reply === 'function' ? (reply as () => Promise<unknown>)() : reply;
      }
      if (query.includes('[r:CALLS|USAGE]')) {
        return EDGES;
      }
      if (query.startsWith('MATCH (f:File)')) {
        return FILES;
      }
      return NODES;
    },
  } as unknown as QueryGraphClient;
  return { client, sent };
}

const evidenceQueries = (sent: string[]) =>
  sent.filter((query) => query === TEST_EVIDENCE_CALLS_QUERY || query === TEST_EVIDENCE_FILES_QUERY);

function assertMapIntact(result: Awaited<ReturnType<typeof runCodeMapQueries>>): void {
  assert.deepEqual(result.nodes.map((node) => [node.id, node.hotspotChangeCount]), [['p.a.f', 3]]);
  assert.deepEqual(result.edges, [{ source: 'p.a.f', target: 'p.a.f', kind: 'CALLS' }]);
}

describe('runCodeMapQueries: Tested by evidence', () => {
  it('sends both evidence queries only with includeTestEvidence, and their rows reach testEvidence', async () => {
    const withFlag = stubClient();
    const result = await runCodeMapQueries(withFlag.client, 'p', { includeTestEvidence: true });
    assert.deepEqual(evidenceQueries(withFlag.sent).sort(), [TEST_EVIDENCE_CALLS_QUERY, TEST_EVIDENCE_FILES_QUERY].sort());
    assertMapIntact(result);
    assert.deepEqual(result.testEvidence, {
      calls: [
        {
          source: 'p.a.test',
          sourceName: 'src/a.test.ts',
          sourceFile: 'src/a.test.ts',
          sourceStartLine: 1,
          sourceEndLine: 40,
          sourceKind: 'Module',
          sourceIsTest: true,
          target: 'p.a.f',
          strategy: 'import_map',
          confidence: 0.95,
          line: 12,
        },
      ],
      testFiles: [{ testFile: 'src/a.test.ts', file: 'src/a.ts' }],
    });

    for (const options of [{}, { includeTestEvidence: false }]) {
      const without = stubClient();
      const plain = await runCodeMapQueries(without.client, 'p', options);
      assert.deepEqual(evidenceQueries(without.sent), [], JSON.stringify(options));
      assert.equal(plain.testEvidence, undefined);
      assertMapIntact(plain);
    }
  });

  it('sends the two evidence queries together, not one after the other', async () => {
    let releaseCalls!: () => void;
    const callsGate = new Promise<void>((resolve) => {
      releaseCalls = resolve;
    });
    const { client, sent } = stubClient({
      calls: async () => {
        await callsGate;
        return CALLS;
      },
    });
    const running = runCodeMapQueries(client, 'p', { includeTestEvidence: true });
    // Let the map queries and the first evidence query go out.
    for (let i = 0; i < 20 && evidenceQueries(sent).length < 2; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(evidenceQueries(sent).length, 2, 'the files query went out while the calls query was still pending');
    releaseCalls();
    await running;
  });

  const failures: [string, Reply][] = [
    ['reports isError', { isError: true, content: [{ type: 'text', text: 'boom' }] }],
    ['rejects', () => Promise.reject(new Error('transport closed'))],
    ['hangs past its timeout', () => new Promise(() => {})],
    ['returns an unparseable result', text('not a table')],
  ];
  for (const part of ['calls', 'files'] as const) {
    for (const [how, reply] of failures) {
      // The per-test `timeout` turns a missing evidence timeout into a failure, not a hung run.
      it(`keeps the map when the ${part} evidence query ${how}, with no rows for that part`, { timeout: 5000 }, async (t) => {
        const warn = mock.method(console, 'warn', () => {});
        t.after(() => warn.mock.restore());
        const { client } = stubClient({ [part]: reply });
        const result = await runCodeMapQueries(client, 'p', { includeTestEvidence: true }, 20);
        assertMapIntact(result);
        assert.ok(result.testEvidence);
        if (part === 'calls') {
          assert.deepEqual(result.testEvidence.calls, []);
          assert.equal(result.testEvidence.testFiles.length, 1, 'the other part still arrives');
        } else {
          assert.deepEqual(result.testEvidence.testFiles, []);
          assert.equal(result.testEvidence.calls.length, 1, 'the other part still arrives');
        }
        const warnings = warn.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes('Tested by'));
        assert.equal(warnings.length, 1, `one warning: ${warnings.join(' | ')}`);
      });
    }
  }

  it('logs, but keeps, an evidence result that may be truncated', async (t) => {
    const warn = mock.method(console, 'warn', () => {});
    t.after(() => warn.mock.restore());
    const cut = text('rows: 1  (cols: testFile file)\n  src/a.test.ts src/a.ts\ntotal: 7\n');
    const { client } = stubClient({ files: cut });
    const result = await runCodeMapQueries(client, 'p', { includeTestEvidence: true });
    assert.equal(result.testEvidence?.testFiles.length, 1);
    const warnings = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(warnings.some((m) => /Tested by \(test files\).*incomplete.*1 of 7/.test(m)), warnings.join(' | '));
  });

  it('a failing map query still fails the fetch (only evidence is best-effort)', async () => {
    const client = {
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'nodes down' }] }),
    } as unknown as QueryGraphClient;
    await assert.rejects(runCodeMapQueries(client, 'p', { includeTestEvidence: true }), /nodes down/);
  });
});

describe('runCodeMapQueries: P4-2 phase 3b IMPLEMENTS links', () => {
  const IMPLEMENTS = text('rows: 1  (cols: source target)\n  p.a.Rect p.a.Point\ntotal: 1\n');

  function implementsClient(reply: () => Promise<unknown>) {
    const sent: string[] = [];
    const client = {
      callTool: async ({ arguments: args }: { arguments?: Record<string, unknown> }) => {
        const query = String(args?.query);
        sent.push(query);
        if (query === IMPLEMENTS_QUERY) {
          return reply();
        }
        if (query.includes('[r:CALLS|USAGE]')) {
          return EDGES;
        }
        return query.startsWith('MATCH (f:File)') ? FILES : NODES;
      },
    } as unknown as QueryGraphClient;
    return { client, sent };
  }

  it('sends IMPLEMENTS_QUERY only with includeImplements, and its rows reach implementsLinks', async () => {
    const withFlag = implementsClient(async () => IMPLEMENTS);
    const result = await runCodeMapQueries(withFlag.client, 'p', { includeImplements: true });
    assert.deepEqual(result.implementsLinks, [{ source: 'p.a.Rect', target: 'p.a.Point' }]);
    assert.equal(result.testEvidence, undefined);
    assertMapIntact(result);

    const without = implementsClient(async () => IMPLEMENTS);
    const plain = await runCodeMapQueries(without.client, 'p', { includeTestEvidence: true });
    assert.ok(!without.sent.includes(IMPLEMENTS_QUERY));
    assert.equal(plain.implementsLinks, undefined);
  });

  it('parseImplementsRow drops a row with an empty or missing column', () => {
    assert.deepEqual(parseImplementsRow({ source: 'a', target: 'b' }), { source: 'a', target: 'b' });
    for (const row of [{ source: '', target: 'b' }, { source: 'a', target: '' }, { source: 'a' }, { target: 'b' }, {}]) {
      assert.equal(parseImplementsRow(row as Record<string, string>), undefined, JSON.stringify(row));
    }
  });

  it('keeps the map when the IMPLEMENTS query throws, with no links', async (t) => {
    const warn = mock.method(console, 'warn', () => {});
    t.after(() => warn.mock.restore());
    const { client } = implementsClient(async () => {
      throw new Error('boom');
    });
    const result = await runCodeMapQueries(client, 'p', { includeImplements: true });
    assert.deepEqual(result.implementsLinks, []);
    assertMapIntact(result);
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('Implements (implements) evidence unavailable')));
  });
});

describe('runCodeMapQueries: P4-2 phase 4 SIMILAR_TO pairs', () => {
  const SIMILAR = text(
    'rows: 2  (cols: source target jaccard sameFile)\n' +
      '  p.a.withTimeout p.b.withTimeout "1.000" "false"\n' +
      '  p.a.f p.a.g "0.984" "true"\n' +
      'total: 2\n',
  );

  function similarClient(reply: () => Promise<unknown>, implementsReply?: () => Promise<unknown>) {
    const sent: string[] = [];
    const client = {
      callTool: async ({ arguments: args }: { arguments?: Record<string, unknown> }) => {
        const query = String(args?.query);
        sent.push(query);
        if (query === SIMILAR_TO_QUERY) {
          return reply();
        }
        if (query === IMPLEMENTS_QUERY) {
          return implementsReply ? implementsReply() : text('rows: 0  (cols: source target)\ntotal: 0\n');
        }
        if (query.includes('[r:CALLS|USAGE]')) {
          return EDGES;
        }
        return query.startsWith('MATCH (f:File)') ? FILES : NODES;
      },
    } as unknown as QueryGraphClient;
    return { client, sent };
  }

  it('reads the backend properties confirmed with get_graph_schema, filtering on the 0.9 threshold', () => {
    assert.match(SIMILAR_TO_QUERY, /\(a:Function\)-\[r:SIMILAR_TO\]->\(b:Function\)/);
    assert.match(SIMILAR_TO_QUERY, /r\.jaccard >= 0\.9 /);
    assert.match(SIMILAR_TO_QUERY, /r\.jaccard AS jaccard/);
    assert.match(SIMILAR_TO_QUERY, /r\.same_file AS sameFile/);
    // Never filtered on same_file in Cypher: an older backend without it would drop every row.
    assert.doesNotMatch(SIMILAR_TO_QUERY, /same_file\s*=/);
  });

  it('sends SIMILAR_TO_QUERY only with includeSimilar, and its rows reach similarPairs', async () => {
    const withFlag = similarClient(async () => SIMILAR);
    const result = await runCodeMapQueries(withFlag.client, 'p', { includeSimilar: true });
    assert.deepEqual(result.similarPairs, [
      { source: 'p.a.withTimeout', target: 'p.b.withTimeout', score: 1 },
      { source: 'p.a.f', target: 'p.a.g', score: 0.984, sameFile: true },
    ]);
    assertMapIntact(result);

    const without = similarClient(async () => SIMILAR);
    const plain = await runCodeMapQueries(without.client, 'p', { includeTestEvidence: true, includeImplements: true });
    assert.ok(!without.sent.includes(SIMILAR_TO_QUERY));
    assert.equal(plain.similarPairs, undefined);
  });

  it('goes out alongside the other evidence queries, not after them', { timeout: 5000 }, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, sent } = similarClient(
      async () => SIMILAR,
      async () => {
        await gate;
        return text('rows: 0  (cols: source target)\ntotal: 0\n');
      },
    );
    const running = runCodeMapQueries(client, 'p', { includeImplements: true, includeSimilar: true });
    for (let i = 0; i < 20 && !sent.includes(SIMILAR_TO_QUERY); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(sent.includes(SIMILAR_TO_QUERY), 'SIMILAR_TO went out while IMPLEMENTS was still pending');
    release();
    await running;
  });

  const failures: [string, () => Promise<unknown>][] = [
    ['reports isError', async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] })],
    ['rejects', () => Promise.reject(new Error('transport closed'))],
    ['hangs past its timeout', () => new Promise(() => {})],
  ];
  for (const [how, reply] of failures) {
    it(`keeps the map when the SIMILAR_TO query ${how}, with no pairs`, { timeout: 5000 }, async (t) => {
      const warn = mock.method(console, 'warn', () => {});
      t.after(() => warn.mock.restore());
      const { client } = similarClient(reply);
      const result = await runCodeMapQueries(client, 'p', { includeSimilar: true }, 20);
      assert.deepEqual(result.similarPairs, []);
      assertMapIntact(result);
      const warnings = warn.mock.calls.map((c) => String(c.arguments[0]));
      assert.ok(
        warnings.some((m) => m.includes('Similar implementations (SIMILAR_TO) evidence unavailable')),
        warnings.join(' | '),
      );
    });
  }

  it('parseSimilarPairRow drops a row without both ids or a finite score; same_file is kept only when true', () => {
    assert.deepEqual(parseSimilarPairRow({ source: 'a', target: 'b', jaccard: '0.953', sameFile: 'false' }), {
      source: 'a',
      target: 'b',
      score: 0.953,
    });
    assert.deepEqual(parseSimilarPairRow({ source: 'a', target: 'b', jaccard: '1.000', sameFile: '-' }), {
      source: 'a',
      target: 'b',
      score: 1,
    });
    for (const row of [
      { source: '', target: 'b', jaccard: '1' },
      { source: 'a', target: '', jaccard: '1' },
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b', jaccard: '-' },
      { source: 'a', target: 'b', jaccard: 'NaN' },
      { source: 'a', target: 'b', jaccard: '-0.5' },
    ]) {
      assert.equal(parseSimilarPairRow(row as Record<string, string>), undefined, JSON.stringify(row));
    }
  });
});
