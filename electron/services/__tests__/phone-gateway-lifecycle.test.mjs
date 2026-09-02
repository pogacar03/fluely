import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/phone-gateway-lifecycle.js");
let lifecycleModule;
try {
  lifecycleModule = await import(pathToFileURL(modulePath).href);
} catch {
  lifecycleModule = {};
}

const readyStatus = {
  state: "ready",
  origin: "http://192.168.50.8:4123",
  qrDataUrl: "data:image/png;base64,qr",
  pairingExpiresAt: 120_000,
  paired: false,
};

function makeGateway() {
  let status = { state: "disabled" };
  const calls = [];
  const listeners = new Set();
  const gateway = {
    getStatus: () => status,
    start: async () => {
      calls.push("start");
      status = { ...readyStatus };
      for (const listener of listeners) listener(status);
      return status;
    },
    stop: async () => {
      calls.push("stop");
      status = { state: "disabled" };
      for (const listener of listeners) listener(status);
      return status;
    },
    regeneratePairing: async () => {
      calls.push("regenerate");
      status = { ...readyStatus, qrDataUrl: "data:image/png;base64,new-qr" };
      for (const listener of listeners) listener(status);
      return status;
    },
    onStatusChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { gateway, calls };
}

function makeSettings() {
  const updates = [];
  let enabled = false;
  return {
    updates,
    service: {
      get: () => ({ phoneGateway: { enabled } }),
      update: async (patch) => {
        updates.push(patch);
        enabled = patch.phoneGateway.enabled;
        return { ok: true, value: { phoneGateway: { enabled } } };
      },
    },
  };
}

test("lifecycle starts persisted enabled state, maps typed actions, and disposes the gateway", async () => {
  assert.equal(typeof lifecycleModule.createPhoneGatewayLifecycle, "function");
  const { gateway, calls } = makeGateway();
  const settings = makeSettings();
  const statusEvents = [];
  const lifecycle = lifecycleModule.createPhoneGatewayLifecycle({
    gateway,
    settings: settings.service,
    notifyStatus: (status) => statusEvents.push(status),
  });

  const initial = await lifecycle.initialize({ enabled: true });
  assert.equal(initial.state, "ready");
  assert.deepEqual(calls, ["start"]);

  const regenerated = await lifecycle.handler.regeneratePairing();
  assert.equal(regenerated.ok, true);
  assert.equal(regenerated.value.qrDataUrl, "data:image/png;base64,new-qr");

  const disabled = await lifecycle.handler.disable();
  assert.deepEqual(disabled, { ok: true, value: { state: "disabled" } });
  assert.deepEqual(settings.updates, [{ phoneGateway: { enabled: false } }]);

  const enabled = await lifecycle.handler.enable();
  assert.equal(enabled.ok, true);
  assert.deepEqual(settings.updates.at(-1), { phoneGateway: { enabled: true } });
  assert.deepEqual(calls, ["start", "regenerate", "stop", "start"]);
  assert.equal(statusEvents.some((status) => status.state === "ready"), true);

  await lifecycle.dispose();
  assert.equal(calls.at(-1), "stop");
});

test("lifecycle turns gateway failures into generic IPC errors without exposing implementation details", async () => {
  assert.equal(typeof lifecycleModule.createPhoneGatewayLifecycle, "function");
  const settings = makeSettings();
  const gateway = {
    getStatus: () => ({ state: "disabled" }),
    start: async () => { throw new Error("/Users/secret/app-token.sock pairing secret=leak"); },
    stop: async () => ({ state: "disabled" }),
    regeneratePairing: async () => ({ state: "disabled" }),
    onStatusChanged: () => () => undefined,
  };
  const lifecycle = lifecycleModule.createPhoneGatewayLifecycle({ gateway, settings: settings.service });

  const result = await lifecycle.handler.enable();

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
  assert.equal(result.error.message.includes("/Users/"), false);
  assert.equal(result.error.message.includes("secret"), false);
  assert.equal(result.error.action.includes("Restart"), true);
  await lifecycle.dispose();
});
