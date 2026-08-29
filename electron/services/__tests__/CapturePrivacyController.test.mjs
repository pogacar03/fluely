import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/CapturePrivacyController.js");
const { CapturePrivacyController } = await import(pathToFileURL(modulePath).href);

function makeWindow({ destroyed = false } = {}) {
  const events = new EventEmitter();
  const calls = {
    contentProtection: [],
    hiddenInMissionControl: [],
  };

  return {
    calls,
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    emit: events.emit.bind(events),
    listenerCount: events.listenerCount.bind(events),
    isDestroyed: () => destroyed,
    setContentProtection: (enabled) => calls.contentProtection.push(enabled),
    setHiddenInMissionControl: (hidden) => calls.hiddenInMissionControl.push(hidden),
  };
}

test("capture protection applies immediately and hides the window from Mission Control on macOS", () => {
  const window = makeWindow();
  const controller = new CapturePrivacyController("darwin");

  controller.apply(window, true);

  assert.deepEqual(window.calls.contentProtection, [true]);
  assert.deepEqual(window.calls.hiddenInMissionControl, [true]);
});

test("capture protection reapplies after the window emits show", () => {
  const window = makeWindow();
  const controller = new CapturePrivacyController("darwin");
  controller.apply(window, true);
  window.calls.contentProtection.length = 0;
  window.calls.hiddenInMissionControl.length = 0;

  window.emit("show");

  assert.deepEqual(window.calls.contentProtection, [true]);
  assert.deepEqual(window.calls.hiddenInMissionControl, [true]);
});

test("capture protection does not call a destroyed window", () => {
  const window = makeWindow({ destroyed: true });
  const controller = new CapturePrivacyController("darwin");

  controller.apply(window, true);
  window.emit("show");
  controller.reassert();

  assert.deepEqual(window.calls.contentProtection, []);
  assert.deepEqual(window.calls.hiddenInMissionControl, []);
});

test("capture protection disposal removes the show listener", () => {
  const window = makeWindow();
  const controller = new CapturePrivacyController("darwin");
  controller.apply(window, true);
  assert.equal(window.listenerCount("show"), 1);

  controller.dispose();
  window.emit("show");

  assert.equal(window.listenerCount("show"), 0);
  assert.deepEqual(window.calls.contentProtection, [true]);
  assert.deepEqual(window.calls.hiddenInMissionControl, [true]);
});

test("capture protection uses content protection on non-macOS platforms", () => {
  const window = makeWindow();
  const controller = new CapturePrivacyController("linux");

  controller.apply(window, true);
  window.emit("show");

  assert.deepEqual(window.calls.contentProtection, [true, true]);
  assert.deepEqual(window.calls.hiddenInMissionControl, []);
});
