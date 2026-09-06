import type {
  AnalysisState,
  AnalysisStateChangedEvent,
  AppStatus,
  CodexCliSettings,
  CodexStatus,
  FluelySettings,
  IpcError,
  IpcResult,
  PhoneGatewaySettings,
  PhoneGatewayStatus,
  ScreenshotState,
  SettingsPatch,
  ShortcutSettings,
  ShortcutStatus,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WindowSettings,
} from "../../src/shared/ipc";
import type {
  ConversationEvent,
  ConversationMessage,
  ConversationPort,
  ConversationSnapshot,
} from "../../src/shared/conversation";
import { PHONE_GATEWAY_SHARED_NETWORK_NOTICE } from "../../src/shared/phone-gateway";
import {
  createRequestIdDeduper,
} from "../../src/shared/context-queue";
import { normalizeSettingsPatch, validateSettingsPatch } from "./settings-core";

export interface IpcMainAdapter {
  handle(channel: string, handler: (_event: unknown, payload?: unknown) => unknown): void;
}

export interface SettingsHandlerService {
  get(): FluelySettings;
  update(patch: SettingsPatch): Promise<IpcResult<FluelySettings>>;
  reset(): Promise<IpcResult<FluelySettings>>;
}

export interface ShortcutHandlerService {
  getStatus(): ShortcutStatus;
  update(shortcuts: ShortcutSettings): IpcResult<ShortcutStatus>;
}

export interface ScreenshotHandlerService {
  getState(): ScreenshotState;
}

export interface AnalysisHandlerService {
  getState?: () => AnalysisState;
  getStatus?: () => AnalysisState;
  onStateChanged(listener: (event: AnalysisStateChangedEvent) => void): () => void;
}

/**
 * The IPC layer consumes a narrow status facade rather than a Codex process.
 * The fallback `validateExecutable` shape keeps composition straightforward
 * for the main process while still allowing tests to inject a status service.
 */
export interface CodexHandlerService {
  getStatus?: () => CodexStatus | Promise<CodexStatus>;
  validate?: (path: string) => CodexStatus | Promise<CodexStatus>;
  validateExecutable?: (path: string, timeoutMs?: number) => unknown;
}

export interface WindowHandlerService {
  setOpacity?: (opacity: number) => void | Promise<void>;
  hide?: () => void | Promise<void>;
}

export interface PhoneGatewayHandlerService {
  getStatus(): PhoneGatewayStatus;
  enable(): IpcResult<PhoneGatewayStatus> | Promise<IpcResult<PhoneGatewayStatus>>;
  disable(): IpcResult<PhoneGatewayStatus> | Promise<IpcResult<PhoneGatewayStatus>>;
  regeneratePairing(): IpcResult<PhoneGatewayStatus> | Promise<IpcResult<PhoneGatewayStatus>>;
}

export interface WorkspaceHandlerService {
  execute(command: WorkspaceCommand, source?: "desktop" | "phone"): WorkspaceCommandResult | Promise<WorkspaceCommandResult>;
}

export interface ConversationHandlerService extends ConversationPort {
  clear?: () => Promise<void>;
}

export interface IpcHandlerDependencies {
  ipcMain: IpcMainAdapter;
  settings: SettingsHandlerService;
  shortcuts: ShortcutHandlerService;
  screenshots: ScreenshotHandlerService;
  analysis?: AnalysisHandlerService;
  analysisService?: AnalysisHandlerService;
  codex?: CodexHandlerService;
  codexService?: CodexHandlerService;
  codexCli?: CodexHandlerService;
  window?: WindowHandlerService;
  windowTarget?: WindowHandlerService;
  browserWindow?: WindowHandlerService;
  workspace?: WorkspaceHandlerService;
  conversation?: ConversationHandlerService;
  applyPrivacy?: (enabled: boolean) => void;
  applyCodexSettings?: (settings: CodexCliSettings) => void | Promise<void>;
  applyOpacity?: (opacity: number) => void | Promise<void>;
  applyWindowOpacity?: (opacity: number) => void | Promise<void>;
  applyShortcuts?: (shortcuts: ShortcutSettings) => IpcResult<ShortcutStatus> | void;
  notifyAnalysisState?: (event: AnalysisStateChangedEvent) => void;
  notifyConversationEvent?: (event: ConversationEvent) => void;
  phoneGateway?: PhoneGatewayHandlerService;
  applyPhoneGatewaySettings?: (settings: PhoneGatewaySettings) => void | Promise<void>;
  getAppStatus(): AppStatus;
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error };
}

