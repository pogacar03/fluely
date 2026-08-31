import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const screenshotServicePath = path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js");
const contextMediaPath = path.resolve(__dirname, "../../../dist-electron/electron/services/context-media.js");
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);
const { ScreenshotService } = await import(pathToFileURL(screenshotServicePath).href);
let createContextMediaHandler;
try {
  ({ createContextMediaHandler } = await import(pathToFileURL(contextMediaPath).href));
} catch {
  // The first RED run proves the production media seam is absent.
}

const SCREENSHOT_ID = "11111111-1111-4111-8111-111111111111";
const PNG_BYTES = Buffer.from("real-managed-png-bytes");

function idleAnalysisState() {
  return {
    status: "idle",
    text: "",
    model: "gpt-test",
    screenshotIds: [],
    startedAt: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
    completedAt: null,
  };
}

test("real workspace capture serves an opaque private preview and clear-queue makes it 404", async () => {
  assert.equal(typeof createContextMediaHandler, "function", "private context media handler seam is missing");
  const directory = await mkdtemp(path.join(os.tmpdir(), "fluely-workspace-media-"));
  const registrations = new Map();
  const service = new ScreenshotService({
    directory,
    platform: "linux",
    desktopCapturer: {
      getSources: async () => [{
        display_id: "1",
        thumbnail: {
          toPNG: () => PNG_BYTES,
          getSize: () => ({ width: 1440, height: 900 }),
        },
      }],
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 20 }),
      getDisplayNearestPoint: () => ({ id: 1, bounds: { width: 1440, height: 900 }, scaleFactor: 1 }),
    },
    idFactory: () => SCREENSHOT_ID,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
  });

  try {
    registerIpcHandlers({
      ipcMain: { handle: (channel, handler) => registrations.set(channel, handler) },
      settings: {
        get: () => ({ codex: { path: "codex", timeoutMs: 120000 }, shortcuts: {}, window: {}, privacy: {} }),
        update: async () => ({ ok: true, value: {} }),
        reset: async () => ({ ok: true, value: {} }),
      },
      shortcuts: {
        getStatus: () => ({ entries: [], updatedAt: "2026-08-31T00:00:00.000Z" }),
        update: () => ({ ok: true, value: { entries: [], updatedAt: "2026-08-31T00:00:00.000Z" } }),
      },
      screenshots: service,
      analysis: {
        start: async () => idleAnalysisState(),
        cancel: async () => idleAnalysisState(),
        getState: idleAnalysisState,
        onStateChanged: () => () => undefined,
      },
      getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
    });
    const execute = registrations.get("workspace:execute");
    const mediaHandler = createContextMediaHandler(service);

    const captured = await execute({}, { type: "capture", requestId: "media-capture-1" });
    assert.equal(captured.ok, true);
    assert.equal(captured.value.queue.items.length, 1);
    const [item] = captured.value.queue.items;
    assert.equal(item.previewUrl, `fluely-media://context/${SCREENSHOT_ID}`);
    assert.equal(JSON.stringify(captured).includes(directory), false);

    const preview = await mediaHandler(new Request(item.previewUrl));
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.equal(preview.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG_BYTES);
    assert.equal(JSON.stringify([...preview.headers]).includes(directory), false);

    const cleared = await execute({}, { type: "clear-queue", requestId: "media-clear-1" });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.value.queue.items, []);
    assert.equal((await mediaHandler(new Request(item.previewUrl))).status, 404);
    assert.equal((await mediaHandler(new Request("fluely-media://context/../settings.json"))).status, 404);
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
