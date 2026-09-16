import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/phone-gateway-startup.js");
let startupModule;
try {
  startupModule = await import(pathToFileURL(modulePath).href);
} catch {
  startupModule = {};
}

test("phone gateway initialization waits for screenshot and attachment stores before pairing can start", async () => {
  assert.equal(typeof startupModule.initializePhoneGatewayAfterStoresReady, "function");
  const order = [];
  let releaseScreenshot;
  let releaseAttachment;
  const screenshotReady = new Promise((resolve) => { releaseScreenshot = resolve; });
  const attachmentReady = new Promise((resolve) => { releaseAttachment = resolve; });

  const initialized = startupModule.initializePhoneGatewayAfterStoresReady({
    settings: { enabled: true },
    screenshotReady: async () => {
      order.push("screenshot-start");
      await screenshotReady;
      order.push("screenshot-ready");
    },
    attachmentReady: async () => {
      order.push("attachment-start");
      await attachmentReady;
      order.push("attachment-ready");
    },
    initializeGateway: async (settings) => {
      order.push(`gateway-start:${settings.enabled}`);
      return "ready";
    },
  });

  await Promise.resolve();
  assert.deepEqual(order, ["screenshot-start", "attachment-start"]);
  releaseScreenshot();
  await Promise.resolve();
  assert.deepEqual(order, ["screenshot-start", "attachment-start", "screenshot-ready"]);
  releaseAttachment();
  assert.equal(await initialized, "ready");
  assert.deepEqual(order, [
    "screenshot-start",
    "attachment-start",
    "screenshot-ready",
    "attachment-ready",
    "gateway-start:true",
  ]);
});
