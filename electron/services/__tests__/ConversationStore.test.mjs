import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/ConversationStore.js");
const { ConversationStore } = await import(pathToFileURL(modulePath).href);

const FIRST_ATTACHMENT = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mimeType: "image/png",
  width: 1,
  height: 1,
  byteLength: 10,
  createdAt: 100,
};
const SECOND_ATTACHMENT = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  mimeType: "image/png",
  width: 1,
  height: 1,
  byteLength: 10,
  createdAt: 101,
};

function makeStore(attachmentStore, overrides = {}) {
  let nextId = 0;
  return new ConversationStore({
    sessionId: "session-store",
    now: () => 1000,
    idFactory: () => `message-${++nextId}`,
    attachmentStore,
    ...overrides,
  });
}

test("ConversationStore exposes one snapshot/event port and cleans evicted attachments", async () => {
  const cleanupCalls = [];
  const store = makeStore({
    deleteUnreferenced: async (candidateIds, referencedIds) => {
      cleanupCalls.push({ candidateIds: [...candidateIds], referencedIds: [...referencedIds] });
      return [...candidateIds];
    },
  }, { maxMessages: 2 });
  const events = [];
  store.subscribe((event) => events.push(event));

  store.addAttachment(FIRST_ATTACHMENT);
  const first = store.startTurn("First", [FIRST_ATTACHMENT.id]);
  store.finishAssistant(first.assistant.id, "completed", "First answer");
  store.addAttachment(SECOND_ATTACHMENT);
  const second = store.startTurn("Second", [SECOND_ATTACHMENT.id]);
  store.finishAssistant(second.assistant.id, "completed", "Second answer");
  await store.whenIdle();

  assert.deepEqual(store.snapshot().messages.map((message) => message.text), ["Second", "Second answer"]);
  assert.deepEqual(store.snapshot().attachments.map((attachment) => attachment.id), [SECOND_ATTACHMENT.id]);
  assert.deepEqual(events.map((event) => event.type), [
    "attachment-added",
    "message-added",
    "message-added",
    "message-updated",
    "attachment-added",
    "message-added",
    "message-added",
    "turn-evicted",
    "message-updated",
  ]);
  assert.deepEqual(cleanupCalls, [{
    candidateIds: [FIRST_ATTACHMENT.id],
    referencedIds: [SECOND_ATTACHMENT.id],
  }]);
});

test("ConversationStore clear emits a revisioned empty snapshot and removes every attachment", async () => {
  const cleanupCalls = [];
  const store = makeStore({
    deleteUnreferenced: async (candidateIds, referencedIds) => {
      cleanupCalls.push({ candidateIds: [...candidateIds], referencedIds: [...referencedIds] });
      return [...candidateIds];
    },
  });
  const events = [];
  store.subscribe((event) => events.push(event));
  store.addAttachment(FIRST_ATTACHMENT);
  const turn = store.startTurn("Question", [FIRST_ATTACHMENT.id]);
  store.finishAssistant(turn.assistant.id, "cancelled");
  const beforeRevision = store.snapshot().revision;

  await store.clear();

  assert.deepEqual(store.snapshot().messages, []);
  assert.deepEqual(store.snapshot().attachments, []);
  assert.equal(store.snapshot().activeMessageId, undefined);
  assert.equal(events.at(-1).type, "cleared");
  assert.equal(events.at(-1).revision, beforeRevision + 1);
  assert.deepEqual(cleanupCalls.at(-1), {
    candidateIds: [FIRST_ATTACHMENT.id],
    referencedIds: [],
  });
});

test("ConversationStore retains failed cleanup registrations for a later retry", async () => {
  let attempts = 0;
  const store = makeStore({
    deleteUnreferenced: async (candidateIds) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("disk cleanup failed"), { code: "ATTACHMENT_CLEANUP_FAILED" });
      }
      return [...candidateIds];
    },
  });
  store.addAttachment(FIRST_ATTACHMENT);

  await assert.rejects(store.clear(), /cleanup failed/);
  assert.equal(attempts, 1);
  assert.deepEqual(store.snapshot().attachments, []);

  await store.clear();
  assert.equal(attempts, 2);
});

test("ConversationStore observes eviction cleanup rejection without unhandled rejection and retries it", async () => {
  let attempts = 0;
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const store = makeStore({
      deleteUnreferenced: async (candidateIds) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("eviction cleanup failed"), { code: "ATTACHMENT_CLEANUP_FAILED" });
        }
        return [...candidateIds];
      },
    }, { maxMessages: 2 });

    store.addAttachment(FIRST_ATTACHMENT);
    const first = store.startTurn("First", [FIRST_ATTACHMENT.id]);
    store.finishAssistant(first.assistant.id, "completed", "First answer");
    store.addAttachment(SECOND_ATTACHMENT);
    const second = store.startTurn("Second", [SECOND_ATTACHMENT.id]);
    store.finishAssistant(second.assistant.id, "completed", "Second answer");

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
    await assert.rejects(store.whenIdle(), /eviction cleanup failed/);

    await store.clear();
    assert.equal(attempts, 3);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("ConversationStore removes cleanup IDs from pending as each deletion succeeds", async () => {
  const cleanupCalls = [];
  const deletedIds = new Set();
  let failSecond = true;
  const store = makeStore({
    deleteUnreferenced: async (candidateIds) => {
      cleanupCalls.push([...candidateIds]);
      const removed = [];
      for (const id of candidateIds) {
        if (deletedIds.has(id)) {
          continue;
        }
        if (id === SECOND_ATTACHMENT.id && failSecond) {
          failSecond = false;
          throw Object.assign(new Error("second attachment cleanup failed"), { code: "ATTACHMENT_CLEANUP_FAILED" });
        }
        deletedIds.add(id);
        removed.push(id);
      }
      return removed;
    },
  }, { maxMessages: 2 });

  store.addAttachment(FIRST_ATTACHMENT);
  store.addAttachment(SECOND_ATTACHMENT);
  const first = store.startTurn("First", [FIRST_ATTACHMENT.id, SECOND_ATTACHMENT.id]);
  store.finishAssistant(first.assistant.id, "completed", "First answer");
  const second = store.startTurn("Second");
  store.finishAssistant(second.assistant.id, "completed", "Second answer");

  await assert.rejects(store.whenIdle(), /second attachment cleanup failed/);
  await store.clear();

  assert.deepEqual(cleanupCalls, [
    [FIRST_ATTACHMENT.id],
    [SECOND_ATTACHMENT.id],
    [SECOND_ATTACHMENT.id],
  ]);
});
