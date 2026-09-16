import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/windowConfig.js");
const { getWindowPreferences } = await import(pathToFileURL(modulePath).href);

test("window preferences enforce the Fluely security boundary", () => {
  const preferences = getWindowPreferences("/tmp/preload.js");

  assert.equal(preferences.preload, "/tmp/preload.js");
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
});
