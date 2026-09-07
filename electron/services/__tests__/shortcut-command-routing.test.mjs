import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/shortcut-command-routing.js");
const { createShortcutCommandHandlers } = await import(pathToFileURL(modulePath).href);

test("shortcut actions enter the desktop CommandRouter and keep clear explicit", async () => {
  const calls = [];
  let nextRequest = 0;
  const handlers = createShortcutCommandHandlers({
    execute: async (command, source) => {
      calls.push({ command, source });
      return { queue: { items: [] }, conversation: { sessionId: "session", revision: 0, messages: [], attachments: [] } };
    },
  }, (action) => `shortcut-${action}-${++nextRequest}`);

  await handlers.captureScreenshot();
  await handlers.analyzeQueue();
  await handlers.captureAndAnalyze();
  await handlers.cancelAndClear();

  assert.deepEqual(calls, [
    {
      command: { type: "capture", requestId: "shortcut-capture-1" },
      source: "desktop",
    },
    {
      command: {
        type: "ask",
        requestId: "shortcut-ask-2",
        prompt: "Analyze the attached screenshots.",
      },
      source: "desktop",
    },
    {
      command: {
        type: "ask",
        requestId: "shortcut-ask-3",
        prompt: "Analyze the attached screenshots.",
      },
      source: "desktop",
    },
    {
      command: { type: "cancel", requestId: "shortcut-cancel-4" },
      source: "desktop",
    },
    {
      command: { type: "clear-queue", requestId: "shortcut-clear-queue-5" },
      source: "desktop",
    },
  ]);
});
