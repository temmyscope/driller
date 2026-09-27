/**
 * P4-2 phase 3a: `findTopLevelOnlyChangedFiles` names the changed files whose
 * only map content is folded top-level code, so PR Review never reports a
 * top-level-only diff as "0 changed Nodes" with no explanation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHANGED_CONTRACT_MAX_DEPENDENT_IDS,
  changedRangeInside,
  changedRangeTouches,
  findChangedContracts,
  findChangedNodeIds,
  findContractOnlyChangedFiles,
  findTopLevelOnlyChangedFiles,
  type FoldedType,
} from './index';

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

// ---------------------------------------------------------------------------
// P4-2 phase 3c: changed contracts
// ---------------------------------------------------------------------------

const type = (id: string, file: string, startLine: number, endLine: number, usedBy: string[] = []): FoldedType => ({
  id,
  name: id.toUpperCase(),
  kind: 'Interface',
  file,
  startLine,
  endLine,
  usedBy,
  usedByTotal: usedBy.length,
  usedByKinds: [],
  implements: [],
  implementedBy: [],
  refersTo: [],
  referencedByTypes: [],
});

describe('changedRangeTouches', () => {
  it('overlaps inclusive ranges', () => {
    assert.equal(changedRangeTouches([{ start: 5, end: 5 }], 3, 9), true);
    assert.equal(changedRangeTouches([{ start: 9, end: 12 }], 3, 9), true);
    assert.equal(changedRangeTouches([{ start: 1, end: 3 }], 3, 9), true);
    assert.equal(changedRangeTouches([{ start: 10, end: 12 }], 3, 9), false);
    assert.equal(changedRangeTouches([{ start: 1, end: 2 }], 3, 9), false);
    assert.equal(changedRangeTouches([], 3, 9), false);
  });

  it('reads a pure deletion (the empty range between n and n + 1) as inside a range only when it spans both', () => {
    // Deleted after new line 5: inside 3–9.
    assert.equal(changedRangeTouches([{ start: 6, end: 5 }], 3, 9), true);
    // Deleted right after the range's last line, or right before its first: outside.
    assert.equal(changedRangeTouches([{ start: 10, end: 9 }], 3, 9), false);
    assert.equal(changedRangeTouches([{ start: 3, end: 2 }], 3, 9), false);
  });
});

describe('findChangedContracts', () => {
  const types = [
    type('node', 'src/types.ts', 3, 9, ['f2', 'f1', 'f3']),
    type('edge', 'src/types.ts', 11, 14, ['f1']),
    type('far', 'src/other.ts', 1, 4, ['f1', 'f2']),
  ];

  it('names each folded type whose lines changed, with its real users as dependents, most dependents first', () => {
    const result = findChangedContracts(types, ['src/types.ts', 'src/other.ts'], {
      'src/types.ts': [
        { start: 12, end: 12 },
        { start: 5, end: 6 },
      ],
      'src/other.ts': [{ start: 2, end: 2 }],
    });
    assert.deepEqual(result, {
      approximate: false,
      contracts: [
        { id: 'node', name: 'NODE', kind: 'Interface', file: 'src/types.ts', dependentCount: 3, dependentIds: ['f1', 'f2', 'f3'] },
        { id: 'far', name: 'FAR', kind: 'Interface', file: 'src/other.ts', dependentCount: 2, dependentIds: ['f1', 'f2'] },
        { id: 'edge', name: 'EDGE', kind: 'Interface', file: 'src/types.ts', dependentCount: 1, dependentIds: ['f1'] },
      ],
    });
  });

  it('leaves out a type in a changed file whose own lines did not change', () => {
    const result = findChangedContracts(types, ['src/types.ts'], { 'src/types.ts': [{ start: 10, end: 10 }] });
    assert.deepEqual(result, { contracts: [], approximate: false });
  });

  it('a file read with no changed lines ([]: a pure rename, a mode change) contributes nothing', () => {
    assert.deepEqual(findChangedContracts(types, ['src/types.ts'], { 'src/types.ts': [] }), {
      contracts: [],
      approximate: false,
    });
  });

  it('never hides a contract: a changed file with no range entry counts every type in it, marked approximate', () => {
    // e.g. a C-quoted path the parser couldn't read, beside one it could.
    const result = findChangedContracts(types, ['src/types.ts', 'src/other.ts'], {
      'src/other.ts': [{ start: 9, end: 9 }],
    });
    assert.deepEqual(
      result.contracts.map((contract) => contract.id),
      ['node', 'edge'],
    );
    assert.equal(result.approximate, true);
    // No ranges at all: the same.
    const none = findChangedContracts(types, ['src/types.ts'], undefined);
    assert.deepEqual([none.contracts.map((contract) => contract.id), none.approximate], [['node', 'edge'], true]);
    // A missing entry for a file with no types changes nothing.
    assert.equal(findChangedContracts(types, ['README.md'], {}).approximate, false);
  });

  it('never counts a dependent that is not a real user, and a type nothing uses has 0', () => {
    const { contracts } = findChangedContracts([type('lonely', 'a.ts', 1, 3)], ['a.ts'], { 'a.ts': [{ start: 2, end: 2 }] });
    assert.deepEqual(contracts, [
      { id: 'lonely', name: 'LONELY', kind: 'Interface', file: 'a.ts', dependentCount: 0, dependentIds: [] },
    ]);
  });

  it('keeps only in-scope dependents, counted after that, and caps the ids with the count exact', () => {
    const many = Array.from({ length: 250 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const big = type('big', 'a.ts', 1, 3, [...many, 'n000', 'outside']);
    const inScope = new Set(many);
    const { contracts } = findChangedContracts([big], ['a.ts'], { 'a.ts': [{ start: 2, end: 2 }] }, { mapNodeIds: inScope });
    assert.equal(contracts[0]?.dependentCount, 250);
    assert.deepEqual(contracts[0]?.dependentIds, many.slice(0, CHANGED_CONTRACT_MAX_DEPENDENT_IDS));
    assert.equal(CHANGED_CONTRACT_MAX_DEPENDENT_IDS, 200);
    const small = findChangedContracts([big], ['a.ts'], { 'a.ts': [{ start: 2, end: 2 }] }, {
      mapNodeIds: new Set(['n001', 'outside-not-a-user']),
      maxDependentIds: 5,
    });
    assert.deepEqual([small.contracts[0]?.dependentCount, small.contracts[0]?.dependentIds], [1, ['n001']]);
  });

  it('ignores ranges for a file not in the changed-file list', () => {
    assert.deepEqual(findChangedContracts(types, [], { 'src/types.ts': [{ start: 5, end: 5 }] }).contracts, []);
  });

  it('matches an unsorted range list and a pure deletion inside a type', () => {
    const result = findChangedContracts(types, ['src/types.ts'], {
      'src/types.ts': [
        { start: 30, end: 31 },
        { start: 8, end: 7 },
        { start: 1, end: 1 },
      ],
    });
    assert.deepEqual(
      result.contracts.map((contract) => contract.id),
      ['node'],
    );
  });
});

describe('changedRangeInside', () => {
  it('is true only for a range wholly inside, and for a deletion between two of its lines', () => {
    assert.equal(changedRangeInside({ start: 4, end: 8 }, 3, 9), true);
    assert.equal(changedRangeInside({ start: 8, end: 10 }, 3, 9), false);
    assert.equal(changedRangeInside({ start: 6, end: 5 }, 3, 9), true);
    assert.equal(changedRangeInside({ start: 10, end: 9 }, 3, 9), false);
  });
});

describe('findContractOnlyChangedFiles', () => {
  const types = [type('node', 'src/types.ts', 3, 9), type('edge', 'src/types.ts', 11, 14)];

  it('lists a file whose every changed range lies wholly inside one of its types', () => {
    assert.deepEqual(
      [
        ...findContractOnlyChangedFiles(types, {
          'src/types.ts': [
            { start: 12, end: 13 },
            { start: 4, end: 4 },
            { start: 6, end: 5 },
          ],
        }),
      ],
      ['src/types.ts'],
    );
  });

  it('keeps out a file with a range spanning a type and the code next to it', () => {
    assert.deepEqual([...findContractOnlyChangedFiles(types, { 'src/types.ts': [{ start: 8, end: 10 }] })], []);
    assert.deepEqual([...findContractOnlyChangedFiles(types, { 'src/types.ts': [{ start: 9, end: 11 }] })], []);
  });

  it('keeps out a file with a change outside its types, a file without types, and one without ranges', () => {
    assert.deepEqual(
      [
        ...findContractOnlyChangedFiles(types, {
          'src/types.ts': [
            { start: 4, end: 4 },
            { start: 20, end: 20 },
          ],
        }),
      ],
      [],
    );
    assert.deepEqual([...findContractOnlyChangedFiles(types, { 'src/a.ts': [{ start: 4, end: 4 }] })], []);
    assert.deepEqual([...findContractOnlyChangedFiles(types, { 'src/types.ts': [] })], []);
  });

  it('finds the containing type among nested and overlapping ones', () => {
    const nested = [type('outer', 'x.ts', 1, 50), type('inner', 'x.ts', 10, 12), type('late', 'x.ts', 40, 45)];
    assert.deepEqual([...findContractOnlyChangedFiles(nested, { 'x.ts': [{ start: 20, end: 30 }] })], ['x.ts']);
    assert.deepEqual([...findContractOnlyChangedFiles(nested, { 'x.ts': [{ start: 49, end: 51 }] })], []);
  });
});
