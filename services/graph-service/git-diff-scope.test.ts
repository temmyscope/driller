/**
 * P4-2 phase 3c: `parseChangedLines` reads each changed file's changed line
 * ranges out of `git diff --unified=0` output — the input to changed-contract
 * detection. The last test runs real git in its own temp repo.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { computeDiffScope, parseChangedLines, readHeadCommit } from './git-diff-scope';

describe('parseChangedLines', () => {
  it('reads each hunk header as a range in the new file, per file', () => {
    const diff = [
      'diff --git a/src/types.ts b/src/types.ts',
      'index 1..2 100644',
      '--- a/src/types.ts',
      '+++ b/src/types.ts',
      '@@ -5 +5 @@ export interface A {',
      '-  a: string;',
      '+  a: number;',
      '@@ -10,0 +11,2 @@',
      '+  b: string;',
      '+  c: string;',
      '@@ -20,3 +22,0 @@',
      '-x',
      '-y',
      '-z',
      'diff --git a/lib/new file.ts b/lib/new file.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/lib/new file.ts\t',
      '@@ -0,0 +1,3 @@',
      '+one',
      '+two',
      '+three',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    assert.deepEqual(parseChangedLines(diff), {
      'src/types.ts': [
        { start: 5, end: 5 },
        { start: 11, end: 12 },
        // A pure deletion after new line 22: the empty range between 22 and 23.
        { start: 23, end: 22 },
      ],
      'lib/new file.ts': [{ start: 1, end: 3 }],
    });
  });

  it('never takes a changed line that reads like a header for one, and records nothing for a deleted file', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +2,2 @@',
      '+++ b/evil.ts',
      '+@@ -1 +900 @@',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    ].join('\n');
    assert.deepEqual(parseChangedLines(diff), { 'a.ts': [{ start: 2, end: 3 }] });
    assert.equal(Object.hasOwn(parseChangedLines(diff), 'gone.ts'), false);
  });

  it('lists a file named with no hunks (a pure rename, a binary file, a mode change) with [] — read, nothing changed', () => {
    assert.deepEqual(parseChangedLines(''), {});
    assert.deepEqual(
      parseChangedLines(
        [
          'diff --git a/x.ts b/y.ts',
          'similarity index 100%',
          'rename from x.ts',
          'rename to y.ts',
          'diff --git a/img.png b/img.png',
          'Binary files a/img.png and b/img.png differ',
          'diff --git a/run me.sh b/run me.sh',
          'old mode 100644',
          'new mode 100755',
        ].join('\n'),
      ),
      { 'y.ts': [], 'img.png': [], 'run me.sh': [] },
    );
  });

  it('leaves a C-quoted path out entirely, so the caller treats it as unread', () => {
    const diff = [
      'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
      '--- "a/tab\\there.ts"',
      '+++ "b/tab\\there.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    assert.deepEqual(parseChangedLines(diff), {});
  });

  it('computeDiffScope reports the committed changed lines of a real repository', { timeout: 30_000 }, async (t) => {
    if (spawnSync('git', ['--version']).status !== 0) {
      t.skip('git is not installed.');
      return;
    }
    const repo = mkdtempSync(path.join(os.tmpdir(), 'driller-changed-lines-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
          cwd: repo,
          stdio: 'pipe',
        });
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(repo, 'types.ts'), ['// 1', 'interface A {', '  a: string;', '}', '// 5', ''].join('\n'));
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'feature');
      writeFileSync(path.join(repo, 'types.ts'), ['// 1', 'interface A {', '  a: number;', '}', '// 5', ''].join('\n'));
      git('add', '.');
      git('commit', '-q', '-m', 'change a field');
      // Uncommitted edits are never in scope.
      writeFileSync(path.join(repo, 'types.ts'), 'changed\n');
      const result = await computeDiffScope(repo, 'main');
      assert.equal(result.status, 'resolved');
      assert.deepEqual(result.status === 'resolved' ? [result.changedFiles, result.changedLines] : undefined, [
        ['types.ts'],
        { 'types.ts': [{ start: 3, end: 3 }] },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it(
    "diffs against the merge base: the base branch's own edits after the fork never count",
    { timeout: 30_000 },
    async (t) => {
      if (spawnSync('git', ['--version']).status !== 0) {
        t.skip('git is not installed.');
        return;
      }
      const repo = mkdtempSync(path.join(os.tmpdir(), 'driller-merge-base-'));
      try {
        const git = (...args: string[]) =>
          execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
            cwd: repo,
            stdio: 'pipe',
          });
        const lines = Array.from({ length: 10 }, (_, i) => `// ${i + 1}`);
        const write = (edit: (copy: string[]) => void) => {
          const copy = [...lines];
          edit(copy);
          writeFileSync(path.join(repo, 'types.ts'), `${copy.join('\n')}\n`);
        };
        git('init', '-q', '-b', 'main');
        write(() => {});
        git('add', '.');
        git('commit', '-q', '-m', 'base');
        git('checkout', '-q', '-b', 'feature');
        write((copy) => {
          copy[1] = '// feature edit';
        });
        git('commit', '-q', '-am', 'feature edit on line 2');
        // main moves on after the fork: an edit on line 8 the feature never saw.
        git('checkout', '-q', 'main');
        write((copy) => {
          copy[7] = '// main edit';
        });
        git('commit', '-q', '-am', 'main edit on line 8');
        git('checkout', '-q', 'feature');
        const result = await computeDiffScope(repo, 'main');
        assert.equal(result.status, 'resolved');
        assert.deepEqual(result.status === 'resolved' ? result.changedLines : undefined, {
          'types.ts': [{ start: 2, end: 2 }],
        });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});

describe('P5-a: readHeadCommit', { skip: spawnSync('git', ['--version']).status !== 0 && 'git is not installed' }, () => {
  it('a repository: the HEAD commit, following a commit and a checkout', { timeout: 30_000 }, async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'driller-head-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
          cwd: repo,
          stdio: 'pipe',
        })
          .toString()
          .trim();
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(repo, 'a.ts'), '// a\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      assert.match(base, /^[0-9a-f]{40}$/);
      assert.equal(await readHeadCommit(repo), base);
      git('checkout', '-q', '-b', 'feature');
      git('commit', '-q', '--allow-empty', '-m', 'next');
      const next = git('rev-parse', 'HEAD');
      assert.notEqual(next, base);
      assert.equal(await readHeadCommit(repo), next);
      git('checkout', '-q', 'main');
      assert.equal(await readHeadCommit(repo), base);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('an unborn HEAD (no commit yet), a folder in no repository, and a missing folder: undefined', { timeout: 30_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'driller-head-none-'));
    try {
      const unborn = path.join(root, 'unborn');
      mkdirSync(unborn);
      execFileSync('git', ['init', '-q'], { cwd: unborn, stdio: 'pipe' });
      const plain = path.join(root, 'plain');
      mkdirSync(plain);
      assert.equal(await readHeadCommit(unborn), undefined, 'unborn HEAD');
      assert.equal(await readHeadCommit(plain), undefined, 'not a repository');
      assert.equal(await readHeadCommit(path.join(root, 'missing')), undefined, 'a failed call');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
