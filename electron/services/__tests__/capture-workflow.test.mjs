import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(__dirname, "../../../dist-electron/electron/services/capture-workflow.js");
const shortcutPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ShortcutManager.js");
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const screenshotServicePath = path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js");
const sessionPath = path.resolve(__dirname, "../../../dist-electron/electron/services/screenshot-session.js");
const { createScreenshotWorkflow, attachWindowLifecycle, attachApplicationLifecycle } = await import(pathToFileURL(workflowPath).href);
const { ShortcutManager } = await import(pathToFileURL(shortcutPath).href);
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);
const { ScreenshotService } = await import(pathToFileURL(screenshotServicePath).href);
const { isScreenshotSessionActive, waitForScreenshotSessionIdle } = await import(pathToFileURL(sessionPath).href);

function makeWindow(visible = true) {
  return {
    visible,
    showCalls: 0,
    hideCalls: 0,
    isVisible() {
      return this.visible;
    },
    hide() {
      this.hideCalls += 1;
      this.visible = false;
    },
    show() {
      this.showCalls += 1;
      this.visible = true;
    },
    showInactive() {
      this.showCalls += 1;
      this.visible = true;
    },
    isDestroyed() {
      return false;
    },
  };
}

function makeShortcutAdapter(callbacks) {
  return {
    register(accelerator, callback) {
      callbacks.set(accelerator, callback);
      return true;
    },
    unregisterAll() {
      callbacks.clear();
    },
  };
}

const shortcuts = {
  toggleVisibility: "CommandOrControl+B",
  captureScreenshot: "CommandOrControl+Shift+8",
  analyzeQueue: "CommandOrControl+Enter",
  captureAndAnalyze: "CommandOrControl+Shift+Enter",
  cancelAndClear: "CommandOrControl+R",
};

test("shortcut capture composes session hiding, service capture, and state notifications", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fluely-workflow-"));
  const window = makeWindow(true);
  const states = [];
  let serviceSawHidden = false;
  const item = {
    id: "99999999-9999-4999-8999-999999999999",
    createdAt: "2026-08-30T00:00:00.000Z",
    width: 1920,
    height: 1080,
  };
  const service = new ScreenshotService({
    directory,
    platform: "linux",
    idFactory: () => item.id,
    desktopCapturer: {
      async getSources() {
        serviceSawHidden = !window.visible;
        return [{
          display_id: "42",
          thumbnail: {
            toPNG: () => Buffer.from("workflow-png"),
            getSize: () => ({ width: item.width, height: item.height }),
          },
        }];
      },
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 20, y: 20 }),
      getDisplayNearestPoint: () => ({ id: 42, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
    },
    onStateChanged: (nextState) => states.push(nextState),
  });
  const workflow = createScreenshotWorkflow({
    window,
    platform: "linux",
    capture: () => service.capture(),
    delete: (id) => service.delete(id),
    clear: () => service.clear(),
  });
  const callbacks = new Map();
  let captureResolve;
  let captureReject;
  const captureFinished = new Promise((resolve, reject) => {
    captureResolve = resolve;
    captureReject = reject;
  });
  const manager = new ShortcutManager(makeShortcutAdapter(callbacks), {
    isVisible: () => window.isVisible(),
    show: () => window.show(),
    hide: () => window.hide(),
    toggleVisibility: workflow.toggleVisibility,
  }, {
    captureScreenshot: () => workflow.capture().then(captureResolve, captureReject),
  });
  manager.registerAll(shortcuts);

  callbacks.get(shortcuts.captureScreenshot)();
  await captureFinished;

  assert.equal(serviceSawHidden, true);
  assert.equal(window.visible, true);
  assert.deepEqual(states.map((entry) => entry.capturing), [true, false]);
  assert.equal(states.at(-1).items[0].id, item.id);
  service.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("failed composed capture restores visibility and reports its final state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fluely-workflow-failure-"));
  const window = makeWindow(true);
  const states = [];
  const service = new ScreenshotService({
    directory,
    platform: "linux",
    desktopCapturer: {
      async getSources() {
        throw new Error("capture failed");
      },
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 20, y: 20 }),
      getDisplayNearestPoint: () => ({ id: 42, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
    },
    onStateChanged: (nextState) => states.push(nextState),
  });
  const workflow = createScreenshotWorkflow({
    window,
    platform: "darwin",
    capture: () => service.capture(),
    delete: (id) => service.delete(id),
    clear: () => service.clear(),
  });

  await assert.rejects(workflow.capture(), (error) => error?.code === "SCREEN_CAPTURE_FAILED");
  assert.equal(window.visible, true);
  assert.equal(states.at(-1).capturing, false);
  assert.deepEqual(states.map((entry) => entry.capturing), [true, false]);
  service.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("settings reset composition reapplies privacy and the default OS shortcuts", async () => {
  const registrations = new Map();
  const appliedPrivacy = [];
  const appliedShortcuts = [];
  const resetSettings = {
    shortcuts,
    window: { width: 960, height: 720 },
    privacy: { captureProtection: true },
  };

  registerIpcHandlers({
    ipcMain: {
      handle(channel, handler) {
        registrations.set(channel, handler);
      },
    },
    settings: {
      get: () => resetSettings,
      update: async () => ({ ok: true, value: resetSettings }),
      reset: async () => ({ ok: true, value: resetSettings }),
    },
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
      update: (value) => {
        appliedShortcuts.push(value);
        return { ok: true, value: {} };
      },
    },
    screenshots: {
      getState: () => ({ items: [], capturing: false, permission: "unavailable" }),
      capture: async () => ({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        createdAt: "2026-08-30T00:00:00.000Z",
        width: 1920,
        height: 1080,
      }),
      delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
      clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    },
    applyPrivacy: (enabled) => appliedPrivacy.push(enabled),
    applyShortcuts: (value) => appliedShortcuts.push(value),
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  const result = await registrations.get("settings:reset")();

  assert.equal(result.ok, true);
  assert.deepEqual(appliedPrivacy, [true]);
  assert.deepEqual(appliedShortcuts, [shortcuts]);
});

test("window lifecycle does not show a window when a screenshot session is active and disposes on close", () => {
  function makeLifecycleWindow() {
    const listeners = new Map();
    return {
      listeners,
      showCalls: 0,
      destroyed: false,
      once(event, listener) {
        listeners.set(event, () => {
          listeners.delete(event);
          listener();
        });
      },
      on(event, listener) {
        listeners.set(event, listener);
      },
      emit(event) {
        listeners.get(event)?.();
      },
      show() {
        this.showCalls += 1;
      },
      isDestroyed() {
        return this.destroyed;
      },
    };
  }

  const activeWindow = makeLifecycleWindow();
  const readyWindow = makeLifecycleWindow();
  let active = true;
  let closed = 0;
  attachWindowLifecycle({
    window: activeWindow,
    isCaptureActive: () => active,
    onReadyToShow: () => activeWindow.show(),
    onClosed: () => { closed += 1; },
  });

  activeWindow.emit("ready-to-show");
  assert.equal(activeWindow.showCalls, 0);
  active = false;
  attachWindowLifecycle({
    window: readyWindow,
    isCaptureActive: () => active,
    onReadyToShow: () => readyWindow.show(),
    onClosed: () => { closed += 1; },
  });
  readyWindow.emit("ready-to-show");
  assert.equal(readyWindow.showCalls, 1);
  readyWindow.emit("closed");
  assert.equal(closed, 1);
});

test("window lifecycle retries a ready window after the screenshot session gate releases", async () => {
  const listeners = new Map();
  const window = {
    showCalls: 0,
    once(event, listener) {
      listeners.set(event, listener);
    },
    on() {},
    show() {
      this.showCalls += 1;
    },
    isDestroyed() {
      return false;
    },
  };
  let active = true;
  let releaseIdle;
  const idle = new Promise((resolve) => { releaseIdle = resolve; });

  attachWindowLifecycle({
    window,
    isCaptureActive: () => active,
    waitForCaptureIdle: () => idle,
    onReadyToShow: () => window.show(),
    onClosed: () => undefined,
  });

  listeners.get("ready-to-show")();
  assert.equal(window.showCalls, 0);
  active = false;
  releaseIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.showCalls, 1);
});

