import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/shared/phone-gateway.js");
let phoneGateway;
try {
  phoneGateway = await import(pathToFileURL(modulePath).href);
} catch {
  phoneGateway = {};
}

test("shared phone gateway contract fixes the default-off pairing policy", () => {
  assert.equal(typeof phoneGateway.PHONE_GATEWAY_PAIRING_TTL_MS, "number");
  assert.equal(phoneGateway.PHONE_GATEWAY_PAIRING_TTL_MS, 120_000);
  assert.deepEqual(phoneGateway.PHONE_GATEWAY_PORTS, [
    4123, 4124, 4125, 4126, 4127, 4128,
    4129, 4130, 4131, 4132, 4133, 4134,
  ]);
});

test("B2 accepts only exact typed resync and ping client frames and serializes server frames", () => {
  assert.equal(typeof phoneGateway.parsePhoneClientFrame, "function");
  assert.equal(typeof phoneGateway.serializePhoneServerFrame, "function");

  assert.deepEqual(phoneGateway.parsePhoneClientFrame(JSON.stringify({
    type: "ping",
    at: 123,
  })), { type: "ping", at: 123 });
  assert.deepEqual(phoneGateway.parsePhoneClientFrame(JSON.stringify({
    type: "resync",
    requestId: "phone-resync-1",
    afterRevision: 7,
  })), {
    type: "resync",
    requestId: "phone-resync-1",
    afterRevision: 7,
  });

  for (const invalid of [
    { type: "command", command: { type: "unsupported", requestId: "b3" } },
    { type: "ping", at: 123, requestId: "unexpected" },
    { type: "resync", requestId: "", afterRevision: 7 },
    { type: "resync", requestId: "phone-resync-1", afterRevision: -1 },
    { type: "resync", requestId: "phone-resync-1", afterRevision: 7, extra: true },
  ]) {
    assert.equal(phoneGateway.parsePhoneClientFrame(JSON.stringify(invalid)), null);
  }
  assert.equal(phoneGateway.parsePhoneClientFrame("not-json"), null);

  assert.equal(phoneGateway.serializePhoneServerFrame({
    type: "pong",
    at: 123,
  }), JSON.stringify({ type: "pong", at: 123 }));
});

test("B3 accepts the capture and ask workspace command frames", () => {
  const commands = [
    { type: "capture", requestId: "phone-capture-1" },
    { type: "ask", requestId: "phone-ask-1" },
    { type: "ask", requestId: "phone-ask-2", prompt: "Question" },
    {
      type: "remove",
      requestId: "phone-remove-1",
      screenshotId: "11111111-1111-4111-8111-111111111111",
    },
    { type: "clear-queue", requestId: "phone-clear-queue-1" },
    { type: "clear-conversation", requestId: "phone-clear-conversation-1" },
    { type: "cancel", requestId: "phone-cancel-1" },
  ];

  for (const command of commands) {
    assert.deepEqual(
      phoneGateway.parsePhoneClientFrame(JSON.stringify({ type: "command", command })),
      { type: "command", command },
      command.type,
    );
  }
});

test("B3 rejects old and unknown command types, invalid IDs, and prompt lengths", () => {
  const validRemove = {
    type: "command",
    command: {
      type: "remove",
      requestId: "phone-remove-2",
      screenshotId: "11111111-1111-4111-8111-111111111111",
    },
  };
  const invalidFrames = [
    { ...validRemove, extra: true },
    { type: "command", command: { ...validRemove.command, extra: true } },
    { type: "command", command: { type: "send", requestId: "phone-send-1", prompt: "Question" } },
    { type: "command", command: { type: "capture-and-send", requestId: "phone-capture-send-1", prompt: "Question" } },
    { type: "command", command: { type: "unknown", requestId: "phone-unknown" } },
    { type: "command", command: { type: "capture", requestId: "" } },
    { type: "command", command: { type: "capture", requestId: " leading" } },
    { type: "command", command: { type: "capture", requestId: "trailing " } },
    { type: "command", command: { type: "capture", requestId: 1 } },
    { type: "command", command: { type: "remove", requestId: "phone-remove-3", screenshotId: "not-an-id" } },
    { type: "command", command: { type: "ask", requestId: "phone-ask-3", prompt: 1 } },
    { type: "command", command: { type: "ask", requestId: "phone-ask-4", prompt: "x".repeat(3001) } },
  ];

  for (const invalid of invalidFrames) {
    assert.equal(phoneGateway.parsePhoneClientFrame(JSON.stringify(invalid)), null, JSON.stringify(invalid));
  }

  assert.deepEqual(
    phoneGateway.parsePhoneClientFrame(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId: "🙂".repeat(32) },
    })),
    { type: "command", command: { type: "capture", requestId: "🙂".repeat(32) } },
  );
  assert.equal(phoneGateway.parsePhoneClientFrame(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "🙂".repeat(33) },
  })), null);
});

test("B3 rejects oversize and malformed UTF-8 frames at the protocol boundary", () => {
  const oversized = JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "x", padding: "x".repeat(16 * 1024) },
  });
  assert.ok(new TextEncoder().encode(oversized).byteLength > 16 * 1024);
  assert.equal(phoneGateway.parsePhoneClientFrame(oversized), null);
  assert.equal(phoneGateway.parsePhoneClientFrame(new Uint8Array([0xff, 0xfe])), null);
});
