/**
 * Driven by `harness.test.ts` (not a test itself: `e2e/*.test.ts` is not
 * recursive). Sets up what a real run has — temp dirs and a detached
 * "app" process group whose grandchild ignores SIGTERM — installs the
 * harness's exit handlers and teardown, prints its state, then waits for a
 * signal (or throws, with `throw` as argv[2]).
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

import {
  createTeardown,
  groupMembers,
  installExitHandlers,
  killProcessGroup,
  listProcesses,
  makeTempDir,
  removeTempDirs,
  TEMP_PREFIXES,
} from '../harness';

const dirs = [makeTempDir(TEMP_PREFIXES.userData), makeTempDir(TEMP_PREFIXES.fixture)];
// The "app": a group leader plus a grandchild that ignores SIGTERM, so only the SIGKILL escalation ends it.
const app = spawn('sh', ['-c', 'trap "" TERM; sleep 120 & wait'], { detached: true, stdio: 'ignore' });
const pgid = app.pid!;
const order: string[] = [];

const teardown = createTeardown({
  closeCdp: () => {
    order.push('closeCdp');
  },
  killAppGroup: async () => {
    order.push('killAppGroup');
    await killProcessGroup(pgid, 300);
  },
  stopOwnCbm: () => {
    order.push('stopOwnCbm');
  },
  removeTempDirs: () => {
    order.push('removeTempDirs');
    const left = removeTempDirs(dirs);
    if (left.length > 0) throw new Error(`left: ${left.join(', ')}`);
  },
  checkSurvivors: () => {
    order.push('checkSurvivors');
    const survivors = groupMembers(listProcesses(), pgid);
    if (survivors.length > 0) throw new Error(`survivors: ${survivors.map((p) => p.pid).join(', ')}`);
  },
});

installExitHandlers((exitCode, reason) => {
  void teardown().then((report) => {
    process.stdout.write(`${JSON.stringify({ done: true, reason, order, failures: report.failures })}\n`);
    process.exit(exitCode);
  });
});

// Wait until the grandchild is up, so the group really has a SIGTERM-proof member.
const waitForGroup = setInterval(() => {
  if (groupMembers(listProcesses(), pgid).length >= 2) {
    clearInterval(waitForGroup);
    process.stdout.write(`${JSON.stringify({ ready: true, dirs, pgid })}\n`);
    if (process.argv[2] === 'throw') {
      setTimeout(() => {
        throw new Error('boom');
      }, 10);
    }
  }
}, 50);
// Keep the process alive until a signal arrives.
setInterval(() => {}, 1_000);
