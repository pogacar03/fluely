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

  assert.deepEqual(Object.keys(exposedApi).sort(), ["app", "screenshots", "settings", "shortcuts"]);
  assert.equal(exposedApi.ipcRenderer, undefined);
  assert.equal(exposedApi.invoke, undefined);
  await exposedApi.settings.get();
  await exposedApi.settings.update({ window: { width: 800 } });
  await exposedApi.shortcuts.get();
  await exposedApi.app.getStatus();
  await exposedApi.screenshots.get();
  await exposedApi.screenshots.capture();
  await exposedApi.screenshots.delete("11111111-1111-4111-8111-111111111111");
  await exposedApi.screenshots.clear();
  assert.deepEqual(calls.map((call) => call.channel), [
    "settings:get",
    "settings:update",
    "shortcuts:get",
    "app:get-status",
    "screenshots:get",
    "screenshots:capture",
    "screenshots:delete",
    "screenshots:clear",
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
  const screenshots = {
    getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
    capture: async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-08-30T00:00:00.000Z",
      width: 1920,
      height: 1080,
    }),
    delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
  };

  registerIpcHandlers({
    ipcMain,
    settings,
    shortcuts,
    screenshots,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  assert.deepEqual([...registrations.keys()].sort(), [
    "app:get-status",
    "screenshots:capture",
    "screenshots:clear",
    "screenshots:delete",
    "screenshots:get",
    "settings:get",
    "settings:reset",
    "settings:update",
    "shortcuts:get",
    "shortcuts:update",
  ]);
});

test("main IPC rejects unsafe screenshot IDs before calling the service", async () => {
  const registrations = new Map();
  const ipcMain = {
    handle(channel, handler) {
      registrations.set(channel, handler);
    },
  };
  const deletedIds = [];
  const screenshots = {
    getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
    capture: async () => ({
      id: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-08-30T00:00:00.000Z",
      width: 1920,
      height: 1080,
    }),
    delete: async (id) => {
      deletedIds.push(id);
      throw {
        code: "SCREENSHOT_NOT_FOUND",
        message: "That screenshot is no longer in the queue.",
        action: "Refresh the screenshot queue and try again.",
      };
    },
    clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
  };

  registerIpcHandlers({
    ipcMain,
    settings: {
      get: () => ({ shortcuts: {}, window: {}, privacy: {} }),
      update: async () => ({ ok: true, value: {} }),
      reset: async () => ({ ok: true, value: {} }),
    },
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
      update: () => ({ ok: true, value: {} }),
    },
    screenshots,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  const unsafe = await registrations.get("screenshots:delete")({}, "../settings.json");
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(deletedIds, []);

  const unknown = await registrations.get("screenshots:delete")({}, "33333333-3333-4333-8333-333333333333");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "SCREENSHOT_NOT_FOUND");
  assert.deepEqual(deletedIds, ["33333333-3333-4333-8333-333333333333"]);
});

test("settings reset reapplies the default capture protection state", async () => {
  const registrations = new Map();
  const appliedPrivacy = [];
  const ipcMain = {
    handle(channel, handler) {
      registrations.set(channel, handler);
    },
  };
  const resetSettings = {
    shortcuts: {},
    window: {},
    privacy: { captureProtection: true },
  };

  registerIpcHandlers({
    ipcMain,
    settings: {
      get: () => resetSettings,
      update: async () => ({ ok: true, value: resetSettings }),
      reset: async () => ({ ok: true, value: resetSettings }),
    },
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
      update: () => ({ ok: true, value: {} }),
    },
    screenshots: {
      getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
      capture: async () => ({
        id: "55555555-5555-4555-8555-555555555555",
        createdAt: "2026-08-30T00:00:00.000Z",
        width: 1920,
        height: 1080,
      }),
      delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
      clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    },
    applyPrivacy: (enabled) => appliedPrivacy.push(enabled),
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  const result = await registrations.get("settings:reset")();

  assert.equal(result.ok, true);
  assert.deepEqual(appliedPrivacy, [true]);
});
