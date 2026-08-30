import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/CapturePrivacyController.js");
const { CapturePrivacyController, DockPrivacyCoordinator } = await import(pathToFileURL(modulePath).href);

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

test("capture privacy hides the macOS Dock while enabled and restores it when disabled", () => {
  const window = makeWindow();
  const dockCalls = [];
  const controller = new CapturePrivacyController("darwin", {
    hide: () => dockCalls.push("hide"),
    show: () => dockCalls.push("show"),
  });

  controller.apply(window, true);
  assert.deepEqual(dockCalls, ["hide"]);

  controller.reassert();
  assert.deepEqual(dockCalls, ["hide", "hide"]);

  controller.apply(window, false);
  assert.deepEqual(dockCalls, ["hide", "hide", "show"]);
});

test("Dock policy is applied before content protection is reasserted", () => {
  const order = [];
  const window = makeWindow();
  window.setContentProtection = () => order.push("content");
  window.setHiddenInMissionControl = () => order.push("mission-control");
  const controller = new CapturePrivacyController("darwin", {
    hide: () => order.push("dock-hide"),
    show: () => order.push("dock-show"),
  });

  controller.apply(window, true);
  assert.deepEqual(order, ["dock-hide", "content", "mission-control"]);

  order.length = 0;
  controller.reassert();
  assert.deepEqual(order, ["dock-hide", "content", "mission-control"]);
});

test("Dock visibility actions are serialized so a stale show cannot win a newer hide intent", async () => {
  const window = makeWindow();
  const calls = [];
  let releaseHide;
  const dock = {
    hide: () => {
      calls.push("hide");
      return new Promise((resolve) => { releaseHide = resolve; });
    },
    show: () => {
      calls.push("show");
      return Promise.resolve();
    },
  };
  const first = new CapturePrivacyController("darwin", dock);
  first.apply(window, true);
  first.apply(window, false);
  const second = new CapturePrivacyController("darwin", dock);
  second.apply(window, true);

  assert.deepEqual(calls, ["hide"]);
  releaseHide();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["hide", "show", "hide"]);
});

test("Dock disposal does not show when a controller never owned a hide request", async () => {
  const window = makeWindow();
  const calls = [];
  const controller = new CapturePrivacyController("darwin", {
    hide: () => calls.push("hide"),
    show: () => calls.push("show"),
  });

  controller.apply(window, false);
  controller.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["show"]);
});

test("replacing a privacy window with a destroyed target releases owned Dock hiding", () => {
  const liveWindow = makeWindow();
  const destroyedWindow = makeWindow({ destroyed: true });
  const calls = [];
  const controller = new CapturePrivacyController("darwin", {
    hide: () => calls.push("hide"),
    show: () => calls.push("show"),
  });

  controller.apply(liveWindow, true);
  controller.apply(destroyedWindow, true);

  assert.deepEqual(calls, ["hide", "show"]);
});

test("shared Dock coordinator serializes every intent and leaves the latest intent last", async () => {
  const calls = [];
  const deferred = [];
  const coordinator = new DockPrivacyCoordinator({
    hide: () => {
      calls.push("hide");
      if (calls.filter((call) => call === "hide").length > 1) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
    },
    show: () => {
      calls.push("show");
      return Promise.resolve();
    },
  });

  const first = coordinator.setHidden(true);
  const second = coordinator.setHidden(false);
  const third = coordinator.setHidden(true);
  assert.deepEqual(calls, ["hide"]);
  deferred.shift().resolve();
  await Promise.all([first, second, third]);

  assert.deepEqual(calls, ["hide", "show", "hide"]);
});

test("shared Dock coordinator continues with the latest intent after an async rejection", async () => {
  const calls = [];
  let rejectHide;
  const coordinator = new DockPrivacyCoordinator({
    hide: () => {
      calls.push("hide");
      return new Promise((resolve, reject) => { rejectHide = reject; });
    },
    show: () => {
      calls.push("show");
      return Promise.resolve();
    },
  });

  const first = coordinator.setHidden(true);
  const second = coordinator.setHidden(false);
  rejectHide(new Error("Dock unavailable"));
  await assert.rejects(first, /Dock unavailable/);
  await second;

  assert.deepEqual(calls, ["hide", "show"]);
});

test("Dock coordinator keeps a queued intent ahead of a later intent after async settle", async () => {
  const calls = [];
  const settled = [];
  let releaseFirstHide;
  const coordinator = new DockPrivacyCoordinator({
    hide: () => {
      calls.push("hide");
      if (calls.filter((call) => call === "hide").length === 1) {
        return new Promise((resolve) => { releaseFirstHide = resolve; });
      }
      return Promise.resolve();
    },
    show: () => {
      calls.push("show");
      return Promise.resolve();
    },
  });

  const first = coordinator.setHidden(true, () => settled.push("first"));
  const second = coordinator.setHidden(false, () => settled.push("second"));
  releaseFirstHide();
  await Promise.resolve();
  await Promise.resolve();
  const third = coordinator.setHidden(true, () => settled.push("third"));

  await Promise.all([first, second, third]);

  assert.deepEqual(calls, ["hide", "show", "hide"]);
  assert.deepEqual(settled, ["third"]);
});

test("shared Dock ownership keeps the Dock hidden until every hiding controller disposes", () => {
  const calls = [];
  const dock = {
    hide: () => calls.push("hide"),
    show: () => calls.push("show"),
  };
  const first = new CapturePrivacyController("darwin", dock);
  const second = new CapturePrivacyController("darwin", dock);

  first.apply(makeWindow(), true);
  second.apply(makeWindow(), true);
  first.dispose();

  assert.deepEqual(calls, ["hide", "hide", "hide"]);

  second.dispose();

  assert.deepEqual(calls, ["hide", "hide", "hide", "show"]);
});
