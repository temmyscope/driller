import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

it('starts a detached child, outside the runner\'s process group, and returns', () => {
  const sleeper = spawn('sleep', ['601'], { stdio: 'ignore', detached: true });
  sleeper.unref();
  writeFileSync(process.env.FIXTURE_PID_FILE, String(sleeper.pid));
});
