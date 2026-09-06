/**
 * Electron main process entry point.
 *
 * Per ARCHITECTURE-SPINE.md, main is a thin orchestration shell: window
 * lifecycle, IPC routing, settings persistence, and Graph Service
 * subprocess spawn/teardown. It owns no domain logic — indexing lives in
 * services/graph-service (AD-1).
 *
 * Security baseline (AD-11): every BrowserWindow sets
 * contextIsolation: true / nodeIntegration: false, with sandbox enabled;
 * renderer reaches this process only through the contextBridge-exposed
 * preload API.
 */

import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import started from 'electron-squirrel-startup';
import {
  IpcChannels,
  type GitDetectionResult,
  type GraphServiceIndexRequest,
  type GraphServiceStatusMessage,
  type ProjectOpenResult,
} from '@driller/ipc-contracts';
import { detectGitRepo } from './git-detect';
import { listRecentProjects, recordProjectOpened } from './settings';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let graphService: UtilityProcess | null = null;
// Set while teardownGraphService is deliberately stopping the subprocess
// (app quit, or a future explicit stop) so its 'exit' handler can tell a
// requested shutdown apart from a real crash.
let isGraphServiceShuttingDown = false;
// The most recently confirmed-opened project's path, so a manual Graph
// Service restart (e.g. after a "codebase-memory-mcp failed to start"
// error) can re-send the index request without requiring the user to
// re-pick the folder.
let currentProjectPath: string | null = null;

// ---------------------------------------------------------------------------
// Graph Service subprocess (AD-1): spawned via `utilityProcess.fork`, never
// `child_process.fork` or inline indexing work in main. This story only
// establishes the process boundary and the alive/status handshake.
// ---------------------------------------------------------------------------

function sendGraphServiceStatus(status: GraphServiceStatusMessage): void {
  // A Graph Service status event can arrive after the window's webContents
  // was torn down during quit; guard against sending into a destroyed
  // WebContents, which would throw.
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.graphServiceStatus, status);
  }
}

function spawnGraphService(): void {
  if (graphService) {
    return;
  }

  isGraphServiceShuttingDown = false;
  const modulePath = path.join(__dirname, 'graph-service.js');

  try {
    graphService = utilityProcess.fork(modulePath, [], {
      serviceName: 'driller-graph-service',
    });
  } catch (error) {
    graphService = null;
    sendGraphServiceStatus({
      state: 'error',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  graphService.on('message', (message: GraphServiceStatusMessage) => {
    sendGraphServiceStatus(message);
  });

  graphService.on('exit', (code: number) => {
    graphService = null;
    if (code === 0 || isGraphServiceShuttingDown) {
      // A deliberate shutdown (app quit, or teardownGraphService's 2s kill
      // fallback) can exit with a non-zero/null code too — that's not an
      // unexpected error, so don't report it as one.
      sendGraphServiceStatus({ state: 'exited', at: new Date().toISOString(), code });
    } else {
      // An unexpected exit surfaces as an explicit, actionable error rather
      // than a crash — the renderer offers a manual retry (matrix: "Graph
      // Service fails to spawn").
      sendGraphServiceStatus({
        state: 'error',
        at: new Date().toISOString(),
        code,
        message: `Graph Service exited unexpectedly (code ${code}).`,
      });
    }
    isGraphServiceShuttingDown = false;
  });
}

/**
 * Sends an index-start request to a running Graph Service subprocess
 * (Story 1.2, Phase 1). A no-op if the subprocess isn't up — callers only
 * invoke this once `spawnGraphService()` has run.
 */
function sendIndexRequest(projectPath: string): void {
  graphService?.postMessage({
    type: 'graphService:index',
    path: projectPath,
  } satisfies GraphServiceIndexRequest);
}

/**
 * Stops the Graph Service subprocess. `onTornDown`, when given, fires once
 * the subprocess has actually exited (either on its own after the shutdown
 * message, or via the 2s fallback kill) — callers that must not proceed
 * until the process is truly gone (e.g. app quit) should wait on it rather
 * than treating this function as synchronous.
 */
function teardownGraphService(onTornDown?: () => void): void {
  if (!graphService) {
    onTornDown?.();
    return;
  }
  isGraphServiceShuttingDown = true;
  const child = graphService;
  graphService = null;
  child.postMessage({ type: 'graphService:shutdown' });

  let settled = false;
  // Fallback in case the subprocess doesn't exit promptly on its own.
  const killTimer = setTimeout(() => child.kill(), 2000);
  child.once('exit', () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(killTimer);
    onTornDown?.();
  });
}

// ---------------------------------------------------------------------------
// Open-folder flow (FR1): detects a git repo before confirming; a non-git
// folder states that explicitly. Confirmed opens are recorded to Recent
// Projects and (re)spawn the Graph Service.
// ---------------------------------------------------------------------------

function resolveOpenedFolder(folderPath: string): ProjectOpenResult {
  const git: GitDetectionResult = detectGitRepo(folderPath);

  if (!git.isGitRepo) {
    return { status: 'not-a-git-repo', path: folderPath };
  }

  const project = recordProjectOpened(folderPath);
  currentProjectPath = project.path;
  spawnGraphService();
  sendIndexRequest(project.path);

  return { status: 'opened', project, git };
}

async function handleOpenFolder(): Promise<ProjectOpenResult> {
  if (!mainWindow) {
    return { status: 'error', message: 'No window available to show the folder picker.' };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { status: 'cancelled' };
  }

  return resolveOpenedFolder(result.filePaths[0]!);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.projectOpen, () => handleOpenFolder());

  ipcMain.handle(IpcChannels.projectOpenPath, (_event, folderPath: unknown): ProjectOpenResult => {
    // The renderer-supplied path crosses the contextBridge boundary as an
    // untyped value at runtime; validate it before it reaches filesystem
    // calls in resolveOpenedFolder/detectGitRepo.
    if (typeof folderPath !== 'string' || folderPath.length === 0 || !path.isAbsolute(folderPath)) {
      return { status: 'error', message: 'Invalid path' };
    }
    return resolveOpenedFolder(folderPath);
  });

  ipcMain.handle(IpcChannels.projectListRecent, () => listRecentProjects());

  ipcMain.handle(IpcChannels.graphServiceRestart, () => {
    spawnGraphService();
    // spawnGraphService's fork() + catch above run synchronously, so
    // `graphService` already reflects whether the spawn actually succeeded.
    if (graphService && currentProjectPath) {
      // Covers both a fresh respawn (the subprocess itself died) and a
      // still-alive subprocess whose indexing MCP call errored (spawn's own
      // guard no-ops in that case) — either way, Retry re-attempts indexing
      // rather than leaving the project un-indexed with no further signal.
      sendIndexRequest(currentProjectPath);
    }
    return { ok: graphService !== null };
  });
}

// ---------------------------------------------------------------------------
// Window creation (AD-11 security baseline)
// ---------------------------------------------------------------------------

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // AD-11 security baseline: renderer content never gets to open new
  // Electron-hosted windows (e.g. via target="_blank" or window.open()).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.on('ready', () => {
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', (event) => {
  if (!graphService) {
    // Nothing running to wait on — let quit proceed immediately. This is
    // also how the second, re-triggered quit below completes: by the time
    // it fires, teardownGraphService has already nulled `graphService`.
    return;
  }
  // Don't let the app process exit before the subprocess actually dies —
  // that would orphan it. Defer quitting until teardown confirms the
  // subprocess has exited (or the 2s fallback kill completed), then
  // request quit again.
  event.preventDefault();
  teardownGraphService(() => {
    app.quit();
  });
});
