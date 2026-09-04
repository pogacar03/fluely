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
    { type: "command", command: { type: "capture", requestId: "b3" } },
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
