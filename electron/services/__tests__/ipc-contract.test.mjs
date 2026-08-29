import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(__dirname, "../../../dist-electron/electron/preloadBridge.js");
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const { exposeFluelyApi } = await import(pathToFileURL(bridgePath).href);
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);

test("preload exposes only the documented Fluely API groups", async () => {
  let exposedApi;
  const contextBridge = {
    exposeInMainWorld(name, api) {
      assert.equal(name, "fluely");
      exposedApi = api;
    },
  };
  const calls = [];
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push({ channel, args });
      return Promise.resolve({ ok: true, value: null });
    },
  };

  exposeFluelyApi(contextBridge, ipcRenderer);

  assert.deepEqual(Object.keys(exposedApi).sort(), ["app", "settings", "shortcuts"]);
  assert.equal(exposedApi.ipcRenderer, undefined);
  assert.equal(exposedApi.invoke, undefined);
  await exposedApi.settings.get();
  await exposedApi.settings.update({ window: { width: 800 } });
  await exposedApi.shortcuts.get();
  await exposedApi.app.getStatus();
  assert.deepEqual(calls.map((call) => call.channel), [
    "settings:get",
    "settings:update",
    "shortcuts:get",
    "app:get-status",
  ]);
});

test("main IPC handlers register only the documented channels", () => {
  const registrations = new Map();
  const ipcMain = {
    handle(channel, handler) {
      registrations.set(channel, handler);
    },
  };
  const settings = {
    get: () => ({ shortcuts: {}, window: {} }),
    update: async () => ({ ok: true, value: {} }),
    reset: async () => ({ ok: true, value: {} }),
  };
  const shortcuts = {
    getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
    update: () => ({ ok: true, value: {} }),
  };

  registerIpcHandlers({
    ipcMain,
    settings,
    shortcuts,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  assert.deepEqual([...registrations.keys()].sort(), [
    "app:get-status",
    "settings:get",
    "settings:reset",
    "settings:update",
    "shortcuts:get",
    "shortcuts:update",
  ]);
});
