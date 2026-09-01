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
