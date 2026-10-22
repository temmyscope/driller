/**
 * P4-8i journey for tracker row **P1-5/6**: "Not-a-git-repo and no-base-ref
 * notices; highlights cleared after a revert".
 *
 * On the scratch repo (handleRequest edited on `review`):
 * 1. PR Review against `main` marks handleRequest changed, with a blast radius.
 * 2. The edit is reverted (a `git revert` commit, so HEAD moves: after a
 *    refocus the app re-indexes, P5-a, and says so): computing again says
 *    "No changes to review…" and leaves no changed card, no blast-radius
 *    line and no metrics table, while the map, history and search stay.
 * 3. With `main` renamed away (no main/master/upstream) and a blank base
 *    ref, the no-base-ref notice shows above the kept map; a Path Trace
 *    still draws its route while the notice stays.
 * 4. With the project's `.git` moved away mid-session, PR Review says it
 *    isn't a git repository, with the map kept. (A folder with no `.git`
 *    can't be opened at all; that is the gate PR Review's notice backs up.)
 * 5. A second fixture copy with no `.git`, picked from Recent Projects, is
 *    refused on landing: "... is not a git repository. Choose another folder."
 */
import { renameSync } from 'node:fs';
import path from 'node:path';

import type { Page } from 'playwright-core';

import { createPlainFixture, createScratchDiffFixture, git, SCRATCH_BASE_REF } from '../fixtureProject';
import type { Journey } from '../journey';
import {
  card,
  cardNames,
  closeProjectButton,
  computeDiffScope,
  eventually,
  getCodeMapCalls,
  landingStep,
  mapShowsStep,
  metricsTable,
  openFolderButton,
  openProjectStep,
  readBlastRadiusLine,
  recentProjectButton,
  switchMode,
  waitForMapRefetch,
} from './common';

const NO_CHANGES = 'No changes to review — the resolved base ref has no diff against the current working tree.';
const NOT_A_REPO = "This project isn't a git repository — PR Review Mode needs local git history to compute a diff.";
const NO_BASE_REF =
  'No base ref could be resolved automatically (no upstream tracking branch or local main/master found) — enter one explicitly above.';

/** P5-a's session notice once the HEAD-triggered re-index has finished. */
const REINDEXED = /^Checkout moved [0-9a-f]{7} → [0-9a-f]{7} — re-indexed; compute the diff again\.$/;

const state = { plainProject: '' };

const notice = (page: Page, sentence: string) => page.getByRole('status').filter({ hasText: sentence });

/** The map, the Back/Forward history and Path Trace search are all still there (P1-5/6). */
async function expectWorkspaceKept(page: Page, someCard: string): Promise<void> {
  await card(page, someCard).first().waitFor({ state: 'visible' });
  await page.getByRole('toolbar', { name: 'Map traversal history' }).waitFor({ state: 'visible' });
  const search = page.getByRole('search', { name: 'Search a traced path' });
  await search.getByRole('textbox', { name: 'Path Trace query' }).waitFor({ state: 'visible' });
  if (!(await search.getByRole('textbox', { name: 'Path Trace query' }).isEditable())) throw new Error('Path Trace input not usable');
}

async function expectNoHighlights(page: Page): Promise<void> {
  const changed = (await cardNames(page)).filter((name) => /, changed\b/.test(name));
  if (changed.length > 0) throw new Error(`changed cards left: ${changed.join(' | ')}`);
  const line = await readBlastRadiusLine(page);
  if (line !== undefined) throw new Error(`blast-radius line left: "${line.text}"`);
  if ((await metricsTable(page).count()) > 0) throw new Error('metrics table still shown');
}

