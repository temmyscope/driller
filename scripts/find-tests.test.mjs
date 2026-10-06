/**
 * Guard tests for `scripts/find-tests.mjs` (P4-8a): its time limits, leak
 * checks and network guard, driven through the real runner in a child
 * process against fixture files in `scripts/fixtures/runner/`.
 *
 * The fixtures hang, leak or reach for the network on purpose. They are
 * named `*.fixture.mjs` one directory below `scripts/`, so no
 * `TEST_PATTERNS` entry can pick them up. Each run gets a private TMPDIR, so
 * the inner leak check never sees the outer suite's temp dirs (and the outer
 * check never sees the inner fixtures'), and tightened limits, so the
 * timeout and overrun cases take seconds rather than 20 s / 240 s.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = 'scripts/fixtures/runner';
const isPosix = process.platform !== 'win32';

const fixture = (name) => `${FIXTURES}/${name}.fixture.mjs`;

const tempRoots = [];
/** Fixture processes, killed at the end if a broken guard left them running. */
const fixturePids = new Set();
after(() => {
  for (const pid of fixturePids) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const readPid = (file) => {
  try {
    return Number(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Runs `find-tests.mjs` on `files` and resolves when it exits. Never hangs:
 * past `giveUpMs` the runner gets SIGTERM (which it forwards to its process
 * group), then SIGKILL; fixture PIDs are collected for `after()` to kill.
 * `tmp` is the parent temp dir the runner makes its own run dir in; runs
 * may share one.
 */
function runRunner(files, { env = {}, giveUpMs = 15_000, onStart, tmp = newTempRoot() } = {}) {
  const pidFile = path.join(tmp, `fixture-${files.length}-${Math.random().toString(36).slice(2)}.pid`);
  const childEnv = {
    ...process.env,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    FIXTURE_PID_FILE: pidFile,
    // Off by default here, so a test proves the runner's own group kill and
    // not the test processes' backstop; the watchdog test turns it on.
    DRILLER_TEST_WATCHDOG: 'off',
    ...env,
  };
  // This file itself runs under `node --test`; the inner runner must not
  // think it is one of the outer runner's test processes.
  for (const key of [
    'NODE_TEST_CONTEXT',
    'DRILLER_TEST_RUN_LOG',
    'DRILLER_TEST_SUPERVISOR_PID',
    'DRILLER_ALLOW_NETWORK_FILES',
  ]) {
    delete childEnv[key];
  }
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['scripts/find-tests.mjs', ...files], {
    cwd: APP_ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const fixturePid = () => readPid(pidFile);
  const fixtureSelfPid = () => readPid(`${pidFile}.self`);
  onStart?.(child, fixturePid);

  let gaveUp = false;
  const termTimer = setTimeout(() => {
    gaveUp = true;
    child.kill('SIGTERM');
  }, giveUpMs);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), giveUpMs + 3_000);

  return new Promise((resolve) => {
    const finish = (code, signal) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      for (const pid of [fixturePid(), fixtureSelfPid()]) {
        if (pid !== undefined) fixturePids.add(pid);
      }
      resolve({
        code,
        signal,
        output,
        ms: Date.now() - startedAt,
        tmp,
        fixturePid: fixturePid(),
        fixtureSelfPid: fixtureSelfPid(),
        gaveUp,
      });
    };
    child.on('close', finish);
    // 'close' waits for every holder of the output pipes; if a broken guard
    // let a test process outlive the runner, don't wait on it.
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 2_000).unref());
  });
}

function newTempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'driller-runner-guard-'));
  tempRoots.push(root);
  return root;
}

/** The run dirs (`npm-test-run-*`) a runner left in `root`. */
const runDirsIn = (root) => readdirSync(root).filter((name) => name.startsWith('npm-test-run-'));

/**
 * Node 22's runner applies `--test-timeout` to each file's process as well,
 * so there a hung test fails its whole file at the timeout and the file's
 * later tests never run. From Node 24 the timeout ends the test alone.
 * (P4-8b: checked on 22.23.3, 24.21.0 and 25.6.1.)
 */
const timeoutEndsFile = Number(process.versions.node.split('.')[0]) < 24;

const failCount = (output) => Number(output.match(/\bfail (\d+)/)?.[1]);

