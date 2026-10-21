/**
 * Path Trace's step list: the call tree a found trace renders as.
 *
 * Extracted from `CodeMap.tsx` with its own ordering logic, its indent
 * arithmetic and the one-time warning it keeps per malformed trace. Self
 * contained: it needs one type back from `CodeMap.tsx` (`FoundPathTrace`),
 * and nothing else from it, so the edge between the two modules is type-only
 * — the harmless kind.
 *
 * FIX-2's rule travels with it: the list renders the real call tree as nested
 * lists so assistive tech gets the structure, never a fabricated consecutive
 * chain, and rows carry no hop numbers because tree order is not a sequence.
 */
import type { FoundPathTrace } from './CodeMap';

/**
 * FIX-1: the extends-beyond line's text. When the step list is also capped
 * (a neighbour trace past `MAX_RENDERED_NEIGHBORS`), the cap folds into the
 * same sentence rather than a second line.
 */
export function routeExtendsBeyondText(listed?: { shown: number; total: number }): string {
  return listed
    ? `The route extends beyond the view — use the steps to follow it (first ${listed.shown} of ${listed.total} listed).`
    : 'The route extends beyond the view — use the steps to follow it.';
}

/** FIX-1: the muted extends-beyond line, shared by both step panels. Hookless. */
export function RouteExtendsBeyondLine({ listed }: { listed?: { shown: number; total: number } }) {
  return (
    <p className="code-map__path-trace-candidates-truncated" role="status">
      {routeExtendsBeyondText(listed)}
    </p>
  );
}

/**
 * FIX-2: what `callTreeOrder` reads — a `'found'` trace's `path`, `parents`
 * and `depths`. `parents`/`depths` are typed optional on purpose: a result
 * from an older Graph Service (or any malformed one) may lack them, and the
 * step list must degrade rather than throw.
 */
export interface CallTreeInput {
  path: readonly string[];
  parents?: FoundPathTrace['parents'] | undefined;
  depths?: FoundPathTrace['depths'] | undefined;
}

/** FIX-2: one row of the `'found'` call tree — see `callTreeOrder`. */
export interface CallTreeRow {
  id: string;
  /** Depth in the BFS tree (root = 0) — drives the indent and the list nesting. */
  depth: number;
  /** The row's tree parent, `null` for a root. */
  parent: string | null;
  /**
   * The caller to NAME on this row: its parent whenever the parent isn't the
   * row directly above, or whenever the indent has hit its cap
   * (`CALL_TREE_INDENT_CAP_DEPTH`) and can no longer show nesting on its own.
   * `null` otherwise.
   */
  calledBy: string | null;
}

/** FIX-2: indent per tree level, and the depth at which it stops growing (64px). */
const CALL_TREE_INDENT_PX = 8;
export const CALL_TREE_INDENT_CAP_DEPTH = 8;

/** FIX-2: a row's indent in px — `depth * 8`, capped at 64px so a deep tree can't push text out of the fixed-width panel. */
export function callTreeIndentPx(depth: number): number {
  return Math.min(depth, CALL_TREE_INDENT_CAP_DEPTH) * CALL_TREE_INDENT_PX;
}

// Malformed-trace warnings fire once per trace object, not on every render.
const warnedCallTrees = new WeakSet<object>();
function warnCallTreeOnce(trace: CallTreeInput, message: string): void {
  if (warnedCallTrees.has(trace)) {
    return;
  }
  warnedCallTrees.add(trace);
  console.warn(`[path-trace] ${message}`);
}

/**
 * FIX-2: the `'found'` step list's rows, in depth-first pre-order of the BFS
 * tree (children in ascending id order, the engine's own sibling order), so
 * each row sits directly under its real caller and indentation alone is
 * truthful: for E→(A, B), A→C the rows are E, A, C, B. Never BFS order —
 * there, C would render under B, which doesn't call it.
 *
 * Pure. Robust to a malformed result, never throwing:
 *  - `parents` missing: every Node is a root, so the list is flat, in `path`
 *    order, with no caller notes (logged once).
 *  - a self-parent, a non-string parent, or a parent not in `path`: that
 *    Node is a root (logged once).
 *  - a parent cycle unreachable from any root: its Nodes are appended as
 *    roots, so every `path` Node still renders exactly once.
 *  - depth is always the tree depth — root 0, otherwise the parent's depth
 *    + 1 — which is exactly what the engine's `depths` holds by
 *    construction. A missing `depths`, or an entry that disagrees, is
 *    derived that way (logged once) rather than trusted, so the indent can
 *    never contradict the nesting.
 */
