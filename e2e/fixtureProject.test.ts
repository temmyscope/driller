/**
 * P4-8h: the e2e fixture project (a temp git copy of path-trace-basic) and
 * the userData seed, plus the smoke journey's shape. No app is started.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixtureProject, readRecentProjects, seedUserData, SEEDED_LAST_OPENED_AT } from './fixtureProject';
import { LANDING_LIMIT_MS, makeTempDir, removeTempDirs, TEMP_PREFIXES } from './harness';
import { HANDLE_REQUEST_CALL_TREE, smokeJourney } from './smoke.e2e';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(path.dirname(E2E_DIR), 'fixtures', 'path-trace-basic');

const made: string[] = [];
after(() => removeTempDirs(made));

describe('createFixtureProject', () => {
  it('copies path-trace-basic into a fresh driller-e2e-fixture-* git repo with one commit', () => {
    const dir = createFixtureProject(SOURCE);
    made.push(dir);
    assert.ok(path.basename(dir).startsWith(TEMP_PREFIXES.fixture));
    const sourceFiles = readdirSync(SOURCE).sort();
    assert.deepEqual(
      readdirSync(dir)
        .filter((name) => name !== '.git')
        .sort(),
      sourceFiles,
    );
    assert.ok(sourceFiles.includes('entry.ts'));
    assert.equal(readFileSync(path.join(dir, 'entry.ts'), 'utf8'), readFileSync(path.join(SOURCE, 'entry.ts'), 'utf8'));
    const head = spawnSync('git', ['log', '--format=%an %s'], { cwd: dir, encoding: 'utf8' });
    assert.equal(head.stdout.trim(), 'driller-e2e driller e2e fixture');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    assert.equal(status.stdout, '', 'every file committed');
    // The checked-in fixture itself is untouched (no nested .git).
    assert.equal(existsSync(path.join(SOURCE, '.git')), false);
  });
});

describe('seedUserData', () => {
  it("lists the fixture in Recent Projects in main's driller-settings shape and selects cloud with no key", () => {
    const userData = makeTempDir(TEMP_PREFIXES.userData);
    made.push(userData);
    const project = '/tmp/driller-e2e-fixture-abc';
    const seeded = seedUserData(userData, project);
    assert.deepEqual(seeded, { path: project, name: 'driller-e2e-fixture-abc', lastOpenedAt: SEEDED_LAST_OPENED_AT });
    assert.deepEqual(JSON.parse(readFileSync(path.join(userData, 'driller-settings.json'), 'utf8')), {
      recentProjects: [seeded],
    });
    assert.deepEqual(JSON.parse(readFileSync(path.join(userData, 'driller-backend-settings.json'), 'utf8')), {
      activeBackend: 'cloud',
    });
    assert.deepEqual(readRecentProjects(userData), [seeded]);
    assert.deepEqual(readdirSync(userData).sort(), ['driller-backend-settings.json', 'driller-settings.json']);
  });

  it('reads an unexpected shape as an empty list', () => {
    const userData = makeTempDir(TEMP_PREFIXES.userData);
    made.push(userData);
    writeFileSync(path.join(userData, 'driller-settings.json'), JSON.stringify({ recentProjects: 'nope' }));
    assert.deepEqual(readRecentProjects(userData), []);
  });
});

describe('smokeJourney', () => {
  it('walks landing → Recent Projects → map → Path Trace → Close project, then (P5-g) the minimum-size resize, in that order', () => {
    const names = smokeJourney.map((step) => step.name);
    assert.deepEqual(names, [
      'Landing shows "Open a folder"',
      'Recent Projects lists the fixture',
      'Open the fixture from Recent Projects',
      'The map shows a fixture card (handleRequest)',
      'Main wrote the temp userData, not the real one',
      'Path Trace "handleRequest" highlights its path',
      'Close project → Recent Projects, focus on "Open a folder"',
      'The window clamps a 400×300 resize to its 640×480 minimum',
    ]);
    assert.equal(smokeJourney[0]!.limitMs, LANDING_LIMIT_MS);
  });

  it("expects the README's handleRequest call tree", () => {
    const readme = readFileSync(path.join(SOURCE, 'README.md'), 'utf8');
    for (const name of HANDLE_REQUEST_CALL_TREE) assert.match(readme, new RegExp(`\\b${name}\\b`));
  });

  it('locates by role and text only, never CSS', () => {
    const source = readFileSync(path.join(E2E_DIR, 'smoke.e2e.ts'), 'utf8');
    assert.doesNotMatch(source, /\.locator\(|\$\(|\$\$\(|querySelector|className|\bcss=/);
  });
});
