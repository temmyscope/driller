/**
 * P4-8i journey for tracker row **P2-5**: "Re-index pending feedback on a
 * genuinely empty project".
 *
 * An empty repo (no files, no scope) opens to the existing sentence "This
 * project has no map-eligible Nodes …" with one "Re-index" action. Pressing
 * it shows "Re-indexing…", disabled, and once the re-index's map comes back
 * (still empty) the action reads "Re-index" and is enabled again.
 */
import { createEmptyProject } from '../fixtureProject';
import type { Journey } from '../journey';
import { landingStep, openProjectStep, until } from './common';

const EMPTY_SENTENCE = /This project has no map-eligible Nodes/;

export const p2_5: Journey = {
  id: 'p2-5',
  rows: ['P2-5'],
  title: 'empty project: Re-index → "Re-indexing…" (disabled) → enabled again',
  prepare: () => ({ projectPath: createEmptyProject() }),
  steps: [
    landingStep,
    openProjectStep,
    {
      name: 'The empty-map notice with one "Re-index" action',
      run: async ({ page }) => {
        await page.getByText(EMPTY_SENTENCE).first().waitFor({ state: 'visible' });
        const reindex = page.getByRole('button', { name: 'Re-index', exact: true });
        await reindex.waitFor({ state: 'visible' });
        await until(() => reindex.isEnabled(), 'Re-index stayed disabled');
        if ((await page.getByRole('button', { name: 'Edit indexing scope' }).count()) > 0) {
          throw new Error('the scope notice showed for a project with no scope');
        }
      },
    },
    {
      name: 'Re-index → "Re-indexing…", disabled',
      run: async ({ page, ipc }) => {
        const before = await ipc.count('restartGraphService');
        await page.getByRole('button', { name: 'Re-index', exact: true }).click();
        const pending = page.getByRole('button', { name: 'Re-indexing…', exact: true });
        await pending.waitFor({ state: 'visible' });
        if (await pending.isEnabled()) throw new Error('"Re-indexing…" is enabled');
        if ((await ipc.count('restartGraphService')) !== before + 1) throw new Error('no restartGraphService call');
      },
    },
    {
      name: 'The map refetches: "Re-index" enabled again, still the empty notice',
      run: async ({ page }) => {
        const reindex = page.getByRole('button', { name: 'Re-index', exact: true });
        await reindex.waitFor({ state: 'visible' });
        await until(() => reindex.isEnabled(), 'Re-index never re-enabled');
        await page.getByText(EMPTY_SENTENCE).first().waitFor({ state: 'visible' });
      },
    },
  ],
};
