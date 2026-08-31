import type {
  AnalysisIntent,
  AnalysisRequest,
  AnalysisState,
  AnalysisStateChangedEvent,
  AppStatus,
  CodexCliSettings,
  CodexStatus,
  FluelySettings,
  IpcError,
  IpcResult,
  ScreenshotItem,
  ScreenshotState,
  SettingsPatch,
  ShortcutSettings,
  ShortcutStatus,
  WindowMode,
  WindowSettings,
} from "../../src/shared/ipc";
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
  capture(): Promise<ScreenshotItem>;
  delete(id: string): Promise<ScreenshotState>;
  clear(): Promise<ScreenshotState>;
}

export interface AnalysisHandlerService {
  start(request: AnalysisRequest): AnalysisState | Promise<AnalysisState>;
  cancel(): AnalysisState | Promise<AnalysisState>;
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
  applyPrivacy?: (enabled: boolean) => void;
  applyCodexSettings?: (settings: CodexCliSettings) => void | Promise<void>;
  applyOpacity?: (opacity: number) => void | Promise<void>;
  applyWindowOpacity?: (opacity: number) => void | Promise<void>;
  applyShortcuts?: (shortcuts: ShortcutSettings) => IpcResult<ShortcutStatus> | void;
  notifyScreenshotState?: (state: ScreenshotState) => void;
  notifyAnalysisState?: (event: AnalysisStateChangedEvent) => void;
  getAppStatus(): AppStatus;
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error };
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
    return result && !result.ok ? result.error : null;
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
const MAX_ANALYSIS_SCREENSHOTS = 5;
const ANALYSIS_INTENTS: readonly AnalysisIntent[] = ["answer", "explain", "follow-up", "recap"];
const MIN_WINDOW_OPACITY = 0.35;
const MAX_WINDOW_OPACITY = 1;
const SCREENSHOT_ERROR_CODES = new Set<IpcError["code"]>([
  "SCREEN_CAPTURE_DENIED",
  "SCREEN_CAPTURE_RESTRICTED",
  "SCREEN_CAPTURE_PERMISSION_REQUIRED",
  "SCREEN_CAPTURE_FAILED",
  "CAPTURE_IN_PROGRESS",
  "SCREENSHOT_NOT_FOUND",
]);

function invalidScreenshotId(): IpcError {
  return {
    code: "INVALID_ARGUMENT",
    message: "Screenshot ID must be a valid managed screenshot identifier.",
    action: "Refresh the screenshot queue and try again.",
  };
}

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

function errorFromUnknown(value: unknown, fallback: IpcError): IpcError {
  if (isRecord(value) && typeof value.code === "string" && IPC_ERROR_CODES.has(value.code as IpcError["code"]) &&
    typeof value.message === "string" && typeof value.action === "string") {
    return {
      code: value.code as IpcError["code"],
      message: value.message,
      action: value.action,
    };
  }

  if (value instanceof Error && value.message.trim()) {
    return { ...fallback, message: value.message.trim() };
  }

  if (isRecord(value) && typeof value.message === "string" && value.message.trim() &&
    typeof value.action === "string" && value.action.trim()) {
    return {
      ...fallback,
      message: value.message.trim(),
      action: value.action.trim(),
    };
  }

  return fallback;
}

function internalFailure(action: string): IpcError {
  return {
    code: "INTERNAL_ERROR",
    message: "Fluely could not complete that request in its main process.",
    action,
  };
}

function invalidAnalysisRequest(message = "Analysis requests must include a prompt, screenshot IDs, intent, and fast mode."): IpcError {
  return {
    code: "INVALID_ARGUMENT",
    message,
    action: "Refresh the analysis form and try again.",
  };
}

function normalizeAnalysisRequest(input: unknown): { request?: AnalysisRequest; error?: IpcError } {
  if (!isRecord(input)) {
    return { error: invalidAnalysisRequest() };
  }

  if (typeof input.prompt !== "string" || input.prompt.length > MAX_ANALYSIS_PROMPT_LENGTH) {
    return {
      error: invalidAnalysisRequest(
        `Analysis prompt must be a string no longer than ${MAX_ANALYSIS_PROMPT_LENGTH} characters.`,
      ),
    };
  }

  if (!Array.isArray(input.screenshotIds) || input.screenshotIds.length > MAX_ANALYSIS_SCREENSHOTS) {
    return {
      error: invalidAnalysisRequest(
        `Analysis screenshotIds must be an array of at most ${MAX_ANALYSIS_SCREENSHOTS} managed IDs.`,
      ),
    };
  }

  const screenshotIds: string[] = [];
  for (const id of input.screenshotIds) {
    if (!isScreenshotId(id)) {
      return { error: invalidAnalysisRequest("Analysis screenshotIds must contain managed screenshot IDs only.") };
    }
    if (screenshotIds.includes(id)) {
      return { error: invalidAnalysisRequest("Analysis screenshotIds must not contain duplicates.") };
    }
    screenshotIds.push(id);
  }

  if (typeof input.intent !== "string" || !ANALYSIS_INTENTS.includes(input.intent as AnalysisIntent)) {
    return { error: invalidAnalysisRequest("Analysis intent is not supported.") };
  }

  if (typeof input.fast !== "boolean") {
    return { error: invalidAnalysisRequest("Analysis fast mode must be a boolean.") };
  }

  return {
    request: {
      prompt: input.prompt.trim(),
      screenshotIds,
      intent: input.intent as AnalysisIntent,
      fast: input.fast,
    },
  };
}

