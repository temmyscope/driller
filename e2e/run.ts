/**
 * `npm run e2e` (P4-8h, P4-8i): preflight once, then for each journey:
 * isolated temp dirs → its fixture project → `electron-forge start` → CDP →
 * the journey's steps → teardown. A per-step table follows each journey, and
 * a summary (plus, with `--report`, one line per tracker row) ends the run.
 *
 *   npm run e2e                         every journey
 *   npm run e2e -- --report             … and one `✅ <date> (e2e)` / `❌ <step>` line per row
 *   npm run e2e -- --only P0-5          only the journey covering that row (or journey id); repeatable
 *
 * Journeys are independent: each starts its own app on a fresh temp
 * userData (P4-7g's relaunch restarts it on the same one). A failing journey
 * fails only its rows; the rest still run.
 *
 * Limits: `E2E_WALL_LIMIT_MS` (300 s) per journey, `E2E_RUN_LIMIT_MS`
 * (15 min) for the whole run, 60 s per step, 90 s for the app to land.
 *
 * Exit codes: 0 every journey passed and every teardown was clean; 1 a
 * journey, a teardown or the real-userData check failed; 2 the preflight
 * refused (or bad options); 130/143 interrupted (SIGINT/SIGTERM), after a
 * full teardown of the journey in progress.
 *
 * Manual trigger only: never part of `npm test`; CI runs it on
 * `workflow_dispatch` only.
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'playwright-core';

import {
  E2E_WALL_LIMIT_MS,
  EXIT,
  KILL_GRACE_MS,
  LANDING_LIMIT_MS,
  MCP_SERVER_PORT,
  TEMP_PREFIXES,
  appEnv,
  artifactDir,
  assertIsolatedUserData,
  cbmProcessesToStop,
  connectToApp,
  createTeardown,
  decidePreflight,
  diffSnapshots,
  findCbmProcesses,
  forgeStartCommand,
  formatStepTable,
  groupMembers,
  installExitHandlers,
  noHuggingFaceHostCheck,
  isElectronMainCommand,
  isPortFree,
  killProcessGroup,
  listProcesses,
  makeTempDir,
  realSleep,
  realUserDataDir,
  refusedHosts,
  removeTempDirs,
  runSteps,
  snapshotDir,
  startAppProcess,
  terminateThenKill,
  withTimeout,
  writeTextArtifact,
  type AppProcess,
  type ProcessInfo,
  type Step,
  type StepResult,
} from './harness';
import { seedUserData } from './fixtureProject';
import { installIpcCounter, type IpcCounter } from './ipcCounter';
import {
  E2E_RUN_LIMIT_MS,
  formatReport,
  parseCliArgs,
  reportDate,
  selectJourneys,
  type Journey,
  type JourneyContext,
  type JourneyOutcome,
} from './journey';
import { JOURNEYS } from './journeys';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_SOURCE = path.join(APP_ROOT, 'fixtures', 'path-trace-basic');
const NETWORK_GUARD = path.join(APP_ROOT, 'scripts', 'no-network-guard.mjs');
const OWN_CBM_PACKAGE_DIR = path.join(APP_ROOT, 'node_modules', 'codebase-memory-mcp');

const log = (line: string) => process.stdout.write(`${line}\n`);

/** Electron's `utilityProcess` for a Node service: how main runs the Graph Service. */
const isGraphServiceCommand = (command: string) =>
  command.includes('--type=utility') && command.includes('--utility-sub-type=node.mojom.NodeService');

/** Waits until nothing listens on the MCP port (the previous app has fully gone). */
async function waitForPortFree(limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!(await isPortFree(MCP_SERVER_PORT))) {
    if (Date.now() > deadline) throw new Error(`port ${MCP_SERVER_PORT} still bound after ${limitMs / 1000} s`);
    await realSleep(250);
  }
}

interface RunState {
  processesBefore: ProcessInfo[];
  /**
   * One `CBM_CACHE_DIR` for the whole run. CBM keeps one daemon per account
   * and refuses (or stalls) a client asking for a different cache dir while
   * a previous daemon is still registered, so back-to-back journeys with a
   * fresh cache dir each hung at "Indexing…". Each journey's fixture is a
   * fresh temp path, so its index never meets another journey's.
   */
  cbmCacheDir: string;
  runStartedAt: Date;
  runDeadline: number;
}

/** One journey's app, from spawn to teardown. `abort` is what a signal handler calls. */
interface ActiveJourney {
  abort: (exitCode: number, reason: string) => Promise<JourneyOutcome>;
}

let active: ActiveJourney | undefined;

