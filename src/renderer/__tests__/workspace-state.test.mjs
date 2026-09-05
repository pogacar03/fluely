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

test("getQueueIds returns every managed queue ID in metadata order", () => {
  const state = {
    items: [
      { id: FIRST_ID, createdAt: "2026-08-30T00:00:00.000Z", width: 1280, height: 720 },
      { id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-08-30T00:01:00.000Z", width: 1440, height: 900 },
    ],
    capturing: false,
    permission: "granted",
  };
  assert.deepEqual(workspaceState.getQueueIds(state), [
    FIRST_ID,
    "22222222-2222-4222-8222-222222222222",
  ]);
  assert.deepEqual(workspaceState.getQueueIds(null), []);
});

test("getAnalysisScreenshotIds analyzes the refreshed queue plus the captured item", () => {
  const state = {
    items: [
      { id: FIRST_ID, createdAt: "2026-08-30T00:00:00.000Z", width: 1280, height: 720 },
      { id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-08-30T00:01:00.000Z", width: 1440, height: 900 },
    ],
    capturing: false,
    permission: "granted",
  };
  assert.deepEqual(workspaceState.getAnalysisScreenshotIds(state, FIRST_ID), [
    FIRST_ID,
    "22222222-2222-4222-8222-222222222222",
  ]);
  assert.deepEqual(workspaceState.getAnalysisScreenshotIds(state, "33333333-3333-4333-8333-333333333333"), [
    FIRST_ID,
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ]);
});

test("getAnalysisActionState disables asks while running and enables cancel", () => {
  assert.deepEqual(workspaceState.getAnalysisActionState("running", 2), {
    isRunning: true,
    canCaptureAsk: false,
    canAskQueue: false,
    canCancel: true,
    captureLabel: "Capture & ask",
    queueLabel: "Send images",
    cancelLabel: "Cancel",
  });
  assert.equal(workspaceState.getAnalysisActionState("idle", 0).canAskQueue, false);
  assert.equal(workspaceState.getAnalysisActionState("completed", 1).canAskQueue, true);
});

test("canonical workspace busy state covers capture, pending, streaming, and restored idle", () => {
  const conversation = (status) => ({
    sessionId: "session-busy",
    revision: 1,
    messages: status ? [{
      id: "assistant-busy",
      sequence: 1,
      role: "assistant",
      text: "",
      attachmentIds: [],
      status,
      createdAt: 1,
    }] : [],
    attachments: [],
    ...(status ? { activeMessageId: "assistant-busy" } : {}),
  });

  assert.deepEqual(workspaceState.getCanonicalWorkspaceBusyState({
    capturing: true,
    conversation: conversation("completed"),
  }), { isCapturing: true, isRunning: false, isBusy: true });
  assert.deepEqual(workspaceState.getCanonicalWorkspaceBusyState({
    capturing: false,
    conversation: conversation("pending"),
  }), { isCapturing: false, isRunning: true, isBusy: true });
  assert.deepEqual(workspaceState.getCanonicalWorkspaceBusyState({
    capturing: false,
    conversation: conversation("streaming"),
  }), { isCapturing: false, isRunning: true, isBusy: true });
  assert.deepEqual(workspaceState.getCanonicalWorkspaceBusyState({
    capturing: false,
    conversation: conversation("completed"),
  }), { isCapturing: false, isRunning: false, isBusy: false });
});

test("workspace action state exposes separate capture/send actions and suppresses duplicates", () => {
  assert.deepEqual(workspaceState.getWorkspaceActionState("idle", 2, false, false), {
    isRunning: false,
    isBusy: false,
    canCapture: true,
    canSendImages: true,
    canCaptureAndSend: true,
    canCancel: false,
    captureLabel: "Capture",
    sendImagesLabel: "Send images",
    captureAndSendLabel: "Capture & ask",
    cancelLabel: "Cancel",
  });

  const running = workspaceState.getWorkspaceActionState("running", 2, false, false);
  assert.equal(running.canCapture, false);
  assert.equal(running.canSendImages, false);
  assert.equal(running.canCaptureAndSend, false);
  assert.equal(running.canCancel, true);

  const duplicate = workspaceState.getWorkspaceActionState("idle", 2, true, false);
  assert.equal(duplicate.isBusy, true);
  assert.equal(duplicate.canCapture, false);
  assert.equal(duplicate.canSendImages, false);
  assert.equal(duplicate.canCancel, false);
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
