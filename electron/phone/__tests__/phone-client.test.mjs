import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/phone/phone.js");
let phoneClientModule;
try {
  phoneClientModule = await import(pathToFileURL(modulePath).href);
} catch {
  phoneClientModule = {};
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

    assert.deepEqual(fetchCalls, [{
      input: "/",
      init: {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "text/html" },
      },
    }]);
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
