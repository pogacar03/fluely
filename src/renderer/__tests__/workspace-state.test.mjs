import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/shared/workspace-state.js");
const workspaceState = await import(pathToFileURL(modulePath).href);
const ipcModulePath = path.resolve(__dirname, "../../../dist-electron/src/shared/ipc.js");
const { subscribeToAnalysisState } = await import(pathToFileURL(ipcModulePath).href);

const FIRST_ID = "11111111-1111-4111-8111-111111111111";

test("selectWorkspaceMode keeps first-run settings in setup and completed settings in work", () => {
  assert.equal(workspaceState.selectWorkspaceMode({ setupComplete: false }), "setup");
  assert.equal(workspaceState.selectWorkspaceMode({ setupComplete: true }), "work");
  assert.equal(workspaceState.selectWorkspaceMode(null), "setup");
});

test("buildIntentPrompt adds an intent instruction while preserving the question", () => {
  assert.equal(
    workspaceState.buildIntentPrompt("explain", "What does this error mean?"),
    "Explain the selected screenshots clearly.\n\nQuestion: What does this error mean?",
  );
  assert.equal(
    workspaceState.buildIntentPrompt("recap", "  "),
    "Recap the selected screenshots briefly.",
  );
});

test("formatOpacityLabel clamps opacity and formats it as a whole percentage", () => {
  assert.equal(workspaceState.formatOpacityLabel(0.92), "92%");
  assert.equal(workspaceState.formatOpacityLabel(0.349), "35%");
  assert.equal(workspaceState.formatOpacityLabel(1.2), "100%");
});

test("getQueueCount reports metadata items without exposing paths", () => {
  const state = {
    items: [{ id: FIRST_ID, createdAt: "2026-08-30T00:00:00.000Z", width: 1280, height: 720 }],
    capturing: false,
    permission: "granted",
  };
  assert.equal(workspaceState.getQueueCount(state), 1);
  assert.equal(workspaceState.getQueueCount(null), 0);
});

test("getAnalysisActionState disables asks while running and enables cancel", () => {
  assert.deepEqual(workspaceState.getAnalysisActionState("running", 2), {
    isRunning: true,
    canCaptureAsk: false,
    canAskQueue: false,
    canCancel: true,
    captureLabel: "Capture & ask",
    queueLabel: "Ask queue",
    cancelLabel: "Cancel",
  });
  assert.equal(workspaceState.getAnalysisActionState("idle", 0).canAskQueue, false);
  assert.equal(workspaceState.getAnalysisActionState("completed", 1).canAskQueue, true);
});

test("successful setup state transition selects the work view", () => {
  let settings = { setupComplete: false };
  assert.equal(workspaceState.selectWorkspaceMode(settings), "setup");
  settings = { ...settings, setupComplete: true };
  assert.equal(workspaceState.selectWorkspaceMode(settings), "work");
});

test("analysis state subscription ignores stale events and unsubscribes once", () => {
  const listeners = new Set();
  let unsubscribeCalls = 0;
  const source = {
    onStateChanged(listener) {
      listeners.add(listener);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(listener);
      };
    },
  };
  let active = true;
  const received = [];
  const unsubscribe = subscribeToAnalysisState(source, (event) => received.push(event), () => active);
  const event = {
    event: "delta",
    status: "running",
    text: "answer",
    model: "model",
    screenshotIds: [],
    startedAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
  };
  for (const listener of listeners) listener(event);
  active = false;
  for (const listener of listeners) listener({ ...event, text: "stale" });
  unsubscribe();
  unsubscribe();
  for (const listener of listeners) listener({ ...event, text: "removed" });

  assert.deepEqual(received.map((value) => value.text), ["answer"]);
  assert.equal(unsubscribeCalls, 1);
});
