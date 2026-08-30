import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/shared/settings-actions.js");
const { runSettingsAction } = await import(pathToFileURL(modulePath).href).catch(() => ({}));

const settings = {
  shortcuts: {
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+Shift+8",
    analyzeQueue: "CommandOrControl+Enter",
    captureAndAnalyze: "CommandOrControl+Shift+Enter",
    cancelAndClear: "CommandOrControl+R",
  },
  window: { width: 960, height: 720 },
  privacy: { captureProtection: true },
};

function makeCallbacks(isActive = () => true) {
  const state = {
    busy: false,
    settings: null,
    draft: null,
    shortcutStatus: null,
    notices: [],
    events: [],
  };
  return {
    state,
    callbacks: {
      isActive,
      setBusy: (value) => {
        state.busy = value;
        state.events.push(["busy", value]);
      },
      setSettings: (value) => { state.settings = value; state.events.push(["settings", value]); },
      setDraft: (value) => { state.draft = value; state.events.push(["draft", value]); },
      setShortcutStatus: (value) => { state.shortcutStatus = value; state.events.push(["shortcuts", value]); },
      setNotice: (value) => { state.notices.push(value); state.events.push(["notice", value]); },
    },
  };
}

test("settings action resets busy and reports an actionable error when update rejects", async () => {
  assert.equal(typeof runSettingsAction, "function");
  const { state, callbacks } = makeCallbacks();
  const api = {
    settings: {
      update: async () => { throw new Error("ipc transport closed"); },
      reset: async () => ({ ok: true, value: settings }),
    },
    shortcuts: { get: async () => ({ ok: true, value: {} }) },
  };

  await runSettingsAction({
    action: "save",
    api,
    patch: { shortcuts: settings.shortcuts, window: settings.window },
    callbacks,
  });

  assert.equal(state.busy, false);
  assert.match(state.notices.at(-1).text, /Restart Fluely/i);
  assert.equal(state.notices.at(-1).tone, "error");
});

test("settings action resets busy and reports an actionable error when shortcut refresh rejects", async () => {
  assert.equal(typeof runSettingsAction, "function");
  const { state, callbacks } = makeCallbacks();
  const api = {
    settings: {
      update: async () => ({ ok: true, value: settings }),
      reset: async () => ({ ok: true, value: settings }),
    },
    shortcuts: { get: async () => { throw new Error("renderer transport closed"); } },
  };

  await runSettingsAction({ action: "reset", api, callbacks });

  assert.equal(state.busy, false);
  assert.deepEqual(state.settings, settings);
  assert.match(state.notices.at(-1).text, /Restart Fluely/i);
  assert.equal(state.notices.at(-1).tone, "error");
});

test("settings action updates settings and shortcut status on a successful save", async () => {
  assert.equal(typeof runSettingsAction, "function");
  const { state, callbacks } = makeCallbacks();
  const shortcutStatus = { entries: [], updatedAt: "2026-08-30T00:00:00.000Z" };
  const api = {
    settings: {
      update: async () => ({ ok: true, value: settings }),
      reset: async () => ({ ok: true, value: settings }),
    },
    shortcuts: { get: async () => ({ ok: true, value: shortcutStatus }) },
  };

  await runSettingsAction({
    action: "save",
    api,
    patch: { shortcuts: settings.shortcuts, window: settings.window },
    callbacks,
  });

  assert.equal(state.busy, false);
  assert.deepEqual(state.settings, settings);
  assert.deepEqual(state.draft, settings);
  assert.deepEqual(state.shortcutStatus, shortcutStatus);
  assert.equal(state.notices.at(-1).tone, "success");
});

test("settings action ignores late results after its component becomes inactive", async () => {
  assert.equal(typeof runSettingsAction, "function");
  let releaseUpdate;
  const active = { value: true };
  const { state, callbacks } = makeCallbacks(() => active.value);
  const api = {
    settings: {
      update: () => new Promise((resolve) => { releaseUpdate = resolve; }),
      reset: async () => ({ ok: true, value: settings }),
    },
    shortcuts: { get: async () => ({ ok: true, value: {} }) },
  };

  const action = runSettingsAction({
    action: "save",
    api,
    patch: { shortcuts: settings.shortcuts, window: settings.window },
    callbacks,
  });
  assert.equal(state.busy, true);
  active.value = false;
  releaseUpdate({ ok: true, value: settings });
  await action;

  assert.deepEqual(state.events, [["busy", true]]);
});
