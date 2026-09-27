/**
 * P2-5: main validates the Code Map reply's scope fields before they reach
 * the renderer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphServiceCodeMapMessage } from '@driller/ipc-contracts';

import { joinNaturally, toOkCodeMapResult } from './code-map-reply';

type Reply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMap' }>;

const reply = (fields: Record<string, unknown>): Reply =>
  ({ type: 'graphService:codeMap', nodes: [], edges: [], ...fields }) as unknown as Reply;

describe('toOkCodeMapResult', () => {
  it('passes valid fields through unchanged, replacing nothing', () => {
    assert.deepEqual(toOkCodeMapResult(reply({ hiddenByScope: 229, appliedScope: ['wbe'], foldedTypes: [] })), {
      result: { status: 'ok', nodes: [], edges: [], hiddenByScope: 229, appliedScope: ['wbe'], foldedTypes: [] },
      replaced: [],
      droppedFoldedTypes: 0,
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
    assert.deepEqual(toOkCodeMapResult(reply({})).replaced, ['hiddenByScope', 'appliedScope', 'foldedTypes']);
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

  it('joinNaturally reads "a", "a and b", "a, b and c"', () => {
    assert.equal(joinNaturally([]), '');
    assert.equal(joinNaturally(['a']), 'a');
    assert.equal(joinNaturally(['a', 'b']), 'a and b');
    assert.equal(joinNaturally(['hiddenByScope', 'appliedScope', 'foldedTypes']), 'hiddenByScope, appliedScope and foldedTypes');
  });
});
