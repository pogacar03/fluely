import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/phone/phone.js");
const workspaceStatePath = path.resolve(__dirname, "../../../dist-electron/src/shared/workspace-state.js");
let phoneClientModule;
let workspaceStateModule;
try {
  phoneClientModule = await import(pathToFileURL(modulePath).href);
  workspaceStateModule = await import(pathToFileURL(workspaceStatePath).href);
} catch {
  phoneClientModule = {};
  workspaceStateModule = {};
}

const CONTEXT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function emptySnapshot() {
  return {
    revision: 0,
    conversation: {
      sessionId: "session-phone",
      revision: 0,
      messages: [],
      attachments: [],
    },
    queue: [],
  };
}

function message(id, sequence, text, status = "completed") {
  return {
    id,
    sequence,
    role: "assistant",
    text,
    attachmentIds: [],
    status,
    createdAt: sequence,
  };
}

function makeFakeTimer() {
  const entries = [];
  return {
    entries,
    setTimeout(callback, delay) {
      const entry = { callback, delay, cleared: false };
      entries.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) entry.cleared = true;
    },
    fire(entry) {
      entry.callback();
    },
    active() {
      return entries.filter((entry) => !entry.cleared);
    },
  };
}

function makeFakeSocketClass() {
  const instances = [];
  class FakeSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, event = {}) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        listener(event);
      }
    }

    open() {
      this.readyState = FakeSocket.OPEN;
      this.emit("open");
    }

    send(value) {
      this.sent.push(value);
    }

    close() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.emit("close");
    }
  }
  return { FakeSocket, instances };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("phone client hydrates canonical snapshots and applies ordered conversation events without optimistic messages", () => {
  assert.equal(typeof phoneClientModule.createPhoneClientState, "function");
  assert.equal(typeof phoneClientModule.applyPhoneServerFrame, "function");
  assert.equal(typeof phoneClientModule.phoneImageUrl, "function");

  const initial = phoneClientModule.createPhoneClientState();
  assert.equal(initial.snapshot, null);
  assert.deepEqual(initial.messages, undefined);

  const first = {
    ...emptySnapshot(),
    queue: [{
      id: CONTEXT_ID,
      capturedAt: 100,
      width: 1920,
      height: 1080,
      mimeType: "image/png",
      previewUrl: `/api/context/${CONTEXT_ID}`,
    }],
  };
  const hydrated = phoneClientModule.applyPhoneServerFrame(initial, {
    type: "snapshot",
    revision: 0,
    payload: first,
  });
  assert.equal(hydrated.effect, null);
  assert.equal(hydrated.state.snapshot.queue[0].previewUrl, `/api/context/${CONTEXT_ID}`);
  assert.deepEqual(hydrated.state.snapshot.conversation.messages, []);

  const firstEvent = phoneClientModule.applyPhoneServerFrame(hydrated.state, {
    type: "event",
    revision: 1,
    payload: {
      type: "message-added",
      revision: 1,
      activeMessageId: "message-1",
      message: message("message-1", 1, "streaming", "streaming"),
    },
  });
  assert.equal(firstEvent.effect, null);
  assert.deepEqual(firstEvent.state.snapshot.conversation.messages.map((item) => item.sequence), [1]);
  assert.equal(firstEvent.state.snapshot.conversation.messages[0].text, "streaming");
});

