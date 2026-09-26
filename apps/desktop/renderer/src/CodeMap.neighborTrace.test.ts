/**
 * P2-4: a Node card's "called by"/"calls" pill draws a 1-hop neighbour trace.
 * `neighborTrace` computes it from the renderer's adjacency,
 * `pathTraceHighlight`/`isPathHighlightEdge` turn a Path Trace state into the
 * map highlight, `NodeNeighborPills` is the pill row and `NeighborTraceSteps`
 * is the step panel.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_RENDERED_NEIGHBORS,
  NeighborTraceSteps,
  NodeNeighborPills,
  callEdgesOf,
  type NodeAdjacency,
  type PathTraceState,
  isPathHighlightEdge,
  neighborPillLabel,
  neighborTrace,
  neighborTraceHeading,
  pathTraceHighlight,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

// ---------------------------------------------------------------------------
// Element-tree walking (`renderTree`/`textOf` from `./testRender`)
// ---------------------------------------------------------------------------

const byClass = (elements: RenderedElement[], className: string) =>
  elements.filter((element) => element.props.className === className);

const fakeEvent = { stopPropagation: () => {} };

// a, b, c call o; o calls x. (A self-loop never reaches the adjacency.)
const adjacency: NodeAdjacency = new Map([
  ['o', { callers: ['b', 'a', 'c'], callees: ['x'] }],
  ['a', { callers: [], callees: ['o'] }],
  ['b', { callers: [], callees: ['o'] }],
  ['c', { callers: [], callees: ['o'] }],
  ['x', { callers: ['o'], callees: [] }],
]);

describe('neighborTrace', () => {
  it('returns the origin and every caller, with caller→origin edges, in adjacency order', () => {
    assert.deepEqual(neighborTrace(adjacency, 'o', 'callers'), {
      nodeIds: ['o', 'b', 'a', 'c'],
      edgeKeys: ['b→o', 'a→o', 'c→o'],
      neighborIds: ['b', 'a', 'c'],
    });
  });

  it('returns the origin and its callee, with an origin→callee edge', () => {
    assert.deepEqual(neighborTrace(adjacency, 'o', 'callees'), {
      nodeIds: ['o', 'x'],
      edgeKeys: ['o→x'],
      neighborIds: ['x'],
    });
  });

  it('returns no neighbours or edges for a Node with none in that direction', () => {
    assert.deepEqual(neighborTrace(adjacency, 'x', 'callees'), { nodeIds: ['x'], edgeKeys: [], neighborIds: [] });
  });

  it('returns no neighbours for an origin missing from the adjacency', () => {
    assert.deepEqual(neighborTrace(adjacency, 'missing', 'callers'), {
      nodeIds: ['missing'],
      edgeKeys: [],
      neighborIds: [],
    });
  });

  it('does not alias the adjacency arrays', () => {
    neighborTrace(adjacency, 'o', 'callers').neighborIds.push('z');
    assert.deepEqual(adjacency.get('o')?.callers, ['b', 'a', 'c']);
  });
});

describe('pathTraceHighlight', () => {
  const neighbors: PathTraceState = {
    status: 'neighbors',
    originId: 'o',
    direction: 'callers',
    ...neighborTrace(adjacency, 'o', 'callers'),
  };

  it('highlights a found chain: its Nodes and its real CALLS edges', () => {
    const highlight = pathTraceHighlight(
      { status: 'found', path: ['a', 'o', 'x'], parents: { a: null, o: 'a', x: 'o' }, depths: { a: 0, o: 1, x: 2 } },
      [
        { source: 'a', target: 'o' },
        { source: 'o', target: 'x' },
      ],
    );
    assert.deepEqual([...highlight.nodeIds], ['a', 'o', 'x']);
    assert.deepEqual([...highlight.edgeKeys], ['a→o', 'o→x']);
    assert.equal(highlight.callsOnly, true);
  });

  // FIX-2 contract guard: `path` is BFS visit order, not a chain. Sibling
  // callees are consecutive in `path` but never call each other, so a
  // consecutive-pair key must never appear — only real CALLS edges do.
  it('highlights exactly the real CALLS edges among reached Nodes, never consecutive path pairs', () => {
    // E calls A and B; A calls C → path [E, A, B, C].
    const highlight = pathTraceHighlight(
      {
        status: 'found',
        path: ['E', 'A', 'B', 'C'],
        parents: { E: null, A: 'E', B: 'E', C: 'A' },
        depths: { E: 0, A: 1, B: 1, C: 2 },
      },
      [
        { source: 'E', target: 'A' },
        { source: 'E', target: 'B' },
        { source: 'A', target: 'C' },
        // An edge leaving the reached set never highlights.
        { source: 'C', target: 'outside' },
        { source: 'elsewhere', target: 'E' },
      ],
    );
    assert.deepEqual([...highlight.edgeKeys].sort(), ['A→C', 'E→A', 'E→B']);
    // The consecutive pairs A→B and B→C are not calls.
    assert.equal(highlight.edgeKeys.has('A→B'), false);
    assert.equal(highlight.edgeKeys.has('B→C'), false);
    assert.equal(isPathHighlightEdge(highlight, { source: 'A', target: 'B', label: 'CALLS' }), false);
    assert.equal(isPathHighlightEdge(highlight, { source: 'E', target: 'B', label: 'CALLS' }), true);
  });

  it('lights non-tree calls on fan-in (serviceB→repository), not sibling pairs', () => {
    // fixtures/path-trace-basic: repository is first reached via serviceA,
    // but serviceB really calls it too.
    const path = ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup'];
    const highlight = pathTraceHighlight(
      {
        status: 'found',
        path,
        parents: {
          handleRequest: null,
          serviceA: 'handleRequest',
          serviceB: 'handleRequest',
          repository: 'serviceA',
          cacheLookup: 'repository',
        },
        depths: { handleRequest: 0, serviceA: 1, serviceB: 1, repository: 2, cacheLookup: 3 },
      },
      [
        { source: 'handleRequest', target: 'serviceA' },
        { source: 'handleRequest', target: 'serviceB' },
        { source: 'serviceA', target: 'repository' },
        { source: 'serviceB', target: 'repository' },
        { source: 'repository', target: 'cacheLookup' },
        { source: 'cacheLookup', target: 'repository' },
      ],
    );
    assert.equal(highlight.edgeKeys.has('serviceB→repository'), true);
    assert.equal(highlight.edgeKeys.has('cacheLookup→repository'), true);
    assert.equal(highlight.edgeKeys.has('serviceA→serviceB'), false);
    // A consecutive pair appears only when it is itself a real call; the
    // sibling pair serviceA→serviceB never does.
    const realCalls = new Set([
      'handleRequest→serviceA',
      'handleRequest→serviceB',
      'serviceA→repository',
      'serviceB→repository',
      'repository→cacheLookup',
      'cacheLookup→repository',
    ]);
    assert.deepEqual([...highlight.edgeKeys].sort(), [...realCalls].sort());
    for (let i = 0; i < path.length - 1; i += 1) {
      const consecutive = `${path[i]}→${path[i + 1]}`;
      assert.equal(highlight.edgeKeys.has(consecutive), realCalls.has(consecutive), consecutive);
    }
    assert.equal(highlight.edgeKeys.size, 6);
  });

  it('highlights no self-edge on a cycle, and nothing for a leaf entry', () => {
    const cycle = pathTraceHighlight(
      { status: 'found', path: ['E', 'A'], parents: { E: null, A: 'E' }, depths: { E: 0, A: 1 } },
      [
        { source: 'E', target: 'A' },
        { source: 'A', target: 'E' },
        { source: 'E', target: 'E' },
      ],
    );
    assert.deepEqual([...cycle.edgeKeys].sort(), ['A→E', 'E→A']);
    const leaf = pathTraceHighlight({ status: 'found', path: ['E'], parents: { E: null }, depths: { E: 0 } }, [
      { source: 'X', target: 'E' },
    ]);
    assert.deepEqual([...leaf.nodeIds], ['E']);
    assert.equal(leaf.edgeKeys.size, 0);
  });

  it('does not throw on a found state missing parents/depths — the highlight needs neither', () => {
    const malformed = { status: 'found', path: ['E', 'A'] } as unknown as PathTraceState;
    const highlight = pathTraceHighlight(malformed, [{ source: 'E', target: 'A' }]);
    assert.deepEqual([...highlight.edgeKeys], ['E→A']);
  });

  it('callEdgesOf keeps only CALLS edges', () => {
    assert.deepEqual(
      callEdgesOf([
        { source: 'a', target: 'b', kind: 'CALLS' },
        { source: 'a', target: 'c', kind: 'IMPORTS' },
        { source: 'a', target: 'd', kind: 'USAGE' },
      ]),
      [{ source: 'a', target: 'b' }],
    );
  });

  it('highlights a neighbour trace from its stored snapshot, any edge kind', () => {
    const highlight = pathTraceHighlight(neighbors, []);
    assert.deepEqual([...highlight.nodeIds], ['o', 'b', 'a', 'c']);
    assert.deepEqual([...highlight.edgeKeys], ['b→o', 'a→o', 'c→o']);
    assert.equal(highlight.callsOnly, false);
  });

  it('reads the snapshot, not anything recomputed', () => {
    const highlight = pathTraceHighlight({
      status: 'neighbors',
      originId: 'o',
      direction: 'callees',
      nodeIds: ['o', 'q'],
      edgeKeys: ['o→q'],
      neighborIds: ['q'],
    }, []);
    assert.deepEqual([...highlight.nodeIds], ['o', 'q']);
    assert.deepEqual([...highlight.edgeKeys], ['o→q']);
  });

  it('highlights nothing while idle (or searching)', () => {
    for (const state of [{ status: 'idle' }, { status: 'searching' }] as PathTraceState[]) {
      const highlight = pathTraceHighlight(state, []);
      assert.equal(highlight.nodeIds.size, 0);
      assert.equal(highlight.edgeKeys.size, 0);
    }
  });

  describe('isPathHighlightEdge', () => {
    it("highlights a neighbour trace's connecting edge whatever its kind", () => {
      const highlight = pathTraceHighlight(neighbors, []);
      for (const label of ['CALLS', 'IMPORTS', 'USAGE']) {
        assert.equal(isPathHighlightEdge(highlight, { source: 'b', target: 'o', label }), true, label);
      }
    });

    it('does not highlight an edge the neighbour trace does not contain', () => {
      const highlight = pathTraceHighlight(neighbors, []);
      assert.equal(isPathHighlightEdge(highlight, { source: 'o', target: 'b', label: 'CALLS' }), false);
      assert.equal(isPathHighlightEdge(highlight, { source: 'o', target: 'x', label: 'CALLS' }), false);
    });

    it('keeps a found path CALLS-only', () => {
      const highlight = pathTraceHighlight({
        status: 'found',
        path: ['a', 'o'],
        parents: { a: null, o: 'a' },
        depths: { a: 0, o: 1 },
      }, [{ source: 'a', target: 'o' }]);
      assert.equal(isPathHighlightEdge(highlight, { source: 'a', target: 'o', label: 'CALLS' }), true);
      assert.equal(isPathHighlightEdge(highlight, { source: 'a', target: 'o', label: 'IMPORTS' }), false);
    });
  });
});

describe('NodeNeighborPills', () => {
  function renderPills(callerCount: number, calleeCount: number, calls: [string, string][] = []) {
    return byClass(
      renderTree(
        NodeNeighborPills({
          node: { id: 'node-o', name: 'handle' },
          callerCount,
          calleeCount,
          onShowNeighbors: (originId, direction) => calls.push([originId, direction]),
        }),
      ),
      'code-map__node-affordance',
    );
  }

  it('fires onShowNeighbors with the origin id and the right direction per pill', () => {
    const calls: [string, string][] = [];
    const [callersPill, calleesPill] = renderPills(3, 2, calls);
    (callersPill?.props.onClick as (event: unknown) => void)(fakeEvent);
    assert.deepEqual(calls, [['node-o', 'callers']]);
    (calleesPill?.props.onClick as (event: unknown) => void)(fakeEvent);
    assert.deepEqual(calls, [
      ['node-o', 'callers'],
      ['node-o', 'callees'],
    ]);
  });

  it('leads each aria-label with the visible pill text (plural)', () => {
    const [callersPill, calleesPill] = renderPills(3, 2);
    assert.equal(textOf(callersPill), '↑3 called by');
    assert.equal(callersPill?.props['aria-label'], '3 called by — show the callers of handle');
    assert.equal(textOf(calleesPill), '↓2 calls');
    assert.equal(calleesPill?.props['aria-label'], '2 calls — show the callees of handle');
  });

  it('uses the singular for a count of 1', () => {
    const [callersPill, calleesPill] = renderPills(1, 1);
    assert.equal(textOf(callersPill), '↑1 called by');
    assert.equal(callersPill?.props['aria-label'], '1 called by — show the caller of handle');
    assert.equal(textOf(calleesPill), '↓1 call');
    assert.equal(calleesPill?.props['aria-label'], '1 call — show the callee of handle');
  });

  it('renders no pill for a count of 0', () => {
    assert.equal(renderPills(0, 0).length, 0);
    const [only] = renderPills(0, 4);
    assert.equal(only?.props['aria-label'], neighborPillLabel('callees', 4, 'handle'));
  });
});

describe('neighborTraceHeading', () => {
  it('names each direction', () => {
    assert.equal(neighborTraceHeading('handle', 'callers', 3), 'Callers of handle (3)');
    assert.equal(neighborTraceHeading('handle', 'callees', 1), 'Callees of handle (1)');
  });
});

describe('NeighborTraceSteps', () => {
  const files: Record<string, string | undefined> = { b: 'src/b.ts', a: undefined, c: 'src/c.ts' };
  const names: Record<string, string> = { b: 'beta', a: 'alpha', c: 'gamma' };

  function renderSteps(
    direction: 'callers' | 'callees',
    neighborIds: string[] = ['b', 'a', 'c'],
    navigated: string[] = [],
    dismissed: number[] = [],
  ) {
    return renderTree(
      NeighborTraceSteps({
        originId: 'node-o',
        originName: 'handle',
        direction,
        neighborIds,
        resolveNode: (id) => ({ name: names[id] ?? id, file: files[id] }),
        onNavigate: (id) => navigated.push(id),
        onDismiss: () => dismissed.push(1),
      }),
    );
  }

  it('headings read "Callers of <origin> (N)" / "Callees of <origin> (N)"', () => {
    const callers = renderSteps('callers');
    assert.equal(callers[0]?.props['aria-label'], 'Callers of handle (3)');
    assert.equal(textOf(byClass(callers, 'code-map__path-trace-neighbors-heading')[0]), 'Callers of handle (3)');
    const callees = renderSteps('callees');
    assert.equal(textOf(byClass(callees, 'code-map__path-trace-neighbors-heading')[0]), 'Callees of handle (3)');
  });

  it("the heading's origin name navigates back to the origin", () => {
    const navigated: string[] = [];
    const [origin] = byClass(renderSteps('callers', undefined, navigated), 'code-map__path-trace-neighbors-origin');
    assert.equal(origin?.type, 'button');
    (origin?.props.onClick as () => void)();
    assert.deepEqual(navigated, ['node-o']);
  });

  it('lists one row per neighbour in an unordered list, no hop numbers, each navigating to it', () => {
    const navigated: string[] = [];
    const elements = renderSteps('callers', undefined, navigated);
    assert.equal(byClass(elements, 'code-map__path-trace-steps')[0]?.type, 'ul');
    const rows = byClass(elements, 'code-map__path-trace-stack-row');
    assert.deepEqual(
      rows.map((row) => textOf(row)),
      ['betasrc/b.ts', 'alpha', 'gammasrc/c.ts'],
    );
    assert.equal(byClass(elements, 'code-map__path-trace-hop-circle').length, 0);
    for (const row of rows) {
      (row.props.onClick as () => void)();
    }
    assert.deepEqual(navigated, ['b', 'a', 'c']);
    assert.equal(byClass(elements, 'code-map__path-trace-candidates-truncated').length, 0);
  });

  it(`caps the rows at ${MAX_RENDERED_NEIGHBORS} and says how many there are`, () => {
    const total = MAX_RENDERED_NEIGHBORS + 7;
    const ids = Array.from({ length: total }, (_, index) => `n${index}`);
    const elements = renderSteps('callers', ids);
    const rows = byClass(elements, 'code-map__path-trace-stack-row');
    assert.equal(rows.length, MAX_RENDERED_NEIGHBORS);
    assert.equal(textOf(rows[0]), 'n0');
    assert.equal(textOf(rows[MAX_RENDERED_NEIGHBORS - 1]), `n${MAX_RENDERED_NEIGHBORS - 1}`);
    const [notice] = byClass(elements, 'code-map__path-trace-candidates-truncated');
    assert.match(textOf(notice), new RegExp(`^Showing the first ${MAX_RENDERED_NEIGHBORS} of ${total}\\b`));
    // The heading still counts every neighbour.
    assert.equal(elements[0]?.props['aria-label'], `Callers of handle (${total})`);
  });

  it('renders exactly the cap without a truncation line', () => {
    const ids = Array.from({ length: MAX_RENDERED_NEIGHBORS }, (_, index) => `n${index}`);
    const elements = renderSteps('callers', ids);
    assert.equal(byClass(elements, 'code-map__path-trace-stack-row').length, MAX_RENDERED_NEIGHBORS);
    assert.equal(byClass(elements, 'code-map__path-trace-candidates-truncated').length, 0);
  });

  it('dismisses through its Dismiss button', () => {
    const dismissed: number[] = [];
    const [dismiss] = byClass(renderSteps('callers', undefined, [], dismissed), 'code-map__path-trace-dismiss');
    (dismiss?.props.onClick as () => void)();
    assert.equal(dismissed.length, 1);
  });
});
