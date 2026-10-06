// Hangs outside any test, so only the suite wall limit can stop it. First it
// starts a grandchild of the runner, whose PID it records, so the guard test
// can check the whole process group was killed, not just the runner. Its
// own PID goes alongside, so the guard test can always clean up after itself.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const sleeper = spawn('sleep', ['600'], { stdio: 'ignore' });
writeFileSync(`${process.env.FIXTURE_PID_FILE}.self`, String(process.pid));
writeFileSync(process.env.FIXTURE_PID_FILE, String(sleeper.pid));
await new Promise(() => {
  setInterval(() => {}, 1_000);
});
