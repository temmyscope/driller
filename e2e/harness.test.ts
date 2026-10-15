/**
 * P4-8h: the e2e harness's pure parts and its process/temp-dir machinery,
 * under `npm test`. Nothing here starts Electron, forge or CBM: the "app" is
 * a shell process group, so these run beside an ambient CBM daemon safely.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, globSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  E2E_WALL_LIMIT_MS,
  EXIT,
  KILL_GRACE_MS,
  LANDING_LIMIT_MS,
  MCP_SERVER_PORT,
  STEP_LIMIT_MS,
  StepTimeoutError,
  TEARDOWN_ORDER,
  TEMP_PREFIXES,
  appEnv,
  artifactDir,
  assertIsolatedUserData,
  cbmProcessesToStop,
  createTeardown,
  decidePreflight,
  diffSnapshots,
  findCbmProcesses,
  forgeStartCommand,
  formatStepTable,
  groupMembers,
  isCbmCommand,
  isElectronMainCommand,
  isPortFree,
  killProcessGroup,
  listProcesses,
  makeTempDir,
  parseDevToolsUrl,
  parsePs,
  realUserDataDir,
  refusedHosts,
  removeTempDirs,
  runSteps,
  snapshotDir,
  startAppProcess,
  KILL_REAP_MS,
  terminateThenKill,
  withNetworkGuard,
  withTimeout,
  writeTextArtifact,
  type ProcessInfo,
  type Step,
  type TeardownPhase,
} from './harness';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(E2E_DIR);
const OWN_CBM = '/repo/app/node_modules/codebase-memory-mcp';

/** Temp dirs a test made; removed in `after` whatever happened. */
const made: string[] = [];
after(() => {
  for (const dir of made) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already gone.
    }
  }
  removeTempDirs(made);
});

describe('limits', () => {
  it('are the founder-approved values', () => {
    assert.equal(E2E_WALL_LIMIT_MS, 300_000);
    assert.equal(STEP_LIMIT_MS, 60_000);
    assert.equal(LANDING_LIMIT_MS, 90_000);
    assert.equal(KILL_GRACE_MS, 5_000);
    assert.equal(MCP_SERVER_PORT, 39217);
  });
});

