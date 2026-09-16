import type {
  FluelyApi,
  FluelySettings,
  IpcError,
  IpcResult,
  SettingsPatch,
  ShortcutStatus,
} from "./ipc";

export type SettingsAction = "save" | "reset";

export interface SettingsActionCallbacks {
  isActive: () => boolean;
  setBusy: (busy: boolean) => void;
  setSettings: (settings: FluelySettings) => void;
  setDraft: (settings: FluelySettings) => void;
  setShortcutStatus: (status: ShortcutStatus) => void;
  setNotice: (notice: { tone: "success" | "error"; text: string }) => void;
}

export interface SettingsActionOptions {
  action: SettingsAction;
  api: Pick<FluelyApi, "settings" | "shortcuts">;
  patch?: SettingsPatch;
  callbacks: SettingsActionCallbacks;
}

function describeError(error: IpcError): string {
  return `${error.message} ${error.action}`;
}

function transportError(action: SettingsAction): IpcError {
  return {
    code: "INTERNAL_ERROR",
    message: action === "save"
      ? "Fluely could not save these settings."
      : "Fluely could not restore the default settings.",
    action: "Restart Fluely and try again.",
  };
}

function showError(
  callbacks: SettingsActionCallbacks,
  error: IpcError,
): void {
  if (callbacks.isActive()) {
    callbacks.setNotice({ tone: "error", text: describeError(error) });
  }
}

export async function runSettingsAction({
  action,
  api,
  patch,
  callbacks,
}: SettingsActionOptions): Promise<void> {
  if (!callbacks.isActive()) {
    return;
  }

  callbacks.setBusy(true);
  try {
    const result: IpcResult<FluelySettings> = action === "save"
      ? await api.settings.update(patch ?? {})
      : await api.settings.reset();

    if (!callbacks.isActive()) {
      return;
    }

    if (!result.ok) {
      showError(callbacks, result.error);
      return;
    }

    callbacks.setSettings(result.value);
    callbacks.setDraft(result.value);

    let shortcutResult: IpcResult<ShortcutStatus>;
    try {
      shortcutResult = await api.shortcuts.get();
    } catch {
      showError(callbacks, transportError(action));
      return;
    }

    if (!callbacks.isActive()) {
      return;
    }

    if (!shortcutResult.ok) {
      showError(callbacks, shortcutResult.error);
      return;
    }

    callbacks.setShortcutStatus(shortcutResult.value);
    callbacks.setNotice({
      tone: "success",
      text: action === "save" ? "Settings saved locally." : "Defaults restored.",
    });
  } catch {
    showError(callbacks, transportError(action));
  } finally {
    if (callbacks.isActive()) {
      callbacks.setBusy(false);
    }
  }
}
