/**
 * FIX-2: `traceCallPath`'s `found` result carries the BFS tree (`parents`,
 * `depths`) alongside the unchanged visit-order `path` — one case per row of
 * the spec's I/O & Edge-Case Matrix, plus the checked-in
 * `fixtures/path-trace-basic` call graph (fan-in + cycle).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type PathTraceEdge, type PathTraceNode, traceCallPath } from './index';

function nodes(...ids: string[]): PathTraceNode[] {
  return ids.map((id) => ({ id, name: id }));
}

/** A null-prototype record, matching what `traceCallPath` returns for `parents`/`depths`. */
function dict<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

function edge(source: string, target: string, kind: PathTraceEdge['kind'] = 'CALLS'): PathTraceEdge {
  return { source, target, kind };
}

describe('traceCallPath BFS tree (FIX-2)', () => {
  it('siblings of the entry are both children of the entry, not of each other', () => {
    // E calls A and B; A calls C. Edges deliberately out of order.
    const result = traceCallPath(nodes('E', 'A', 'B', 'C'), [edge('A', 'C'), edge('E', 'B'), edge('E', 'A')], 'E');
    assert.deepEqual(result, {
      status: 'found',
      path: ['E', 'A', 'B', 'C'],
      parents: dict({ E: null, A: 'E', B: 'E', C: 'A' }),
      depths: dict({ E: 0, A: 1, B: 1, C: 2 }),
    });
  });

  it('a linear chain is a chain', () => {
    const result = traceCallPath(nodes('E', 'A', 'B'), [edge('E', 'A'), edge('A', 'B')], 'E');
    assert.deepEqual(result, {
      status: 'found',
      path: ['E', 'A', 'B'],
      parents: dict({ E: null, A: 'E', B: 'A' }),
      depths: dict({ E: 0, A: 1, B: 2 }),
    });
  });

  it('a cycle back to the entry visits the entry once and keeps its parent null', () => {
    const result = traceCallPath(nodes('E', 'A'), [edge('E', 'A'), edge('A', 'E')], 'E');
    assert.deepEqual(result, {
      status: 'found',
      path: ['E', 'A'],
      parents: dict({ E: null, A: 'E' }),
      depths: dict({ E: 0, A: 1 }),
    });
  });

  it('a leaf entry is a single-Node tree', () => {
    const result = traceCallPath(nodes('E', 'X'), [edge('X', 'E')], 'E');
    assert.deepEqual(result, { status: 'found', path: ['E'], parents: dict({ E: null }), depths: dict({ E: 0 }) });
  });

  it('first discovery wins on fan-in, and non-CALLS / dangling edges add no parents', () => {
    // fixtures/path-trace-basic: handleRequest -> serviceA, serviceB; both
    // -> repository; repository <-> cacheLookup.
    const result = traceCallPath(
      nodes('handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup', 'other'),
      [
        edge('handleRequest', 'serviceB'),
        edge('handleRequest', 'serviceA'),
        edge('serviceB', 'repository'),
        edge('serviceA', 'repository'),
        edge('repository', 'cacheLookup'),
        edge('cacheLookup', 'repository'),
        edge('handleRequest', 'other', 'IMPORTS'),
        edge('handleRequest', 'ghost'),
      ],
      'handleRequest',
    );
    assert.deepEqual(result, {
      status: 'found',
      path: ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup'],
      parents: dict({
        handleRequest: null,
        serviceA: 'handleRequest',
        serviceB: 'handleRequest',
        repository: 'serviceA',
        cacheLookup: 'repository',
      }),
      depths: dict({ handleRequest: 0, serviceA: 1, serviceB: 1, repository: 2, cacheLookup: 3 }),
    });
  });

  it('every non-entry parent edge is a real CALLS edge, and parents/depths cover exactly the path', () => {
    const edges = [edge('E', 'B'), edge('E', 'A'), edge('A', 'C'), edge('B', 'C'), edge('C', 'D'), edge('D', 'A')];
    const result = traceCallPath(nodes('E', 'A', 'B', 'C', 'D'), edges, 'E');
    assert.equal(result.status, 'found');
    if (result.status !== 'found') return;
    assert.deepEqual(Object.keys(result.parents).sort(), [...result.path].sort());
    assert.deepEqual(Object.keys(result.depths).sort(), [...result.path].sort());
    for (const id of result.path.slice(1)) {
      const parent: string = result.parents[id]!;
      assert.ok(edges.some((e) => e.kind === 'CALLS' && e.source === parent && e.target === id), `${parent}→${id}`);
      assert.equal(result.depths[id], result.depths[parent]! + 1);
    }
  });

  it('uses null-prototype records, so a Node id like __proto__ or constructor is just a key', () => {
    const result = traceCallPath(nodes('E', '__proto__', 'constructor'), [edge('E', '__proto__'), edge('__proto__', 'constructor')], 'E');
    assert.equal(result.status, 'found');
    if (result.status !== 'found') return;
    assert.equal(Object.getPrototypeOf(result.parents), null);
    assert.equal(Object.getPrototypeOf(result.depths), null);
    assert.deepEqual(Object.keys(result.parents), ['E', '__proto__', 'constructor']);
    assert.equal(result.parents['__proto__'], 'E');
    assert.equal(result.parents['constructor'], '__proto__');
    assert.equal(result.depths['constructor'], 2);
  });

  it('is deterministic: same input, same tree', () => {
    const run = () => traceCallPath(nodes('E', 'A', 'B', 'C'), [edge('E', 'B'), edge('E', 'A'), edge('B', 'C')], 'E');
    assert.deepEqual(run(), run());
  });
});
