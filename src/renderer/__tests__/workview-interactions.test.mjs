import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(__dirname, "../../../dist-electron/src/renderer/App.js");
const bridgePath = path.resolve(__dirname, "../../../dist-electron/electron/preloadBridge.js");
const handlersPath = path.resolve(__dirname, "../../../dist-electron/electron/services/ipcHandlers.js");
const settingsPath = path.resolve(__dirname, "../../../dist-electron/electron/services/settings-core.js");

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "https://fluely.test/",
});
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { App } = await import(pathToFileURL(appPath).href);
const { exposeFluelyApi } = await import(pathToFileURL(bridgePath).href);
const { registerIpcHandlers } = await import(pathToFileURL(handlersPath).href);
const { DEFAULT_SETTINGS } = await import(pathToFileURL(settingsPath).href);

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const CAPTURE_IDS = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const roots = [];

function screenshot(id, capturedAt) {
  return {
    id,
    capturedAt,
    width: 1920,
    height: 1080,
    mimeType: "image/png",
    previewUrl: `fluely-media://context/${id}`,
  };
}

function analysisState(status = "idle", screenshotIds = []) {
  return {
    status,
    text: "",
    model: "gpt-test",
    screenshotIds: [...screenshotIds],
    startedAt: status === "running" ? "2026-08-31T00:00:00.000Z" : null,
    updatedAt: "2026-08-31T00:00:00.000Z",
    completedAt: null,
  };
}

