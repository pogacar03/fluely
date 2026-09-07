import type {
  CodexCliSettings,
  CodexModelReasoningEffort,
  CodexSandboxMode,
  FluelySettings,
  IpcError,
  PrivacySettings,
  PhoneGatewaySettings,
  SettingsPatch,
  ShortcutAction,
  ShortcutSettings,
  WindowSettings,
} from "../../src/shared/ipc";
import { DEFAULT_PHONE_GATEWAY_SETTINGS } from "../../src/shared/phone-gateway";

const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "toggleVisibility",
  "captureScreenshot",
  "ask",
  "cancelAndClear",
];

const DEFAULT_SHORTCUTS: ShortcutSettings = {
  toggleVisibility: "CommandOrControl+B",
  captureScreenshot: "CommandOrControl+Shift+8",
  ask: "CommandOrControl+Enter",
  cancelAndClear: "CommandOrControl+R",
};

const DEFAULT_PRIVACY: PrivacySettings = {
  captureProtection: true,
};

export const DEFAULT_CODEX: CodexCliSettings = {
  enabled: true,
  path: "codex",
  model: "gpt-5.6-sol",
  fastModel: "gpt-5.6-luna",
  timeoutMs: 120000,
  sandboxMode: "read-only",
  modelReasoningEffort: "medium",
};

export const DEFAULT_SETTINGS: FluelySettings = {
  setupComplete: false,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  window: { width: 960, height: 720, opacity: 0.92 },
  privacy: { ...DEFAULT_PRIVACY },
  codex: { ...DEFAULT_CODEX },
  phoneGateway: { ...DEFAULT_PHONE_GATEWAY_SETTINGS },
};

const MIN_WINDOW_WIDTH = 480;
const MAX_WINDOW_WIDTH = 1600;
const MIN_WINDOW_HEIGHT = 360;
const MAX_WINDOW_HEIGHT = 1400;
const MIN_WINDOW_OPACITY = 0.35;
const MAX_WINDOW_OPACITY = 1;

const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

const CODEX_REASONING_EFFORTS: readonly CodexModelReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaultSettings(): FluelySettings {
  return {
    setupComplete: DEFAULT_SETTINGS.setupComplete,
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
    window: { ...DEFAULT_SETTINGS.window },
    privacy: { ...DEFAULT_SETTINGS.privacy },
    codex: { ...DEFAULT_SETTINGS.codex },
    phoneGateway: { ...DEFAULT_SETTINGS.phoneGateway },
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

function normalizeOpacity(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, value));
}

