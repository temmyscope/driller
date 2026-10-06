import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

it('starts a child and returns without waiting for it', () => {
  const sleeper = spawn('sleep', ['600'], { stdio: 'ignore' });
  sleeper.unref();
  writeFileSync(process.env.FIXTURE_PID_FILE, String(sleeper.pid));
});
