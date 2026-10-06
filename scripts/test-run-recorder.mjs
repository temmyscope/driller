/**
 * `--import` preload for `npm test` (P4-8a): lets `scripts/find-tests.mjs`
 * name the test file behind a problem it finds after the run.
 *
 * In each test file's process (`NODE_TEST_CONTEXT` is set there, not in the
 * runner itself) this appends one JSON line per event to the log file named
 * by `DRILLER_TEST_RUN_LOG`:
 * - `start` / `end` of the file, so a suite killed at the wall limit can
 *   name the file that started last and the ones still running;
 * - every `mkdtemp` directory created, so a leaked temp dir names its file;
 * - every child process spawned, so a leaked process names its file.
 *
 * It only records; it never changes what the wrapped calls do.
 *
 * It is also a watchdog. If the runner (this process's parent) or the
 * supervising `find-tests.mjs` (`DRILLER_TEST_SUPERVISOR_PID`) dies — say it
 * was SIGKILLed, so its wall limit is gone — the test process kills its own
 * process group (the runner's, on POSIX) instead of running on unsupervised.
 *
 * `DRILLER_TEST_WATCHDOG=off` turns the watchdog off. Only the runner's
 * own guard tests set it, so they can prove the runner kills its process
 * group itself rather than relying on this backstop.
 *
 * Without the environment variables (a test run by hand) it does nothing.
 */
import { appendFileSync } from 'node:fs';
import fs from 'node:fs';
import { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const logFile = process.env.DRILLER_TEST_RUN_LOG;

if (logFile !== undefined && process.env.NODE_TEST_CONTEXT !== undefined && process.argv[1] !== undefined) {
  const file = path.relative(process.cwd(), path.resolve(process.argv[1]));
  const record = (event) => {
    try {
      appendFileSync(logFile, `${JSON.stringify({ ...event, file })}\n`);
    } catch {
      // Recording is best-effort; a missing log must never fail a test.
    }
  };

  record({ event: 'start' });

  const parentPid = process.ppid;
  const supervisorPid = Number(process.env.DRILLER_TEST_SUPERVISOR_PID);
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
  const watchdog = setInterval(() => {
    const orphaned = process.ppid !== parentPid;
    const unsupervised = Number.isInteger(supervisorPid) && supervisorPid > 0 && !isAlive(supervisorPid);
    if (!orphaned && !unsupervised) return;
    process.stderr.write(`npm test: ${file}: the test runner is gone; stopping\n`);
    if (process.platform !== 'win32') {
      try {
        process.kill(0, 'SIGKILL'); // the whole runner process group
      } catch {
        // fall through to exiting alone
      }
    }
    process.exit(1);
  }, 500);
  watchdog.unref();
  if (process.env.DRILLER_TEST_WATCHDOG === 'off') clearInterval(watchdog);
  process.on('exit', () => record({ event: 'end' }));

  const recordDir = (dir) => record({ event: 'mkdtemp', path: String(dir) });

  const { mkdtempSync, mkdtemp } = fs;
  fs.mkdtempSync = function (...args) {
    const dir = mkdtempSync.apply(this, args);
    recordDir(dir);
    return dir;
  };
  fs.mkdtemp = function (...args) {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = (error, dir) => {
        if (!error) recordDir(dir);
        callback(error, dir);
      };
    }
    return mkdtemp.apply(this, args);
  };
  const promisesMkdtemp = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function (...args) {
    const dir = await promisesMkdtemp.apply(this, args);
    recordDir(dir);
    return dir;
  };
  // Make `import { mkdtempSync } from 'node:fs'` (and `node:fs/promises`)
  // see the wrappers too.
  syncBuiltinESMExports();

  // `spawn`, `exec`, `execFile` and `fork` all go through this method.
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (...args) {
    const result = spawn.apply(this, args);
    if (this.pid !== undefined) {
      record({ event: 'spawn', pid: this.pid, command: (this.spawnargs ?? []).join(' ') });
    }
    return result;
  };
}