test("phone client detects a revision gap, requests one fresh snapshot, ignores stale events, and clears the gap after resync", () => {
  assert.equal(typeof phoneClientModule.createPhoneClientState, "function");
  assert.equal(typeof phoneClientModule.applyPhoneServerFrame, "function");
  let state = phoneClientModule.createPhoneClientState();
  state = phoneClientModule.applyPhoneServerFrame(state, {
    type: "snapshot",
    revision: 1,
    payload: {
      ...emptySnapshot(),
      revision: 1,
      conversation: {
        ...emptySnapshot().conversation,
        revision: 1,
        messages: [message("message-1", 1, "old")],
      },
    },
  }).state;

  const gap = phoneClientModule.applyPhoneServerFrame(state, {
    type: "event",
    revision: 3,
    payload: {
      type: "message-updated",
      revision: 3,
      activeMessageId: null,
      message: message("message-1", 1, "stale replacement"),
    },
  });
  assert.deepEqual(gap.effect, { type: "resync", afterRevision: 1 });
  assert.equal(gap.state.resyncPending, true);
  assert.equal(gap.state.snapshot.revision, 1);
  assert.equal(gap.state.snapshot.conversation.messages[0].text, "old");

  const stale = phoneClientModule.applyPhoneServerFrame(gap.state, {
    type: "event",
    revision: 2,
    payload: {
      type: "message-updated",
      revision: 2,
      activeMessageId: null,
      message: message("message-1", 1, "stale event"),
    },
  });
  assert.equal(stale.effect, null);
  assert.equal(stale.state.snapshot.conversation.messages[0].text, "old");

  const fresh = phoneClientModule.applyPhoneServerFrame(gap.state, {
    type: "snapshot",
    revision: 4,
    payload: {
      ...emptySnapshot(),
      revision: 4,
      conversation: {
        ...emptySnapshot().conversation,
        revision: 4,
        messages: [message("message-1", 1, "fresh"), message("message-2", 2, "answer")],
      },
    },
  });
  assert.equal(fresh.effect, null);
  assert.equal(fresh.state.resyncPending, false);
  assert.deepEqual(fresh.state.snapshot.conversation.messages.map((item) => item.text), ["fresh", "answer"]);
});

test("phone client exposes bounded reconnect backoff and separate authenticated media namespaces", () => {
  assert.equal(typeof phoneClientModule.reconnectDelayMs, "function");
  assert.deepEqual([0, 1, 2, 3, 4, 20].map((attempt) => phoneClientModule.reconnectDelayMs(attempt)), [250, 500, 1000, 2000, 4000, 8000]);
  assert.equal(phoneClientModule.phoneImageUrl("context", CONTEXT_ID), `/api/context/${CONTEXT_ID}`);
  assert.equal(phoneClientModule.phoneImageUrl("attachments", ATTACHMENT_ID), `/api/attachments/${ATTACHMENT_ID}`);
  assert.equal(phoneClientModule.phoneImageUrl("context", CONTEXT_ID).includes("fluely-media"), false);
  assert.equal(phoneClientModule.phoneImageUrl("attachments", ATTACHMENT_ID).includes("/Users/"), false);
});

