/**
 * P4-8i: the multi-journey runner's pure parts (`--report`, `--only`), the
 * journey registry's shape, the fixture variants, and the IPC counter's
 * channel → method map. No app is started.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { IpcChannels } from '../packages/ipc-contracts/src/index';
import {
  createEmptyProject,
  createPlainFixture,
  createScratchDiffFixture,
  createSectionedFixture,
  editFile,
  readUserDataJson,
  SCRATCH_BASE_REF,
  seedUserData,
  WEB_SECTION_FILES,
} from './fixtureProject';
import { LANDING_LIMIT_MS, makeTempDir, removeTempDirs, TEMP_PREFIXES, type StepResult } from './harness';
import { channelToMethod, PRELOAD_SOURCE_PATH } from './ipcCounter';
import { E2E_RUN_LIMIT_MS, firstFailure, formatReport, parseCliArgs, reportDate, selectJourneys, type JourneyOutcome } from './journey';
import { JOURNEYS } from './journeys';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(path.dirname(E2E_DIR), 'fixtures', 'path-trace-basic');
const made: string[] = [];
after(() => removeTempDirs(made));

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

describe('parseCliArgs', () => {
  it('reads --report and repeatable, comma-separated --only (lower-cased)', () => {
    assert.deepEqual(parseCliArgs([]), { report: false, only: [] });
    assert.deepEqual(parseCliArgs(['--report', '--only', 'P0-5,P4-3c', '--only=p2-1']), {
      report: true,
      only: ['p0-5', 'p4-3c', 'p2-1'],
    });
  });

  it('rejects an unknown option and a bare --only', () => {
    assert.throws(() => parseCliArgs(['--repot']), /unknown option --repot/);
    assert.throws(() => parseCliArgs(['--only']), /--only needs a row id/);
  });
});

describe('selectJourneys', () => {
  const journeys = [
    { id: 'a', rows: ['P0-5'] },
    { id: 'b', rows: ['P4-7d', 'P4-7e'] },
  ];
  it('matches a journey id or any of its row ids; empty = all', () => {
    assert.deepEqual(selectJourneys(journeys, []), journeys);
    assert.deepEqual(selectJourneys(journeys, ['p4-7e']), [journeys[1]]);
    assert.deepEqual(selectJourneys(journeys, ['a', 'p4-7d']), journeys);
  });
  it('throws on a filter value that matches nothing', () => {
    assert.throws(() => selectJourneys(journeys, ['p9-9']), /--only p9-9: no such row/);
  });
});

describe('formatReport', () => {
  const step = (name: string, ok: boolean, extra: Partial<StepResult> = {}): StepResult => ({ name, ok, ms: 10, ...extra });
  const outcome = (id: string, rows: string[], steps: StepResult[], checkFailures: string[] = []): JourneyOutcome => ({
    journey: { id, rows, title: id },
    ok: steps.every((s) => s.ok) && checkFailures.length === 0,
    ms: 12_300,
    steps,
    checkFailures,
  });

  it('prints one line per row: ✅ <date> (e2e), or ❌ with the first failing step', () => {
    const report = formatReport(
      [
        outcome('p4-7de', ['P4-7d', 'P4-7e'], [step('one', true)]),
        outcome('p0-5', ['P0-5'], [step('one', true), step('Badge', false, { error: 'reads 4' }), step('three', false, { skipped: true, error: 'not run' })]),
      ],
      '2026-10-11',
    );
    assert.deepEqual(report.split('\n'), [
      'P4-7d  ✅ 2026-10-11 (e2e)  [p4-7de, 12.3 s]',
      'P4-7e  ✅ 2026-10-11 (e2e)  [p4-7de, 12.3 s]',
      'P0-5   ❌ Badge: reads 4  [p0-5, 12.3 s]',
    ]);
  });

  it('names a failed teardown check when every step passed', () => {
    assert.equal(firstFailure(outcome('x', ['X'], [step('one', true)], ['Teardown: survivors'])), 'Teardown: survivors');
  });

  it('formats a local date', () => {
    assert.equal(reportDate(new Date(2026, 9, 1)), '2026-10-01');
  });
});

describe('JOURNEYS', () => {
  it('covers P0-3 (smoke), the 8 P4-8i row groups and FIX-7’s regressions, each journey with a unique id', () => {
    assert.deepEqual(
      JOURNEYS.flatMap((j) => j.rows),
      ['P0-3', 'P0-5', 'P1-5/6', 'P2-1', 'P2-5', 'P4-3c', 'P4-4i', 'P4-7d', 'P4-7e', 'P4-7g', 'P2-4', 'P3-11/12', 'P4-7e', 'FIX-5'],
    );
    assert.equal(new Set(JOURNEYS.map((j) => j.id)).size, JOURNEYS.length);
  });

  it('starts every journey at the landing, with the 90 s landing budget', () => {
    for (const journey of JOURNEYS) {
      assert.equal(journey.steps[0]!.name, 'Landing shows "Open a folder"', journey.id);
      assert.equal(journey.steps[0]!.limitMs, LANDING_LIMIT_MS, journey.id);
    }
  });

  it('allows the whole run 15 minutes', () => {
    assert.equal(E2E_RUN_LIMIT_MS, 15 * 60_000);
  });

  it('cites its tracker row in each journey file, and locates by role and text only, never CSS', () => {
    const dir = path.join(E2E_DIR, 'journeys');
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(source, /\.locator\(|\$\(|\$\$\(|querySelector|className|\bcss=/, file);
      if (file.endsWith('.e2e.ts')) assert.match(source, /tracker rows? \*\*P\d/, file);
    }
  });
});

describe('fixture variants', () => {
  it('createPlainFixture copies path-trace-basic with no .git', () => {
    const dir = createPlainFixture(SOURCE);
    made.push(dir);
    assert.ok(path.basename(dir).startsWith(TEMP_PREFIXES.fixture));
    assert.equal(existsSync(path.join(dir, '.git')), false);
    assert.ok(existsSync(path.join(dir, 'entry.ts')));
  });

  it('createEmptyProject is a repo with no files', () => {
    const dir = createEmptyProject();
    made.push(dir);
    assert.deepEqual(readdirSync(dir), ['.git']);
  });

  it('createSectionedFixture commits api/ (path-trace-basic) and web/', () => {
    const dir = createSectionedFixture(SOURCE);
    made.push(dir);
    assert.deepEqual(readdirSync(path.join(dir, 'api')).sort(), readdirSync(SOURCE).sort());
    assert.deepEqual(readdirSync(path.join(dir, 'web')).sort(), Object.keys(WEB_SECTION_FILES).sort());
    assert.equal(git(dir, ['status', '--porcelain']), '');
  });

  it('createScratchDiffFixture: review is one commit ahead of main, changing only entry.ts', () => {
    const dir = createScratchDiffFixture(SOURCE);
    made.push(dir);
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'review');
    assert.equal(git(dir, ['diff', '--name-only', SCRATCH_BASE_REF, 'HEAD']), 'entry.ts');
    assert.match(readFileSync(path.join(dir, 'entry.ts'), 'utf8'), /serviceB\(\);\n {2}serviceA\(\);\n\}/);
    assert.equal(git(dir, ['status', '--porcelain']), '');
  });

  it('editFile refuses an edit that changes nothing', () => {
    const dir = createPlainFixture(SOURCE);
    made.push(dir);
    assert.throws(() => editFile(dir, 'entry.ts', (text) => text), /unchanged/);
  });
});

describe('seedUserData (P4-8i seeds)', () => {
  it('writes extra Recent Projects, the scope allowlist and UI settings', () => {
    const userData = makeTempDir(TEMP_PREFIXES.userData);
    made.push(userData);
    seedUserData(userData, '/tmp/p', { includedPaths: ['api', 'web'], uiSettings: { a: 1 }, extraRecentProjects: ['/tmp/q'] });
    const recents = readUserDataJson(userData, 'driller-settings').recentProjects as { path: string }[];
    assert.deepEqual(recents.map((r) => r.path), ['/tmp/p', '/tmp/q']);
    assert.deepEqual(readUserDataJson(userData, 'driller-project-scope-settings'), {
      projects: { '/tmp/p': { includedPaths: ['api', 'web'] } },
    });
    assert.deepEqual(readUserDataJson(userData, 'driller-ui-settings'), { a: 1 });
    assert.deepEqual(readUserDataJson(userData, 'missing'), {});
  });
});

describe('channelToMethod', () => {
  it("maps the preload's channels to its window.driller methods", () => {
    const map = channelToMethod(readFileSync(PRELOAD_SOURCE_PATH, 'utf8'), IpcChannels as unknown as Record<string, string>);
    assert.equal(map.get(IpcChannels.blastRadiusExpand), 'expandBlastRadius');
    assert.equal(map.get(IpcChannels.codeMapGet), 'getCodeMap');
    assert.equal(map.get(IpcChannels.entryCandidatesList), 'listEntryCandidates');
    assert.equal(map.get(IpcChannels.settingsSetEntryPins), 'setEntryPins');
    assert.equal(map.get(IpcChannels.graphServiceRestart), 'restartGraphService');
  });
});
