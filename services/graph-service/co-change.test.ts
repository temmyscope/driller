/**
 * `attachCoChanges` — which files a Node's own file has a history of
 * changing alongside.
 *
 * This is the signal a diff cannot give: a reviewer sees that the contract
 * changed and that `preload` did not, when the two have never changed apart.
 * The scenarios below are driller's own measured coupling (2026-10-21):
 * `ipc-contracts` ↔ `main`, `preload` and `graph-service` at scores 0.74 to
 * 1.00, and `CodeMap.tsx` ↔ `styles.css` at 52 commits.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CO_CHANGE_MAX_ENTRIES,
  CO_CHANGE_MIN_COMMITS,
  CO_CHANGE_MIN_SCORE,
  type CoChangingFile,
} from '@driller/graph-contracts';

import { attachCoChanges } from './co-change';
import type { CoChangePair } from './mcp-client';

interface TestNode {
  id: string;
  name: string;
  file: string;
  kind: string;
  isTest?: boolean;
  coChangesWith?: CoChangingFile[];
  coChangesWithTotal?: number;
}

const CONTRACT = 'packages/ipc-contracts/src/index.ts';
const MAIN = 'apps/desktop/main/index.ts';
const PRELOAD = 'apps/desktop/preload/index.ts';
const SERVICE = 'services/graph-service/index.ts';

const node = (file: string, name: string, extra: Partial<TestNode> = {}): TestNode => ({
  id: `${file}::${name}`,
  name,
  file,
  kind: 'Function',
  ...extra,
});

const pair = (a: string, b: string, coChanges: number, score: number): CoChangePair => ({
  file: a,
  partner: b,
  coChanges,
  score,
});

/** driller's own IPC boundary: the contract, and the three files that move with it. */
const IPC_BOUNDARY: CoChangePair[] = [
  pair(MAIN, CONTRACT, 32, 0.89),
  pair(PRELOAD, CONTRACT, 27, 1),
  pair(CONTRACT, SERVICE, 34, 0.74),
];

describe('a Node learns which files its own file changes alongside', () => {
  it('names them on the Node, strongest coupling first', () => {
    const [contract] = attachCoChanges([node(CONTRACT, 'IpcChannels')], IPC_BOUNDARY);
    assert.deepEqual(
      contract!.coChangesWith?.map((entry) => entry.file),
      [SERVICE, MAIN, PRELOAD],
      'ordered by how many commits touched both',
    );
    assert.equal(contract!.coChangesWithTotal, 3);
  });

  it('reads a pair from either side, so both files learn about the other', () => {
    const [main] = attachCoChanges([node(MAIN, 'registerIpcHandlers')], IPC_BOUNDARY);
    assert.deepEqual(main!.coChangesWith?.map((entry) => entry.file), [CONTRACT]);
    assert.equal(main!.coChangesWith?.[0]?.coChanges, 32);
    assert.equal(main!.coChangesWith?.[0]?.score, 0.89);
  });

  it('gives every Node in a file the same partners', () => {
    const nodes = attachCoChanges([node(CONTRACT, 'IpcChannels'), node(CONTRACT, 'CodeMapResult')], IPC_BOUNDARY);
    assert.deepEqual(nodes[0]!.coChangesWith, nodes[1]!.coChangesWith);
  });

  it('never names the Node’s own file', () => {
    const [service] = attachCoChanges([node(SERVICE, 'handleIndexRequest')], [
      ...IPC_BOUNDARY,
      pair(SERVICE, SERVICE, 40, 1),
    ]);
    assert.ok(!service!.coChangesWith?.some((entry) => entry.file === SERVICE));
  });

  it('says nothing when the file has no qualifying partner', () => {
    const [lonely] = attachCoChanges([node('apps/desktop/renderer/src/contrast.ts', 'contrastRatio')], IPC_BOUNDARY);
    assert.equal(lonely!.coChangesWith, undefined, 'absent, never an empty array');
    assert.equal(lonely!.coChangesWithTotal, undefined);
  });
});

describe('attachCoChanges only reports coupling it can defend', () => {
  it('drops a pair with too little history behind it', () => {
    const thin = CO_CHANGE_MIN_COMMITS - 1;
    const [main] = attachCoChanges([node(MAIN, 'x')], [pair(MAIN, CONTRACT, thin, 1)]);
    assert.equal(main!.coChangesWith, undefined, `${thin} commits is below the floor`);
  });

  it('drops a pair that changed together only incidentally', () => {
    const weak = CO_CHANGE_MIN_SCORE - 0.1;
    const [main] = attachCoChanges([node(MAIN, 'x')], [pair(MAIN, CONTRACT, 40, weak)]);
    assert.equal(main!.coChangesWith, undefined, `a score of ${weak} is incidental, not coupling`);
  });

  it('keeps a pair exactly at each floor', () => {
    const [main] = attachCoChanges(
      [node(MAIN, 'x')],
      [pair(MAIN, CONTRACT, CO_CHANGE_MIN_COMMITS, CO_CHANGE_MIN_SCORE)],
    );
    assert.equal(main!.coChangesWith?.length, 1);
  });

  it('ignores test files on either side — a file changing with its own test is not news', () => {
    const [codeMap] = attachCoChanges([node('apps/desktop/renderer/src/CodeMap.tsx', 'CodeMap')], [
      pair('apps/desktop/renderer/src/CodeMap.tsx', 'apps/desktop/renderer/src/CodeMap.smoke.dom.test.tsx', 30, 1),
      pair('apps/desktop/renderer/src/CodeMap.tsx', 'apps/desktop/renderer/src/styles.css', 52, 0.8),
    ]);
    assert.deepEqual(
      codeMap!.coChangesWith?.map((entry) => entry.file),
      ['apps/desktop/renderer/src/styles.css'],
    );
  });

  it('says nothing about a test Node itself', () => {
    const [test] = attachCoChanges(
      [node('apps/desktop/main/index.test.ts', 'suite', { isTest: true })],
      [pair('apps/desktop/main/index.test.ts', CONTRACT, 30, 1)],
    );
    assert.equal(test!.coChangesWith, undefined);
  });

  it('caps what it carries and still reports the true total', () => {
    const many = Array.from({ length: CO_CHANGE_MAX_ENTRIES + 5 }, (_unused, index) =>
      pair(MAIN, `apps/desktop/other${index}.ts`, 10 + index, 0.9),
    );
    const [main] = attachCoChanges([node(MAIN, 'x')], many);
    assert.equal(main!.coChangesWith?.length, CO_CHANGE_MAX_ENTRIES);
    assert.equal(main!.coChangesWithTotal, CO_CHANGE_MAX_ENTRIES + 5);
  });

  it('is deterministic whatever order the pairs arrive in', () => {
    const forward = attachCoChanges([node(CONTRACT, 'x')], IPC_BOUNDARY);
    const reversed = attachCoChanges([node(CONTRACT, 'x')], [...IPC_BOUNDARY].reverse());
    assert.deepEqual(reversed[0]!.coChangesWith, forward[0]!.coChangesWith);
  });

  it('re-derives from scratch, so a scoped subset never keeps a stale partner', () => {
    const stale: CoChangingFile[] = [{ file: 'gone.ts', coChanges: 99, score: 1 }];
    const [main] = attachCoChanges(
      [node(MAIN, 'x', { coChangesWith: stale, coChangesWithTotal: 1 })],
      [pair(MAIN, CONTRACT, 32, 0.89)],
    );
    assert.deepEqual(main!.coChangesWith?.map((entry) => entry.file), [CONTRACT]);
  });
});
