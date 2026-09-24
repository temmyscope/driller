/**
 * P0-2c: unit tests for Health Audit Mode's row interaction — one case per row
 * of the spec's I/O & Edge-Case Matrix.
 *
 * Why these render the components instead of pinning another pure helper: the
 * two failure modes this spec names are both SILENT WRONG BEHAVIOR, not a
 * crash, and neither is visible from a pure function. "The remainder lines are
 * not activatable" is a claim about which elements carry a handler, and
 * "duplicate-named rows open distinct Nodes" is a claim about WHICH Node the
 * handler closes over — a name-keyed lookup would pass every string assertion
 * and still open the wrong Node.
 *
 * This repo's runner is `node --test` with no DOM (`docs/agent.md`), so there
 * is nothing to mount into. It does not need one: a React element is a plain
 * object (`type`, `props`), and a function component is a plain function from
 * props to those objects, so calling the component and walking what it returns
 * reaches the handlers directly. `renderTree` below is that walk and the only
 * machinery here — no test framework, no renderer, matching the loader's own
 * "smallest thing that works, and no second convention" stance.
 *
 * THE CONSTRAINT THIS BUYS: `HealthAuditClusterGrid` and
 * `HealthAuditClusterRow` must stay HOOKLESS. `renderTree` invokes them
 * directly rather than through a renderer, so React's dispatcher is unset — a
 * `useMemo`/`useId`/`useState` in either component, or a `memo()` wrapper
 * around either, turns every test in this file into a dispatcher error instead
 * of an assertion. Both components say so at their own definitions; this is
 * the other half of that pact. If one of them ever genuinely needs a hook, the
 * honest move is to pull the hookless rendering into a child and point this
 * file at that, not to reach for a renderer this repo does not have.
 *
 * What this still cannot reach, and what the spec's manual checks therefore
 * cover:
 * - Real focus order, focus-ring visibility, and keyboard scrolling of the grid.
 * - That the Node Detail panel paints over the grid, and that the grid holds
 *   its scroll offset across an open/close.
 * - **The call-site wiring itself** — that the JSX passes
 *   `onActivateNode={openNodeDetail}`. That one line carries this spec's whole
 *   behavioral claim, and swapping it for `activateNode`, or for a no-op,
 *   leaves this entire file green. It is the same no-DOM-runner gap P0-2b
 *   logged for its own surface gates (`resolveCodeMapSurfaces` can be pinned
 *   exhaustively; which property each JSX block reads cannot), deferred on the
 *   same grounds — recorded here so it is never mistaken for covered.
 * - Anything about how a browser computes an accessible name.
 *   `accessibleNameOf` below is a deliberate approximation (see its comment).
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`, which is what lets a
 * `.ts` test import components out of a `.tsx` module.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapNode, DeterministicRiskSignalType, RiskSignal } from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';

import {
  HEALTH_CLUSTER_LIMIT,
  HEALTH_CLUSTER_NODE_LIMIT,
  HealthAuditClusterGrid,
  HealthAuditClusterRow,
  type HealthClusterNode,
  formatDeterministicSignalLabel,
  groupNodesIntoHealthClusters,
  heatForRiskCount,
  riskCountForNode,
} from './CodeMap';

// ---------------------------------------------------------------------------
// Element-tree walking
// ---------------------------------------------------------------------------

interface RenderedElement {
  type: string | ((props: Record<string, unknown>) => unknown);
  props: Record<string, unknown>;
  /** React's own reconciliation key — a top-level element field, not a prop. */
  key: string | null;
}

function isRenderedElement(value: unknown): value is RenderedElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$$typeof' in value &&
    'type' in value &&
    'props' in value
  );
}

function childrenOf(element: RenderedElement): unknown {
  return typeof element.type === 'function' ? element.type(element.props) : element.props.children;
}

/**
 * Every element the tree produces, in render order, with function components
 * invoked so their output is walked too. Depth-first and parent-before-child,
 * which is what makes "the Nth row button" mean the Nth row on screen.
 */
function renderTree(node: unknown, out: RenderedElement[] = []): RenderedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      renderTree(child, out);
    }
    return out;
  }
  if (!isRenderedElement(node)) {
    return out;
  }
  out.push(node);
  renderTree(childrenOf(node), out);
  return out;
}

