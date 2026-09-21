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
  type BlastRadiusExpansionResult,
  type CloudBackend,
  type CodeMapResult,
  type DiagnosticLogEntry,
  type DiffScopeResult,
  type DrillerApi,
  type EditorPreference,
  type GraphServiceStatusMessage,
  type HardwareAdvisoryMessage,
  type LlmJudgmentProgressMessage,
  type ModelStatusMessage,
  type OpenInEditorResult,
  type PathTraceResult,
  type PrBotConfig,
  type PrBotId,
  type PrBotIngestionResult,
  type ProjectOpenResult,
  type ReadSourceRangeResult,
  type RecentProject,
  type RegenerateNodeResult,
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

  // Story 2.2 (Phase 2): forwards batched LLM-judgment generation progress —
  // one-line subscription mirroring `onSummaryProgress` above. No renderer
  // consumer subscribes to this yet (Phase 3's job).
  onLlmJudgmentProgress: (callback: (message: LlmJudgmentProgressMessage) => void) => {
    const listener = (_event: IpcRendererEvent, message: LlmJudgmentProgressMessage) => callback(message);
    ipcRenderer.on(IpcChannels.llmJudgmentProgress, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.llmJudgmentProgress, listener);
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

  openInEditor: (file: string, startLine: number): Promise<OpenInEditorResult> =>
    ipcRenderer.invoke(IpcChannels.shellOpenInEditor, file, startLine),

  getBackendConfig: (): Promise<BackendConfig> =>
    ipcRenderer.invoke(IpcChannels.settingsGetBackendConfig),

  setActiveBackend: (backend: CloudBackend): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.settingsSetActiveBackend, backend),

  setCloudApiKey: (key: string, acknowledgeInsecureStorage?: boolean): Promise<SetCloudApiKeyResult> =>
    ipcRenderer.invoke(IpcChannels.settingsSetCloudApiKey, key, acknowledgeInsecureStorage),

  getEditorPreference: (): Promise<EditorPreference> =>
    ipcRenderer.invoke(IpcChannels.settingsGetEditorPreference),

  setEditorPreference: (value: EditorPreference): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.settingsSetEditorPreference, value),

  getPrBotConfig: (projectPath: string): Promise<PrBotConfig> =>
    ipcRenderer.invoke(IpcChannels.settingsGetPrBotConfig, projectPath),

  setPrBotEnabled: (projectPath: string, bot: PrBotId, enabled: boolean): Promise<PrBotConfig> =>
    ipcRenderer.invoke(IpcChannels.settingsSetPrBotEnabled, projectPath, bot, enabled),

  runPrBotIngestion: (projectPath: string, bot: PrBotId): Promise<PrBotIngestionResult> =>
    ipcRenderer.invoke(IpcChannels.prBotRunIngestion, projectPath, bot),

  regenerateNode: (nodeId: string): Promise<RegenerateNodeResult> =>
    ipcRenderer.invoke(IpcChannels.nodeRegenerate, nodeId),

  tracePath: (query: string): Promise<PathTraceResult> =>
    ipcRenderer.invoke(IpcChannels.pathTrace, query),

  // Review fix: `.catch` here is what actually makes `DrillerApi.
  // logDiagnosticEvent`'s documented "never rejects" contract hold at this
  // boundary — without it, the guarantee only held by accident of the sole
  // current caller (CodeMap.tsx) adding its own `.catch`.
  logDiagnosticEvent: (entry: DiagnosticLogEntry): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.diagnosticLog, entry).catch(() => undefined),

  computeDiffScope: (projectPath: string, baseRef?: string): Promise<DiffScopeResult> =>
    ipcRenderer.invoke(IpcChannels.diffScopeCompute, projectPath, baseRef),

  expandBlastRadius: (projectPath: string, nodeIds: string[]): Promise<BlastRadiusExpansionResult> =>
    ipcRenderer.invoke(IpcChannels.blastRadiusExpand, projectPath, nodeIds),
};

contextBridge.exposeInMainWorld('driller', drillerApi);
