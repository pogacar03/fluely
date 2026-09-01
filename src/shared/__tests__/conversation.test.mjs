import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/shared/conversation.js");
const {
  ConversationModel,
  applyConversationEvent,
  createConversationProjection,
} = await import(pathToFileURL(modulePath).href);

const FIRST_ATTACHMENT = {
  id: "attachment-1",
  mimeType: "image/png",
  width: 1920,
  height: 1080,
  byteLength: 3,
  createdAt: 100,
};

const SECOND_ATTACHMENT = {
  id: "attachment-2",
  mimeType: "image/png",
  width: 1920,
  height: 1080,
  byteLength: 4,
  createdAt: 101,
};

function makeModel(options = {}) {
  let nextId = 0;
  return new ConversationModel({
    sessionId: "session-test",
    now: () => 1000,
    idFactory: () => `message-${++nextId}`,
    ...options,
  });
}

test("conversation revisions and message sequences increase in mutation order", () => {
  const model = makeModel();
  const events = [];
  model.subscribe((event) => events.push(event));

  model.addAttachment(FIRST_ATTACHMENT);
  const turn = model.startTurn("What is shown?", [FIRST_ATTACHMENT.id]);
  model.updateAssistant(turn.assistant.id, "Answer", "streaming");
  model.finishAssistant(turn.assistant.id, "completed");

  assert.deepEqual(events.map((event) => event.revision), [1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((event) => event.type), [
    "attachment-added",
    "message-added",
    "message-added",
    "message-updated",
    "message-updated",
  ]);
  assert.deepEqual(model.snapshot().messages.map((message) => message.sequence), [1, 2]);
  assert.equal(model.snapshot().revision, 5);
});

test("conversation snapshots and attachment references are immutable to callers", () => {
  const model = makeModel();
  model.addAttachment(FIRST_ATTACHMENT);
  const turn = model.startTurn("Question", [FIRST_ATTACHMENT.id]);

  const snapshot = model.snapshot();
  snapshot.messages[0].text = "mutated";
  snapshot.messages[0].attachmentIds.push("unexpected");
  snapshot.attachments[0].id = "mutated";

  const fresh = model.snapshot();
  assert.equal(fresh.messages[0].text, "Question");
  assert.deepEqual(fresh.messages[0].attachmentIds, [FIRST_ATTACHMENT.id]);
  assert.equal(fresh.attachments[0].id, FIRST_ATTACHMENT.id);
  assert.equal(fresh.activeMessageId, turn.assistant.id);
});

test("terminal assistant events clear the active message and preserve the terminal status", () => {
  const model = makeModel();
  const turn = model.startTurn("Question", []);

  assert.equal(model.snapshot().activeMessageId, turn.assistant.id);
  model.finishAssistant(turn.assistant.id, "cancelled");

  const assistant = model.snapshot().messages.find((message) => message.id === turn.assistant.id);
  assert.equal(model.snapshot().activeMessageId, undefined);
  assert.equal(assistant.status, "cancelled");
  assert.equal(assistant.finishedAt, 1000);
});

test("oldest complete user/assistant turn is evicted with unreferenced attachments", () => {
  const model = makeModel({ maxMessages: 2, maxAttachmentBytes: 100 });
  model.addAttachment(FIRST_ATTACHMENT);
  const first = model.startTurn("First", [FIRST_ATTACHMENT.id]);
  model.finishAssistant(first.assistant.id, "completed", "first answer");

  model.addAttachment(SECOND_ATTACHMENT);
  const second = model.startTurn("Second", [SECOND_ATTACHMENT.id]);
  model.finishAssistant(second.assistant.id, "completed", "second answer");

  const snapshot = model.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => message.text), ["Second", "second answer"]);
  assert.deepEqual(snapshot.attachments.map((attachment) => attachment.id), [SECOND_ATTACHMENT.id]);
  assert.equal(snapshot.activeMessageId, undefined);
  assert.equal(snapshot.revision, 9);
});

test("projection applies the next revision, ignores duplicates, and reports gaps", () => {
  const model = makeModel();
  const turn = model.startTurn("Question", []);
  const snapshot = {
    sessionId: "session-test",
    revision: 1,
    messages: [],
    attachments: [],
  };
  const firstEvent = model.snapshot();
  const event = {
    revision: 2,
    type: "message-added",
    message: firstEvent.messages[0],
    activeMessageId: turn.assistant.id,
  };

  const applied = applyConversationEvent(snapshot, event);
  assert.equal(applied.status, "applied");
  assert.equal(applied.snapshot.revision, 2);
  assert.equal(applied.snapshot.messages[0].id, turn.user.id);

  const duplicate = applyConversationEvent(applied.snapshot, event);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.snapshot.revision, 2);

  const gap = applyConversationEvent(applied.snapshot, {
    ...event,
    revision: 4,
  });
  assert.equal(gap.status, "gap");
  assert.equal(gap.snapshot.revision, 2);
});

test("conversation projection serializes events and replaces state after a revision gap", async () => {
  const firstMessage = {
    id: "message-1",
    sequence: 1,
    role: "user",
    text: "Question",
    attachmentIds: [],
    status: "completed",
    createdAt: 1000,
    finishedAt: 1000,
  };
  const assistantMessage = {
    id: "message-2",
    sequence: 2,
    role: "assistant",
    text: "Answer",
    attachmentIds: [],
    status: "completed",
    createdAt: 1000,
    finishedAt: 1000,
  };
  let resyncReads = 0;
  const projection = createConversationProjection({
    sessionId: "session-projection",
    revision: 0,
    messages: [],
    attachments: [],
  }, async () => {
    resyncReads += 1;
    return {
      sessionId: "session-projection",
      revision: 3,
      messages: [firstMessage, assistantMessage],
      attachments: [],
    };
  });

  const first = await projection.apply({
    type: "message-added",
    revision: 1,
    activeMessageId: null,
    message: firstMessage,
  });
  assert.equal(first.status, "applied");
  assert.equal(projection.snapshot().revision, 1);

  const gap = await projection.apply({
    type: "message-updated",
    revision: 4,
    activeMessageId: null,
    message: assistantMessage,
  });
  assert.equal(gap.status, "gap");
  assert.equal(resyncReads, 1);
  assert.equal(projection.snapshot().revision, 3);
  assert.deepEqual(projection.snapshot().messages.map((message) => message.text), ["Question", "Answer"]);

  const terminalUpdate = await projection.apply({
    type: "message-updated",
    revision: 4,
    activeMessageId: null,
    message: { ...assistantMessage, text: "Final answer" },
  });
  assert.equal(terminalUpdate.status, "applied");
  assert.equal(projection.snapshot().revision, 4);
  assert.equal(projection.snapshot().messages[1].text, "Final answer");
});
