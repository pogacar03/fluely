import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { join } from "node:path";
import type { AppStatus } from "../src/shared/ipc";
import { registerIpcHandlers } from "./services/ipcHandlers";
import { SettingsService } from "./services/SettingsService";
import { ShortcutManager } from "./services/ShortcutManager";
import { getWindowPreferences } from "./windowConfig";

let mainWindow: BrowserWindow | null = null;
let settingsService: SettingsService | null = null;
let shortcutManager: ShortcutManager | null = null;
let ipcHandlersRegistered = false;

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: "#0a0b12",
    title: "Fluely",
    webPreferences: getWindowPreferences(join(__dirname, "preload.js")),
  });

  window.loadFile(join(__dirname, "../../dist/index.html"));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
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

async function initializeServices(window: BrowserWindow): Promise<void> {
  if (!settingsService) {
    settingsService = new SettingsService(app.getPath("userData"));
    const loadResult = await settingsService.load();
    if (loadResult.warning) {
      console.warn(loadResult.warning.message);
    }
  }

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
  );
  shortcutManager.registerAll(settingsService.get().shortcuts);

  if (!ipcHandlersRegistered) {
    registerIpcHandlers({
      ipcMain,
      settings: settingsService,
      shortcuts: shortcutManager,
      getAppStatus,
    });
    ipcHandlersRegistered = true;
  }
}

app.setName("Fluely");

app.whenReady().then(async () => {
  const window = createMainWindow();
  await initializeServices(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWindow = createMainWindow();
      void initializeServices(nextWindow);
    }
  });
});

app.on("will-quit", () => {
  shortcutManager?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
