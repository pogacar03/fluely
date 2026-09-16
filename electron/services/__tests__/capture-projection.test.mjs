import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js");
const conversationPath = path.resolve(__dirname, "../../../dist-electron/src/shared/conversation.js");
const projectionPath = path.resolve(__dirname, "../../../dist-electron/electron/services/SessionProjectionStore.js");
const [{ ScreenshotService }, { ConversationModel }, { SessionProjectionStore }] = await Promise.all([
  import(pathToFileURL(screenshotPath).href),
  import(pathToFileURL(conversationPath).href),
  import(pathToFileURL(projectionPath).href),
]);

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test("a successful capture updates the session projection queue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-capture-projection-"));
  temporaryDirectories.push(root);
  const listeners = new Set();
  const screenshots = new ScreenshotService({
    directory: root,
    platform: "linux",
    desktopCapturer: {
      getSources: async () => [{
        display_id: "42",
        thumbnail: {
          toPNG: () => PNG_BYTES,
          getSize: () => ({ width: 1920, height: 1080 }),
        },
      }],
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 200 }),
      getDisplayNearestPoint: () => ({
        id: 42,
        bounds: { width: 1920, height: 1080 },
        scaleFactor: 1,
      }),
    },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    idFactory: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    now: () => new Date(100),
    onStateChanged: (state) => {
      for (const listener of listeners) listener(state);
    },
  });
  const queue = {
    getState: () => screenshots.getState(),
    onStateChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const conversation = new ConversationModel({ sessionId: "capture-projection", now: () => 100 });
  const projection = new SessionProjectionStore({ conversation, queue });
  const events = [];
  projection.subscribe((event) => events.push(event));

  const result = await screenshots.capture("desktop");

  assert.equal(result.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(projection.getSnapshot().queue.map((item) => item.id), [result.id]);
  assert.deepEqual(events.map((event) => event.type), ["queue-changed", "queue-changed"]);
  assert.deepEqual(events.at(-1).queue.map((item) => item.id), [result.id]);
});
