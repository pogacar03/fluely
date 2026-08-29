import type {
  AppStatus,
  FluelySettings,
  IpcError,
  IpcResult,
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

export interface IpcHandlerDependencies {
  ipcMain: IpcMainAdapter;
  settings: SettingsHandlerService;
  shortcuts: ShortcutHandlerService;
  getAppStatus(): AppStatus;
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error };
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

export function registerIpcHandlers({
  ipcMain,
  settings,
  shortcuts,
  getAppStatus,
}: IpcHandlerDependencies): void {
  ipcMain.handle("settings:get", () => success(settings.get()));

  ipcMain.handle("settings:update", async (_event, payload) => {
    const validationError = validateSettingsPatch(payload);
    if (validationError) {
      return failure<FluelySettings>(validationError);
    }

    return settings.update(normalizeSettingsPatch(payload));
  });

  ipcMain.handle("settings:reset", () => settings.reset());
  ipcMain.handle("shortcuts:get", () => success(shortcuts.getStatus()));

  ipcMain.handle("shortcuts:update", (_event, payload) => {
    if (!isShortcutSettings(payload)) {
      return failure<ShortcutStatus>(invalidShortcutPayload());
    }

    return shortcuts.update(payload);
  });

  ipcMain.handle("app:get-status", () => success(getAppStatus()));
}