function serializeIpcResult<T>(result: IpcResult<T>): IpcResult<T> {
  return result.ok ? result : failure(safeIpcError(result.error.code, result.error));
}

function shortcutApplicationFailure(): IpcError {
  return {
    code: "INTERNAL_ERROR",
    message: "Fluely saved the requested settings but could not register the shortcuts.",
    action: "Restart Fluely and try again.",
  };
}

function applyShortcutSettings(
  applyShortcuts: ((shortcuts: ShortcutSettings) => IpcResult<ShortcutStatus> | void) | undefined,
  shortcuts: ShortcutSettings,
): IpcError | null {
  if (!applyShortcuts) {
    return null;
  }

  try {
    const result = applyShortcuts(shortcuts);
    return isRecord(result) && result.ok === false && isRecord(result.error)
      ? safeIpcError(
        typeof result.error.code === "string" ? result.error.code as IpcError["code"] : "INTERNAL_ERROR",
        {
          code: "INTERNAL_ERROR",
          message: "Fluely could not register the shortcuts.",
          action: "Restart Fluely and try again.",
        },
      )
      : null;
  } catch {
    return shortcutApplicationFailure();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidShortcutPayload(): IpcError {
  return {
    code: "INVALID_ARGUMENT",
    message: "Shortcut settings must include five non-empty accelerator strings.",
    action: "Enter each shortcut once and try again.",
  };
}

function isShortcutSettings(input: unknown): input is ShortcutSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  const settings = input as Record<string, unknown>;
  return [
    "toggleVisibility",
    "captureScreenshot",
    "analyzeQueue",
    "captureAndAnalyze",
    "cancelAndClear",
  ].every((key) => typeof settings[key] === "string" && settings[key].trim().length > 0);
}

const SCREENSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ANALYSIS_PROMPT_LENGTH = 3000;
const MIN_WINDOW_OPACITY = 0.35;
const MAX_WINDOW_OPACITY = 1;
function isScreenshotId(input: unknown): input is string {
  return typeof input === "string" && SCREENSHOT_ID_PATTERN.test(input);
}

const IPC_ERROR_CODES = new Set<IpcError["code"]>([
  "INVALID_ARGUMENT",
  "SETTINGS_READ_FAILED",
  "SETTINGS_WRITE_FAILED",
  "SHORTCUT_CONFLICT",
  "SCREEN_CAPTURE_DENIED",
  "SCREEN_CAPTURE_RESTRICTED",
  "SCREEN_CAPTURE_PERMISSION_REQUIRED",
  "SCREEN_CAPTURE_FAILED",
  "CAPTURE_IN_PROGRESS",
  "SCREENSHOT_NOT_FOUND",
  "ANALYSIS_IN_PROGRESS",
  "CLI_START_TIMEOUT",
  "CLI_IDLE_TIMEOUT",
  "CLI_HARD_TIMEOUT",
  "ANALYSIS_FAILED",
  "INTERNAL_ERROR",
]);

/**
 * IPC is a trust boundary. Main-process errors may contain paths, command
 * lines, tokens, or provider diagnostics, so only this fixed copy is allowed
 * to cross into renderer/phone code. The original error remains available to
 * the main-process caller for diagnostics before it is serialized here.
 */
const SAFE_IPC_ERROR_COPY: Record<IpcError["code"], Pick<IpcError, "message" | "action">> = {
  INVALID_ARGUMENT: {
    message: "Fluely received an invalid request.",
    action: "Check the request and try again.",
  },
  SETTINGS_READ_FAILED: {
    message: "Fluely could not read its settings.",
    action: "Restart Fluely and try again.",
  },
  SETTINGS_WRITE_FAILED: {
    message: "Fluely could not save that setting.",
    action: "Check the Fluely data directory permissions and try again.",
  },
  SHORTCUT_CONFLICT: {
    message: "Fluely could not register that shortcut.",
    action: "Choose another shortcut and try again.",
  },
  SCREEN_CAPTURE_DENIED: {
    message: "Screen capture permission was denied.",
    action: "Allow screen capture for Fluely and try again.",
  },
  SCREEN_CAPTURE_RESTRICTED: {
    message: "Screen capture is restricted on this device.",
    action: "Check the device privacy settings and try again.",
  },
  SCREEN_CAPTURE_PERMISSION_REQUIRED: {
    message: "Fluely needs screen capture permission.",
    action: "Allow screen capture for Fluely and try again.",
  },
  SCREEN_CAPTURE_FAILED: {
    message: "Fluely could not capture the selected display.",
    action: "Check that a display is available and try again.",
  },
  CAPTURE_IN_PROGRESS: {
    message: "A screen capture is already in progress.",
    action: "Wait for the current capture to finish and try again.",
  },
  SCREENSHOT_NOT_FOUND: {
    message: "That screenshot is no longer available.",
    action: "Refresh the screenshot queue and try again.",
  },
  ANALYSIS_IN_PROGRESS: {
    message: "An analysis request is already in progress.",
    action: "Wait for it to finish or cancel it before starting another.",
  },
  CLI_START_TIMEOUT: {
    message: "Fluely could not start the Codex analysis in time.",
    action: "Check the Codex CLI path and try again.",
  },
  CLI_IDLE_TIMEOUT: {
    message: "The Codex analysis stopped responding.",
    action: "Try the analysis again.",
  },
  CLI_HARD_TIMEOUT: {
    message: "The Codex analysis exceeded its time limit.",
    action: "Try a shorter request or run the analysis again.",
  },
  ANALYSIS_FAILED: {
    message: "Fluely could not complete the analysis request.",
    action: "Retry the analysis request.",
  },
  INTERNAL_ERROR: {
    message: "Fluely could not complete that request in its main process.",
    action: "Restart Fluely and try again.",
  },
};

function safeIpcError(code: IpcError["code"], fallback: IpcError): IpcError {
  const safeCode = IPC_ERROR_CODES.has(code) ? code : fallback.code;
  return {
    code: safeCode,
    ...SAFE_IPC_ERROR_COPY[safeCode],
  };
}

function errorFromUnknown(value: unknown, fallback: IpcError): IpcError {
  const candidateCode = isRecord(value) && typeof value.code === "string"
    ? value.code as IpcError["code"]
    : fallback.code;
  return safeIpcError(candidateCode, fallback);
}

function internalFailure(action: string): IpcError {
  return {
    code: "INTERNAL_ERROR",
    message: "Fluely could not complete that request in its main process.",
    action,
  };
}

function clampOpacity(value: number): number {
  return Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, value));
}

