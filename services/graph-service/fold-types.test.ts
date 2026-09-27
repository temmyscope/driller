/**
 * P4-2 phase 3b: `foldTypes` takes Type/Interface Nodes off the map and
 * keeps who uses them, what they refer to and what they implement (from
 * real `USAGE`/`IMPLEMENTS` edges only); `scopeFoldedTypes` applies the
 * indexing scope to that; `attachTypeUses` hands each Node the types it
 * uses; `splitModuleTypeUses` keeps a file's top-level type uses;
 * `capFoldedTypeUsedBy` caps the reply.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBidirectionalAdjacency,
  computeBlastRadiusFromAdjacency,
  type CodeMapEdge,
  type FoldedModule,
  type FoldedType,
  type TypeUse,
} from '@driller/graph-contracts';

import { attachTypeUses, capFoldedTypeUsedBy, foldTypes, scopeFoldedTypes, splitModuleTypeUses } from './fold-types';

type Kind = 'Function' | 'Interface' | 'Type' | 'Module';

interface TestNode {
  id: string;
  name: string;
  file: string;
  kind: Kind;
  startLine: number;
  endLine: number;
  usesTypes?: TypeUse[];
}

function node(id: string, file: string, kind: Kind = 'Function', startLine = 1, endLine = 2): TestNode {
  return { id, name: id.toUpperCase(), file, kind, startLine, endLine };
}

const edge = (source: string, target: string, kind: CodeMapEdge['kind'] = 'CALLS'): CodeMapEdge => ({
  source,
  target,
  kind,
});

function type(id: string, file: string, usedBy: string[], overrides: Partial<FoldedType> = {}): FoldedType {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'Type',
    file,
    startLine: 1,
    endLine: 2,
    usedBy,
    usedByTotal: usedBy.length,
    usedByKinds: usedBy.length > 0 ? [{ kind: 'Function', count: usedBy.length }] : [],
    implements: [],
    implementedBy: [],
    refersTo: [],
    referencedByTypes: [],
    ...overrides,
  };
}

const NO_LINKS = { implements: [], implementedBy: [], refersTo: [], referencedByTypes: [] };

describe('foldTypes', () => {
  it('drops Type/Interface Nodes and every edge touching one, keeping USAGE users both ways', () => {
    const nodes = [
      node('f', 'src/f.ts'),
      node('g', 'src/g.ts'),
      node('t', 'src/types.ts', 'Type', 3, 9),
      node('i', 'src/types.ts', 'Interface', 10, 20),
    ];
    const edges = [
      edge('f', 'g'),
      edge('f', 't', 'USAGE'),
      edge('g', 't', 'USAGE'),
      edge('g', 'i', 'USAGE'),
      edge('f', 't', 'USAGE'),
    ];
    const result = foldTypes(nodes, edges);
    assert.deepEqual(result.nodes.map((n) => n.id), ['f', 'g']);
    assert.deepEqual(result.edges, [edge('f', 'g')]);
    assert.deepEqual([...result.typesById.values()], [
      {
        id: 't',
        name: 'T',
        kind: 'Type',
        file: 'src/types.ts',
        startLine: 3,
        endLine: 9,
        usedBy: ['f', 'g'],
        usedByTotal: 2,
        usedByKinds: [{ kind: 'Function', count: 2 }],
        ...NO_LINKS,
      },
      {
        id: 'i',
        name: 'I',
        kind: 'Interface',
        file: 'src/types.ts',
        startLine: 10,
        endLine: 20,
        usedBy: ['g'],
        usedByTotal: 1,
        usedByKinds: [{ kind: 'Function', count: 1 }],
        ...NO_LINKS,
      },
    ]);
    assert.deepEqual([...result.usesByNode], [
      ['f', ['t']],
      ['g', ['i', 't']],
    ]);
    assert.deepEqual([...result.usedByType], [
      ['t', ['f', 'g']],
      ['i', ['g']],
    ]);
  });

  it('counts users by kind, most first', () => {
    const nodes = [node('f', 'a.ts'), node('g', 'a.ts'), { ...node('m', 'a.ts'), kind: 'Module' as const }, node('t', 'a.ts', 'Type')];
    const result = foldTypes(nodes, [edge('f', 't', 'USAGE'), edge('g', 't', 'USAGE'), edge('m', 't', 'USAGE')]);
    assert.deepEqual(result.typesById.get('t')?.usedByKinds, [
      { kind: 'Function', count: 2 },
      { kind: 'Module', count: 1 },
    ]);
  });

  it('keeps type → type USAGE as refersTo / referencedByTypes, never as a use', () => {
    const nodes = [node('f', 'a.ts'), node('t', 'a.ts', 'Type'), node('u', 'a.ts', 'Interface'), node('v', 'a.ts', 'Type')];
    const edges = [edge('t', 'u', 'USAGE'), edge('v', 'u', 'USAGE'), edge('t', 'v', 'USAGE'), edge('t', 't', 'USAGE')];
    const result = foldTypes(nodes, edges);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.typesById.get('t')?.refersTo, ['u', 'v']);
    assert.deepEqual(result.typesById.get('u')?.referencedByTypes, ['t', 'v']);
    assert.deepEqual(result.typesById.get('v')?.referencedByTypes, ['t']);
    assert.deepEqual(result.typesById.get('t')?.referencedByTypes, [], 'a self-reference is not a link');
    assert.deepEqual(result.typesById.get('u')?.usedBy, []);
    assert.equal(result.usesByNode.size, 0);
  });

  it('records nothing for a CALLS into a type, a USAGE from a type into a map Node, or a source not on the map', () => {
    const nodes = [node('f', 'a.ts'), node('t', 'a.ts', 'Type'), node('u', 'a.ts', 'Interface')];
    const edges = [edge('f', 't', 'CALLS'), edge('t', 'f', 'USAGE'), edge('t', 'u', 'CALLS'), edge('gone', 't', 'USAGE')];
    const result = foldTypes(nodes, edges);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.typesById.get('t'), { ...type('t', 'a.ts', []), name: 'T' });
    assert.deepEqual(result.typesById.get('u')?.referencedByTypes, []);
    assert.equal(result.usesByNode.size, 0);
  });

  it('never infers a use: a Function whose name or signature mentions a type, with no USAGE edge, uses nothing', () => {
    const nodes = [
      { ...node('toCodeMapNode', 'a.ts'), name: 'toCodeMapNode', paramTypes: ['CodeMapNode'], returnType: 'CodeMapNode' },
      { ...node('CodeMapNode', 'types.ts', 'Interface'), name: 'CodeMapNode' },
    ];
    const result = foldTypes(nodes, []);
    assert.deepEqual(result.typesById.get('CodeMapNode')?.usedBy, []);
    assert.equal(result.usesByNode.size, 0);
  });

  it('keeps a type used by nobody in the index, so it still resolves', () => {
    const result = foldTypes([node('t', 'a.ts', 'Type')], []);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.typesById.get('t')?.usedBy, []);
  });

  it('builds implements and implementedBy from IMPLEMENTS links between folded types only', () => {
    const nodes = [node('a', 'x.ts', 'Interface'), node('b', 'x.ts', 'Interface'), node('c', 'x.ts', 'Interface'), node('f', 'x.ts')];
    const result = foldTypes(nodes, [], [
      { source: 'a', target: 'c' },
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b' },
      { source: 'a', target: 'a' },
      { source: 'a', target: 'elsewhere' },
      { source: 'f', target: 'b' },
    ]);
    assert.deepEqual(result.typesById.get('a')?.implements, ['b', 'c']);
    assert.deepEqual(result.typesById.get('b')?.implements, []);
    assert.deepEqual(result.typesById.get('b')?.implementedBy, ['a']);
    assert.deepEqual(result.typesById.get('c')?.implementedBy, ['a']);
    assert.deepEqual(result.typesById.get('a')?.implementedBy, []);
  });

  it('an id shared by a type and a map Node stays a map Node, with its edges', () => {
    const nodes = [node('f', 'a.ts'), node('dup', 'a.ts'), node('dup', 'b.ts', 'Type')];
    const edges = [edge('f', 'dup', 'USAGE')];
    const result = foldTypes(nodes, edges);
    assert.deepEqual(result.nodes.map((n) => [n.id, n.kind]), [
      ['f', 'Function'],
      ['dup', 'Function'],
    ]);
    assert.deepEqual(result.edges, edges);
    assert.equal(result.typesById.size, 0);
  });

  it('returns its inputs unchanged when there is no type', () => {
    const nodes = [node('f', 'a.ts')];
    const edges = [edge('f', 'f')];
    const result = foldTypes(nodes, edges);
    assert.equal(result.nodes, nodes);
    assert.equal(result.edges, edges);
  });

  it("a type's edges no longer count toward a function's blast radius", () => {
    // f uses t; with t on the map, t is within f's forward reach.
    const nodes = [node('f', 'a.ts'), node('g', 'b.ts'), node('t', 'c.ts', 'Type')];
    const edges = [edge('f', 't', 'USAGE'), edge('g', 't', 'USAGE')];
    const before = computeBlastRadiusFromAdjacency(buildBidirectionalAdjacency(nodes, edges), 'f');
    const result = foldTypes(nodes, edges);
    const after = computeBlastRadiusFromAdjacency(buildBidirectionalAdjacency(result.nodes, result.edges), 'f');
    assert.equal(before, 1);
    assert.equal(after, 0);
  });
});

describe('scopeFoldedTypes', () => {
  it('drops out-of-scope types, names only surviving users and types, and recounts users', () => {
    const types = [
      type('t', 'web/types.ts', ['w', 'd'], {
        kind: 'Interface',
        usedByKinds: [{ kind: 'Function', count: 2 }],
        implements: ['u', 'x'],
        implementedBy: ['u'],
        refersTo: ['v', 'u'],
        referencedByTypes: ['x'],
      }),
      type('u', 'docs/types.ts', ['d']),
      type('x', 'webapp/types.ts', []),
      type('v', 'web/v.ts', ['w']),
    ];
    const scoped = scopeFoldedTypes(types, new Map([['w', 'Function']]), ['web']);
    assert.deepEqual(
      scoped.map((t) => [t.id, t.usedBy, t.usedByTotal, t.usedByKinds, t.implements, t.implementedBy, t.refersTo, t.referencedByTypes]),
      [
        ['t', ['w'], 1, [{ kind: 'Function', count: 1 }], [], [], ['v'], []],
        ['v', ['w'], 1, [{ kind: 'Function', count: 1 }], [], [], [], []],
      ],
    );
    // Unchanged types are passed through as the same object.
    assert.equal(scoped[1], types[3]);
  });

  it('an empty scope keeps every type', () => {
    const types = [type('t', 'a.ts', ['f'])];
    assert.deepEqual(scopeFoldedTypes(types, new Map([['f', 'Function']]), []), types);
  });
});

describe('capFoldedTypeUsedBy', () => {
  it('caps usedBy, keeping the full usedByTotal and kinds', () => {
    const many = Array.from({ length: 5 }, (_, i) => `u${i}`);
    const [capped] = capFoldedTypeUsedBy([type('t', 'a.ts', many)], 3);
    assert.deepEqual(capped?.usedBy, ['u0', 'u1', 'u2']);
    assert.equal(capped?.usedByTotal, 5);
    assert.deepEqual(capped?.usedByKinds, [{ kind: 'Function', count: 5 }]);
    const small = type('s', 'a.ts', ['f']);
    assert.equal(capFoldedTypeUsedBy([small], 3)[0], small);
  });
});

describe('attachTypeUses', () => {
  it("sets each Node's usesTypes from the types' users, sorted by name, and removes a stale one", () => {
    const nodes = [
      node('f', 'a.ts'),
      node('g', 'a.ts'),
      { ...node('h', 'a.ts'), usesTypes: [{ id: 'old', name: 'OLD', kind: 'Type' as const }] },
    ];
    const types = [type('zeta', 'x.ts', ['f', 'g']), type('alpha', 'x.ts', ['f'], { kind: 'Interface' })];
    const result = attachTypeUses(nodes, types);
    assert.deepEqual(result[0]?.usesTypes, [
      { id: 'alpha', name: 'ALPHA', kind: 'Interface' },
      { id: 'zeta', name: 'ZETA', kind: 'Type' },
    ]);
    assert.deepEqual(result[1]?.usesTypes, [{ id: 'zeta', name: 'ZETA', kind: 'Type' }]);
    assert.equal(result[2]?.usesTypes, undefined);
    assert.ok(!('usesTypes' in (result[2] ?? {})));
  });

  it('returns a Node untouched when it has no link to set or remove', () => {
    const nodes = [node('f', 'a.ts')];
    assert.equal(attachTypeUses(nodes, [])[0], nodes[0]);
  });
});

describe('splitModuleTypeUses', () => {
  const module = (uses: FoldedModule['uses'], usesTypes?: TypeUse[]): FoldedModule => ({
    file: 'src/boot.ts',
    moduleIds: ['mod:boot'],
    startLine: 1,
    endLine: 9,
    uses,
    ...(usesTypes ? { usesTypes } : {}),
  });

  it("moves a file's top-level uses of folded types out of uses into usesTypes, sorted by name", () => {
    const types = [type('z', 'x.ts', []), type('a', 'x.ts', [], { kind: 'Interface' })];
    const [split] = splitModuleTypeUses(
      [module([
        { id: 'f', kind: 'CALLS' },
        { id: 'z', kind: 'USAGE' },
        { id: 'a', kind: 'USAGE' },
      ])],
      types,
    );
    assert.deepEqual(split?.uses, [{ id: 'f', kind: 'CALLS' }]);
    assert.deepEqual(split?.usesTypes, [
      { id: 'a', name: 'A', kind: 'Interface' },
      { id: 'z', name: 'Z', kind: 'Type' },
    ]);
  });

  it('re-running with fewer (scoped) types drops the ones gone, and a Module with nothing to change is returned as-is', () => {
    const types = [type('z', 'x.ts', []), type('a', 'x.ts', [])];
    const [split] = splitModuleTypeUses([module([{ id: 'z', kind: 'USAGE' }, { id: 'a', kind: 'USAGE' }])], types);
    assert.ok(split);
    const [rescoped] = splitModuleTypeUses([split], [types[0]!]);
    assert.deepEqual(rescoped?.usesTypes, [{ id: 'z', name: 'Z', kind: 'Type' }]);
    const [none] = splitModuleTypeUses([split], []);
    assert.equal(none?.usesTypes, undefined);
    const plain = module([{ id: 'f', kind: 'CALLS' }]);
    assert.equal(splitModuleTypeUses([plain], types)[0], plain);
  });
});
