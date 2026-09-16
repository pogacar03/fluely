import type { ContextScreenshot } from "./context-queue";
import type {
  CommandResult,
  ConversationEvent,
  ConversationEventListener,
  ConversationSnapshot,
} from "./conversation";
import type {
  PhoneGatewaySettings,
  PhoneGatewayStatusListener,
  PhoneGatewayStatus,
} from "./phone-gateway";

export type { PhoneGatewaySettings, PhoneGatewayStatus, PhoneGatewayStatusListener } from "./phone-gateway";

export interface PhoneGatewayStatusSubscriptionSource {
  onStatusChanged(listener: PhoneGatewayStatusListener): () => void;
}

/** Keeps renderer phone-gateway listeners scoped to a live component and idempotent. */
export function subscribeToPhoneGatewayStatus(
  source: PhoneGatewayStatusSubscriptionSource,
  listener: PhoneGatewayStatusListener,
  isActive: () => boolean = () => true,
): () => void {
  let subscribed = true;
  const wrappedListener: PhoneGatewayStatusListener = (status) => {
    if (subscribed && isActive()) {
      listener(status);
    }
  };
  const unsubscribeSource = source.onStatusChanged(wrappedListener);

  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    unsubscribeSource();
  };
}

export type {
  CommandResult,
  ConversationEvent,
  ConversationEventListener,
  ConversationSnapshot,
} from "./conversation";

export type ShortcutAction =
  | "toggleVisibility"
  | "captureScreenshot"
  | "ask"
  | "cancelAndClear";

export interface ShortcutSettings {
  toggleVisibility: string;
  captureScreenshot: string;
  ask: string;
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

export interface FluelySettings {
  setupComplete: boolean;
  shortcuts: ShortcutSettings;
  window: WindowSettings;
  privacy: PrivacySettings;
  codex: CodexCliSettings;
  phoneGateway: PhoneGatewaySettings;
}

export type SettingsPatch = Partial<{
  setupComplete: boolean;
  shortcuts: Partial<ShortcutSettings>;
  window: Partial<WindowSettings>;
  privacy: Partial<PrivacySettings>;
  codex: Partial<CodexCliSettings>;
  phoneGateway: Partial<PhoneGatewaySettings>;
}>;

export type ScreenshotPermission =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unavailable";

/** @deprecated Use ContextScreenshot for the renderer-facing queue metadata. */
export type ScreenshotItem = ContextScreenshot;

export interface ScreenshotState {
  items: ContextScreenshot[];
  capturing: boolean;
  permission: ScreenshotPermission;
}

export type { ContextScreenshot } from "./context-queue";

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
  conversationContext?: string;
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

/** Keeps renderer analysis listeners scoped to a live component and idempotent. */
export function subscribeToAnalysisState(
  source: AnalysisStateSubscriptionSource,
  listener: AnalysisStateListener,
  isActive: () => boolean = () => true,
): () => void {
  let subscribed = true;
  const wrappedListener: AnalysisStateListener = (event) => {
    if (subscribed && isActive()) {
      listener(event);
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
  | "ANALYSIS_IN_PROGRESS"
  | "CLI_START_TIMEOUT"
  | "CLI_IDLE_TIMEOUT"
  | "CLI_HARD_TIMEOUT"
  | "USAGE_LIMIT"
  | "AUTHENTICATION_REQUIRED"
  | "MODEL_UNAVAILABLE"
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

export type WorkspaceCommand =
  | { type: "capture"; requestId: string }
  | { type: "remove"; requestId: string; screenshotId: string }
  | { type: "clear-queue"; requestId: string }
  | { type: "clear-conversation"; requestId: string }
  | { type: "ask"; requestId: string; prompt?: string }
  | { type: "cancel"; requestId: string };

/** @deprecated Use the shared CommandResult contract. */
export type WorkspaceCommandResult = CommandResult;

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
    getStatus: () => Promise<IpcResult<AnalysisState>>;
    onStateChanged: (listener: AnalysisStateListener) => () => void;
  };
  window: {
    setOpacity: (opacity: number) => Promise<IpcResult<WindowSettings>>;
    hide: () => Promise<IpcResult<void>>;
  };
  workspace: {
    execute: (command: WorkspaceCommand) => Promise<IpcResult<WorkspaceCommandResult>>;
  };
  conversation: {
    getSnapshot: () => Promise<IpcResult<ConversationSnapshot>>;
    onEvent: (listener: ConversationEventListener) => () => void;
  };
  phoneGateway: {
    getStatus: () => Promise<IpcResult<PhoneGatewayStatus>>;
    enable: () => Promise<IpcResult<PhoneGatewayStatus>>;
    disable: () => Promise<IpcResult<PhoneGatewayStatus>>;
    regeneratePairing: () => Promise<IpcResult<PhoneGatewayStatus>>;
    onStatusChanged: (listener: PhoneGatewayStatusListener) => () => void;
  };
}

declare global {
  interface Window {
    fluely: FluelyApi;
  }
}

export {};
