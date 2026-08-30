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

export interface ContextBridgeAdapter {
  exposeInMainWorld(name: string, api: FluelyApi): void;
}

export interface IpcRendererAdapter {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on?: (channel: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (channel: string, listener: (...args: unknown[]) => void) => unknown;
}

function invoke<T>(ipcRenderer: IpcRendererAdapter, channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>;
}

export function exposeFluelyApi(
  contextBridge: ContextBridgeAdapter,
  ipcRenderer: IpcRendererAdapter,
): void {
  contextBridge.exposeInMainWorld("fluely", {
    settings: {
      get: () => invoke<FluelySettings>(ipcRenderer, "settings:get"),
      update: (patch: SettingsPatch) => invoke<FluelySettings>(ipcRenderer, "settings:update", patch),
      reset: () => invoke<FluelySettings>(ipcRenderer, "settings:reset"),
    },
    shortcuts: {
      get: () => invoke<ShortcutStatus>(ipcRenderer, "shortcuts:get"),
      update: (shortcuts: ShortcutSettings) => invoke<ShortcutStatus>(ipcRenderer, "shortcuts:update", shortcuts),
    },
    screenshots: {
      get: () => invoke<ScreenshotState>(ipcRenderer, "screenshots:get"),
      capture: () => invoke<ScreenshotItem>(ipcRenderer, "screenshots:capture"),
      delete: (id: string) => invoke<ScreenshotState>(ipcRenderer, "screenshots:delete", id),
      clear: () => invoke<ScreenshotState>(ipcRenderer, "screenshots:clear"),
      onStateChanged: (listener: ScreenshotStateListener) => {
        if (!ipcRenderer.on || !ipcRenderer.removeListener) {
          return () => undefined;
        }

        const eventListener = (...args: unknown[]) => {
          const state = args[1] as ScreenshotState | undefined;
          if (state) {
            listener(state);
          }
        };
        ipcRenderer.on("screenshots:state-changed", eventListener);
        return () => ipcRenderer.removeListener?.("screenshots:state-changed", eventListener);
      },
    },
    app: {
      getStatus: () => invoke<AppStatus>(ipcRenderer, "app:get-status"),
    },
    codex: {
      getStatus: () => invoke<CodexStatus>(ipcRenderer, "codex:get-status"),
      validate: (path: string) => invoke<CodexStatus>(ipcRenderer, "codex:validate", path),
    },
    analysis: {
      start: (request: AnalysisRequest) => invoke<AnalysisState>(ipcRenderer, "analysis:start", request),
      cancel: () => invoke<AnalysisState>(ipcRenderer, "analysis:cancel"),
      getStatus: () => invoke<AnalysisState>(ipcRenderer, "analysis:get-status"),
      onStateChanged: (listener: AnalysisStateListener) => {
        if (!ipcRenderer.on || !ipcRenderer.removeListener) {
          return () => undefined;
        }

        const eventListener = (...args: unknown[]) => {
          const event = args[1] as AnalysisStateChangedEvent | undefined;
          if (event) {
            listener(event);
          }
        };
        ipcRenderer.on("analysis:state-changed", eventListener);
        return () => ipcRenderer.removeListener?.("analysis:state-changed", eventListener);
      },
    },
    window: {
      setOpacity: (opacity: number) => invoke<WindowSettings>(ipcRenderer, "window:set-opacity", opacity),
      setMode: (mode: WindowMode) => invoke<FluelySettings>(ipcRenderer, "window:set-mode", mode),
    },
  });
}
