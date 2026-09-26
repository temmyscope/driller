/**
 * P2-7 + P2-8: the modal-layer stack's ordering, and every decision
 * `useModalLayer` makes — key action, scrim click, focus restore, the
 * overlays' open predicates — plus the Tab-wrap arithmetic. The DOM wiring
 * itself (focus actually moving) is an owed in-app check — the runner is
 * `node --test` with no DOM (`docs/agent.md`).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { CodeMapNode } from '@driller/ipc-contracts';

import type { NodeDetailState, SourceViewState } from './CodeMap';
import {
  isTopModalLayer,
  modalKeyAction,
  nextFocusIndex,
  nodeDetailOverlayOpen,
  openModalLayers,
  pushModalLayer,
  removeModalLayer,
  shouldCloseOnScrimClick,
  shouldRestoreFocusOnClose,
  sourceOverlayOpen,
  type ModalKeyInput,
  type ScrimClickInput,
} from './modalStack';

afterEach(() => {
  for (const id of openModalLayers()) {
    removeModalLayer(id);
  }
});

describe('modal layer stack', () => {
  it('has no top layer when nothing is open', () => {
    assert.equal(isTopModalLayer('settings'), false);
    assert.deepEqual(openModalLayers(), []);
  });

  it('makes whichever layer opened last the top one', () => {
    pushModalLayer('node-detail');
    assert.equal(isTopModalLayer('node-detail'), true);
    pushModalLayer('source');
    assert.equal(isTopModalLayer('source'), true);
    assert.equal(isTopModalLayer('node-detail'), false);
    pushModalLayer('settings');
    assert.deepEqual(openModalLayers(), ['node-detail', 'source', 'settings']);
    assert.equal(isTopModalLayer('settings'), true);
  });

  it('hands the top back one layer at a time as layers close', () => {
    pushModalLayer('source');
    pushModalLayer('settings');
    removeModalLayer('settings');
    assert.equal(isTopModalLayer('source'), true);
    removeModalLayer('source');
    assert.equal(isTopModalLayer('source'), false);
    assert.deepEqual(openModalLayers(), []);
  });

  it('removes a non-top layer without disturbing the top', () => {
    pushModalLayer('node-detail');
    pushModalLayer('source');
    pushModalLayer('settings');
    removeModalLayer('source');
    assert.equal(isTopModalLayer('settings'), true);
    assert.deepEqual(openModalLayers(), ['node-detail', 'settings']);
    removeModalLayer('settings');
    assert.equal(isTopModalLayer('node-detail'), true);
  });

  it('ignores removing a layer that is not open', () => {
    pushModalLayer('source');
    removeModalLayer('settings');
    assert.deepEqual(openModalLayers(), ['source']);
  });

  it('moves a re-pushed layer to the top instead of duplicating it', () => {
    pushModalLayer('source');
    pushModalLayer('settings');
    pushModalLayer('source');
    assert.deepEqual(openModalLayers(), ['settings', 'source']);
    removeModalLayer('source');
    assert.equal(isTopModalLayer('settings'), true);
  });
});

describe('nextFocusIndex', () => {
  it('steps forward and wraps from the last element to the first', () => {
    assert.equal(nextFocusIndex(0, 3, false), 1);
    assert.equal(nextFocusIndex(1, 3, false), 2);
    assert.equal(nextFocusIndex(2, 3, false), 0);
  });

  it('steps back and wraps from the first element to the last', () => {
    assert.equal(nextFocusIndex(2, 3, true), 1);
    assert.equal(nextFocusIndex(1, 3, true), 0);
    assert.equal(nextFocusIndex(0, 3, true), 2);
  });

  it('enters at the first element forward, the last backward, when focus is outside', () => {
    assert.equal(nextFocusIndex(-1, 3, false), 0);
    assert.equal(nextFocusIndex(-1, 3, true), 2);
    assert.equal(nextFocusIndex(7, 3, false), 0);
  });

  it('returns -1 with nothing to focus', () => {
    assert.equal(nextFocusIndex(-1, 0, false), -1);
    assert.equal(nextFocusIndex(0, 0, true), -1);
  });

  it('stays on the only element with a count of 1', () => {
    assert.equal(nextFocusIndex(0, 1, false), 0);
    assert.equal(nextFocusIndex(0, 1, true), 0);
    assert.equal(nextFocusIndex(-1, 1, true), 0);
  });
});

const KEY_BASE: ModalKeyInput = {
  key: 'Escape',
  isTop: true,
  defaultPrevented: false,
  isComposing: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
};

describe('modalKeyAction', () => {
  it('closes the top layer on Escape', () => {
    assert.equal(modalKeyAction(KEY_BASE), 'close');
  });

  it('P2-7: ignores Escape and Tab on a layer that is not on top — one Escape closes one layer', () => {
    // Settings over the source viewer: both listeners see the same Escape.
    pushModalLayer('source');
    pushModalLayer('settings');
    const escapeFor = (id: string) => modalKeyAction({ ...KEY_BASE, isTop: isTopModalLayer(id) });
    assert.equal(escapeFor('settings'), 'close');
    assert.equal(escapeFor('source'), 'ignore');
    assert.equal(modalKeyAction({ ...KEY_BASE, key: 'Tab', isTop: false }), 'ignore');
    // Settings closes; the next Escape is the source viewer's.
    removeModalLayer('settings');
    assert.equal(escapeFor('source'), 'close');
  });

  it('ignores Escape during IME composition', () => {
    assert.equal(modalKeyAction({ ...KEY_BASE, isComposing: true }), 'ignore');
  });

  it('ignores a key something else already handled', () => {
    assert.equal(modalKeyAction({ ...KEY_BASE, defaultPrevented: true }), 'ignore');
  });

  it('traps Tab, with or without Shift (Shift is not a modifier here)', () => {
    assert.equal(modalKeyAction({ ...KEY_BASE, key: 'Tab' }), 'trap');
  });

  it('leaves Tab with Ctrl, Alt or Meta alone', () => {
    assert.equal(modalKeyAction({ ...KEY_BASE, key: 'Tab', ctrlKey: true }), 'ignore');
    assert.equal(modalKeyAction({ ...KEY_BASE, key: 'Tab', altKey: true }), 'ignore');
    assert.equal(modalKeyAction({ ...KEY_BASE, key: 'Tab', metaKey: true }), 'ignore');
  });

  it('ignores every other key', () => {
    assert.equal(modalKeyAction({ ...KEY_BASE, key: 'Enter' }), 'ignore');
    assert.equal(modalKeyAction({ ...KEY_BASE, key: 'a' }), 'ignore');
  });
});

const SCRIM_BASE: ScrimClickInput = { startedOnScrim: true, targetIsCurrentTarget: true, isTop: true, button: 0 };

describe('shouldCloseOnScrimClick', () => {
  it('closes on a primary press that starts and ends on the scrim of the top layer', () => {
    assert.equal(shouldCloseOnScrimClick(SCRIM_BASE), true);
  });

  it('stays open for a click inside the panel', () => {
    assert.equal(shouldCloseOnScrimClick({ ...SCRIM_BASE, targetIsCurrentTarget: false }), false);
  });

  it('stays open when the press started in the panel and was released on the scrim', () => {
    assert.equal(shouldCloseOnScrimClick({ ...SCRIM_BASE, startedOnScrim: false }), false);
  });

  it('stays open for a non-primary button', () => {
    assert.equal(shouldCloseOnScrimClick({ ...SCRIM_BASE, button: 1 }), false);
    assert.equal(shouldCloseOnScrimClick({ ...SCRIM_BASE, button: 2 }), false);
  });

  it('stays open when the layer is not on top', () => {
    assert.equal(shouldCloseOnScrimClick({ ...SCRIM_BASE, isTop: false }), false);
  });
});

describe('shouldRestoreFocusOnClose', () => {
  it('restores when the top layer closes', () => {
    assert.equal(shouldRestoreFocusOnClose({ wasTop: true, focusInsideLayer: true }), true);
    assert.equal(shouldRestoreFocusOnClose({ wasTop: true, focusInsideLayer: false }), true);
  });

  it('restores when a lower layer closes while holding focus', () => {
    assert.equal(shouldRestoreFocusOnClose({ wasTop: false, focusInsideLayer: true }), true);
  });

  it('leaves focus alone when a lower layer closes in code under the top dialog', () => {
    // E.g. a refresh closing Node Detail under Settings.
    assert.equal(shouldRestoreFocusOnClose({ wasTop: false, focusInsideLayer: false }), false);
  });
});

describe('overlay open predicates', () => {
  const node = { id: 'n' } as unknown as CodeMapNode;

  it('sourceOverlayOpen: open in every state but closed', () => {
    const cases = {
      closed: false,
      loading: true,
      open: true,
      error: true,
    } satisfies Record<SourceViewState['status'], boolean>;
    const states: Record<SourceViewState['status'], SourceViewState> = {
      closed: { status: 'closed' },
      loading: { status: 'loading', node },
      open: { status: 'open', node, content: '' },
      error: { status: 'error', node, message: 'x' },
    };
    for (const [status, expected] of Object.entries(cases) as [SourceViewState['status'], boolean][]) {
      assert.equal(sourceOverlayOpen(states[status]), expected, status);
    }
  });

  it('nodeDetailOverlayOpen: open only when open', () => {
    const cases = { closed: false, open: true } satisfies Record<NodeDetailState['status'], boolean>;
    const states: Record<NodeDetailState['status'], NodeDetailState> = {
      closed: { status: 'closed' },
      open: { status: 'open', node },
    };
    for (const [status, expected] of Object.entries(cases) as [NodeDetailState['status'], boolean][]) {
      assert.equal(nodeDetailOverlayOpen(states[status]), expected, status);
    }
  });
});