/** Concatenated visible text of an element's own subtree, `aria-hidden` glyphs included. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  if (!isRenderedElement(node)) {
    return '';
  }
  return textOf(childrenOf(node));
}

/**
 * The element's accessible name AS COMPOSED FROM CONTENT — the three rules
 * that decide this row's name and nothing more: an `aria-hidden` subtree
 * contributes nothing, an `aria-label` on a descendant substitutes for that
 * descendant's own content (which is how each `role="img"` signal chip
 * contributes "Complexity: 21" rather than "●21"), and everything else
 * contributes its text.
 *
 * Deliberately NOT a reimplementation of accname: no `aria-labelledby`, no
 * `alt`/`title` fallback, no control-value handling. It is a check that the
 * row's name is built from what the row shows, which is the property P0-2c's
 * review asked for — a full accname implementation here would be a second,
 * unverifiable spec of the browser.
 */
function accessibleNameOf(node: unknown): string {
  return nameFragments(node).join(' ').replace(/\s+/g, ' ').trim();
}

function nameFragments(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      nameFragments(child, out);
    }
    return out;
  }
  if (!isRenderedElement(node)) {
    return out;
  }
  if (node.props['aria-hidden'] === 'true' || node.props['aria-hidden'] === true) {
    return out;
  }
  const label = node.props['aria-label'];
  if (typeof label === 'string') {
    out.push(label);
    return out;
  }
  nameFragments(childrenOf(node), out);
  return out;
}

// ---------------------------------------------------------------------------
// "Is this thing activatable?"
//
// Widened past the obvious `onClick` on purpose: the Never this guards ("no
// second click target per row") is about a target of ANY kind appearing in a
// row, and a nested `<a href>`, a `role="link"` span, or a `div` wired to
// `onMouseDown` would each be one while carrying no `onClick` at all.
// ---------------------------------------------------------------------------

