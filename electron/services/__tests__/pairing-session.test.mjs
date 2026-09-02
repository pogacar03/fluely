import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/pairing-session.js");
let pairingModule;
try {
  pairingModule = await import(pathToFileURL(modulePath).href);
} catch {
  pairingModule = {};
}

function deterministicRandomBytes() {
  let nextByte = 0;
  return (size) => {
    nextByte += 1;
    return Buffer.alloc(size, nextByte);
  };
}

test("pairing issues a 32-byte secret with a 120-second expiry and exchanges it once", () => {
  assert.equal(typeof pairingModule.createPairingSessionManager, "function");
  let now = 10_000;
  const manager = pairingModule.createPairingSessionManager({
    now: () => now,
    randomBytes: deterministicRandomBytes(),
  });

  const pairing = manager.issue();
  assert.match(pairing.secret, /^[0-9a-f]{64}$/);
  assert.equal(pairing.expiresAt, 130_000);

  const exchanged = manager.exchange(pairing.secret);
  assert.ok(exchanged);
  assert.match(exchanged.cookieToken, /^[0-9a-f]{64}$/);
  assert.notEqual(exchanged.cookieToken, pairing.secret);
  assert.equal(manager.authenticate(exchanged.cookieToken), true);
  assert.equal(manager.exchange(pairing.secret), null);
  assert.equal(manager.authenticate("00"), false);
});

test("expired pairing is rejected and replacement pairing revokes the previous phone", () => {
  assert.equal(typeof pairingModule.createPairingSessionManager, "function");
  let now = 50_000;
  const manager = pairingModule.createPairingSessionManager({
    now: () => now,
    randomBytes: deterministicRandomBytes(),
  });

  const first = manager.issue();
  now = first.expiresAt;
  assert.equal(manager.exchange(first.secret), null);

  now += 1;
  const second = manager.issue();
  const firstCookie = manager.exchange(second.secret).cookieToken;
  const replacement = manager.issue();
  assert.equal(manager.authenticate(firstCookie), false);
  const secondCookie = manager.exchange(replacement.secret).cookieToken;
  assert.equal(manager.authenticate(secondCookie), true);

  manager.revokeAll();
  assert.equal(manager.authenticate(secondCookie), false);
  assert.equal(manager.exchange(replacement.secret), null);
});

test("expiring pending pairing clears only the pending secret and preserves a paired session", () => {
  assert.equal(typeof pairingModule.createPairingSessionManager, "function");
  const manager = pairingModule.createPairingSessionManager({
    now: () => 10_000,
    randomBytes: deterministicRandomBytes(),
  });

  const first = manager.issue();
  const firstCookie = manager.exchange(first.secret).cookieToken;
  manager.revokePending();

  assert.equal(manager.authenticate(firstCookie), true);
  assert.equal(manager.isPaired(), true);
});
