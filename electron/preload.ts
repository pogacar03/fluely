import { contextBridge, ipcRenderer } from "electron";
import type {
  AnalysisRequest,
  AnalysisState,
  AnalysisStateChangedEvent,
  AnalysisStateListener,
  AppStatus,
  CodexStatus,
  FluelyApi,
  FluelySettings,
  IpcResult,
  SettingsPatch,
  ScreenshotItem,
  ScreenshotStateListener,
  ScreenshotState,
  ShortcutSettings,
  ShortcutStatus,
  WindowMode,
  WindowSettings,
} from "../src/shared/ipc";

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>;
}

const api: FluelyApi = {
  settings: {
    get: () => invoke<FluelySettings>("settings:get"),
    update: (patch: SettingsPatch) => invoke<FluelySettings>("settings:update", patch),
    reset: () => invoke<FluelySettings>("settings:reset"),
  },
  shortcuts: {
    get: () => invoke<ShortcutStatus>("shortcuts:get"),
    update: (shortcuts: ShortcutSettings) => invoke<ShortcutStatus>("shortcuts:update", shortcuts),
  },
  screenshots: {
    get: () => invoke<ScreenshotState>("screenshots:get"),
    capture: () => invoke<ScreenshotItem>("screenshots:capture"),
    delete: (id: string) => invoke<ScreenshotState>("screenshots:delete", id),
    clear: () => invoke<ScreenshotState>("screenshots:clear"),
    onStateChanged: (listener: ScreenshotStateListener) => {
      const eventListener = (_event: Electron.IpcRendererEvent, state: ScreenshotState) => listener(state);
      ipcRenderer.on("screenshots:state-changed", eventListener);
      return () => ipcRenderer.removeListener("screenshots:state-changed", eventListener);
    },
  },
  app: {
    getStatus: () => invoke<AppStatus>("app:get-status"),
  },
  codex: {
    getStatus: () => invoke<CodexStatus>("codex:get-status"),
    validate: (path: string) => invoke<CodexStatus>("codex:validate", path),
  },
  analysis: {
    start: (request: AnalysisRequest) => invoke<AnalysisState>("analysis:start", request),
    cancel: () => invoke<AnalysisState>("analysis:cancel"),
    getStatus: () => invoke<AnalysisState>("analysis:get-status"),
    onStateChanged: (listener: AnalysisStateListener) => {
      const eventListener = (_event: Electron.IpcRendererEvent, event: AnalysisStateChangedEvent) => {
        listener(event);
      };
      ipcRenderer.on("analysis:state-changed", eventListener);
      return () => ipcRenderer.removeListener("analysis:state-changed", eventListener);
    },
  },
  window: {
    setOpacity: (opacity: number) => invoke<WindowSettings>("window:set-opacity", opacity),
    setMode: (mode: WindowMode) => invoke<FluelySettings>("window:set-mode", mode),
    hide: () => invoke<void>("window:hide"),
  },
};

contextBridge.exposeInMainWorld("fluely", api);