const INTERACTIVE_TYPES = new Set([
  'a',
  'button',
  'details',
  'input',
  'label',
  'select',
  'summary',
  'textarea',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

const ACTIVATION_HANDLERS = [
  'onClick',
  'onDoubleClick',
  'onKeyDown',
  'onKeyPress',
  'onKeyUp',
  'onMouseDown',
  'onMouseUp',
  'onPointerDown',
  'onPointerUp',
  'onTouchStart',
];

function isActivatable(element: RenderedElement): boolean {
  const { props } = element;
  if (typeof element.type === 'string' && INTERACTIVE_TYPES.has(element.type)) {
    return true;
  }
  if (typeof props.role === 'string' && INTERACTIVE_ROLES.has(props.role)) {
    return true;
  }
  if (props.href !== undefined || props.tabIndex !== undefined) {
    return true;
  }
  return ACTIVATION_HANDLERS.some((handler) => typeof props[handler] === 'function');
}

function rowButtons(tree: RenderedElement[]): RenderedElement[] {
  return tree.filter(
    (element) => element.type === 'button' && element.props.className === 'code-map__health-row-button',
  );
}

function activate(button: RenderedElement): void {
  const onClick = button.props.onClick;
  assert.equal(typeof onClick, 'function', 'the row button must carry a click handler');
  (onClick as () => void)();
}

// ---------------------------------------------------------------------------
// Fixtures. Every `HealthClusterNode` these tests use comes out of the real
// `groupNodesIntoHealthClusters`, never hand-built — a hand-built member can
// carry a `riskCount` its signals do not justify, and a row asserted against
// one would pass while the shipped pairing was broken.
// ---------------------------------------------------------------------------

const LOCATION = { file: 'unused.ts', startLine: 1, endLine: 2 };

function deterministic(type: DeterministicRiskSignalType, value = 1): RiskSignal {
  return { family: 'deterministic', type, value, location: LOCATION, severity: 'moderate' };
}

function judgment(text: string): RiskSignal {
  return { family: 'llm-judgment', judgment: text, location: LOCATION };
}

const ALL_DETERMINISTIC_TYPES: DeterministicRiskSignalType[] = [
  'complexity',
  'cognitive-complexity',
  'hotspot',
  'blast-radius',
  'test-coverage-gap',
];

function signalsOfCount(count: number): RiskSignal[] {
  return ALL_DETERMINISTIC_TYPES.slice(0, count).map((type) => deterministic(type));
}

function node(overrides: Partial<CodeMapNode> & Pick<CodeMapNode, 'id' | 'file'>): CodeMapNode {
  return {
    name: overrides.id,
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'ready',
    riskSignals: [],
    ...overrides,
  };
}

/** The member the real grouping helper produces for a single Node. */
function memberFor(only: CodeMapNode): HealthClusterNode {
  const member = groupNodesIntoHealthClusters([only]).clusters[0]?.nodes[0];
  assert.ok(member !== undefined, 'the grouping helper must place a lone Node in a cluster');
  return member;
}

/** One row, rendered on its own, plus a recorder for what activating it opened. */
function renderRow(only: CodeMapNode): {
  tree: RenderedElement[];
  button: RenderedElement;
  opened: CodeMapNode[];
} {
  const opened: CodeMapNode[] = [];
  const tree = renderTree(
    HealthAuditClusterRow({
      member: memberFor(only),
      onActivate: (activated) => opened.push(activated),
    }),
  );
  const button = rowButtons(tree)[0];
  assert.ok(button !== undefined, 'a row must render its control');
  return { tree, button, opened };
}

/** The whole grid as it renders for `nodes`, plus the same recorder. */
function renderGrid(nodes: CodeMapNode[]): {
  tree: RenderedElement[];
  buttons: RenderedElement[];
  opened: CodeMapNode[];
} {
  const opened: CodeMapNode[] = [];
  const tree = renderTree(
    HealthAuditClusterGrid({
      grouping: groupNodesIntoHealthClusters(nodes),
      onActivateNode: (activated) => opened.push(activated),
    }),
  );
  return { tree, buttons: rowButtons(tree), opened };
}

// ---------------------------------------------------------------------------

describe('Health Audit row, rendered on its own', () => {
  // The row is the component that OWNS the handler, so it is tested directly
  // and not only through the grid — the grid's job is to pass `onActivate`
  // down, which is a different claim (and one the grid's own tests make).
  //
  // A NATIVE `<button>` is part of the assertion, not an incidental detail:
  // Enter and Space come from the platform for one, and are three hand-written
  // handlers away for a `div` with `role="button"` (the shape the canvas card
  // has to use, because React Flow owns its mouse handling). `type="button"`
  // because a bare `<button>` inside any future form would default to
  // submitting it.
  it('renders a native button that opens its own Node object', () => {
    const only = node({ id: 'api/svc.ts.charge', name: 'charge', file: 'api/svc.ts', riskSignals: signalsOfCount(3) });
    const { button, opened } = renderRow(only);

    assert.equal(button.type, 'button');
    assert.equal(button.props.type, 'button');
    activate(button);
    assert.equal(opened.length, 1);
    // The Node OBJECT, not a copy or a re-lookup — the callee
    // (`openNodeDetail`) renders straight from it.
    assert.equal(opened[0], only);
  });

  // The row is wrapped in an `<li>`, so it is still a list item to AT — the
  // control fills the row rather than replacing the list structure.
  it('stays a list item containing one control, not a bare button', () => {
    const { tree, button } = renderRow(node({ id: 'api/a.ts.one', name: 'one', file: 'api/a.ts' }));
    assert.equal(tree[0]?.type, 'li');
    assert.equal(tree.filter(isActivatable).length, 1);
    assert.equal(tree.filter(isActivatable)[0], button);
  });

  // Finding: the two identity lines both ellipsise, so a long identifier under
  // a deep qualified path is unreadable at this card width with nothing to
  // recover it. The `title` is that recovery path, and it has to carry BOTH
  // truncated strings, not just one.
  it('carries a title that recovers both ellipsised lines', () => {
    const only = node({ id: 'api/internal/service/billing.ts.reconcileOutstanding', name: 'reconcileOutstanding', file: 'api/internal/service/billing.ts' });
    const { button } = renderRow(only);

    assert.equal(
      button.props.title,
      'reconcileOutstanding · api/internal/service/billing.ts',
    );
  });
});

describe('Health Audit row accessible name', () => {
  // The finding this spec's review raised, as a test: an `aria-label` on the
  // button REPLACES its content as the accessible name, which would delete
  // every signal chip's own label from what is announced — "Complexity: 1",
  // "Blast radius: 1" and the whole AI-judgment sentence are rendered for
  // sighted users and announced nowhere. The button must therefore carry no
  // `aria-label` at all, and the name must compose from content.
  it('carries no aria-label, so every chip label still reaches the name', () => {
    const only = node({
      id: 'api/svc.ts.charge',
      name: 'charge',
      file: 'api/svc.ts',
      riskSignals: [...signalsOfCount(2), judgment('unbounded retry loop')],
    });
    const { tree, button } = renderRow(only);

    assert.equal(button.props['aria-label'], undefined);

    const name = accessibleNameOf(button);
    // Every chip in the row — deterministic and judgment alike — contributes
    // its own label. Asserted against the chips the row actually rendered
    // rather than against copied strings, so this cannot drift from
    // `DETERMINISTIC_SIGNAL_LABELS`.
    const chipLabels = tree
      .filter((element) => element.props.role === 'img')
      .map((element) => element.props['aria-label']);
    assert.ok(chipLabels.length >= 3, 'two deterministic chips and the judgment chip');
    for (const label of chipLabels) {
      assert.ok(typeof label === 'string' && name.includes(label), `missing from the name: ${String(label)}`);
    }
  });

  // What the row IS, then what activating it DOES — the affordance phrase last,
  // and present as real content rather than as a label override.
  it('composes the name from the identifier, location, band and affordance', () => {
    const only = node({ id: 'api/svc.ts.charge', name: 'charge', file: 'api/svc.ts', riskSignals: signalsOfCount(3) });
    const { button } = renderRow(only);
    const name = accessibleNameOf(button);

    assert.ok(name.startsWith('charge api/svc.ts'), name);
    assert.ok(name.includes(` ${heatForRiskCount(3)} `), name);
    assert.ok(name.endsWith('open Node detail'), name);
  });

  // The glyphs are decoration for the chip labels beside them and must not be
  // announced — `●`/`■`/`✦` read as nothing useful, or as literal punctuation.
  it('leaves the aria-hidden glyphs out of the name while still rendering them', () => {
    const only = node({
      id: 'api/svc.ts.charge',
      name: 'charge',
      file: 'api/svc.ts',
      riskSignals: [deterministic('complexity', 21), judgment('risky')],
    });
    const { button } = renderRow(only);

    assert.ok(textOf(button).includes('✦'), 'the judgment glyph is rendered');
    assert.equal(accessibleNameOf(button).includes('✦'), false);
  });

  // A clean Node reads "healthy" by the same path every other row takes (P3-9:
  // ordinary output, not a special-cased empty state) and is still named and
  // still activatable.
  it('names a zero-signal row "healthy" and still offers the affordance', () => {
    const clean = node({ id: 'api/a.ts.ok', name: 'ok', file: 'api/a.ts' });
    const { button } = renderRow(clean);
    const name = accessibleNameOf(button);

    assert.equal(riskCountForNode(clean), 0);
    assert.ok(name.includes('healthy'), name);
    assert.ok(name.endsWith('open Node detail'), name);
  });
});

describe('Health Audit row LLM judgment', () => {
  // The judgment branch of the row renders a chip and nothing else — the
  // sentence itself is too long for this card width, so it lives entirely in
  // the accessible name and the `title`. Untested until P0-2c's review caught
  // it: no fixture reached this branch at all.
  it('renders the judgment chip with the "AI judgment:" lead-in, glyph hidden', () => {
    const only = node({
      id: 'api/svc.ts.charge',
      name: 'charge',
      file: 'api/svc.ts',
      riskSignals: [judgment('unbounded retry loop')],
    });
    const { tree, button } = renderRow(only);
    const chip = tree.find(
      (element) =>
        typeof element.props['aria-label'] === 'string' &&
        element.props['aria-label'].startsWith('AI judgment:'),
    );

    assert.ok(chip !== undefined, 'the judgment renders a chip');
    // The "AI judgment:" lead-in is load-bearing: it stops a qualitative
    // sentence from reading with a deterministic measurement's confidence.
    assert.equal(chip.props['aria-label'], 'AI judgment: unbounded retry loop');
    assert.equal(chip.props.title, 'AI judgment: unbounded retry loop');
    assert.equal(chip.props.role, 'img');
    assert.ok(accessibleNameOf(button).includes('AI judgment: unbounded retry loop'));
  });

  // The same gate `riskCountForNode` counts by (`selectCountedLlmJudgment`):
  // a whitespace-only judgment renders nothing, so it must not be announced
  // either — otherwise a screen-reader user hears a signal that is not there.
  it('renders no judgment chip for a blank judgment, matching the count', () => {
    const only = node({ id: 'api/a.ts.ok', name: 'ok', file: 'api/a.ts', riskSignals: [judgment('  \n\t')] });
    const { tree, button } = renderRow(only);

    assert.equal(riskCountForNode(only), 0);
    assert.equal(
      tree.some(
        (element) =>
          typeof element.props['aria-label'] === 'string' &&
          element.props['aria-label'].startsWith('AI judgment:'),
      ),
      false,
    );
    assert.equal(accessibleNameOf(button).includes('AI judgment'), false);
  });
});

describe('Health Audit row location line', () => {
  // `formatCandidateLocation` strips a trailing `.${name}` off the Node id.
  it('shows the qualified path with the trailing symbol name stripped', () => {
    const { button } = renderRow(
      node({ id: 'api/internal/svc.ts.charge', name: 'charge', file: 'api/internal/svc.ts' }),
    );
    assert.ok(accessibleNameOf(button).startsWith('charge api/internal/svc.ts '), accessibleNameOf(button));
  });

  // The fallback branch, untested until P0-2c's review caught it: an id that
  // does NOT end in `.${name}` is shown verbatim. A module Node whose id is
  // its own bare name is the real case — the row then reads "charge charge",
  // which looks like a bug and is not one, so it is pinned rather than left to
  // be "fixed" by someone reading the render.
  it('shows an id that does not end in the symbol name verbatim', () => {
    const { button, tree } = renderRow(node({ id: 'charge', name: 'charge', file: 'api/svc.ts' }));
    const location = tree.find((element) => element.props.className === 'code-map__health-row-location');

    assert.ok(location !== undefined);
    assert.equal(textOf(location), 'charge');
    assert.equal(button.props.title, 'charge · charge');
  });
});

describe('Health Audit grid row activation', () => {
  it("renders one control per Node and opens each row's own Node", () => {
    const nodes = [
      node({ id: 'api/svc.ts.charge', name: 'charge', file: 'api/svc.ts', riskSignals: signalsOfCount(3) }),
      node({ id: 'api/svc.ts.refund', name: 'refund', file: 'api/svc.ts', riskSignals: signalsOfCount(1) }),
    ];
    const { buttons, opened } = renderGrid(nodes);

    assert.equal(buttons.length, 2);
    activate(buttons[0]!);
    activate(buttons[1]!);
    // Rows are ordered by `riskCount` desc, so `charge` is first.
    assert.deepEqual(
      opened.map((opening) => opening.id),
      ['api/svc.ts.charge', 'api/svc.ts.refund'],
    );
    assert.equal(opened[0], nodes[0]);
    assert.equal(opened[1], nodes[1]);
  });

  // I/O Matrix: "Duplicate names". A directory cluster merges every file under
  // it, so one card really can list two Nodes called `handle`. Resolving the
  // activation by name — or by anything other than the row's own Node — opens
  // the first match for both rows and looks entirely correct on screen.
  it('opens each duplicate-named row\'s own Node, never the first match by name', () => {
    const first = node({ id: 'api/a.ts.handle', name: 'handle', file: 'api/a.ts', riskSignals: signalsOfCount(2) });
    const second = node({ id: 'api/b.ts.handle', name: 'handle', file: 'api/b.ts', riskSignals: signalsOfCount(2) });
    const { buttons, opened } = renderGrid([first, second]);

    assert.equal(buttons.length, 2, 'both same-named Nodes get their own row');
    activate(buttons[1]!);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], second);
    assert.notEqual(opened[0], first);

    // And the two rows are distinguishable to a screen reader, which the Node
    // name alone cannot do here — the location line is what separates them.
    assert.notEqual(accessibleNameOf(buttons[0]!), accessibleNameOf(buttons[1]!));
  });

  // I/O Matrix: "Zero-signal Node". A clean repo is ordinary output (P3-9), so
  // its rows are ordinary controls — there is no "nothing to show here" row
  // state that would leave a healthy Node with no way into its detail panel.
  it('keeps a Node with no risk signals at all activatable', () => {
    const clean = node({ id: 'api/a.ts.ok', name: 'ok', file: 'api/a.ts' });
    const { buttons, opened } = renderGrid([clean]);

    assert.equal(buttons.length, 1);
    activate(buttons[0]!);
    assert.equal(opened[0], clean);
  });

  // Never: "no second click target per row. One row, one action." Counted
  // against the Nodes actually rendered, so a nested pill, link or
  // pointer-handler target added to the row later fails here rather than only
  // in review (`isActivatable` recognises all three).
  it('gives every rendered Node exactly one activatable control, and nothing else one', () => {
    const nodes = [
      node({ id: 'api/a.ts.one', name: 'one', file: 'api/a.ts', riskSignals: signalsOfCount(4) }),
      node({ id: 'api/a.ts.two', name: 'two', file: 'api/a.ts', riskSignals: signalsOfCount(2) }),
      node({ id: 'web/c.ts.three', name: 'three', file: 'web/c.ts', riskSignals: signalsOfCount(1) }),
    ];
    const { tree, buttons } = renderGrid(nodes);

    assert.equal(buttons.length, nodes.length);
    // The only OTHER focusable thing in the whole tree is the scroll container
    // itself (see below); everything else — cards, headings, heat lines, signal
    // chips, remainder lines — stays inert.
    const activatable = tree.filter(isActivatable);
    assert.equal(activatable.length, buttons.length + 1);
    assert.equal(activatable[0]!.type, 'section');
  });
});

