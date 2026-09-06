import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePaths = {
  router: path.resolve(__dirname, "../../../dist-electron/electron/services/CommandRouter.js"),
  conversation: path.resolve(__dirname, "../../../dist-electron/electron/services/ConversationStore.js"),
  attachments: path.resolve(__dirname, "../../../dist-electron/electron/services/AttachmentStore.js"),
  analysis: path.resolve(__dirname, "../../../dist-electron/electron/services/AnalysisService.js"),
};
const [{ CommandRouter }, { ConversationStore }, { AttachmentStore }, { AnalysisService }] = await Promise.all(
  Object.values(modulePaths).map((modulePath) => import(pathToFileURL(modulePath).href)),
);

const SCREENSHOT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const temporaryDirectories = [];

async function makeHarness({ provider, queueItems = 1 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-router-"));
  temporaryDirectories.push(root);
  const items = Array.from({ length: queueItems }, (_, index) => ({
    id: index === 0 ? SCREENSHOT_ID : `22222222-2222-4222-8222-22222222222${index}`,
    capturedAt: 100 + index,
    width: 1920,
    height: 1080,
    mimeType: "image/png",
    previewUrl: `fluely-media://context/${index === 0 ? SCREENSHOT_ID : `22222222-2222-4222-8222-22222222222${index}`}`,
  }));
  const paths = new Map();
  await Promise.all(items.map(async (item) => {
    const sourcePath = path.join(root, `${item.id}.png`);
    await writeFile(sourcePath, PNG_BYTES);
    paths.set(item.id, sourcePath);
  }));
  let queue = [...items];
  const screenshots = {
    getState: () => ({ items: queue.map((item) => ({ ...item })), capturing: false, permission: "granted" }),
    getManagedPaths: (ids) => (ids ?? queue.map((item) => item.id))
      .filter((id) => paths.has(id))
      .map((id) => paths.get(id)),
    capture: async () => queue[0],
    delete: async (id) => {
      queue = queue.filter((item) => item.id !== id);
      return screenshots.getState();
    },
    clear: async () => {
      queue = [];
      return screenshots.getState();
    },
  };
  let nextAttachmentId = 0;
  const attachments = new AttachmentStore({
    rootDirectory: path.join(root, "session-attachments"),
    sessionId: "session-router",
    idFactory: () => [ATTACHMENT_ID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"][nextAttachmentId++],
    now: () => 200,
  });
  await attachments.whenReady();
  const conversation = new ConversationStore({
    sessionId: attachments.sessionId,
    now: () => 300,
    idFactory: (() => {
      let next = 0;
      return () => `message-${++next}`;
    })(),
    attachmentStore: attachments,
  });
  const analysis = new AnalysisService({
    provider,
    screenshots,
    codex: {
      enabled: true,
      path: "codex",
      model: "test-model",
      fastModel: "fast-model",
      timeoutMs: 1000,
      sandboxMode: "read-only",
      modelReasoningEffort: "medium",
    },
    now: () => new Date(400),
  });
  const router = new CommandRouter({ screenshots, attachments, conversation, analysis });
  return { router, analysis, conversation, attachments, screenshots };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test("send materializes immutable attachments, preserves the queue, and completes one canonical turn", async () => {
  const calls = [];
  const harness = await makeHarness({
    provider: {
      stream: async function* (_path, options) {
        calls.push(options);
        yield "fallback answer";
      },
    },
  });
  const events = [];
  harness.conversation.subscribe((event) => events.push(event));

  const result = await harness.router.execute({ type: "send", requestId: "send-1", prompt: "Question" }, "desktop");
  await harness.analysis.whenIdle();

  const snapshot = harness.conversation.snapshot();
  assert.equal(result.conversation.activeMessageId !== undefined, true);
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.status, message.text]), [
    ["user", "completed", "Question"],
    ["assistant", "completed", "fallback answer"],
  ]);
  assert.deepEqual(snapshot.messages[0].attachmentIds, [ATTACHMENT_ID]);
  assert.equal(snapshot.attachments[0].id, ATTACHMENT_ID);
  assert.deepEqual(harness.screenshots.getState().items.map((item) => item.id), [SCREENSHOT_ID]);
  assert.equal(calls[0].imagePaths.length, 1);
  assert.deepEqual(events.map((event) => event.type), [
    "attachment-added",
    "message-added",
    "message-added",
    "message-updated",
    "message-updated",
  ]);
  assert.equal(snapshot.activeMessageId, undefined);
});

