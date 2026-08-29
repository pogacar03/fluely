import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  systemPreferences,
} from "electron";
import { join } from "node:path";
import type { AppStatus, FluelySettings, IpcError, ScreenshotItem } from "../src/shared/ipc";
import { DEFAULT_SETTINGS } from "./services/settings-core";
import { CapturePrivacyController } from "./services/CapturePrivacyController";
import { registerIpcHandlers } from "./services/ipcHandlers";
import { SettingsService } from "./services/SettingsService";
import { ScreenshotService } from "./services/ScreenshotService";
import { ShortcutManager } from "./services/ShortcutManager";
import { runScreenshotSession } from "./services/screenshot-session";
import { getWindowPreferences } from "./windowConfig";

let mainWindow: BrowserWindow | null = null;
let settingsService: SettingsService | null = null;
let shortcutManager: ShortcutManager | null = null;
let capturePrivacyController: CapturePrivacyController | null = null;
let screenshotService: ScreenshotService | null = null;
let ipcHandlersRegistered = false;

export function createMainWindow(settings: FluelySettings = DEFAULT_SETTINGS): BrowserWindow {
  const window = new BrowserWindow({
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: "#0a0b12",
    title: "Fluely",
    webPreferences: getWindowPreferences(join(__dirname, "preload.js")),
  });

  capturePrivacyController?.dispose();
  capturePrivacyController = new CapturePrivacyController(process.platform);
  capturePrivacyController.apply(window, settings.privacy.captureProtection);

  window.loadFile(join(__dirname, "../../dist/index.html"));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      capturePrivacyController?.dispose();
      capturePrivacyController = null;
    }
  });

  mainWindow = window;
  return window;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function getAppStatus(): AppStatus {
  return {
    name: "Fluely",
    version: app.getVersion(),
    platform: process.platform,
    visible: mainWindow?.isVisible() ?? false,
  };
}

function getScreenshotService(): ScreenshotService {
  if (!screenshotService) {
    screenshotService = new ScreenshotService({
      directory: join(app.getPath("userData"), "screenshots"),
      platform: process.platform,
      desktopCapturer: {
        getSources: (options) => desktopCapturer.getSources({
          types: [...options.types],
          thumbnailSize: options.thumbnailSize,
        }),
      },
      screen: {
        getCursorScreenPoint: () => screen.getCursorScreenPoint(),
        getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
      },
      systemPreferences: {
        getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
      },
    });
  }
  return screenshotService;
}

function captureFailure(): IpcError {
  return {
    code: "SCREEN_CAPTURE_FAILED",
    message: "Fluely could not capture the selected display.",
    action: "Check that a display is available and try again.",
  };
}

function captureCurrentWindow(): Promise<ScreenshotItem> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return Promise.reject(captureFailure());
  }

  return runScreenshotSession({
    window,
    platform: process.platform,
    capture: () => getScreenshotService().capture(),
  });
}

function logShortcutError(action: string, error: unknown): void {
  console.error(`Fluely ${action} shortcut failed.`, error);
}

async function ensureSettingsService(): Promise<SettingsService> {
  if (!settingsService) {
    settingsService = new SettingsService(app.getPath("userData"));
    const loadResult = await settingsService.load();
    if (loadResult.warning) {
      console.warn(loadResult.warning.message);
    }
  }
  return settingsService;
}

async function initializeServices(window: BrowserWindow): Promise<void> {
  const loadedSettings = await ensureSettingsService();
  getScreenshotService();

  shortcutManager?.dispose();
  shortcutManager = new ShortcutManager(
    {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregisterAll: () => globalShortcut.unregisterAll(),
    },
    {
      isVisible: () => window.isVisible(),
      show: () => window.show(),
      hide: () => window.hide(),
    },
    {
      captureScreenshot: () => {
        void captureCurrentWindow().catch((error) => logShortcutError("captureScreenshot", error));
      },
      cancelAndClear: () => {
        void getScreenshotService().clear().catch((error) => logShortcutError("cancelAndClear", error));
      },
    },
  );
  const shortcutResult = shortcutManager.registerAll(loadedSettings.get().shortcuts);
  if (!shortcutResult.ok) {
    console.warn(shortcutResult.error.message);
  }

  if (!ipcHandlersRegistered) {
    registerIpcHandlers({
      ipcMain,
      settings: loadedSettings,
      shortcuts: {
        getStatus: () => shortcutManager?.getStatus() ?? {
          entries: [],
          updatedAt: new Date(0).toISOString(),
        },
        update: (shortcuts) => shortcutManager?.update(shortcuts) ?? {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Fluely shortcut services are not ready.",
            action: "Restart Fluely and try again.",
          },
        },
      },
      screenshots: {
        getState: () => getScreenshotService().getState(),
        capture: () => captureCurrentWindow(),
        delete: (id) => getScreenshotService().delete(id),
        clear: () => getScreenshotService().clear(),
      },
      applyPrivacy: (enabled) => {
        if (mainWindow && capturePrivacyController) {
          capturePrivacyController.apply(mainWindow, enabled);
        }
      },
      getAppStatus,
    });
    ipcHandlersRegistered = true;
  }
}

app.setName("Fluely");

app.whenReady().then(async () => {
  const loadedSettings = await ensureSettingsService();
  const window = createMainWindow(loadedSettings.get());
  await initializeServices(window);

  app.on("activate", () => {
    capturePrivacyController?.reassert();
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWindow = createMainWindow(loadedSettings.get());
      void initializeServices(nextWindow).catch((error) => {
        console.error("Fluely could not restore its main window services.", error);
      });
    }
  });
}).catch((error) => {
  console.error("Fluely could not initialize its main process.", error);
  app.quit();
});

app.on("will-quit", () => {
  capturePrivacyController?.dispose();
  shortcutManager?.dispose();
  screenshotService?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