describe('Health Audit remainder lines', () => {
  /** One cluster over the per-cluster cap, and enough clusters to pass the list cap. */
  function overflowingNodes(): CodeMapNode[] {
    const nodes: CodeMapNode[] = [];
    for (let index = 0; index < HEALTH_CLUSTER_NODE_LIMIT + 3; index += 1) {
      nodes.push(
        node({
          id: `api/big.ts.n${index}`,
          name: `n${index}`,
          file: 'api/big.ts',
          riskSignals: signalsOfCount(5),
        }),
      );
    }
    for (let index = 0; index < HEALTH_CLUSTER_LIMIT + 2; index += 1) {
      nodes.push(
        node({ id: `mod${index}/x.ts.solo`, name: 'solo', file: `mod${index}/x.ts`, riskSignals: signalsOfCount(1) }),
      );
    }
    return nodes;
  }

  // I/O Matrix: "Capped remainder". They are counts of Nodes the caps dropped,
  // not Nodes — there is no Node for them to open, so a handler on one could
  // only ever open the wrong thing or nothing at all.
  it('renders both remainders as inert text, with no handler and no focus stop', () => {
    const { tree } = renderGrid(overflowingNodes());
    const remainders = tree.filter(
      (element) =>
        typeof element.props.className === 'string' &&
        element.props.className.startsWith('code-map__health-more'),
    );

    assert.ok(remainders.length >= 2, 'both the per-cluster and the list remainder render');
    assert.ok(
      remainders.some((line) => textOf(line).includes('more Nodes')),
      'the per-cluster remainder renders',
    );
    assert.ok(
      remainders.some((line) => textOf(line).includes('more modules')),
      'the cluster-list remainder renders',
    );
    for (const line of remainders) {
      assert.equal(line.type, 'p', 'a remainder is a paragraph, never a control');
      assert.equal(isActivatable(line), false);
    }
  });

  // The cap's own consequence, stated as a count: a capped cluster renders
  // exactly `HEALTH_CLUSTER_NODE_LIMIT` controls, so the dropped Nodes are
  // genuinely absent rather than present-but-inert.
  it('renders one control per rendered Node only, never one per grouped Node', () => {
    const nodes = overflowingNodes();
    const grouping = groupNodesIntoHealthClusters(nodes);
    const rendered = grouping.clusters.reduce((total, cluster) => total + cluster.nodes.length, 0);

    const { buttons } = renderGrid(nodes);
    assert.equal(buttons.length, rendered);
    assert.ok(rendered < nodes.length, 'this fixture really does overflow both caps');
  });
});

