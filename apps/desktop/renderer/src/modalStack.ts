/**
 * P2-7 + P2-8: the one record of which modal overlays are open, in the order
 * they opened. Settings, the source viewer and Node Detail each register
 * here through `useModalLayer` — only the top entry handles Escape and Tab,
 * so one Escape undoes exactly one layer.
 *
 * Push order is open order, and for every combination that can actually
 * occur it is also visual z-order: Settings (`position: fixed`, z-index 20,
 * rendered by App) over either CodeMap overlay (z-index 10). The two CodeMap
 * overlays never stack on each other — Node Detail's "View source" closes
 * Node Detail before opening the source viewer, since both sit at z-index 10
 * and Node Detail renders later in the DOM. So the top of this stack is
 * always the dialog the user can see on top.
 *
 * Every decision the hook makes — which key does what, whether a scrim press
 * closes, whether closing restores focus, whether an overlay is open — is a
 * pure function here, unit-tested in `modalStack.test.ts`. The DOM helpers at
 * the bottom are not: the test runner has no DOM (`docs/agent.md`).
 */
import type { NodeDetailState, SourceViewState } from './CodeMap';

const layers: string[] = [];

/** Registers `id` as the newest (top) layer. Re-pushing an id moves it to the top rather than duplicating it. */
export function pushModalLayer(id: string): void {
  removeModalLayer(id);
  layers.push(id);
}

/** Drops `id` wherever it sits — closing a non-top layer leaves the others' order intact. */
export function removeModalLayer(id: string): void {
  const index = layers.indexOf(id);
  if (index !== -1) {
    layers.splice(index, 1);
  }
}

/** Whether `id` is the layer that currently owns Escape and Tab. */
export function isTopModalLayer(id: string): boolean {
  return layers.length > 0 && layers[layers.length - 1] === id;
}

/** A snapshot of the open layers, oldest first. */
export function openModalLayers(): readonly string[] {
  return [...layers];
}

/** What a keydown means for one modal layer. */
export type ModalKeyAction = 'close' | 'trap' | 'ignore';

export interface ModalKeyInput {
  key: string;
  /** Whether this layer is the top of the stack. */
  isTop: boolean;
  defaultPrevented: boolean;
  /** Mid IME composition — Escape there cancels the composition, not the dialog. */
  isComposing: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Escape closes and Tab (with or without Shift) is trapped — only for the
 * top layer. Escape during IME composition, and Tab with Ctrl/Alt/Meta
 * (tab switching, OS shortcuts), are left alone.
 */
export function modalKeyAction(input: ModalKeyInput): ModalKeyAction {
  if (!input.isTop || input.defaultPrevented) {
    return 'ignore';
  }
  if (input.key === 'Escape') {
    return input.isComposing ? 'ignore' : 'close';
  }
  if (input.key === 'Tab') {
    return input.ctrlKey || input.altKey || input.metaKey ? 'ignore' : 'trap';
  }
  return 'ignore';
}

export interface ScrimClickInput {
  /** The mousedown landed on the scrim itself (not the panel) with the primary button. */
  startedOnScrim: boolean;
  /** The click's `target === currentTarget`: it ended on the scrim itself. */
  targetIsCurrentTarget: boolean;
  isTop: boolean;
  /** `MouseEvent.button`; 0 is the primary button. */
  button: number;
}

/**
 * A scrim click closes its layer only when a primary-button press both
 * started and ended on the scrim itself, and the layer is on top — so a drag
 * that starts in the panel (a text selection) and ends on the scrim never
 * closes it.
 */
export function shouldCloseOnScrimClick(input: ScrimClickInput): boolean {
  return input.button === 0 && input.startedOnScrim && input.targetIsCurrentTarget && input.isTop;
}

export interface RestoreFocusInput {
  /** The closing layer was the top of the stack when it closed. */
  wasTop: boolean;
  /** Focus was inside the closing layer (or was last inside it before it left the DOM). */
  focusInsideLayer: boolean;
}

/**
 * Closing restores focus to the opener only when the closing layer was on
 * top or held focus — so a lower layer closed in code (e.g. a refresh closing
 * Node Detail under Settings) never pulls focus out of the dialog on top.
 */
export function shouldRestoreFocusOnClose(input: RestoreFocusInput): boolean {
  return input.wasTop || input.focusInsideLayer;
}

/**
 * Whether the source viewer overlay is mounted (every non-`closed` state,
 * loading and error included). A type guard, so the render gate and the
 * modal layer's `open` read the one predicate.
 */
export function sourceOverlayOpen(
  sourceView: SourceViewState,
): sourceView is Exclude<SourceViewState, { status: 'closed' }> {
  return sourceView.status !== 'closed';
}

/** Whether the Node Detail overlay is mounted. A type guard, like `sourceOverlayOpen`. */
export function nodeDetailOverlayOpen(
  nodeDetail: NodeDetailState,
): nodeDetail is Extract<NodeDetailState, { status: 'open' }> {
  return nodeDetail.status === 'open';
}

/**
 * The index Tab (or Shift+Tab) moves focus to among `count` focusable
 * elements, wrapping at both ends. `current` is -1 when focus is not on any
 * of them (it has escaped the layer, or sits on the container itself):
 * forward then enters at the first element, backward at the last. Returns -1
 * when there is nothing to focus.
 */
export function nextFocusIndex(current: number, count: number, shiftKey: boolean): number {
  if (count <= 0) {
    return -1;
  }
  if (current < 0 || current >= count) {
    return shiftKey ? count - 1 : 0;
  }
  return shiftKey ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * The element focus falls back to when a closed layer's opener has left the
 * document (e.g. its Node collapsed into a cluster at a coarser LOD): the Code
 * Map's own container, found by id so Settings (rendered by App, outside
 * CodeMap) can reach it too.
 */
export const MODAL_FOCUS_FALLBACK_ID = 'code-map-focus-fallback';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

/** The keyboard-reachable elements inside `container`, in DOM (tab) order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      // Covers a control inside a disabled `<fieldset>` too.
      !element.matches(':disabled') &&
      // Not rendered (display: none, or inside something that is).
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      element.closest('[inert]') === null,
  );
}
