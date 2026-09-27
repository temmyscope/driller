/**
 * P4-2 phase 3a: `findTopLevelOnlyChangedFiles` names the changed files whose
 * only map content is folded top-level code, so PR Review never reports a
 * top-level-only diff as "0 changed Nodes" with no explanation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findChangedNodeIds, findTopLevelOnlyChangedFiles } from './index';

const nodes = [
  { id: 'f', file: 'src/a.ts' },
  { id: 'g', file: 'src/b.ts' },
];
const range = (file: string, endLine: number) => ({ file, startLine: 1, endLine });
const folded = [range('src/a.ts', 5), range('src/boot.ts', 9), range('src/cli.ts', 30)];

describe('findTopLevelOnlyChangedFiles', () => {
  it('lists a changed file with folded top-level code and no map Node', () => {
    assert.deepEqual(findTopLevelOnlyChangedFiles(nodes, folded, ['src/boot.ts']), [range('src/boot.ts', 9)]);
    // …and that change contributes no changed Node.
    assert.deepEqual(findChangedNodeIds(nodes, ['src/boot.ts']), []);
  });

  it('does not list a changed file that has map Nodes (they already count as changed)', () => {
    assert.deepEqual(findTopLevelOnlyChangedFiles(nodes, folded, ['src/a.ts']), []);
  });

  it('does not list a changed file with no folded top-level code', () => {
    assert.deepEqual(findTopLevelOnlyChangedFiles(nodes, folded, ['README.md', 'src/b.ts']), []);
  });

  it('keeps changedFiles order and lists each file once, with its top-level range', () => {
    assert.deepEqual(
      findTopLevelOnlyChangedFiles(nodes, folded, ['src/cli.ts', 'src/a.ts', 'src/boot.ts', 'src/cli.ts']),
      [range('src/cli.ts', 30), range('src/boot.ts', 9)],
    );
  });
});