function createBackend({
  initialAnalysisStatus = "idle",
  failedAsks = 0,
  holdCapture = false,
  initialQueue = [screenshot(FIRST_ID, 1), screenshot(SECOND_ID, 2)],
  conversationSnapshot,
  conversationUnavailableUntilCommand = false,
} = {}) {
  const registrations = new Map();
  const calls = [];
  const analysisRequests = [];
  const workspaceCommands = [];
  let queue = initialQueue.map((item) => ({ ...item }));
  let currentAnalysis = analysisState(initialAnalysisStatus, initialAnalysisStatus === "running" ? [FIRST_ID] : []);
  let captureCount = 0;
  let remainingFailedAsks = failedAsks;
  let conversationAvailable = !conversationUnavailableUntilCommand;
  let conversationEventListener;
  let releaseCapture = () => undefined;
  const captureGate = holdCapture
    ? new Promise((resolve) => { releaseCapture = resolve; })
    : Promise.resolve();
  const settings = {
    ...DEFAULT_SETTINGS,
    setupComplete: true,
    codex: { ...DEFAULT_SETTINGS.codex },
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
    window: { ...DEFAULT_SETTINGS.window },
    privacy: { ...DEFAULT_SETTINGS.privacy },
  };
  const canonicalConversation = conversationSnapshot ?? {
    sessionId: "session-renderer",
    revision: 0,
    messages: [],
    attachments: [],
  };

  const screenshots = {
    getState: () => ({
      items: queue.map((item) => ({ ...item })),
      capturing: false,
      permission: "granted",
    }),
    capture: async () => {
      calls.push("capture");
      await captureGate;
      const item = screenshot(CAPTURE_IDS[captureCount], 3 + captureCount);
      captureCount += 1;
      queue = [...queue, item].slice(-5);
      return item;
    },
    delete: async (id) => {
      queue = queue.filter((item) => item.id !== id);
      return screenshots.getState();
    },
    clear: async () => {
      queue = [];
      return screenshots.getState();
    },
  };
  const analysis = {
    start: async (request) => {
      calls.push("ask");
      analysisRequests.push({ ...request, screenshotIds: [...request.screenshotIds] });
      if (remainingFailedAsks > 0) {
        remainingFailedAsks -= 1;
        throw {
          code: "ANALYSIS_FAILED",
          message: "Deterministic provider failure.",
          action: "Retry the request.",
        };
      }
      currentAnalysis = analysisState("running", request.screenshotIds);
      return currentAnalysis;
    },
    cancel: async () => {
      calls.push("cancel");
      currentAnalysis = analysisState("cancelled", currentAnalysis.screenshotIds);
      return currentAnalysis;
    },
    getState: () => ({ ...currentAnalysis, screenshotIds: [...currentAnalysis.screenshotIds] }),
    onStateChanged: () => () => undefined,
  };

  const workspace = {
    execute: async (command) => {
      conversationAvailable = true;
      switch (command.type) {
        case "capture":
          await screenshots.capture();
          return {
            queue: screenshots.getState(),
            conversation: structuredClone(canonicalConversation),
          };
        case "remove":
          return {
            queue: await screenshots.delete(command.screenshotId),
            conversation: structuredClone(canonicalConversation),
          };
        case "clear-queue":
          return {
            queue: await screenshots.clear(),
            conversation: structuredClone(canonicalConversation),
          };
        case "clear-conversation":
          return {
            queue: screenshots.getState(),
            conversation: structuredClone(canonicalConversation),
          };
        case "cancel":
          return {
            queue: screenshots.getState(),
            conversation: structuredClone(canonicalConversation),
            analysis: await analysis.cancel(),
          };
        case "ask": {
          const queueSnapshot = screenshots.getState();
          const state = await analysis.start({
            prompt: command.prompt?.trim() || "Analyze the attached screenshots.",
            screenshotIds: queueSnapshot.items.map((item) => item.id),
            intent: "answer",
            fast: false,
          });
          return {
            queue: await screenshots.clear(),
            conversation: structuredClone(canonicalConversation),
            analysis: state,
          };
        }
      }
    },
  };

  registerIpcHandlers({
    ipcMain: { handle: (channel, handler) => registrations.set(channel, handler) },
    settings: {
      get: () => settings,
      update: async () => ({ ok: true, value: settings }),
      reset: async () => ({ ok: true, value: settings }),
    },
    shortcuts: {
      getStatus: () => ({ entries: [], updatedAt: "2026-08-31T00:00:00.000Z" }),
      update: () => ({ ok: true, value: { entries: [], updatedAt: "2026-08-31T00:00:00.000Z" } }),
    },
    screenshots,
    analysis,
    workspace,
    conversation: {
      snapshot: () => structuredClone(canonicalConversation),
      subscribe: () => () => undefined,
    },
    codex: {
      getStatus: () => ({ available: true, configuredPath: "codex" }),
      validate: () => ({ available: true, configuredPath: "codex" }),
    },
    window: {
      setOpacity: () => undefined,
      hide: () => undefined,
    },
    phoneGateway: {
      getStatus: () => ({ state: "disabled" }),
      enable: async () => ({ ok: true, value: { state: "disabled" } }),
      disable: async () => ({ ok: true, value: { state: "disabled" } }),
      regeneratePairing: async () => ({ ok: true, value: { state: "disabled" } }),
    },
    getAppStatus: () => ({ name: "Fluely", version: "0.1.0", platform: "linux", visible: true }),
  });

  exposeFluelyApi({
    exposeInMainWorld(name, api) {
      dom.window[name] = api;
    },
  }, {
    async invoke(channel, ...args) {
      const handler = registrations.get(channel);
      if (!handler) {
        throw new Error(`Missing IPC handler: ${channel}`);
      }
      if (channel === "workspace:execute") {
        workspaceCommands.push(structuredClone(args[0]));
      }
      return handler({}, args[0]);
    },
    on: (channel, listener) => {
      if (channel === "conversation:event") {
        conversationEventListener = listener;
      }
    },
    removeListener: (channel, listener) => {
      if (channel === "conversation:event" && conversationEventListener === listener) {
        conversationEventListener = undefined;
      }
    },
  });

  registrations.set("conversation:get-snapshot", async () => conversationAvailable
    ? { ok: true, value: structuredClone(canonicalConversation) }
    : {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Conversation is temporarily unavailable.",
        action: "Retry the workspace action.",
      },
    });

  return {
    calls,
    analysisRequests,
    workspaceCommands,
    getQueue: () => screenshots.getState().items,
    releaseCapture,
    emitConversationEvent: (event) => conversationEventListener?.({}, event),
  };
}

async function flushRenderer() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

