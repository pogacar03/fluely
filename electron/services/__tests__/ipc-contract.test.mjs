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
  const subscriptions = new Map();
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push({ channel, args });
      return Promise.resolve({ ok: true, value: null });
    },
    on(channel, listener) {
      subscriptions.set(channel, listener);
    },
    removeListener(channel, listener) {
      if (subscriptions.get(channel) === listener) {
        subscriptions.delete(channel);
      }
    },
  };

  exposeFluelyApi(contextBridge, ipcRenderer);

  assert.deepEqual(Object.keys(exposedApi).sort(), [
    "analysis",
    "app",
    "codex",
    "conversation",
    "screenshots",
    "settings",
    "shortcuts",
    "window",
    "workspace",
  ]);
  assert.deepEqual(Object.keys(exposedApi.analysis).sort(), [
    "getStatus",
    "onStateChanged",
  ]);
  assert.deepEqual(Object.keys(exposedApi.codex).sort(), ["getStatus", "validate"]);
  assert.deepEqual(Object.keys(exposedApi.screenshots).sort(), [
    "capture",
    "clear",
    "delete",
    "get",
    "onStateChanged",
  ]);
  assert.deepEqual(Object.keys(exposedApi.window).sort(), ["hide", "setOpacity"]);
  assert.deepEqual(Object.keys(exposedApi.workspace).sort(), ["execute"]);
  assert.deepEqual(Object.keys(exposedApi.conversation).sort(), ["getSnapshot", "onEvent"]);
  assert.equal(exposedApi.ipcRenderer, undefined);
  assert.equal(exposedApi.invoke, undefined);
  await exposedApi.settings.get();
  await exposedApi.settings.update({ window: { width: 800 } });
  await exposedApi.shortcuts.get();
  await exposedApi.app.getStatus();
  await exposedApi.codex.getStatus();
  await exposedApi.codex.validate("codex");
  await exposedApi.analysis.getStatus();
  await exposedApi.window.setOpacity(0.8);
  await exposedApi.window.hide();
  await exposedApi.screenshots.get();
  await exposedApi.screenshots.capture();
  await exposedApi.screenshots.delete("11111111-1111-4111-8111-111111111111");
  await exposedApi.screenshots.clear();
  await exposedApi.workspace.execute({ type: "capture", requestId: "workspace-1" });
  await exposedApi.conversation.getSnapshot();
  let receivedState;
  const unsubscribe = exposedApi.screenshots.onStateChanged((state) => {
    receivedState = state;
  });
  assert.equal(typeof unsubscribe, "function");
  subscriptions.get("screenshots:state-changed")({}, {
    items: [],
    capturing: true,
    permission: "granted",
  });
  assert.equal(receivedState.capturing, true);
  unsubscribe();
  assert.equal(subscriptions.size, 0);
  let receivedAnalysisEvent;
  const unsubscribeAnalysis = exposedApi.analysis.onStateChanged((event) => {
    receivedAnalysisEvent = event;
  });
  assert.equal(typeof unsubscribeAnalysis, "function");
  subscriptions.get("analysis:state-changed")({ sender: "private" }, {
    event: "delta",
    status: "running",
    text: "answer",
    model: "gpt-custom",
    screenshotIds: [],
    startedAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
  });
  assert.equal(receivedAnalysisEvent.text, "answer");
  unsubscribeAnalysis();
  assert.equal(subscriptions.size, 0);
  let receivedConversationEvent;
  const unsubscribeConversation = exposedApi.conversation.onEvent((event) => {
    receivedConversationEvent = event;
  });
  assert.equal(typeof unsubscribeConversation, "function");
  subscriptions.get("conversation:event")({}, {
    type: "cleared",
    revision: 1,
    activeMessageId: null,
    snapshot: { sessionId: "session", revision: 1, messages: [], attachments: [] },
  });
  assert.equal(receivedConversationEvent.type, "cleared");
  unsubscribeConversation();
  assert.equal(subscriptions.size, 0);
  assert.deepEqual(calls.map((call) => call.channel), [
    "settings:get",
    "settings:update",
    "shortcuts:get",
    "app:get-status",
    "codex:get-status",
    "codex:validate",
    "analysis:get-status",
    "window:set-opacity",
    "window:hide",
    "screenshots:get",
    "screenshots:capture",
    "screenshots:delete",
    "screenshots:clear",
    "workspace:execute",
    "conversation:get-snapshot",
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
  const analysis = {
    start: () => ({ status: "running" }),
    cancel: () => ({ status: "cancelled" }),
    getState: () => ({ status: "idle" }),
    onStateChanged: () => () => undefined,
  };
  const conversation = {
    snapshot: () => ({ sessionId: "session", revision: 0, messages: [], attachments: [] }),
    subscribe: () => () => undefined,
  };
  const workspace = {
    execute: async () => ({
      queue: { items: [] },
      conversation: { sessionId: "session", revision: 0, messages: [], attachments: [] },
    }),
  };
  const codex = {
    getStatus: async () => ({ available: true, configuredPath: "codex" }),
    validate: async () => ({ available: true, configuredPath: "codex" }),
  };
  const window = {
    setOpacity: () => undefined,
    hide: () => undefined,
  };

  registerIpcHandlers({
    ipcMain,
    settings,
    shortcuts,
    screenshots,
    analysis,
    conversation,
    workspace,
    codex,
    window,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  assert.deepEqual([...registrations.keys()].sort(), [
    "analysis:get-status",
    "app:get-status",
    "codex:get-status",
    "codex:validate",
    "conversation:get-snapshot",
    "screenshots:capture",
    "screenshots:clear",
    "screenshots:delete",
    "screenshots:get",
    "settings:get",
    "settings:reset",
    "settings:update",
    "shortcuts:get",
    "shortcuts:update",
    "window:hide",
    "window:set-opacity",
    "workspace:execute",
  ]);
});

test("window hide IPC invokes only the injected narrow hide adapter", async () => {
  const registrations = new Map();
  let hideCalls = 0;
  registerIpcHandlers({
    ipcMain: {
      handle(channel, handler) {
        registrations.set(channel, handler);
      },
    },
    settings: {
      get: () => ({ shortcuts: {}, window: {}, privacy: {} }),
      update: async () => ({ ok: true, value: {} }),
      reset: async () => ({ ok: true, value: {} }),
    },
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
      update: () => ({ ok: true, value: {} }),
    },
    screenshots: {
      getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
      capture: async () => ({ id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-08-30T00:00:00.000Z", width: 1, height: 1 }),
      delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
      clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    },
    window: {
      hide: () => { hideCalls += 1; },
    },
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  const result = await registrations.get("window:hide")();
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(hideCalls, 1);
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
  const appliedCodex = [];
  const appliedShortcuts = [];
  const ipcMain = {
    handle(channel, handler) {
      registrations.set(channel, handler);
    },
  };
  const resetSettings = {
    shortcuts: {},
    window: {},
    privacy: { captureProtection: true },
    codex: {
      enabled: true,
      path: "codex",
      model: "gpt-5.6-sol",
      fastModel: "gpt-5.6-luna",
      timeoutMs: 120000,
      sandboxMode: "read-only",
      modelReasoningEffort: "medium",
    },
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
    applyCodexSettings: (codex) => appliedCodex.push(codex),
    applyShortcuts: (shortcuts) => appliedShortcuts.push(shortcuts),
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  const result = await registrations.get("settings:reset")();

  assert.equal(result.ok, true);
  assert.deepEqual(appliedPrivacy, [true]);
  assert.deepEqual(appliedCodex, [resetSettings.codex]);
  assert.deepEqual(appliedShortcuts, [resetSettings.shortcuts]);
});

test("settings update reapplies persisted shortcuts after a successful save", async () => {
  const registrations = new Map();
  const appliedShortcuts = [];
  const requested = {
    toggleVisibility: "CommandOrControl+K",
    captureScreenshot: "CommandOrControl+Shift+9",
    analyzeQueue: "CommandOrControl+L",
    captureAndAnalyze: "CommandOrControl+Shift+L",
    cancelAndClear: "CommandOrControl+R",
  };

  const settings = {
    get: () => ({ shortcuts: requested, window: { width: 960, height: 720 }, privacy: { captureProtection: true } }),
    update: async () => ({ ok: true, value: {
      shortcuts: requested,
      window: { width: 960, height: 720 },
      privacy: { captureProtection: true },
    } }),
    reset: async () => ({ ok: true, value: {
      shortcuts: requested,
      window: { width: 960, height: 720 },
      privacy: { captureProtection: true },
    } }),
  };

  registerIpcHandlers({
    ipcMain: {
      handle(channel, handler) {
        registrations.set(channel, handler);
      },
    },
    settings,
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
      update: () => ({ ok: true, value: {} }),
    },
    screenshots: {
      getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
      capture: async () => ({
        id: "88888888-8888-4888-8888-888888888888",
        createdAt: "2026-08-30T00:00:00.000Z",
        width: 1920,
        height: 1080,
      }),
      delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
      clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    },
    applyShortcuts: (shortcuts) => appliedShortcuts.push(shortcuts),
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: true }),
  });

  const result = await registrations.get("settings:update")({}, { shortcuts: requested });

  assert.equal(result.ok, true);
  assert.deepEqual(appliedShortcuts, [requested]);
});

test("settings update returns shortcut registration failure instead of saved success", async () => {
  const registrations = new Map();
  const requested = {
    toggleVisibility: "CommandOrControl+K",
    captureScreenshot: "CommandOrControl+Shift+9",
    analyzeQueue: "CommandOrControl+L",
    captureAndAnalyze: "CommandOrControl+Shift+L",
    cancelAndClear: "CommandOrControl+R",
  };
  const failure = {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "OS shortcut registration failed.",
      action: "Restart Fluely and try again.",
    },
  };

  registerIpcHandlers({
    ipcMain: { handle(channel, handler) { registrations.set(channel, handler); } },
    settings: {
      get: () => ({ shortcuts: requested, window: {}, privacy: {} }),
      update: async () => ({ ok: true, value: { shortcuts: requested, window: {}, privacy: {} } }),
      reset: async () => ({ ok: true, value: { shortcuts: requested, window: {}, privacy: {} } }),
    },
    shortcuts: { getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }), update: () => ({ ok: true, value: {} }) },
    screenshots: {
      getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
      capture: async () => ({ id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-08-30T00:00:00.000Z", width: 1, height: 1 }),
      delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
      clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    },
    applyShortcuts: () => failure,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  const result = await registrations.get("settings:update")({}, { shortcuts: requested });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
});

test("settings reset returns shortcut registration failure instead of saved success", async () => {
  const registrations = new Map();
  const failure = {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "OS shortcut registration failed.",
      action: "Restart Fluely and try again.",
    },
  };
  registerIpcHandlers({
    ipcMain: { handle(channel, handler) { registrations.set(channel, handler); } },
    settings: {
      get: () => ({ shortcuts: {}, window: {}, privacy: { captureProtection: true } }),
      update: async () => ({ ok: true, value: {} }),
      reset: async () => ({ ok: true, value: { shortcuts: {}, window: {}, privacy: { captureProtection: true } } }),
    },
    shortcuts: { getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }), update: () => ({ ok: true, value: {} }) },
    screenshots: {
      getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
      capture: async () => ({ id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-08-30T00:00:00.000Z", width: 1, height: 1 }),
      delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
      clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    },
    applyShortcuts: () => failure,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  const result = await registrations.get("settings:reset")();

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
});

test("screenshot mutation handlers notify complete state snapshots on success and failure", async () => {
  const registrations = new Map();
  const notifications = [];
  let state = { items: [], capturing: false, permission: "granted" };
  const item = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    createdAt: "2026-08-30T00:00:00.000Z",
    width: 1920,
    height: 1080,
  };

  registerIpcHandlers({
    ipcMain: {
      handle(channel, handler) {
        registrations.set(channel, handler);
      },
    },
    settings: {
      get: () => ({ shortcuts: {}, window: {}, privacy: {} }),
      update: async () => ({ ok: true, value: {} }),
      reset: async () => ({ ok: true, value: {} }),
    },
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
      update: () => ({ ok: true, value: {} }),
    },
    screenshots: {
      getState: () => state,
      capture: async () => {
        state = { items: [item], capturing: false, permission: "granted" };
        return item;
      },
      delete: async () => {
        state = { items: [], capturing: false, permission: "granted" };
        return state;
      },
      clear: async () => {
        throw { code: "SCREEN_CAPTURE_FAILED", message: "clear failed", action: "retry" };
      },
    },
    notifyScreenshotState: (nextState) => notifications.push(nextState),
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  await registrations.get("screenshots:capture")();
  await registrations.get("screenshots:delete")({}, item.id);
  const clearResult = await registrations.get("screenshots:clear")();

  assert.equal(clearResult.ok, false);
  assert.equal(notifications.length, 3);
  for (const notification of notifications) {
    assert.deepEqual(Object.keys(notification).sort(), ["capturing", "items", "permission"]);
  }
  assert.equal(notifications.at(-1).capturing, false);
});
