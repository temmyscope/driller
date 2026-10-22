/**
 * P5-g (founder 5.3): the main window's constructor options, as a pure
 * function so they can be tested without Electron.
 *
 * Today's options (P2-3's 1100×720 default, P4-1's dev icon off macOS, the
 * AD-11 webPreferences, P2-9's remembered zoom) plus a real minimum size:
 * 640×480 device-independent px. At 200% app zoom the CSS viewport can then
 * be 320×240 — accepted, zoom is the user's choice (P2-9).
 *
 * Only type imports from `electron` here, so this module (and its test)
 * load under plain `node --test`.
 */

import type { BrowserWindowConstructorOptions } from 'electron';

/** The window's default size (P2-3). */
export const MAIN_WINDOW_DEFAULT_SIZE = { width: 1100, height: 720 } as const;

/** The window's minimum size, device-independent px. A larger minimum is Ask First. */
export const MAIN_WINDOW_MIN_SIZE = { width: 640, height: 480 } as const;

export interface MainWindowOptionsInput {
  /** The dev source icon, or `undefined` when packaged (forge.config.ts supplies it). */
  iconPath: string | undefined;
  platform: NodeJS.Platform;
  preloadPath: string;
  zoomFactor: number;
}

export function mainWindowOptions({ iconPath, platform, preloadPath, zoomFactor }: MainWindowOptionsInput): BrowserWindowConstructorOptions {
  return {
    width: MAIN_WINDOW_DEFAULT_SIZE.width,
    height: MAIN_WINDOW_DEFAULT_SIZE.height,
    minWidth: MAIN_WINDOW_MIN_SIZE.width,
    minHeight: MAIN_WINDOW_MIN_SIZE.height,
    ...(iconPath && platform !== 'darwin' ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // P2-9: open at the remembered zoom, with no 100% flash first.
      zoomFactor,
    },
  };
}