describe('parsePs / CBM detection', () => {
  const ps = [
    '  1514     1 Ss   /Users/me/.local/bin/codebase-memory-mcp --cbm-daemon-internal',
    '  1836   633 S    /Users/me/.local/bin/codebase-memory-mcp',
    '  2000  2000 Z    (codebase-memory-mcp)',
    '  2001  2001 S    /usr/local/bin/node /repo/app/node_modules/codebase-memory-mcp/bin.js',
    '  2002  2001 S    /repo/app/node_modules/codebase-memory-mcp/bin/codebase-memory-mcp',
    '  2003  2003 S    pgrep -fl codebase-memory-mcp',
    '  2004  2003 S    /usr/bin/vim notes-on-codebase-memory-mcp.md',
    'garbage line',
  ].join('\n');

  it('parses pid, pgid and command, and drops zombies', () => {
    const rows = parsePs(ps);
    assert.deepEqual(rows[0], {
      pid: 1514,
      pgid: 1,
      command: '/Users/me/.local/bin/codebase-memory-mcp --cbm-daemon-internal',
    });
    assert.equal(rows.find((r) => r.pid === 2000), undefined);
    assert.equal(rows.length, 6);
  });

  it('finds the native binary (daemon or client) and the npm shim, never a command that merely mentions it', () => {
    assert.deepEqual(
      findCbmProcesses(parsePs(ps)).map((p) => p.pid),
      [1514, 1836, 2001, 2002],
    );
    assert.equal(isCbmCommand('pgrep -fl codebase-memory-mcp'), false);
    assert.equal(isCbmCommand('less /x/codebase-memory-mcp/bin.js.orig'), false);
    assert.equal(isCbmCommand('node C:\\x\\codebase-memory-mcp\\bin.js daemon stop'), true);
  });

  it('P5-a review round 1: isElectronMainCommand picks Electron main, never its --type= helpers or forge', () => {
    const bin = '/repo/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
    assert.equal(isElectronMainCommand(`${bin} . --remote-debugging-port=0 --user-data-dir=/tmp/u`), true);
    assert.equal(isElectronMainCommand('/repo/node_modules/electron/dist/electron .'), true);
    assert.equal(isElectronMainCommand('C:\\repo\\node_modules\\electron\\dist\\electron.exe .'), true);
    assert.equal(isElectronMainCommand(`/repo/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer`), false);
    assert.equal(isElectronMainCommand(`${bin} --type=utility --utility-sub-type=node.mojom.NodeService`), false);
    assert.equal(isElectronMainCommand('/usr/local/bin/node /repo/node_modules/@electron-forge/cli/dist/electron-forge-start.js -- --remote-debugging-port=0'), false);
  });

  it('never lists the harness itself', () => {
    const self: ProcessInfo = { pid: process.pid, pgid: 1, command: '/x/codebase-memory-mcp' };
    assert.deepEqual(findCbmProcesses([self]), []);
  });

  it('stops only CBM processes that are new since preflight and run from this checkout', () => {
    const before = parsePs(ps).filter((p) => p.pid < 2000);
    const after: ProcessInfo[] = [
      ...before,
      { pid: 3001, pgid: 3001, command: `${OWN_CBM}/bin/codebase-memory-mcp --cbm-daemon-internal` },
      { pid: 3002, pgid: 3002, command: `node ${OWN_CBM}/bin.js daemon stop` },
      // Started mid-run by the developer's own tools: a different binary.
      { pid: 3003, pgid: 3003, command: '/Users/me/.local/bin/codebase-memory-mcp --cbm-daemon-internal' },
      // A sibling checkout whose path shares this one's prefix.
      { pid: 3004, pgid: 3004, command: `${OWN_CBM}-fork/bin/codebase-memory-mcp` },
    ];
    assert.deepEqual(
      cbmProcessesToStop(before, after, OWN_CBM).map((p) => p.pid),
      [3001, 3002],
    );
    // A pre-existing process is never stopped, even from this checkout.
    assert.deepEqual(cbmProcessesToStop(after, after, OWN_CBM), []);
  });

  it('reads the real process table', () => {
    const me = listProcesses().find((p) => p.pid === process.pid);
    assert.ok(me, 'this test process is listed');
  });
});

describe('decidePreflight', () => {
  const daemon: ProcessInfo = { pid: 1514, pgid: 1514, command: '/u/.local/bin/codebase-memory-mcp --cbm-daemon-internal' };

  it('passes on a clean machine', () => {
    assert.deepEqual(decidePreflight({ platform: 'darwin', portFree: true, cbmProcesses: [] }), { ok: true });
  });

  it('refuses with exit 2 while port 39217 is bound', () => {
    const decision = decidePreflight({ platform: 'darwin', portFree: false, cbmProcesses: [] });
    assert.equal(decision.ok, false);
    assert.ok(!decision.ok);
    assert.equal(decision.exitCode, 2);
    assert.match(decision.reasons.join('\n'), /Port 39217 is already bound/);
  });

  it("refuses with exit 2 and the tracker's instruction while a CBM runs, naming each PID", () => {
    const decision = decidePreflight({ platform: 'linux', portFree: true, cbmProcesses: [daemon] });
    assert.ok(!decision.ok);
    assert.equal(decision.exitCode, EXIT.refused);
    const text = decision.reasons.join('\n');
    assert.match(text, /PID 1514: .*--cbm-daemon-internal/);
    assert.match(text, /Make sure no ambient codebase-memory-mcp is running/);
    assert.match(text, /stops only that one/);
  });

  it('reports every reason at once', () => {
    const decision = decidePreflight({ platform: 'win32', portFree: false, cbmProcesses: [daemon] });
    assert.ok(!decision.ok);
    assert.equal(decision.reasons.length, 3);
  });
});

describe('isPortFree', () => {
  it('is false while something listens on the port, true once it closes', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    assert.equal(await isPortFree(port), false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await isPortFree(port), true);
    // The probe released the port again.
    assert.equal(await isPortFree(port), true);
  });
});

