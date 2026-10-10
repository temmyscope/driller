/**
 * `npm run e2e` (P4-8h): preflight → isolated temp dirs → `electron-forge
 * start` → CDP → the smoke journey → teardown, then a per-step table.
 *
 * Exit codes: 0 every step passed and teardown was clean; 1 a step, the
 * teardown or the real-userData check failed; 2 the preflight refused;
 * 130/143 interrupted (SIGINT/SIGTERM), after a full teardown.
 *
 * Manual trigger only: never part of `npm test` or CI's default jobs.
 */
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
  type Step,
  type StepResult,
  type TeardownReport,
} from './harness';
import { createFixtureProject, seedUserData } from './fixtureProject';
import { smokeJourney, type SmokeContext } from './smoke.e2e';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_SOURCE = path.join(APP_ROOT, 'fixtures', 'path-trace-basic');
const NETWORK_GUARD = path.join(APP_ROOT, 'scripts', 'no-network-guard.mjs');
const OWN_CBM_PACKAGE_DIR = path.join(APP_ROOT, 'node_modules', 'codebase-memory-mcp');

const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
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

  const startedAt = Date.now();
  const wallDeadline = startedAt + E2E_WALL_LIMIT_MS;
  const realUserData = realUserDataDir(process.platform, process.env, os.homedir());
  const realBefore = snapshotDir(realUserData);

  const tempDirs: string[] = [];
  let app: AppProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  const consoleLines: string[] = [];
  const results: StepResult[] = [];

  const teardown = createTeardown({
    closeCdp: async () => {
      if (browser !== undefined) await withTimeout(browser.close(), 5_000);
    },
    killAppGroup: async () => {
      if (app !== undefined) await killProcessGroup(app.pgid, KILL_GRACE_MS);
    },
    stopOwnCbm: async () => {
      const ours = cbmProcessesToStop(processesBefore, listProcesses(), OWN_CBM_PACKAGE_DIR);
      if (ours.length === 0) return;
      const pids = new Set(ours.map((p) => p.pid));
      await terminateThenKill([...pids], KILL_GRACE_MS, {
        kill: (pid, signal) => process.kill(pid, signal),
        alive: () => listProcesses().some((p) => pids.has(p.pid)),
        sleep: realSleep,
        now: Date.now,
      });
      log(`teardown: stopped this run's CBM (${ours.map((p) => `PID ${p.pid}`).join(', ')})`);
    },
    removeTempDirs: () => {
      const left = removeTempDirs(tempDirs);
      if (left.length > 0) throw new Error(`temp dirs left behind: ${left.join(', ')}`);
    },
    checkSurvivors: () => {
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
    },
  });

  let finishing: Promise<number> | undefined;
  /** Artifacts (on failure) → teardown → checks → table. Runs once; a second caller gets the same result. */
  const finish = (exitCode: number, reason?: string): Promise<number> => {
    finishing ??= (async () => {
      if (reason !== undefined) log(`\nnpm run e2e: ${reason}; tearing down.`);
      const failed = exitCode !== EXIT.pass || results.some((r) => !r.ok);
      let artifacts: string | undefined;
      if (failed) artifacts = await writeArtifacts();
      const report: TeardownReport = await teardown();
      const realChanges = diffSnapshots(realBefore, snapshotDir(realUserData));
      const checks: StepResult[] = [
        {
          name: 'Teardown: group killed, own CBM stopped, temp dirs removed, no survivors',
          ok: report.failures.length === 0,
          ms: 0,
          error: report.failures.map((f) => `${f.phase}: ${f.message}`).join(' | ') || undefined,
        },
        {
          name: `Real userData untouched (${realUserData})`,
          ok: realChanges.length === 0,
          ms: 0,
          error: realChanges.join(', ') || undefined,
        },
      ];
      log(`\n${formatStepTable([...results, ...checks])}`);
      const refused = refusedHosts(app?.output() ?? '');
      if (refused.length > 0) log(`\nnetwork guard refused (expected, e.g. the local-model download): ${refused.join(', ')}`);
      if (artifacts !== undefined) log(`artifacts: ${artifacts}`);
      log(`total: ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      if (exitCode !== EXIT.pass) return exitCode;
      return failed || checks.some((c) => !c.ok) ? EXIT.fail : EXIT.pass;
    })();
    return finishing;
  };

  async function writeArtifacts(): Promise<string | undefined> {
    try {
      const dir = artifactDir(APP_ROOT, new Date());
      writeTextArtifact(dir, 'steps.txt', `${formatStepTable(results)}\n`);
      writeTextArtifact(dir, 'main-output.log', app?.output() ?? '(the app was never started)\n');
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

  const uninstall = installExitHandlers((exitCode, reason) => {
    void finish(exitCode, reason).then((code) => process.exit(code));
  });
  // Backstop: steps are already bounded by the wall limit; this catches a hang outside them.
  const wallTimer = setTimeout(() => {
    void finish(EXIT.fail, `exceeded the ${E2E_WALL_LIMIT_MS / 1000} s run limit`).then((code) => process.exit(code));
  }, E2E_WALL_LIMIT_MS + KILL_GRACE_MS);
  wallTimer.unref();

  try {
    const userDataDir = makeTempDir(TEMP_PREFIXES.userData);
    tempDirs.push(userDataDir);
    assertIsolatedUserData(userDataDir, realUserData);
    const cbmCacheDir = makeTempDir(TEMP_PREFIXES.cbmCache);
    tempDirs.push(cbmCacheDir);
    const appTmpDir = makeTempDir(TEMP_PREFIXES.appTmp);
    tempDirs.push(appTmpDir);
    const fixturePath = createFixtureProject(FIXTURE_SOURCE);
    tempDirs.push(fixturePath);
    const seeded = seedUserData(userDataDir, fixturePath);
    log(`npm run e2e: userData ${userDataDir}\n  fixture ${fixturePath}`);

    const context = { fixturePath, fixtureName: seeded.name, userDataDir } as SmokeContext;
    let landingDeadline = 0;
    const startSteps: Step<SmokeContext>[] = [
      {
        name: 'Start the dev app (electron-forge start)',
        limitMs: LANDING_LIMIT_MS,
        run: async () => {
          const { command, args, cwd } = forgeStartCommand(APP_ROOT, userDataDir);
          app = startAppProcess(command, args, {
            cwd,
            env: appEnv({ base: process.env, guardPath: NETWORK_GUARD, cbmCacheDir, appTmpDir }),
          });
          landingDeadline = Date.now() + LANDING_LIMIT_MS;
          await app.devToolsUrl;
        },
      },
      {
        name: 'Connect over CDP',
        limitMs: LANDING_LIMIT_MS,
        run: async () => {
          const connected = await connectToApp(await app!.devToolsUrl, Math.max(1_000, landingDeadline - Date.now()));
          browser = connected.browser;
          page = connected.page;
          page.on('console', (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
          page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`));
          context.page = page;
        },
      },
    ];
    // The landing shares the start's 90 s budget.
    const [landing, ...rest] = smokeJourney;
    const boundedLanding: Step<SmokeContext> = {
      ...landing!,
      run: (ctx) => withTimeout(landing!.run(ctx), Math.max(1, landingDeadline - Date.now())),
    };
    await runSteps([...startSteps, boundedLanding, ...rest], context, { wallDeadline, into: results });
  } catch (error) {
    results.push({ name: 'Set up temp dirs and fixture', ok: false, ms: 0, error: String(error) });
  }

  const code = await finish(EXIT.pass);
  clearTimeout(wallTimer);
  uninstall();
  return code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`npm run e2e: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(EXIT.fail);
  },
);
