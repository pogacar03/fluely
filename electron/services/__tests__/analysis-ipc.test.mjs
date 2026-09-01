import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const analysisServicePath = path.resolve(__dirname, "../../../dist-electron/electron/services/AnalysisService.js");
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);
const { AnalysisService } = await import(pathToFileURL(analysisServicePath).href);

const screenshotId = "11111111-1111-4111-8111-111111111111";
const unknownScreenshotId = "22222222-2222-4222-8222-222222222222";
const screenshotState = {
  items: [{
    id: screenshotId,
    createdAt: "2026-08-30T00:00:00.000Z",
    width: 1280,
    height: 720,
  }],
  capturing: false,
  permission: "granted",
};
const settingsValue = {
  setupComplete: false,
  shortcuts: {
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+Shift+8",
    analyzeQueue: "CommandOrControl+Enter",
    captureAndAnalyze: "CommandOrControl+Shift+Enter",
    cancelAndClear: "CommandOrControl+R",
  },
  window: { width: 960, height: 720, opacity: 0.92 },
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

function makeHarness(overrides = {}) {
  const registrations = new Map();
  const analysisCalls = [];
  const codexCalls = [];
  const opacityCalls = [];
  const settingsUpdates = [];
  const analysisState = {
    status: "idle",
    text: "",
    model: "gpt-5.6-sol",
    screenshotIds: [],
    startedAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
  };
  const analysisListeners = new Set();
  const analysisNotifications = [];
  const settings = {
    get: () => settingsValue,
    update: async (patch) => {
      settingsUpdates.push(patch);
      return { ok: true, value: { ...settingsValue, ...patch } };
    },
    reset: async () => ({ ok: true, value: settingsValue }),
  };
  const screenshots = {
    getState: () => screenshotState,
    getManagedPaths: (ids) => (ids ?? [screenshotId]).map((id) => `/private/screenshots/${id}.png`),
    capture: async () => screenshotState.items[0],
    delete: async () => screenshotState,
    clear: async () => ({ ...screenshotState, items: [] }),
  };
  const analysis = {
    start: (request) => {
      analysisCalls.push(request);
      return { ...analysisState, status: "running", screenshotIds: request.screenshotIds };
    },
    cancel: () => ({ ...analysisState, status: "cancelled" }),
    getState: () => analysisState,
    onStateChanged: (listener) => {
      analysisListeners.add(listener);
      return () => analysisListeners.delete(listener);
    },
  };
  const codex = {
    getStatus: async () => {
      codexCalls.push({ method: "getStatus" });
      return { available: true, configuredPath: "codex", version: "codex-cli test" };
    },
    validate: async (pathValue) => {
      codexCalls.push({ method: "validate", path: pathValue });
      return { available: true, configuredPath: pathValue, version: "codex-cli test" };
    },
  };
  const window = {
    setOpacity: (opacity) => opacityCalls.push(opacity),
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
    screenshots,
    analysis,
    codex,
    window,
    ...overrides,
    notifyAnalysisState: (event) => analysisNotifications.push(event),
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  return {
    registrations,
    analysisCalls,
    codexCalls,
    opacityCalls,
    settingsUpdates,
    analysisListeners,
    analysisNotifications,
  };
}

test("analysis IPC no longer exposes a direct start or cancel channel", () => {
  const harness = makeHarness();
  assert.equal(harness.registrations.has("analysis:start"), false);
  assert.equal(harness.registrations.has("analysis:cancel"), false);
});

test("window opacity IPC clamps valid values and rejects invalid input", async () => {
  const harness = makeHarness();

  const low = await harness.registrations.get("window:set-opacity")({}, -10);
  assert.equal(low.ok, true);
  assert.equal(harness.opacityCalls.at(-1), 0.35);
  assert.deepEqual(harness.settingsUpdates.at(-1), { window: { opacity: 0.35 } });

  const high = await harness.registrations.get("window:set-opacity")({}, 2);
  assert.equal(high.ok, true);
  assert.equal(harness.opacityCalls.at(-1), 1);
  assert.deepEqual(harness.settingsUpdates.at(-1), { window: { opacity: 1 } });

  const invalid = await harness.registrations.get("window:set-opacity")({}, "opaque");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_ARGUMENT");

});

test("Codex IPC returns a serializable status and never exposes child-process details", async () => {
  const harness = makeHarness();

  const status = await harness.registrations.get("codex:get-status")();
  assert.equal(status.ok, true);
  assert.deepEqual(status.value, {
    available: true,
    configuredPath: "codex",
  });
  assert.equal(Object.hasOwn(status.value, "child"), false);

  const validated = await harness.registrations.get("codex:validate")({}, " /custom/codex ");
  assert.equal(validated.ok, true);
  assert.deepEqual(harness.codexCalls.at(-1), { method: "validate", path: "/custom/codex" });
});

test("analysis state subscription forwards serializable snapshots to the renderer notifier", () => {
  const harness = makeHarness();
  const notify = [...harness.analysisListeners][0];
  assert.equal(typeof notify, "function");
  notify({ event: "delta", status: "running", text: "answer" });

  assert.deepEqual(harness.analysisNotifications, [{
    event: "delta",
    status: "running",
    text: "answer",
    model: "",
    screenshotIds: [],
    startedAt: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
    completedAt: null,
  }]);
});

test("settings updates refresh the next analysis provider call without changing an active request", async () => {
  const initialCodex = {
    ...settingsValue.codex,
    path: "/old/codex",
    model: "old-model",
    fastModel: "old-fast-model",
    timeoutMs: 1100,
  };
  let currentSettings = {
    ...settingsValue,
    codex: initialCodex,
  };
  const registrations = new Map();
  const calls = [];
  let releaseFirst;
  let providerStarted;
  const firstProviderStarted = new Promise((resolve) => {
    providerStarted = resolve;
  });
  const firstProviderRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const provider = {
    stream: async function* (executable, options) {
      calls.push({ executable, options });
      if (calls.length === 1) {
        providerStarted();
        await firstProviderRelease;
      }
      yield "answer";
    },
  };
  const analysis = new AnalysisService({
    provider,
    getManagedPaths: () => [],
    codex: initialCodex,
  });
  const settings = {
    get: () => currentSettings,
    update: async (patch) => {
      currentSettings = {
        ...currentSettings,
        ...patch,
        codex: {
          ...currentSettings.codex,
          ...(patch.codex ?? {}),
        },
      };
      return { ok: true, value: currentSettings };
    },
    reset: async () => ({ ok: true, value: currentSettings }),
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
      capture: async () => screenshotState.items[0],
      delete: async () => ({ items: [], capturing: false, permission: "unavailable" }),
      clear: async () => ({ items: [], capturing: false, permission: "unavailable" }),
    },
    analysis,
    applyCodexSettings: (codex) => analysis.updateCodexSettings(codex),
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  const request = {
    prompt: "What is shown?",
    screenshotIds: [],
    intent: "answer",
    fast: false,
  };
  const first = analysis.start(request);
  assert.equal(first.status, "running");
  await firstProviderStarted;

  const updated = await registrations.get("settings:update")({}, {
    codex: {
      path: "/new/codex",
      model: "new-model",
      timeoutMs: 2200,
    },
  });
  assert.equal(updated.ok, true);
  assert.equal(calls[0].executable, "/old/codex");
  assert.equal(calls[0].options.model, "old-model");
  assert.equal(calls[0].options.timeoutMs, 1100);

  releaseFirst();
  await analysis.whenIdle();
  const second = analysis.start(request);
  assert.equal(second.status, "running");
  await analysis.whenIdle();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].executable, "/new/codex");
  assert.equal(calls[1].options.model, "new-model");
  assert.equal(calls[1].options.timeoutMs, 2200);
});
