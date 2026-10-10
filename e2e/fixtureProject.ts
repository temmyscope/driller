/**
 * P4-8h: the e2e fixture project and the userData seed.
 *
 * The fixture is a temp `git init` copy of `fixtures/path-trace-basic` (its
 * checked-in copy has no `.git` of its own). A native folder picker can't be
 * driven, so the seeded `driller-settings.json` (main's `driller-settings`
 * store, `apps/desktop/main/settings.ts`) lists it in Recent Projects.
 *
 * The seeded `driller-backend-settings.json` selects the cloud backend with
 * no key: summaries stay paused, so the run needs neither a cloud key nor
 * the local model. (The Graph Service still starts its model download on
 * index; the harness's network guard refuses it, which the map tolerates.)
 */
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeTempDir, TEMP_PREFIXES } from './harness';

/** Git that ignores the developer's global/system config and identity. */
function git(cwd: string, args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=driller-e2e', '-c', 'user.email=driller-e2e@localhost', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

/** Copies `sourceDir` into a fresh `driller-e2e-fixture-*` dir and commits it on a new repo. Returns its realpath. */
export function createFixtureProject(sourceDir: string, tmpRoot = os.tmpdir()): string {
  const dir = makeTempDir(TEMP_PREFIXES.fixture, tmpRoot);
  cpSync(sourceDir, dir, { recursive: true });
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', 'driller e2e fixture']);
  return dir;
}

export const SEEDED_LAST_OPENED_AT = '2000-01-01T00:00:00.000Z';

export interface SeededRecent {
  path: string;
  name: string;
  lastOpenedAt: string;
}

/** Writes the Recent Projects and backend seeds into a fresh userData dir. */
export function seedUserData(userDataDir: string, projectPath: string): SeededRecent {
  const recent: SeededRecent = { path: projectPath, name: path.basename(projectPath), lastOpenedAt: SEEDED_LAST_OPENED_AT };
  writeFileSync(path.join(userDataDir, 'driller-settings.json'), JSON.stringify({ recentProjects: [recent] }, null, '\t'));
  writeFileSync(path.join(userDataDir, 'driller-backend-settings.json'), JSON.stringify({ activeBackend: 'cloud' }, null, '\t'));
  return recent;
}

/** The Recent Projects list main persisted under `userDataDir` (the e2e temp dir, never the real one). */
export function readRecentProjects(userDataDir: string): SeededRecent[] {
  const parsed = JSON.parse(readFileSync(path.join(userDataDir, 'driller-settings.json'), 'utf8')) as {
    recentProjects?: unknown;
  };
  return Array.isArray(parsed.recentProjects) ? (parsed.recentProjects as SeededRecent[]) : [];
}
