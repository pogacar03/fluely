import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/ShortcutManager.js");
const corePath = path.resolve(__dirname, "../../../dist-electron/electron/services/settings-core.js");
const { ShortcutManager } = await import(pathToFileURL(modulePath).href);
const { DEFAULT_SETTINGS } = await import(pathToFileURL(corePath).href);

function makeManager({ failAccelerator, visible = false } = {}) {
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
  };
  const actions = { analyze: 0 };
  const adapter = {
    register(accelerator, callback) {
      registerCalls.push(accelerator);
      if (accelerator === failAccelerator) {
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
    captureScreenshot: () => undefined,
    analyzeQueue: () => { actions.analyze += 1; },
    captureAndAnalyze: () => undefined,
    cancelAndClear: () => undefined,
  });

  return { manager, callbacks, registerCalls, unregisterCalls, window, actions };
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
  assert.equal(result.value.entries.filter((entry) => entry.action !== "toggleVisibility").every((entry) => !entry.available), true);
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

test("dispose unregisters every active shortcut", () => {
  const { manager, unregisterCalls } = makeManager();
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);

  manager.dispose();

  assert.deepEqual(unregisterCalls, Object.values(DEFAULT_SETTINGS.shortcuts));
});
