import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

it('git reads no global or system config', () => {
  const git = spawnSync('git', ['config', '--show-origin', '--list'], { encoding: 'utf8', cwd: '/' });
  assert.doesNotMatch(git.stdout ?? '', /^file:/m, git.stdout);
});
