/**
 * P3-5 + P3-6: the backend group — a failed switch whose action re-attempts
 * that same switch, the pure outcome of each settled switch attempt, and
 * "Cloud selected, no key" stated where the key is entered. Rendered
 * hooklessly (`testRender`), since the runner is `node --test` with no DOM.
 *
 * What this cannot reach: `Settings`' own hook wiring (the IPC promises
 * feeding `backendSwitchOutcome`, focus moving to the checked radio after a
 * retry) — owed in-app checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BackendConfig, CloudBackend } from '@driller/ipc-contracts';

import {
  BACKEND_CHOICES,
  BackendConfigNotices,
  BackendRadios,
  CLOUD_NO_KEY_NOTICE_ID,
  CLOUD_NO_KEY_NOTICE_TEXT,
  CloudKeyBlock,
  backendLabel,
  backendSwitchErrorText,
  backendSwitchOutcome,
  ipcErrorMessage,
  showCloudNoKeyNotice,
  stripIpcErrorPrefix,
  type BackendConfigNoticesProps,
  type BackendSwitchSettle,
} from './Settings';
import { renderTree, textOf, type RenderedElement } from './testRender';

function config(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return { activeBackend: 'cloud', hasCloudKey: false, isLinuxInsecureBackend: false, ...overrides };
}

const noop = () => {};

function render(overrides: Partial<BackendConfigNoticesProps> = {}) {
  const props: BackendConfigNoticesProps = {
    config: config({ activeBackend: 'local' }),
    pendingBackend: null,
    switchError: null,
    onRetrySwitch: noop,
    onDismissSwitchError: noop,
    ...overrides,
  };
  return renderTree(BackendConfigNotices(props));
}

function classes(element: RenderedElement): string[] {
  return typeof element.props.className === 'string' ? element.props.className.split(/\s+/) : [];
}

/** Every `ActionableNotice` root, found by its root class. */
function notices(elements: RenderedElement[]): RenderedElement[] {
  return elements.filter((element) => classes(element).includes('actionable-notice'));
}

function buttons(element: RenderedElement): RenderedElement[] {
  return renderTree(element).filter((child) => child.type === 'button');
}

function only<T>(items: T[]): T {
  assert.equal(items.length, 1);
  const [item] = items;
  assert.ok(item !== undefined);
  return item;
}

describe('backendLabel', () => {
  it('names every backend, and the radios read "<name> (<detail>)"', () => {
    assert.deepEqual(BACKEND_CHOICES, ['local', 'cloud']);
    assert.deepEqual(backendLabel('local'), { name: 'Local model', detail: 'on-device' });
    assert.deepEqual(backendLabel('cloud'), { name: 'Cloud', detail: 'bring your own key' });
  });
});

describe('stripIpcErrorPrefix / ipcErrorMessage', () => {
  it("strips Electron's remote-method wrapper and the inner error's name", () => {
    assert.equal(
      stripIpcErrorPrefix("Error invoking remote method 'backend:setActive': Error: store write failed"),
      'store write failed',
    );
    assert.equal(stripIpcErrorPrefix("Error invoking remote method 'x': TypeError: bad"), 'bad');
    assert.equal(stripIpcErrorPrefix("Error invoking remote method 'x': plain"), 'plain');
  });

  it('leaves any other message unchanged', () => {
    assert.equal(stripIpcErrorPrefix('Error: kept'), 'Error: kept');
    assert.equal(stripIpcErrorPrefix('disk full'), 'disk full');
  });

  it('reads Errors, other values, and nothing', () => {
    assert.equal(ipcErrorMessage(new Error("Error invoking remote method 'x': Error: boom")), 'boom');
    assert.equal(ipcErrorMessage('raw'), 'raw');
    assert.equal(ipcErrorMessage(undefined), '');
    assert.equal(ipcErrorMessage(null), '');
  });
});

describe('backendSwitchErrorText', () => {
  it('names the backend it tried to switch to, then the message', () => {
    assert.equal(backendSwitchErrorText('cloud', 'store write failed'), "Couldn't switch to Cloud: store write failed");
    assert.equal(backendSwitchErrorText('local', 'boom'), "Couldn't switch to Local model: boom");
  });

  it('reads "unknown error" for an empty or missing message', () => {
    assert.equal(backendSwitchErrorText('cloud', ''), "Couldn't switch to Cloud: unknown error");
    assert.equal(backendSwitchErrorText('cloud', '   '), "Couldn't switch to Cloud: unknown error");
    assert.equal(backendSwitchErrorText('local', undefined), "Couldn't switch to Local model: unknown error");
    assert.equal(backendSwitchErrorText('local', null), "Couldn't switch to Local model: unknown error");
  });

  it('strips the IPC wrapper itself', () => {
    assert.equal(
      backendSwitchErrorText('cloud', "Error invoking remote method 'x': Error: nope"),
      "Couldn't switch to Cloud: nope",
    );
  });
});

