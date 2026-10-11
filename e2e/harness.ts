/**
 * P4-8h: the Electron e2e harness behind `npm run e2e` (never `npm test`).
 *
 * It starts the real dev app with `electron-forge start -- --remote-debugging-port=0
 * --user-data-dir=<tmp>` in a process group of its own, reads the DevTools URL
 * from stderr, and drives the window with `playwright-core`'s
 * `chromium.connectOverCDP` (no browser download).
 *
 * Guarantees, each enforced here:
 * - **Preflight** refuses (exit 2) while port 39217 is bound (a driller is
 *   running) or any `codebase-memory-mcp` process is running: the app's
 *   Graph Service shares CBM's per-account daemon, and the app retires that
 *   daemon on quit, so a run next to an ambient one could stop it.
 * - **Isolation:** userData, the fixture project, CBM's cache and the app
 *   tree's TMPDIR are fresh `mkdtemp` dirs. The developer's real userData is
 *   only ever `stat`ed (before/after, to prove it was untouched), never read
 *   or written. Non-loopback network is refused in every Node process of the
 *   app tree (`scripts/no-network-guard.mjs` via `NODE_OPTIONS`).
 * - **Limits:** `E2E_WALL_LIMIT_MS` for the run, `STEP_LIMIT_MS` per step,
 *   `LANDING_LIMIT_MS` for the first landing.
 * - **Teardown** on every exit path, in a fixed order: close CDP → kill the
 *   forge process group (SIGTERM, SIGKILL after `KILL_GRACE_MS`) → stop the
 *   CBM processes this run started (and only those) → remove the temp dirs →
 *   check that nothing from the group survived. A survivor fails the run.
 *
 * The pure parts (parsing, preflight decision, ordering, timeouts, port and
 * temp-dir helpers) are unit-tested by `harness.test.ts` under `npm test`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { Browser, Page } from 'playwright-core';

export const E2E_WALL_LIMIT_MS = 300_000;
export const STEP_LIMIT_MS = 60_000;
export const LANDING_LIMIT_MS = 90_000;
/** SIGTERM to the forge group, then SIGKILL after this long. */
export const KILL_GRACE_MS = 5_000;
/** `services/graph-service/mcp-server.ts`'s `MCP_SERVER_PORT`. */
export const MCP_SERVER_PORT = 39217;

export const TEMP_PREFIXES = {
  userData: 'driller-e2e-userdata-',
  fixture: 'driller-e2e-fixture-',
  cbmCache: 'driller-e2e-cbm-',
  appTmp: 'driller-e2e-tmp-',
} as const;

/** Exit codes: a refused preflight is distinct from a failed run. */
export const EXIT = { pass: 0, fail: 1, refused: 2, sigint: 130, sigterm: 143 } as const;

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export interface ProcessInfo {
  pid: number;
  pgid: number;
  command: string;
}

/** Parses `ps -A -o pid=,pgid=,stat=,command=`; zombies are dropped (they are already dead). */
export function parsePs(stdout: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (match === null || match[3]!.startsWith('Z')) continue;
    rows.push({ pid: Number(match[1]), pgid: Number(match[2]), command: match[4]! });
  }
  return rows;
}

/** Every live process. POSIX only; throws when `ps` can't run (the harness can't prove anything without it). */
export function listProcesses(): ProcessInfo[] {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], { encoding: 'utf8', timeout: 10_000 });
  if (ps.status !== 0 || typeof ps.stdout !== 'string') {
    throw new Error(`could not run ps (${ps.error?.message ?? `exit ${ps.status}`})`);
  }
  return parsePs(ps.stdout);
}

/** A `codebase-memory-mcp` process: the native binary (daemon or client), or its npm `bin.js` shim. */
export function isCbmCommand(command: string): boolean {
  const program = command.trim().split(/\s+/)[0] ?? '';
  return path.basename(program) === 'codebase-memory-mcp' || /[\\/]codebase-memory-mcp[\\/]bin\.js(\s|$)/.test(command);
}

export function findCbmProcesses(processes: readonly ProcessInfo[]): ProcessInfo[] {
  return processes.filter((p) => p.pid !== process.pid && isCbmCommand(p.command));
}

/**
 * The CBM processes this run started: new since the preflight snapshot AND
 * run from this checkout's own `codebase-memory-mcp` package (the app's
 * Graph Service resolves that one). A CBM the developer's tools start
 * mid-run (a different binary) is never picked, so it is never stopped.
 */
