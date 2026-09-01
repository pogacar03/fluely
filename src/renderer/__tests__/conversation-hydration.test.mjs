import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/renderer/conversation-hydration.js");
const { createConversationHydrationCoordinator } = await import(pathToFileURL(modulePath).href);

function snapshot(revision = 0, messages = []) {
  return {
    sessionId: "session-hydration",
    revision,
    messages,
    attachments: [],
  };
}

function messageAdded(revision, text = "event applied") {
  return {
    type: "message-added",
    revision,
    activeMessageId: null,
    message: {
      id: `message-${revision}`,
      sequence: revision,
      role: "user",
      text,
      attachmentIds: [],
      status: "completed",
      createdAt: revision,
      finishedAt: revision,
    },
  };
}

test("bounded hydration failure reaches unavailable, then command fallback recovers queued events", async () => {
  let readAttempts = 0;
  const coordinator = createConversationHydrationCoordinator({
    readSnapshot: async () => {
      readAttempts += 1;
      throw new Error("snapshot unavailable");
    },
    sleep: async () => undefined,
    maxAttempts: 3,
  });

  assert.equal(await coordinator.retryHydration(), false);
  assert.equal(readAttempts, 3);
  assert.equal(coordinator.getState().status, "unavailable");

  const event = messageAdded(1);
  await coordinator.queueEvent(event);
  coordinator.promote(snapshot(0));
  await coordinator.whenIdle();

  assert.equal(coordinator.getState().status, "hydrated");
  assert.equal(coordinator.snapshot().revision, 1);
  assert.equal(coordinator.snapshot().messages[0].text, "event applied");
});

test("an in-flight hydration retry cannot undo a command fallback promotion", async () => {
  let releaseRead;
  let readStarted;
  const readStartedPromise = new Promise((resolve) => { readStarted = resolve; });
  const readSnapshot = new Promise((_, reject) => {
    releaseRead = reject;
  });
  const coordinator = createConversationHydrationCoordinator({
    readSnapshot: async () => {
      readStarted();
      return readSnapshot;
    },
    sleep: async () => undefined,
    maxAttempts: 1,
  });

  const retry = coordinator.retryHydration();
  await readStartedPromise;
  coordinator.promote(snapshot(0));
  releaseRead(new Error("stale hydration retry failed"));

  assert.equal(await retry, false);
  assert.equal(coordinator.getState().status, "hydrated");

  await coordinator.queueEvent(messageAdded(1));
  assert.equal(coordinator.snapshot().revision, 1);
  assert.equal(coordinator.snapshot().messages[0].text, "event applied");
});

test("conversation gaps retry resync a bounded number of times and settle after recovery", async () => {
  let readAttempts = 0;
  const coordinator = createConversationHydrationCoordinator({
    initial: snapshot(0),
    readSnapshot: async () => {
      readAttempts += 1;
      if (readAttempts === 1) {
        throw new Error("temporary snapshot failure");
      }
      return snapshot(2, [messageAdded(1).message, messageAdded(2, "gap event").message]);
    },
    sleep: async () => undefined,
    maxAttempts: 3,
  });

  await coordinator.queueEvent(messageAdded(2, "gap event"));
  await coordinator.whenIdle();

  assert.equal(readAttempts, 2);
  assert.equal(coordinator.getState().status, "hydrated");
  assert.equal(coordinator.snapshot().revision, 2);
  assert.equal(coordinator.snapshot().messages[1].text, "gap event");
});
