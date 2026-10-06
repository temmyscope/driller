/**
 * The `npm test` runner.
 *
 * Preflight: `node --test` exits 0 when its glob patterns match nothing, so
 * a renamed file or a moved directory would silently drop the repo to zero
 * tests with every command still green — the failure mode a test suite
 * exists to prevent. This globs the same patterns first and fails loudly on
 * zero matches, then starts the runner.
 *
 * Patterns live here rather than in `package.json` so the preflight and the
 * runner can never be given different ones.
 *
 * Limits and leak checks (P4-8a), so the gate can't hang or leave a mess:
 * - every test gets `--test-timeout` (`PER_TEST_TIMEOUT_MS`); on Node 22
 *   the runner applies it to each test file's process too, so there it also
 *   bounds a whole file (Node 24 and later: the test alone);
 * - the whole run gets `SUITE_WALL_LIMIT_MS`, after which the runner's
 *   entire process group is killed (it is spawned detached for that);
 * - the run gets a temp dir of its own (`npm-test-run-*`, set as
 *   TMPDIR/TMP/TEMP), so `os.tmpdir()` in every test resolves there and a
 *   concurrent run can't be blamed. Anything left in it afterwards fails
 *   the run; the dir is then kept and its path printed, never cleaned;
 * - a process still alive after the runner exits — in the runner's process
 *   group, or any process a test spawned (a `detached` one escapes the
 *   group) — fails the run (POSIX only), and is then killed;
 * - `no-network-guard.mjs` refuses any non-loopback network access, in the
 *   test processes (`--import`) and in Node subprocesses (`NODE_OPTIONS`);
 * - `test-run-recorder.mjs` logs which file started, made a temp dir or
 *   spawned a process, so each failure names its test file, and stops a
 *   test process whose runner or supervisor died;
 * - git reads no global or system config, so a developer's settings can't
 *   change a test's outcome.
 *
 * Arguments, if given, replace the globbed file list (the runner's own
 * guard tests use this to run fixtures). `DRILLER_TEST_TIMEOUT_MS` and
 * `DRILLER_TEST_WALL_LIMIT_MS` exist for those tests too, and can only
 * tighten the limits, never loosen them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Not exported: this file is a script, not a module. Kept in step with `renderer/tsconfig.json`'s `exclude` and `tsconfig.test.json`'s `include`. */
const TEST_PATTERNS = [
  'apps/**/*.test.ts',
  'apps/**/*.test.tsx',
  'packages/**/*.test.ts',
  'packages/**/*.test.tsx',
  'services/**/*.test.ts',
  'services/**/*.test.tsx',
  // The runner's own guard tests. Not recursive: the hanging/leaking
  // fixtures under `scripts/fixtures/` must never be picked up.
  'scripts/*.test.mjs',
];

const PER_TEST_TIMEOUT_MS = 20_000;
const SUITE_WALL_LIMIT_MS = 240_000;

/** How long a process may take to finish exiting before it counts as leaked. */
const EXIT_GRACE_MS = 1_000;

const RUN_LOG_NAME = '.npm-test-run.jsonl';
const NETWORK_GUARD = fileURLToPath(new URL('./no-network-guard.mjs', import.meta.url));

const ALLOW_NETWORK_COMMENT = /^\/\/\s*@allow-network:\s*\S/;

const isWindows = process.platform === 'win32';

/** An override may only lower a limit. */
function tightened(limitMs, override) {
  const value = Number(override);
  return Number.isInteger(value) && value > 0 ? Math.min(limitMs, value) : limitMs;
}

const perTestTimeoutMs = tightened(PER_TEST_TIMEOUT_MS, process.env.DRILLER_TEST_TIMEOUT_MS);
const suiteWallLimitMs = tightened(SUITE_WALL_LIMIT_MS, process.env.DRILLER_TEST_WALL_LIMIT_MS);

const explicitFiles = process.argv.slice(2);
const matches =
  explicitFiles.length > 0
    ? explicitFiles
    : TEST_PATTERNS.flatMap((pattern) =>
        globSync(pattern, { exclude: (name) => name === 'node_modules' }),
      ).sort();

