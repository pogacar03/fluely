import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { getWindowPreferences } from "./windowConfig";

let mainWindow: BrowserWindow | null = null;

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

app.setName("Fluely");

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
