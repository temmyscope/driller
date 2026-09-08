/**
 * Preload script — the renderer's only path out (AD-11).
 *
 * Exposes a small, explicitly-typed `window.driller` API via
 * `contextBridge`. Renderer code never sees `ipcRenderer` or any other
 * Node/Electron API directly; every call here is a thin, typed forward to
 * an `ipcMain` handler registered in main/index.ts.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannels,
  type BackendConfig,
  type CloudBackend,
  type CodeMapResult,
  type DrillerApi,
  type GraphServiceStatusMessage,
  type HardwareAdvisoryMessage,
  type ModelStatusMessage,
  type ProjectOpenResult,
  type ReadSourceRangeResult,
  type RecentProject,
  type SetCloudApiKeyResult,
  type SummaryProgressMessage,
} from '@driller/ipc-contracts';

const drillerApi: DrillerApi = {
  openFolder: (): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(IpcChannels.projectOpen),

  openRecentProject: (path: string): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(IpcChannels.projectOpenPath, path),

  listRecentProjects: (): Promise<RecentProject[]> =>
    ipcRenderer.invoke(IpcChannels.projectListRecent),

  restartGraphService: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.graphServiceRestart),

  onGraphServiceStatus: (callback: (status: GraphServiceStatusMessage) => void) => {
    const listener = (_event: IpcRendererEvent, status: GraphServiceStatusMessage) =>
      callback(status);
    ipcRenderer.on(IpcChannels.graphServiceStatus, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.graphServiceStatus, listener);
    };
  },

  onModelStatus: (callback: (status: ModelStatusMessage) => void) => {
    const listener = (_event: IpcRendererEvent, status: ModelStatusMessage) => callback(status);
    ipcRenderer.on(IpcChannels.modelStatus, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.modelStatus, listener);
    };
  },

  onSummaryProgress: (callback: (message: SummaryProgressMessage) => void) => {
    const listener = (_event: IpcRendererEvent, message: SummaryProgressMessage) => callback(message);
    ipcRenderer.on(IpcChannels.summaryProgress, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.summaryProgress, listener);
    };
  },

  onHardwareAdvisory: (callback: (message: HardwareAdvisoryMessage) => void) => {
    const listener = (_event: IpcRendererEvent, message: HardwareAdvisoryMessage) => callback(message);
    ipcRenderer.on(IpcChannels.hardwareAdvisory, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.hardwareAdvisory, listener);
    };
  },

  getCodeMap: (): Promise<CodeMapResult> => ipcRenderer.invoke(IpcChannels.codeMapGet),

  readSourceRange: (file: string, startLine: number, endLine: number): Promise<ReadSourceRangeResult> =>
    ipcRenderer.invoke(IpcChannels.sourceReadRange, file, startLine, endLine),

  getBackendConfig: (): Promise<BackendConfig> =>
    ipcRenderer.invoke(IpcChannels.settingsGetBackendConfig),

  setActiveBackend: (backend: CloudBackend): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.settingsSetActiveBackend, backend),

  setCloudApiKey: (key: string, acknowledgeInsecureStorage?: boolean): Promise<SetCloudApiKeyResult> =>
    ipcRenderer.invoke(IpcChannels.settingsSetCloudApiKey, key, acknowledgeInsecureStorage),
};

contextBridge.exposeInMainWorld('driller', drillerApi);
