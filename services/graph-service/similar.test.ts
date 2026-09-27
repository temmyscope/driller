/**
 * P4-2 phase 4: `attachSimilar` — "Similar implementations" come only from
 * the backend's `SIMILAR_TO` pairs, between production map Functions in
 * different files, at jaccard ≥ `SIMILAR_TO_MIN_JACCARD`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SIMILAR_TO_MAX_ENTRIES, SIMILAR_TO_MIN_JACCARD, type SimilarImplementation } from '@driller/graph-contracts';

import type { SimilarPair } from './mcp-client';
import { attachSimilar, compareSimilar, isSimilarEnough } from './similar';

interface TestNode {
  id: string;
  name: string;
  file: string;
  kind: string;
  isTest?: boolean;
  similarTo?: SimilarImplementation[];
  similarToTotal?: number;
}

const fn = (id: string, file: string, overrides: Partial<TestNode> = {}): TestNode => ({
  id,
  name: id.split('.').pop() ?? id,
  file,
  kind: 'Function',
  ...overrides,
});

const pair = (source: string, target: string, score = 1, sameFile?: true): SimilarPair => ({
  source,
  target,
  score,
  ...(sameFile ? { sameFile } : {}),
});

const similarOf = (nodes: TestNode[], id: string) => nodes.find((node) => node.id === id)?.similarTo;

describe('attachSimilar', () => {
  it('the threshold is 0.9, inclusive', () => {
    assert.equal(SIMILAR_TO_MIN_JACCARD, 0.9);
    assert.equal(isSimilarEnough(0.9), true);
    assert.equal(isSimilarEnough(0.89), false);
    assert.equal(isSimilarEnough(Number.NaN), false);
    assert.equal(isSimilarEnough(1), true);
    assert.equal(isSimilarEnough(1.5), false);
  });

  it('withTimeout in 5 files: each lists the 4 others at 1.00 (edges stored once per pair are read both ways)', () => {
    const files = ['judgment-generator', 'mcp-client', 'model-manager', 'summary-generator', 'cloud-summary-generator'];
    const nodes = files.map((file) => fn(`${file}.withTimeout`, `services/graph-service/${file}.ts`));
    const pairs: SimilarPair[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        pairs.push(pair(nodes[i]!.id, nodes[j]!.id));
      }
    }
    const result = attachSimilar(nodes, pairs);
    for (const node of result) {
      assert.equal(node.similarToTotal, 4);
      assert.deepEqual(
        node.similarTo?.map((entry) => [entry.name, entry.score]),
        [
          ['withTimeout', 1],
          ['withTimeout', 1],
          ['withTimeout', 1],
          ['withTimeout', 1],
        ],
      );
      assert.ok(node.similarTo?.every((entry) => entry.file !== node.file && entry.id !== node.id));
    }
    // Sorted by file among equal scores and names.
    assert.deepEqual(
      similarOf(result, 'mcp-client.withTimeout')?.map((entry) => entry.file),
      [
        'services/graph-service/cloud-summary-generator.ts',
        'services/graph-service/judgment-generator.ts',
        'services/graph-service/model-manager.ts',
        'services/graph-service/summary-generator.ts',
      ],
    );
  });

  it('a pair below 0.9 is not listed; one at 0.953 is', () => {
    const nodes = [fn('a.f', 'src/a.ts'), fn('b.f', 'src/b.ts'), fn('c.f', 'src/c.ts')];
    const result = attachSimilar(nodes, [pair('a.f', 'b.f', 0.85), pair('a.f', 'c.f', 0.953)]);
    assert.deepEqual(similarOf(result, 'a.f'), [{ id: 'c.f', name: 'f', file: 'src/c.ts', score: 0.953 }]);
    assert.equal(similarOf(result, 'b.f'), undefined);
  });

  it('a same-file pair is not listed — by the backend flag, and by the Nodes\' own files', () => {
    const nodes = [fn('a.f', 'src/a.ts'), fn('a.g', 'src/a.ts'), fn('b.f', 'src/b.ts')];
    const byFile = attachSimilar(nodes, [pair('a.f', 'a.g')]);
    assert.ok(byFile.every((node) => node.similarTo === undefined && node.similarToTotal === undefined));
    const byFlag = attachSimilar(nodes, [pair('a.f', 'b.f', 1, true)]);
    assert.ok(byFlag.every((node) => node.similarTo === undefined));
  });

  it('a test end (by path or by the backend flag), a test-support end, or a non-Function end is not listed', () => {
    const nodes = [
      fn('a.f', 'src/a.ts'),
      fn('t.f', 'src/a.test.ts'),
      fn('x.f', 'src/fixtures.ts', { isTest: true }),
      fn('r.f', 'src/testRender.ts'),
      fn('i.T', 'src/types.ts', { kind: 'Interface' }),
      fn('m.M', 'src/mod.ts', { kind: 'Module' }),
    ];
    const pairs = ['t.f', 'x.f', 'r.f', 'i.T', 'm.M'].map((other) => pair('a.f', other));
    const result = attachSimilar(nodes, pairs);
    assert.ok(result.every((node) => node.similarTo === undefined), JSON.stringify(result));
  });

  it('an end that is no Node (e.g. out of scope), a self-pair, or an ambiguous id is not listed', () => {
    const nodes = [fn('a.f', 'src/a.ts'), fn('dup', 'src/b.ts'), fn('dup', 'src/c.ts')];
    const result = attachSimilar(nodes, [pair('a.f', 'gone'), pair('a.f', 'a.f'), pair('a.f', 'dup')]);
    assert.ok(result.every((node) => node.similarTo === undefined));
  });

  it('a pair seen twice (either direction) is listed once, at its higher score', () => {
    const nodes = [fn('a.f', 'src/a.ts'), fn('b.f', 'src/b.ts')];
    const result = attachSimilar(nodes, [pair('a.f', 'b.f', 0.92), pair('b.f', 'a.f', 0.97)]);
    assert.deepEqual(similarOf(result, 'a.f'), [{ id: 'b.f', name: 'f', file: 'src/b.ts', score: 0.97 }]);
    assert.equal(result[0]?.similarToTotal, 1);
  });

  it('sorts by score, then name, file and id', () => {
    const entries: SimilarImplementation[] = [
      { id: '3', name: 'b', file: 'x.ts', score: 1 },
      { id: '2', name: 'a', file: 'y.ts', score: 0.95 },
      { id: '1', name: 'a', file: 'x.ts', score: 1 },
    ];
    assert.deepEqual([...entries].sort(compareSimilar).map((entry) => entry.id), ['1', '3', '2']);
  });

  it(`caps the list at ${SIMILAR_TO_MAX_ENTRIES}, with similarToTotal the full count`, () => {
    const hub = fn('hub.f', 'src/hub.ts');
    const others = Array.from({ length: 30 }, (_, i) => fn(`o${String(i).padStart(2, '0')}.f`, `src/o${i}.ts`));
    const result = attachSimilar([hub, ...others], others.map((other) => pair(hub.id, other.id)));
    assert.equal(result[0]?.similarTo?.length, SIMILAR_TO_MAX_ENTRIES);
    assert.equal(result[0]?.similarToTotal, 30);
  });

  it('re-derives from scratch: a re-attach on a subset drops entries outside it, and old fields go when nothing qualifies', () => {
    const nodes = [fn('a.f', 'src/a.ts'), fn('b.f', 'src/b.ts'), fn('c.f', 'lib/c.ts')];
    const pairs = [pair('a.f', 'b.f'), pair('a.f', 'c.f', 0.95)];
    const full = attachSimilar(nodes, pairs);
    assert.equal(full[0]?.similarToTotal, 2);
    const scoped = attachSimilar(full.filter((node) => node.file.startsWith('src/')), pairs);
    assert.deepEqual(similarOf(scoped, 'a.f')?.map((entry) => entry.id), ['b.f']);
    assert.equal(scoped[0]?.similarToTotal, 1);
    const alone = attachSimilar(full.filter((node) => node.id === 'c.f'), pairs);
    assert.deepEqual(alone, [fn('c.f', 'lib/c.ts')]);
  });

  it('returns Nodes with nothing to attach unchanged (the same objects)', () => {
    const nodes = [fn('a.f', 'src/a.ts'), fn('b.f', 'src/b.ts')];
    const result = attachSimilar(nodes, []);
    assert.ok(result.every((node, index) => node === nodes[index]));
  });
});