export function cbmProcessesToStop(
  before: readonly ProcessInfo[],
  after: readonly ProcessInfo[],
  ownCbmPackageDir: string,
): ProcessInfo[] {
  const preexisting = new Set(before.map((p) => p.pid));
  const ownPrefix = ownCbmPackageDir.endsWith(path.sep) ? ownCbmPackageDir : ownCbmPackageDir + path.sep;
  return findCbmProcesses(after).filter((p) => !preexisting.has(p.pid) && p.command.includes(ownPrefix));
}

export function groupMembers(processes: readonly ProcessInfo[], pgid: number): ProcessInfo[] {
  return processes.filter((p) => p.pgid === pgid);
}

export interface KillDeps {
  /** `process.kill`; a negative pid targets a group. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether any target is still alive. */
  alive: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long, after SIGKILL, to wait for the targets to leave the process
 * table. SIGKILL is delivered asynchronously: right after `kill()` returns,
 * `ps` can still list a killed process (macOS shows it as `(sleep)` while it
 * exits), so a survivor check made at once flaked (FIX-6: ~1 in 7 full
 * `npm test` runs, "the group kill … leaves no survivor").
 */
export const KILL_REAP_MS = 2_000;

/**
 * SIGTERM, wait up to `graceMs` for the targets to go, then SIGKILL and wait
 * up to `KILL_REAP_MS` for them to be gone. Returns which signals were sent,
 * in order. Never throws (ESRCH = gone).
 */
export async function terminateThenKill(
  targets: readonly number[],
  graceMs: number,
  deps: KillDeps,
): Promise<NodeJS.Signals[]> {
  const sent: NodeJS.Signals[] = [];
  const send = (signal: NodeJS.Signals) => {
    sent.push(signal);
    for (const target of targets) {
      try {
        deps.kill(target, signal);
      } catch {
        // ESRCH / EPERM: nothing (more) to signal.
      }
    }
  };
  if (targets.length === 0) return sent;
  send('SIGTERM');
  const deadline = deps.now() + graceMs;
  while (deps.alive() && deps.now() < deadline) {
    await deps.sleep(100);
  }
  if (deps.alive()) {
    send('SIGKILL');
    const reapDeadline = deps.now() + KILL_REAP_MS;
    while (deps.alive() && deps.now() < reapDeadline) {
      await deps.sleep(50);
    }
  }
  return sent;
}

/** Kills a whole process group: `kill(-pgid)` SIGTERM, then SIGKILL after `graceMs`. */
export function killProcessGroup(pgid: number, graceMs = KILL_GRACE_MS, list = listProcesses): Promise<NodeJS.Signals[]> {
  return terminateThenKill([-pgid], graceMs, {
    kill: (pid, signal) => process.kill(pid, signal),
    alive: () => groupMembers(list(), pgid).length > 0,
    sleep: realSleep,
    now: Date.now,
  });
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightInput {
  platform: NodeJS.Platform;
  portFree: boolean;
  cbmProcesses: readonly ProcessInfo[];
}

export type PreflightDecision = { ok: true } | { ok: false; exitCode: typeof EXIT.refused; reasons: string[] };

/** Pure: whether the run may start. Every reason is reported, not just the first. */
export function decidePreflight({ platform, portFree, cbmProcesses }: PreflightInput): PreflightDecision {
  const reasons: string[] = [];
  if (platform === 'win32') {
    reasons.push('npm run e2e supports macOS and Linux only (it kills a POSIX process group and reads `ps`).');
  }
  if (!portFree) {
    reasons.push(
      `Port ${MCP_SERVER_PORT} is already bound, so a driller is probably running. Quit it, then re-run npm run e2e.`,
    );
  }
  if (cbmProcesses.length > 0) {
    const listed = cbmProcesses.map((p) => `  PID ${p.pid}: ${p.command}`).join('\n');
    reasons.push(
      'An ambient codebase-memory-mcp (CBM) is running:\n' +
        `${listed}\n` +
        'The e2e run starts its own CBM daemon and stops only that one, so it never runs beside another. ' +
        'Make sure no ambient codebase-memory-mcp is running (close the tools that use it, then ' +
        '`codebase-memory-mcp daemon stop`), then re-run npm run e2e.',
    );
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, exitCode: EXIT.refused, reasons };
}

/**
 * Whether `port` can be bound on `host` right now. A listen probe, closed at
 * once: EADDRINUSE means bound. Any other error is rethrown.
 */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

// ---------------------------------------------------------------------------
// userData isolation
// ---------------------------------------------------------------------------

/** Where Electron puts driller's real userData (`app.getPath('userData')` for productName `driller`). */
export function realUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'driller');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'driller');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'driller');
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Throws unless `tempDir` is a fresh e2e userData dir clear of the real one (in both directions). */
export function assertIsolatedUserData(tempDir: string, realDir: string): void {
  if (!path.basename(tempDir).startsWith(TEMP_PREFIXES.userData)) {
    throw new Error(`userData ${tempDir} is not a ${TEMP_PREFIXES.userData}* temp dir`);
  }
  const resolvedTemp = path.resolve(tempDir);
  const resolvedReal = path.resolve(realDir);
  if (isInside(resolvedTemp, resolvedReal) || isInside(resolvedReal, resolvedTemp)) {
    throw new Error(`userData ${tempDir} overlaps the real userData ${realDir}; refusing to run`);
  }
}

