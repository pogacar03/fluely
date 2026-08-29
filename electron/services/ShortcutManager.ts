import type {
  IpcError,
  IpcResult,
  ShortcutAction,
  ShortcutSettings,
  ShortcutStatus,
  ShortcutStatusEntry,
} from "../../src/shared/ipc";

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean;
  unregisterAll(): void;
}

export interface WindowAdapter {
  isVisible(): boolean;
  show(): void;
  hide(): void;
}

export interface ShortcutActionHandlers {
  captureScreenshot?: () => void;
  analyzeQueue?: () => void;
  captureAndAnalyze?: () => void;
  cancelAndClear?: () => void;
}

const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "toggleVisibility",
  "captureScreenshot",
  "analyzeQueue",
  "captureAndAnalyze",
  "cancelAndClear",
];

const PLACEHOLDER_ACTIONS = new Set<ShortcutAction>([
  "captureScreenshot",
  "analyzeQueue",
  "captureAndAnalyze",
  "cancelAndClear",
]);

function invalidShortcut(message: string): IpcError {
  return {
    code: "INVALID_ARGUMENT",
    message,
    action: "Enter each shortcut once, using a non-empty accelerator.",
  };
}

function validateShortcuts(input: ShortcutSettings): IpcError | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalidShortcut("Shortcuts must be an object.");
  }

  const seen = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const value = input[action];
    if (typeof value !== "string" || value.trim().length === 0) {
      return invalidShortcut(`Shortcut ${action} must be a non-empty string.`);
    }

    const accelerator = value.trim();
    if (seen.has(accelerator)) {
      return invalidShortcut(`Shortcut ${action} duplicates another shortcut: ${accelerator}.`);
    }
    seen.add(accelerator);
  }

  return null;
}

function cloneStatus(status: ShortcutStatus): ShortcutStatus {
  return {
    entries: status.entries.map((entry) => ({ ...entry })),
    updatedAt: status.updatedAt,
  };
}

export class ShortcutManager {
  private status: ShortcutStatus = { entries: [], updatedAt: new Date(0).toISOString() };

  public constructor(
    private readonly globalShortcut: GlobalShortcutAdapter,
    private readonly window: WindowAdapter,
    private readonly handlers: ShortcutActionHandlers = {},
  ) {}

  public registerAll(shortcuts: ShortcutSettings): IpcResult<ShortcutStatus> {
    const validationError = validateShortcuts(shortcuts);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    this.globalShortcut.unregisterAll();
    const entries = SHORTCUT_ACTIONS.map((action) => this.registerAction(action, shortcuts[action]));
    this.status = {
      entries,
      updatedAt: new Date().toISOString(),
    };

    return { ok: true, value: this.getStatus() };
  }

  public update(shortcuts: ShortcutSettings): IpcResult<ShortcutStatus> {
    return this.registerAll(shortcuts);
  }

  public getStatus(): ShortcutStatus {
    return cloneStatus(this.status);
  }

  public dispose(): void {
    this.globalShortcut.unregisterAll();
    this.status = { entries: [], updatedAt: new Date().toISOString() };
  }

  private registerAction(action: ShortcutAction, accelerator: string): ShortcutStatusEntry {
    const registered = this.globalShortcut.register(accelerator, this.callbackFor(action));

    if (!registered) {
      return {
        action,
        accelerator,
        registered: false,
        available: false,
        message: "This shortcut is unavailable because another application is using it.",
        errorCode: "SHORTCUT_CONFLICT",
      };
    }

    if (PLACEHOLDER_ACTIONS.has(action)) {
      return {
        action,
        accelerator,
        registered: true,
        available: false,
        message: "Reserved for a later Fluely milestone.",
      };
    }

    return {
      action,
      accelerator,
      registered: true,
      available: true,
      message: "Active.",
    };
  }

  private callbackFor(action: ShortcutAction): () => void {
    if (action === "toggleVisibility") {
      return () => {
        if (this.window.isVisible()) {
          this.window.hide();
        } else {
          this.window.show();
        }
      };
    }

    return this.handlers[action] ?? (() => undefined);
  }
}
