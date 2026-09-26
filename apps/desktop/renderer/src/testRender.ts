/**
 * Test-only helpers for rendering a HOOKLESS component by calling it as a
 * plain function and walking the React elements it returns — the renderer's
 * unit tests run under `node --test` with no DOM. Function components in the
 * tree are expanded by calling them with their props; anything that uses a
 * hook cannot be rendered this way.
 *
 * Imported only by `*.test.ts` files, so it is never bundled into the app.
 * It needs no Node types, so it typechecks under the renderer's own config.
 */

export interface RenderedElement {
  type: unknown;
  props: Record<string, unknown>;
}

export function isRenderedElement(value: unknown): value is RenderedElement {
  return typeof value === 'object' && value !== null && '$$typeof' in value && 'type' in value && 'props' in value;
}

/** A host element's children, or a function component's rendered output. */
export function childrenOf(element: RenderedElement): unknown {
  return typeof element.type === 'function'
    ? (element.type as (props: Record<string, unknown>) => unknown)(element.props)
    : element.props.children;
}

/** Every element in the tree, depth-first, in document order. */
export function renderTree(node: unknown, out: RenderedElement[] = []): RenderedElement[] {
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

/** The concatenated text content of a node, visually hidden text included. */
export function textOf(node: unknown): string {
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
