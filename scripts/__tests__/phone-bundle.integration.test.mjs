import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, "../..", "dist-phone/phone.js");
const CONTEXT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

    send() {}

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

async function waitForCondition(condition, description, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function loadPhoneBundle({ fetchImpl }) {
  const bundle = await readFile(bundlePath, "utf8");
  const dom = new JSDOM("<div id=\"phone-app\"></div>", {
    url: "http://phone.test/",
    runScripts: "outside-only",
  });
  const timer = makeFakeTimer();
  const { FakeSocket, instances } = makeFakeSocketClass();
  Object.defineProperty(dom.window, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
  Object.defineProperty(dom.window, "fetch", {
    configurable: true,
    value: fetchImpl,
  });
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value: timer.setTimeout,
  });
  Object.defineProperty(dom.window, "clearTimeout", {
    configurable: true,
    value: timer.clearTimeout,
  });
  dom.window.eval(bundle);
  await flushMicrotasks();
  return { dom, timer, instances };
}

function snapshotWithUntrustedText(text) {
  return {
    type: "snapshot",
    revision: 1,
    payload: {
      revision: 1,
      conversation: {
        sessionId: "session-bundle",
        revision: 1,
        messages: [{
          id: "message-1",
          sequence: 1,
          role: "user",
          text,
          attachmentIds: [ATTACHMENT_ID],
          status: "completed",
          createdAt: 1,
        }],
        attachments: [{
          id: ATTACHMENT_ID,
          mimeType: "image/png",
          width: 1920,
          height: 1080,
          byteLength: 11,
          createdAt: 1,
        }],
      },
      queue: [{
        id: CONTEXT_ID,
        capturedAt: 1,
        width: 1920,
        height: 1080,
        mimeType: "image/png",
        previewUrl: "/api/context/" + CONTEXT_ID,
      }],
    },
  };
}

test("built phone bundle renders untrusted projection text as text and keeps media URLs in opaque namespaces", async () => {
  const maliciousText = "<img src=x onerror=window.pwned=1><script>window.pwned=2</script>";
  const { dom, instances } = await loadPhoneBundle({
    fetchImpl: async () => ({ status: 200, ok: true }),
  });
  try {
    assert.equal(instances.length, 1);
    instances[0].open();
    instances[0].emit("message", { data: JSON.stringify(snapshotWithUntrustedText(maliciousText)) });

    const root = dom.window.document.getElementById("phone-app");
    assert.equal(root.querySelector("script"), null);
    assert.equal(root.querySelector("[onerror]"), null);
    assert.equal(root.textContent.includes(maliciousText), true);
    assert.deepEqual(
      [...root.querySelectorAll("img")].map((image) => image.getAttribute("src")),
      ["/api/context/" + CONTEXT_ID, "/api/attachments/" + ATTACHMENT_ID],
    );
    assert.equal(dom.window.pwned, undefined);
  } finally {
    instances[0]?.close();
    dom.window.close();
  }
});

test("built phone bundle renders the initial canonical snapshot and applies an incremental event in the DOM", async () => {
  const { dom, instances } = await loadPhoneBundle({
    fetchImpl: async () => ({ status: 200, ok: true }),
  });
  try {
    instances[0].open();
    instances[0].emit("message", { data: JSON.stringify(snapshotWithUntrustedText("initial user text")) });
    const root = dom.window.document.getElementById("phone-app");
    assert.equal(root.querySelectorAll(".phone-message").length, 1);
    assert.equal(root.querySelector(".phone-message-text")?.textContent, "initial user text");
    assert.equal(root.querySelector("img[src^=\"/api/context/\"]")?.getAttribute("src"), "/api/context/" + CONTEXT_ID);
    assert.equal(root.querySelector("img[src^=\"/api/attachments/\"]")?.getAttribute("src"), "/api/attachments/" + ATTACHMENT_ID);

    instances[0].emit("message", {
      data: JSON.stringify({
        type: "event",
        revision: 2,
        payload: {
          type: "message-updated",
          revision: 2,
          activeMessageId: null,
          message: {
            id: "message-1",
            sequence: 1,
            role: "user",
            text: "incremental user text",
            attachmentIds: [ATTACHMENT_ID],
            status: "completed",
            createdAt: 1,
          },
        },
      }),
    });
    assert.equal(root.querySelector(".phone-message-text")?.textContent, "incremental user text");
  } finally {
    instances[0]?.close();
    dom.window.close();
  }
});

test("built phone bundle clears and resets rendered conversation on the canonical cleared event", async () => {
  const { dom, instances } = await loadPhoneBundle({
    fetchImpl: async () => ({ status: 200, ok: true }),
  });
  try {
    instances[0].open();
    instances[0].emit("message", { data: JSON.stringify(snapshotWithUntrustedText("remove me")) });
    const root = dom.window.document.getElementById("phone-app");
    assert.equal(root.querySelectorAll(".phone-message").length, 1);

    instances[0].emit("message", {
      data: JSON.stringify({
        type: "event",
        revision: 2,
        payload: {
          type: "cleared",
          revision: 2,
          activeMessageId: null,
          snapshot: {
            sessionId: "session-bundle",
            revision: 2,
            messages: [],
            attachments: [],
          },
        },
      }),
    });
    assert.equal(root.querySelectorAll(".phone-message").length, 0);
    assert.equal(root.textContent.includes("Sent screenshots and answers will appear here."), true);
  } finally {
    instances[0]?.close();
    dom.window.close();
  }
});

test("built phone bundle marks a revoked cookie and does not open another socket after a 401 probe", async () => {
  const fetchCalls = [];
  const { dom, timer, instances } = await loadPhoneBundle({
    fetchImpl: async (input, init) => {
      fetchCalls.push({ input, init });
      return { status: 401, ok: false };
    },
  });
  try {
    instances[0].open();
    instances[0].close();
    assert.equal(timer.active().length, 1);
    timer.fire(timer.active()[0]);

    const root = dom.window.document.getElementById("phone-app");
    await waitForCondition(
      () => root.querySelector(".phone-connection-revoked")?.textContent === "Pairing revoked",
      "the packaged client to render revoked state",
    );
    assert.equal(root.querySelector(".phone-connection-revoked")?.textContent, "Pairing revoked");
    assert.equal(instances.length, 1);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, "/");
    assert.equal(fetchCalls[0].init.credentials, "same-origin");
    assert.equal(fetchCalls[0].init.cache, "no-store");
    assert.equal(fetchCalls[0].init.headers.Accept, "text/html");
    assert.equal(timer.active().length, 0);
  } finally {
    instances[0]?.close();
    dom.window.close();
  }
});
