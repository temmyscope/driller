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
 * the local model. P5-c: under Cloud the Graph Service never starts the
 * model download, and the run's teardown checks that the network guard
 * refused no Hugging Face host.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeTempDir, TEMP_PREFIXES } from './harness';
import type { UserDataSeed } from './journey';

/** Git that ignores the developer's global/system config and identity. */
export function git(cwd: string, args: string[]): void {
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

/** `git init` + commit everything in `dir` (a fresh repo with one commit on `main`). */
export function commitAll(dir: string, message = 'driller e2e fixture'): void {
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', message]);
}

/** Copies `sourceDir` into a fresh `driller-e2e-fixture-*` dir and commits it on a new repo. Returns its realpath. */
export function createFixtureProject(sourceDir: string, tmpRoot = os.tmpdir()): string {
  const dir = makeTempDir(TEMP_PREFIXES.fixture, tmpRoot);
  cpSync(sourceDir, dir, { recursive: true });
  commitAll(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// P4-8i variants. Each is a fresh temp dir (never the developer's repos);
// the caller registers it for teardown.
// ---------------------------------------------------------------------------

/** A copy of `sourceDir` with no `.git` anywhere (P1-5/6's not-a-git-repo notice). */
export function createPlainFixture(sourceDir: string, tmpRoot = os.tmpdir()): string {
  const dir = makeTempDir(TEMP_PREFIXES.fixture, tmpRoot);
  cpSync(sourceDir, dir, { recursive: true });
  return dir;
}

/** An empty project folder: a repo with no files (P2-5's genuinely empty project). */
export function createEmptyProject(tmpRoot = os.tmpdir()): string {
  const dir = makeTempDir(TEMP_PREFIXES.fixture, tmpRoot);
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  return dir;
}

/** The second section's sources: a tiny call chain with names that never clash with path-trace-basic's. */
export const WEB_SECTION_FILES: Readonly<Record<string, string>> = {
  'page.ts': "import { formatTitle } from './title';\n\nexport function renderPage(): string {\n  return formatTitle('home');\n}\n",
  'title.ts': "export function formatTitle(name: string): string {\n  return name.toUpperCase();\n}\n",
};

/**
 * A repo with two sections (P4-4i): `api/` is a copy of `sourceDir`
 * (path-trace-basic) and `web/` holds `WEB_SECTION_FILES`. Pair it with an
 * `includedPaths: ['api', 'web']` seed.
 */
export function createSectionedFixture(sourceDir: string, tmpRoot = os.tmpdir()): string {
  const dir = makeTempDir(TEMP_PREFIXES.fixture, tmpRoot);
  cpSync(sourceDir, path.join(dir, 'api'), { recursive: true });
  mkdirSync(path.join(dir, 'web'));
  for (const [name, text] of Object.entries(WEB_SECTION_FILES)) writeFileSync(path.join(dir, 'web', name), text);
  commitAll(dir);
  return dir;
}

/** The branch the scratch repo's base commit sits on; PR Review's base ref. */
export const SCRATCH_BASE_REF = 'main';

/** `handleRequest`'s edit in the scratch repo: one more call, so only that function's lines change. */
export const editHandleRequest = (text: string): string => text.replace('  serviceB();\n}', '  serviceB();\n  serviceA();\n}');

/**
 * The PR Review scratch repo (P0-5, P1-5/6, P4-3c): path-trace-basic
 * committed on `main`, then a `review` branch whose one commit edits
 * `handleRequest` (entry.ts). PR Review diffs committed state only
 * (`merge-base(HEAD, base)..HEAD`), so the edit is committed and the base
 * ref is `main` (`SCRATCH_BASE_REF`); against `HEAD` itself the diff would
 * always be empty.
 */
export function createScratchDiffFixture(sourceDir: string, tmpRoot = os.tmpdir()): string {
  const dir = createFixtureProject(sourceDir, tmpRoot);
  git(dir, ['checkout', '--quiet', '-b', 'review']);
  editFile(dir, 'entry.ts', editHandleRequest);
  git(dir, ['commit', '--quiet', '--all', '--message', 'edit handleRequest']);
  return dir;
}

/** P5-a: the branch whose one commit changes all seven contracts. */
export const SEVEN_TYPES_BRANCH = 'seventypes';
/** P5-a: the seven interfaces `types.ts` declares. */
export const SEVEN_TYPE_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'] as const;

/** `types.ts`: the seven interfaces, each with `fieldsEach` fields. */
export function sevenTypesSource(fieldsEach: number): string {
  return SEVEN_TYPE_NAMES.map(
    (name) =>
      `export interface ${name} {\n${Array.from({ length: fieldsEach }, (_, i) => `  field${i + 1}: string;\n`).join('')}}\n`,
  ).join('\n');
}

/**
 * The P5-a scratch repo (the 2026-10-11 `seventypes` finding):
 * path-trace-basic plus `types.ts` (seven interfaces) committed on `main`,
 * then a `seventypes` branch whose one commit adds a field to each interface
 * — so every later interface's lines shift, and an index taken on `main`
 * maps that diff onto stale ranges. Left checked out on `main`, where the
 * journey opens it.
 */
export function createSevenTypesFixture(sourceDir: string, tmpRoot = os.tmpdir()): string {
  const dir = makeTempDir(TEMP_PREFIXES.fixture, tmpRoot);
  cpSync(sourceDir, dir, { recursive: true });
  writeFileSync(path.join(dir, 'types.ts'), sevenTypesSource(2));
  commitAll(dir);
  git(dir, ['checkout', '--quiet', '-b', SEVEN_TYPES_BRANCH]);
  writeFileSync(path.join(dir, 'types.ts'), sevenTypesSource(3));
  git(dir, ['commit', '--quiet', '--all', '--message', 'add a field to all seven contracts']);
  git(dir, ['checkout', '--quiet', SCRATCH_BASE_REF]);
  return dir;
}

/**
 * Rewrites one committed file in place (an uncommitted working-tree change),
 * so PR Review against base ref `HEAD` sees exactly that diff. Throws when
 * `edit` leaves the text unchanged.
 */
export function editFile(projectDir: string, relativePath: string, edit: (text: string) => string): void {
  const file = path.join(projectDir, relativePath);
  const before = readFileSync(file, 'utf8');
  const after = edit(before);
  if (after === before) throw new Error(`editFile: ${relativePath} unchanged`);
  writeFileSync(file, after);
}

export const SEEDED_LAST_OPENED_AT = '2000-01-01T00:00:00.000Z';

export interface SeededRecent {
  path: string;
  name: string;
  lastOpenedAt: string;
}

/**
 * Writes the Recent Projects and backend seeds into a fresh userData dir,
 * plus (P4-8i) an optional indexing-scope allowlist and UI settings.
 */
export function seedUserData(userDataDir: string, projectPath: string, seed: UserDataSeed = {}): SeededRecent {
  const recent: SeededRecent = { path: projectPath, name: path.basename(projectPath), lastOpenedAt: SEEDED_LAST_OPENED_AT };
  const extra = (seed.extraRecentProjects ?? []).map((p) => ({ path: p, name: path.basename(p), lastOpenedAt: SEEDED_LAST_OPENED_AT }));
  writeFileSync(
    path.join(userDataDir, 'driller-settings.json'),
    JSON.stringify({ recentProjects: [recent, ...extra] }, null, '\t'),
  );
  writeFileSync(path.join(userDataDir, 'driller-backend-settings.json'), JSON.stringify({ activeBackend: 'cloud' }, null, '\t'));
  if (seed.includedPaths !== undefined) {
    const projects = { [projectPath]: { includedPaths: [...seed.includedPaths] } };
    writeFileSync(path.join(userDataDir, 'driller-project-scope-settings.json'), JSON.stringify({ projects }, null, '\t'));
  }
  if (seed.uiSettings !== undefined) {
    writeFileSync(path.join(userDataDir, 'driller-ui-settings.json'), JSON.stringify(seed.uiSettings, null, '\t'));
  }
  return recent;
}

/** A JSON settings file main wrote under `userDataDir` (`{}` when absent). */
export function readUserDataJson(userDataDir: string, name: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(userDataDir, `${name}.json`), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The Recent Projects list main persisted under `userDataDir` (the e2e temp dir, never the real one). */
export function readRecentProjects(userDataDir: string): SeededRecent[] {
  const parsed = JSON.parse(readFileSync(path.join(userDataDir, 'driller-settings.json'), 'utf8')) as {
    recentProjects?: unknown;
  };
  return Array.isArray(parsed.recentProjects) ? (parsed.recentProjects as SeededRecent[]) : [];
}