describe('userData isolation', () => {
  it("resolves driller's real userData per platform", () => {
    assert.equal(realUserDataDir('darwin', {}, '/Users/me'), '/Users/me/Library/Application Support/driller');
    assert.equal(realUserDataDir('linux', {}, '/home/me'), '/home/me/.config/driller');
    assert.equal(realUserDataDir('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/me'), '/cfg/driller');
    assert.equal(realUserDataDir('win32', { APPDATA: 'C:/AppData' }, 'C:/me'), path.join('C:/AppData', 'driller'));
  });

  it('accepts a temp userData and refuses one overlapping the real dir or without the prefix', () => {
    const real = '/Users/me/Library/Application Support/driller';
    assert.doesNotThrow(() => assertIsolatedUserData(`/tmp/${TEMP_PREFIXES.userData}abc`, real));
    assert.throws(() => assertIsolatedUserData(`${real}/${TEMP_PREFIXES.userData}abc`, real), /overlaps/);
    assert.throws(() => assertIsolatedUserData(`/Users/${TEMP_PREFIXES.userData}x`, `/Users/${TEMP_PREFIXES.userData}x/driller`), /overlaps/);
    assert.throws(() => assertIsolatedUserData(real, real), /not a driller-e2e-userdata-/);
    assert.throws(() => assertIsolatedUserData('/tmp/driller-x', real), /not a driller-e2e-userdata-/);
  });

  it('snapshots by stat only and reports every change', () => {
    const dir = makeTempDir('driller-e2e-snapshot-');
    made.push(dir);
    const missing = path.join(dir, 'absent');
    assert.deepEqual(snapshotDir(missing), { exists: false, entries: {} });

    writeFileSync(path.join(dir, 'driller-settings.json'), '{}');
    writeFileSync(path.join(dir, 'gone.json'), '{}');
    utimesSync(dir, new Date(1_000_000), new Date(1_000_000));
    const before = snapshotDir(dir);
    assert.deepEqual(diffSnapshots(before, snapshotDir(dir)), []);

    utimesSync(path.join(dir, 'driller-settings.json'), new Date(), new Date(2_000_000));
    writeFileSync(path.join(dir, 'new.json'), '{}');
    // Removing through a fresh write-then-delete keeps the test independent of rm's own mtime rules.
    writeFileSync(path.join(dir, 'gone.json'), '');
    removeTempDirs([path.join(dir, 'gone.json')]);
    assert.deepEqual(diffSnapshots(before, snapshotDir(dir)), [
      'directory mtime changed',
      'driller-settings.json modified',
      'gone.json removed',
      'new.json added',
    ]);

    mkdirSync(missing);
    assert.deepEqual(diffSnapshots(snapshotDir(path.join(dir, 'nope')), snapshotDir(missing)), ['created']);
  });
});

describe('temp-dir lifecycle', () => {
  it('makes realpath dirs with the given prefix and removes them', () => {
    const dir = makeTempDir(TEMP_PREFIXES.userData);
    made.push(dir);
    assert.ok(path.basename(dir).startsWith(TEMP_PREFIXES.userData));
    assert.ok(path.isAbsolute(dir) && existsSync(dir));
    writeFileSync(path.join(dir, 'Local State'), '{}');
    mkdirSync(path.join(dir, 'node-records'));
    assert.deepEqual(removeTempDirs([dir, path.join(dir, 'never-existed')]), []);
    assert.equal(existsSync(dir), false);
  });

  it('reports a dir it could not remove', { skip: process.getuid?.() === 0 ? 'root ignores permissions' : false }, () => {
    const parent = makeTempDir('driller-e2e-locked-');
    made.push(parent);
    const child = path.join(parent, 'inner');
    mkdirSync(child);
    writeFileSync(path.join(child, 'file'), 'x');
    chmodSync(parent, 0o555);
    try {
      assert.deepEqual(removeTempDirs([child]), [child]);
    } finally {
      chmodSync(parent, 0o755);
    }
    assert.deepEqual(removeTempDirs([parent]), []);
  });
});

