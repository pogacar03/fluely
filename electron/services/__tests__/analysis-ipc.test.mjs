import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);

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

test("analysis IPC rejects malformed requests and unknown queued screenshot IDs before starting", async () => {
  const harness = makeHarness();

  const malformed = await harness.registrations.get("analysis:start")({}, {
    prompt: "question",
    screenshotIds: ["../../settings.json"],
    intent: "answer",
    fast: false,
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "INVALID_ARGUMENT");

  const unknown = await harness.registrations.get("analysis:start")({}, {
    prompt: "question",
    screenshotIds: [unknownScreenshotId],
    intent: "answer",
    fast: false,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "SCREENSHOT_NOT_FOUND");
  assert.deepEqual(harness.analysisCalls, []);

  const notAnObject = await harness.registrations.get("analysis:start")({}, null);
  assert.equal(notAnObject.ok, false);
  assert.equal(notAnObject.error.code, "INVALID_ARGUMENT");
});

test("analysis IPC forwards only the validated request and serializes service failures", async () => {
  const expected = {
    prompt: "Summarize this screen",
    screenshotIds: [screenshotId],
    intent: "recap",
    fast: true,
  };
  const harness = makeHarness();
  const result = await harness.registrations.get("analysis:start")({}, expected);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.analysisCalls, [expected]);
  assert.deepEqual(result.value.screenshotIds, [screenshotId]);
  assert.equal(Object.hasOwn(result.value, "paths"), false);

  const failingHarness = makeHarness({
    analysis: {
      start: () => {
        throw {
          code: "ANALYSIS_IN_PROGRESS",
          message: "already running",
          action: "Cancel the running request first.",
        };
      },
      cancel: () => ({ status: "cancelled" }),
      getState: () => ({ status: "running" }),
      onStateChanged: () => () => undefined,
    },
  });
  const failure = await failingHarness.registrations.get("analysis:start")({}, expected);
  assert.deepEqual(failure, {
    ok: false,
    error: {
      code: "ANALYSIS_IN_PROGRESS",
      message: "already running",
      action: "Cancel the running request first.",
    },
  });
});

test("window IPC clamps opacity before applying and persists setup/work mode", async () => {
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

  const work = await harness.registrations.get("window:set-mode")({}, "work");
  assert.equal(work.ok, true);
  assert.deepEqual(harness.settingsUpdates.at(-1), { setupComplete: true });

  const setup = await harness.registrations.get("window:set-mode")({}, "setup");
  assert.equal(setup.ok, true);
  assert.deepEqual(harness.settingsUpdates.at(-1), { setupComplete: false });

  const unknown = await harness.registrations.get("window:set-mode")({}, "debug");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "INVALID_ARGUMENT");
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