function invalidOpacity(): IpcError {
  return {
    code: "INVALID_ARGUMENT",
    message: "Window opacity must be a finite number.",
    action: "Choose a window opacity between 35% and 100% and try again.",
  };
}

function serializeAnalysisState(value: unknown): AnalysisState {
  const candidate = isRecord(value) ? value : {};
  const status = candidate.status === "idle" || candidate.status === "running" ||
    candidate.status === "completed" || candidate.status === "cancelled" || candidate.status === "error"
    ? candidate.status
    : "idle";
  const screenshotIds = Array.isArray(candidate.screenshotIds)
    ? candidate.screenshotIds.filter(isScreenshotId)
    : [];
  const state: AnalysisState = {
    status,
    text: typeof candidate.text === "string" ? candidate.text : "",
    model: typeof candidate.model === "string" ? candidate.model : "",
    screenshotIds: [...screenshotIds],
    startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : null,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    completedAt: typeof candidate.completedAt === "string" ? candidate.completedAt : null,
  };
  if (isRecord(candidate.error)) {
    const error = errorFromUnknown(candidate.error, {
      code: "ANALYSIS_FAILED",
      message: "Analysis failed.",
      action: "Retry the analysis request.",
    });
    state.error = error;
  }
  return state;
}

function serializeAnalysisEvent(value: unknown): AnalysisStateChangedEvent {
  const candidate = isRecord(value) ? value : {};
  const event = candidate.event === "started" || candidate.event === "delta" ||
    candidate.event === "completed" || candidate.event === "cancelled" || candidate.event === "error"
    ? candidate.event
    : "delta";
  return { ...serializeAnalysisState(value), event };
}

