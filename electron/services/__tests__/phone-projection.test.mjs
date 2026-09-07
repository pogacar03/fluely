import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const conversationPath = path.resolve(__dirname, "../../../dist-electron/src/shared/conversation.js");
const projectionPath = path.resolve(__dirname, "../../../dist-electron/electron/services/phone-projection.js");
const [{ cloneSessionProjectionSnapshot }, phoneProjectionModule] = await Promise.all([
  import(pathToFileURL(conversationPath).href),
  (async () => {
    try {
      return await import(pathToFileURL(projectionPath).href);
    } catch {
      return {};
    }
  })(),
]);

const QUEUE_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_CAPABILITY = "a".repeat(64);

function canonicalSnapshot() {
  return {
    revision: 4,
    conversation: {
      sessionId: "session-phone",
      revision: 3,
      messages: [{
        id: "message-1",
        sequence: 1,
        role: "user",
        text: "What is shown?",
        attachmentIds: [ATTACHMENT_ID],
        status: "completed",
        createdAt: 100,
        finishedAt: 100,
      }],
      attachments: [{
        id: ATTACHMENT_ID,
        mimeType: "image/png",
        width: 1920,
        height: 1080,
        byteLength: 10,
        createdAt: 100,
      }],
    },
    queue: [{
      id: QUEUE_ID,
      capturedAt: 90,
      width: 1920,
      height: 1080,
      mimeType: "image/png",
      previewUrl: `fluely-media://context/${QUEUE_ID}`,
    }],
  };
}

test("phone projection preserves canonical conversation metadata and only rewrites queue media URLs", () => {
  assert.equal(typeof phoneProjectionModule.toPhoneProjectionSnapshot, "function");
  assert.equal(typeof phoneProjectionModule.phoneContextUrl, "function");
  assert.equal(typeof phoneProjectionModule.phoneAttachmentUrl, "function");

  const canonical = canonicalSnapshot();
  const phone = phoneProjectionModule.toPhoneProjectionSnapshot(canonical, MEDIA_CAPABILITY);
  const canonicalComparable = cloneSessionProjectionSnapshot(canonical);
  const phoneComparable = structuredClone(phone);
  delete phoneComparable.mediaCapability;
  phoneComparable.queue = phoneComparable.queue.map(({ previewUrl, ...item }) => item);
  canonicalComparable.queue = canonicalComparable.queue.map(({ previewUrl, ...item }) => item);

  assert.deepEqual(phoneComparable, canonicalComparable);
  assert.equal(phone.queue[0].previewUrl, `/api/context/${MEDIA_CAPABILITY}/${QUEUE_ID}`);
  assert.equal(phoneProjectionModule.phoneContextUrl(QUEUE_ID, MEDIA_CAPABILITY), `/api/context/${MEDIA_CAPABILITY}/${QUEUE_ID}`);
  assert.equal(phoneProjectionModule.phoneAttachmentUrl(ATTACHMENT_ID, MEDIA_CAPABILITY), `/api/attachments/${MEDIA_CAPABILITY}/${ATTACHMENT_ID}`);
  assert.throws(() => phoneProjectionModule.phoneContextUrl(QUEUE_ID), /capability/i);
  assert.throws(() => phoneProjectionModule.phoneAttachmentUrl(ATTACHMENT_ID, "bad"), /capability/i);
  assert.equal(phone.queue[0].previewUrl.includes("/Users/"), false);
});

test("phone projection redacts unsafe fields while preserving normal user and assistant text", () => {
  assert.equal(typeof phoneProjectionModule.toPhoneProjectionEvent, "function");
  const privateValue = "/Users/private/fluely/session/diagnostic.json";
  const unsafeAssistant = {
    id: "message-unsafe",
    sequence: 2,
    role: "assistant",
    text: "Visible assistant answer",
    attachmentIds: [],
    status: "error",
    createdAt: 101,
    error: {
      code: "INTERNAL_ERROR",
      message: `raw provider failure at ${privateValue}`,
      stack: `Error: raw\n    at ${privateValue}:12:4`,
    },
    path: privateValue,
    internalException: privateValue,
  };
  const unsafeSnapshot = {
    ...canonicalSnapshot(),
    conversation: {
      ...canonicalSnapshot().conversation,
      messages: [canonicalSnapshot().conversation.messages[0], unsafeAssistant],
      attachments: [{ ...canonicalSnapshot().conversation.attachments[0], path: privateValue }],
    },
    queue: [{ ...canonicalSnapshot().queue[0], path: privateValue }],
  };

  const phone = phoneProjectionModule.toPhoneProjectionSnapshot(unsafeSnapshot, MEDIA_CAPABILITY);
  const serializedSnapshot = JSON.stringify(phone);
  assert.doesNotMatch(serializedSnapshot, /Users\/private|raw provider|INTERNAL_ERROR|stack|internalException/i);
  assert.equal(phone.conversation.messages[0].text, "What is shown?");
  assert.equal(phone.conversation.messages[1].text, "Visible assistant answer");
  assert.deepEqual(phone.conversation.messages[1].error, {
    code: "ANALYSIS_FAILED",
    message: "Analysis failed.",
  });

  const event = phoneProjectionModule.toPhoneProjectionEvent({
    type: "conversation",
    revision: 5,
    event: {
      type: "message-updated",
      revision: 5,
      activeMessageId: unsafeAssistant.id,
      message: unsafeAssistant,
    },
  }, MEDIA_CAPABILITY);
  const serializedEvent = JSON.stringify(event);
  assert.doesNotMatch(serializedEvent, /Users\/private|raw provider|INTERNAL_ERROR|stack|internalException/i);
  assert.equal(event.event.message.text, "Visible assistant answer");
  assert.deepEqual(event.event.message.error, {
    code: "ANALYSIS_FAILED",
    message: "Analysis failed.",
  });
});

test("phone projection subscription preserves projection revisions and returns immutable channel-specific queue events", () => {
  assert.equal(typeof phoneProjectionModule.createPhoneProjection, "function");
  const canonical = canonicalSnapshot();
  const listeners = new Set();
  const source = {
    getSnapshot: () => cloneSessionProjectionSnapshot(canonical),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const phone = phoneProjectionModule.createPhoneProjection(source, {
    getMediaCapability: () => MEDIA_CAPABILITY,
  });
  const events = [];
  phone.subscribe((event) => events.push(event));

  const queue = [{ ...canonical.queue[0], previewUrl: "fluely-media://context/11111111-1111-4111-8111-111111111111" }];
  for (const listener of listeners) {
    listener({ type: "queue-changed", revision: 5, queue });
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].revision, 5);
  assert.equal(events[0].type, "queue-changed");
  assert.equal(events[0].queue[0].previewUrl, `/api/context/${MEDIA_CAPABILITY}/${QUEUE_ID}`);
  events[0].queue[0].id = "mutated";
  assert.equal(queue[0].id, QUEUE_ID);
});

test("phone projection fails closed when the current session capability is unavailable", () => {
  const source = {
    getSnapshot: () => ({ ...canonicalSnapshot(), queue: [] }),
    subscribe: () => () => undefined,
  };
  const phone = phoneProjectionModule.createPhoneProjection(source, {
    getMediaCapability: () => undefined,
  });
  assert.throws(() => phone.getSnapshot(), /capability/i);
});