async function renderApp(backend) {
  document.body.innerHTML = "<div id=\"root\"></div>";
  const root = createRoot(document.getElementById("root"));
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(App));
  });
  for (let attempt = 0; attempt < 10 && !findButton("Capture") && !findButton("Capture screenshot without sending"); attempt += 1) {
    await flushRenderer();
  }
  assert.ok(findButton("Capture") || findButton("Capture screenshot without sending"), "WorkView did not mount");
  return backend;
}

function findButton(label) {
  return [...document.querySelectorAll("button")]
    .find((button) => button.getAttribute("aria-label") === label);
}

function queueCountText() {
  return document.querySelector(".queue-count")?.textContent;
}

async function clickAndSettle(label) {
  const button = findButton(label);
  assert.ok(button, `Missing button: ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

async function setPrompt(value) {
  const input = document.querySelector(".composer-input");
  assert.ok(input, "Missing desktop prompt input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

function promptValue() {
  return document.querySelector(".composer-input")?.value;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "<div id=\"root\"></div>";
});

test("the actual Capture control appends context without invoking analysis", async () => {
  const backend = await renderApp(createBackend());

  await clickAndSettle("Capture");

  assert.deepEqual(backend.calls, ["capture"]);
  assert.deepEqual(backend.analysisRequests, []);
  assert.equal(queueCountText(), "3/5");
});

test("the desktop Ask control sends pure text without capturing and clears the prompt", async () => {
  const backend = await renderApp(createBackend({ initialQueue: [] }));

  await setPrompt("What is on screen?");
  await clickAndSettle("Ask Fluely");

  assert.deepEqual(backend.calls, ["ask"]);
  assert.deepEqual(backend.analysisRequests, [{
    prompt: "What is on screen?",
    screenshotIds: [],
    intent: "answer",
    fast: false,
  }]);
  assert.equal(queueCountText(), "0/5");
  assert.equal(promptValue(), "");
});

test("the desktop Ask control sends pure screenshots without capturing and clears the shared queue", async () => {
  const backend = await renderApp(createBackend());

  await clickAndSettle("Ask Fluely");

  assert.deepEqual(backend.calls, ["ask"]);
  assert.deepEqual(backend.analysisRequests, [{
    prompt: "Analyze the attached screenshots.",
    screenshotIds: [FIRST_ID, SECOND_ID],
    intent: "answer",
    fast: false,
  }]);
  assert.equal(queueCountText(), "0/5");
});

test("the desktop Ask control sends the current prompt with the shared screenshot queue", async () => {
  const backend = await renderApp(createBackend());

  await setPrompt("Compare these screenshots");
  await clickAndSettle("Ask Fluely");

  assert.deepEqual(backend.calls, ["ask"]);
  assert.deepEqual(backend.analysisRequests[0], {
    prompt: "Compare these screenshots",
    screenshotIds: [FIRST_ID, SECOND_ID],
    intent: "answer",
    fast: false,
  });
  assert.equal(queueCountText(), "0/5");
  assert.equal(promptValue(), "");
});

test("the desktop Ask control is disabled when both prompt and queue are empty", async () => {
  await renderApp(createBackend({ initialQueue: [] }));

  assert.equal(findButton("Ask Fluely").disabled, true);
  assert.match(document.querySelector(".composer-tip")?.textContent ?? "", /enter a question or capture a screen/i);
});

test("the desktop Work view exposes only Capture and Ask as its primary actions", async () => {
  await renderApp(createBackend());

  assert.ok(findButton("Capture"));
  assert.ok(findButton("Ask Fluely"));
  assert.equal(findButton("Send all queued screenshots"), undefined);
  assert.equal(findButton("Capture screenshot and ask"), undefined);
  assert.doesNotMatch(document.body.textContent ?? "", /Send images|Capture & ask/);
});

test("loading disables the actual controls and prevents duplicate Capture clicks", async () => {
  const backend = await renderApp(createBackend({ holdCapture: true }));
  const captureButton = findButton("Capture");

  await act(async () => {
    captureButton.click();
    await Promise.resolve();
  });
  assert.equal(findButton("Capture").disabled, true);
  assert.equal(document.querySelector(".composer-actions")?.getAttribute("aria-busy"), "true");

  findButton("Capture").click();
  assert.deepEqual(backend.calls, ["capture"]);

  await act(async () => {
    backend.releaseCapture();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(queueCountText(), "3/5");
});

test("the actual Cancel control routes through the shared workspace command", async () => {
  const backend = await renderApp(createBackend({ initialAnalysisStatus: "running" }));

  await clickAndSettle("Cancel analysis");

  assert.deepEqual(backend.calls, ["cancel"]);
  assert.equal(backend.workspaceCommands[0].type, "cancel");
  assert.equal(queueCountText(), "2/5");
});

test("a failed Ask retains the queue and the current prompt", async () => {
  const backend = await renderApp(createBackend({ failedAsks: 1 }));

  await setPrompt("Retry this question");
  await clickAndSettle("Ask Fluely");
  assert.equal(queueCountText(), "2/5");
  assert.match(document.querySelector("[role=status]")?.textContent ?? "", /could not complete the analysis request/i);
  assert.equal(findButton("Ask Fluely").disabled, false);
  assert.equal(promptValue(), "Retry this question");
  assert.deepEqual(backend.getQueue().map((item) => item.id), [FIRST_ID, SECOND_ID]);
  assert.equal(queueCountText(), "2/5");
});

test("a streaming canonical conversation makes the desktop composer aria-busy and disables actions", async () => {
  await renderApp(createBackend({
    initialAnalysisStatus: "idle",
    conversationSnapshot: {
      sessionId: "session-renderer-streaming",
      revision: 1,
      messages: [{
        id: "message-assistant-streaming",
        sequence: 1,
        role: "assistant",
        text: "Streaming",
        attachmentIds: [],
        status: "streaming",
        createdAt: 100,
      }],
      attachments: [],
      activeMessageId: "message-assistant-streaming",
    },
  }));

  assert.equal(document.querySelector(".composer-actions")?.getAttribute("aria-busy"), "true");
  assert.equal(findButton("Capture").disabled, true);
  assert.equal(findButton("Ask Fluely").disabled, true);
});

test("the actual Work view renders the canonical conversation snapshot and opaque attachment thumbnail", async () => {
  const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await renderApp(createBackend({
    conversationSnapshot: {
      sessionId: "session-renderer",
      revision: 4,
      messages: [
        {
          id: "message-user",
          sequence: 1,
          role: "user",
          text: "What is shown?",
          attachmentIds: [attachmentId],
          status: "completed",
          createdAt: 100,
          finishedAt: 100,
        },
        {
          id: "message-assistant",
          sequence: 2,
          role: "assistant",
          text: "The answer is streaming.",
          attachmentIds: [],
          status: "streaming",
          createdAt: 100,
        },
      ],
      attachments: [{
        id: attachmentId,
        mimeType: "image/png",
        width: 1920,
        height: 1080,
        byteLength: 16,
        createdAt: 100,
      }],
      activeMessageId: "message-assistant",
    },
  }));

  assert.match(document.body.textContent ?? "", /What is shown\?/);
  assert.match(document.body.textContent ?? "", /The answer is streaming\./);
  const thumbnail = document.querySelector('img[src="fluely-media://attachment/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]');
  assert.ok(thumbnail);
  assert.equal(document.body.textContent?.includes("/Users/"), false);
});

test("a workspace fallback promotes failed conversation hydration before applying later events", async () => {
  const backend = await renderApp(createBackend({ conversationUnavailableUntilCommand: true }));

  await clickAndSettle("Capture");
  backend.emitConversationEvent({
    type: "message-added",
    revision: 1,
    activeMessageId: null,
    message: {
      id: "recovered-message",
      sequence: 1,
      role: "user",
      text: "Recovered conversation event",
      attachmentIds: [],
      status: "completed",
      createdAt: 1,
      finishedAt: 1,
    },
  });
  await flushRenderer();

  assert.match(document.body.textContent ?? "", /Recovered conversation event/);
});
