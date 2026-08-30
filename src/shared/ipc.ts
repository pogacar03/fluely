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

/** Public Codex health data; process handles and raw CLI objects stay in main. */
export interface CodexStatus {
  available: boolean;
  configuredPath: string;
  resolvedPath?: string;
  error?: IpcError;
}

export type WindowMode = "setup" | "work";

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

export type AnalysisStatus = "idle" | "running" | "completed" | "cancelled" | "error";

export type AnalysisIntent = "answer" | "explain" | "follow-up" | "recap";

export interface AnalysisRequest {
  prompt: string;
  screenshotIds: string[];
  intent: AnalysisIntent;
  fast: boolean;
}

export type AnalysisStateEventType = "started" | "delta" | "completed" | "cancelled" | "error";

export interface AnalysisState {
  status: AnalysisStatus;
  text: string;
  model: string;
  screenshotIds: string[];
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  error?: IpcError;
}

export interface AnalysisStateChangedEvent extends AnalysisState {
  event: AnalysisStateEventType;
}

export type AnalysisStateListener = (event: AnalysisStateChangedEvent) => void;

export interface AnalysisStateSubscriptionSource {
  onStateChanged(listener: AnalysisStateListener): () => void;
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
  | "ANALYSIS_IN_PROGRESS"
  | "ANALYSIS_FAILED"
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
  codex: {
    getStatus: () => Promise<IpcResult<CodexStatus>>;
    validate: (path: string) => Promise<IpcResult<CodexStatus>>;
  };
  analysis: {
    start: (request: AnalysisRequest) => Promise<IpcResult<AnalysisState>>;
    cancel: () => Promise<IpcResult<AnalysisState>>;
    getStatus: () => Promise<IpcResult<AnalysisState>>;
    onStateChanged: (listener: AnalysisStateListener) => () => void;
  };
  window: {
    setOpacity: (opacity: number) => Promise<IpcResult<WindowSettings>>;
    setMode: (mode: WindowMode) => Promise<IpcResult<FluelySettings>>;
  };
}

declare global {
  interface Window {
    fluely: FluelyApi;
  }
}

export {};
