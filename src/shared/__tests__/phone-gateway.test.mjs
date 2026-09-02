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
