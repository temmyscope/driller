/**
 * P2-11: the re-nested Settings wiring — the extracted, hookless
 * `SettingsTitlebar` and `CloudKeyBlock` — rendered by calling them and
 * walking the returned elements (the `renderTree` approach of
 * `ModeSwitcher.test.ts`, since the runner is `node --test` with no DOM).
 *
 * Pins: the key input's accessible name, the Save / Remove / Store anyway
 * `disabled` guards and handler identity, and the close button's name and
 * `onClick`. What this cannot reach: the modal layout itself, focus
 * trapping and Escape (`modalStack.test.ts`), and a screen reader actually
 * announcing the names — owed in-app checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BackendConfig } from '@driller/ipc-contracts';

import { CloudKeyBlock, SettingsTitlebar, type CloudKeyBlockProps, type KeyEntryState } from './Settings';
import { renderTree, textOf, type RenderedElement } from './testRender';

function buttonNamed(elements: RenderedElement[], name: string): RenderedElement | undefined {
  return elements.find((element) => element.type === 'button' && textOf(element) === name);
}

const noop = () => {};

function config(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return { activeBackend: 'cloud', hasCloudKey: false, isLinuxInsecureBackend: false, ...overrides };
}

function renderKeyBlock(overrides: Partial<CloudKeyBlockProps> = {}) {
  const props: CloudKeyBlockProps = {
    config: config(),
    keyEntry: { kind: 'idle' },
    keyInput: '',
    removingKey: false,
    keyRemovedNotice: null,
    keyRemoveError: null,
    onKeyInputChange: noop,
    onSaveKey: noop,
    onRemoveKey: noop,
    onAcknowledgeInsecureStorage: noop,
    ...overrides,
  };
  return renderTree(CloudKeyBlock(props));
}

describe('SettingsTitlebar', () => {
  it('names the close button with its visible text plus a hidden " settings" and wires onClose', () => {
    const onClose = () => {};
    const elements = renderTree(SettingsTitlebar({ onClose }));
    const title = elements.find((element) => element.type === 'h2');
    assert.equal(textOf(title), 'Settings');

    const close = elements.find((element) => element.type === 'button');
    assert.ok(close, 'the close button renders');
    assert.equal(close.props['aria-label'], undefined, 'no aria-label replacing the visible text');
    assert.equal(textOf(close), '[esc] close settings');
    const hidden = renderTree(close.props.children).find((element) => element.props.className === 'visually-hidden');
    assert.ok(hidden, 'the " settings" suffix is visually hidden');
    assert.equal(textOf(hidden), ' settings');
    assert.equal(close.props.onClick, onClose);
  });
});

describe('CloudKeyBlock: key input', () => {
  it('is named "API key" by a visible label wrapping it, and wired to onKeyInputChange', () => {
    const onKeyInputChange = () => {};
    const elements = renderKeyBlock({ onKeyInputChange });
    const input = elements.find((element) => element.type === 'input');
    assert.ok(input);
    assert.equal(input.props.type, 'password');
    assert.equal(input.props['aria-label'], undefined);
    assert.equal(input.props['aria-labelledby'], undefined);
    assert.equal(input.props.onChange, onKeyInputChange);

    const label = elements.find(
      (element) => element.type === 'label' && renderTree(element.props.children).includes(input),
    );
    assert.ok(label, 'a <label> wraps the input');
    assert.equal(textOf(label), 'API key');
    const visibleText = renderTree(label.props.children).find(
      (element) => element.props.className === 'settings-panel__field-text',
    );
    assert.ok(visibleText, 'the label text is visible, not visually hidden');
  });

  it('is disabled only while a removal is in flight', () => {
    const input = (removingKey: boolean) => renderKeyBlock({ removingKey }).find((element) => element.type === 'input');
    assert.equal(input(false)?.props.disabled, false);
    assert.equal(input(true)?.props.disabled, true);
  });
});

describe('CloudKeyBlock: Save key', () => {
  const cases: Array<{ keyEntry: KeyEntryState; removingKey: boolean; disabled: boolean }> = [
    { keyEntry: { kind: 'idle' }, removingKey: false, disabled: false },
    { keyEntry: { kind: 'idle' }, removingKey: true, disabled: true },
    { keyEntry: { kind: 'saving' }, removingKey: false, disabled: true },
    { keyEntry: { kind: 'error', message: 'x' }, removingKey: true, disabled: true },
  ];
  for (const { keyEntry, removingKey, disabled } of cases) {
    it(`is ${disabled ? 'disabled' : 'enabled'} when ${keyEntry.kind}, removingKey=${removingKey}`, () => {
      const elements = renderKeyBlock({ keyEntry, removingKey });
      const save = buttonNamed(elements, keyEntry.kind === 'saving' ? 'Saving…' : 'Save key');
      assert.ok(save);
      assert.equal(save.props.disabled, disabled);
    });
  }

  it('calls onSaveKey and is the primary action', () => {
    const onSaveKey = () => {};
    const save = buttonNamed(renderKeyBlock({ onSaveKey }), 'Save key');
    assert.ok(save);
    assert.equal(save.props.onClick, onSaveKey);
    assert.equal(save.props.className, 'settings-panel__action settings-panel__action--primary');
  });
});

describe('CloudKeyBlock: Remove saved key', () => {
  const saved = config({ hasCloudKey: true });

  it('shows beside "Key saved" only with a saved key, an empty input and no warning', () => {
    assert.ok(buttonNamed(renderKeyBlock({ config: saved }), 'Remove saved key'));
    assert.equal(buttonNamed(renderKeyBlock(), 'Remove saved key'), undefined);
    assert.equal(buttonNamed(renderKeyBlock({ config: saved, keyInput: 'sk' }), 'Remove saved key'), undefined);
    assert.equal(
      buttonNamed(
        renderKeyBlock({ config: saved, keyEntry: { kind: 'warning', message: 'w', pendingKey: 'k' } }),
        'Remove saved key',
      ),
      undefined,
    );
  });

  it('is disabled while removing or saving, and calls onRemoveKey', () => {
    const onRemoveKey = () => {};
    const idle = buttonNamed(renderKeyBlock({ config: saved, onRemoveKey }), 'Remove saved key');
    assert.ok(idle);
    assert.equal(idle.props.disabled, false);
    assert.equal(idle.props.onClick, onRemoveKey);
    assert.equal(idle.props.className, 'settings-panel__action', 'the muted outline, not the primary');

    const removing = buttonNamed(renderKeyBlock({ config: saved, removingKey: true }), 'Removing…');
    assert.ok(removing);
    assert.equal(removing.props.disabled, true);

    const saving = buttonNamed(renderKeyBlock({ config: saved, keyEntry: { kind: 'saving' } }), 'Remove saved key');
    assert.ok(saving);
    assert.equal(saving.props.disabled, true);
  });
});

describe('CloudKeyBlock: Store anyway', () => {
  const warning: KeyEntryState = { kind: 'warning', message: 'No secure keystore.', pendingKey: 'sk-1' };

  it('appears only on the insecure-storage warning and calls onAcknowledgeInsecureStorage', () => {
    const onAcknowledgeInsecureStorage = () => {};
    assert.equal(buttonNamed(renderKeyBlock(), 'Store anyway'), undefined);
    const store = buttonNamed(renderKeyBlock({ keyEntry: warning, onAcknowledgeInsecureStorage }), 'Store anyway');
    assert.ok(store);
    assert.equal(store.props.onClick, onAcknowledgeInsecureStorage);
    assert.equal(store.props.disabled, false);
  });

  it('is disabled while a removal is in flight', () => {
    const store = buttonNamed(renderKeyBlock({ keyEntry: warning, removingKey: true }), 'Store anyway');
    assert.ok(store);
    assert.equal(store.props.disabled, true);
  });
});