function unknownScreenshotError(): IpcError {
  return {
    code: "SCREENSHOT_NOT_FOUND",
    message: "One or more selected screenshots are no longer in the queue.",
    action: "Refresh the screenshot queue and select the available screenshots again.",
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

function invalidWindowMode(): IpcError {
  return {
    code: "INVALID_ARGUMENT",
    message: "Window mode must be setup or work.",
    action: "Choose setup or work mode and try again.",
  };
}

function isWindowMode(value: unknown): value is WindowMode {
  return value === "setup" || value === "work";
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

function screenshotFailure(error: unknown): IpcError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.code === "string" &&
      SCREENSHOT_ERROR_CODES.has(candidate.code as IpcError["code"]) &&
      typeof candidate.message === "string" &&
      typeof candidate.action === "string") {
      return candidate as unknown as IpcError;
    }
  }

  return {
    code: "SCREEN_CAPTURE_FAILED",
    message: "Fluely could not capture the selected display.",
    action: "Check that a display is available and try again.",
  };
}

function emitScreenshotState(
  notifyScreenshotState: ((state: ScreenshotState) => void) | undefined,
  screenshots: ScreenshotHandlerService,
): void {
  try {
    notifyScreenshotState?.(screenshots.getState());
  } catch {
    // Renderer notification failures must not change the IPC mutation result.
  }
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
  notifyScreenshotState,
  notifyAnalysisState,
  getAppStatus,
}: IpcHandlerDependencies): void {
  const analysisHandler = analysis ?? analysisService;
  const codexHandler = codex ?? codexService ?? codexCli;
  const windowHandler = window ?? windowTarget ?? browserWindow;
  const applyWindowOpacityHandler = applyOpacity ?? applyWindowOpacity;
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
    return result;
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
    return result;
  });
  ipcMain.handle("shortcuts:get", () => success(shortcuts.getStatus()));

  ipcMain.handle("shortcuts:update", (_event, payload) => {
    if (!isShortcutSettings(payload)) {
      return failure<ShortcutStatus>(invalidShortcutPayload());
    }

    return shortcuts.update(payload);
  });

  ipcMain.handle("screenshots:get", () => success(screenshots.getState()));

  ipcMain.handle("screenshots:capture", async () => {
    try {
      return success(await screenshots.capture());
    } catch (error) {
      return failure<ScreenshotItem>(screenshotFailure(error));
    } finally {
      emitScreenshotState(notifyScreenshotState, screenshots);
    }
  });

  ipcMain.handle("screenshots:delete", async (_event, payload) => {
    if (!isScreenshotId(payload)) {
      return failure<ScreenshotState>(invalidScreenshotId());
    }

    try {
      return success(await screenshots.delete(payload));
    } catch (error) {
      return failure<ScreenshotState>(screenshotFailure(error));
    } finally {
      emitScreenshotState(notifyScreenshotState, screenshots);
    }
  });

  ipcMain.handle("screenshots:clear", async () => {
    try {
      return success(await screenshots.clear());
    } catch (error) {
      return failure<ScreenshotState>(screenshotFailure(error));
    } finally {
      emitScreenshotState(notifyScreenshotState, screenshots);
    }
  });

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

    ipcMain.handle("analysis:start", async (_event, payload) => {
      const normalized = normalizeAnalysisRequest(payload);
      if (normalized.error || !normalized.request) {
        return failure<AnalysisState>(normalized.error ?? invalidAnalysisRequest());
      }

      try {
        const queuedIds = new Set(screenshots.getState().items.map((item) => item.id));
        if (normalized.request.screenshotIds.some((id) => !queuedIds.has(id))) {
          return failure<AnalysisState>(unknownScreenshotError());
        }
      } catch (error) {
        return failure<AnalysisState>(errorFromUnknown(error, internalFailure("Refresh the screenshot queue and try again.")));
      }

      try {
        const state = await analysisHandler.start(normalized.request);
        return success(serializeAnalysisState(state));
      } catch (error) {
        return failure<AnalysisState>(errorFromUnknown(error, {
          code: "ANALYSIS_FAILED",
          message: "Fluely could not start the analysis request.",
          action: "Cancel any running request and try again.",
        }));
      }
    });

    ipcMain.handle("analysis:cancel", async () => {
      try {
        return success(serializeAnalysisState(await analysisHandler.cancel()));
      } catch (error) {
        return failure<AnalysisState>(errorFromUnknown(error, {
          code: "ANALYSIS_FAILED",
          message: "Fluely could not cancel the analysis request.",
          action: "Wait for the current request to finish, then try again.",
        }));
      }
    });

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

  if (windowHandler || applyWindowOpacityHandler) {
    ipcMain.handle("window:set-opacity", async (_event, payload) => {
      if (typeof payload !== "number" || !Number.isFinite(payload)) {
        return failure<WindowSettings>(invalidOpacity());
      }

      const opacity = clampOpacity(payload);
      try {
        const result = await settings.update({ window: { opacity } });
        if (!result.ok) {
          return failure<WindowSettings>(result.error);
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

    ipcMain.handle("window:set-mode", async (_event, payload) => {
      if (!isWindowMode(payload)) {
        return failure<FluelySettings>(invalidWindowMode());
      }

      try {
        return await settings.update({ setupComplete: payload === "work" });
      } catch (error) {
        return failure<FluelySettings>(errorFromUnknown(error, {
          code: "SETTINGS_WRITE_FAILED",
          message: "Fluely could not save the requested window mode.",
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
