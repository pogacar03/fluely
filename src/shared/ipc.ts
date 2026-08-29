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

export interface PrivacySettings {
  captureProtection: boolean;
}

export interface FluelySettings {
  shortcuts: ShortcutSettings;
  window: WindowSettings;
  privacy: PrivacySettings;
}

export type SettingsPatch = Partial<{
  shortcuts: Partial<ShortcutSettings>;
  window: Partial<WindowSettings>;
  privacy: Partial<PrivacySettings>;
}>;

export type ScreenshotPermission =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unavailable";

export interface ScreenshotItem {
  id: string;
  createdAt: string;
  width: number;
  height: number;
}

export interface ScreenshotState {
  items: ScreenshotItem[];
  capturing: boolean;
  permission: ScreenshotPermission;
}

export type ScreenshotStateListener = (state: ScreenshotState) => void;

export type IpcErrorCode =
  | "INVALID_ARGUMENT"
  | "SETTINGS_READ_FAILED"
  | "SETTINGS_WRITE_FAILED"
  | "SHORTCUT_CONFLICT"
  | "SCREEN_CAPTURE_DENIED"
  | "SCREEN_CAPTURE_RESTRICTED"
  | "SCREEN_CAPTURE_PERMISSION_REQUIRED"
  | "SCREEN_CAPTURE_FAILED"
  | "CAPTURE_IN_PROGRESS"
  | "SCREENSHOT_NOT_FOUND"
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
  screenshots: {
    get: () => Promise<IpcResult<ScreenshotState>>;
    capture: () => Promise<IpcResult<ScreenshotItem>>;
    delete: (id: string) => Promise<IpcResult<ScreenshotState>>;
    clear: () => Promise<IpcResult<ScreenshotState>>;
    onStateChanged: (listener: ScreenshotStateListener) => () => void;
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