test("phone client probes same-origin authentication before reconnecting and stops permanently on a revoked cookie", async () => {
  assert.equal(typeof phoneClientModule.startPhoneClient, "function");
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  const fetchCalls = [];
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async (input, init) => {
      fetchCalls.push({ input, init });
      return { status: 401, ok: false };
    },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    assert.equal(instances.length, 1);
    instances[0].open();
    assert.equal(client.getState().connection, "connected");
    instances[0].close();
    assert.equal(timer.active().length, 1);
    assert.equal(timer.active()[0].delay, 250);

    timer.fire(timer.active()[0]);
    await flushMicrotasks();

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, "/");
    assert.equal(fetchCalls[0].init.credentials, "same-origin");
    assert.equal(fetchCalls[0].init.cache, "no-store");
    assert.deepEqual(fetchCalls[0].init.headers, { Accept: "text/html" });
    assert.equal(fetchCalls[0].init.signal instanceof AbortSignal, true);
    assert.equal(client.getState().connection, "revoked");
    assert.equal(instances.length, 1);
    assert.equal(timer.active().length, 0);
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("phone client continues bounded reconnect after network probe errors and can restart after authentication is restored", async () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  let probeCount = 0;
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async () => {
      probeCount += 1;
      if (probeCount === 1) throw new Error("network unavailable");
      return { status: 200, ok: true };
    },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    instances[0].close();
    const firstTimer = timer.active()[0];
    timer.fire(firstTimer);
    await flushMicrotasks();
    assert.equal(client.getState().connection, "error");
    assert.equal(instances.length, 1);
    assert.equal(timer.active().length, 1);
    assert.equal(timer.active()[0].delay, 500);

    const secondTimer = timer.active()[0];
    timer.fire(secondTimer);
    await flushMicrotasks();
    assert.equal(instances.length, 2);
    assert.equal(client.getState().connection, "connecting");

    instances[1].open();
    assert.equal(client.getState().connection, "connected");
    instances[1].close();
    assert.equal(timer.active().length, 1);
    client.restart();
    await flushMicrotasks();
    assert.equal(instances.length, 3);
    instances[2].open();
    assert.equal(client.getState().connection, "connected");
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("phone client treats a forbidden authentication probe as a permanent revocation", async () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async () => ({ status: 403, ok: false }),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    instances[0].close();
    timer.fire(timer.active()[0]);
    await flushMicrotasks();
    assert.equal(client.getState().connection, "revoked");
    assert.equal(instances.length, 1);
    assert.equal(timer.active().length, 0);
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("phone client treats non-2xx non-revocation probe responses as transient and never opens WebSocket", async () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async () => ({ status: 503, ok: false }),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    instances[0].close();
    timer.fire(timer.active()[0]);
    await flushMicrotasks();
    assert.equal(instances.length, 1);
    assert.equal(client.getState().connection, "error");
    assert.deepEqual(timer.active().map((entry) => entry.delay), [500]);
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("phone client aborts a pending authentication probe and continues bounded backoff", async () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  let probeSignal;
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async (_input, init) => {
      probeSignal = init.signal;
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true });
        void resolve;
      });
      return { status: 200, ok: true };
    },
    fetchTimeoutMs: 1_000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    instances[0].close();
    timer.fire(timer.active()[0]);
    await flushMicrotasks();
    assert.equal(probeSignal instanceof AbortSignal, true);
    const timeoutEntry = timer.active().find((entry) => entry.delay === 1_000);
    assert.ok(timeoutEntry);
    timer.fire(timeoutEntry);
    await flushMicrotasks();
    assert.equal(client.getState().connection, "error");
    assert.deepEqual(timer.active().map((entry) => entry.delay), [500]);
    assert.equal(instances.length, 1);
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("phone client keeps SESSION_REVOKED locked through websocket error and close until an explicit restart", () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async () => ({ status: 200, ok: true }),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    assert.equal(client.sendCommand({ type: "capture" }), true);
    assert.ok(client.getState().commandPending);
    instances[0].emit("message", {
      data: JSON.stringify({ type: "error", code: "SESSION_REVOKED", message: "Pairing revoked." }),
    });
    assert.equal(client.getState().connection, "revoked");
    assert.equal(client.getState().commandPending, undefined);
    instances[0].emit("error");
    assert.equal(client.getState().connection, "revoked");
    instances[0].close();
    assert.equal(client.getState().connection, "revoked");
    assert.equal(timer.active().length, 0);

    client.restart();
    assert.equal(instances.length, 2);
    assert.equal(client.getState().connection, "connecting");
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

function controlSnapshot({ queued = true, running = false, capturing = false } = {}) {
  const assistant = {
    id: "assistant-1",
    sequence: 2,
    role: "assistant",
    text: running ? "partial" : "answer",
    attachmentIds: [],
    status: running ? "streaming" : "completed",
    createdAt: 2,
  };
  return {
    revision: 0,
    capturing,
    conversation: {
      sessionId: "session-phone-controls",
      revision: 0,
      messages: running ? [
        {
          id: "user-1",
          sequence: 1,
          role: "user",
          text: "Question",
          attachmentIds: [],
          status: "completed",
          createdAt: 1,
        },
        assistant,
      ] : [],
      attachments: [],
      ...(running ? { activeMessageId: assistant.id } : {}),
    },
    queue: queued ? [{
      id: CONTEXT_ID,
      capturedAt: 100,
      width: 1920,
      height: 1080,
      mimeType: "image/png",
      previewUrl: `/api/context/${CONTEXT_ID}`,
    }] : [],
  };
}

test("phone and desktop share canonical busy inputs and the same localPending contract", () => {
  for (const snapshot of [
    controlSnapshot({ capturing: true }),
    controlSnapshot({ running: true }),
    controlSnapshot({ capturing: false, running: false }),
  ]) {
    const shared = workspaceStateModule.getCanonicalWorkspaceBusyState({
      capturing: snapshot.capturing,
      conversation: snapshot.conversation,
      localPending: false,
    });
    const phone = phoneClientModule.getPhoneActionState({
      connection: "connected",
      snapshot,
    });
    assert.equal(phone.isBusy, shared.isBusy);
  }

  const snapshot = controlSnapshot({ capturing: false, running: false });
  const sharedLocalPending = workspaceStateModule.getCanonicalWorkspaceBusyState({
    capturing: snapshot.capturing,
    conversation: snapshot.conversation,
    localPending: true,
  });
  const phoneLocalPending = phoneClientModule.getPhoneActionState({
    connection: "connected",
    snapshot,
    commandPending: { requestId: "phone-local-pending", type: "capture" },
  });
  assert.equal(sharedLocalPending.isBusy, true);
  assert.equal(phoneLocalPending.isBusy, sharedLocalPending.isBusy);
});

test("phone DOM controls send every workspace command, mirror canonical busy state, and keep ack state out of the conversation", () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async () => ({ status: 200, ok: true }),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    instances[0].emit("message", { data: JSON.stringify({ type: "snapshot", revision: 0, payload: controlSnapshot() }) });
    const root = dom.window.document.getElementById("phone-app");
    const getButton = (name) => [...root.querySelectorAll("button")].find((button) => button.textContent.includes(name) || button.getAttribute("aria-label")?.includes(name));
    const getCommand = () => JSON.parse(instances[0].sent.at(-1));
    const acknowledge = () => {
      const command = getCommand().command;
      instances[0].emit("message", {
        data: JSON.stringify({ type: "ack", requestId: command.requestId }),
      });
    };

    for (const label of ["Capture", "Send images", "Capture & ask", "Remove", "Clear queue", "Clear conversation", "Cancel"]) {
      assert.ok(getButton(label), label);
    }
    assert.equal(getButton("Send images").disabled, false);
    assert.equal(getButton("Capture").disabled, false);
    assert.equal(getButton("Cancel").disabled, true);
    assert.equal(root.querySelector("fieldset").getAttribute("aria-busy"), "false");

    getButton("Capture").click();
    assert.equal(getCommand().type, "command");
    assert.equal(getCommand().command.type, "capture");
    assert.equal(getButton("Capture").disabled, true);
    assert.equal(root.querySelector("fieldset").getAttribute("aria-busy"), "true");
    const queueBeforeAck = client.getState().snapshot.queue;
    getButton("Capture").click();
    assert.equal(instances[0].sent.length, 1);
    acknowledge();
    assert.deepEqual(client.getState().snapshot.queue, queueBeforeAck);
    assert.match(root.textContent, /Command completed/);
    assert.equal(root.querySelector("fieldset").getAttribute("aria-busy"), "false");

    const prompt = root.querySelector("textarea");
    prompt.value = "Question from phone";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    getButton("Send images").click();
    assert.deepEqual(getCommand().command.type, "send");
    assert.equal(getCommand().command.prompt, "Question from phone");
    acknowledge();

    getButton("Capture & ask").click();
    assert.deepEqual(getCommand().command.type, "capture-and-send");
    acknowledge();

    getButton("Remove").click();
    assert.deepEqual(getCommand().command.type, "remove");
    assert.equal(getCommand().command.screenshotId, CONTEXT_ID);
    acknowledge();

    getButton("Clear queue").click();
    assert.deepEqual(getCommand().command.type, "clear-queue");
    acknowledge();

    getButton("Clear conversation").click();
    assert.deepEqual(getCommand().command.type, "clear-conversation");
    acknowledge();

    instances[0].emit("message", { data: JSON.stringify({ type: "snapshot", revision: 1, payload: controlSnapshot({ running: true }) }) });
    assert.equal(getButton("Cancel").disabled, false);
    assert.equal(getButton("Capture").disabled, true);
    assert.equal(getButton("Send images").disabled, true);
    assert.equal(getButton("Clear conversation").disabled, true);
    assert.equal(root.querySelector("fieldset").getAttribute("aria-busy"), "true");
    getButton("Cancel").click();
    assert.deepEqual(getCommand().command.type, "cancel");
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("phone command errors clear only command loading and never invent messages or queue entries", () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async () => ({ status: 200, ok: true }),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    instances[0].emit("message", { data: JSON.stringify({ type: "snapshot", revision: 0, payload: controlSnapshot() }) });
    const root = dom.window.document.getElementById("phone-app");
    const capture = [...root.querySelectorAll("button")].find((button) => button.textContent.includes("Capture"));
    capture.click();
    const command = JSON.parse(instances[0].sent.at(-1)).command;
    instances[0].emit("message", { data: JSON.stringify({
      type: "error",
      requestId: command.requestId,
      code: "SCREEN_CAPTURE_FAILED",
      message: "Capture failed.",
    }) });
    assert.equal(client.getState().commandPending, undefined);
    assert.equal(client.getState().snapshot.queue.length, 1);
    assert.equal(client.getState().snapshot.conversation.messages.length, 0);
    assert.match(root.textContent, /Capture failed/);
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("phone controls use canonical capturing state for busy and aria-busy without local optimistic state", () => {
  const dom = new JSDOM("<div id=\"phone-app\"></div>", { url: "http://phone.test/" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  const client = phoneClientModule.startPhoneClient(dom.window.document.getElementById("phone-app"), {
    WebSocket: FakeSocket,
    fetch: async () => ({ status: 200, ok: true }),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    location: { protocol: "http:", host: "phone.test" },
  });

  try {
    instances[0].open();
    instances[0].emit("message", { data: JSON.stringify({
      type: "snapshot",
      revision: 0,
      payload: controlSnapshot({ capturing: true }),
    }) });
    const root = dom.window.document.getElementById("phone-app");
    const capture = [...root.querySelectorAll("button")].find((button) => button.textContent.includes("Capture"));
    const clearConversation = [...root.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Clear conversation"));
    assert.equal(phoneClientModule.getPhoneActionState(client.getState()).isBusy, true);
    assert.equal(client.getState().commandPending, undefined);
    assert.equal(capture.disabled, true);
    assert.equal(clearConversation.disabled, true);
    assert.equal(root.querySelector("fieldset").getAttribute("aria-busy"), "true");

    instances[0].emit("message", { data: JSON.stringify({
      type: "snapshot",
      revision: 1,
      payload: { ...controlSnapshot({ capturing: false }), revision: 1 },
    }) });
    const restoredCapture = [...root.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Capture"));
    const restoredClearConversation = [...root.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Clear conversation"));
    assert.equal(phoneClientModule.getPhoneActionState(client.getState()).isBusy, false);
    assert.equal(restoredCapture.disabled, false);
    assert.equal(restoredClearConversation.disabled, false);
    assert.equal(root.querySelector("fieldset").getAttribute("aria-busy"), "false");
  } finally {
    client.stop();
    globalThis.document = previousDocument;
    dom.window.close();
  }
});
