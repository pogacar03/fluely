import type {
  FluelySettings,
  IpcError,
  PrivacySettings,
  SettingsPatch,
  ShortcutAction,
  ShortcutSettings,
  WindowSettings,
} from "../../src/shared/ipc";

const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "toggleVisibility",
  "captureScreenshot",
  "analyzeQueue",
  "captureAndAnalyze",
  "cancelAndClear",
];

const DEFAULT_SHORTCUTS: ShortcutSettings = {
  toggleVisibility: "CommandOrControl+B",
  captureScreenshot: "CommandOrControl+Shift+8",
  analyzeQueue: "CommandOrControl+Enter",
  captureAndAnalyze: "CommandOrControl+Shift+Enter",
  cancelAndClear: "CommandOrControl+R",
};

const DEFAULT_PRIVACY: PrivacySettings = {
  captureProtection: true,
};

export const DEFAULT_SETTINGS: FluelySettings = {
  shortcuts: { ...DEFAULT_SHORTCUTS },
  window: { width: 960, height: 720 },
  privacy: { ...DEFAULT_PRIVACY },
};

const MIN_WINDOW_WIDTH = 480;
const MAX_WINDOW_WIDTH = 1600;
const MIN_WINDOW_HEIGHT = 360;
const MAX_WINDOW_HEIGHT = 1400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaultSettings(): FluelySettings {
  return {
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
    window: { ...DEFAULT_SETTINGS.window },
    privacy: { ...DEFAULT_SETTINGS.privacy },
  };
}

function normalizeShortcut(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeDimension(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeSettings(input: unknown): FluelySettings {
  const settings = cloneDefaultSettings();

  if (!isRecord(input)) {
    return settings;
  }

  if (isRecord(input.shortcuts)) {
    for (const action of SHORTCUT_ACTIONS) {
      settings.shortcuts[action] = normalizeShortcut(
        input.shortcuts[action],
        DEFAULT_SETTINGS.shortcuts[action],
      );
    }
  }

  if (isRecord(input.window)) {
    settings.window.width = normalizeDimension(
      input.window.width,
      DEFAULT_SETTINGS.window.width,
      MIN_WINDOW_WIDTH,
      MAX_WINDOW_WIDTH,
    );
    settings.window.height = normalizeDimension(
      input.window.height,
      DEFAULT_SETTINGS.window.height,
      MIN_WINDOW_HEIGHT,
      MAX_WINDOW_HEIGHT,
    );
  }

  if (isRecord(input.privacy) && typeof input.privacy.captureProtection === "boolean") {
    settings.privacy.captureProtection = input.privacy.captureProtection;
  }

  return settings;
}

export function normalizeSettingsPatch(input: unknown): SettingsPatch {
  if (!isRecord(input)) {
    return {};
  }

  const patch: SettingsPatch = {};

  if (isRecord(input.shortcuts)) {
    const shortcuts: Partial<ShortcutSettings> = {};
    for (const action of SHORTCUT_ACTIONS) {
      if (action in input.shortcuts) {
        shortcuts[action] = input.shortcuts[action] as string;
      }
    }
    patch.shortcuts = shortcuts;
  }

  if (isRecord(input.window)) {
    const window: Partial<WindowSettings> = {};
    if ("width" in input.window) {
      window.width = input.window.width as number;
    }
    if ("height" in input.window) {
      window.height = input.window.height as number;
    }
    patch.window = window;
  }

  if (isRecord(input.privacy)) {
    const privacy: Partial<PrivacySettings> = {};
    if ("captureProtection" in input.privacy) {
      privacy.captureProtection = input.privacy.captureProtection as boolean;
    }
    patch.privacy = privacy;
  }

  return patch;
}

export function validateSettingsPatch(input: unknown): IpcError | null {
  if (!isRecord(input)) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Settings patch must be an object.",
      action: "Refresh Fluely and try again.",
    };
  }

  if ("shortcuts" in input && !isRecord(input.shortcuts)) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Shortcuts must be an object.",
      action: "Enter the shortcut values again and try once more.",
    };
  }

  if (isRecord(input.shortcuts)) {
    for (const action of SHORTCUT_ACTIONS) {
      if (action in input.shortcuts &&
        (typeof input.shortcuts[action] !== "string" || input.shortcuts[action].trim().length === 0)) {
        return {
          code: "INVALID_ARGUMENT",
          message: `Shortcut ${action} must be a non-empty string.`,
          action: "Enter a valid keyboard accelerator and try again.",
        };
      }
    }
  }

  if ("window" in input && !isRecord(input.window)) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Window settings must be an object.",
      action: "Enter numeric window dimensions and try once more.",
    };
  }

  if (isRecord(input.window)) {
    for (const dimension of ["width", "height"] as const) {
      if (dimension in input.window &&
        (typeof input.window[dimension] !== "number" || !Number.isFinite(input.window[dimension]))) {
        return {
          code: "INVALID_ARGUMENT",
          message: `Window ${dimension} must be a finite number.`,
          action: "Enter numeric window dimensions and try again.",
        };
      }
    }
  }

  if ("privacy" in input && !isRecord(input.privacy)) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Privacy settings must be an object.",
      action: "Choose whether Fluely should protect its window from capture and try again.",
    };
  }

  if (isRecord(input.privacy) &&
    "captureProtection" in input.privacy &&
    typeof input.privacy.captureProtection !== "boolean") {
    return {
      code: "INVALID_ARGUMENT",
      message: "Privacy captureProtection must be a boolean.",
      action: "Choose whether Fluely should protect its window from capture and try again.",
    };
  }

  return null;
}

export function mergeSettings(current: FluelySettings, patch: SettingsPatch): FluelySettings {
  return normalizeSettings({
    shortcuts: { ...current.shortcuts, ...patch.shortcuts },
    window: { ...current.window, ...patch.window },
    privacy: { ...current.privacy, ...patch.privacy },
  });
}
