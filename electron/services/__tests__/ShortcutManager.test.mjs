import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/ShortcutManager.js");
const corePath = path.resolve(__dirname, "../../../dist-electron/electron/services/settings-core.js");
const { ShortcutManager } = await import(pathToFileURL(modulePath).href);
const { DEFAULT_SETTINGS } = await import(pathToFileURL(corePath).href);

function makeManager({ failAccelerator, throwAccelerator, throwAlways = false, visible = false, captureActive = false } = {}) {
  const callbacks = new Map();
  const registerCalls = [];
  const unregisterCalls = [];
  const window = {
    visible,
    isVisible() {
      return this.visible;
    },
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    isCaptureActive() {
      return captureActive;
    },
  };
  const actions = { analyze: 0, capture: 0, cancel: 0 };
  const adapter = {
    failAccelerator,
    throwAccelerator,
    throwAlways,
    register(accelerator, callback) {
      registerCalls.push(accelerator);
      if (adapter.throwAlways || accelerator === adapter.throwAccelerator) {
        throw new Error(`register failed for ${accelerator}`);
      }
      if (accelerator === adapter.failAccelerator) {
        return false;
      }
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      unregisterCalls.push(accelerator);
      callbacks.delete(accelerator);
    },
    unregisterAll() {
      callbacks.forEach((_, accelerator) => unregisterCalls.push(accelerator));
      callbacks.clear();
    },
  };
  const manager = new ShortcutManager(adapter, window, {
    captureScreenshot: () => { actions.capture += 1; },
    analyzeQueue: () => { actions.analyze += 1; },
    captureAndAnalyze: () => undefined,
    cancelAndClear: () => { actions.cancel += 1; },
  });

  return { manager, callbacks, registerCalls, unregisterCalls, window, actions, adapter };
}

test("duplicate accelerators are rejected before registration", () => {
  const { manager, registerCalls } = makeManager();
  const result = manager.registerAll({
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+B",
    analyzeQueue: "CommandOrControl+Enter",
    captureAndAnalyze: "CommandOrControl+Shift+Enter",
    cancelAndClear: "CommandOrControl+R",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(registerCalls, []);
});

test("successful registration exposes each configured shortcut", () => {
  const { manager, registerCalls } = makeManager();

  const result = manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  assert.equal(result.ok, true);
  assert.equal(result.value.entries.length, 5);
  assert.deepEqual(registerCalls, Object.values(DEFAULT_SETTINGS.shortcuts));
  assert.equal(result.value.entries.find((entry) => entry.action === "toggleVisibility").available, true);
  assert.equal(result.value.entries.find((entry) => entry.action === "captureScreenshot").available, true);
  assert.equal(result.value.entries.find((entry) => entry.action === "cancelAndClear").available, true);
  assert.equal(result.value.entries.find((entry) => entry.action === "analyzeQueue").available, false);
  assert.equal(result.value.entries.find((entry) => entry.action === "captureAndAnalyze").available, false);
});

test("OS conflicts are reported without changing the requested accelerator", () => {
  const { manager } = makeManager({ failAccelerator: "CommandOrControl+Enter" });

  const result = manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  assert.equal(result.ok, true);
  const entry = result.value.entries.find((item) => item.action === "analyzeQueue");
  assert.equal(entry.accelerator, "CommandOrControl+Enter");
  assert.equal(entry.registered, false);
  assert.equal(entry.available, false);
  assert.match(entry.message, /another application/i);
});

test("re-registration unregisters the previous accelerators", () => {
  const { manager, unregisterCalls } = makeManager();
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  const next = { ...DEFAULT_SETTINGS.shortcuts, toggleVisibility: "CommandOrControl+K" };
  const result = manager.update(next);

  assert.equal(result.ok, true);
  assert.deepEqual(unregisterCalls, Object.values(DEFAULT_SETTINGS.shortcuts));
  assert.equal(result.value.entries.find((entry) => entry.action === "toggleVisibility").accelerator, "CommandOrControl+K");
});

test("toggle shortcut changes visibility without invoking analysis", () => {
  const { manager, callbacks, window, actions } = makeManager({ visible: false });
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  callbacks.get(DEFAULT_SETTINGS.shortcuts.toggleVisibility)();

  assert.equal(window.visible, true);
  assert.equal(actions.analyze, 0);
});

test("toggle shortcut does not show a hidden window during an active capture", () => {
  const { manager, callbacks, window } = makeManager({ visible: false, captureActive: true });
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  callbacks.get(DEFAULT_SETTINGS.shortcuts.toggleVisibility)();

  assert.equal(window.visible, false);
});

test("capture and cancel shortcuts invoke supplied handlers while provider shortcuts remain unavailable", () => {
  const { manager, callbacks, actions } = makeManager();
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  callbacks.get(DEFAULT_SETTINGS.shortcuts.captureScreenshot)();
  callbacks.get(DEFAULT_SETTINGS.shortcuts.cancelAndClear)();
  callbacks.get(DEFAULT_SETTINGS.shortcuts.analyzeQueue)();

  assert.equal(actions.capture, 1);
  assert.equal(actions.cancel, 1);
  assert.equal(actions.analyze, 1);
  assert.equal(manager.getStatus().entries.find((entry) => entry.action === "analyzeQueue").available, false);
  assert.equal(manager.getStatus().entries.find((entry) => entry.action === "captureAndAnalyze").available, false);
});

test("dispose unregisters every active shortcut", () => {
  const { manager, unregisterCalls } = makeManager();
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  manager.dispose();

  assert.deepEqual(unregisterCalls, Object.values(DEFAULT_SETTINGS.shortcuts));
});

test("registration throws return failure and restore the previous shortcut state", () => {
  const { manager, adapter } = makeManager();
  const initial = manager.registerAll(DEFAULT_SETTINGS.shortcuts);
  assert.equal(initial.ok, true);

  const next = { ...DEFAULT_SETTINGS.shortcuts, toggleVisibility: "CommandOrControl+K" };
  adapter.throwAccelerator = next.toggleVisibility;
  const result = manager.update(next);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
  assert.equal(manager.getStatus().entries.find((entry) => entry.action === "toggleVisibility").accelerator,
    DEFAULT_SETTINGS.shortcuts.toggleVisibility);
  assert.equal(manager.getStatus().entries.find((entry) => entry.action === "toggleVisibility").registered, true);
});

test("failed shortcut rollback never reports active entries when restoration also throws", () => {
  const { manager, adapter } = makeManager();
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);
  adapter.throwAlways = true;

  const result = manager.update({ ...DEFAULT_SETTINGS.shortcuts, toggleVisibility: "CommandOrControl+K" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
  assert.equal(manager.getStatus().entries.every((entry) => entry.registered === false && entry.available === false), true);
});

test("shortcut rollback clears partial registrations when an old accelerator becomes unavailable", () => {
  const { manager, adapter, callbacks } = makeManager();
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);
  adapter.throwAccelerator = "CommandOrControl+K";
  adapter.failAccelerator = DEFAULT_SETTINGS.shortcuts.captureScreenshot;

  const result = manager.update({ ...DEFAULT_SETTINGS.shortcuts, toggleVisibility: "CommandOrControl+K" });

  assert.equal(result.ok, false);
  assert.equal(manager.getStatus().entries.every((entry) => entry.registered === false && entry.available === false), true);
  assert.equal(callbacks.size, 0);
});