test("application lifecycle reasserts privacy on activate and recreates a closed window", () => {
  let activateListener;
  const app = {
    on(event, listener) {
      assert.equal(event, "activate");
      activateListener = listener;
    },
  };
  let reassertions = 0;
  let created = 0;
  attachApplicationLifecycle({
    app,
    hasWindows: () => false,
    reassertPrivacy: () => { reassertions += 1; },
    createWindow: () => { created += 1; },
  });

  activateListener();

  assert.equal(reassertions, 1);
  assert.equal(created, 1);
});

test("composition holds the hidden window and session gate through a timed-out native capture", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fluely-workflow-timeout-"));
  const window = makeWindow(true);
  const listeners = new Map();
  window.once = (event, listener) => listeners.set(event, listener);
  window.on = (event, listener) => listeners.set(event, listener);
  const sourcePromise = new Promise((resolve) => { window.releaseSources = resolve; });
  const service = new ScreenshotService({
    directory,
    platform: "darwin",
    sourceTimeoutMs: 5,
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    desktopCapturer: { getSources: () => sourcePromise },
    screen: {
      getCursorScreenPoint: () => ({ x: 20, y: 20 }),
      getDisplayNearestPoint: () => ({ id: 42, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
    },
  });
  const workflow = createScreenshotWorkflow({
    window,
    platform: "darwin",
    capture: () => service.capture(),
    whenIdle: () => service.whenIdle(),
    delete: (id) => service.delete(id),
    clear: () => service.clear(),
  });
  attachWindowLifecycle({
    window,
    isCaptureActive: isScreenshotSessionActive,
    waitForCaptureIdle: waitForScreenshotSessionIdle,
    onReadyToShow: () => window.show(),
    onClosed: () => service.dispose(),
  });

  const capturePromise = workflow.capture();
  await new Promise((resolve) => setImmediate(resolve));
  listeners.get("ready-to-show")();
  workflow.toggleVisibility();
  await assert.rejects(capturePromise, (error) => error?.code === "SCREEN_CAPTURE_FAILED");
  assert.equal(window.visible, false);
  assert.equal(window.showCalls, 0);
  assert.equal(isScreenshotSessionActive(), true);

  window.releaseSources([]);
  await service.whenIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.visible, true);
  assert.equal(window.showCalls, 2);
  service.dispose();
  await rm(directory, { recursive: true, force: true });
});
