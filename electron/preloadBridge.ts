import type {
  AppStatus,
  FluelyApi,
  FluelySettings,
  IpcResult,
  SettingsPatch,
  ScreenshotItem,
  ScreenshotState,
  ShortcutSettings,
  ShortcutStatus,
} from "../src/shared/ipc";

export interface ContextBridgeAdapter {
  exposeInMainWorld(name: string, api: FluelyApi): void;
}

export interface IpcRendererAdapter {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
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
    },
    app: {
      getStatus: () => invoke<AppStatus>(ipcRenderer, "app:get-status"),
    },
  });
}
