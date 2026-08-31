import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(__dirname, "../../../dist-electron/electron/preloadBridge.js");
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const { exposeFluelyApi } = await import(pathToFileURL(bridgePath).href);
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

function screenshot(id, capturedAt) {
  return {
    id,
    capturedAt,
    width: 1920,
    height: 1080,
    mimeType: "image/png",
    previewUrl: `fluely-media://context/${id}`,
  };
}

function makeHarness({ captureFailure = null } = {}) {
  const registrations = new Map();
  const calls = [];
  const analysisCalls = [];
  let queue = [screenshot(FIRST_ID, 1), screenshot(SECOND_ID, 2)];
  let nextCapture = 0;
  const analysisState = {
    status: "idle",
    text: "",
    model: "gpt-test",
    screenshotIds: [],
    startedAt: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
    completedAt: null,
  };

  const screenshots = {
    getState: () => ({ items: queue.map((item) => ({ ...item })), capturing: false, permission: "granted" }),
    capture: async () => {
      calls.push("capture");
      if (captureFailure) {
        throw captureFailure;
      }
      nextCapture += 1;
      const item = screenshot(THIRD_ID, 2 + nextCapture);
      queue = [...queue, item];
      return item;
    },
    delete: async (id) => {
      calls.push(`remove:${id}`);
      queue = queue.filter((item) => item.id !== id);
      return screenshots.getState();
    },
    clear: async () => {
      calls.push("clear-queue");
      queue = [];
      return screenshots.getState();
    },
  };
  const analysis = {
    start: async (request) => {
      calls.push("send");
      analysisCalls.push(request);
      return {
        ...analysisState,
        status: "running",
        screenshotIds: [...request.screenshotIds],
      };
    },
    cancel: async () => {
      calls.push("cancel");
      return { ...analysisState, status: "cancelled" };
    },
    getState: () => ({ ...analysisState }),
    onStateChanged: () => () => undefined,
  };

  registerIpcHandlers({
    ipcMain: {
      handle(channel, handler) {
        registrations.set(channel, handler);
      },
    },
    settings: {
      get: () => ({ codex: { path: "codex", timeoutMs: 120000 }, shortcuts: {}, window: {}, privacy: {} }),
      update: async () => ({ ok: true, value: {} }),
      reset: async () => ({ ok: true, value: {} }),
    },
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }),
      update: () => ({ ok: true, value: {} }),
    },
    screenshots,
    analysis,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  return { registrations, calls, analysisCalls, screenshots };
}

test("preload exposes one shared workspace command method and forwards opaque command payloads", async () => {
  let exposedApi;
  const calls = [];
  exposeFluelyApi({ exposeInMainWorld: (_name, api) => { exposedApi = api; } }, {
    invoke: (channel, ...args) => {
      calls.push({ channel, args });
      return Promise.resolve({ ok: true, value: { queue: { items: [] } } });
    },
  });

  const command = { type: "send", requestId: "request-1", prompt: "" };
  await exposedApi.workspace.execute(command);

  assert.deepEqual(calls, [{ channel: "workspace:execute", args: [command] }]);
  assert.equal(exposedApi.workspace.execute.length, 1);
});

test("workspace IPC validates every command payload before touching queue or analysis services", async () => {
  const harness = makeHarness();
  const execute = harness.registrations.get("workspace:execute");

  for (const payload of [
    null,
    { type: "capture", requestId: "" },
    { type: "remove", requestId: "bad-remove", screenshotId: "../settings.json" },
    { type: "send", requestId: "bad-send", prompt: 42 },
    { type: "unknown", requestId: "bad-type" },
  ]) {
    const result = await execute({}, payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_ARGUMENT");
  }

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.analysisCalls, []);
});

test("Send images sends all queued IDs, normalizes an empty prompt, and retains the draft queue", async () => {
  const harness = makeHarness();
  const execute = harness.registrations.get("workspace:execute");
  const command = { type: "send", requestId: "send-1", prompt: "   " };

  const result = await execute({}, command);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.calls, ["send"]);
  assert.deepEqual(harness.analysisCalls, [{
    prompt: "Analyze the attached screenshots.",
    screenshotIds: [FIRST_ID, SECOND_ID],
    intent: "answer",
    fast: false,
  }]);
  assert.deepEqual(result.value.queue.items.map((item) => item.id), [FIRST_ID, SECOND_ID]);
  assert.deepEqual(harness.screenshots.getState().items.map((item) => item.id), [FIRST_ID, SECOND_ID]);
});

test("duplicate workspace request IDs share one result and do not repeat a send", async () => {
  const harness = makeHarness();
  const execute = harness.registrations.get("workspace:execute");
  const command = { type: "send", requestId: "send-duplicate", prompt: "Read these screens" };

  const first = await execute({}, command);
  const duplicate = await execute({}, { ...command });

  assert.deepEqual(duplicate, first);
  assert.deepEqual(harness.calls, ["send"]);
  assert.equal((await execute({}, { ...command, prompt: "Different request" })).ok, false);
  assert.deepEqual(harness.calls, ["send"]);
});

test("Capture & ask captures first and sends only after a successful capture", async () => {
  const harness = makeHarness();
  const execute = harness.registrations.get("workspace:execute");

  const result = await execute({}, {
    type: "capture-and-send",
    requestId: "capture-send-1",
    prompt: "What changed?",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(harness.calls, ["capture", "send"]);
  assert.deepEqual(harness.analysisCalls[0].screenshotIds, [FIRST_ID, SECOND_ID, THIRD_ID]);
  assert.equal(harness.analysisCalls[0].prompt, "What changed?");
  assert.deepEqual(harness.screenshots.getState().items.map((item) => item.id), [FIRST_ID, SECOND_ID, THIRD_ID]);

  const failed = makeHarness({ captureFailure: {
    code: "SCREEN_CAPTURE_DENIED",
    message: "permission denied",
    action: "Enable screen recording.",
  } });
  const failedResult = await failed.registrations.get("workspace:execute")({}, {
    type: "capture-and-send",
    requestId: "capture-send-failed",
    prompt: "Do not send",
  });
  assert.equal(failedResult.ok, false);
  assert.deepEqual(failed.calls, ["capture"]);
  assert.deepEqual(failed.analysisCalls, []);
});

test("cancel, remove, and clear-queue are explicit queue-preserving or queue-only commands", async () => {
  const harness = makeHarness();
  const execute = harness.registrations.get("workspace:execute");

  const cancelled = await execute({}, { type: "cancel", requestId: "cancel-1" });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelled.value.queue.items.map((item) => item.id), [FIRST_ID, SECOND_ID]);

  const removed = await execute({}, { type: "remove", requestId: "remove-1", screenshotId: FIRST_ID });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.value.queue.items.map((item) => item.id), [SECOND_ID]);

  const cleared = await execute({}, { type: "clear-queue", requestId: "clear-1" });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.value.queue.items, []);
  assert.deepEqual(harness.calls, ["cancel", `remove:${FIRST_ID}`, "clear-queue"]);
});
