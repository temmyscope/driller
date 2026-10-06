import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

it('a Node subprocess is refused the network too', () => {
  // 192.0.2.1 is TEST-NET-1: no DNS lookup, and nothing answers there.
  const child = spawnSync(
    process.execPath,
    ['-e', "require('node:net').connect(9, '192.0.2.1').on('error', () => {}).destroy()"],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.notEqual(child.status, 0, child.stderr);
  assert.match(child.stderr, /NetworkDisabledInTests: 192\.0\.2\.1/);
});
