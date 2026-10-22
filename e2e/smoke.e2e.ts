/**
 * P4-8h: the smoke journey `npm run e2e` drives against the real dev app.
 *
 * landing → open the fixture from Recent Projects → a fixture card on the
 * map → Path Trace `handleRequest` → Close project → focus on "Open a folder".
 *
 * Checks use accessible locators only (`getByRole`, `getByText`), so each
 * step reads like its live-UI-tracker row. Named `*.e2e.ts` so
 * `scripts/find-tests.mjs` never picks it up.
 */
import type { Page } from 'playwright-core';

import { LANDING_LIMIT_MS, realSleep, STEP_LIMIT_MS, type Step } from './harness';
import { readRecentProjects, SEEDED_LAST_OPENED_AT } from './fixtureProject';

export interface SmokeContext {
  page: Page;
  /** The temp fixture project's absolute path. */
  fixturePath: string;
  fixtureName: string;
  /** The temp userData dir the app was started with. */
  userDataDir: string;
}

/** The fixture's traced call tree for `handleRequest` (`fixtures/path-trace-basic/README.md`). */
export const HANDLE_REQUEST_CALL_TREE = ['handleRequest', 'serviceA', 'repository', 'cacheLookup', 'serviceB'] as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Polls `check` until it holds. The step's limit fails the step first; this bound just stops the polling after it. */
async function until(check: () => Promise<boolean>, limitMs = STEP_LIMIT_MS): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`still false after ${Math.round(limitMs / 1000)} s`);
    await realSleep(200);
  }
}

const openFolder = (page: Page) => page.getByRole('button', { name: 'Open a folder', exact: true });

export const smokeJourney: readonly Step<SmokeContext>[] = [
  {
    name: 'Landing shows "Open a folder"',
    limitMs: LANDING_LIMIT_MS,
    run: async ({ page }) => {
      await openFolder(page).waitFor({ state: 'visible', timeout: LANDING_LIMIT_MS });
    },
  },
  {
    name: 'Recent Projects lists the fixture',
    run: async ({ page, fixtureName }) => {
      const recent = page.getByRole('region', { name: 'Recent projects' });
      await recent.getByRole('heading', { name: 'Recent Projects' }).waitFor({ state: 'visible' });
      await recent.getByRole('button', { name: new RegExp(`^${escapeRegExp(fixtureName)}\\b`) }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'Open the fixture from Recent Projects',
    run: async ({ page, fixtureName }) => {
      await page
        .getByRole('region', { name: 'Recent projects' })
        .getByRole('button', { name: new RegExp(`^${escapeRegExp(fixtureName)}\\b`) })
        .click();
      await page.getByRole('button', { name: 'Close project', exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'The map shows a fixture card (handleRequest)',
    run: async ({ page }) => {
      await page.getByRole('button', { name: /\bhandleRequest, open Node detail$/ }).first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'Main wrote the temp userData, not the real one',
    run: async ({ userDataDir, fixturePath }) => {
      // `--user-data-dir` reached `app.getPath('userData')`: main's
      // `recordProjectOpened` re-stamped the seeded entry in the temp dir.
      await until(async () => {
        const [first] = readRecentProjects(userDataDir);
        return first !== undefined && first.path === fixturePath && first.lastOpenedAt !== SEEDED_LAST_OPENED_AT;
      });
    },
  },
  {
    name: 'Path Trace "handleRequest" highlights its path',
    run: async ({ page }) => {
      const search = page.getByRole('search', { name: 'Search a traced path' });
      await search.getByRole('textbox', { name: 'Path Trace query' }).fill('handleRequest');
      await search.getByRole('button', { name: 'Trace', exact: true }).click();
      const callTree = page.getByRole('region', { name: 'Call tree' });
      for (const name of HANDLE_REQUEST_CALL_TREE) {
        await callTree.getByRole('button', { name: new RegExp(`^${name}\\b`) }).waitFor({ state: 'visible' });
      }
    },
  },
  {
    name: 'Close project → Recent Projects, focus on "Open a folder"',
    run: async ({ page, fixtureName }) => {
      await page.getByRole('button', { name: 'Close project', exact: true }).click();
      await page
        .getByRole('region', { name: 'Recent projects' })
        .getByRole('button', { name: new RegExp(`^${escapeRegExp(fixtureName)}\\b`) })
        .waitFor({ state: 'visible' });
      const button = openFolder(page);
      await until(() => button.evaluate((element) => element === document.activeElement));
    },
  },
  {
    // P5-g (founder 5.3): `mainWindowOptions` sets minWidth/minHeight 640×480.
    // Last, so a failure here can't skip the steps above. Electron's DevTools
    // server has no `Browser.getWindowForTarget`/`setWindowBounds` (live pass
    // 2026-10-19), so the resize goes through the page's own
    // `window.resizeTo`: Electron turns it into a `content-bounds-updated`
    // event whose default resizes the BrowserWindow through the same
    // native bounds path a drag ends in, where the minimum size applies.
    name: 'The window clamps a 400×300 resize to its 640×480 minimum',
    run: async ({ page }) => {
      const outer = () => page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));
      const before = await outer();
      // First prove the path resizes at all (a no-op would pass the clamp check vacuously).
      await page.evaluate(() => window.resizeTo(900, 700));
      await until(async () => {
        const size = await outer();
        return size.width === 900 && size.height === 700;
      }, 5_000).catch(async () => {
        const size = await outer();
        throw new Error(`window.resizeTo(900, 700) left the window at ${size.width}×${size.height} (was ${before.width}×${before.height}): no resize path`);
      });
      await page.evaluate(() => window.resizeTo(400, 300));
      await realSleep(500);
      const size = await outer();
      if (size.width !== 640 || size.height !== 480) throw new Error(`a 400×300 resize left the window at ${size.width}×${size.height}, not clamped to 640×480`);
      await page.evaluate(({ width, height }) => window.resizeTo(width, height), before);
    },
  },
];