if (matches.length === 0) {
  process.stderr.write(
    `No test files matched. Expected at least one of:\n${TEST_PATTERNS.map((p) => `  ${p}`).join('\n')}\n` +
      'If tests moved, update TEST_PATTERNS in scripts/find-tests.mjs (and the two renderer tsconfigs) rather than leaving the suite silently empty.\n',
  );
  process.exit(1);
}

/** Files whose leading comment block carries `// @allow-network: <reason>`. */
function networkOptOuts(files) {
  const optOuts = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue; // `node --test` reports a missing file itself.
    }
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (ALLOW_NETWORK_COMMENT.test(trimmed)) {
        optOuts.push({ file, reason: trimmed.replace(/^\/\/\s*@allow-network:\s*/, '') });
        break;
      }
      const isLeadingComment =
        trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
      if (!isLeadingComment) break;
    }
  }
  return optOuts;
}

function readRunLog(logFile) {
  let text = '';
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** Kills the runner and everything it started. Never throws. */
function killRunnerTree(pid) {
  if (isWindows) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 10_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: the group is already gone.
  }
}


/** Kills one leaked process and, if it leads a group of its own (a `detached` spawn), that group. */
function killLeaked(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // ESRCH / EPERM: nothing (more) to kill.
    }
  }
}

/** Every live (non-zombie) process, via `ps`. POSIX only. */
function processTable() {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (ps.status !== 0 || typeof ps.stdout !== 'string') {
    return { error: `could not run ps (${ps.error?.message ?? `exit ${ps.status}`})` };
  }
  const processes = ps.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m) => m !== null && !m[3].startsWith('Z'))
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[4] }));
  return { processes };
}

const programName = (command) => path.basename(String(command).trim().split(/\s+/)[0] ?? '');

/**
 * Processes that outlived the runner: anything left in its process group,
 * plus any process a test spawned that is still alive — matched on its
 * command too, so a recycled PID isn't blamed.
 */
function survivors(runnerPid, spawns) {
  const table = processTable();
  if (table.error !== undefined) return table;
  const spawnedPids = new Map(spawns.map((e) => [e.pid, e]));
  const found = table.processes.filter((p) => {
    if (p.pid === process.pid) return false;
    if (p.pgid === runnerPid) return true;
    const spawned = spawnedPids.get(p.pid);
    return (
      spawned !== undefined &&
      (p.command.trim() === spawned.command.trim() || programName(p.command) === programName(spawned.command))
    );
  });
  return { processes: found };
}

const relative = (file) => path.relative(process.cwd(), file) || file;

// The run's own temp dir: TMPDIR/TMP/TEMP for the whole runner tree.
const runTempDir = mkdtempSync(path.join(os.tmpdir(), 'npm-test-run-'));
const runLogFile = path.join(runTempDir, RUN_LOG_NAME);

const optOuts = networkOptOuts(matches);
for (const { file, reason } of optOuts) {
  process.stdout.write(`npm test: network allowed in ${relative(file)} (${reason})\n`);
}
const canonicalPath = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

const guardImport = `--import=${pathToFileURL(NETWORK_GUARD).href}`;
const env = {
  ...process.env,
  TMPDIR: runTempDir,
  TMP: runTempDir,
  TEMP: runTempDir,
  // Node subprocesses a test starts get the network guard too.
  NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '').includes(guardImport)
    ? process.env.NODE_OPTIONS
    : `${process.env.NODE_OPTIONS ?? ''} ${guardImport}`.trim(),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  DRILLER_TEST_RUN_LOG: runLogFile,
  DRILLER_TEST_SUPERVISOR_PID: String(process.pid),
  DRILLER_ALLOW_NETWORK_FILES: JSON.stringify(optOuts.map(({ file }) => canonicalPath(file))),
};
delete env.NODE_TEST_CONTEXT;

process.stdout.write(
  `npm test: ${matches.length} files, ${perTestTimeoutMs / 1000} s per test, ${suiteWallLimitMs / 1000} s for the suite\n`,
);

const runner = spawn(
  process.execPath,
  [
    '--import',
    './scripts/no-network-guard.mjs',
    '--import',
    './scripts/test-run-recorder.mjs',
    '--import',
    './scripts/register-ts-test-loader.mjs',
    '--test',
    // Explicit: Node 22 defaults to TAP when stdout isn't a terminal.
    '--test-reporter=spec',
    `--test-timeout=${perTestTimeoutMs}`,
    ...matches,
  ],
  // Detached on POSIX makes the runner a process-group leader, so one kill
  // reaches every test process and anything they spawned. (On Windows it
  // would open a new console instead; `taskkill /T` walks the tree there.)
  // No stdin: a background process group reading the terminal would stop.
  { stdio: ['ignore', 'inherit', 'inherit'], detached: !isWindows, env },
);

