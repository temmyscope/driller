/**
 * P4-2 phase 1: the Code Map Node query's `isTest` column is actually parsed
 * off a real-shaped `query_graph` text block, and the query's columns match
 * what the parser reads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CODE_MAP_NODES_QUERY, parseCodeMapNodeRow, parseQueryGraphRows, parseTestFlag } from './mcp-client';

const NODE_COLUMNS = ['id', 'name', 'file', 'startLine', 'endLine', 'kind', 'complexity', 'cognitive', 'isTest'];

describe('CODE_MAP_NODES_QUERY', () => {
  it('returns exactly the columns parseCodeMapNodeRow reads, isTest included', () => {
    const aliases = [...CODE_MAP_NODES_QUERY.matchAll(/ AS (\w+)/g)].map((match) => match[1]);
    assert.deepEqual(aliases, NODE_COLUMNS);
    assert.match(CODE_MAP_NODES_QUERY, /n\.is_test AS isTest/);
  });
});

describe('parseTestFlag', () => {
  const cases: [unknown, boolean][] = [
    [true, true],
    ['true', true],
    ['True', true],
    ['TRUE', true],
    ['1', true],
    [1, true],
    [false, false],
    ['false', false],
    ['-', false],
    ['', false],
    [undefined, false],
    ['0', false],
    ['yes', false],
  ];
  for (const [value, expected] of cases) {
    it(`${JSON.stringify(value)} → ${expected}`, () => {
      assert.equal(parseTestFlag(value), expected);
    });
  }
});

describe('parseCodeMapNodeRow over a real-shaped query_graph response', () => {
  // The backend's plain-text table (see `parseCodeMapRows`'s doc comment):
  // numeric and boolean columns come back quoted, an absent property as `-`.
  const text = [
    `rows: 6  (cols: ${NODE_COLUMNS.join(' ')})`,
    '  proj.src.a.run run src/a.ts "1" "9" Function "4" "7" "false"',
    '  proj.src.a_test.it it src/a.test.ts "1" "3" Function "0" "0" "true"',
    '  proj.src.a_test.Shape Shape src/a.test.ts "4" "6" Interface "0" "0" "false"',
    '  proj.src.fixtures.make make src/fixtures.ts "1" "2" Function "1" "1" "True"',
    '  proj.src.b.helper helper src/b.ts "1" "2" Function "1" "1" -',
    '  proj.src.c.flagged flagged src/c.ts "1" "2" Function "1" "1" "1"',
    'total: 6',
  ].join('\n');

  it('sets isTest only when the backend flag is true', () => {
    const rows = parseQueryGraphRows(text, 'test');
    assert.equal(rows.length, 6);
    const nodes = rows.map(parseCodeMapNodeRow);
    assert.deepEqual(
      nodes.map((n) => [n?.id.split('.').pop(), n?.isTest]),
      [
        ['run', undefined],
        ['it', true],
        ['Shape', undefined],
        ['make', true],
        ['helper', undefined],
        ['flagged', true],
      ],
    );
    // Absent, not `false`: the key itself is omitted.
    assert.equal('isTest' in nodes[0]!, false);
    assert.equal(nodes[0]!.complexity, 4);
  });
});
