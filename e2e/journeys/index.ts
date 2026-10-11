/**
 * P4-8i: every journey `npm run e2e` runs, in order. The smoke journey
 * (P4-8h) comes first; each P4-8i journey cites its tracker row id(s) in
 * `rows`, which `--only` and `--report` use.
 */
import { createFixtureProject } from '../fixtureProject';
import type { Journey } from '../journey';
import { smokeJourney } from '../smoke.e2e';
import { p0_5 } from './p0-5.e2e';
import { p1_5_6 } from './p1-5-6.e2e';
import { p2_1 } from './p2-1.e2e';
import { p2_5 } from './p2-5.e2e';
import { p4_3c } from './p4-3c.e2e';
import { p4_4i } from './p4-4i.e2e';
import { p4_7de } from './p4-7de.e2e';
import { p4_7g } from './p4-7g.e2e';

/** P4-8h's smoke journey, as the P0-3 "Close project" row. */
export const smoke: Journey = {
  id: 'smoke',
  rows: ['P0-3'],
  title: 'landing → open → map → Path Trace → Close project, focus on "Open a folder"',
  prepare: (env) => ({ projectPath: createFixtureProject(env.fixtureSource) }),
  steps: smokeJourney.map((step) => ({
    ...step,
    run: (ctx) =>
      step.run({ page: ctx.page, fixturePath: ctx.projectPath, fixtureName: ctx.projectName, userDataDir: ctx.userDataDir }),
  })),
};

export const JOURNEYS: readonly Journey[] = [smoke, p0_5, p1_5_6, p2_1, p2_5, p4_3c, p4_4i, p4_7de, p4_7g];