export interface DirSnapshot {
  exists: boolean;
  mtimeMs?: number;
  /** Top-level entry name → mtimeMs. `stat` only: nothing is read. */
  entries: Record<string, number>;
}

export function snapshotDir(dir: string): DirSnapshot {
  if (!existsSync(dir)) return { exists: false, entries: {} };
  const entries: Record<string, number> = {};
  for (const name of readdirSync(dir)) {
    try {
      entries[name] = statSync(path.join(dir, name)).mtimeMs;
    } catch {
      // Removed between readdir and stat: absent from this snapshot.
    }
  }
  return { exists: true, mtimeMs: statSync(dir).mtimeMs, entries };
}

/** Human-readable differences; empty when unchanged. */
export function diffSnapshots(before: DirSnapshot, after: DirSnapshot): string[] {
  const changes: string[] = [];
  if (before.exists !== after.exists) changes.push(after.exists ? 'created' : 'removed');
  if (before.mtimeMs !== after.mtimeMs && before.exists && after.exists) changes.push('directory mtime changed');
  const names = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const name of [...names].sort()) {
    const a = before.entries[name];
    const b = after.entries[name];
    if (a === undefined) changes.push(`${name} added`);
    else if (b === undefined) changes.push(`${name} removed`);
    else if (a !== b) changes.push(`${name} modified`);
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Temp dirs
// ---------------------------------------------------------------------------

/** A fresh `mkdtemp` dir under `root`, realpath'd (macOS `/var` → `/private/var`). */
export function makeTempDir(prefix: string, root = os.tmpdir()): string {
  return realpathSync(mkdtempSync(path.join(root, prefix)));
}

/** Removes every dir; returns the ones still present afterwards (a failed removal). */
export function removeTempDirs(dirs: readonly string[]): string[] {
  const left: string[] = [];
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Reported below by the existence check.
    }
    if (existsSync(dir)) left.push(dir);
  }
  return left;
}

// ---------------------------------------------------------------------------
// Steps and limits
// ---------------------------------------------------------------------------

export class StepTimeoutError extends Error {
  constructor(limitMs: number) {
    super(`timed out after ${Math.round(limitMs / 1000)} s`);
    this.name = 'StepTimeoutError';
  }
}

/** Rejects with `StepTimeoutError` once `limitMs` passes; the timer never outlives the race. */
export async function withTimeout<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(limitMs)), Math.max(0, limitMs));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  /** Not run: an earlier step failed or the wall limit was reached. */
  skipped?: boolean;
  error?: string;
  timedOut?: boolean;
}

export interface Step<C> {
  name: string;
  /** Defaults to `STEP_LIMIT_MS`. */
  limitMs?: number;
  run: (context: C) => Promise<void>;
}

/**
 * Runs steps in order. Each gets `min(its limit, what's left of the wall
 * limit)`. After the first failure (or once the wall limit is spent) the
 * rest are reported as skipped, never run.
 */