async function runJourney(journey: Journey, state: RunState): Promise<JourneyOutcome> {
  const startedAt = Date.now();
  const deadline = Math.min(startedAt + E2E_WALL_LIMIT_MS, state.runDeadline);
  const tempDirs: string[] = [];
  const consoleLines: string[] = [];
  const results: StepResult[] = [];
  let app: AppProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let ipc: IpcCounter | undefined;
  /** Every app this journey started (a relaunch adds one), for the output artifact. */
  const outputs: (() => string)[] = [];

  const closeCdp = async () => {
    await ipc?.dispose();
    ipc = undefined;
    if (browser !== undefined) await withTimeout(browser.close(), 5_000);
    browser = undefined;
  };
  const killAppGroup = async () => {
    if (app !== undefined) await killProcessGroup(app.pgid, KILL_GRACE_MS);
  };
  const stopOwnCbm = async () => {
    const ours = cbmProcessesToStop(state.processesBefore, listProcesses(), OWN_CBM_PACKAGE_DIR);
    if (ours.length === 0) return;
    const pids = new Set(ours.map((p) => p.pid));
    await terminateThenKill([...pids], KILL_GRACE_MS, {
      kill: (pid, signal) => process.kill(pid, signal),
      alive: () => listProcesses().some((p) => pids.has(p.pid)),
      sleep: realSleep,
      now: Date.now,
    });
    log(`  teardown: stopped this run's CBM (${ours.map((p) => `PID ${p.pid}`).join(', ')})`);
  };
  const checkSurvivors = () => {
    if (app === undefined) return;
    const survivors = groupMembers(listProcesses(), app.pgid);
    if (survivors.length === 0) return;
    for (const survivor of survivors) {
      try {
        process.kill(survivor.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    throw new Error(`processes survived the group kill: ${survivors.map((p) => `PID ${p.pid} ${p.command}`).join('; ')}`);
  };
  const teardown = createTeardown({
    closeCdp,
    killAppGroup,
    stopOwnCbm,
    removeTempDirs: () => {
      const left = removeTempDirs(tempDirs);
      if (left.length > 0) throw new Error(`temp dirs left behind: ${left.join(', ')}`);
    },
    checkSurvivors,
  });

  const track = (dir: string) => {
    tempDirs.push(dir);
    return dir;
  };

  let context: JourneyContext | undefined;
  let startApp: ((limitMs: number) => Promise<void>) | undefined;

  const relaunch = async () => {
    // Quit: the same phases as teardown, minus removing the temp dirs.
    await closeCdp();
    await killAppGroup();
    await stopOwnCbm();
    checkSurvivors();
    app = undefined;
    page = undefined;
    await startApp!(LANDING_LIMIT_MS);
  };

  const killGraphService = async () => {
    if (app === undefined) throw new Error('the app is not running');
    const pgid = app.pgid;
    const services = groupMembers(listProcesses(), pgid).filter((p) => isGraphServiceCommand(p.command));
    if (services.length !== 1) {
      throw new Error(`expected one Graph Service utility process in the app's group, found ${services.length}`);
    }
    process.kill(services[0]!.pid, 'SIGKILL');
    const gone = Date.now() + 10_000;
    while (listProcesses().some((p) => p.pid === services[0]!.pid)) {
      if (Date.now() > gone) throw new Error(`Graph Service PID ${services[0]!.pid} survived SIGKILL`);
      await realSleep(100);
    }
  };

  const emitWindowFocus = async () => {
    if (app === undefined) throw new Error('the app is not running');
    const mains = groupMembers(listProcesses(), app.pgid).filter((p) => isElectronMainCommand(p.command));
    if (mains.length !== 1) {
      throw new Error(`expected one Electron main process in the app's group, found ${mains.length}`);
    }
    process.kill(mains[0]!.pid, 'SIGUSR2');
  };

  let finishing: Promise<JourneyOutcome> | undefined;
  const finish = (exitCode: number, reason?: string): Promise<JourneyOutcome> => {
    finishing ??= (async () => {
      if (reason !== undefined) log(`\n${journey.id}: ${reason}; tearing down.`);
      const failed = exitCode !== EXIT.pass || results.some((r) => !r.ok);
      let artifacts: string | undefined;
      if (failed) artifacts = await writeArtifacts();
      const report = await teardown();
      const appOutput = outputs.map((o) => o()).join('\n');
      const refused = refusedHosts(appOutput);
      const checks: StepResult[] = [
        {
          name: 'Teardown: group killed, own CBM stopped, temp dirs removed, no survivors',
          ok: report.failures.length === 0,
          ms: 0,
          error: report.failures.map((f) => `${f.phase}: ${f.message}`).join(' | ') || undefined,
        },
        // P5-c: every journey seeds Cloud, so no local-model download.
        noHuggingFaceHostCheck(appOutput),
      ];
      log(`\n${formatStepTable([...results, ...checks])}`);
      if (refused.length > 0) log(`network guard refused: ${refused.join(', ')}`);
      if (artifacts !== undefined) log(`artifacts: ${artifacts}`);
      const ms = Date.now() - startedAt;
      log(`${journey.id}: ${(ms / 1000).toFixed(1)} s`);
      const checkFailures = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.error ?? ''}`);
      return {
        journey,
        ok: !failed && checkFailures.length === 0,
        ms,
        steps: [...results],
        checkFailures,
        artifacts,
      };
    })();
    return finishing;
  };

  async function writeArtifacts(): Promise<string | undefined> {
    try {
      const dir = path.join(artifactDir(APP_ROOT, state.runStartedAt), journey.id);
      mkdirSync(dir, { recursive: true });
      writeTextArtifact(dir, 'steps.txt', `${formatStepTable(results)}\n`);
      writeTextArtifact(
        dir,
        'main-output.log',
        outputs.length === 0 ? '(the app was never started)\n' : outputs.map((o, i) => `=== app start ${i + 1}\n${o()}`).join('\n'),
      );
      writeTextArtifact(dir, 'page-console.log', `${consoleLines.join('\n')}\n`);
      if (page !== undefined) {
        await withTimeout(page.screenshot({ path: path.join(dir, 'screenshot.png'), timeout: 10_000 }), 12_000).catch(
          (error: unknown) => writeTextArtifact(dir, 'screenshot-failed.txt', `${String(error)}\n`),
        );
      }
      return dir;
    } catch (error) {
      log(`could not write artifacts: ${String(error)}`);
      return undefined;
    }
  }

  active = { abort: (exitCode, reason) => finish(exitCode, reason) };
  log(`\n=== ${journey.id} (${journey.rows.join(', ')}): ${journey.title}`);

  try {
    const realUserData = realUserDataDir(process.platform, process.env, os.homedir());
    const userDataDir = track(makeTempDir(TEMP_PREFIXES.userData));
    assertIsolatedUserData(userDataDir, realUserData);
    const { cbmCacheDir } = state;
    const appTmpDir = track(makeTempDir(TEMP_PREFIXES.appTmp));
    const prepared = journey.prepare({
      fixtureSource: FIXTURE_SOURCE,
      makeFixtureDir: () => track(makeTempDir(TEMP_PREFIXES.fixture)),
      track,
    });
    if (!tempDirs.includes(prepared.projectPath)) track(prepared.projectPath);
    const seeded = seedUserData(userDataDir, prepared.projectPath, prepared.seed);
    log(`  userData ${userDataDir}\n  project  ${prepared.projectPath}`);

    const [landing, ...rest] = journey.steps;
    if (landing === undefined) throw new Error('a journey needs at least its landing step');

    context = {
      projectPath: prepared.projectPath,
      projectName: seeded.name,
      userDataDir,
      relaunch,
      killGraphService,
      emitWindowFocus,
    } as JourneyContext;

    /** Spawn → DevTools URL → CDP → landing → IPC counter, all within `limitMs`. */
    startApp = async (limitMs: number) => {
      const until = Date.now() + limitMs;
      const left = () => Math.max(1_000, until - Date.now());
      await waitForPortFree(Math.min(30_000, left()));
      const { command, args, cwd } = forgeStartCommand(APP_ROOT, userDataDir);
      app = startAppProcess(command, args, {
        cwd,
        env: appEnv({ base: process.env, guardPath: NETWORK_GUARD, cbmCacheDir, appTmpDir }),
      });
      outputs.push(app.output);
      const url = await withTimeout(app.devToolsUrl, left());
      const connected = await connectToApp(url, left());
      browser = connected.browser;
      page = connected.page;
      page.on('console', (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
      page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`));
      page.on('crash', () => consoleLines.push('[crash] the renderer process crashed'));
      page.on('close', () => {
        consoleLines.push('[close] the page closed');
        // Diagnostics: what the browser holds after the window's page went away.
        setTimeout(() => {
          const urls = browser?.contexts().flatMap((c) => c.pages().map((p) => p.url())) ?? [];
          consoleLines.push(`[close] pages 1 s later: ${urls.join(', ') || '(none)'}; browser connected: ${browser?.isConnected() ?? false}`);
        }, 1_000);
      });
      page.on('framenavigated', (frame) => {
        if (frame === page?.mainFrame()) consoleLines.push(`[navigated] ${frame.url()}`);
      });
      context!.page = page;
      await withTimeout(landing.run(context!), left());
      ipc = await installIpcCounter(page);
      context!.ipc = ipc;
    };

    const steps: Step<JourneyContext>[] = [
      {
        name: `Start the app, connect over CDP, ${landing.name.charAt(0).toLowerCase()}${landing.name.slice(1)}`,
        limitMs: LANDING_LIMIT_MS,
        run: () => startApp!(LANDING_LIMIT_MS),
      },
      ...rest,
    ];
    await runSteps(steps, context, { wallDeadline: deadline, into: results });
  } catch (error) {
    results.push({ name: 'Set up temp dirs and fixture', ok: false, ms: 0, error: String(error) });
  }

  const outcome = await finish(EXIT.pass);
  active = undefined;
  return outcome;
}

async function main(): Promise<number> {
  let options: ReturnType<typeof parseCliArgs>;
  let journeys: Journey[];
  try {
    options = parseCliArgs(process.argv.slice(2));
    journeys = selectJourneys(JOURNEYS, options.only);
  } catch (error) {
    process.stderr.write(`npm run e2e: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.refused;
  }

  // --- Preflight: refuse before creating or spawning anything. -------------
  const processesBefore = process.platform === 'win32' ? [] : listProcesses();
  const decision = decidePreflight({
    platform: process.platform,
    portFree: await isPortFree(MCP_SERVER_PORT),
    cbmProcesses: findCbmProcesses(processesBefore),
  });
  if (!decision.ok) {
    process.stderr.write(`npm run e2e: refusing to start.\n\n${decision.reasons.join('\n\n')}\n`);
    return decision.exitCode;
  }

  const runStartedAt = new Date();
  const cbmCacheDir = makeTempDir(TEMP_PREFIXES.cbmCache);
  const state: RunState = {
    processesBefore,
    cbmCacheDir,
    runStartedAt,
    runDeadline: runStartedAt.getTime() + E2E_RUN_LIMIT_MS,
  };
  const realUserData = realUserDataDir(process.platform, process.env, os.homedir());
  const realBefore = snapshotDir(realUserData);
  const outcomes: JourneyOutcome[] = [];

  const summarize = (): number => {
    // Every journey stopped its own CBM, so the shared cache dir can go.
    const cacheLeft = removeTempDirs([cbmCacheDir]);
    const realChanges = diffSnapshots(realBefore, snapshotDir(realUserData));
    log('\n=== Summary');
    for (const o of outcomes) {
      log(`${o.ok ? 'PASS' : 'FAIL'}  ${o.journey.id.padEnd(8)} ${(o.ms / 1000).toFixed(1).padStart(6)} s  ${o.journey.rows.join(', ')}`);
    }
    const notRun = journeys.filter((j) => !outcomes.some((o) => o.journey.id === j.id));
    for (const j of notRun) log(`SKIP  ${j.id.padEnd(8)}      - s  ${j.rows.join(', ')}  (not run)`);
    log(`Real userData untouched (${realUserData}): ${realChanges.length === 0 ? 'yes' : `NO — ${realChanges.join(', ')}`}`);
    log(`total: ${((Date.now() - runStartedAt.getTime()) / 1000).toFixed(1)} s (limit ${E2E_RUN_LIMIT_MS / 60_000} min)`);
    if (options.report) {
      log(`\n=== Report (copy into live-ui-test-tracker.md by hand)\n${formatReport(outcomes, reportDate(runStartedAt))}`);
      for (const j of notRun) for (const row of j.rows) log(`${row}  ❌ not run (the run was interrupted or out of time)`);
    }
    if (cacheLeft.length > 0) log(`temp dir left behind: ${cacheLeft.join(', ')}`);
    const ok = cacheLeft.length === 0 && realChanges.length === 0 && notRun.length === 0 && outcomes.every((o) => o.ok);
    return ok ? EXIT.pass : EXIT.fail;
  };

  let exiting = false;
  const uninstall = installExitHandlers((exitCode, reason) => {
    if (exiting) return;
    exiting = true;
    void (async () => {
      const outcome = await active?.abort(exitCode, reason);
      if (outcome !== undefined && !outcomes.includes(outcome)) outcomes.push({ ...outcome, ok: false });
      summarize();
      process.exit(exitCode);
    })();
  });
  // Backstop: steps are bounded by the limits; this catches a hang outside them.
  const runTimer = setTimeout(() => {
    if (exiting) return;
    exiting = true;
    void (async () => {
      const outcome = await active?.abort(EXIT.fail, `exceeded the ${E2E_RUN_LIMIT_MS / 60_000} min run limit`);
      if (outcome !== undefined && !outcomes.includes(outcome)) outcomes.push({ ...outcome, ok: false });
      summarize();
      process.exit(EXIT.fail);
    })();
  }, E2E_RUN_LIMIT_MS + 2 * KILL_GRACE_MS);
  runTimer.unref();

  for (const journey of journeys) {
    if (Date.now() >= state.runDeadline) break;
    const outcome = await runJourney(journey, state);
    if (exiting) return new Promise<number>(() => {}); // the signal path exits
    outcomes.push(outcome);
  }

  clearTimeout(runTimer);
  uninstall();
  return summarize();
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`npm run e2e: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(EXIT.fail);
  },
);
