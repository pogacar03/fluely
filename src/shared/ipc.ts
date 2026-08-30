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
  opacity: number;
}

export interface PrivacySettings {
  captureProtection: boolean;
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CodexCliSettings {
  enabled: boolean;
  path: string;
  model: string;
  fastModel: string;
  timeoutMs: number;
  sandboxMode: CodexSandboxMode;
  modelReasoningEffort?: CodexModelReasoningEffort;
}

export interface FluelySettings {
  setupComplete: boolean;
  shortcuts: ShortcutSettings;
  window: WindowSettings;
  privacy: PrivacySettings;
  codex: CodexCliSettings;
}

export type SettingsPatch = Partial<{
  setupComplete: boolean;
  shortcuts: Partial<ShortcutSettings>;
  window: Partial<WindowSettings>;
  privacy: Partial<PrivacySettings>;
  codex: Partial<CodexCliSettings>;
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

export interface ScreenshotStateSubscriptionSource {
  onStateChanged(listener: ScreenshotStateListener): () => void;
}

/** Keeps renderer state listeners scoped to a live component and makes cleanup idempotent. */
export function subscribeToScreenshotState(
  source: ScreenshotStateSubscriptionSource,
  listener: ScreenshotStateListener,
  isActive: () => boolean = () => true,
): () => void {
  let subscribed = true;
  const wrappedListener: ScreenshotStateListener = (state) => {
    if (subscribed && isActive()) {
      listener(state);
    }
  };
  const unsubscribeSource = source.onStateChanged(wrappedListener);

  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    unsubscribeSource();
  };
}

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