test("source does not change command semantics and duplicate request IDs execute once", async () => {
  let providerCalls = 0;
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        providerCalls += 1;
        yield "answer";
      },
    },
  });

  const command = { type: "send", requestId: "same-request", prompt: "Question" };
  const [first, duplicate] = await Promise.all([
    harness.router.execute(command, "desktop"),
    harness.router.execute(command, "phone"),
  ]);
  await harness.analysis.whenIdle();

  assert.equal(providerCalls, 1);
  assert.deepEqual(first, duplicate);
  assert.equal(harness.conversation.snapshot().messages.length, 2);
});

test("phone send uses the desktop prompt normalization and canonical attachment order without clearing the draft queue", async () => {
  const calls = [];
  const harness = await makeHarness({
    queueItems: 2,
    provider: {
      stream: async function* (_path, options) {
        calls.push(options);
        yield "phone answer";
      },
    },
  });

  const result = await harness.router.execute({
    type: "send",
    requestId: "phone-empty-prompt",
    prompt: "   \n\t",
  }, "phone");
  await harness.router.whenIdle();

  assert.match(calls[0].prompt, /Intent: answer/);
  assert.match(calls[0].prompt, /Question: Analyze the attached screenshots\.$/);
  assert.equal(result.conversation.messages[0].text, "Analyze the attached screenshots.");
  assert.deepEqual(result.conversation.messages[0].attachmentIds, [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ]);
  assert.deepEqual(harness.screenshots.getState().items.map((item) => item.id), [
    SCREENSHOT_ID,
    "22222222-2222-4222-8222-222222222221",
  ]);
  assert.deepEqual(harness.conversation.snapshot().messages.map((message) => message.role), ["user", "assistant"]);
});

test("phone clear-conversation and cancel preserve the canonical draft queue", async () => {
  let release;
  const harness = await makeHarness({
    provider: {
      stream: (_path, options) => (async function* () {
        yield "partial";
        await new Promise((resolve) => { release = resolve; });
        if (!options.signal.aborted) yield "late";
      })(),
    },
  });

  await harness.router.execute({ type: "send", requestId: "phone-cancel-send", prompt: "Question" }, "desktop");
  const cancelPromise = harness.router.execute({ type: "cancel", requestId: "phone-cancel" }, "phone");
  while (typeof release !== "function") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  release();
  await cancelPromise;
  await harness.router.whenIdle();
  assert.deepEqual(harness.screenshots.getState().items.map((item) => item.id), [SCREENSHOT_ID]);

  await harness.router.execute({ type: "clear-conversation", requestId: "phone-clear" }, "phone");
  assert.deepEqual(harness.conversation.snapshot().messages, []);
  assert.deepEqual(harness.screenshots.getState().items.map((item) => item.id), [SCREENSHOT_ID]);
});

test("provider failure with zero visible delta produces an error assistant terminal state", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        throw Object.assign(new Error("provider failure"), {
          code: "ANALYSIS_FAILED",
          action: "Retry the request.",
        });
      },
    },
  });
  await harness.router.execute({ type: "send", requestId: "error-1", prompt: "Question" }, "desktop");
  await harness.analysis.whenIdle();

  const snapshot = harness.conversation.snapshot();
  const assistant = snapshot.messages[1];
  assert.equal(assistant.status, "error");
  assert.equal(assistant.text, "");
  assert.deepEqual(assistant.error, { code: "ANALYSIS_FAILED", message: "provider failure" });
  assert.equal(snapshot.activeMessageId, undefined);
});

test("child completion with no visible answer is not reported as a successful completion", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        // A child can close cleanly without yielding a visible answer.
      },
    },
  });
  await harness.router.execute({ type: "send", requestId: "empty-1", prompt: "Question" }, "desktop");
  await harness.analysis.whenIdle();

  const assistant = harness.conversation.snapshot().messages[1];
  assert.equal(assistant.status, "error");
  assert.equal(assistant.text, "");
});

