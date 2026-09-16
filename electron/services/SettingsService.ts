import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FluelySettings, IpcError, IpcResult, SettingsPatch } from "../../src/shared/ipc";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  validateShortcutSettings,
  validateSettingsPatch,
} from "./settings-core";

export interface SettingsLoadResult {
  settings: FluelySettings;
  warning?: IpcError;
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error };
}

function cloneSettings(settings: FluelySettings): FluelySettings {
  return normalizeSettings(settings);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class SettingsService {
  private settings = cloneSettings(DEFAULT_SETTINGS);
  private readonly settingsPath: string;

  public constructor(private readonly userDataPath: string) {
    this.settingsPath = join(userDataPath, "settings.json");
  }

  public get(): FluelySettings {
    return cloneSettings(this.settings);
  }

  public async load(): Promise<SettingsLoadResult> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      this.settings = normalizeSettings(JSON.parse(raw) as unknown);
      return { settings: this.get() };
    } catch (error) {
      if (isMissingFile(error)) {
        this.settings = cloneSettings(DEFAULT_SETTINGS);
        return { settings: this.get() };
      }

      await this.backupInvalidSettings();
      this.settings = cloneSettings(DEFAULT_SETTINGS);
      return {
        settings: this.get(),
        warning: {
          code: "SETTINGS_READ_FAILED",
          message: "Fluely could not read its settings, so the default settings are active.",
          action: "Review your settings and save them again.",
        },
      };
    }
  }

  public async update(patch: SettingsPatch): Promise<IpcResult<FluelySettings>> {
    const validationError = validateSettingsPatch(patch);
    if (validationError) {
      return failure(validationError);
    }

    const nextSettings = mergeSettings(this.settings, patch);
    const shortcutValidationError = validateShortcutSettings(nextSettings.shortcuts);
    if (shortcutValidationError) {
      return failure(shortcutValidationError);
    }

    try {
      await this.writeAtomically(nextSettings);
      this.settings = nextSettings;
      return success(this.get());
    } catch {
      return failure({
        code: "SETTINGS_WRITE_FAILED",
        message: "Fluely could not save the new settings.",
        action: "Check the Fluely data directory permissions and try again.",
      });
    }
  }

  public async reset(): Promise<IpcResult<FluelySettings>> {
    const nextSettings = cloneSettings(DEFAULT_SETTINGS);

    try {
      await this.writeAtomically(nextSettings);
      this.settings = nextSettings;
      return success(this.get());
    } catch {
      return failure({
        code: "SETTINGS_WRITE_FAILED",
        message: "Fluely could not restore the default settings.",
        action: "Check the Fluely data directory permissions and try again.",
      });
    }
  }

  private async writeAtomically(settings: FluelySettings): Promise<void> {
    await mkdir(this.userDataPath, { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const content = `${JSON.stringify(settings, null, 2)}\n`;

    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.settingsPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async backupInvalidSettings(): Promise<void> {
    const backupPath = join(
      this.userDataPath,
      `settings.invalid-${Date.now()}-${randomBytes(4).toString("hex")}.json`,
    );

    await copyFile(this.settingsPath, backupPath).catch(() => undefined);
  }
}
