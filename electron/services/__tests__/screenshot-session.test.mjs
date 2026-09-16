import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/screenshot-session.js");
const shortcutModulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/ShortcutManager.js");
const { isScreenshotSessionActive, runScreenshotSession, waitForScreenshotSessionIdle } = await import(pathToFileURL(modulePath).href);
const { ShortcutManager } = await import(pathToFileURL(shortcutModulePath).href);

function makeWindow(visible = true) {
  return {
    visible,
    hideCalls: 0,
    showCalls: 0,
    showInactiveCalls: 0,
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
      this.showInactiveCalls += 1;
      this.visible = true;
    },
    isDestroyed() {
      return false;
    },
  };
}

function makeWait() {
  const waits = [];
  return {
    waits,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  };
}

test("screenshot session hides and restores a visible window on non-macOS", async () => {
  const window = makeWindow(true);
  const wait = makeWait();

  const result = await runScreenshotSession({
    window,
    platform: "linux",
    capture: async () => {
      assert.equal(window.visible, false);
      return "captured";
    },
    wait: wait.wait,
  });

  assert.equal(result, "captured");
  assert.equal(window.visible, true);
  assert.equal(window.hideCalls, 1);
  assert.equal(window.showCalls, 1);
  assert.equal(window.showInactiveCalls, 0);
  assert.deepEqual(wait.waits, [40]);
});

test("screenshot session leaves an already-hidden window hidden", async () => {
  const window = makeWindow(false);
  const wait = makeWait();

  const result = await runScreenshotSession({
    window,
    platform: "darwin",
    capture: async () => {
      assert.equal(window.visible, false);
      return "captured while hidden";
    },
    wait: wait.wait,
  });

  assert.equal(result, "captured while hidden");
  assert.equal(window.visible, false);
  assert.equal(window.hideCalls, 0);
  assert.equal(window.showCalls, 0);
  assert.equal(window.showInactiveCalls, 0);
  assert.deepEqual(wait.waits, [80]);
});

test("screenshot session restores a visible macOS window without activating it", async () => {
  const window = makeWindow(true);
  const wait = makeWait();

  await runScreenshotSession({
    window,
    platform: "darwin",
    capture: async () => "captured",
    wait: wait.wait,
  });

  assert.equal(window.visible, true);
  assert.equal(window.showCalls, 0);
  assert.equal(window.showInactiveCalls, 1);
  assert.deepEqual(wait.waits, [80]);
});

test("screenshot session restores visibility when capture fails", async () => {
  const window = makeWindow(true);
  const wait = makeWait();
  const failure = new Error("capture failed");

  await assert.rejects(
    runScreenshotSession({
      window,
      platform: "darwin",
      capture: async () => { throw failure; },
      wait: wait.wait,
    }),
    failure,
  );

  assert.equal(window.visible, true);
  assert.equal(window.showInactiveCalls, 1);
  assert.deepEqual(wait.waits, [80]);
});

test("screenshot session releases its lock after a failed capture", async () => {
  const firstWindow = makeWindow(true);
  const secondWindow = makeWindow(true);
  const wait = makeWait();

  await assert.rejects(runScreenshotSession({
    window: firstWindow,
    platform: "linux",
    capture: async () => { throw new Error("first failure"); },
    wait: wait.wait,
  }));

  const result = await runScreenshotSession({
    window: secondWindow,
    platform: "linux",
    capture: async () => "second capture",
    wait: wait.wait,
  });

  assert.equal(result, "second capture");
  assert.equal(secondWindow.visible, true);
});

test("screenshot session returns a timeout before idle but holds its visibility gate until native settle", async () => {
  const window = makeWindow(true);
  const wait = makeWait();
  let releaseIdle;
  const idle = new Promise((resolve) => {
    releaseIdle = resolve;
  });
  const timeout = {
    code: "SCREEN_CAPTURE_FAILED",
    message: "capture timed out",
    action: "Restart Fluely and try again.",
  };

  const session = runScreenshotSession({
    window,
    platform: "darwin",
    capture: async () => { throw timeout; },
    whenIdle: () => idle,
    wait: wait.wait,
  });

  await assert.rejects(session, timeout);
  assert.equal(window.visible, false);
  assert.equal(isScreenshotSessionActive(), true);

  releaseIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isScreenshotSessionActive(), false);
  assert.equal(window.visible, true);
  assert.equal(window.showInactiveCalls, 1);
});

