import type {
  AppStatus,
  FluelySettings,
  IpcError,
  IpcResult,
  ScreenshotItem,
  ScreenshotState,
  SettingsPatch,
  ShortcutSettings,
  ShortcutStatus,
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

export interface IpcHandlerDependencies {
  ipcMain: IpcMainAdapter;
  settings: SettingsHandlerService;
  shortcuts: ShortcutHandlerService;
  screenshots: ScreenshotHandlerService;
  applyPrivacy?: (enabled: boolean) => void;
  getAppStatus(): AppStatus;
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error };
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

export function registerIpcHandlers({
  ipcMain,
  settings,
  shortcuts,
  screenshots,
  applyPrivacy,
  getAppStatus,
}: IpcHandlerDependencies): void {
  ipcMain.handle("settings:get", () => success(settings.get()));

  ipcMain.handle("settings:update", async (_event, payload) => {
    const validationError = validateSettingsPatch(payload);
    if (validationError) {
      return failure<FluelySettings>(validationError);
    }

    const result = await settings.update(normalizeSettingsPatch(payload));
    if (result.ok && applyPrivacy && result.value.privacy && isRecord(payload) && isRecord(payload.privacy) &&
      typeof payload.privacy.captureProtection === "boolean") {
      applyPrivacy?.(result.value.privacy.captureProtection);
    }
    return result;
  });

  ipcMain.handle("settings:reset", async () => {
    const result = await settings.reset();
    if (result.ok && applyPrivacy && result.value.privacy) {
      applyPrivacy?.(result.value.privacy.captureProtection);
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
    }
  });

  ipcMain.handle("screenshots:clear", async () => {
    try {
      return success(await screenshots.clear());
    } catch (error) {
      return failure<ScreenshotState>(screenshotFailure(error));
    }
  });

  ipcMain.handle("app:get-status", () => success(getAppStatus()));
}