function serializeConversationMessage(message: ConversationMessage): ConversationMessage {
  const serialized: ConversationMessage = {
    ...message,
    attachmentIds: [...message.attachmentIds],
  };
  if (message.error) {
    const error = errorFromUnknown(message.error, {
      code: "ANALYSIS_FAILED",
      message: "Analysis failed.",
      action: "Retry the analysis request.",
    });
    serialized.error = { code: error.code, message: error.message };
  }
  return serialized;
}

function serializeConversationSnapshot(value: unknown): ConversationSnapshot {
  const candidate = isRecord(value) ? value : {};
  const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId : "unknown";
  const revision = typeof candidate.revision === "number" && Number.isSafeInteger(candidate.revision) && candidate.revision >= 0
    ? candidate.revision
    : 0;
  const messages = Array.isArray(candidate.messages)
    ? candidate.messages.filter(isRecord).map((message) => serializeConversationMessage(message as unknown as ConversationMessage))
    : [];
  const attachments = Array.isArray(candidate.attachments)
    ? candidate.attachments.filter(isRecord).map((attachment) => ({ ...attachment } as unknown as ConversationSnapshot["attachments"][number]))
    : [];
  return {
    sessionId,
    revision,
    messages,
    attachments,
    ...(typeof candidate.activeMessageId === "string" ? { activeMessageId: candidate.activeMessageId } : {}),
  };
}

function serializeConversationEvent(event: ConversationEvent): ConversationEvent {
  if (event.type === "attachment-added") {
    return { ...event, attachment: { ...event.attachment } };
  }
  if (event.type === "message-added" || event.type === "message-updated") {
    return { ...event, message: serializeConversationMessage(event.message) };
  }
  if (event.type === "cleared") {
    return { ...event, snapshot: serializeConversationSnapshot(event.snapshot) };
  }
  return {
    ...event,
    messageIds: [...event.messageIds],
    attachmentIds: [...event.attachmentIds],
    snapshot: serializeConversationSnapshot(event.snapshot),
  };
}

function serializeWorkspaceResult(value: WorkspaceCommandResult): WorkspaceCommandResult {
  return {
    queue: {
      ...value.queue,
      items: value.queue.items.map((item) => ({ ...item })),
    },
    conversation: serializeConversationSnapshot(value.conversation),
    ...(value.analysis ? { analysis: serializeAnalysisState(value.analysis) } : {}),
  };
}

function serializeCodexStatus(value: unknown, configuredPath: string): CodexStatus {
  const candidate = isRecord(value) ? value : {};
  const available = typeof candidate.available === "boolean"
    ? candidate.available
    : candidate.success === true;
  const status: CodexStatus = {
    available,
    configuredPath: typeof candidate.configuredPath === "string" ? candidate.configuredPath : configuredPath,
  };
  if (typeof candidate.resolvedPath === "string" && candidate.resolvedPath.trim()) {
    status.resolvedPath = candidate.resolvedPath;
  }
  if (candidate.error !== undefined) {
    status.error = errorFromUnknown(candidate.error, {
      code: "INTERNAL_ERROR",
      message: "Codex CLI validation failed.",
      action: "Check the Codex CLI path and try validation again.",
    });
  }
  return status;
}

const PHONE_GATEWAY_ERROR_MESSAGES: Record<Extract<PhoneGatewayStatus, { state: "error" }>["code"], string> = {
  no_lan_address: "No private or shared LAN address is available.",
  port_unavailable: "No gateway port is available.",
  start_failed: "Phone companion could not start.",
};