function normalizeTimeout(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  const rounded = Math.round(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizeCodexSandboxMode(value: unknown, fallback: CodexSandboxMode): CodexSandboxMode {
  return typeof value === "string" && CODEX_SANDBOX_MODES.includes(value as CodexSandboxMode)
    ? value as CodexSandboxMode
    : fallback;
}

function normalizeCodexReasoningEffort(
  value: unknown,
  fallback: CodexModelReasoningEffort,
): CodexModelReasoningEffort {
  return typeof value === "string" && CODEX_REASONING_EFFORTS.includes(value as CodexModelReasoningEffort)
    ? value as CodexModelReasoningEffort
    : fallback;
}

export function validateShortcutSettings(input: unknown): IpcError | null {
  if (!isRecord(input)) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Shortcuts must be an object.",
      action: "Enter each shortcut once, using a non-empty accelerator.",
    };
  }

  const seen = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const value = input[action];
    if (typeof value !== "string" || value.trim().length === 0) {
      return {
        code: "INVALID_ARGUMENT",
        message: `Shortcut ${action} must be a non-empty string.`,
        action: "Enter each shortcut once, using a non-empty accelerator.",
      };
    }

    const accelerator = value.trim();
    if (seen.has(accelerator)) {
      return {
        code: "INVALID_ARGUMENT",
        message: `Shortcut ${action} duplicates another shortcut: ${accelerator}.`,
        action: "Enter each shortcut once, using a non-empty accelerator.",
      };
    }
    seen.add(accelerator);
  }

  return null;
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
    settings.window.opacity = normalizeOpacity(
      input.window.opacity,
      DEFAULT_SETTINGS.window.opacity,
    );
  }

  if (isRecord(input.privacy) && typeof input.privacy.captureProtection === "boolean") {
    settings.privacy.captureProtection = input.privacy.captureProtection;
  }

  if (typeof input.setupComplete === "boolean") {
    settings.setupComplete = input.setupComplete;
  }

  if (isRecord(input.codex)) {
    settings.codex.enabled = typeof input.codex.enabled === "boolean"
      ? input.codex.enabled
      : DEFAULT_SETTINGS.codex.enabled;
    settings.codex.path = normalizeShortcut(input.codex.path, DEFAULT_SETTINGS.codex.path);
    settings.codex.model = normalizeShortcut(input.codex.model, DEFAULT_SETTINGS.codex.model);
    settings.codex.fastModel = normalizeShortcut(input.codex.fastModel, DEFAULT_SETTINGS.codex.fastModel);
    settings.codex.timeoutMs = normalizeTimeout(
      input.codex.timeoutMs,
      DEFAULT_SETTINGS.codex.timeoutMs,
    );
    settings.codex.sandboxMode = normalizeCodexSandboxMode(
      input.codex.sandboxMode,
      DEFAULT_SETTINGS.codex.sandboxMode,
    );
    settings.codex.modelReasoningEffort = normalizeCodexReasoningEffort(
      input.codex.modelReasoningEffort,
      DEFAULT_SETTINGS.codex.modelReasoningEffort ?? "medium",
    );
  }

  if (isRecord(input.phoneGateway) && typeof input.phoneGateway.enabled === "boolean") {
    settings.phoneGateway.enabled = input.phoneGateway.enabled;
  }

  return settings;
}

