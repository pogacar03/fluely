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
import type {
  AnalysisStateChangedEvent,
  AppStatus,
  CodexStatus,
  FluelySettings,
  IpcError,
  ScreenshotItem,
  ScreenshotState,
} from "../src/shared/ipc";
import { DEFAULT_SETTINGS } from "./services/settings-core";
import { AnalysisService } from "./services/AnalysisService";
import { CapturePrivacyController, DockPrivacyCoordinator } from "./services/CapturePrivacyController";
import {
  CodexCliService,
  createMainProcessCodexCliService,
} from "./services/CodexCliService";
import { registerIpcHandlers } from "./services/ipcHandlers";
import { SettingsService } from "./services/SettingsService";
import { ScreenshotService } from "./services/ScreenshotService";
import { ShortcutManager } from "./services/ShortcutManager";
import { createScreenshotWorkflow } from "./services/capture-workflow";
import { isScreenshotSessionActive, waitForScreenshotSessionIdle } from "./services/screenshot-session";
import { attachApplicationLifecycle, attachWindowLifecycle } from "./services/window-lifecycle";
import { getWindowPreferences } from "./windowConfig";

let mainWindow: BrowserWindow | null = null;
let settingsService: SettingsService | null = null;
let shortcutManager: ShortcutManager | null = null;
let capturePrivacyController: CapturePrivacyController | null = null;
let screenshotService: ScreenshotService | null = null;
let codexCliService: CodexCliService | null = null;
let analysisService: AnalysisService | null = null;
let dockPrivacyCoordinator: DockPrivacyCoordinator | null = null;
let ipcHandlersRegistered = false;

const MIN_WINDOW_OPACITY = 0.35;
const MAX_WINDOW_OPACITY = 1;

function clampWindowOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.window.opacity;
  }
  return Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, value));
}

function getDockPrivacyCoordinator(): DockPrivacyCoordinator | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  if (!dockPrivacyCoordinator) {
    dockPrivacyCoordinator = new DockPrivacyCoordinator({
      hide: () => app.dock?.hide(),
      show: () => app.dock?.show(),
    });
  }

  return dockPrivacyCoordinator;
}

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
  window.setOpacity(clampWindowOpacity(settings.window.opacity));

  capturePrivacyController?.dispose();
  capturePrivacyController = new CapturePrivacyController(
    process.platform,
    getDockPrivacyCoordinator(),
  );
  capturePrivacyController.apply(window, settings.privacy.captureProtection);

  window.loadFile(join(__dirname, "../../dist/index.html"));
  attachWindowLifecycle({
    window,
    isCaptureActive: isScreenshotSessionActive,
    waitForCaptureIdle: waitForScreenshotSessionIdle,
    onReadyToShow: () => window.show(),
    onClosed: () => {
      if (mainWindow === window) {
        analysisService?.cancel();
        mainWindow = null;
        capturePrivacyController?.dispose();
        capturePrivacyController = null;
      }
    },
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

function notifyScreenshotState(state?: ScreenshotState): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    window.webContents.send("screenshots:state-changed", state ?? getScreenshotService().getState());
  } catch {
    // The renderer may be tearing down while a background mutation completes.
  }
}

function notifyAnalysisState(event: AnalysisStateChangedEvent): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    window.webContents.send("analysis:state-changed", event);
  } catch {
    // The renderer may be tearing down while a background request completes.
  }
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
      onStateChanged: (state) => notifyScreenshotState(state),
    });
  }
  return screenshotService;
}

function getCodexCliService(): CodexCliService {
  if (!codexCliService) {
    codexCliService = createMainProcessCodexCliService();
  }
  return codexCliService;
}

function getAnalysisService(settings: SettingsService): AnalysisService {
  if (!analysisService) {
    analysisService = new AnalysisService({
      provider: getCodexCliService(),
      getManagedPaths: (ids) => getScreenshotService().getManagedPaths(ids),
      codex: settings.get().codex,
    });
  }
  return analysisService;
}