test("cancellation clears the canonical active message while preserving partial text", async () => {
  let release;
  const provider = {
    stream: (_path, options) => (async function* () {
      yield "partial";
      await new Promise((resolve) => { release = resolve; });
      if (!options.signal.aborted) {
        yield "late";
      }
    })(),
  };
  const harness = await makeHarness({ provider });
  await harness.router.execute({ type: "send", requestId: "cancel-send", prompt: "Question" }, "desktop");
  for (let attempt = 0; attempt < 20 && typeof release !== "function"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const cancelPromise = harness.router.execute({ type: "cancel", requestId: "cancel-1" }, "phone");
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = harness.conversation.snapshot().messages[1];
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.text, "partial");
  assert.equal(harness.conversation.snapshot().activeMessageId, undefined);
  release();
  const cancelResult = await cancelPromise;
  assert.equal(cancelResult.conversation.activeMessageId, undefined);
  await harness.analysis.whenIdle();
});

test("cancel waits for the provider to settle before acknowledging and permits a later retry", async () => {
  let release;
  let calls = 0;
  const provider = {
    stream: (_path, options) => (async function* () {
      calls += 1;
      if (calls === 1) {
        yield "partial";
        await new Promise((resolve) => { release = resolve; });
        return;
      }
      yield "retry answer";
    })(),
  };
  const harness = await makeHarness({ provider });
  await harness.router.execute({ type: "send", requestId: "cancel-wait-send", prompt: "Question" }, "desktop");
  for (let attempt = 0; attempt < 20 && typeof release !== "function"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  let cancelSettled = false;
  const cancelPromise = harness.router.execute({ type: "cancel", requestId: "cancel-wait" }, "desktop");
  cancelPromise.then(() => { cancelSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelSettled, false);

  release();
  const cancelled = await cancelPromise;
  assert.equal(cancelled.conversation.messages[1].status, "cancelled");

  const retried = await harness.router.execute({ type: "send", requestId: "cancel-retry", prompt: "Retry" }, "desktop");
  await harness.analysis.whenIdle();
  assert.equal(retried.conversation.messages.at(-1).status, "streaming");
  assert.equal(harness.conversation.snapshot().messages.at(-1).status, "completed");
  assert.equal(harness.conversation.snapshot().messages.at(-1).text, "retry answer");
});

test("clear cancels settled work and removes conversation attachment files without clearing the draft queue", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        yield "answer";
      },
    },
  });
  await harness.router.execute({ type: "send", requestId: "clear-send", prompt: "Question" }, "desktop");
  await harness.analysis.whenIdle();
  const attachmentId = harness.conversation.snapshot().attachments[0].id;
  assert.notEqual(harness.attachments.getPath(attachmentId), undefined);

  const result = await harness.router.execute({ type: "clear-conversation", requestId: "clear-1" }, "desktop");

  assert.deepEqual(result.conversation.messages, []);
  assert.equal(harness.attachments.getPath(attachmentId), undefined);
  assert.deepEqual(harness.screenshots.getState().items.map((item) => item.id), [SCREENSHOT_ID]);
});

test("a conversation clear racing provider completion releases the router for a later retry", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        yield "answer";
      },
    },
  });
  let clearPromise;
  let cleared = false;
  const unsubscribe = harness.conversation.subscribe((event) => {
    if (!cleared && event.type === "message-updated" && event.message.status === "streaming") {
      cleared = true;
      clearPromise = harness.conversation.clear();
    }
  });

  await harness.router.execute({ type: "send", requestId: "race-send", prompt: "Question" }, "desktop");
  await harness.analysis.whenIdle();
  await clearPromise;
  await harness.router.whenIdle();
  unsubscribe();

  const retry = await harness.router.execute({ type: "send", requestId: "race-retry", prompt: "Retry" }, "phone");
  await harness.analysis.whenIdle();

  assert.equal(retry.conversation.activeMessageId !== undefined, true);
  assert.equal(harness.conversation.snapshot().messages.at(-1).status, "completed");
  assert.equal(harness.conversation.snapshot().messages.at(-1).text, "answer");
});