test("screenshot session releases once after a rejected idle promise without an unhandled rejection", async () => {
  const window = makeWindow(true);
  let rejectIdle;
  const idle = new Promise((resolve, reject) => {
    rejectIdle = reject;
  });
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.once("unhandledRejection", onUnhandled);

  try {
    const session = runScreenshotSession({
      window,
      platform: "darwin",
      capture: async () => {
        throw new Error("caller timeout");
      },
      whenIdle: () => idle,
      wait: async () => undefined,
    });
    await assert.rejects(session, /caller timeout/);
    assert.equal(isScreenshotSessionActive(), true);
    rejectIdle(new Error("native settle failure"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isScreenshotSessionActive(), false);
    assert.equal(window.showInactiveCalls, 1);
    assert.equal(unhandled, false);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("screenshot session rejects an overlapping capture", async () => {
  const window = makeWindow(true);
  const wait = makeWait();
  let releaseCapture;
  const captureFinished = new Promise((resolve) => {
    releaseCapture = resolve;
  });

  const firstCapture = runScreenshotSession({
    window,
    platform: "linux",
    capture: async () => {
      await captureFinished;
      return "first capture";
    },
    wait: wait.wait,
  });

  await new Promise((resolve) => setImmediate(resolve));
  const secondCapture = runScreenshotSession({
    window,
    platform: "linux",
    capture: async () => "second capture",
    wait: wait.wait,
  });

  await assert.rejects(secondCapture, (error) => error?.code === "CAPTURE_IN_PROGRESS");
  releaseCapture();
  assert.equal(await firstCapture, "first capture");
  assert.equal(window.visible, true);
});

test("screenshot session idle gate resolves only after the active session restores", async () => {
  assert.equal(typeof waitForScreenshotSessionIdle, "function");
  const window = makeWindow(true);
  let releaseCapture;
  const capture = new Promise((resolve) => { releaseCapture = resolve; });
  const session = runScreenshotSession({
    window,
    platform: "linux",
    capture: () => capture,
    wait: async () => undefined,
  });

  await new Promise((resolve) => setImmediate(resolve));
  let idleResolved = false;
  const idle = waitForScreenshotSessionIdle().then(() => { idleResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleResolved, false);

  releaseCapture("captured");
  await session;
  await idle;
  assert.equal(idleResolved, true);
  assert.equal(window.visible, true);
});

test("visibility toggle remains hidden while the screenshot session is waiting or capturing", async () => {
  const window = makeWindow(true);
  const callbacks = new Map();
  const shortcuts = new ShortcutManager(
    {
      register: (accelerator, callback) => {
        callbacks.set(accelerator, callback);
        return true;
      },
      unregisterAll: () => callbacks.clear(),
    },
    {
      isVisible: () => window.isVisible(),
      show: () => window.show(),
      hide: () => window.hide(),
      isCaptureActive: () => isScreenshotSessionActive(),
    },
  );
  shortcuts.registerAll({
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+Shift+8",
    ask: "CommandOrControl+Enter",
    cancelAndClear: "CommandOrControl+R",
  });

  await runScreenshotSession({
    window,
    platform: "linux",
    capture: async () => {
      callbacks.get("CommandOrControl+B")();
      assert.equal(isScreenshotSessionActive(), true);
      assert.equal(window.isVisible(), false);
      return "captured";
    },
    wait: async () => {
      callbacks.get("CommandOrControl+B")();
      assert.equal(isScreenshotSessionActive(), true);
      assert.equal(window.isVisible(), false);
    },
  });

  assert.equal(isScreenshotSessionActive(), false);
  assert.equal(window.isVisible(), true);
});
