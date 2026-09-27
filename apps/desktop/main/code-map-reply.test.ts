/**
 * P2-5: main validates the Code Map reply's scope fields before they reach
 * the renderer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphServiceCodeMapMessage } from '@driller/ipc-contracts';

import { joinNaturally, toOkCodeMapResult, toValidatedDiffScopeResult } from './code-map-reply';

type Reply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMap' }>;

const reply = (fields: Record<string, unknown>): Reply =>
  ({ type: 'graphService:codeMap', nodes: [], edges: [], foldedModules: [], ...fields }) as unknown as Reply;

describe('toOkCodeMapResult', () => {
  it('passes valid fields through unchanged, replacing nothing', () => {
    assert.deepEqual(toOkCodeMapResult(reply({ hiddenByScope: 229, appliedScope: ['wbe'], foldedTypes: [] })), {
      result: {
        status: 'ok',
        nodes: [],
        edges: [],
        hiddenByScope: 229,
        appliedScope: ['wbe'],
        foldedTypes: [],
        foldedModules: [],
      },
      replaced: [],
      droppedFoldedTypes: 0,
      droppedFoldedModules: 0,
    });
  });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '3', undefined, null]) {
    it(`a non-finite hiddenByScope (${String(bad)}) becomes 0`, () => {
      const { result, replaced } = toOkCodeMapResult(reply({ hiddenByScope: bad, appliedScope: [], foldedTypes: [] }));
      assert.equal(result.hiddenByScope, 0);
      assert.deepEqual(replaced, ['hiddenByScope']);
    });
  }

  for (const bad of [undefined, 'web', ['web', 1], { 0: 'web' }]) {
    it(`a non-string-array appliedScope (${JSON.stringify(bad)}) becomes []`, () => {
      const { result, replaced } = toOkCodeMapResult(reply({ hiddenByScope: 2, appliedScope: bad, foldedTypes: [] }));
      assert.deepEqual(result.appliedScope, []);
      assert.deepEqual(replaced, ['appliedScope']);
    });
  }

  it('reports every field that was replaced', () => {
    assert.deepEqual(toOkCodeMapResult(reply({ foldedModules: undefined })).replaced, [
      'hiddenByScope',
      'appliedScope',
      'foldedTypes',
      'foldedModules',
    ]);
  });

  const TYPE = {
    id: 'T',
    name: 'T',
    kind: 'Type',
    file: 'a.ts',
    startLine: 1,
    endLine: 2,
    usedBy: ['f'],
    usedByTotal: 1,
    usedByKinds: [{ kind: 'Function', count: 1 }],
    implements: [],
    implementedBy: [],
    refersTo: [],
    referencedByTypes: [],
  };

  it('P4-2 phase 3b: passes valid foldedTypes through, and a non-array becomes []', () => {
    const ok = toOkCodeMapResult(reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: [TYPE] }));
    assert.deepEqual(ok.result.foldedTypes, [TYPE]);
    assert.equal(ok.droppedFoldedTypes, 0);
    for (const bad of [undefined, 'T', { 0: TYPE }]) {
      const { result, replaced } = toOkCodeMapResult(reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: bad }));
      assert.deepEqual(result.foldedTypes, []);
      assert.deepEqual(replaced, ['foldedTypes']);
    }
  });

  it('P4-2 phase 3b: drops each malformed folded type, keeping the rest, and counts them', () => {
    const malformed = [
      null,
      'T',
      { ...TYPE, id: 7 },
      { ...TYPE, name: undefined },
      { ...TYPE, kind: 'Class' },
      { ...TYPE, file: null },
      { ...TYPE, startLine: '1' },
      { ...TYPE, endLine: Number.NaN },
      { ...TYPE, startLine: 3, endLine: 2 },
      { ...TYPE, endLine: 2.5 },
      { ...TYPE, usedByTotal: undefined },
      { ...TYPE, usedBy: ['f', 3] },
      { ...TYPE, implements: 'U' },
      { ...TYPE, implementedBy: undefined },
      { ...TYPE, refersTo: [null] },
      { ...TYPE, referencedByTypes: {} },
      { ...TYPE, usedByKinds: [{ kind: 'Function' }] },
    ];
    const good = { ...TYPE, id: 'U' };
    const { result, replaced, droppedFoldedTypes } = toOkCodeMapResult(
      reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: [TYPE, ...malformed, good] }),
    );
    assert.deepEqual(result.foldedTypes, [TYPE, good]);
    assert.equal(droppedFoldedTypes, malformed.length);
    assert.deepEqual(replaced, [], 'a present array is not "replaced"');
  });

  const MODULE = {
    file: 'lib/boot.ts',
    moduleIds: ['mod:boot'],
    startLine: 1,
    endLine: 9,
    uses: [
      { id: 'f', kind: 'CALLS' },
      { id: 'g', kind: 'USAGE' },
    ],
    usesTypes: [{ id: 'T', name: 'T', kind: 'Type' }],
  };

  it('P4-2 phase 3c: passes valid foldedModules through, and a non-array becomes []', () => {
    const noTypes = { ...MODULE, usesTypes: undefined };
    const ok = toOkCodeMapResult(reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: [], foldedModules: [MODULE, noTypes] }));
    assert.deepEqual(ok.result.foldedModules, [MODULE, noTypes]);
    assert.equal(ok.droppedFoldedModules, 0);
    for (const bad of [undefined, 'mod', { 0: MODULE }]) {
      const { result, replaced } = toOkCodeMapResult(
        reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: [], foldedModules: bad }),
      );
      assert.deepEqual(result.foldedModules, []);
      assert.deepEqual(replaced, ['foldedModules']);
    }
  });

  it('P4-2 phase 3c: drops each malformed folded Module, keeping the rest, and counts them', () => {
    const malformed = [
      null,
      'mod',
      { ...MODULE, file: 3 },
      { ...MODULE, moduleIds: [] },
      { ...MODULE, moduleIds: ['m', 2] },
      { ...MODULE, moduleIds: [''] },
      { ...MODULE, startLine: 1.5 },
      { ...MODULE, startLine: 10, endLine: 9 },
      { ...MODULE, startLine: 0 },
      { ...MODULE, startLine: '1' },
      { ...MODULE, endLine: Number.POSITIVE_INFINITY },
      { ...MODULE, uses: 'f' },
      { ...MODULE, uses: [{ id: 'f', kind: 'IMPLEMENTS' }] },
      { ...MODULE, uses: [{ kind: 'CALLS' }] },
      { ...MODULE, usesTypes: [{ id: 'T', name: 'T', kind: 'Class' }] },
      { ...MODULE, usesTypes: 'T' },
    ];
    const good = { ...MODULE, file: 'lib/other.ts' };
    const { result, replaced, droppedFoldedModules } = toOkCodeMapResult(
      reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: [], foldedModules: [MODULE, ...malformed, good] }),
    );
    assert.deepEqual(result.foldedModules, [MODULE, good]);
    assert.equal(droppedFoldedModules, malformed.length);
    assert.deepEqual(replaced, []);
  });

  it('joinNaturally reads "a", "a and b", "a, b and c"', () => {
    assert.equal(joinNaturally([]), '');
    assert.equal(joinNaturally(['a']), 'a');
    assert.equal(joinNaturally(['a', 'b']), 'a and b');
    assert.equal(joinNaturally(['hiddenByScope', 'appliedScope', 'foldedTypes']), 'hiddenByScope, appliedScope and foldedTypes');
  });
});

describe('toValidatedDiffScopeResult (P4-2 phase 3c)', () => {
  type Result = Parameters<typeof toValidatedDiffScopeResult>[0];
  const CONTRACT = { id: 'T', name: 'T', kind: 'Interface', file: 'a.ts', dependentCount: 2, dependentIds: ['f', 'g'] };
  const FILE = { file: 'boot.ts', startLine: 1, endLine: 4 };
  const resolved = (fields: Record<string, unknown>) =>
    ({ status: 'resolved', resolvedBaseRef: 'abc', nodeIds: ['n'], ...fields }) as unknown as Result;

  it('passes a well-formed result, and every other well-formed state, through unchanged', () => {
    const ok = resolved({ topLevelFiles: [FILE], changedContracts: [CONTRACT], changedContractsApproximate: true });
    assert.deepEqual(toValidatedDiffScopeResult(ok), { result: ok, dropped: 0 });
    const without: Result = { status: 'resolved', resolvedBaseRef: 'abc', nodeIds: [] };
    assert.deepEqual(toValidatedDiffScopeResult(without), { result: without, dropped: 0 });
    const others: Result[] = [
      { status: 'no-changes' },
      { status: 'not-a-git-repo' },
      { status: 'no-base-ref-resolvable' },
      { status: 'error', message: 'x' },
    ];
    for (const other of others) {
      assert.deepEqual(toValidatedDiffScopeResult(other), { result: other, dropped: 0 });
    }
  });

  it('accepts capped dependentIds (fewer ids than the count)', () => {
    const capped = { ...CONTRACT, dependentCount: 500, dependentIds: ['f', 'g'] };
    assert.deepEqual(toValidatedDiffScopeResult(resolved({ changedContracts: [capped] })).dropped, 0);
  });

  it('drops each malformed contract, and the field (and the approximate flag) when none survive', () => {
    const malformed = [
      null,
      { ...CONTRACT, id: 1 },
      { ...CONTRACT, kind: 'Module' },
      { ...CONTRACT, dependentIds: 'f' },
      // More ids than the count: the count is never below the real dependents.
      { ...CONTRACT, dependentCount: 1 },
      { ...CONTRACT, dependentCount: 2.5 },
      { ...CONTRACT, dependentIds: ['f', 'f'] },
      { ...CONTRACT, file: undefined },
    ];
    const good = { ...CONTRACT, id: 'U', dependentCount: 0, dependentIds: [] };
    assert.deepEqual(toValidatedDiffScopeResult(resolved({ changedContracts: [CONTRACT, ...malformed, good] })), {
      result: resolved({ changedContracts: [CONTRACT, good] }),
      dropped: malformed.length,
    });
    assert.deepEqual(
      toValidatedDiffScopeResult(resolved({ changedContracts: malformed, changedContractsApproximate: true })),
      { result: resolved({}), dropped: malformed.length },
    );
    assert.deepEqual(toValidatedDiffScopeResult(resolved({ changedContracts: 'T' })), { result: resolved({}), dropped: 1 });
    // The flag survives only as `true`.
    assert.deepEqual(
      toValidatedDiffScopeResult(resolved({ changedContracts: [CONTRACT], changedContractsApproximate: 'yes' })).result,
      resolved({ changedContracts: [CONTRACT] }),
    );
  });

  it('validates nodeIds and topLevelFiles too', () => {
    const badFiles = [null, { ...FILE, file: 1 }, { ...FILE, startLine: 0 }, { ...FILE, startLine: 5 }, { ...FILE, endLine: 2.5 }];
    assert.deepEqual(
      toValidatedDiffScopeResult(resolved({ nodeIds: ['n', 3, null], topLevelFiles: [FILE, ...badFiles] })),
      { result: resolved({ topLevelFiles: [FILE] }), dropped: 2 + badFiles.length },
    );
  });

  it('turns a structurally broken reply into an explicit error', () => {
    const broken = [
      undefined,
      'resolved',
      { status: 'resolved', nodeIds: [] },
      { status: 'resolved', resolvedBaseRef: 'abc', nodeIds: 'n' },
      { status: 'error' },
      { status: 'weird' },
    ];
    for (const reply of broken) {
      const { result } = toValidatedDiffScopeResult(reply as unknown as Result);
      assert.equal(result.status, 'error', JSON.stringify(reply));
    }
  });
});
