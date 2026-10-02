/**
 * P2-5: main validates the Code Map reply's scope fields before they reach
 * the renderer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphServiceCodeMapMessage } from '@driller/ipc-contracts';

import {
  isSectionNodeCount,
  isSimilarImplementation,
  joinNaturally,
  sanitizeNodeSimilarTo,
  sanitizeNodeTestCoverageAvailable,
  toOkCodeMapResult,
  toUnknownSectionResult,
  toValidatedDiffScopeResult,
} from './code-map-reply';

type Reply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMap' }>;

const reply = (fields: Record<string, unknown>): Reply =>
  ({ type: 'graphService:codeMap', nodes: [], edges: [], foldedModules: [], section: null, sections: [], ...fields }) as unknown as Reply;

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
        section: null,
        sections: [],
      },
      replaced: [],
      droppedFoldedTypes: 0,
      droppedFoldedModules: 0,
      droppedSimilarTo: 0,
      droppedTestCoverageAvailable: 0,
      droppedSections: 0,
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

describe('similarTo per element (P4-2 phase 4)', () => {
  const node = (fields: Record<string, unknown> = {}) => ({
    id: 'a.f',
    name: 'f',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: [],
    ...fields,
  });
  const GOOD = { id: 'b.f', name: 'f', file: 'src/b.ts', score: 1 };

  it('isSimilarImplementation needs non-empty id/name/file and a score in [0, 1]', () => {
    assert.equal(isSimilarImplementation(GOOD), true);
    assert.equal(isSimilarImplementation({ ...GOOD, score: 0.953 }), true);
    for (const bad of [
      null,
      'b.f',
      { ...GOOD, id: '' },
      { ...GOOD, name: 7 },
      { ...GOOD, file: undefined },
      { ...GOOD, score: '1.00' },
      { ...GOOD, score: Number.NaN },
      { ...GOOD, score: 1.5 },
      { ...GOOD, score: -0.1 },
    ]) {
      assert.equal(isSimilarImplementation(bad), false, JSON.stringify(bad));
    }
  });

  it('a well-formed Node passes through as the same object', () => {
    const ok = node({ similarTo: [GOOD], similarToTotal: 3 });
    const plain = node();
    const { result, droppedSimilarTo } = toOkCodeMapResult(reply({ nodes: [ok, plain], foldedTypes: [] }));
    assert.equal(result.nodes[0], ok);
    assert.equal(result.nodes[1], plain);
    assert.equal(droppedSimilarTo, 0);
  });

  it('drops malformed elements (counted), keeping the rest and a consistent total', () => {
    const { result, droppedSimilarTo } = toOkCodeMapResult(
      reply({ nodes: [node({ similarTo: [GOOD, { ...GOOD, score: 'x' }, null], similarToTotal: 3 })], foldedTypes: [] }),
    );
    assert.deepEqual(result.nodes[0]?.similarTo, [GOOD]);
    assert.equal(result.nodes[0]?.similarToTotal, 3);
    assert.equal(droppedSimilarTo, 2);
  });

  it('a total below the list, or missing, becomes the list length; a lone total or an emptied list removes both', () => {
    assert.equal(sanitizeNodeSimilarTo(node({ similarTo: [GOOD], similarToTotal: 0 }) as never).node.similarToTotal, 1);
    assert.equal(sanitizeNodeSimilarTo(node({ similarTo: [GOOD] }) as never).node.similarToTotal, 1);
    const deduped = sanitizeNodeSimilarTo(node({ similarTo: [GOOD, { ...GOOD, score: 0.95 }], similarToTotal: 2 }) as never);
    assert.deepEqual(deduped.node.similarTo, [GOOD]);
    assert.equal(deduped.dropped, 1);
    for (const fields of [{ similarToTotal: 4 }, { similarTo: [], similarToTotal: 0 }, { similarTo: 'b.f', similarToTotal: 1 }]) {
      const { node: cleaned, dropped } = sanitizeNodeSimilarTo(node(fields) as never);
      assert.ok(!('similarTo' in cleaned) && !('similarToTotal' in cleaned), JSON.stringify(fields));
      assert.equal(dropped, typeof fields.similarTo === 'string' ? 1 : 0);
    }
  });
});

describe('testCoverageAvailable (P4-3 phase 5)', () => {
  const node = (fields: Record<string, unknown> = {}) => ({
    id: 'a.f',
    name: 'f',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: [],
    ...fields,
  });

  it('keeps a true flag, and a Node without one, as the same object', () => {
    const covered = node({ testCoverageAvailable: true });
    const plain = node();
    const { result, droppedTestCoverageAvailable } = toOkCodeMapResult(
      reply({ nodes: [covered, plain], foldedTypes: [] }),
    );
    assert.equal(result.nodes[0], covered);
    assert.equal(result.nodes[1], plain);
    assert.equal(result.nodes[0]?.testCoverageAvailable, true);
    assert.equal(droppedTestCoverageAvailable, 0);
  });

  it('strips every non-true value (false, "yes", 1, null, {}) and counts each', () => {
    const bad = [false, 'yes', 'true', 1, 0, null, {}];
    const { result, droppedTestCoverageAvailable } = toOkCodeMapResult(
      reply({ nodes: bad.map((value, i) => node({ id: `n${i}`, testCoverageAvailable: value })), foldedTypes: [] }),
    );
    for (const [i, cleaned] of result.nodes.entries()) {
      assert.ok(!('testCoverageAvailable' in cleaned), JSON.stringify(bad[i]));
      assert.equal(cleaned.id, `n${i}`);
      assert.deepEqual(cleaned.riskSignals, []);
    }
    assert.equal(droppedTestCoverageAvailable, bad.length);
  });

  it('an own undefined key is removed without counting as malformed', () => {
    const { node: cleaned, dropped } = sanitizeNodeTestCoverageAvailable(node({ testCoverageAvailable: undefined }) as never);
    assert.ok(!('testCoverageAvailable' in cleaned));
    assert.equal(dropped, 0);
  });

  it('review round 1: testCoverageHit is kept only as `true` and only beside a surviving testCoverageAvailable', () => {
    const both = node({ testCoverageAvailable: true, testCoverageHit: true });
    assert.equal(sanitizeNodeTestCoverageAvailable(both as never).node, both);
    const cases: [Record<string, unknown>, Record<string, unknown>, number][] = [
      [{ testCoverageAvailable: true, testCoverageHit: false }, { testCoverageAvailable: true }, 1],
      [{ testCoverageAvailable: true, testCoverageHit: 'yes' }, { testCoverageAvailable: true }, 1],
      [{ testCoverageHit: true }, {}, 1],
      [{ testCoverageAvailable: 'yes', testCoverageHit: true }, {}, 2],
      [{ testCoverageAvailable: false, testCoverageHit: false }, {}, 2],
      [{ testCoverageAvailable: true, testCoverageHit: undefined }, { testCoverageAvailable: true }, 0],
    ];
    for (const [fields, kept, dropped] of cases) {
      const result = sanitizeNodeTestCoverageAvailable(node(fields) as never);
      const flags = Object.fromEntries(
        Object.entries(result.node).filter(([key]) => key === 'testCoverageAvailable' || key === 'testCoverageHit'),
      );
      assert.deepEqual(flags, kept, JSON.stringify(fields));
      assert.equal(result.dropped, dropped, JSON.stringify(fields));
      assert.equal(result.node.id, 'a.f');
    }
  });

  it('is sanitised alongside similarTo on the same Node', () => {
    const { result, droppedSimilarTo, droppedTestCoverageAvailable } = toOkCodeMapResult(
      reply({ nodes: [node({ similarTo: [null], similarToTotal: 1, testCoverageAvailable: 'yes' })], foldedTypes: [] }),
    );
    const [cleaned] = result.nodes;
    assert.ok(cleaned && !('similarTo' in cleaned) && !('testCoverageAvailable' in cleaned));
    assert.equal(droppedSimilarTo, 1);
    assert.equal(droppedTestCoverageAvailable, 1);
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

describe('toValidatedDiffScopeResult: unknown-section (P4-4 phase 2a)', () => {
  type Result = Parameters<typeof toValidatedDiffScopeResult>[0];
  it('passes a well-formed unknown-section result through', () => {
    const unknown: Result = { status: 'unknown-section', section: 'docs', knownSections: ['web', 'api'] };
    assert.deepEqual(toValidatedDiffScopeResult(unknown), { result: unknown, dropped: 0 });
  });

  it('drops malformed known sections, and is an explicit error without a string section', () => {
    assert.deepEqual(
      toValidatedDiffScopeResult({ status: 'unknown-section', section: 'docs', knownSections: ['web', 3] } as unknown as Result),
      { result: { status: 'unknown-section', section: 'docs', knownSections: ['web'] }, dropped: 1 },
    );
    const { result } = toValidatedDiffScopeResult({ status: 'unknown-section', knownSections: [] } as unknown as Result);
    assert.equal(result.status, 'error');
  });
});

type UnknownSectionReply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMapUnknownSection' }>;
const unknownReply = (fields: Record<string, unknown>): UnknownSectionReply =>
  ({ type: 'graphService:codeMapUnknownSection', ...fields }) as unknown as UnknownSectionReply;

describe('section and sections (P4-4 phase 1b)', () => {
  it('passes a string or null section and well-formed sections through', () => {
    const sections = [
      { path: 'web', nodeCount: 3 },
      { path: 'api', nodeCount: 0 },
    ];
    for (const section of ['api', null]) {
      const { result, replaced, droppedSections } = toOkCodeMapResult(
        reply({ hiddenByScope: 0, appliedScope: ['web', 'api'], foldedTypes: [], section, sections }),
      );
      assert.equal(result.section, section);
      assert.deepEqual(result.sections, sections);
      assert.deepEqual(replaced, []);
      assert.equal(droppedSections, 0);
    }
  });

  for (const bad of [undefined, 42, ['api'], { path: 'api' }]) {
    it(`a malformed section (${JSON.stringify(bad)}) becomes null and is named`, () => {
      const { result, replaced } = toOkCodeMapResult(reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: [], section: bad }));
      assert.equal(result.section, null);
      assert.deepEqual(replaced, ['section']);
    });
  }

  it('a non-array sections becomes [] and is named', () => {
    const { result, replaced } = toOkCodeMapResult(
      reply({ hiddenByScope: 0, appliedScope: [], foldedTypes: [], sections: { web: 3 } }),
    );
    assert.deepEqual(result.sections, []);
    assert.deepEqual(replaced, ['sections']);
  });

  it('drops each malformed sections element and counts it', () => {
    const good = { path: 'web', nodeCount: 2 };
    const { result, replaced, droppedSections } = toOkCodeMapResult(
      reply({
        hiddenByScope: 0,
        appliedScope: [],
        foldedTypes: [],
        sections: [good, { path: 'api', nodeCount: -1 }, { path: 'x', nodeCount: 1.5 }, { path: 3, nodeCount: 1 }, null, { path: 'y' }],
      }),
    );
    assert.deepEqual(result.sections, [good]);
    assert.deepEqual(replaced, []);
    assert.equal(droppedSections, 5);
    assert.equal(isSectionNodeCount({ path: '', nodeCount: 0 }), true);
  });

  it('toUnknownSectionResult: validated, with non-string known sections dropped', () => {
    assert.deepEqual(toUnknownSectionResult(unknownReply({ section: 'docs', knownSections: ['web', 'api'] })), {
      result: { status: 'unknown-section', section: 'docs', knownSections: ['web', 'api'] },
      dropped: 0,
    });
    assert.deepEqual(toUnknownSectionResult(unknownReply({ section: 'docs', knownSections: ['web', 7, null] })), {
      result: { status: 'unknown-section', section: 'docs', knownSections: ['web'] },
      dropped: 2,
    });
    assert.deepEqual(toUnknownSectionResult(unknownReply({ section: 'docs', knownSections: 'web' })), {
      result: { status: 'unknown-section', section: 'docs', knownSections: [] },
      dropped: 1,
    });
    assert.equal(toUnknownSectionResult(unknownReply({ section: 4, knownSections: [] })), null);
  });
});