async function getCodexStatus(settings: SettingsService): Promise<CodexStatus> {
  const configuredPath = settings.get().codex.path;
  const validation = await getCodexCliService().validateExecutable(
    configuredPath,
    settings.get().codex.timeoutMs,
  );
  const status: CodexStatus = {
    available: validation.success,
    configuredPath,
  };
  if (validation.resolvedPath) {
    status.resolvedPath = validation.resolvedPath;
  }
  if (validation.error) {
    status.error = {
      code: "INTERNAL_ERROR",
      message: validation.error.message,
      action: validation.error.action,
    };
  }
  return status;
}

async function validateCodexPath(path: string, settings: SettingsService): Promise<CodexStatus> {
  const validation = await getCodexCliService().validateExecutable(
    path,
    settings.get().codex.timeoutMs,
  );
  const status: CodexStatus = {
    available: validation.success,
    configuredPath: path,
  };
  if (validation.resolvedPath) {
    status.resolvedPath = validation.resolvedPath;
  }
  if (validation.error) {
    status.error = {
      code: "INTERNAL_ERROR",
      message: validation.error.message,
      action: validation.error.action,
    };
  }
  return status;
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

  return createScreenshotWorkflow({
    window,
    platform: process.platform,
    capture: () => getScreenshotService().capture(),
    whenIdle: () => getScreenshotService().whenIdle(),
    delete: (id) => getScreenshotService().delete(id),
    clear: () => getScreenshotService().clear(),
  }).capture().catch((error) => {
    notifyScreenshotState();
    throw error;
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
  const analysis = getAnalysisService(loadedSettings);

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
      isCaptureActive: () => isScreenshotSessionActive(),
      toggleVisibility: () => createScreenshotWorkflow({
        window,
        platform: process.platform,
        capture: () => getScreenshotService().capture(),
        delete: (id) => getScreenshotService().delete(id),
        clear: () => getScreenshotService().clear(),
      }).toggleVisibility(),
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
        delete: (id) => getScreenshotService().delete(id).catch((error) => {
          notifyScreenshotState();
          throw error;
        }),
        clear: () => getScreenshotService().clear().catch((error) => {
          notifyScreenshotState();
          throw error;
        }),
      },
      analysis,
      codex: {
        getStatus: () => getCodexStatus(loadedSettings),
        validate: (path) => validateCodexPath(path, loadedSettings),
      },
      applyCodexSettings: (codexSettings) => analysis.updateCodexSettings(codexSettings),
      window: {
        setOpacity: (opacity) => {
          const currentWindow = mainWindow;
          if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.setOpacity(opacity);
          }
        },
        hide: () => {
          const currentWindow = mainWindow;
          if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.hide();
          }
        },
      },
      applyPrivacy: (enabled) => {
        if (mainWindow && capturePrivacyController) {
          capturePrivacyController.apply(mainWindow, enabled);
        }
      },
      applyOpacity: (opacity) => {
        const currentWindow = mainWindow;
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.setOpacity(opacity);
        }
      },
      applyShortcuts: (shortcuts) => shortcutManager?.update(shortcuts) ?? {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Fluely shortcut services are not ready.",
          action: "Restart Fluely and try again.",
        },
      },
      notifyScreenshotState,
      notifyAnalysisState,
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

  attachApplicationLifecycle({
    app,
    hasWindows: () => BrowserWindow.getAllWindows().length > 0,
    reassertPrivacy: () => capturePrivacyController?.reassert(),
    createWindow: () => {
      const nextWindow = createMainWindow(loadedSettings.get());
      void initializeServices(nextWindow).catch((error) => {
        console.error("Fluely could not restore its main window services.", error);
      });
    },
  });
}).catch((error) => {
  console.error("Fluely could not initialize its main process.", error);
  app.quit();
});

app.on("will-quit", () => {
  capturePrivacyController?.dispose();
  shortcutManager?.dispose();
  analysisService?.cancel();
  screenshotService?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