let overran = false;
const wallTimer = setTimeout(() => {
  overran = true;
  killRunnerTree(runner.pid);
}, suiteWallLimitMs);

// Ctrl-C reaches only the foreground group, which a detached runner left;
// pass it on so an interrupted `npm test` leaves nothing behind. Exit codes
// follow the shell's 128 + signal number (Ctrl-C: 130).
for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
  process.on(signal, () => {
    killRunnerTree(runner.pid);
    process.stderr.write(`npm test: ${signal} received; killed the runner (temp dir kept: ${runTempDir})\n`);
    process.exit(128 + number);
  });
}

const runnerExit = await new Promise((resolve) => {
  runner.on('error', (error) => resolve({ code: null, error }));
  runner.on('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(wallTimer);

const runLog = readRunLog(runLogFile);
const failures = [];

if (runnerExit.error !== undefined) {
  failures.push(`npm test: could not start the test runner: ${runnerExit.error.message}`);
}

if (overran) {
  const started = runLog.filter((e) => e.event === 'start').map((e) => e.file);
  const ended = new Set(runLog.filter((e) => e.event === 'end').map((e) => e.file));
  const stillRunning = started.filter((file) => !ended.has(file));
  failures.push(
    `npm test exceeded ${suiteWallLimitMs / 1000} s; killed the runner\n` +
      `  last test file started: ${started.at(-1) ?? '(none)'}\n` +
      `  still running when killed: ${stillRunning.length > 0 ? stillRunning.join(', ') : '(none)'}`,
  );
}

if (isWindows) {
  process.stdout.write('npm test: leaked-process check skipped on Windows\n');
} else if (runner.pid !== undefined) {
  const spawns = runLog.filter((e) => e.event === 'spawn');
  // A process may still be finishing its exit; give it a moment.
  let result = survivors(runner.pid, spawns);
  const deadline = Date.now() + EXIT_GRACE_MS;
  while (result.error === undefined && result.processes.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = survivors(runner.pid, spawns);
  }
  if (result.error !== undefined) {
    failures.push(`npm test: leaked-process check failed: ${result.error}`);
  } else if (result.processes.length > 0) {
    const spawnedBy = new Map(spawns.map((e) => [e.pid, e.file]));
    failures.push(
      `npm test: ${result.processes.length} process(es) outlived the test runner:\n` +
        result.processes
          .map(
            ({ pid, command }) =>
              `  PID ${pid}: ${command} (spawned by ${spawnedBy.get(pid) ?? 'an unrecorded child; see the commands above'})`,
          )
          .join('\n') +
        '\n  They have been killed. Make the test that started them wait for, or kill, its children.',
    );
    killRunnerTree(runner.pid);
    for (const { pid } of result.processes) killLeaked(pid);
  }
}

// Anything a test left in the run's temp dir. The top-level entry is what
// gets reported; the recorder says which file's `mkdtemp` made it.
let leftovers = [];
try {
  leftovers = readdirSync(runTempDir).filter((name) => name !== RUN_LOG_NAME).sort();
} catch {
  // The dir itself vanished: nothing to report there.
}
if (leftovers.length > 0) {
  const createdBy = new Map(
    runLog
      .filter((e) => e.event === 'mkdtemp')
      .map((e) => [path.relative(runTempDir, e.path).split(path.sep)[0], e.file]),
  );
  failures.push(
    `npm test: ${leftovers.length} temp entr${leftovers.length === 1 ? 'y' : 'ies'} left behind (kept, not deleted; fix the test that made them):\n` +
      leftovers
        .map((name) => `  ${path.join(runTempDir, name)} (created by ${createdBy.get(name) ?? 'an unrecorded test'})`)
        .join('\n'),
  );
} else {
  rmSync(runTempDir, { recursive: true, force: true });
}

for (const failure of failures) {
  process.stderr.write(`\n${failure}\n`);
}

process.exit(failures.length > 0 ? 1 : (runnerExit.code ?? 1));