describe('withTimeout / runSteps', () => {
  it('passes a result through and rejects with StepTimeoutError on overrun', async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 1_000), 7);
    await assert.rejects(withTimeout(new Promise(() => {}), 20), StepTimeoutError);
    await assert.rejects(withTimeout(Promise.reject(new Error('own')), 1_000), /own/);
  });

  const ok = (name: string, ran: string[]): Step<null> => ({ name, run: async () => void ran.push(name) });

  it('runs steps in order, stops at the first failure and reports the rest as skipped', async () => {
    const ran: string[] = [];
    const steps: Step<null>[] = [
      ok('a', ran),
      { name: 'b', run: async () => Promise.reject(new Error('locator not found\nstack')) },
      ok('c', ran),
    ];
    const results = await runSteps(steps, null, { wallDeadline: Date.now() + 10_000 });
    assert.deepEqual(ran, ['a']);
    assert.deepEqual(
      results.map((r) => [r.name, r.ok, r.skipped ?? false]),
      [
        ['a', true, false],
        ['b', false, false],
        ['c', false, true],
      ],
    );
    assert.equal(results[1]!.error, 'locator not found');
  });

  it('times a hung step out at its own limit', async () => {
    const results = await runSteps([{ name: 'hang', limitMs: 30, run: () => new Promise(() => {}) }], null, {
      wallDeadline: Date.now() + 10_000,
    });
    assert.equal(results[0]!.timedOut, true);
    assert.match(results[0]!.error!, /timed out/);
  });

  it('caps a step at what is left of the wall limit, then skips the rest', async () => {
    const started = Date.now();
    const results = await runSteps(
      [
        { name: 'long', limitMs: 60_000, run: () => new Promise(() => {}) },
        { name: 'after', run: async () => {} },
      ],
      null,
      { wallDeadline: started + 50 },
    );
    assert.ok(Date.now() - started < 5_000, 'the wall limit, not the 60 s step limit, ended it');
    assert.equal(results[0]!.timedOut, true);
    assert.equal(results[1]!.skipped, true);
  });

  it('skips every step once the wall limit is spent, with that reason', async () => {
    const ran: string[] = [];
    const results = await runSteps([ok('a', ran)], null, { wallDeadline: Date.now() - 1 });
    assert.deepEqual(ran, []);
    assert.match(results[0]!.error!, /300 s run limit/);
  });

  it('fills a shared results array as each step finishes', async () => {
    const into: { name: string }[] = [];
    let seenDuringSecond = -1;
    await runSteps(
      [
        { name: 'one', run: async () => {} },
        { name: 'two', run: async () => void (seenDuringSecond = into.length) },
      ],
      null,
      { wallDeadline: Date.now() + 10_000, into: into as never },
    );
    assert.equal(seenDuringSecond, 1);
    assert.equal(into.length, 2);
  });

  it('prints a per-step table', () => {
    const table = formatStepTable([
      { name: 'Landing', ok: true, ms: 1234 },
      { name: 'Trace', ok: false, ms: 60_000, timedOut: true, error: 'timed out after 60 s' },
      { name: 'Close', ok: false, ms: 0, skipped: true, error: 'not run' },
      { name: 'Broken', ok: false, ms: 10, error: 'boom' },
    ]);
    assert.match(table, /Landing\s+PASS\s+1\.2 s/);
    assert.match(table, /Trace\s+TIMEOUT\s+60\.0 s/);
    assert.match(table, /Close\s+SKIP\s+-/);
    assert.match(table, /Broken\s+FAIL/);
    assert.match(table, /timed out after 60 s/);
  });
});

describe('createTeardown', () => {
  const recording = (calls: string[], throwing: TeardownPhase[] = []) =>
    Object.fromEntries(
      TEARDOWN_ORDER.map((phase) => [
        phase,
        async () => {
          calls.push(phase);
          if (throwing.includes(phase)) throw new Error(`${phase} failed`);
        },
      ]),
    ) as Record<TeardownPhase, () => Promise<void>>;

  it('runs CDP close → group kill → own CBM stop → temp dirs → survivor check, in that order', async () => {
    assert.deepEqual([...TEARDOWN_ORDER], ['closeCdp', 'killAppGroup', 'stopOwnCbm', 'removeTempDirs', 'checkSurvivors']);
    const calls: string[] = [];
    const report = await createTeardown(recording(calls))();
    assert.deepEqual(calls, [...TEARDOWN_ORDER]);
    assert.deepEqual(report.failures, []);
  });

  it('keeps going after a phase throws, and reports it', async () => {
    const calls: string[] = [];
    const report = await createTeardown(recording(calls, ['closeCdp', 'checkSurvivors']))();
    assert.deepEqual(calls, [...TEARDOWN_ORDER]);
    assert.deepEqual(report.failures, [
      { phase: 'closeCdp', message: 'closeCdp failed' },
      { phase: 'checkSurvivors', message: 'checkSurvivors failed' },
    ]);
  });

  it('runs once: a second caller (a signal during the finally) gets the same teardown', async () => {
    const calls: string[] = [];
    const teardown = createTeardown(recording(calls));
    const [first, second] = await Promise.all([teardown(), teardown()]);
    assert.equal(first, second);
    await teardown();
    assert.deepEqual(calls, [...TEARDOWN_ORDER]);
  });
});

