import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(__dirname, "../../../dist-electron/electron/preloadBridge.js");
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const { exposeFluelyApi } = await import(pathToFileURL(bridgePath).href);
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);

const disabledStatus = { state: "disabled" };

test("preload exposes typed phone gateway actions without exposing ipc primitives", async () => {
  let exposed;
  const calls = [];
  exposeFluelyApi({ exposeInMainWorld: (_name, api) => { exposed = api; } }, {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      return { ok: true, value: disabledStatus };
    },
  });

  assert.deepEqual(Object.keys(exposed.phoneGateway).sort(), [
    "disable",
    "enable",
    "getStatus",
    "onStatusChanged",
    "regeneratePairing",
  ]);
  await exposed.phoneGateway.getStatus();
  await exposed.phoneGateway.enable();
  await exposed.phoneGateway.regeneratePairing();
  await exposed.phoneGateway.disable();
  const unsubscribe = exposed.phoneGateway.onStatusChanged(() => undefined);
  assert.equal(typeof unsubscribe, "function");
  assert.deepEqual(calls.map((call) => call.channel), [
    "phone-gateway:get-status",
    "phone-gateway:enable",
    "phone-gateway:regenerate-pairing",
    "phone-gateway:disable",
  ]);
  assert.equal(exposed.ipcRenderer, undefined);
});

test("main registers typed phone gateway lifecycle channels and forwards only safe status", async () => {
  const registrations = new Map();
  const status = {
    state: "ready",
    origin: "http://192.168.50.8:45678",
    qrDataUrl: "data:image/png;base64,qr",
    pairingExpiresAt: 130_000,
    paired: false,
  };
  const phoneGateway = {
    getStatus: () => status,
    enable: async () => ({ ok: true, value: status }),
    disable: async () => ({ ok: true, value: disabledStatus }),
    regeneratePairing: async () => ({ ok: true, value: status }),
  };
  registerIpcHandlers({
    ipcMain: { handle: (channel, handler) => registrations.set(channel, handler) },
    settings: {
      get: () => ({ phoneGateway: { enabled: false } }),
      update: async () => ({ ok: true, value: { phoneGateway: { enabled: false } } }),
      reset: async () => ({ ok: true, value: { phoneGateway: { enabled: false } } }),
    },
    shortcuts: { getStatus: () => ({ entries: [], updatedAt: new Date(0).toISOString() }), update: () => ({ ok: true, value: {} }) },
    screenshots: { getState: () => ({ items: [], capturing: false, permission: "unavailable" }) },
    phoneGateway,
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: false }),
  });

  for (const channel of [
    "phone-gateway:get-status",
    "phone-gateway:enable",
    "phone-gateway:disable",
    "phone-gateway:regenerate-pairing",
  ]) {
    assert.equal(typeof registrations.get(channel), "function", channel);
  }
  assert.deepEqual(await registrations.get("phone-gateway:get-status")(), { ok: true, value: status });
  assert.deepEqual(await registrations.get("phone-gateway:enable")(), { ok: true, value: status });
  assert.deepEqual(await registrations.get("phone-gateway:disable")(), { ok: true, value: disabledStatus });
});

test("settings IPC applies persisted phone gateway changes and reset disables it", async () => {
  const registrations = new Map();
  const applied = [];
  const enabledSettings = { phoneGateway: { enabled: true } };
  const disabledSettings = { phoneGateway: { enabled: false } };
  registerIpcHandlers({
    ipcMain: { handle: (channel, handler) => registrations.set(channel, handler) },
    settings: {
      get: () => disabledSettings,
      update: async () => ({ ok: true, value: enabledSettings }),
      reset: async () => ({ ok: true, value: disabledSettings }),
    },
    shortcuts: { getStatus: () => ({ entries: [], updatedAt: "" }), update: () => ({ ok: true, value: {} }) },
    screenshots: { getState: () => ({ items: [], capturing: false, permission: "unavailable" }) },
    applyPhoneGatewaySettings: async (settings) => { applied.push(settings); },
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "darwin", visible: false }),
  });

  const updateResult = await registrations.get("settings:update")({}, { phoneGateway: { enabled: true } });
  const resetResult = await registrations.get("settings:reset")();

  assert.equal(updateResult.ok, true);
  assert.equal(resetResult.ok, true);
  assert.deepEqual(applied, [enabledSettings.phoneGateway, disabledSettings.phoneGateway]);
});