export function normalizeSettingsPatch(input: unknown): SettingsPatch {
  if (!isRecord(input)) {
    return {};
  }

  const patch: SettingsPatch = {};

  if ("setupComplete" in input) {
    patch.setupComplete = input.setupComplete as boolean;
  }

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
    if ("opacity" in input.window) {
      window.opacity = input.window.opacity as number;
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

  if (isRecord(input.codex)) {
    const codex: Partial<CodexCliSettings> = {};
    if ("enabled" in input.codex) {
      codex.enabled = input.codex.enabled as boolean;
    }
    if ("path" in input.codex) {
      codex.path = input.codex.path as string;
    }
    if ("model" in input.codex) {
      codex.model = input.codex.model as string;
    }
    if ("fastModel" in input.codex) {
      codex.fastModel = input.codex.fastModel as string;
    }
    if ("timeoutMs" in input.codex) {
      codex.timeoutMs = input.codex.timeoutMs as number;
    }
    if ("sandboxMode" in input.codex) {
      codex.sandboxMode = input.codex.sandboxMode as CodexSandboxMode;
    }
    if ("modelReasoningEffort" in input.codex) {
      codex.modelReasoningEffort = input.codex.modelReasoningEffort as CodexModelReasoningEffort;
    }
    patch.codex = codex;
  }

  if (isRecord(input.phoneGateway)) {
    const phoneGateway: Partial<PhoneGatewaySettings> = {};
    if ("enabled" in input.phoneGateway) {
      phoneGateway.enabled = input.phoneGateway.enabled as boolean;
    }
    patch.phoneGateway = phoneGateway;
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

  if ("setupComplete" in input && typeof input.setupComplete !== "boolean") {
    return {
      code: "INVALID_ARGUMENT",
      message: "setupComplete must be a boolean.",
      action: "Finish setup or choose setup mode and try again.",
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
    const seenAccelerators = new Set<string>();
    for (const action of SHORTCUT_ACTIONS) {
      if (action in input.shortcuts &&
        (typeof input.shortcuts[action] !== "string" || input.shortcuts[action].trim().length === 0)) {
        return {
          code: "INVALID_ARGUMENT",
          message: `Shortcut ${action} must be a non-empty string.`,
          action: "Enter a valid keyboard accelerator and try again.",
        };
      }

      if (action in input.shortcuts) {
        const accelerator = (input.shortcuts[action] as string).trim();
        if (seenAccelerators.has(accelerator)) {
          return {
            code: "INVALID_ARGUMENT",
            message: `Shortcut ${action} duplicates another shortcut: ${accelerator}.`,
            action: "Enter each shortcut once, using a non-empty accelerator.",
          };
        }
        seenAccelerators.add(accelerator);
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

    if ("opacity" in input.window &&
      (typeof input.window.opacity !== "number" || !Number.isFinite(input.window.opacity))) {
      return {
        code: "INVALID_ARGUMENT",
        message: "Window opacity must be a finite number.",
        action: "Choose a window opacity between 35% and 100% and try again.",
      };
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

  if ("codex" in input && !isRecord(input.codex)) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Codex settings must be an object.",
      action: "Review the Codex CLI settings and try again.",
    };
  }

  if (isRecord(input.codex)) {
    const codex = input.codex;
    if ("enabled" in codex && typeof codex.enabled !== "boolean") {
      return {
        code: "INVALID_ARGUMENT",
        message: "Codex enabled must be a boolean.",
        action: "Choose whether Codex CLI is enabled and try again.",
      };
    }

    for (const field of ["path", "model", "fastModel"] as const) {
      if (field in codex && typeof codex[field] !== "string") {
        return {
          code: "INVALID_ARGUMENT",
          message: `Codex ${field} must be a string.`,
          action: "Enter a non-empty Codex CLI value and try again.",
        };
      }
    }

    if ("timeoutMs" in codex &&
      (typeof codex.timeoutMs !== "number" || !Number.isFinite(codex.timeoutMs) || codex.timeoutMs <= 0)) {
      return {
        code: "INVALID_ARGUMENT",
        message: "Codex timeoutMs must be a positive finite number.",
        action: "Enter a positive Codex timeout and try again.",
      };
    }

    if ("sandboxMode" in codex &&
      (typeof codex.sandboxMode !== "string" || !CODEX_SANDBOX_MODES.includes(codex.sandboxMode as CodexSandboxMode))) {
      return {
        code: "INVALID_ARGUMENT",
        message: "Codex sandboxMode is not supported.",
        action: "Choose read-only, workspace-write, or danger-full-access and try again.",
      };
    }

    if ("modelReasoningEffort" in codex &&
      (typeof codex.modelReasoningEffort !== "string" ||
        !CODEX_REASONING_EFFORTS.includes(codex.modelReasoningEffort as CodexModelReasoningEffort))) {
      return {
        code: "INVALID_ARGUMENT",
        message: "Codex modelReasoningEffort is not supported.",
        action: "Choose none, low, medium, high, xhigh, or max and try again.",
      };
    }
  }

  if ("phoneGateway" in input && !isRecord(input.phoneGateway)) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Phone gateway settings must be an object.",
      action: "Choose whether to start the phone companion on the LAN and try again.",
    };
  }

  if (isRecord(input.phoneGateway) && "enabled" in input.phoneGateway &&
    typeof input.phoneGateway.enabled !== "boolean") {
    return {
      code: "INVALID_ARGUMENT",
      message: "Phone gateway enabled must be a boolean.",
      action: "Choose whether to start the phone companion on the LAN and try again.",
    };
  }

  return null;
}

export function mergeSettings(current: FluelySettings, patch: SettingsPatch): FluelySettings {
  return normalizeSettings({
    setupComplete: patch.setupComplete ?? current.setupComplete,
    shortcuts: { ...current.shortcuts, ...patch.shortcuts },
    window: { ...current.window, ...patch.window },
    privacy: { ...current.privacy, ...patch.privacy },
    codex: { ...current.codex, ...patch.codex },
    phoneGateway: { ...current.phoneGateway, ...patch.phoneGateway },
  });
}