export function callTreeOrder(trace: CallTreeInput): CallTreeRow[] {
  const { parents, depths } = trace;
  if (!parents || !depths) {
    warnCallTreeOnce(trace, `found trace is missing ${!parents ? 'parents' : 'depths'}; rendering a degraded call tree.`);
  }
  const ids = [...new Set(trace.path)];
  const inPath = new Set(ids);

  const parentOf = new Map<string, string | null>();
  for (const id of ids) {
    const raw: unknown = parents && Object.hasOwn(parents, id) ? parents[id] : null;
    const valid = typeof raw === 'string' && raw !== id && inPath.has(raw);
    if (parents && raw !== null && !valid) {
      warnCallTreeOnce(trace, `found trace has an invalid parent for ${id}; treating it as a root.`);
    }
    parentOf.set(id, valid ? raw : null);
  }

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    if (parent === null) {
      roots.push(id);
      continue;
    }
    const siblings = childrenOf.get(parent);
    if (siblings) {
      siblings.push(id);
    } else {
      childrenOf.set(parent, [id]);
    }
  }
  for (const children of childrenOf.values()) {
    children.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const rows: CallTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (rootId: string) => {
    // Iterative pre-order DFS: a deep tree can't blow the call stack.
    const stack: { id: string; depth: number; parent: string | null }[] = [
      { id: rootId, depth: 0, parent: null },
    ];
    while (stack.length > 0) {
      const { id, depth, parent } = stack.pop()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      if (depths && depths[id] !== depth) {
        warnCallTreeOnce(trace, `found trace depth for ${id} disagrees with its parent chain; using the tree depth.`);
      }
      const previous = rows.at(-1)?.id;
      rows.push({
        id,
        depth,
        parent,
        calledBy:
          parent !== null && (parent !== previous || depth >= CALL_TREE_INDENT_CAP_DEPTH) ? parent : null,
      });
      const children = childrenOf.get(id) ?? [];
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({ id: children[i]!, depth: depth + 1, parent: id });
      }
    }
  };
  for (const root of roots) {
    walk(root);
  }
  for (const id of ids) {
    if (!visited.has(id)) {
      warnCallTreeOnce(trace, `found trace has a parent cycle at ${id}; treating it as a root.`);
      parentOf.set(id, null);
      walk(id);
    }
  }
  return rows;
}

/** FIX-2: a call-tree row plus its children, for the nested-list rendering. */
interface CallTreeNode {
  row: CallTreeRow;
  children: CallTreeNode[];
}

/** FIX-2: nests `callTreeOrder`'s pre-order rows by depth (each row's parent is the nearest shallower row above it). */
function nestCallTreeRows(rows: readonly CallTreeRow[]): CallTreeNode[] {
  const roots: CallTreeNode[] = [];
  const stack: CallTreeNode[] = [];
  for (const row of rows) {
    const node: CallTreeNode = { row, children: [] };
    while (stack.length > 0 && stack.at(-1)!.row.depth >= row.depth) {
      stack.pop();
    }
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** FIX-2: a step row's "called by X" note — this prefix, then the caller's identifier in `<code>`. */
export const CALLED_BY_PREFIX = 'called by ';

/**
 * Story 1.9 (Phase 2): the step panel for a `'found'` Path Trace state —
 * extracted (FIX-1) as a hookless component, like `NeighborTraceSteps`, so a
 * test can walk its element tree. `resolveNode` returns the id itself as the
 * name when a Node can't be resolved.
 *
 * FIX-2: renders the call tree (`callTreeOrder`) as nested `<ul>`s, so
 * assistive tech gets the real structure, not just the visual indent. No hop
 * numbers: rows are tree order, not a sequence. A row names its caller
 * ("called by X") when the caller isn't the row directly above.
 */
export function FoundTraceSteps({
  path,
  parents,
  depths,
  resolveNode,
  onNavigate,
  onDismiss,
  routeClamped = false,
}: {
  path: readonly string[];
  parents: FoundPathTrace['parents'];
  depths: FoundPathTrace['depths'];
  resolveNode: (id: string) => { name: string; file: string | undefined };
  onNavigate: (id: string) => void;
  onDismiss: () => void;
  /** FIX-1: `routeViewport` clamped the fit, so the route runs past the view. */
  routeClamped?: boolean;
}) {
  const renderNodes = (nodes: CallTreeNode[], nested: boolean) => (
    <ul className={nested ? 'code-map__path-trace-tree-children' : 'code-map__path-trace-steps code-map__path-trace-tree'}>
      {nodes.map(({ row: { id, depth, calledBy }, children }) => {
        const node = resolveNode(id);
        return (
          // `callTreeOrder` renders each Node exactly once, so `id` is a unique key.
          <li key={id}>
            <button type="button" className="code-map__path-trace-stack-row" onClick={() => onNavigate(id)}>
              {/* Roots (depth 0) carry no connector; every other row is
                  indented by its tree depth (`callTreeIndentPx`, capped at
                  64px — past the cap the caller is always named instead). */}
              {depth > 0 && (
                <span
                  className="code-map__path-trace-indent"
                  aria-hidden="true"
                  style={{ marginLeft: `${callTreeIndentPx(depth)}px` }}
                >
                  └─
                </span>
              )}
              <span className="code-map__path-trace-stack-row-text">
                <code className="code-map__path-trace-stack-row-name">{node.name}</code>
                {calledBy !== null && (
                  <span className="code-map__path-trace-stack-row-caller">
                    {CALLED_BY_PREFIX}
                    <code>{resolveNode(calledBy).name}</code>
                  </span>
                )}
                {node.file && <span className="code-map__path-trace-stack-row-module">{node.file}</span>}
              </span>
            </button>
            {children.length > 0 && renderNodes(children, true)}
          </li>
        );
      })}
    </ul>
  );
  return (
    // Boundaries & Constraints (UX-DR10): "leaves the
    // highlight/step list visible for further stepping" — clicking
    // an entry only re-centers the map via `navigateToNode`, it
    // never closes/collapses this panel.
    //
    // DESIGN.md `path-trace-stack-row`: dense-profiler's indented
    // call-stack visual — tree-indent glyph, identifier, module.
    // Deliberately no duration/timing field (Never: driller resolves
    // paths statically and never executes code).
    <div className="code-map__path-trace-steps-panel" role="region" aria-label="Call tree">
      {renderNodes(nestCallTreeRows(callTreeOrder({ path, parents, depths })), false)}
      {routeClamped && <RouteExtendsBeyondLine />}
      {/* Story 1.9 (Phase 4): logs the dismissal (AD-21) and resets
          the panel to `idle` — also driller's first clear-search
          affordance, resolving Phase 2's deferred gap. */}
      <button
        type="button"
        className="code-map__path-trace-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
