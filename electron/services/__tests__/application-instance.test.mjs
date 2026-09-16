import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/application-instance.js");
const {
  acquireSingleInstance,
  createApplicationWindowFocusController,
  createApplicationInstancePort,
  restoreAndFocusWindow,
} = await import(pathToFileURL(modulePath).href);

function makeWindow(calls, options = {}) {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => options.minimized ?? false,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("application instance port delegates lock acquisition to Electron", () => {
  let lockCalls = 0;
  const port = createApplicationInstancePort({
    requestSingleInstanceLock: () => {
      lockCalls += 1;
      return true;
    },
    on: () => undefined,
    removeListener: () => undefined,
  });

  assert.equal(port.acquire(), true);
  assert.equal(lockCalls, 1);
});

test("lock failure quits before first-instance initialization can run", () => {
  let quitCalls = 0;
  let initializationCalls = 0;
  const port = {
    acquire: () => false,
    onSecondInstance: () => () => undefined,
  };

  const acquired = acquireSingleInstance(port, () => { quitCalls += 1; });
  if (acquired) {
    initializationCalls += 1;
  }

  assert.equal(acquired, false);
  assert.equal(quitCalls, 1);
  assert.equal(initializationCalls, 0);
});

test("second-instance focus restores, shows, and focuses the owned window", () => {
  const calls = [];
  restoreAndFocusWindow(makeWindow(calls, { minimized: true }));

  assert.deepEqual(calls, ["restore", "show", "focus"]);
});

test("duplicate launch before readiness queues one focus until readiness opens", () => {
  const calls = [];
  let ready = false;
  const controller = createApplicationWindowFocusController({
    getWindow: () => makeWindow(calls),
    isReady: () => ready,
    isCaptureActive: () => false,
    waitForCaptureIdle: () => Promise.resolve(),
  });

  controller.requestFocus();
  controller.requestFocus();
  assert.deepEqual(calls, []);

  ready = true;
  assert.equal(controller.notifyGateChanged(), true);
  assert.deepEqual(calls, ["show", "focus"]);
  assert.equal(controller.notifyGateChanged(), false);
});

test("duplicate launch during capture stays hidden and replays once when capture is idle", async () => {
  const calls = [];
  const idle = deferred();
  let captureActive = true;
  let waitCalls = 0;
  const controller = createApplicationWindowFocusController({
    getWindow: () => makeWindow(calls),
    isReady: () => true,
    isCaptureActive: () => captureActive,
    waitForCaptureIdle: () => {
      waitCalls += 1;
      return idle.promise;
    },
  });

  controller.requestFocus();
  controller.requestFocus();
  controller.requestFocus();
  assert.deepEqual(calls, []);
  assert.equal(waitCalls, 1);

  captureActive = false;
  idle.resolve();
  await idle.promise;
  await Promise.resolve();
  assert.deepEqual(calls, ["show", "focus"]);
});

test("window destroyed before readiness clears queued focus instead of replaying to a replacement", () => {
  const calls = [];
  let ready = false;
  let currentWindow = makeWindow(calls);
  const controller = createApplicationWindowFocusController({
    getWindow: () => currentWindow,
    isReady: () => ready,
    isCaptureActive: () => false,
    waitForCaptureIdle: () => Promise.resolve(),
  });

  controller.requestFocus();
  controller.notifyWindowDestroyed();
  currentWindow = makeWindow(calls);
  ready = true;
  assert.equal(controller.notifyGateChanged(), false);
  assert.deepEqual(calls, []);
});

test("focus controller cleanup drops pending work and ignores later duplicate launches", async () => {
  const calls = [];
  const idle = deferred();
  let captureActive = true;
  const controller = createApplicationWindowFocusController({
    getWindow: () => makeWindow(calls),
    isReady: () => true,
    isCaptureActive: () => captureActive,
    waitForCaptureIdle: () => idle.promise,
  });

  controller.requestFocus();
  controller.dispose();
  captureActive = false;
  idle.resolve();
  await idle.promise;
  await Promise.resolve();
  controller.requestFocus();
  assert.deepEqual(calls, []);
});

test("second-instance listener cleanup is idempotent and stops forwarding events", () => {
  let listener;
  let removeCalls = 0;
  const app = {
    requestSingleInstanceLock: () => true,
    on: (event, nextListener) => {
      assert.equal(event, "second-instance");
      listener = nextListener;
    },
    removeListener: (event, nextListener) => {
      assert.equal(event, "second-instance");
      assert.equal(nextListener, listener);
      removeCalls += 1;
      listener = undefined;
    },
  };
  const port = createApplicationInstancePort(app);
  let focusCalls = 0;
  const unsubscribe = port.onSecondInstance(() => { focusCalls += 1; });

  listener();
  unsubscribe();
  unsubscribe();
  listener?.();

  assert.equal(focusCalls, 1);
  assert.equal(removeCalls, 1);
});
