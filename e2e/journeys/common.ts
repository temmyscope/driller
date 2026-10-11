/**
 * P4-8i: steps and locators the journeys share. Accessible locators only
 * (`getByRole`, `getByText`, `getByLabel`), never CSS classes, so each
 * check reads like its tracker row.
 */
import type { Locator, Page } from 'playwright-core';

import { LANDING_LIMIT_MS, realSleep, STEP_LIMIT_MS, type Step } from '../harness';
import type { JourneyContext } from '../journey';

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Polls `check` until it holds; throws `message` (or a generic line) after `limitMs`. */
export async function until(check: () => Promise<boolean>, message?: string, limitMs = STEP_LIMIT_MS): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message ?? `still false after ${Math.round(limitMs / 1000)} s`);
    await realSleep(200);
  }
}

/** Polls `read` until `accept` holds; returns the last value, or throws with it. */
export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  describe: (value: T) => string,
  limitMs = STEP_LIMIT_MS,
): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(describe(value));
    await realSleep(200);
  }
}

export const openFolderButton = (page: Page) => page.getByRole('button', { name: 'Open a folder', exact: true });
export const closeProjectButton = (page: Page) => page.getByRole('button', { name: 'Close project', exact: true });

/** A canvas card (`<kind> <name>[, changed][…], open Node detail`). */
export const card = (page: Page, name: string) =>
  page.getByRole('application').getByRole('button', { name: new RegExp(`^\\S+ ${escapeRegExp(name)}(,[^]*)?, open Node detail$`) });

export const recentProjectButton = (page: Page, projectName: string) =>
  page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: new RegExp(`^${escapeRegExp(projectName)}\\b`) });

export const modeRadio = (page: Page, mode: 'Code Map' | 'PR Review' | 'Health Audit') =>
  page.getByRole('radio', { name: new RegExp(`^${escapeRegExp(mode)}\\b`) });

export const landingStep: Step<JourneyContext> = {
  name: 'Landing shows "Open a folder"',
  limitMs: LANDING_LIMIT_MS,
  run: async ({ page }) => {
    await openFolderButton(page).waitFor({ state: 'visible', timeout: LANDING_LIMIT_MS });
  },
};

export const openProjectStep: Step<JourneyContext> = {
  name: 'Open the project from Recent Projects',
  run: async ({ page, projectName }) => {
    await recentProjectButton(page, projectName).click();
    await closeProjectButton(page).waitFor({ state: 'visible' });
  },
};

/** A step that waits for a card to be drawn. */
export const mapShowsStep = (name: string): Step<JourneyContext> => ({
  name: `The map shows ${name}`,
  run: async ({ page }) => {
    await card(page, name).first().waitFor({ state: 'visible' });
  },
});

/** Text content of a locator, trimmed ('' when it isn't there). */
export async function textOf(locator: Locator): Promise<string> {
  if ((await locator.count()) === 0) return '';
  return ((await locator.first().textContent()) ?? '').trim();
}

/**
 * Presses Tab until `target` has keyboard focus (a real keyboard path, not
 * `focus()`); throws after `maxPresses`.
 */
export async function tabTo(page: Page, target: Locator, maxPresses = 120): Promise<void> {
  for (let i = 0; i < maxPresses; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached the target in ${maxPresses} presses`);
}

/** Whether `locator` (first match) has keyboard focus. */
export const isFocused = (locator: Locator) =>
  locator.first().evaluate((element) => element === document.activeElement).catch(() => false);

/** Switches the view mode and waits for its radio to be checked. */
export async function switchMode(page: Page, mode: 'Code Map' | 'PR Review' | 'Health Audit'): Promise<void> {
  const radio = modeRadio(page, mode);
  await radio.click();
  await until(() => radio.isChecked(), `the ${mode} radio never became checked`);
}

/** PR Review: enter `baseRef` ('' = auto-resolve) and press Compute diff scope. */
export async function computeDiffScope(page: Page, baseRef: string): Promise<void> {
  const toolbar = page.getByRole('toolbar', { name: 'PR Review base ref' });
  await toolbar.getByRole('textbox', { name: 'Base ref' }).fill(baseRef);
  await toolbar.getByRole('button', { name: 'Compute diff scope', exact: true }).click();
}

export const metricsTable = (page: Page) => page.getByRole('table', { name: /risk metrics/ });

export interface MetricsRow {
  node: string;
  /** `changed`, or the hop number as text. */
  hop: string;
}

/** The PR Review metrics table's body rows: each row's Node name and hop cell. */
export async function readMetricsRows(page: Page): Promise<MetricsRow[]> {
  const table = metricsTable(page);
  if ((await table.count()) === 0) return [];
  const rows: MetricsRow[] = [];
  for (const row of await table.getByRole('row').all()) {
    const header = row.getByRole('rowheader');
    if ((await header.count()) === 0) continue; // the column-header row
    const node = ((await header.getByRole('code').first().textContent()) ?? '').trim();
    const hop = ((await row.getByRole('cell').first().textContent()) ?? '').trim();
    rows.push({ node, hop });
  }
  return rows;
}

export const describeRows = (rows: readonly MetricsRow[]) => rows.map((r) => `${r.node}@${r.hop}`).join(', ') || '(none)';

/** PR Review's "Blast radius: N Nodes within D hops." line, parsed (undefined while absent). */
export async function readBlastRadiusLine(page: Page): Promise<{ nodes: number; hops: number; text: string } | undefined> {
  const line = page.getByRole('status').filter({ hasText: /^Blast radius: [\d,]+ Nodes? within \d+ hops?\.$/ });
  const text = await textOf(line);
  const match = /^Blast radius: ([\d,]+) Nodes? within (\d+) hops?\.$/.exec(text);
  if (match === null) return undefined;
  return { nodes: Number(match[1]!.replace(/,/g, '')), hops: Number(match[2]), text };
}

/** The React Flow canvas (`role="application"`). */
export const canvas = (page: Page) => page.getByRole('application');

/** Every canvas card's accessible name (`<kind> <name>…, open Node detail`), in DOM order. */
export async function cardNames(page: Page): Promise<string[]> {
  const cards = canvas(page).getByRole('button', { name: /, open Node detail$/ });
  return Promise.all((await cards.all()).map(async (c) => (await c.getAttribute('aria-label')) ?? ''));
}