describe('Health Audit grid keyboard reach', () => {
  // I/O Matrix: "Keyboard traversal" and "Long grid". Focusable rows are what
  // make the grid traversable at all; the container's own `tabIndex` is what
  // still makes the parts that are NOT controls — the heading, and the "+N
  // more" lines below the last row — reachable by scrolling without a pointer.
  it('keeps the scroll container focusable alongside the row controls', () => {
    const { tree, buttons } = renderGrid([
      node({ id: 'api/a.ts.one', name: 'one', file: 'api/a.ts', riskSignals: signalsOfCount(2) }),
    ]);
    const section = tree.find((element) => element.type === 'section');

    assert.ok(section !== undefined);
    assert.equal(section.props.tabIndex, 0);
    assert.equal(section.props.className, 'code-map__health-grid');
    assert.equal(buttons.length, 1);
  });

  // Rows are emitted in the order `groupNodesIntoHealthClusters` settled, so
  // tab order is the order the cards are read in — never DOM order diverging
  // from the ranking the surface is built on.
  it('emits the row controls in the grouping order, cluster by cluster', () => {
    const nodes = [
      node({ id: 'web/c.ts.quiet', name: 'quiet', file: 'web/c.ts', riskSignals: signalsOfCount(1) }),
      node({ id: 'api/a.ts.mild', name: 'mild', file: 'api/a.ts', riskSignals: signalsOfCount(2) }),
      node({ id: 'api/a.ts.worst', name: 'worst', file: 'api/a.ts', riskSignals: signalsOfCount(5) }),
    ];
    const grouping = groupNodesIntoHealthClusters(nodes);
    const expected = grouping.clusters.flatMap((cluster) =>
      cluster.nodes.map((member) => member.node.name),
    );

    const { buttons } = renderGrid(nodes);
    assert.deepEqual(
      buttons.map((button) => accessibleNameOf(button).split(' ')[0]),
      expected,
    );
  });

  // Two Nodes sharing a qualified name inside one cluster would be a duplicate
  // React key if the key were the id alone — React would reuse one element for
  // both rows, so the second row could render and open the first row's Node.
  // Nothing in `graph-contracts` guarantees id uniqueness, and this surface
  // already has to survive the duplicate-name case.
  //
  // Asserted on the KEYS, not on the rendered row count: `renderTree` does no
  // reconciliation, so a duplicate key would not collapse anything here and a
  // row-count assertion would pass either way.
  it('gives two rows sharing a Node id distinct keys', () => {
    const shared = 'api/a.ts.handle';
    const { tree, buttons } = renderGrid([
      node({ id: shared, name: 'handle', file: 'api/a.ts', riskSignals: signalsOfCount(2) }),
      node({ id: shared, name: 'handle', file: 'api/a.ts', riskSignals: signalsOfCount(2) }),
    ]);
    const keys = tree
      .filter((element) => element.type === HealthAuditClusterRow)
      .map((element) => element.key);

    assert.equal(buttons.length, 2, 'both Nodes get a row');
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(new Set(keys).size, keys.length);
  });
});

