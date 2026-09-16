import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/pairing-rate-limiter.js");
let limiterModule;
try {
  limiterModule = await import(pathToFileURL(modulePath).href);
} catch {
  limiterModule = {};
}

test("pairing failure limiter enforces per-address and global fixed-window caps", () => {
  assert.equal(typeof limiterModule.createPairingFailureLimiter, "function");
  let now = 1_000;
  const limiter = limiterModule.createPairingFailureLimiter({
    now: () => now,
    windowMs: 1_000,
    maxFailuresPerAddress: 2,
    maxFailuresGlobal: 3,
    maxTrackedAddresses: 4,
  });

  assert.equal(limiter.allow("192.168.1.10"), true);
  limiter.recordFailure("192.168.1.10");
  assert.equal(limiter.allow("192.168.1.10"), true);
  limiter.recordFailure("192.168.1.10");
  assert.equal(limiter.allow("192.168.1.10"), false);

  assert.equal(limiter.allow("192.168.1.11"), true);
  limiter.recordFailure("192.168.1.11");
  assert.equal(limiter.allow("192.168.1.12"), false);
});

test("pairing failure limiter resets on success and at the next window", () => {
  assert.equal(typeof limiterModule.createPairingFailureLimiter, "function");
  let now = 5_000;
  const limiter = limiterModule.createPairingFailureLimiter({
    now: () => now,
    windowMs: 1_000,
    maxFailuresPerAddress: 1,
    maxFailuresGlobal: 2,
    maxTrackedAddresses: 4,
  });

  assert.equal(limiter.allow("192.168.1.10"), true);
  limiter.recordFailure("192.168.1.10");
  assert.equal(limiter.allow("192.168.1.10"), false);
  limiter.recordSuccess();
  assert.equal(limiter.allow("192.168.1.10"), true);
  limiter.recordFailure("192.168.1.10");

  now = 6_000;
  assert.equal(limiter.allow("192.168.1.10"), true);
});

test("pairing failure limiter evicts the oldest address when its state cap is full", () => {
  assert.equal(typeof limiterModule.createPairingFailureLimiter, "function");
  const limiter = limiterModule.createPairingFailureLimiter({
    now: () => 20_000,
    windowMs: 1_000,
    maxFailuresPerAddress: 10,
    maxFailuresGlobal: 50,
    maxTrackedAddresses: 2,
  });

  for (const address of ["192.168.1.1", "192.168.1.2"]) {
    assert.equal(limiter.allow(address), true);
    limiter.recordFailure(address);
  }

  assert.equal(limiter.allow("192.168.1.3"), true);
  limiter.recordFailure("192.168.1.3");
  assert.equal(limiter.allow("192.168.1.1"), true);
});