export function serializePhoneGatewayStatus(value: unknown): PhoneGatewayStatus {
  if (!isRecord(value)) {
    return { state: "disabled" };
  }
  if (value.state === "starting") {
    return { state: "starting" };
  }
  if (value.state === "ready") {
    let origin = "";
    try {
      const parsed = new URL(typeof value.origin === "string" ? value.origin : "");
      if (parsed.protocol === "http:" && parsed.pathname === "/" && !parsed.search && !parsed.hash &&
        !parsed.username && !parsed.password) {
        origin = parsed.origin;
      }
    } catch {
      origin = "";
    }
    const qrDataUrl = typeof value.qrDataUrl === "string" &&
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.qrDataUrl)
      ? value.qrDataUrl
      : "";
    const pairingExpiresAt = typeof value.pairingExpiresAt === "number" &&
      Number.isSafeInteger(value.pairingExpiresAt) && value.pairingExpiresAt >= 0
      ? value.pairingExpiresAt
      : 0;
    return {
      state: "ready",
      origin,
      qrDataUrl,
      pairingExpiresAt,
      paired: value.paired === true,
      ...(value.networkNotice === PHONE_GATEWAY_SHARED_NETWORK_NOTICE
        ? { networkNotice: PHONE_GATEWAY_SHARED_NETWORK_NOTICE }
        : {}),
    };
  }
  if (value.state === "error" &&
    (value.code === "no_lan_address" || value.code === "port_unavailable" || value.code === "start_failed")) {
    return {
      state: "error",
      code: value.code,
      message: PHONE_GATEWAY_ERROR_MESSAGES[value.code],
    };
  }
  return { state: "disabled" };
}

function serializePhoneGatewayResult(
  result: IpcResult<PhoneGatewayStatus>,
): IpcResult<PhoneGatewayStatus> {
  if (!result.ok) {
    return failure<PhoneGatewayStatus>(safeIpcError(result.error.code, {
      code: "INTERNAL_ERROR",
      message: "Fluely could not update the phone companion.",
      action: "Restart Fluely and try again.",
    }));
  }
  return success(serializePhoneGatewayStatus(result.value));
}

function statusFailure(value: unknown): IpcError {
  return errorFromUnknown(value, {
    code: "INTERNAL_ERROR",
    message: "Fluely could not validate the Codex CLI.",
    action: "Check the Codex CLI path and try again.",
  });
}

function configuredCodex(settings: SettingsHandlerService): { path: string; timeoutMs: number } {
  try {
    const candidate = settings.get().codex;
    return {
      path: typeof candidate?.path === "string" && candidate.path.trim() ? candidate.path.trim() : "codex",
      timeoutMs: typeof candidate?.timeoutMs === "number" && Number.isFinite(candidate.timeoutMs) && candidate.timeoutMs > 0
        ? Math.round(candidate.timeoutMs)
        : 120000,
    };
  } catch {
    return { path: "codex", timeoutMs: 120000 };
  }
}

const MAX_WORKSPACE_REQUEST_ID_LENGTH = 128;

function invalidWorkspaceCommand(message = "Workspace commands must use a supported type and request ID."): IpcError {
  return {
    code: "INVALID_ARGUMENT",
    message,
    action: "Refresh the workspace and try again.",
  };
}

function isWorkspaceRequestId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_WORKSPACE_REQUEST_ID_LENGTH;
}

/** Validates and normalizes the renderer-facing command before any service is called. */
export function normalizeWorkspaceCommand(
  input: unknown,
): { command?: WorkspaceCommand; error?: IpcError } {
  if (!isRecord(input) || !isWorkspaceRequestId(input.requestId) || input.requestId !== input.requestId.trim()) {
    return { error: invalidWorkspaceCommand("Workspace commands must include a non-empty request ID.") };
  }

  const requestId = input.requestId;
  switch (input.type) {
    case "capture":
    case "clear-queue":
    case "clear-conversation":
    case "cancel":
      return { command: { type: input.type, requestId } };
    case "remove":
      if (!isScreenshotId(input.screenshotId)) {
        return { error: invalidWorkspaceCommand("Remove commands must identify a managed screenshot.") };
      }
      return { command: { type: "remove", requestId, screenshotId: input.screenshotId } };
    case "send":
    case "capture-and-send":
      if (typeof input.prompt !== "string" || input.prompt.length > MAX_ANALYSIS_PROMPT_LENGTH) {
        return {
          error: invalidWorkspaceCommand(
            `Workspace prompts must be a string no longer than ${MAX_ANALYSIS_PROMPT_LENGTH} characters.`,
          ),
        };
      }
      return { command: { type: input.type, requestId, prompt: input.prompt } };
    default:
      return { error: invalidWorkspaceCommand("Workspace command type is not supported.") };
  }
}