describe('backendSwitchOutcome', () => {
  const settle = (overrides: Partial<BackendSwitchSettle>): BackendSwitchSettle => ({
    attemptId: 3,
    latestAttemptId: 3,
    phase: 'saved',
    backend: 'cloud',
    ...overrides,
  });

  it('confirms a saved switch', () => {
    assert.deepEqual(backendSwitchOutcome(settle({ phase: 'saved' })), { kind: 'confirmed' });
  });

  it('turns a rejected save into a switch error with rollback, never a load error', () => {
    assert.deepEqual(backendSwitchOutcome(settle({ phase: 'save-failed', message: 'store write failed' })), {
      kind: 'switch-error',
      switchError: { backend: 'cloud', message: 'store write failed' },
      rollback: true,
    });
    assert.deepEqual(backendSwitchOutcome(settle({ phase: 'save-failed', backend: 'local' })), {
      kind: 'switch-error',
      switchError: { backend: 'local', message: '' },
      rollback: true,
    });
  });

  it('turns a failed re-read after a successful save into a load error, with no rollback', () => {
    assert.deepEqual(backendSwitchOutcome(settle({ phase: 'refresh-failed', message: 'read failed' })), {
      kind: 'load-error',
      message: 'read failed',
      rollback: false,
    });
    assert.deepEqual(backendSwitchOutcome(settle({ phase: 'refresh-failed', message: '' })), {
      kind: 'load-error',
      message: 'unknown error',
      rollback: false,
    });
  });

  it('ignores every phase of a stale attempt', () => {
    for (const phase of ['saved', 'save-failed', 'refresh-failed'] as const) {
      assert.deepEqual(
        backendSwitchOutcome(settle({ attemptId: 2, latestAttemptId: 3, phase, message: 'x' })),
        { kind: 'ignore' },
        phase,
      );
    }
  });
});

describe('showCloudNoKeyNotice', () => {
  it('is true only when the confirmed config has Cloud active and no key stored', () => {
    assert.equal(showCloudNoKeyNotice(config({ activeBackend: 'cloud', hasCloudKey: false })), true);
    assert.equal(showCloudNoKeyNotice(config({ activeBackend: 'cloud', hasCloudKey: true })), false);
    assert.equal(showCloudNoKeyNotice(config({ activeBackend: 'local', hasCloudKey: false })), false);
    assert.equal(showCloudNoKeyNotice(config({ activeBackend: 'local', hasCloudKey: true })), false);
  });

  it('is false while a switch is in flight, whatever its target', () => {
    assert.equal(showCloudNoKeyNotice(config({ activeBackend: 'local' }), 'cloud'), false);
    assert.equal(showCloudNoKeyNotice(config({ activeBackend: 'cloud' }), 'local'), false);
  });
});

describe('BackendRadios', () => {
  it('labels, checks, disables and wires each radio', () => {
    const changed: CloudBackend[] = [];
    const elements = renderTree(
      BackendRadios({ selected: 'cloud', disabled: true, onChange: (backend) => changed.push(backend) }),
    );
    const labels = elements.filter((element) => element.type === 'label');
    assert.deepEqual(labels.map(textOf), ['Local model (on-device)', 'Cloud (bring your own key)']);
    const inputs = elements.filter((element) => element.type === 'input');
    assert.deepEqual(
      inputs.map((input) => [input.props.value, input.props.checked, input.props.disabled]),
      [
        ['local', false, true],
        ['cloud', true, true],
      ],
    );
    for (const input of inputs) {
      (input.props.onChange as () => void)();
    }
    assert.deepEqual(changed, ['local', 'cloud']);

    const enabled = renderTree(BackendRadios({ selected: 'local', disabled: false, onChange: noop }));
    assert.ok(enabled.filter((element) => element.type === 'input').every((input) => input.props.disabled === false));
  });
});

