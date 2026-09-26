/**
 * P2-7 + P2-8: makes one `role="dialog" aria-modal="true"` overlay behave
 * as a modal layer on the shared stack (`modalStack.ts`):
 *
 * - Escape closes it only while it is the top layer, and goes no further —
 *   one Escape undoes exactly one layer.
 * - Tab / Shift+Tab wrap within its focusable elements (the container itself
 *   when it has none), so focus never walks into the map behind.
 * - Opening moves focus inside; closing returns focus to whatever held it at
 *   open, or — when that element has left the document — the Code Map's
 *   container, or failing that the body.
 * - The returned `scrimProps` go on the dimmed backdrop: a primary-button
 *   press that both starts and ends on the backdrop itself closes this layer;
 *   a press inside the panel never does.
 *
 * Every decision is a pure, unit-tested function in `modalStack.ts`; this
 * hook only wires them to the DOM, which has no unit-test runner here
 * (`docs/agent.md`).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, type MouseEvent, type RefObject } from 'react';

import {
  MODAL_FOCUS_FALLBACK_ID,
  focusableWithin,
  isTopModalLayer,
  modalKeyAction,
  nextFocusIndex,
  pushModalLayer,
  removeModalLayer,
  shouldCloseOnScrimClick,
  shouldRestoreFocusOnClose,
} from './modalStack';

export interface UseModalLayerOptions {
  open: boolean;
  onClose: () => void;
  /** The dialog element. Give it `tabIndex={-1}` so it can hold focus when it has no focusable children. */
  containerRef: RefObject<HTMLElement | null>;
}

export interface ModalScrimProps {
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

/** Any focusable element — HTML or SVG (e.g. a focused `<svg>` edge or icon). */
type FocusableElement = Element & { focus: (options?: FocusOptions) => void };

function isFocusable(element: Element | null): element is FocusableElement {
  return element !== null && typeof (element as Partial<FocusableElement>).focus === 'function';
}

function restoreFocus(opener: FocusableElement | null): void {
  if (opener !== null && opener !== document.body && opener.isConnected) {
    opener.focus();
    return;
  }
  const fallback = document.getElementById(MODAL_FOCUS_FALLBACK_ID);
  if (fallback !== null) {
    fallback.focus();
    return;
  }
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

export function useModalLayer({ open, onClose, containerRef }: UseModalLayerOptions): ModalScrimProps {
  const id = useId();
  // Read at event time, so a parent re-creating `onClose` never re-registers
  // the layer (which would reorder the stack and re-capture the opener).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // A layout effect, so focus is inside the dialog before the browser paints
  // it — no keystroke can land on the map behind in between.
  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }
    const container = containerRef.current;
    const active = document.activeElement;
    // Never capture something already inside the dialog (e.g. a field an
    // autofocus-style ref callback focused during this same commit).
    const opener = isFocusable(active) && !(container?.contains(active) ?? false) ? active : null;
    pushModalLayer(id);

    if (container !== null && !container.contains(document.activeElement)) {
      const [first] = focusableWithin(container);
      (first ?? container).focus();
    }

    // Whether focus was last seen inside this layer. Tracked from `focusin`
    // alone: when the focused element is removed with the dialog, no event
    // moves it elsewhere, so the last answer ("inside") stands.
    let focusInside = container?.contains(document.activeElement) ?? false;
    const onFocusIn = (event: FocusEvent) => {
      const current = containerRef.current;
      focusInside = current !== null && event.target instanceof Node && current.contains(event.target);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const action = modalKeyAction({
        key: event.key,
        isTop: isTopModalLayer(id),
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      if (action === 'ignore') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action === 'close') {
        onCloseRef.current();
        return;
      }
      const current = containerRef.current;
      if (current === null) {
        return;
      }
      const items = focusableWithin(current);
      const focused = document.activeElement;
      const next = nextFocusIndex(
        focused instanceof HTMLElement ? items.indexOf(focused) : -1,
        items.length,
        event.shiftKey,
      );
      (items[next] ?? current).focus();
    };
    // Capture phase: runs before any window listener registered earlier in
    // the bubble phase, so nothing can act on (or preventDefault) the
    // top layer's Escape first.
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      const wasTop = isTopModalLayer(id);
      removeModalLayer(id);
      if (shouldRestoreFocusOnClose({ wasTop, focusInsideLayer: focusInside })) {
        restoreFocus(opener);
      }
    };
  }, [open, id, containerRef]);

  const pressStartedOnScrimRef = useRef(false);
  const onMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    pressStartedOnScrimRef.current = event.button === 0 && event.target === event.currentTarget;
  }, []);
  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const startedOnScrim = pressStartedOnScrimRef.current;
      pressStartedOnScrimRef.current = false;
      if (
        shouldCloseOnScrimClick({
          startedOnScrim,
          targetIsCurrentTarget: event.target === event.currentTarget,
          isTop: isTopModalLayer(id),
          button: event.button,
        })
      ) {
        onCloseRef.current();
      }
    },
    [id],
  );

  return { onMouseDown, onClick };
}