describe('terminateThenKill', () => {
  const fakeDeps = (aliveAfterTerm: boolean) => {
    let clock = 0;
    const sent: [number, string][] = [];
    let terminated = false;
    return {
      sent,
      deps: {
        kill: (pid: number, signal: NodeJS.Signals) => {
          sent.push([pid, signal]);
          if (signal === 'SIGTERM') terminated = true;
          if (pid === -99) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        },
        alive: () => !terminated || aliveAfterTerm,
        sleep: async (ms: number) => void (clock += ms),
        now: () => clock,
      },
      clock: () => clock,
    };
  };

  it('stops at SIGTERM when the targets go', async () => {
    const fake = fakeDeps(false);
    assert.deepEqual(await terminateThenKill([-42], 5_000, fake.deps), ['SIGTERM']);
    assert.deepEqual(fake.sent, [[-42, 'SIGTERM']]);
  });

  it('escalates to SIGKILL only after the grace period', async () => {
    const fake = fakeDeps(true);
    assert.deepEqual(await terminateThenKill([-42, -99], 5_000, fake.deps), ['SIGTERM', 'SIGKILL']);
    assert.ok(fake.clock() >= 5_000, 'waited the whole grace period first');
    assert.deepEqual(fake.sent.at(-1), [-99, 'SIGKILL']);
  });

  it('FIX-6: after SIGKILL, waits (bounded) until the targets are gone — SIGKILL lands asynchronously', async () => {
    let clock = 0;
    let killed = false;
    let pollsAfterKill = 0;
    const deps = {
      kill: (_pid: number, signal: NodeJS.Signals) => void (signal === 'SIGKILL' && (killed = true)),
      // Still listed for three polls after the SIGKILL, like a process that is exiting.
      alive: () => !killed || (pollsAfterKill += 1) <= 3,
      sleep: async (ms: number) => void (clock += ms),
      now: () => clock,
    };
    assert.deepEqual(await terminateThenKill([-42], 300, deps), ['SIGTERM', 'SIGKILL']);
    assert.ok(pollsAfterKill > 3, 'returned only once the targets were gone');
    // A target that never goes: the wait stops at KILL_REAP_MS.
    const stuck = fakeDeps(true);
    await terminateThenKill([-42], 300, stuck.deps);
    assert.ok(stuck.clock() >= 300 + KILL_REAP_MS && stuck.clock() < 300 + KILL_REAP_MS + 200, `waited ${stuck.clock()} ms`);
  });

  it('does nothing with no targets', async () => {
    assert.deepEqual(await terminateThenKill([], 5_000, fakeDeps(true).deps), []);
  });
});