describe('BackendConfigNotices', () => {
  it('renders nothing with no switch error and a usable backend', () => {
    assert.deepEqual(render(), []);
    assert.deepEqual(render({ config: config({ activeBackend: 'cloud', hasCloudKey: true }) }), []);
  });

  it('shows the Cloud-no-key warning as a status with no action, under the id the key input names', () => {
    const elements = render({ config: config({ activeBackend: 'cloud', hasCloudKey: false }) });
    const notice = only(notices(elements));
    assert.ok(classes(notice).includes('actionable-notice--warning'));
    assert.equal(notice.props.role, 'status');
    assert.ok(textOf(notice).includes(CLOUD_NO_KEY_NOTICE_TEXT));
    assert.equal(
      CLOUD_NO_KEY_NOTICE_TEXT,
      'Cloud is selected but no API key is saved — summaries are paused until you add one.',
    );
    assert.deepEqual(buttons(notice), [], 'no action: the key field sits directly below');
    const wrapper = elements.find((element) => element.props.id === CLOUD_NO_KEY_NOTICE_ID);
    assert.ok(wrapper, 'the described-by id is rendered');
    assert.equal(notices(renderTree(wrapper)).length, 1, 'the notice sits inside the described-by id');
    assert.ok(textOf(wrapper).includes(CLOUD_NO_KEY_NOTICE_TEXT));
  });

  it('does not show the Cloud-no-key warning on an in-flight switch to Cloud', () => {
    assert.deepEqual(render({ config: config({ activeBackend: 'local' }), pendingBackend: 'cloud' }), []);
  });

  it('shows a failed switch as an alert whose Retry re-attempts that same switch', () => {
    const retried: CloudBackend[] = [];
    const elements = render({
      switchError: { backend: 'cloud', message: 'store write failed' },
      onRetrySwitch: (backend) => retried.push(backend),
    });
    const notice = only(notices(elements));
    assert.ok(classes(notice).includes('actionable-notice--error'));
    assert.equal(notice.props.role, 'alert');
    assert.ok(textOf(notice).includes("Couldn't switch to Cloud: store write failed"));

    const [retry] = buttons(notice);
    assert.ok(retry);
    assert.equal(textOf(retry), 'Retry the switch');
    assert.equal(retry.props.disabled, false);
    (retry.props.onClick as () => void)();
    assert.deepEqual(retried, ['cloud'], 'retries the recorded backend, not a config re-read');
  });

  it('reads "unknown error" for a failed switch with no message', () => {
    const notice = only(notices(render({ switchError: { backend: 'cloud', message: '' } })));
    assert.ok(textOf(notice).includes("Couldn't switch to Cloud: unknown error"));
  });

  it('retries a failed switch to Local with Local', () => {
    const retried: CloudBackend[] = [];
    const elements = render({
      config: config({ activeBackend: 'cloud', hasCloudKey: true }),
      switchError: { backend: 'local', message: 'boom' },
      onRetrySwitch: (backend) => retried.push(backend),
    });
    const [retry] = buttons(only(notices(elements)));
    assert.ok(retry);
    (retry.props.onClick as () => void)();
    assert.deepEqual(retried, ['local']);
  });

  it('disables Retry and reads "Retrying…" while an attempt is in flight', () => {
    const elements = render({ pendingBackend: 'cloud', switchError: { backend: 'cloud', message: 'boom' } });
    const [retry] = buttons(only(notices(elements)));
    assert.ok(retry);
    assert.equal(textOf(retry), 'Retrying…');
    assert.equal(retry.props.disabled, true);
  });

  it('has an × close control named "Dismiss" wired to onDismissSwitchError', () => {
    const onDismissSwitchError = () => {};
    const notice = only(notices(render({ switchError: { backend: 'cloud', message: 'x' }, onDismissSwitchError })));
    const dismiss = buttons(notice).find((button) => button.props['aria-label'] === 'Dismiss');
    assert.ok(dismiss);
    assert.equal(textOf(dismiss), '×');
    assert.equal(dismiss.props.onClick, onDismissSwitchError);
  });

  it('hides a switch error once the confirmed backend is the one it failed to reach', () => {
    assert.deepEqual(
      render({ config: config({ activeBackend: 'cloud', hasCloudKey: true }), switchError: { backend: 'cloud', message: 'x' } }),
      [],
    );
  });

  it('shows the switch error first, then the Cloud-no-key warning', () => {
    const shown = notices(
      render({
        config: config({ activeBackend: 'cloud', hasCloudKey: false }),
        switchError: { backend: 'local', message: 'boom' },
      }),
    );
    assert.deepEqual(
      shown.map((notice) => [notice.props.role, classes(notice).find((name) => name.startsWith('actionable-notice--'))]),
      [
        ['alert', 'actionable-notice--error'],
        ['status', 'actionable-notice--warning'],
      ],
    );
  });
});

describe('CloudKeyBlock: no-key link', () => {
  it('points the key input at the no-key notice only when told to', () => {
    const props = {
      config: config(),
      keyEntry: { kind: 'idle' } as const,
      keyInput: '',
      removingKey: false,
      keyRemovedNotice: null,
      keyRemoveError: null,
      onKeyInputChange: noop,
      onSaveKey: noop,
      onRemoveKey: noop,
      onAcknowledgeInsecureStorage: noop,
    };
    const linked = renderTree(CloudKeyBlock({ ...props, keyInputDescribedBy: CLOUD_NO_KEY_NOTICE_ID })).find(
      (element) => element.type === 'input',
    );
    assert.equal(linked?.props['aria-describedby'], CLOUD_NO_KEY_NOTICE_ID);
    const unlinked = renderTree(CloudKeyBlock(props)).find((element) => element.type === 'input');
    assert.equal(unlinked?.props['aria-describedby'], undefined);
  });
});
