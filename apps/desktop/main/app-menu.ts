/**
 * P2-9: the explicit application menu, and app zoom's pure step logic.
 *
 * driller previously set no menu, so zoom (the accessible scaling path for
 * px-token type in Electron) depended on Electron's implicit default menu,
 * was unbounded, and wasn't remembered. This module owns the zoom steps and
 * the menu template and the zoom-key mapping; main/index.ts wires the
 * handlers (apply + persist zoom, send `menu:openFolder`) and calls
 * `Menu.buildFromTemplate`.
 *
 * Only type imports from `electron` here, so this module (and its test)
 * load under plain `node --test`.
 */

import type { MenuItemConstructorOptions } from 'electron';

/** The fixed zoom steps, 80–200%. Changing these or the range is Ask First. */
export const ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const DEFAULT_ZOOM_FACTOR = 1;

export type ZoomDirection = 'in' | 'out' | 'reset';

/** Index of the step nearest `value`; a tie goes to the lower step. A non-finite value maps to 100%. */
function nearestStepIndex(value: number): number {
  if (!Number.isFinite(value)) {
    return ZOOM_STEPS.indexOf(DEFAULT_ZOOM_FACTOR);
  }
  let best = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i += 1) {
    if (Math.abs(ZOOM_STEPS[i]! - value) < Math.abs(ZOOM_STEPS[best]! - value)) {
      best = i;
    }
  }
  return best;
}

/**
 * The zoom factor after one Zoom In / Zoom Out / Actual Size. `'in'` and
 * `'out'` move one step and clamp at the ends; `'reset'` returns 1. A
 * `current` that isn't a step snaps to the nearest step first.
 */
export function nextZoomFactor(current: number, direction: ZoomDirection): number {
  if (direction === 'reset') {
    return DEFAULT_ZOOM_FACTOR;
  }
  const index = nearestStepIndex(current);
  const next = direction === 'in' ? index + 1 : index - 1;
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, next))]!;
}

/** How far past 80% or 200% a stored value may drift (float round-trips) and still count as that bound. */
const ZOOM_BOUND_TOLERANCE = 1e-6;

/**
 * Validates a persisted zoom value (the store file is hand-editable JSON).
 * A finite number within 80–200% (±1e-6 for float drift) snaps to its
 * nearest step; anything else (`"abc"`, `7`, `NaN`, missing) is `null`, so
 * the caller falls back to 1.
 *
 * Deliberately stricter than `nextZoomFactor`: that one takes the live
 * zoom and must always produce *some* step, so it snaps even an
 * out-of-range value to the nearest end. A stored value outside the range
 * didn't come from driller, so it's rejected as corrupt, not trusted.
 */
export function parseStoredZoomFactor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const min = ZOOM_STEPS[0]!;
  const max = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  if (value < min - ZOOM_BOUND_TOLERANCE || value > max + ZOOM_BOUND_TOLERANCE) {
    return null;
  }
  return ZOOM_STEPS[nearestStepIndex(value)]!;
}

/** The subset of Electron's `Input` (from `before-input-event`) the zoom keys need. */
export interface ZoomKeyInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}

/**
 * The zoom keys the menu's accelerators can't cover, handled in main via
 * `before-input-event`: Cmd/Ctrl+Plus (Shift+=) and the numpad's add,
 * subtract and 0. A hidden duplicate menu item would cover Plus on macOS
 * only (hidden items' accelerators don't fire on Windows/Linux). Returns
 * `null` for every other input. The caller `preventDefault`s a match, which
 * also stops any menu accelerator from firing a second time.
 */
export function zoomDirectionForInput(input: ZoomKeyInput, platform: NodeJS.Platform): ZoomDirection | null {
  if (input.type !== 'keyDown' || input.alt) {
    return null;
  }
  const commandKey = platform === 'darwin' ? input.meta : input.control;
  if (!commandKey) {
    return null;
  }
  switch (input.code) {
    case 'NumpadAdd':
      return 'in';
    case 'NumpadSubtract':
      return 'out';
    case 'Numpad0':
      return 'reset';
    default:
      return input.key === '+' ? 'in' : null;
  }
}

export interface AppMenuHandlers {
  onOpenFolder: () => void;
  onZoom: (direction: ZoomDirection) => void;
}

export interface AppMenuOptions {
  platform: NodeJS.Platform;
  /** `app.isPackaged` — Toggle DevTools appears only when false. */
  isPackaged: boolean;
}

/**
 * The application menu template: the macOS app menu (roles), File (Open
 * Folder…, Close, and Quit off macOS), Edit (roles, so copy/paste keep
 * working), View (zoom, full screen, and dev-only reload/DevTools) and
 * Window (roles).
 */
export function buildAppMenu(
  handlers: AppMenuHandlers,
  options: AppMenuOptions,
): MenuItemConstructorOptions[] {
  const isMac = options.platform === 'darwin';

  const viewSubmenu: MenuItemConstructorOptions[] = [];
  if (!options.isPackaged) {
    viewSubmenu.push({ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' });
  }
  viewSubmenu.push(
    // Cmd/Ctrl+Plus and the numpad keys arrive via `zoomDirectionForInput`.
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => handlers.onZoom('in') },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => handlers.onZoom('out') },
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => handlers.onZoom('reset') },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  );
  if (!options.isPackaged) {
    viewSubmenu.push({ type: 'separator' }, { role: 'toggleDevTools' });
  }

  const fileSubmenu: MenuItemConstructorOptions[] = [
    { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => handlers.onOpenFolder() },
    { type: 'separator' },
    { role: 'close' },
  ];
  if (!isMac) {
    // macOS has Quit in the app menu.
    fileSubmenu.push({ role: 'quit' });
  }

  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({ role: 'appMenu' });
  }
  template.push(
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    { label: 'View', submenu: viewSubmenu },
    { role: 'windowMenu' },
  );
  return template;
}
