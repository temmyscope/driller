/**
 * P5-g (founder 5.3): the main window opens at 1100×720 with a 640×480
 * minimum, and its AD-11 webPreferences are unchanged.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAIN_WINDOW_DEFAULT_SIZE, MAIN_WINDOW_MIN_SIZE, mainWindowOptions } from './window-options';

const base = { iconPath: '/dev/icon.png', platform: 'linux' as const, preloadPath: '/app/preload.js', zoomFactor: 1.25 };

describe('mainWindowOptions', () => {
  it('a 640×480 minimum, no larger than the 1100×720 default', () => {
    const options = mainWindowOptions(base);
    assert.equal(options.minWidth, 640);
    assert.equal(options.minHeight, 480);
    assert.deepEqual(MAIN_WINDOW_MIN_SIZE, { width: 640, height: 480 });
    assert.equal(options.width, 1100);
    assert.equal(options.height, 720);
    assert.deepEqual(MAIN_WINDOW_DEFAULT_SIZE, { width: 1100, height: 720 });
    assert.ok(options.minWidth! <= options.width! && options.minHeight! <= options.height!);
  });

  it('webPreferences unchanged: preload, contextIsolation, sandbox, no nodeIntegration, the remembered zoom', () => {
    assert.deepEqual(mainWindowOptions(base).webPreferences, {
      preload: '/app/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: 1.25,
    });
  });

  it('the dev icon only off macOS, and never when packaged', () => {
    assert.equal(mainWindowOptions(base).icon, '/dev/icon.png');
    assert.equal(mainWindowOptions({ ...base, platform: 'win32' }).icon, '/dev/icon.png');
    assert.ok(!('icon' in mainWindowOptions({ ...base, platform: 'darwin' })));
    assert.ok(!('icon' in mainWindowOptions({ ...base, iconPath: undefined })));
  });
});