function noCanonicalWorkspaceRouter(): IpcError {
  return {
    code: "INTERNAL_ERROR",
    message: "Fluely cannot execute workspace commands until its canonical command router is ready.",
    action: "Restart Fluely and try again.",
  };
}

export function registerIpcHandlers({
  ipcMain,
  settings,
  shortcuts,
  screenshots,
  analysis,
  analysisService,
  codex,
  window,
  windowTarget,
  codexService,
  codexCli,
  browserWindow,
  applyPrivacy,
  applyCodexSettings,
  applyOpacity,
  applyWindowOpacity,
  applyShortcuts,
  notifyAnalysisState,
  notifyConversationEvent,
  workspace,
  conversation,
  phoneGateway,
  applyPhoneGatewaySettings,
  getAppStatus,
}: IpcHandlerDependencies): void {
  const analysisHandler = analysis ?? analysisService;
  const codexHandler = codex ?? codexService ?? codexCli;
  const windowHandler = window ?? windowTarget ?? browserWindow;
  const applyWindowOpacityHandler = applyOpacity ?? applyWindowOpacity;
  const workspaceHandler = workspace ?? {
    execute: async (): Promise<WorkspaceCommandResult> => {
      throw noCanonicalWorkspaceRouter();
    },
  };
  const workspaceRequestDeduper = createRequestIdDeduper<IpcResult<WorkspaceCommandResult>>();
  ipcMain.handle("settings:get", () => success(settings.get()));

  ipcMain.handle("settings:update", async (_event, payload) => {
    const validationError = validateSettingsPatch(payload);
    if (validationError) {
      return failure<FluelySettings>(validationError);
    }

    const result = await settings.update(normalizeSettingsPatch(payload));
    if (result.ok && applyCodexSettings && result.value.codex) {
      try {
        await applyCodexSettings(result.value.codex);
      } catch {
        return failure<FluelySettings>({
          code: "INTERNAL_ERROR",
          message: "Fluely saved the requested settings but could not apply the Codex configuration.",
          action: "Restart Fluely and try again.",
        });
      }
    }
    if (result.ok && applyPrivacy && result.value.privacy && isRecord(payload) && isRecord(payload.privacy) &&
      typeof payload.privacy.captureProtection === "boolean") {
      applyPrivacy?.(result.value.privacy.captureProtection);
    }
    if (result.ok && isRecord(payload) && isRecord(payload.shortcuts)) {
      const shortcutError = applyShortcutSettings(applyShortcuts, result.value.shortcuts);
      if (shortcutError) {
        return failure<FluelySettings>(shortcutError);
      }
    }
    if (result.ok && applyPhoneGatewaySettings && isRecord(payload) && isRecord(payload.phoneGateway) &&
      typeof payload.phoneGateway.enabled === "boolean") {
      try {
        await applyPhoneGatewaySettings(result.value.phoneGateway);
      } catch {
        return failure<FluelySettings>({
          code: "INTERNAL_ERROR",
          message: "Fluely saved the phone companion setting but could not apply it.",
          action: "Restart Fluely and try again.",
        });
      }
    }
    return serializeIpcResult(result);
  });

  ipcMain.handle("settings:reset", async () => {
    const result = await settings.reset();
    if (result.ok && applyCodexSettings && result.value.codex) {
      try {
        await applyCodexSettings(result.value.codex);
      } catch {
        return failure<FluelySettings>({
          code: "INTERNAL_ERROR",
          message: "Fluely restored its settings but could not apply the Codex configuration.",
          action: "Restart Fluely to apply the restored Codex settings.",
        });
      }
    }
    if (result.ok && applyPrivacy && result.value.privacy) {
      applyPrivacy?.(result.value.privacy.captureProtection);
    }
    if (result.ok && applyWindowOpacityHandler && result.value.window) {
      try {
        await applyWindowOpacityHandler(result.value.window.opacity);
      } catch {
        return failure<FluelySettings>({
          code: "INTERNAL_ERROR",
          message: "Fluely restored its settings but could not apply the window opacity.",
          action: "Restart Fluely to apply the restored window appearance.",
        });
      }
    }
    if (result.ok) {
      const shortcutError = applyShortcutSettings(applyShortcuts, result.value.shortcuts);
      if (shortcutError) {
        return failure<FluelySettings>(shortcutError);
      }
    }
    if (result.ok && applyPhoneGatewaySettings && result.value.phoneGateway) {
      try {
        await applyPhoneGatewaySettings(result.value.phoneGateway);
      } catch {
        return failure<FluelySettings>({
          code: "INTERNAL_ERROR",
          message: "Fluely restored settings but could not apply the phone companion state.",
          action: "Restart Fluely to apply the restored phone companion setting.",
        });
      }
    }
    return serializeIpcResult(result);
  });
  ipcMain.handle("shortcuts:get", () => success(shortcuts.getStatus()));

  ipcMain.handle("shortcuts:update", (_event, payload) => {
    if (!isShortcutSettings(payload)) {
      return failure<ShortcutStatus>(invalidShortcutPayload());
    }

    return serializeIpcResult(shortcuts.update(payload));
  });

  ipcMain.handle("screenshots:get", () => success(screenshots.getState()));

  ipcMain.handle("workspace:execute", async (_event, payload) => {
    const normalized = normalizeWorkspaceCommand(payload);
    if (normalized.error || !normalized.command) {
      return failure<WorkspaceCommandResult>(normalized.error ?? invalidWorkspaceCommand());
    }

    const command = normalized.command;
    try {
      return await workspaceRequestDeduper.run(
        command.requestId,
        JSON.stringify(command),
        async () => {
          try {
            return success(serializeWorkspaceResult(await workspaceHandler.execute(command, "desktop")));
          } catch (error) {
            return failure<WorkspaceCommandResult>(errorFromUnknown(error, {
              code: "INTERNAL_ERROR",
              message: "Fluely could not complete that workspace command.",
              action: "Try the command again.",
            }));
          }
        },
      );
    } catch (error) {
      return failure<WorkspaceCommandResult>(errorFromUnknown(error, invalidWorkspaceCommand(
        "This request ID was already used for a different workspace command.",
      )));
    }
  });

  if (conversation) {
    ipcMain.handle("conversation:get-snapshot", () => {
      try {
        return success(serializeConversationSnapshot(conversation.snapshot()));
      } catch (error) {
        return failure<ConversationSnapshot>(errorFromUnknown(error, {
          code: "INTERNAL_ERROR",
          message: "Fluely could not read the current conversation.",
          action: "Restart Fluely and try again.",
        }));
      }
    });

    if (notifyConversationEvent) {
      try {
        conversation.subscribe((event) => {
          try {
            notifyConversationEvent(serializeConversationEvent(event));
          } catch {
            // Renderer teardown must not break canonical conversation writes.
          }
        });
      } catch {
        // A failed observer registration must not prevent command handlers.
      }
    }
  }

  if (codexHandler) {
    ipcMain.handle("codex:get-status", async () => {
      try {
        const configured = configuredCodex(settings);
        const configuredPath = configured.path;
        const result = codexHandler.getStatus
          ? await codexHandler.getStatus()
          : codexHandler.validateExecutable
            ? await codexHandler.validateExecutable(configuredPath, configured.timeoutMs)
            : { available: false, configuredPath };
        return success(serializeCodexStatus(result, configuredPath));
      } catch (error) {
        return failure<CodexStatus>(statusFailure(error));
      }
    });

    ipcMain.handle("codex:validate", async (_event, payload) => {
      if (typeof payload !== "string" || payload.trim().length === 0) {
        return failure<CodexStatus>({
          code: "INVALID_ARGUMENT",
          message: "Codex executable path must be a non-empty string.",
          action: "Enter the Codex CLI executable path and try again.",
        });
      }

      const configuredPath = payload.trim();
      try {
        const configured = configuredCodex(settings);
        const result = codexHandler.validate
          ? await codexHandler.validate(configuredPath)
          : codexHandler.validateExecutable
            ? await codexHandler.validateExecutable(configuredPath, configured.timeoutMs)
            : { available: false, configuredPath };
        return success(serializeCodexStatus(result, configuredPath));
      } catch (error) {
        return failure<CodexStatus>(statusFailure(error));
      }
    });
  }

  if (analysisHandler) {
    if (notifyAnalysisState) {
      try {
        analysisHandler.onStateChanged((event) => {
          try {
            notifyAnalysisState(serializeAnalysisEvent(event));
          } catch {
            // Renderer teardown must not break the analysis stream.
          }
        });
      } catch {
        // A failed observer registration should not prevent request handlers.
      }
    }

    ipcMain.handle("analysis:get-status", () => {
      try {
        if (!analysisHandler.getState && !analysisHandler.getStatus) {
          return failure<AnalysisState>({
            code: "ANALYSIS_FAILED",
            message: "Fluely could not read the analysis status.",
            action: "Restart Fluely and try again.",
          });
        }
        const state = analysisHandler.getState
          ? analysisHandler.getState()
          : analysisHandler.getStatus?.();
        return success(serializeAnalysisState(state));
      } catch (error) {
        return failure<AnalysisState>(errorFromUnknown(error, {
          code: "ANALYSIS_FAILED",
          message: "Fluely could not read the analysis status.",
          action: "Restart Fluely and try again.",
        }));
      }
    });
  }

  if (phoneGateway) {
    ipcMain.handle("phone-gateway:get-status", () => {
      try {
        return success(serializePhoneGatewayStatus(phoneGateway.getStatus()));
      } catch {
        return failure<PhoneGatewayStatus>({
          code: "INTERNAL_ERROR",
          message: "Fluely could not read the phone companion state.",
          action: "Restart Fluely and try again.",
        });
      }
    });

    const actions = [
      ["phone-gateway:enable", () => phoneGateway.enable()],
      ["phone-gateway:disable", () => phoneGateway.disable()],
      ["phone-gateway:regenerate-pairing", () => phoneGateway.regeneratePairing()],
    ] as const;
    for (const [channel, action] of actions) {
      ipcMain.handle(channel, async () => {
        try {
          const result = await action();
          return serializePhoneGatewayResult(result);
        } catch {
          return failure<PhoneGatewayStatus>({
            code: "INTERNAL_ERROR",
            message: "Fluely could not update the phone companion.",
            action: "Restart Fluely and try again.",
          });
        }
      });
    }
  }

  if (windowHandler || applyWindowOpacityHandler) {
    ipcMain.handle("window:set-opacity", async (_event, payload) => {
      if (typeof payload !== "number" || !Number.isFinite(payload)) {
        return failure<WindowSettings>(invalidOpacity());
      }

      const opacity = clampOpacity(payload);
      try {
        const result = await settings.update({ window: { opacity } });
        if (!result.ok) {
          return failure<WindowSettings>(safeIpcError(result.error.code, result.error));
        }
        const apply = applyWindowOpacityHandler ?? windowHandler?.setOpacity;
        if (apply) {
          await apply(opacity);
        }
        return success({ ...result.value.window, opacity });
      } catch (error) {
        return failure<WindowSettings>(errorFromUnknown(error, {
          code: "SETTINGS_WRITE_FAILED",
          message: "Fluely could not save the window opacity.",
          action: "Check the Fluely data directory permissions and try again.",
        }));
      }
    });

    ipcMain.handle("window:hide", async () => {
      const hide = windowHandler?.hide;
      if (!hide) {
        return failure<void>({
          code: "INTERNAL_ERROR",
          message: "Fluely could not hide its window.",
          action: "Use the Fluely shortcut to hide the window and try again.",
        });
      }

      try {
        await hide();
        return success<void>(undefined);
      } catch (error) {
        return failure<void>(errorFromUnknown(error, {
          code: "INTERNAL_ERROR",
          message: "Fluely could not hide its window.",
          action: "Use the Fluely shortcut to hide the window and try again.",
        }));
      }
    });
  }

  ipcMain.handle("app:get-status", () => success(getAppStatus()));
}
