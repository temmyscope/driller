/**
 * P4-2 phase 3a: `foldModules` takes Module Nodes off the map and keeps what
 * each file's top-level code calls or uses; `scopeFoldedModules` applies the
 * indexing scope to that; `attachFoldedModuleLinks` hands each Node its
 * file's top-level uses and the files whose top level calls it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeBlastRadius, type CodeMapEdge, type FileTopLevelUse, type FoldedModule } from '@driller/graph-contracts';

import { attachFoldedModuleLinks, foldModules, scopeFoldedModules } from './fold-modules';

type Kind = 'Function' | 'Interface' | 'Type' | 'Module';

interface TestNode {
  id: string;
  name: string;
  file: string;
  kind: Kind;
  startLine: number;
  endLine: number;
  fileTopLevel?: FileTopLevelUse[];
  calledAtLoadBy?: string[];
}

function node(id: string, file: string, kind: Kind = 'Function', startLine = 1, endLine = 2): TestNode {
  return { id, name: id, file, kind, startLine, endLine };
}

const edge = (source: string, target: string, kind: CodeMapEdge['kind'] = 'CALLS'): CodeMapEdge => ({
  source,
  target,
  kind,
});

const folded = (file: string, moduleIds: string[], uses: FileTopLevelUse[], startLine = 1, endLine = 2): FoldedModule => ({
  file,
  moduleIds,
  startLine,
  endLine,
  uses,
});

describe('foldModules', () => {
  it("drops Module Nodes and every edge touching one, keeping the file's top-level uses and range", () => {
    const nodes = [
      node('x.ts', 'src/x.ts', 'Module', 1, 40),
      node('f', 'src/x.ts'),
      node('g', 'src/y.ts'),
      node('T', 'src/y.ts', 'Type'),
    ];
    const edges = [edge('x.ts', 'g'), edge('x.ts', 'f'), edge('x.ts', 'T', 'USAGE'), edge('f', 'g'), edge('g', 'T', 'USAGE')];
    const result = foldModules(nodes, edges);
    assert.deepEqual(result.nodes.map((n) => n.id), ['f', 'g', 'T']);
    assert.deepEqual(result.edges, [edge('f', 'g'), edge('g', 'T', 'USAGE')]);
    assert.deepEqual(
      [...result.modulesByFile.entries()],
      [
        [
          'src/x.ts',
          folded(
            'src/x.ts',
            ['x.ts'],
            [
              { id: 'f', kind: 'CALLS' },
              { id: 'g', kind: 'CALLS' },
              { id: 'T', kind: 'USAGE' },
            ],
            1,
            40,
          ),
        ],
      ],
    );
  });

  it('lists a target reached by both CALLS and USAGE once, as CALLS; dedupes repeats', () => {
    const nodes = [node('m', 'a.ts', 'Module'), node('f', 'b.ts')];
    const result = foldModules(nodes, [edge('m', 'f', 'USAGE'), edge('m', 'f'), edge('m', 'f')]);
    assert.deepEqual(result.modulesByFile.get('a.ts')?.uses, [{ id: 'f', kind: 'CALLS' }]);
  });

  it('keeps an IMPORTS use, ordered after CALLS and USAGE, and never lets it replace a CALLS', () => {
    const nodes = [node('m', 'a.ts', 'Module'), node('f', 'b.ts'), node('g', 'b.ts'), node('h', 'b.ts')];
    const result = foldModules(nodes, [edge('m', 'f', 'IMPORTS'), edge('m', 'g', 'USAGE'), edge('m', 'h'), edge('m', 'h', 'IMPORTS')]);
    assert.deepEqual(result.modulesByFile.get('a.ts')?.uses, [
      { id: 'h', kind: 'CALLS' },
      { id: 'g', kind: 'USAGE' },
      { id: 'f', kind: 'IMPORTS' },
    ]);
  });

  it('records nothing for a target removed earlier (e.g. test code) or for another Module', () => {
    const nodes = [node('m1', 'a.ts', 'Module'), node('m2', 'b.ts', 'Module'), node('f', 'b.ts')];
    const result = foldModules(nodes, [edge('m1', 'm2'), edge('m1', 'gone-test-helper'), edge('f', 'm2', 'USAGE')]);
    assert.deepEqual(result.nodes.map((n) => n.id), ['f']);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.modulesByFile.get('a.ts'), folded('a.ts', ['m1'], []));
    assert.deepEqual(result.modulesByFile.get('b.ts'), folded('b.ts', ['m2'], []));
  });

  it('merges two Modules in one file, with their combined range', () => {
    const nodes = [node('m2', 'a.ts', 'Module', 5, 30), node('m1', 'a.ts', 'Module', 1, 10), node('f', 'b.ts'), node('g', 'b.ts')];
    const result = foldModules(nodes, [edge('m2', 'g'), edge('m1', 'f')]);
    assert.deepEqual(
      result.modulesByFile.get('a.ts'),
      folded(
        'a.ts',
        ['m1', 'm2'],
        [
          { id: 'f', kind: 'CALLS' },
          { id: 'g', kind: 'CALLS' },
        ],
        1,
        30,
      ),
    );
  });

  it('a Module id duplicated across files: each file gets that id\'s uses, never an empty entry', () => {
    const nodes = [node('dup', 'a.ts', 'Module'), node('dup', 'b.ts', 'Module'), node('f', 'c.ts')];
    const result = foldModules(nodes, [edge('dup', 'f')]);
    assert.deepEqual(result.modulesByFile.get('a.ts'), folded('a.ts', ['dup'], [{ id: 'f', kind: 'CALLS' }]));
    assert.deepEqual(result.modulesByFile.get('b.ts'), folded('b.ts', ['dup'], [{ id: 'f', kind: 'CALLS' }]));
  });

  it('returns the inputs unchanged when there is no Module', () => {
    const nodes = [node('f', 'a.ts'), node('g', 'a.ts')];
    const edges = [edge('f', 'g')];
    const result = foldModules(nodes, edges);
    assert.equal(result.nodes, nodes);
    assert.equal(result.edges, edges);
    assert.equal(result.modulesByFile.size, 0);
  });

  it('an id shared by a Module and a map Node stays on the map with its edges', () => {
    const nodes = [node('dup', 'a.ts', 'Module'), node('dup', 'a.ts'), node('g', 'b.ts')];
    const edges = [edge('dup', 'g')];
    const result = foldModules(nodes, edges);
    assert.deepEqual(
      result.nodes.map((n) => [n.id, n.kind]),
      [
        ['dup', 'Function'],
        ['g', 'Function'],
      ],
    );
    assert.deepEqual(result.edges, edges);
    assert.equal(result.modulesByFile.size, 0);
  });

  it("a Module's call no longer counts toward its target's blast radius", () => {
    // f is called by x.ts's top level, and calls g. Unfolded, f's blast radius
    // would include the Module; folded, only g.
    const nodes = [node('x.ts', 'x.ts', 'Module'), node('f', 'y.ts'), node('g', 'y.ts')];
    const edges = [edge('x.ts', 'f'), edge('f', 'g')];
    const result = foldModules(nodes, edges);
    assert.equal(computeBlastRadius(result.nodes, result.edges, 'f'), 1);
    assert.equal(computeBlastRadius(nodes, edges, 'f'), 2, 'sanity: the Module edge would have counted');
  });
});

describe('scopeFoldedModules', () => {
  const modules = [
    folded('web/a.ts', ['ma'], [
      { id: 'w', kind: 'CALLS' },
      { id: 'd', kind: 'USAGE' },
    ]),
    folded('lib/boot.ts', ['mb'], [{ id: 'w', kind: 'CALLS' }]),
    folded('webapp/x.ts', ['mx'], []),
  ];

  it('keeps every Module and use with no scope and every target on the map', () => {
    assert.deepEqual(scopeFoldedModules(modules, new Set(['w', 'd']), []), modules);
  });

  it("drops Modules whose file is out of scope (on a path boundary) and uses whose target didn't survive", () => {
    assert.deepEqual(scopeFoldedModules(modules, new Set(['w']), ['web']), [
      folded('web/a.ts', ['ma'], [{ id: 'w', kind: 'CALLS' }]),
    ]);
  });
});

describe('attachFoldedModuleLinks', () => {
  it("gives every Node in a file its file's top-level uses (one shared array), and each target its load-time callers", () => {
    const { nodes, modulesByFile } = foldModules(
      [
        node('m', 'a.ts', 'Module'),
        node('n', 'c.ts', 'Module'),
        node('o', 'd.ts', 'Module'),
        node('f', 'a.ts'),
        node('h', 'a.ts'),
        node('g', 'b.ts'),
        node('k', 'c.ts'),
      ],
      [edge('m', 'g'), edge('o', 'g', 'USAGE'), edge('m', 'f')],
    );
    const attached = attachFoldedModuleLinks(nodes, [...modulesByFile.values()]);
    const byId = (id: string) => attached.find((n) => n.id === id)!;
    const uses = [
      { id: 'f', kind: 'CALLS' },
      { id: 'g', kind: 'CALLS' },
    ];
    assert.deepEqual(byId('f').fileTopLevel, uses);
    assert.equal(byId('f').fileTopLevel, byId('h').fileTopLevel, 'one array per file, shared');
    assert.equal('fileTopLevel' in byId('g'), false);
    // c.ts has a Module that uses nothing: no empty `fileTopLevel`.
    assert.equal('fileTopLevel' in byId('k'), false);
    // The reverse link: g is called only by top-level code, in a.ts and d.ts.
    assert.deepEqual(byId('g').calledAtLoadBy, ['a.ts', 'd.ts']);
    assert.deepEqual(byId('f').calledAtLoadBy, ['a.ts']);
    assert.equal('calledAtLoadBy' in byId('h'), false);
  });

  it('re-running with a narrower set removes stale links instead of keeping them', () => {
    const first = attachFoldedModuleLinks([node('f', 'a.ts'), node('g', 'b.ts')], [folded('a.ts', ['m'], [{ id: 'g', kind: 'CALLS' }])]);
    assert.deepEqual(first.find((n) => n.id === 'g')?.calledAtLoadBy, ['a.ts']);
    const again = attachFoldedModuleLinks(first, []);
    assert.equal('fileTopLevel' in again[0]!, false);
    assert.equal('calledAtLoadBy' in again[1]!, false);
  });
});