describe('the app process group (a stand-in app, no Electron)', () => {
  const FAKE_APP = [
    "const { spawn } = require('node:child_process');",
    // A grandchild that ignores SIGTERM, like a helper slow to quit.
    "spawn('sh', ['-c', 'trap \"\" TERM; sleep 120'], { stdio: 'ignore' });",
    "process.on('SIGTERM', () => {});",
    "setTimeout(() => process.stderr.write('\\nDevTools listening on ws://127.0.0.1:53111/devtools/browser/abc-123\\n'), 50);",
    'setInterval(() => {}, 1000);',
  ].join('\n');

  it('reads the DevTools URL from stderr, and the group kill escalates to SIGKILL and leaves no survivor', async () => {
    const app = startAppProcess(process.execPath, ['-e', FAKE_APP], { cwd: APP_ROOT, env: process.env });
    try {
      assert.equal(app.pgid, app.child.pid);
      assert.equal(await withTimeout(app.devToolsUrl, 10_000), 'ws://127.0.0.1:53111/devtools/browser/abc-123');
      assert.match(app.output(), /DevTools listening/);
      // Wait for the grandchild to join the group.
      const deadline = Date.now() + 5_000;
      while (groupMembers(listProcesses(), app.pgid).length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(groupMembers(listProcesses(), app.pgid).length >= 2, 'leader and grandchild share the group');
      assert.deepEqual(await killProcessGroup(app.pgid, 300), ['SIGTERM', 'SIGKILL']);
      assert.deepEqual(groupMembers(listProcesses(), app.pgid), []);
    } finally {
      try {
        process.kill(-app.pgid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await app.exited;
  });

  it('a cooperative group goes at SIGTERM, without SIGKILL', async () => {
    const app = startAppProcess('sleep', ['120'], { cwd: APP_ROOT, env: process.env });
    assert.deepEqual(await killProcessGroup(app.pgid, 5_000), ['SIGTERM']);
    await app.exited;
  });

  it('rejects the DevTools URL when the app exits without printing it', async () => {
    const app = startAppProcess(process.execPath, ['-e', "process.stderr.write('vite build failed\\n'); process.exit(3)"], {
      cwd: APP_ROOT,
      env: process.env,
    });
    await assert.rejects(app.devToolsUrl, /exited \(code 3\) before printing its DevTools URL/);
    assert.equal(await app.exited, 3);
    assert.match(app.output(), /vite build failed/);
  });
});

describe('exit paths (a real signal to a driver process)', () => {
  const driver = path.join(E2E_DIR, 'fixtures', 'exit-driver.ts');
  const loader = path.join(APP_ROOT, 'scripts', 'register-ts-test-loader.mjs');

  async function runDriver(trigger: NodeJS.Signals | 'throw') {
    const child = spawn(process.execPath, ['--import', loader, driver, ...(trigger === 'throw' ? ['throw'] : [])], {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const ready = new Promise<{ dirs: string[]; pgid: number }>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const line = stdout.split('\n').find((l) => l.includes('"ready"'));
        if (line !== undefined) resolve(JSON.parse(line));
      });
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      const state = await withTimeout(ready, 15_000);
      assert.equal(state.dirs.every((dir) => existsSync(dir)), true);
      if (trigger !== 'throw') child.kill(trigger);
      const code = await withTimeout(exited, 15_000);
      const done = JSON.parse(stdout.split('\n').find((l) => l.includes('"done"')) ?? '{}');
      return { code, state, done, stderr };
    } finally {
      child.kill('SIGKILL');
    }
  }

  for (const [trigger, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['throw', 1],
  ] as const) {
    it(`${trigger}: teardown runs in order, the group is gone, temp dirs removed, exit ${code}`, async () => {
      const { code: exitCode, state, done, stderr } = await runDriver(trigger);
      assert.equal(exitCode, code, stderr);
      assert.deepEqual(done.order, [...TEARDOWN_ORDER]);
      assert.deepEqual(done.failures, []);
      if (trigger === 'throw') assert.match(done.reason, /uncaught exception: Error: boom/);
      assert.deepEqual(groupMembers(listProcesses(), state.pgid), []);
      for (const dir of state.dirs) assert.equal(existsSync(dir), false, `${dir} removed`);
    });
  }
});

describe('spawn environment', () => {
  it('parses the DevTools URL Electron prints', () => {
    assert.equal(
      parseDevToolsUrl('noise\nDevTools listening on ws://127.0.0.1:61234/devtools/browser/0f-9a\nmore'),
      'ws://127.0.0.1:61234/devtools/browser/0f-9a',
    );
    assert.equal(parseDevToolsUrl('[vite] ready'), undefined);
  });

  it('adds the network guard to NODE_OPTIONS once, keeping what was there', () => {
    const guard = '/repo/app/scripts/no-network-guard.mjs';
    const flag = '--import=file:///repo/app/scripts/no-network-guard.mjs';
    assert.equal(withNetworkGuard(undefined, guard), flag);
    assert.equal(withNetworkGuard('--max-old-space-size=4096', guard), `--max-old-space-size=4096 ${flag}`);
    assert.equal(withNetworkGuard(`--trace-warnings ${flag}`, guard), `--trace-warnings ${flag}`);
  });

  it('gives the app tree its own TMPDIR and CBM cache, never ELECTRON_RUN_AS_NODE, without touching the base env', () => {
    const base = { ELECTRON_RUN_AS_NODE: '1', HOME: '/Users/me', TMPDIR: '/var/x' };
    const env = appEnv({ base, guardPath: '/g.mjs', cbmCacheDir: '/tmp/driller-e2e-cbm-1', appTmpDir: '/tmp/driller-e2e-tmp-1' });
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.CBM_CACHE_DIR, '/tmp/driller-e2e-cbm-1');
    assert.equal(env.TMPDIR, '/tmp/driller-e2e-tmp-1');
    assert.equal(env.TEMP, '/tmp/driller-e2e-tmp-1');
    assert.equal(env.TMP, '/tmp/driller-e2e-tmp-1');
    assert.equal(env.HOME, '/Users/me');
    assert.match(env.NODE_OPTIONS!, /no-network-guard|g\.mjs/);
    assert.equal(env.DRILLER_E2E_HOOKS, '1', 'P5-a review round 1: the dev-only focus hook');
    assert.equal(base.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(base.TMPDIR, '/var/x');
  });

  it('starts electron-forge directly with a free DevTools port and the temp userData', () => {
    const { command, args, cwd } = forgeStartCommand(APP_ROOT, '/tmp/driller-e2e-userdata-1');
    assert.equal(command, process.execPath);
    assert.match(args[0]!, /@electron-forge[\\/]cli[\\/]dist[\\/]electron-forge-start\.js$/);
    assert.deepEqual(args.slice(1), ['--', '--remote-debugging-port=0', '--user-data-dir=/tmp/driller-e2e-userdata-1']);
    assert.equal(cwd, path.join(APP_ROOT, 'apps', 'desktop'));
    assert.throws(() => forgeStartCommand(os.tmpdir(), '/x'), /electron-forge is not installed/);
  });

  it("collects the hosts the network guard refused, from both of its messages", () => {
    const output = [
      'Error: NetworkDisabledInTests: huggingface.co (in graph-service.js: non-loopback network is disabled …)',
      'NetworkDisabledInTests: graph-service.js attempted non-loopback network access (huggingface.co, cdn-lfs.hf.co); failing the file.',
    ].join('\n');
    assert.deepEqual(refusedHosts(output), ['cdn-lfs.hf.co', 'huggingface.co']);
    assert.deepEqual(refusedHosts('all quiet'), []);
  });
});

describe('artifacts', () => {
  it('go to e2e-artifacts/<timestamp>/ under the app root', () => {
    const root = makeTempDir('driller-e2e-artifacts-');
    made.push(root);
    const dir = artifactDir(root, new Date('2026-10-10T12:34:56.789Z'));
    assert.equal(dir, path.join(root, 'e2e-artifacts', '2026-10-10T12-34-56-789Z'));
    writeTextArtifact(dir, 'main-output.log', 'stderr');
    assert.equal(readFileSync(path.join(dir, 'main-output.log'), 'utf8'), 'stderr');
  });
});

describe('npm test never runs a journey', () => {
  it("find-tests' patterns pick up e2e/*.test.ts but never *.e2e.ts", () => {
    const source = readFileSync(path.join(APP_ROOT, 'scripts', 'find-tests.mjs'), 'utf8');
    const block = /const TEST_PATTERNS = \[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
    const patterns = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    assert.ok(patterns.includes('e2e/*.test.ts'));
    const matched = patterns.flatMap((pattern) => globSync(pattern, { cwd: APP_ROOT, exclude: (name) => name === 'node_modules' }));
    assert.ok(matched.includes(path.join('e2e', 'harness.test.ts')));
    assert.deepEqual(
      matched.filter((file) => file.endsWith('.e2e.ts') || file.includes(`e2e${path.sep}fixtures`)),
      [],
    );
    assert.ok(existsSync(path.join(E2E_DIR, 'smoke.e2e.ts')));
  });
});