test("real service terminal events remain one canonical error/cancelled/completed transition", async () => {
  const cases = [
    {
      name: "provider error with zero delta",
      provider: {
        stream: async function* () {
          throw new Error("provider unavailable");
        },
      },
      expectedStatus: "error",
      expectedEvent: "message-updated",
      expectedText: "",
    },
    {
      name: "clean no-output exit",
      provider: {
        stream: async function* () {
          // The provider exits without yielding visible text.
        },
      },
      expectedStatus: "error",
      expectedEvent: "message-updated",
      expectedText: "",
    },
    {
      name: "successful fallback text",
      provider: {
        stream: async function* () {
          yield "fallback answer";
        },
      },
      expectedStatus: "completed",
      expectedEvent: "message-updated",
      expectedText: "fallback answer",
    },
  ];

  for (const scenario of cases) {
    const harness = await makeHarness({ provider: scenario.provider });
    const events = [];
    harness.conversation.subscribe((event) => events.push(event));

    await harness.router.execute({ type: "send", requestId: `terminal-${scenario.name}`, prompt: "Question" }, "desktop");
    await harness.router.whenIdle();

    const snapshot = harness.conversation.snapshot();
    const assistant = snapshot.messages.at(-1);
    assert.equal(assistant.status, scenario.expectedStatus, scenario.name);
    assert.equal(assistant.text, scenario.expectedText, scenario.name);
    assert.equal(snapshot.activeMessageId, undefined, scenario.name);
    assert.equal(events.at(-1).type, scenario.expectedEvent, scenario.name);
    assert.equal(
      events.filter((event) => event.type === "message-updated" && ["completed", "error", "cancelled"].includes(event.message.status)).length,
      1,
      scenario.name,
    );
  }
});

test("different request IDs execute workspace commands in fair FIFO order while send materializes", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        yield "answer";
      },
    },
  });
  const materializationStarted = new Promise((resolve) => {
    harness.attachments.addFromScreenshot = async (...args) => {
      resolve();
      await new Promise((release) => { harness.releaseMaterialization = release; });
      return harness.originalAddFromScreenshot(...args);
    };
  });
  harness.originalAddFromScreenshot = AttachmentStore.prototype.addFromScreenshot.bind(harness.attachments);
  const steps = [];
  const originalClear = harness.conversation.clear.bind(harness.conversation);
  harness.conversation.clear = async () => {
    steps.push("clear-conversation");
    return originalClear();
  };
  const originalCancel = harness.analysis.cancel.bind(harness.analysis);
  harness.analysis.cancel = () => {
    steps.push("cancel");
    return originalCancel();
  };

  const sendPromise = harness.router.execute({ type: "send", requestId: "fifo-send", prompt: "Question" }, "desktop");
  await materializationStarted;
  const clearPromise = harness.router.execute({ type: "clear-conversation", requestId: "fifo-clear" }, "phone");
  const cancelPromise = harness.router.execute({ type: "cancel", requestId: "fifo-cancel" }, "phone");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(steps, []);
  harness.releaseMaterialization();
  await Promise.all([sendPromise, clearPromise, cancelPromise]);
  await harness.router.whenIdle();

  assert.equal(steps.includes("clear-conversation"), true);
  assert.equal(steps.indexOf("clear-conversation") > -1, true);
  assert.deepEqual(harness.conversation.snapshot().messages, []);
});

test("send rolls back conversation attachment metadata and files when turn setup fails", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        yield "answer";
      },
    },
  });
  harness.conversation.startTurn("Existing active turn", []);
  const queueBefore = harness.screenshots.getState();

  await assert.rejects(
    harness.router.execute({ type: "send", requestId: "transaction-failure", prompt: "Question" }, "desktop"),
    /conversation turn is already active/i,
  );

  assert.equal(harness.conversation.snapshot().attachments.length, 0);
  assert.equal(harness.attachments.list().length, 0);
  assert.equal(harness.attachments.getPath(ATTACHMENT_ID), undefined);
  assert.deepEqual(harness.screenshots.getState(), queueBefore);
});

test("sync start throws and async start rejects both produce one error terminal and release the active turn", async () => {
  const scenarios = [
    {
      name: "sync throw",
      start() {
        throw Object.assign(new Error("sync provider failure"), { code: "ANALYSIS_FAILED" });
      },
    },
    {
      name: "async reject",
      async start() {
        throw Object.assign(new Error("async provider failure"), { code: "ANALYSIS_FAILED" });
      },
    },
  ];

  for (const scenario of scenarios) {
    const harness = await makeHarness({
      provider: {
        stream: async function* () {
          yield "unreachable";
        },
      },
    });
    const terminalEvents = [];
    harness.conversation.subscribe((event) => {
      if (event.type === "message-updated" && ["completed", "error", "cancelled"].includes(event.message.status)) {
        terminalEvents.push(event);
      }
    });
    harness.analysis.start = scenario.start;

    const result = await harness.router.execute({
      type: "send",
      requestId: `start-failure-${scenario.name}`,
      prompt: "Question",
    }, "desktop");

    assert.equal(result.conversation.messages.at(-1).status, "error", scenario.name);
    assert.equal(result.conversation.activeMessageId, undefined, scenario.name);
    assert.equal(terminalEvents.length, 1, scenario.name);
    await harness.router.whenIdle();
  }
});