// P0-5: the Blast Radius chip must say its count is bounded, at the place it
// actually renders. Reverting this row's call site to a bare "label: value"
// fails here, not only in the helper's own unit test.
describe('Health Audit row Blast Radius chip', () => {
  it('labels the chip with the bounded count, and the row name carries it', () => {
    const only = node({
      id: 'api/svc.ts.charge',
      name: 'charge',
      file: 'api/svc.ts',
      riskSignals: [deterministic('blast-radius', 4)],
    });
    const { tree, button } = renderRow(only);
    const expected = formatDeterministicSignalLabel({ type: 'blast-radius', value: 4, severity: 'moderate' });
    const chip = tree.find(
      (element) =>
        element.props.role === 'img' &&
        typeof element.props['aria-label'] === 'string' &&
        element.props['aria-label'].startsWith('Blast radius'),
    );
    assert.ok(chip !== undefined, 'the row renders a Blast Radius chip');
    assert.equal(chip.props['aria-label'], expected);
    assert.equal(chip.props.title, expected);
    assert.ok(expected.includes('within'));
    assert.ok(expected.includes(String(BLAST_RADIUS_DEFAULT_HOPS)));
    assert.notEqual(expected, 'Blast radius: 4');
    assert.ok(accessibleNameOf(button).includes(expected), 'the row button name includes the chip label');
  });
});