export const p1_5_6: Journey = {
  id: 'p1-5-6',
  rows: ['P1-5/6'],
  title: 'not-a-git-repo and no-base-ref notices keep the map; a revert clears the highlights',
  prepare: (env) => {
    const projectPath = createScratchDiffFixture(env.fixtureSource);
    state.plainProject = env.track(createPlainFixture(env.fixtureSource));
    return { projectPath, seed: { extraRecentProjects: [state.plainProject] } };
  },
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('handleRequest'),
    {
      name: `PR Review against ${SCRATCH_BASE_REF}: handleRequest changed, blast radius shown`,
      run: async ({ page }) => {
        await switchMode(page, 'PR Review');
        await computeDiffScope(page, SCRATCH_BASE_REF);
        await page.getByRole('application').getByRole('button', { name: /^Function handleRequest, changed, / }).waitFor({ state: 'visible' });
        await eventually(() => readBlastRadiusLine(page), (l) => l !== undefined, () => 'no blast-radius line');
      },
    },
    {
      name: 'Revert the edit, compute again: "No changes" notice, highlights cleared, map kept',
      run: async (ctx) => {
        const { page, projectPath, emitWindowFocus } = ctx;
        // The revert is a commit, so HEAD moves (P5-a): the app re-indexes
        // when the window regains focus (a diff before that is P5-a's
        // explicit checkout-changed error, never a diff). Come back to the
        // app the way a user does, wait for the "re-indexed" notice, then
        // compute again.
        const fetches = await getCodeMapCalls(ctx);
        git(projectPath, ['revert', '--no-edit', 'HEAD']);
        await emitWindowFocus();
        await page.getByText(REINDEXED).waitFor({ state: 'visible' });
        await waitForMapRefetch(ctx, fetches);
        await computeDiffScope(page, SCRATCH_BASE_REF);
        await notice(page, NO_CHANGES).waitFor({ state: 'visible' });
        await eventually(
          async () => {
            try {
              await expectNoHighlights(page);
              return '';
            } catch (error) {
              return String(error);
            }
          },
          (problem) => problem === '',
          (problem) => problem,
        );
        await expectWorkspaceKept(page, 'handleRequest');
      },
    },
    {
      name: 'No main/master and a blank base ref: the no-base-ref notice, map kept',
      run: async ({ page, projectPath }) => {
        git(projectPath, ['branch', '-m', SCRATCH_BASE_REF, 'trunk']);
        await computeDiffScope(page, '');
        await notice(page, NO_BASE_REF).waitFor({ state: 'visible' });
        await expectNoHighlights(page);
        await expectWorkspaceKept(page, 'handleRequest');
      },
    },
    {
      name: 'A Path Trace under the notice draws its route; the notice stays',
      run: async ({ page }) => {
        const search = page.getByRole('search', { name: 'Search a traced path' });
        await search.getByRole('textbox', { name: 'Path Trace query' }).fill('handleRequest');
        await search.getByRole('button', { name: 'Trace', exact: true }).click();
        const callTree = page.getByRole('region', { name: 'Call tree' });
        for (const name of ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup']) {
          await callTree.getByRole('button', { name: new RegExp(`^${name}\\b`) }).waitFor({ state: 'visible' });
        }
        await notice(page, NO_BASE_REF).waitFor({ state: 'visible' });
      },
    },
    {
      name: "The project's .git removed mid-session: PR Review's not-a-git-repo notice, map kept",
      run: async ({ page, projectPath }) => {
        // Open-folder refuses a folder with no .git (next step), so PR Review's
        // notice is reached the way its code documents: .git gone mid-session.
        renameSync(path.join(projectPath, '.git'), path.join(projectPath, 'git-moved-away'));
        await computeDiffScope(page, '');
        await notice(page, NOT_A_REPO).waitFor({ state: 'visible' });
        await expectNoHighlights(page);
        await expectWorkspaceKept(page, 'handleRequest');
      },
    },
    {
      name: 'The copy without .git, from Recent Projects: "is not a git repository" on landing',
      run: async ({ page }) => {
        await closeProjectButton(page).click();
        await recentProjectButton(page, path.basename(state.plainProject)).click();
        await page.getByText(`${state.plainProject} is not a git repository. Choose another folder.`).waitFor({ state: 'visible' });
        await openFolderButton(page).waitFor({ state: 'visible' });
      },
    },
  ],
};
