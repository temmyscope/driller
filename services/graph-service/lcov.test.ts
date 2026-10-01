/**
 * P4-3 phase 5: `lcov.ts` — `loadLcovCoverage` (missing, malformed, relative,
 * `./`-prefixed and absolute `SF:` paths, repeated blocks), `hasCoverageGap`
 * and the new `hasCoverageData`, which backs `CodeMapNode.testCoverageAvailable`.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  hasCoverageData,
  hasCoverageGap,
  hasFunctionHit,
  loadLcovCoverage,
  type LcovCoverage,
  type LcovFunctions,
  type LcovReport,
} from './lcov';

const roots: string[] = [];

function projectWith(lcov: string | undefined): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'driller-lcov-'));
  roots.push(root);
  if (lcov !== undefined) {
    mkdirSync(path.join(root, 'coverage'));
    writeFileSync(path.join(root, 'coverage', 'lcov.info'), lcov);
  }
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('loadLcovCoverage', () => {
  it('resolves undefined when coverage/lcov.info is missing', async () => {
    assert.equal(await loadLcovCoverage(projectWith(undefined)), undefined);
  });

  it('parses relative, ./-prefixed and absolute SF: paths to POSIX-relative keys', async () => {
    const root = projectWith('');
    writeFileSync(
      path.join(root, 'coverage', 'lcov.info'),
      [
        'TN:',
        'SF:src/a.ts',
        'DA:1,2',
        'DA:2,0',
        'end_of_record',
        'SF:./src/b.ts',
        'DA:3,1',
        'end_of_record ',
        `SF:${path.join(root, 'src', 'c.ts')}`,
        'DA:4,0',
        'end_of_record',
        '',
      ].join('\n'),
    );
    const report = await loadLcovCoverage(root);
    assert.ok(report !== undefined);
    const coverage = report.lines;
    assert.deepEqual([...coverage.keys()].sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual([...coverage.get('src/a.ts')!], [1]);
    assert.deepEqual([...coverage.get('src/c.ts')!], []);
  });

  it('merges a repeated SF: block for the same file', async () => {
    const report = await loadLcovCoverage(
      projectWith(
        [
          'SF:src/a.ts',
          'FN:1,f',
          'FNDA:2,f',
          'DA:1,1',
          'end_of_record',
          'SF:src/a.ts',
          'FN:1,f',
          'FNDA:0,f',
          'DA:5,1',
          'end_of_record',
        ].join('\n'),
      ),
    );
    assert.deepEqual([...report!.lines.get('src/a.ts')!].sort(), [1, 5]);
    // P4-3f review round 1: function records merge too — same start line, summed counts.
    assert.deepEqual(report!.functions.get('src/a.ts')!.get('f'), { lines: new Set([1]), hits: 2 });
  });

  it('malformed content never throws: DA: without SF: is ignored, leaving no file listed', async () => {
    const report = await loadLcovCoverage(projectWith('garbage\nDA:1,1\nDA:x,y\nFN:1,f\nFNDA:1,f\n'));
    assert.ok(report !== undefined);
    assert.equal(report.lines.size, 0);
    assert.equal(report.functions.size, 0);
    assert.equal(hasCoverageData(report.lines, 'src/a.ts'), false);
  });
});

describe('hasCoverageData', () => {
  const coverage: LcovCoverage = new Map([
    ['src/hit.ts', new Set([7])],
    ['src/empty.ts', new Set<number>()],
  ]);

  it('is true exactly when the report has an SF: section for the file', () => {
    assert.equal(hasCoverageData(coverage, 'src/hit.ts'), true);
    // Listed with no hit line: still data (every Node in it is a gap).
    assert.equal(hasCoverageData(coverage, 'src/empty.ts'), true);
    assert.equal(hasCoverageData(coverage, 'src/absent.ts'), false);
    // Keys are matched as-is, the Node's POSIX-relative `file`.
    assert.equal(hasCoverageData(coverage, './src/hit.ts'), false);
    assert.equal(hasCoverageData(new Map(), 'src/hit.ts'), false);
  });
});

describe('hasCoverageGap', () => {
  const coverage: LcovCoverage = new Map([
    ['src/hit.ts', new Set([7])],
    ['src/empty.ts', new Set<number>()],
  ]);

  it('no gap when a line in range was hit; a gap when none was', () => {
    assert.equal(hasCoverageGap(coverage, 'src/hit.ts', 5, 9), false);
    assert.equal(hasCoverageGap(coverage, 'src/hit.ts', 8, 12), true);
    assert.equal(hasCoverageGap(coverage, 'src/empty.ts', 1, 3), true);
  });

  it('never a gap for a file the report omits, or an inverted range', () => {
    assert.equal(hasCoverageGap(coverage, 'src/absent.ts', 1, 3), false);
    assert.equal(hasCoverageGap(coverage, 'src/hit.ts', 9, 5), false);
  });

  it('a gap implies data: gap is never reported without the flag', () => {
    for (const file of ['src/hit.ts', 'src/empty.ts', 'src/absent.ts']) {
      for (const [start, end] of [[1, 3], [5, 9], [8, 12]] as const) {
        if (hasCoverageGap(coverage, file, start, end)) {
          assert.equal(hasCoverageData(coverage, file), true, `${file} ${start}-${end}`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P4-3f review round 1: function-level proof, staleness, a real-tool fixture
// ---------------------------------------------------------------------------

const fns = (entries: [string, number[], number][]): LcovFunctions =>
  new Map(entries.map(([name, lines, hits]) => [name, { lines: new Set(lines), hits }]));

const reportOf = (functions: Record<string, LcovFunctions>, staleFiles: string[] = []): LcovReport => ({
  lines: new Map(Object.keys(functions).map((file) => [file, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])])),
  functions: new Map(Object.entries(functions)),
  staleFiles: new Set(staleFiles),
});

describe('hasFunctionHit', () => {
  const report = reportOf({
    'src/a.ts': fns([
      ['hit', [1], 1],
      ['cold', [6], 0],
      ['inner', [8], 3],
      ['dup', [12, 20], 5],
    ]),
  });

  it('an FN record at the exact start line decides: hit only with FNDA > 0', () => {
    assert.equal(hasFunctionHit(report, 'src/a.ts', 1, 4), true);
    // `cold` starts at 6 with 0 calls: the exact record decides, even though
    // `inner` (line 8, hit) lies inside the range.
    assert.equal(hasFunctionHit(report, 'src/a.ts', 6, 10), false);
  });

  it('without an exact record, a hit record starting inside the range proves it (decorator/comment above, or a nested function)', () => {
    assert.equal(hasFunctionHit(report, 'src/a.ts', 7, 10), true);
  });

  it('no FN record in range, an ambiguous name, a missing file or a DA-only file: no proof', () => {
    assert.equal(hasFunctionHit(report, 'src/a.ts', 2, 5), false);
    assert.equal(hasFunctionHit(report, 'src/a.ts', 12, 14), false, 'dup has two start lines');
    assert.equal(hasFunctionHit(report, 'src/other.ts', 1, 4), false);
    const linesOnly: LcovReport = { lines: new Map([['src/a.ts', new Set([1, 2, 3])]]), functions: new Map(), staleFiles: new Set() };
    assert.equal(hasFunctionHit(linesOnly, 'src/a.ts', 1, 3), false);
  });

  it('inverted or invalid ranges never prove anything', () => {
    assert.equal(hasFunctionHit(report, 'src/a.ts', 4, 1), false);
    // Inverted, but starting exactly on a hit record (`hit` at 1, `inner` at 8).
    assert.equal(hasFunctionHit(report, 'src/a.ts', 1, 0), false);
    assert.equal(hasFunctionHit(report, 'src/a.ts', 8, 7), false);
    assert.equal(hasFunctionHit(report, 'src/a.ts', 1.5, 4), false);
    assert.equal(hasFunctionHit(report, 'src/a.ts', 0, 4), false);
    assert.equal(hasFunctionHit(report, 'src/a.ts', Number.NaN, 4), false);
  });

  it('a stale file (newer than the report) never proves anything', () => {
    assert.equal(hasFunctionHit({ ...report, staleFiles: new Set(['src/a.ts']) }, 'src/a.ts', 1, 4), false);
  });

  it('parses the lcov 2.x FN:<start>,<end>,<name> form', async () => {
    const root = projectWith(['SF:src/a.ts', 'FN:3,9,f', 'FNDA:1,f', 'DA:3,1', 'end_of_record'].join('\n'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), '');
    const past = new Date(Date.now() - 60_000);
    utimesSync(path.join(root, 'src', 'a.ts'), past, past);
    const loaded = await loadLcovCoverage(root);
    assert.deepEqual(loaded!.functions.get('src/a.ts')!.get('f'), { lines: new Set([3]), hits: 1 });
    assert.equal(hasFunctionHit(loaded!, 'src/a.ts', 3, 9), true);
  });
});

describe('a real `node --test --experimental-test-coverage --test-reporter=lcov` report', () => {
  /**
   * `fixtures/lcov-node-test/`: `mod.mjs` exports an uncalled declaration
   * (lines 1–4), an uncalled arrow (6–9) and a called function (11–13);
   * `mod.test.mjs` calls only `called`. `coverage/lcov.info` was captured
   * from `node --test --experimental-test-coverage --test-reporter=lcov
   * --test-reporter-destination=coverage/lcov.info mod.test.mjs` (Node 25).
   * Module load hits lines 1, 5, 6, 9 and 10 (DA > 0), so line data alone
   * says neither uncalled function has a gap; FNDA says 0 for both.
   */
  const FIXTURE = fileURLToPath(new URL('../../fixtures/lcov-node-test', import.meta.url));

  async function loadFixture(sourceNewer: boolean): Promise<LcovReport> {
    const root = mkdtempSync(path.join(os.tmpdir(), 'driller-lcov-fixture-'));
    roots.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    // A checkout sets mtimes arbitrarily, so pin them: the report newer than
    // the source, unless this case wants the source edited after the run.
    const older = new Date(Date.now() - 120_000);
    const newer = new Date(Date.now() - 60_000);
    utimesSync(path.join(root, 'coverage', 'lcov.info'), sourceNewer ? older : newer, sourceNewer ? older : newer);
    utimesSync(path.join(root, 'mod.mjs'), sourceNewer ? newer : older, sourceNewer ? newer : older);
    const report = await loadLcovCoverage(root);
    assert.ok(report !== undefined);
    return report;
  }

  it('the uncalled declaration and arrow are never proven hit, though line data shows no gap; the called one is', async () => {
    const report = await loadFixture(false);
    // The honesty bug this guards: DA alone reports no gap for the uncalled ones.
    assert.equal(hasCoverageGap(report.lines, 'mod.mjs', 1, 4), false);
    assert.equal(hasCoverageGap(report.lines, 'mod.mjs', 6, 9), false);
    assert.equal(hasCoverageData(report.lines, 'mod.mjs'), true);
    assert.equal(hasFunctionHit(report, 'mod.mjs', 1, 4), false, 'neverCalledDecl');
    assert.equal(hasFunctionHit(report, 'mod.mjs', 6, 9), false, 'neverCalledArrow');
    assert.equal(hasFunctionHit(report, 'mod.mjs', 11, 13), true, 'called');
  });

  it('the source edited after the report: nothing in it is proven hit', async () => {
    const report = await loadFixture(true);
    assert.ok(report.staleFiles.has('mod.mjs'));
    assert.equal(hasFunctionHit(report, 'mod.mjs', 11, 13), false);
    // The gap signal's inputs are unchanged by staleness.
    assert.equal(hasCoverageData(report.lines, 'mod.mjs'), true);
  });

  it('a listed file that no longer exists is stale', async () => {
    const report = await loadFixture(false);
    rmSync(path.join(roots.at(-1)!, 'mod.mjs'));
    const reloaded = await loadLcovCoverage(roots.at(-1)!);
    assert.ok(reloaded!.staleFiles.has('mod.mjs'));
    assert.equal(report.staleFiles.size, 0);
  });
});
