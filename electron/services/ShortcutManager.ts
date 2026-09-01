import type {
  IpcError,
  IpcResult,
  ShortcutAction,
  ShortcutSettings,
  ShortcutStatus,
  ShortcutStatusEntry,
} from "../../src/shared/ipc";
import { validateShortcutSettings } from "./settings-core";

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean;
  unregisterAll(): void;
}

export interface WindowAdapter {
  isVisible(): boolean;
  show(): void;
  hide(): void;
  isCaptureActive?: () => boolean;
  toggleVisibility?: () => void;
}

export interface ShortcutActionHandlers {
  captureScreenshot?: () => void | Promise<void>;
  analyzeQueue?: () => void | Promise<void>;
  captureAndAnalyze?: () => void | Promise<void>;
  cancelAndClear?: () => void | Promise<void>;
}

const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "toggleVisibility",
  "captureScreenshot",
  "analyzeQueue",
  "captureAndAnalyze",
  "cancelAndClear",
];

function cloneStatus(status: ShortcutStatus): ShortcutStatus {
  return {
    entries: status.entries.map((entry) => ({ ...entry })),
    updatedAt: status.updatedAt,
  };
}

function cloneShortcuts(shortcuts: ShortcutSettings | null): ShortcutSettings | null {
  return shortcuts ? { ...shortcuts } : null;
}

function registrationFailure(): IpcError {
  return {
    code: "INTERNAL_ERROR",
    message: "Fluely could not register its shortcuts with the operating system.",
    action: "Restart Fluely and try again.",
  };
}

export class ShortcutManager {
  private status: ShortcutStatus = { entries: [], updatedAt: new Date(0).toISOString() };
  private requestedShortcuts: ShortcutSettings | null = null;

  public constructor(
    private readonly globalShortcut: GlobalShortcutAdapter,
    private readonly window: WindowAdapter,
    private readonly handlers: ShortcutActionHandlers = {},
    private readonly onError: (action: ShortcutAction, error: unknown) => void = (action, error) => {
      console.error(`Fluely ${action} shortcut failed.`, error);
    },
  ) {}

  public registerAll(shortcuts: ShortcutSettings): IpcResult<ShortcutStatus> {
    const validationError = validateShortcutSettings(shortcuts);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    const previousShortcuts = cloneShortcuts(this.requestedShortcuts);
    const previousStatus = cloneStatus(this.status);

    try {
      this.globalShortcut.unregisterAll();
      const entries = SHORTCUT_ACTIONS.map((action) => this.registerAction(action, shortcuts[action]));
      this.status = {
        entries,
        updatedAt: new Date().toISOString(),
      };
      this.requestedShortcuts = cloneShortcuts(shortcuts);

      return { ok: true, value: this.getStatus() };
    } catch {
      const restored = this.restorePreviousRegistration(previousShortcuts, previousStatus);
      if (!restored) {
        this.status = {
          entries: previousStatus.entries.map((entry) => ({
            ...entry,
            registered: false,
            available: false,
            message: "Fluely could not restore this shortcut after registration failed.",
            errorCode: "INTERNAL_ERROR",
          })),
          updatedAt: new Date().toISOString(),
        };
      } else {
        this.status = previousStatus;
      }
      this.requestedShortcuts = previousShortcuts;
      return { ok: false, error: registrationFailure() };
    }
  }

  public update(shortcuts: ShortcutSettings): IpcResult<ShortcutStatus> {
    return this.registerAll(shortcuts);
  }

  public getStatus(): ShortcutStatus {
    return cloneStatus(this.status);
  }

  public dispose(): void {
    try {
      this.globalShortcut.unregisterAll();
    } catch {
      // Teardown is best-effort; never leave a stale active status in memory.
    }
    this.requestedShortcuts = null;
    this.status = { entries: [], updatedAt: new Date().toISOString() };
  }

  private restorePreviousRegistration(
    previousShortcuts: ShortcutSettings | null,
    previousStatus: ShortcutStatus,
  ): boolean {
    try {
      this.globalShortcut.unregisterAll();
    } catch {
      return false;
    }

    if (!previousShortcuts) {
      return true;
    }

    try {
      const entries = SHORTCUT_ACTIONS.map((action) => this.registerAction(action, previousShortcuts[action]));
      const matches = entries.length === previousStatus.entries.length && entries.every((entry, index) => {
        const previous = previousStatus.entries[index];
        return entry.action === previous.action &&
          entry.accelerator === previous.accelerator &&
          entry.registered === previous.registered &&
          entry.available === previous.available;
      });
      if (matches) {
        return true;
      }

      try {
        this.globalShortcut.unregisterAll();
      } catch {
        // Best-effort cleanup after a partial restoration.
      }
      return false;
    } catch {
      try {
        this.globalShortcut.unregisterAll();
      } catch {
        // Best-effort cleanup after rollback failure.
      }
      return false;
    }
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
      return () => this.invokeSafely(action, () => {
        if (this.window.toggleVisibility) {
          this.window.toggleVisibility();
          return;
        }
        if (this.window.isVisible()) {
          this.window.hide();
        } else if (!this.window.isCaptureActive?.()) {
          this.window.show();
        }
      });
    }

    const handler = this.handlers[action];
    return handler ? () => this.invokeSafely(action, handler) : () => undefined;
  }

  private invokeSafely(action: ShortcutAction, handler: () => void | Promise<void>): void {
    try {
      const result = handler();
      if (result && typeof result === "object" && "catch" in result && typeof result.catch === "function") {
        void result.catch((error: unknown) => this.onError(action, error));
      }
    } catch (error) {
      this.onError(action, error);
    }
  }
}
