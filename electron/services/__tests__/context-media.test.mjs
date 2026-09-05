import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/context-media.js");
const { createContextMediaHandler } = await import(pathToFileURL(modulePath).href);

const SCREENSHOT_ID = "11111111-1111-4111-8111-111111111111";

test("context media converts a managed-path getter failure into a generic 404", async () => {
  const handler = createContextMediaHandler({
    getManagedPaths: () => {
      throw new Error("private managed path");
    },
  });

  const response = await handler(new Request(`fluely-media://context/${SCREENSHOT_ID}`));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await response.text(), "");
});
