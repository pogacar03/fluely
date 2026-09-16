import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/shared/context-queue.js");
const {
  EMPTY_CONTEXT_PROMPT,
  MAX_CONTEXT_SCREENSHOTS,
  appendContextScreenshot,
  clearContextQueue,
  createContextQueue,
  createRequestIdDeduper,
  createWorkspaceRequestIdFactory,
  normalizeContextPrompt,
  removeContextScreenshot,
  selectQueuedScreenshots,
} = await import(pathToFileURL(modulePath).href);

function screenshot(index) {
  return {
    id: `${index}${"0000000"}-0000-4000-8000-000000000000`.slice(0, 36),
    capturedAt: index,
    width: 1280 + index,
    height: 720 + index,
    mimeType: "image/png",
    previewUrl: `fluely-media://context/${index}`,
  };
}

test("context queue appends in order and retains only its five newest screenshots", () => {
  let queue = createContextQueue();

  for (let index = 1; index <= MAX_CONTEXT_SCREENSHOTS + 1; index += 1) {
    queue = appendContextScreenshot(queue, screenshot(index));
  }

  assert.deepEqual(queue.items.map((item) => item.capturedAt), [2, 3, 4, 5, 6]);
  assert.equal(queue.items.length, 5);
  assert.equal(queue.items[0].previewUrl, "fluely-media://context/2");
});

test("context queue removes one draft item and clear removes only draft items", () => {
  const first = screenshot(1);
  const second = screenshot(2);
  const queue = createContextQueue([first, second]);

  const afterRemove = removeContextScreenshot(queue, first.id);
  assert.deepEqual(afterRemove.items, [second]);
  assert.deepEqual(clearContextQueue(afterRemove).items, []);
  assert.deepEqual(queue.items, [first, second]);
});

test("context queue normalizes only blank prompts to the deterministic send prompt", () => {
  assert.equal(EMPTY_CONTEXT_PROMPT, "Analyze the attached screenshots.");
  assert.equal(normalizeContextPrompt("   \n\t"), EMPTY_CONTEXT_PROMPT);
  assert.equal(normalizeContextPrompt("  Explain the error.  "), "Explain the error.");
});

test("send selection returns every queued screenshot in display order without mutating the queue", () => {
  const queue = createContextQueue([screenshot(1), screenshot(2), screenshot(3)]);

  const selection = selectQueuedScreenshots(queue);
  assert.deepEqual(selection.map((item) => item.id), queue.items.map((item) => item.id));
  assert.notEqual(selection, queue.items);
  selection.pop();
  assert.equal(queue.items.length, 3);
});

test("request-id deduper shares one pending result and rejects reuse for a different command", async () => {
  const deduper = createRequestIdDeduper();
  let calls = 0;
  let release;
  const pendingResult = new Promise((resolve) => { release = resolve; });

  const first = deduper.run("request-1", "capture", async () => {
    calls += 1;
    return pendingResult;
  });
  const duplicate = deduper.run("request-1", "capture", async () => {
    calls += 1;
    return "unexpected";
  });

  release("captured once");
  assert.equal(await first, "captured once");
  assert.equal(await duplicate, "captured once");
  assert.equal(calls, 1);

  await assert.rejects(
    deduper.run("request-1", "remove", async () => "unexpected"),
    /already used/i,
  );
});

test("renderer request IDs use one injectable nonce per session and restart their sequence after reload", () => {
  assert.equal(typeof createWorkspaceRequestIdFactory, "function");

  const firstSession = createWorkspaceRequestIdFactory(() => "session-alpha");
  const reloadedSession = createWorkspaceRequestIdFactory(() => "session-beta");

  assert.equal(firstSession.next("capture"), "desktop-session-alpha-capture-1");
  assert.equal(firstSession.next("send"), "desktop-session-alpha-send-2");
  assert.equal(reloadedSession.next("capture"), "desktop-session-beta-capture-1");
});

test("request-id deduper retains exactly the 512 most recently completed requests", async () => {
  const deduper = createRequestIdDeduper();
  let calls = 0;

  for (let index = 0; index < 513; index += 1) {
    await deduper.run(`completed-${index}`, "capture", async () => {
      calls += 1;
      return index;
    });
  }

  const newestCached = await deduper.run("completed-512", "capture", async () => {
    calls += 1;
    return "unexpected";
  });
  const evictedOldest = await deduper.run("completed-0", "capture", async () => {
    calls += 1;
    return "fresh";
  });

  assert.equal(newestCached, 512);
  assert.equal(evictedOldest, "fresh");
  assert.equal(calls, 514);
});

test("request-id deduper never evicts an in-flight request while completed entries rotate", async () => {
  const deduper = createRequestIdDeduper();
  let pendingCalls = 0;
  let release;
  const pendingResult = new Promise((resolve) => { release = resolve; });

  const first = deduper.run("pending", "capture", async () => {
    pendingCalls += 1;
    return pendingResult;
  });
  for (let index = 0; index < 513; index += 1) {
    await deduper.run(`other-${index}`, "capture", async () => index);
  }
  const duplicate = deduper.run("pending", "capture", async () => {
    pendingCalls += 1;
    return "unexpected";
  });

  release("shared result");
  assert.equal(await first, "shared result");
  assert.equal(await duplicate, "shared result");
  assert.equal(pendingCalls, 1);
});
