export type ShortcutAction =
  | "toggleVisibility"
  | "captureScreenshot"
  | "analyzeQueue"
  | "captureAndAnalyze"
  | "cancelAndClear";

export interface ShortcutSettings {
  toggleVisibility: string;
  captureScreenshot: string;
  analyzeQueue: string;
  captureAndAnalyze: string;
  cancelAndClear: string;
}

export interface WindowSettings {
  width: number;
  height: number;
}

export interface FluelySettings {
  shortcuts: ShortcutSettings;
  window: WindowSettings;
}

export type SettingsPatch = Partial<{
  shortcuts: Partial<ShortcutSettings>;
  window: Partial<WindowSettings>;
}>;

export type IpcErrorCode =
  | "INVALID_ARGUMENT"
  | "SETTINGS_READ_FAILED"
  | "SETTINGS_WRITE_FAILED"
  | "SHORTCUT_CONFLICT"
  | "INTERNAL_ERROR";

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  action: string;
}

export interface IpcSuccess<T> {
  ok: true;
  value: T;
}

export interface IpcFailure {
  ok: false;
  error: IpcError;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export interface ShortcutStatusEntry {
  action: ShortcutAction;
  accelerator: string;
  registered: boolean;
  available: boolean;
  message: string;
  errorCode?: IpcErrorCode;
}

export interface ShortcutStatus {
  entries: ShortcutStatusEntry[];
  updatedAt: string;
}

export interface AppStatus {
  name: "Fluely";
  version: string;
  platform: NodeJS.Platform;
  visible: boolean;
}

export interface FluelyApi {
  settings: {
    get: () => Promise<IpcResult<FluelySettings>>;
    update: (patch: SettingsPatch) => Promise<IpcResult<FluelySettings>>;
    reset: () => Promise<IpcResult<FluelySettings>>;
  };
  shortcuts: {
    get: () => Promise<IpcResult<ShortcutStatus>>;
    update: (shortcuts: ShortcutSettings) => Promise<IpcResult<ShortcutStatus>>;
  };
  app: {
    getStatus: () => Promise<IpcResult<AppStatus>>;
  };
}

declare global {
  interface Window {
    fluely: FluelyApi;
  }
}

export {};
