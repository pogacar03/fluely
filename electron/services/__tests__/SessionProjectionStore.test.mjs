import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const conversationPath = path.resolve(__dirname, "../../../dist-electron/src/shared/conversation.js");
const projectionPath = path.resolve(__dirname, "../../../dist-electron/electron/services/SessionProjectionStore.js");
const [{ ConversationModel, applySessionProjectionEvent }, { SessionProjectionStore }] = await Promise.all([
  import(pathToFileURL(conversationPath).href),
  import(pathToFileURL(projectionPath).href),
]);

const FIRST_SCREENSHOT = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  capturedAt: 100,
  width: 1920,
  height: 1080,
  mimeType: "image/png",
  previewUrl: "fluely-media://context/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const SECOND_SCREENSHOT = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  capturedAt: 101,
  width: 1280,
  height: 720,
  mimeType: "image/png",
  previewUrl: "fluely-media://context/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

function createQueueSource() {
  let state = { items: [] };
  const listeners = new Set();
  return {
    getState: () => ({ items: state.items.map((item) => ({ ...item })) }),
    onStateChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(items) {
      state = { items: items.map((item) => ({ ...item })) };
      for (const listener of listeners) {
        listener(this.getState());
      }
    },
  };
}

function createConversation() {
  let nextId = 0;
  return new ConversationModel({
    sessionId: "session-projection",
    now: () => 1000,
    idFactory: () => `message-${++nextId}`,
  });
}

test("session projection exposes an immutable opaque snapshot and ordered conversation/queue events", () => {
  const conversation = createConversation();
  const queue = createQueueSource();
  const port = new SessionProjectionStore({ conversation, queue });
  const events = [];
  port.subscribe((event) => events.push(event));

  const queueItemWithPathProperty = {
    ...FIRST_SCREENSHOT,
    path: "/Users/yu/private/screenshot.png",
    previewUrl: "/Users/yu/private/screenshot.png",
  };
  queue.publish([queueItemWithPathProperty]);
  const turn = conversation.startTurn("What is shown?");

  const snapshot = port.getSnapshot();
  assert.deepEqual(snapshot.queue, [{
    ...FIRST_SCREENSHOT,
  }]);
  assert.equal("path" in snapshot.queue[0], false);
  assert.equal(snapshot.queue[0].previewUrl, FIRST_SCREENSHOT.previewUrl);
  snapshot.queue[0].id = "mutated";
  snapshot.conversation.messages[0].text = "mutated";

  assert.equal(snapshot.revision, 3);
  assert.equal(port.getSnapshot().queue[0].id, FIRST_SCREENSHOT.id);
  assert.equal(port.getSnapshot().conversation.messages[0].text, "What is shown?");
  assert.deepEqual(events.map((event) => event.type), ["queue-changed", "conversation", "conversation"]);
  assert.deepEqual(events.map((event) => event.revision), [1, 2, 3]);
  assert.equal(events[1].event.revision, 1);
  assert.equal(events[2].event.revision, 2);
  assert.equal(events[1].event.message.id, turn.user.id);
});

test("unchanged queue state does not create a false queue event and five queued items remain bounded by the source contract", () => {
  const conversation = createConversation();
  const queue = createQueueSource();
  const port = new SessionProjectionStore({ conversation, queue });
  const events = [];
  port.subscribe((event) => events.push(event));

  const fiveItems = [
    FIRST_SCREENSHOT,
    SECOND_SCREENSHOT,
    { ...FIRST_SCREENSHOT, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", capturedAt: 102 },
    { ...FIRST_SCREENSHOT, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", capturedAt: 103 },
    { ...FIRST_SCREENSHOT, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", capturedAt: 104 },
  ];
  queue.publish(fiveItems);
  queue.publish(fiveItems);

  assert.equal(port.getSnapshot().queue.length, 5);
  assert.deepEqual(events.map((event) => event.type), ["queue-changed"]);
  assert.equal(events[0].queue.length, 5);
});

test("a reconnecting consumer detects a projection revision gap and replaces it from a fresh snapshot", () => {
  const conversation = createConversation();
  const queue = createQueueSource();
  const port = new SessionProjectionStore({ conversation, queue });
  const initial = port.getSnapshot();
  const events = [];
  port.subscribe((event) => events.push(event));

  queue.publish([FIRST_SCREENSHOT]);
  const turn = conversation.startTurn("Question");
  const missedEvent = events[1];

  const gap = applySessionProjectionEvent(initial, missedEvent);
  assert.equal(gap.status, "gap");
  assert.equal(gap.snapshot.revision, initial.revision);

  const reconnected = port.getSnapshot();
  assert.equal(reconnected.revision, 3);
  assert.deepEqual(reconnected.queue.map((item) => item.id), [FIRST_SCREENSHOT.id]);
  assert.deepEqual(reconnected.conversation.messages.map((message) => message.sequence), [1, 2]);

  conversation.updateAssistant(turn.assistant.id, "Answer");
  const applied = applySessionProjectionEvent(reconnected, events[3]);
  assert.equal(applied.status, "applied");
  assert.equal(applied.snapshot.revision, 4);
  assert.equal(applied.snapshot.conversation.messages[1].text, "Answer");
});