export async function runSteps<C>(
  steps: readonly Step<C>[],
  context: C,
  options: { wallDeadline: number; now?: () => number; defaultLimitMs?: number; into?: StepResult[] },
): Promise<StepResult[]> {
  const now = options.now ?? Date.now;
  // Filled as steps finish, so an interrupted run can still report the ones done.
  const results: StepResult[] = options.into ?? [];
  let stop: string | undefined;
  for (const step of steps) {
    if (stop !== undefined) {
      results.push({ name: step.name, ok: false, ms: 0, skipped: true, error: stop });
      continue;
    }
    const remaining = options.wallDeadline - now();
    if (remaining <= 0) {
      stop = `not run: the ${Math.round(E2E_WALL_LIMIT_MS / 1000)} s run limit was reached`;
      results.push({ name: step.name, ok: false, ms: 0, skipped: true, error: stop });
      continue;
    }
    const limitMs = Math.min(step.limitMs ?? options.defaultLimitMs ?? STEP_LIMIT_MS, remaining);
    const started = now();
    try {
      await withTimeout(step.run(context), limitMs);
      results.push({ name: step.name, ok: true, ms: now() - started });
    } catch (error) {
      const timedOut = error instanceof StepTimeoutError;
      results.push({
        name: step.name,
        ok: false,
        ms: now() - started,
        timedOut,
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
      stop = 'not run: an earlier step failed';
    }
  }
  return results;
}

/** The per-step pass/fail table `npm run e2e` prints. */
export function formatStepTable(results: readonly StepResult[]): string {
  const status = (r: StepResult) => (r.ok ? 'PASS' : r.skipped ? 'SKIP' : r.timedOut ? 'TIMEOUT' : 'FAIL');
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const lines = [`${'step'.padEnd(nameWidth)}  result   time`, `${'-'.repeat(nameWidth)}  -------  ------`];
  for (const r of results) {
    const time = r.skipped ? '-' : `${(r.ms / 1000).toFixed(1)} s`;
    lines.push(`${r.name.padEnd(nameWidth)}  ${status(r).padEnd(7)}  ${time}`);
    if (!r.ok && r.error !== undefined) lines.push(`${' '.repeat(nameWidth)}    ${r.error}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** The fixed teardown order. Each phase runs once, even if an earlier one threw. */
export const TEARDOWN_ORDER = ['closeCdp', 'killAppGroup', 'stopOwnCbm', 'removeTempDirs', 'checkSurvivors'] as const;
export type TeardownPhase = (typeof TEARDOWN_ORDER)[number];
export type TeardownOps = Record<TeardownPhase, () => Promise<void> | void>;

export interface TeardownReport {
  /** Phases that threw, with their messages. A non-empty list fails the run. */
  failures: { phase: TeardownPhase; message: string }[];
}

/**
 * Returns an idempotent teardown: the first call runs every phase in
 * `TEARDOWN_ORDER`; later calls (a signal arriving during the `finally`)
 * get that same promise, so nothing is torn down twice or concurrently.
 */
export function createTeardown(ops: TeardownOps): () => Promise<TeardownReport> {
  let running: Promise<TeardownReport> | undefined;
  return () => {
    running ??= (async () => {
      const failures: TeardownReport['failures'] = [];
      for (const phase of TEARDOWN_ORDER) {
        try {
          await ops[phase]();
        } catch (error) {
          failures.push({ phase, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { failures };
    })();
    return running;
  };
}

/**
 * Routes SIGINT, SIGTERM, an uncaught exception and an unhandled rejection
 * through `onExit` (which tears down and then exits). Returns the uninstaller.
 */
export function installExitHandlers(onExit: (exitCode: number, reason: string) => void): () => void {
  const handlers: [string, (...args: unknown[]) => void][] = [
    ['SIGINT', () => onExit(EXIT.sigint, 'SIGINT')],
    ['SIGTERM', () => onExit(EXIT.sigterm, 'SIGTERM')],
    ['uncaughtException', (error) => onExit(EXIT.fail, `uncaught exception: ${describe(error)}`)],
    ['unhandledRejection', (error) => onExit(EXIT.fail, `unhandled rejection: ${describe(error)}`)],
  ];
  for (const [event, handler] of handlers) process.on(event, handler);
  return () => {
    for (const [event, handler] of handlers) process.off(event, handler);
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

// ---------------------------------------------------------------------------
// Spawning the app
// ---------------------------------------------------------------------------

/** Electron prints this to stderr once `--remote-debugging-port` is listening. */
export function parseDevToolsUrl(text: string): string | undefined {
  return /DevTools listening on (ws:\/\/\S+)/.exec(text)?.[1];
}

/** Hosts `scripts/no-network-guard.mjs` refused in the app tree, from its two message shapes. */
export function refusedHosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const match of output.matchAll(/NetworkDisabledInTests: (\S+) \(in /g)) hosts.add(match[1]!);
  for (const match of output.matchAll(/attempted non-loopback network access \(([^)]*)\)/g)) {
    for (const host of match[1]!.split(', ')) if (host !== '') hosts.add(host);
  }
  return [...hosts].sort();
}

/** Appends an `--import` of `guardPath` to `NODE_OPTIONS`, once. */
export function withNetworkGuard(nodeOptions: string | undefined, guardPath: string): string {
  const flag = `--import=${pathToFileURL(guardPath).href}`;
  const existing = (nodeOptions ?? '').trim();
  if (existing.split(/\s+/).includes(flag)) return existing;
  return existing === '' ? flag : `${existing} ${flag}`;
}

export interface AppEnvInput {
  base: NodeJS.ProcessEnv;
  guardPath: string;
  cbmCacheDir: string;
  appTmpDir: string;
}

/** The app tree's environment: network guard, its own TMPDIR and CBM cache, never run-as-node. */
export function appEnv({ base, guardPath, cbmCacheDir, appTmpDir }: AppEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Set by some hosts (an editor's integrated terminal): Electron would run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  env.NODE_OPTIONS = withNetworkGuard(base.NODE_OPTIONS, guardPath);
  env.CBM_CACHE_DIR = cbmCacheDir;
  env.TMPDIR = appTmpDir;
  env.TMP = appTmpDir;
  env.TEMP = appTmpDir;
  return env;
}

export interface AppProcess {
  child: ChildProcess;
  /** The forge process group (the leader's pid: it is spawned detached). */
  pgid: number;
  /** Everything forge, vite and Electron main printed (stdout and stderr). */
  output: () => string;
  /** Resolves with the DevTools WebSocket URL; rejects if the app exits first. */
  devToolsUrl: Promise<string>;
  /** Resolves when the leader has exited. */
  exited: Promise<number | null>;
}

/** Starts `command args` detached (its own process group), capturing output. */
export function startAppProcess(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): AppProcess {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid === undefined) throw new Error(`could not start ${command}`);
  let output = '';
  let settleUrl: { resolve: (url: string) => void; reject: (error: Error) => void } | undefined;
  const devToolsUrl = new Promise<string>((resolve, reject) => {
    settleUrl = { resolve, reject };
  });
  // Unobserved until awaited; a rejection here must not count as unhandled.
  devToolsUrl.catch(() => {});
  const onData = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    const url = parseDevToolsUrl(output);
    if (url !== undefined) settleUrl?.resolve(url);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      settleUrl?.reject(new Error(`the app exited (code ${code}) before printing its DevTools URL`));
      resolve(code);
    });
    child.once('error', (error) => {
      settleUrl?.reject(error);
      resolve(null);
    });
  });
  return { child, pgid: child.pid, output: () => output, devToolsUrl, exited };
}

/** The `electron-forge start` command line (run with this Node, no `npx`). */
export function forgeStartCommand(appRoot: string, userDataDir: string): { command: string; args: string[]; cwd: string } {
  const forgeStart = path.join(appRoot, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge-start.js');
  if (!existsSync(forgeStart)) throw new Error(`electron-forge is not installed (${forgeStart}); run npm ci`);
  return {
    command: process.execPath,
    args: [forgeStart, '--', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`],
    cwd: path.join(appRoot, 'apps', 'desktop'),
  };
}

/** Connects over CDP and returns the app window (the page served by the dev server, not DevTools). */
export async function connectToApp(wsUrl: string, limitMs: number): Promise<{ browser: Browser; page: Page }> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: limitMs });
  const deadline = Date.now() + limitMs;
  for (;;) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => /^https?:\/\/(localhost|127\.0\.0\.1)/.test(candidate.url()) || candidate.url().startsWith('file:'));
    if (page !== undefined) return { browser, page };
    if (Date.now() > deadline) throw new StepTimeoutError(limitMs);
    await realSleep(250);
  }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** `e2e-artifacts/<timestamp>/`, created; `:` and `.` are swapped out so it is a valid name everywhere. */
export function artifactDir(appRoot: string, at: Date): string {
  const dir = path.join(appRoot, 'e2e-artifacts', at.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeTextArtifact(dir: string, name: string, text: string): void {
  writeFileSync(path.join(dir, name), text);
}