describe('npm test runner guards (P4-8a)', { concurrency: 4 }, () => {
  it('a clean run passes, removes its temp dir, and the limit overrides can only tighten the limits', async () => {
    const run = await runRunner([fixture('pass')], {
      env: { DRILLER_TEST_TIMEOUT_MS: '999999', DRILLER_TEST_WALL_LIMIT_MS: '9999999' },
    });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /passes/);
    assert.match(run.output, /20 s per test, 240 s for the suite/);
    assert.deepEqual(runDirsIn(run.tmp), [], 'the run dir of a clean run is removed');
  });

  it('a test that never settles fails at the per-test timeout and the file carries on', async () => {
    const run = await runRunner([fixture('timeout')], {
      env: { DRILLER_TEST_TIMEOUT_MS: '1000', DRILLER_TEST_WALL_LIMIT_MS: '10000' },
    });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /test timed out after 1000ms/);
    if (timeoutEndsFile) {
      assert.match(run.output, /✖ scripts\/fixtures\/runner\/timeout\.fixture\.mjs/);
    } else {
      assert.match(run.output, /✔ runs after the timed-out test/);
    }
    assert.doesNotMatch(run.output, /exceeded/);
  });

  it('a run that hangs outside any test is killed at the wall limit, process group and all', { skip: !isPosix }, async () => {
    const run = await runRunner([fixture('overrun')], {
      env: { DRILLER_TEST_WALL_LIMIT_MS: '2000' },
    });
    assert.equal(run.gaveUp, false, `the wall limit never fired:\n${run.output}`);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /npm test exceeded 2 s; killed the runner/);
    assert.match(run.output, /last test file started: scripts\/fixtures\/runner\/overrun\.fixture\.mjs/);
    // The group kill took the grandchild with it; nothing was left for the
    // leak check to find.
    assert.doesNotMatch(run.output, /outlived the test runner/);
    assert.ok(run.fixturePid !== undefined, run.output);
    assert.ok(await waitFor(() => !isAlive(run.fixturePid), 2_000), `PID ${run.fixturePid} survived`);
  });

  it('Ctrl-C (SIGINT) kills the runner\'s process group too, and exits 130', { skip: !isPosix }, async () => {
    const run = await runRunner([fixture('overrun')], {
      giveUpMs: 15_000,
      onStart: (child, fixturePid) => {
        void waitFor(() => fixturePid() !== undefined, 10_000).then(() => child.kill('SIGINT'));
      },
    });
    assert.equal(run.gaveUp, false, run.output);
    assert.equal(run.code, 130, run.output);
    assert.match(run.output, /SIGINT received; killed the runner/);
    assert.ok(run.fixturePid !== undefined, run.output);
    assert.ok(await waitFor(() => !isAlive(run.fixturePid), 2_000), `PID ${run.fixturePid} survived`);
  });

  it('if the supervisor itself is SIGKILLed, the test processes stop their process group', { skip: !isPosix }, async () => {
    const run = await runRunner([fixture('overrun')], {
      giveUpMs: 15_000,
      env: { DRILLER_TEST_WATCHDOG: 'on' },
      onStart: (child, fixturePid) => {
        void waitFor(() => fixturePid() !== undefined, 10_000).then(() => child.kill('SIGKILL'));
      },
    });
    assert.equal(run.signal, 'SIGKILL', run.output);
    assert.ok(run.fixturePid !== undefined && run.fixtureSelfPid !== undefined, run.output);
    assert.ok(await waitFor(() => !isAlive(run.fixtureSelfPid), 3_000), `test process ${run.fixtureSelfPid} survived`);
    assert.ok(await waitFor(() => !isAlive(run.fixturePid), 3_000), `PID ${run.fixturePid} survived`);
  });

  it('anything left in the run\'s temp dir fails the run, naming the path and its test file, and is kept', async () => {
    const run = await runRunner([fixture('leak-temp-dir')]);
    assert.equal(run.code, 1, run.output);
    const [runDir, ...others] = runDirsIn(run.tmp);
    assert.equal(others.length, 0, run.output);
    assert.ok(runDir !== undefined, `the run dir was removed:\n${run.output}`);
    const leaked = readdirSync(path.join(run.tmp, runDir)).filter((name) => name.startsWith('driller-scope-git-'));
    assert.equal(leaked.length, 1, run.output);
    assert.ok(
      run.output.includes(
        `${path.join(run.tmp, runDir, leaked[0])} (created by scripts/fixtures/runner/leak-temp-dir.fixture.mjs)`,
      ),
      run.output,
    );
  });

  it('two runs sharing a parent temp dir each see only their own leftovers', async () => {
    const tmp = newTempRoot();
    const [clean, leaky] = await Promise.all([
      runRunner([fixture('pass'), fixture('network-loopback')], { tmp }),
      runRunner([fixture('leak-temp-dir')], { tmp }),
    ]);
    assert.equal(clean.code, 0, clean.output);
    assert.equal(leaky.code, 1, leaky.output);
    assert.equal(leaky.output.match(/\(created by /g)?.length, 1, leaky.output);
    assert.equal(runDirsIn(tmp).length, 1, 'only the leaky run keeps its dir');
  });

  it('a leaked child process fails the run, naming its PID, command and test file, then is killed', { skip: !isPosix }, async () => {
    const run = await runRunner([fixture('leak-child')]);
    assert.equal(run.code, 1, run.output);
    assert.ok(run.fixturePid !== undefined, run.output);
    assert.ok(
      run.output.includes(
        `PID ${run.fixturePid}: sleep 600 (spawned by scripts/fixtures/runner/leak-child.fixture.mjs)`,
      ),
      run.output,
    );
    assert.ok(await waitFor(() => !isAlive(run.fixturePid), 2_000), `PID ${run.fixturePid} survived`);
  });

  it('a leaked detached child, outside the process group, is caught and killed too', { skip: !isPosix }, async () => {
    const run = await runRunner([fixture('leak-child-detached')]);
    assert.equal(run.code, 1, run.output);
    assert.ok(run.fixturePid !== undefined, run.output);
    assert.ok(
      run.output.includes(
        `PID ${run.fixturePid}: sleep 601 (spawned by scripts/fixtures/runner/leak-child-detached.fixture.mjs)`,
      ),
      run.output,
    );
    assert.ok(await waitFor(() => !isAlive(run.fixturePid), 2_000), `PID ${run.fixturePid} survived`);
  });

  it('a child still finishing its exit when the runner ends is given a moment, not reported', { skip: !isPosix }, async () => {
    const run = await runRunner([fixture('slow-exit-child')]);
    assert.equal(run.code, 0, run.output);
    assert.doesNotMatch(run.output, /outlived the test runner/);
  });

  it('a recorded PID now running a different command is not blamed or killed', { skip: !isPosix }, async () => {
    const foreign = spawn('sleep', ['603'], { stdio: 'ignore' });
    try {
      const run = await runRunner([fixture('recycled-pid')], {
        env: { FIXTURE_FOREIGN_PID: String(foreign.pid) },
      });
      assert.equal(run.code, 0, run.output);
      assert.ok(isAlive(foreign.pid), 'the unrelated process was killed');
    } finally {
      foreign.kill('SIGKILL');
    }
  });

  it('fetch, sockets (an empty socket path included) and a WebSocket to a remote host each fail their test', async () => {
    const expected = typeof WebSocket === 'function' ? 4 : 3;
    const run = await runRunner([fixture('network-remote')]);
    assert.equal(run.code, 1, run.output);
    assert.equal(
      run.output.match(/NetworkDisabledInTests: example\.com \(in scripts\/fixtures\/runner\/network-remote\.fixture\.mjs/g)?.length,
      expected,
      run.output,
    );
    assert.equal(failCount(run.output), expected, run.output);
  });

  it('a Node subprocess a test starts is refused the network too', async () => {
    const run = await runRunner([fixture('network-subprocess')]);
    assert.equal(run.code, 0, run.output);
  });

  it('a refused attempt the test swallows still fails its file', async () => {
    const run = await runRunner([fixture('network-swallowed')]);
    assert.equal(run.code, 1, run.output);
    assert.match(
      run.output,
      /NetworkDisabledInTests: scripts\/fixtures\/runner\/network-swallowed\.fixture\.mjs attempted non-loopback network access \(example\.com\)/,
    );
  });

  it('loopback and Unix socket connections are allowed', async () => {
    const run = await runRunner([fixture('network-loopback')]);
    assert.equal(run.code, 0, run.output);
    assert.doesNotMatch(run.output, /NetworkDisabledInTests/);
  });

  it('a top-of-file // @allow-network comment opts that file out', async () => {
    const run = await runRunner([fixture('network-opt-out')]);
    assert.equal(run.code, 0, run.output);
    assert.match(
      run.output,
      /network allowed in scripts\/fixtures\/runner\/network-opt-out\.fixture\.mjs \(fixture proving the per-file opt-out/,
    );
  });

  it('git sees no global or system config', async () => {
    // A global config that the run must ignore.
    const home = newTempRoot();
    writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = from-the-developer\n');
    const run = await runRunner([fixture('git-config')], { env: { HOME: home, XDG_CONFIG_HOME: home } });
    assert.equal(run.code, 0, run.output);
  });
});