test("an async start rejection releases the router for a successful later send", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* () {
        yield "retry answer";
      },
    },
  });
  const originalStart = harness.analysis.start.bind(harness.analysis);
  let starts = 0;
  harness.analysis.start = async (request) => {
    starts += 1;
    if (starts === 1) {
      throw Object.assign(new Error("first async start failed"), { code: "ANALYSIS_FAILED" });
    }
    return originalStart(request);
  };

  const failed = await harness.router.execute({
    type: "send",
    requestId: "async-start-retry-first",
    prompt: "First question",
  }, "desktop");
  assert.equal(failed.conversation.messages.at(-1).status, "error");
  assert.equal(failed.conversation.activeMessageId, undefined);

  await harness.router.execute({
    type: "send",
    requestId: "async-start-retry-second",
    prompt: "Second question",
  }, "phone");
  await harness.router.whenIdle();

  const snapshot = harness.conversation.snapshot();
  assert.equal(starts, 2);
  assert.equal(snapshot.messages.at(-1).status, "completed");
  assert.equal(snapshot.messages.at(-1).text, "retry answer");
  assert.equal(snapshot.activeMessageId, undefined);
});

test("terminal analysis callbacks racing start rejection produce one terminal without unhandled rejection", async () => {
  for (const order of ["terminal-first", "reject-first"]) {
    const harness = await makeHarness({
      provider: {
        stream: async function* () {
          yield "unreachable";
        },
      },
    });
    const terminalEvents = [];
    harness.conversation.subscribe((event) => {
      if (event.type === "message-updated" && ["completed", "error", "cancelled"].includes(event.message.status)) {
        terminalEvents.push(event);
      }
    });
    let rejectStart;
    harness.analysis.start = () => new Promise((_, reject) => {
      rejectStart = reject;
    });
    const unhandledRejections = [];
    const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const sendPromise = harness.router.execute({
        type: "send",
        requestId: `terminal-reject-race-${order}`,
        prompt: "Question",
      }, "desktop");
      while (typeof rejectStart !== "function") {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const startError = Object.assign(new Error(`${order} start failed`), { code: "ANALYSIS_FAILED" });
      if (order === "terminal-first") {
        harness.analysis.emit("error");
        rejectStart(startError);
      } else {
        rejectStart(startError);
        await new Promise((resolve) => setImmediate(resolve));
        harness.analysis.emit("error");
      }

      const result = await sendPromise;
      await harness.router.whenIdle();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(result.conversation.messages.at(-1).status, "error", order);
      assert.equal(harness.conversation.snapshot().activeMessageId, undefined, order);
      assert.equal(terminalEvents.length, 1, order);
      assert.deepEqual(unhandledRejections, [], order);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  }
});

test("phone quiesce cancels an in-flight phone capture and releases queued desktop work", async () => {
  const harness = await makeHarness({
    provider: { stream: async function* () { yield "answer"; } },
  });
  let rejectCapture;
  let captureStarted = false;
  harness.screenshots.capture = () => new Promise((_, reject) => {
    captureStarted = true;
    rejectCapture = reject;
  });
  harness.screenshots.cancelPending = async () => {
    rejectCapture?.(Object.assign(new Error("capture cancelled"), { code: "COMMAND_CANCELLED" }));
  };

  const phoneCapture = harness.router.execute({ type: "capture", requestId: "phone-capture-quiesce" }, "phone");
  while (!captureStarted) await new Promise((resolve) => setImmediate(resolve));
  const desktopClear = harness.router.execute({ type: "clear-queue", requestId: "desktop-clear-after-phone" }, "desktop");

  await harness.router.quiesce("phone");
  await assert.rejects(phoneCapture, (error) => error?.code === "COMMAND_CANCELLED");
  await desktopClear;
  assert.deepEqual(harness.screenshots.getState().items, []);
});

test("phone quiesce cancels phone-owned streaming but preserves desktop-owned streaming", async () => {
  for (const source of ["phone", "desktop"]) {
    const harness = await makeHarness({
      provider: {
        stream: async function* (_path, options) {
          yield "partial";
          await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        },
      },
    });
    await harness.router.execute({ type: "send", requestId: `${source}-stream-quiesce`, prompt: "Question" }, source);
    while (harness.analysis.getState().status !== "running") await new Promise((resolve) => setImmediate(resolve));

    await harness.router.quiesce("phone");
    assert.equal(harness.analysis.getState().status, source === "phone" ? "cancelled" : "running", source);
    if (source === "desktop") {
      await harness.router.quiesce("all");
      assert.equal(harness.analysis.getState().status, "cancelled");
    }
  }
});

test("phone cancel and clear-conversation intentionally cancel shared desktop analysis", async () => {
  const harness = await makeHarness({
    provider: {
      stream: async function* (_path, options) {
        yield "partial";
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
      },
    },
  });

  await harness.router.execute({ type: "send", requestId: "desktop-before-phone-cancel", prompt: "Question" }, "desktop");
  while (harness.analysis.getState().status !== "running") await new Promise((resolve) => setImmediate(resolve));
  await harness.router.execute({ type: "cancel", requestId: "phone-shared-cancel" }, "phone");
  await harness.router.whenIdle();
  assert.equal(harness.conversation.snapshot().messages.at(-1).status, "cancelled");

  await harness.router.execute({ type: "send", requestId: "desktop-before-phone-clear", prompt: "Again" }, "desktop");
  while (harness.analysis.getState().status !== "running") await new Promise((resolve) => setImmediate(resolve));
  await harness.router.execute({ type: "clear-conversation", requestId: "phone-shared-clear" }, "phone");
  await harness.router.whenIdle();
  assert.deepEqual(harness.conversation.snapshot().messages, []);
});

test("quiesce retains timed-out capture ownership and cancels only the requested source", async () => {
  for (const source of ["phone", "desktop"]) {
    const harness = await makeHarness({
      provider: { stream: async function* () { yield "unused"; } },
    });
    let cancelCalls = 0;
    let capturing = true;
    let activeOwner;
    harness.screenshots.capture = async (owner) => {
      activeOwner = owner;
      throw Object.assign(new Error("capture timed out"), { code: "SCREEN_CAPTURE_FAILED" });
    };
    harness.screenshots.getState = () => ({ items: [], capturing, permission: "granted" });
    harness.screenshots.cancelPending = async (owner) => {
      if (owner && owner !== activeOwner) return;
      cancelCalls += 1;
      capturing = false;
    };
    harness.screenshots.whenIdle = async () => undefined;

    await assert.rejects(harness.router.execute({ type: "capture", requestId: `${source}-timed-out-capture` }, source));
    await harness.router.quiesce("phone");
    assert.equal(cancelCalls, source === "phone" ? 1 : 0, source);
    if (source === "desktop") {
      await harness.router.quiesce("all");
      assert.equal(cancelCalls, 1);
    }
  }
});

test("a failed cross-source capture attempt cannot replace the active capture owner", async () => {
  for (const activeOwner of ["desktop", "phone"]) {
    const harness = await makeHarness({
      provider: { stream: async function* () { yield "unused"; } },
    });
    let capturing = false;
    let claimedOwner;
    let cancelCalls = 0;
    harness.screenshots.capture = async (owner) => {
      if (capturing) {
        throw Object.assign(new Error("capture in progress"), { code: "CAPTURE_IN_PROGRESS" });
      }
      capturing = true;
      claimedOwner = owner;
      throw Object.assign(new Error("capture timed out"), { code: "SCREEN_CAPTURE_FAILED" });
    };
    harness.screenshots.getState = () => ({ items: [], capturing, permission: "granted" });
    harness.screenshots.cancelPending = async (owner) => {
      if (owner && owner !== claimedOwner) return;
      cancelCalls += 1;
      capturing = false;
    };
    harness.screenshots.whenIdle = () => new Promise(() => {});

    const failedOwner = activeOwner === "desktop" ? "phone" : "desktop";
    await assert.rejects(
      harness.router.execute({ type: "capture", requestId: `${activeOwner}-owns-capture` }, activeOwner),
      { code: "SCREEN_CAPTURE_FAILED" },
    );
    await assert.rejects(
      harness.router.execute({ type: "capture", requestId: `${failedOwner}-cannot-claim` }, failedOwner),
      { code: "CAPTURE_IN_PROGRESS" },
    );

    await harness.router.quiesce("phone");
    assert.equal(cancelCalls, activeOwner === "phone" ? 1 : 0, activeOwner);
    if (activeOwner === "desktop") {
      assert.equal(capturing, true);
      await harness.router.quiesce("all");
      assert.equal(cancelCalls, 1);
    }
  }
});
