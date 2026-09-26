/**
 * P2-9: zoom moves one fixed step at a time within 80–200%, snaps an
 * off-step value first, and a corrupt stored value falls back to 100%.
 * The menu carries Open Folder… (Cmd/Ctrl+O) and the zoom accelerators.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MenuItemConstructorOptions } from 'electron';

import {
  buildAppMenu,
  nextZoomFactor,
  parseStoredZoomFactor,
  ZOOM_STEPS,
  zoomDirectionForInput,
  type ZoomDirection,
  type ZoomKeyInput,
} from './app-menu';

describe('nextZoomFactor', () => {
  it('steps in three times from 100% to 110, 125, 150%', () => {
    let zoom = 1;
    const seen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      zoom = nextZoomFactor(zoom, 'in');
      seen.push(zoom);
    }
    assert.deepEqual(seen, [1.1, 1.25, 1.5]);
  });

  it('steps out one step', () => {
    assert.equal(nextZoomFactor(1, 'out'), 0.9);
    assert.equal(nextZoomFactor(1.5, 'out'), 1.25);
  });

  it('clamps at 80% when zooming out at the floor', () => {
    assert.equal(nextZoomFactor(0.8, 'out'), 0.8);
  });

  it('clamps at 200% when zooming in at the ceiling', () => {
    assert.equal(nextZoomFactor(2, 'in'), 2);
  });

  it('resets to 100% from any value', () => {
    for (const value of [0.8, 1.25, 2, 1.33, Number.NaN]) {
      assert.equal(nextZoomFactor(value, 'reset'), 1);
    }
  });

  it('snaps an off-step value to the nearest step before moving', () => {
    assert.equal(nextZoomFactor(1.3, 'in'), 1.5); // 1.3 → 1.25 → 1.5
    assert.equal(nextZoomFactor(1.3, 'out'), 1.1); // 1.3 → 1.25 → 1.1
    assert.equal(nextZoomFactor(1.1000000001, 'in'), 1.25);
  });

  it('snaps out-of-range values to the nearest end, then clamps', () => {
    assert.equal(nextZoomFactor(0.3, 'out'), 0.8);
    assert.equal(nextZoomFactor(0.3, 'in'), 0.9);
    assert.equal(nextZoomFactor(7, 'in'), 2);
    assert.equal(nextZoomFactor(7, 'out'), 1.75);
  });

  it('treats a non-finite current value as 100%', () => {
    assert.equal(nextZoomFactor(Number.NaN, 'in'), 1.1);
  });

  it('always returns a step', () => {
    const directions: ZoomDirection[] = ['in', 'out', 'reset'];
    for (const value of [...ZOOM_STEPS, 0.85, 1.05, 1.6, 0, 3]) {
      for (const direction of directions) {
        assert.ok(ZOOM_STEPS.includes(nextZoomFactor(value, direction)));
      }
    }
  });
});

describe('parseStoredZoomFactor', () => {
  it('accepts every step as-is', () => {
    for (const step of ZOOM_STEPS) {
      assert.equal(parseStoredZoomFactor(step), step);
    }
  });

  it('snaps an in-range off-step number', () => {
    assert.equal(parseStoredZoomFactor(1.3), 1.25);
  });

  it('snaps float drift within 1e-6 of a bound to that bound', () => {
    assert.equal(parseStoredZoomFactor(0.7999999999), 0.8);
    assert.equal(parseStoredZoomFactor(2.0000000001), 2);
    assert.equal(parseStoredZoomFactor(2.00001), null);
  });

  it('rejects a non-number, a non-finite number and an out-of-range number', () => {
    for (const value of ['abc', '1.25', 7, 0.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) {
      assert.equal(parseStoredZoomFactor(value), null);
    }
  });
});

function findItem(
  template: MenuItemConstructorOptions[],
  predicate: (item: MenuItemConstructorOptions) => boolean,
): MenuItemConstructorOptions | undefined {
  for (const item of template) {
    if (predicate(item)) {
      return item;
    }
    if (Array.isArray(item.submenu)) {
      const found = findItem(item.submenu, predicate);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

describe('buildAppMenu', () => {
  const calls: string[] = [];
  const handlers = {
    onOpenFolder: () => calls.push('open'),
    onZoom: (direction: ZoomDirection) => calls.push(`zoom:${direction}`),
  };

  it('wires Open Folder… to Cmd/Ctrl+O and the zoom accelerators to their directions', () => {
    const template = buildAppMenu(handlers, { platform: 'darwin', isPackaged: true });
    const byAccelerator = (accelerator: string) =>
      findItem(template, (item) => item.accelerator === accelerator);

    calls.length = 0;
    for (const accelerator of ['CmdOrCtrl+O', 'CmdOrCtrl+=', 'CmdOrCtrl+-', 'CmdOrCtrl+0']) {
      const item = byAccelerator(accelerator);
      assert.ok(item, accelerator);
      (item.click as () => void)();
    }
    assert.deepEqual(calls, ['open', 'zoom:in', 'zoom:out', 'zoom:reset']);
  });

  it('has no hidden items (their accelerators do not fire on Windows/Linux)', () => {
    const template = buildAppMenu(handlers, { platform: 'win32', isPackaged: false });
    assert.equal(findItem(template, (item) => item.visible === false), undefined);
  });

  it('puts Quit in File on Windows/Linux only', () => {
    const fileHasQuit = (platform: NodeJS.Platform) => {
      const file = buildAppMenu(handlers, { platform, isPackaged: true }).find((item) => item.label === 'File');
      return (file?.submenu as MenuItemConstructorOptions[]).some((item) => item.role === 'quit');
    };
    assert.equal(fileHasQuit('win32'), true);
    assert.equal(fileHasQuit('linux'), true);
    assert.equal(fileHasQuit('darwin'), false);
  });

  it('offers Toggle Full Screen in View in every build', () => {
    for (const isPackaged of [true, false]) {
      const view = buildAppMenu(handlers, { platform: 'darwin', isPackaged }).find((item) => item.label === 'View');
      assert.ok((view?.submenu as MenuItemConstructorOptions[]).some((item) => item.role === 'togglefullscreen'));
    }
  });

  it('offers Reload and Force Reload only in unpackaged builds', () => {
    const roles = (isPackaged: boolean) => {
      const view = buildAppMenu(handlers, { platform: 'darwin', isPackaged }).find((item) => item.label === 'View');
      return (view?.submenu as MenuItemConstructorOptions[]).map((item) => item.role);
    };
    assert.ok(roles(false).includes('reload'));
    assert.ok(roles(false).includes('forceReload'));
    assert.equal(roles(true).includes('reload'), false);
    assert.equal(roles(true).includes('forceReload'), false);
  });

  it('includes the macOS app menu only on macOS', () => {
    const hasAppMenu = (platform: NodeJS.Platform) =>
      findItem(buildAppMenu(handlers, { platform, isPackaged: true }), (item) => item.role === 'appMenu') !== undefined;
    assert.equal(hasAppMenu('darwin'), true);
    assert.equal(hasAppMenu('win32'), false);
  });

  it('keeps Edit and Window as standard roles', () => {
    const template = buildAppMenu(handlers, { platform: 'linux', isPackaged: true });
    assert.ok(findItem(template, (item) => item.role === 'editMenu'));
    assert.ok(findItem(template, (item) => item.role === 'windowMenu'));
  });

  it('offers Toggle DevTools only in unpackaged builds', () => {
    const hasDevTools = (isPackaged: boolean) =>
      findItem(buildAppMenu(handlers, { platform: 'darwin', isPackaged }), (item) => item.role === 'toggleDevTools') !==
      undefined;
    assert.equal(hasDevTools(false), true);
    assert.equal(hasDevTools(true), false);
  });
});

describe('zoomDirectionForInput', () => {
  const key = (overrides: Partial<ZoomKeyInput>): ZoomKeyInput => ({
    type: 'keyDown',
    key: '',
    code: '',
    control: false,
    meta: false,
    alt: false,
    ...overrides,
  });

  it('maps Cmd+Plus on macOS and Ctrl+Plus elsewhere to zoom in', () => {
    assert.equal(zoomDirectionForInput(key({ key: '+', code: 'Equal', meta: true }), 'darwin'), 'in');
    assert.equal(zoomDirectionForInput(key({ key: '+', code: 'Equal', control: true }), 'win32'), 'in');
    assert.equal(zoomDirectionForInput(key({ key: '+', code: 'Equal', control: true }), 'linux'), 'in');
  });

  it('maps the numpad add, subtract and 0 keys', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const mod = platform === 'darwin' ? { meta: true } : { control: true };
      assert.equal(zoomDirectionForInput(key({ key: '+', code: 'NumpadAdd', ...mod }), platform), 'in');
      assert.equal(zoomDirectionForInput(key({ key: '-', code: 'NumpadSubtract', ...mod }), platform), 'out');
      assert.equal(zoomDirectionForInput(key({ key: '0', code: 'Numpad0', ...mod }), platform), 'reset');
    }
  });

  it('leaves the keys the menu accelerators already handle alone', () => {
    assert.equal(zoomDirectionForInput(key({ key: '=', code: 'Equal', meta: true }), 'darwin'), null);
    assert.equal(zoomDirectionForInput(key({ key: '-', code: 'Minus', meta: true }), 'darwin'), null);
    assert.equal(zoomDirectionForInput(key({ key: '0', code: 'Digit0', meta: true }), 'darwin'), null);
  });

  it('ignores the wrong modifier, Alt, a missing modifier and key-up', () => {
    assert.equal(zoomDirectionForInput(key({ key: '+', code: 'NumpadAdd', control: true }), 'darwin'), null);
    assert.equal(zoomDirectionForInput(key({ key: '+', code: 'NumpadAdd', meta: true }), 'win32'), null);
    assert.equal(zoomDirectionForInput(key({ key: '+', code: 'NumpadAdd', meta: true, alt: true }), 'darwin'), null);
    assert.equal(zoomDirectionForInput(key({ key: '+', code: 'NumpadAdd' }), 'darwin'), null);
    assert.equal(zoomDirectionForInput(key({ type: 'keyUp', key: '+', code: 'NumpadAdd', meta: true }), 'darwin'), null);
  });
});
