import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePaths = {
  gateway: path.resolve(__dirname, "../../../dist-electron/electron/services/PhoneGateway.js"),
  screenshot: path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js"),
  attachment: path.resolve(__dirname, "../../../dist-electron/electron/services/AttachmentStore.js"),
  conversation: path.resolve(__dirname, "../../../dist-electron/electron/services/ConversationStore.js"),
  projection: path.resolve(__dirname, "../../../dist-electron/electron/services/SessionProjectionStore.js"),
  analysis: path.resolve(__dirname, "../../../dist-electron/electron/services/AnalysisService.js"),
  router: path.resolve(__dirname, "../../../dist-electron/electron/services/CommandRouter.js"),
  phone: path.resolve(__dirname, "../../../dist-electron/electron/phone/phone.js"),
};
const [
  { PhoneGateway },
  { ScreenshotService },
  { AttachmentStore },
  { ConversationStore },
  { SessionProjectionStore },
  { AnalysisService },
  { CommandRouter },
  { startPhoneClient },
] = await Promise.all(
  Object.values(modulePaths).map((modulePath) => import(pathToFileURL(modulePath).href)),
);

const SCREENSHOT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

function requestOnce(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: requestPath,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(2_000, () => request.destroy(new Error("HTTP request timed out")));
    request.on("error", reject);
    request.end();
  });
}

function expectRejectedWebSocket(port, cookieHeader, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws", {
      headers: { Cookie: cookieHeader },
      origin,
    });
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* The handshake already ended. */ }
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode);
    });
    socket.once("open", () => finish(undefined, new Error("Expected the old phone session to be rejected.")));
    socket.once("error", (error) => finish(undefined, error));
  });
}

function waitFor(predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        const result = predicate();
        if (result) {
          resolve(result);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for real phone projection state: ${String(predicate).replace(/\s+/g, " ").slice(0, 240)}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function comparableCanonicalProjection(snapshot) {
  return {
    revision: snapshot.revision,
    capturing: snapshot.capturing ?? false,
    conversation: structuredClone(snapshot.conversation),
    queue: snapshot.queue.map(({ previewUrl: _previewUrl, ...item }) => ({ ...item })),
  };
}

test("real components stream canonical snapshots/events over PhoneGateway HTTP+WS and serve identical media bytes", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-real-components-"));
  const screenshotDirectory = path.join(root, "screenshots");
  const attachmentDirectory = path.join(root, "session-attachments");
  const queueListeners = new Set();
  const previousDocument = globalThis.document;
  let gateway;
  let projection;
  let screenshots;
  let attachments;
  let conversation;
  let phoneClient;
  let dom;

  try {
    screenshots = new ScreenshotService({
      directory: screenshotDirectory,
      platform: "linux",
      desktopCapturer: {
        getSources: async () => [{
          display_id: "1",
          thumbnail: {
            toPNG: () => PNG_BYTES,
            getSize: () => ({ width: 1920, height: 1080 }),
          },
        }],
      },
      screen: {
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      },
      idFactory: () => SCREENSHOT_ID,
      now: () => new Date(100),
      onStateChanged: (state) => {
        for (const listener of queueListeners) listener(state);
      },
    });
    attachments = new AttachmentStore({
      rootDirectory: attachmentDirectory,
      sessionId: "session-phone-real",
      idFactory: () => ATTACHMENT_ID,
      now: () => 200,
    });
    await Promise.all([screenshots.whenIdle(), attachments.whenReady()]);
    conversation = new ConversationStore({
      sessionId: attachments.sessionId,
      now: () => 300,
      idFactory: (() => {
        let sequence = 0;
        return () => "message-" + (++sequence);
      })(),
    });
    projection = new SessionProjectionStore({
      conversation,
      queue: {
        getState: () => screenshots.getState(),
        onStateChanged(listener) {
          queueListeners.add(listener);
          return () => queueListeners.delete(listener);
        },
      },
    });

    const qrUrls = [];
    gateway = new PhoneGateway({
      networkInterfaces: () => ({ en0: [{ address: "192.168.50.8", family: "IPv4", internal: false }] }),
      portCandidates: [0],
      projection,
      context: {
        getManagedPaths: (ids) => screenshots.getManagedPaths(ids),
        getManagedRoot: () => screenshots.getManagedRoot(),
      },
      attachments: {
        getPath: (id) => attachments.getPath(id),
        getManagedRoot: () => attachments.directory,
      },
      qrCode: {
        toDataURL: async (url) => {
          qrUrls.push(url);
          return "data:qr";
        },
      },
    });

    const ready = await gateway.start();
    assert.equal(ready.state, "ready");
    const port = Number(new URL(ready.origin).port);
    const advertisedHost = new URL(ready.origin).host;
    const pairingSecret = new URL(qrUrls[0]).searchParams.get("secret");
    assert.equal(typeof pairingSecret, "string");

    const exchange = await requestOnce(
      port,
      "/pair?secret=" + encodeURIComponent(pairingSecret),
      { Host: advertisedHost },
    );
    assert.equal(exchange.statusCode, 302);
    const setCookie = exchange.headers["set-cookie"];
    assert.ok(Array.isArray(setCookie));
    const cookieHeader = setCookie[0].match(/^(fluely_phone_session=[^;]+)/)?.[1];
    assert.ok(cookieHeader);

    const item = await screenshots.capture();
    await screenshots.whenIdle();
    const screenshotPath = screenshots.getManagedPaths([item.id])[0];
    assert.deepEqual(await readFile(screenshotPath), PNG_BYTES);
    const attachment = await attachments.addFromScreenshot(item, screenshotPath);
    conversation.addAttachment(attachment);
    const turn = conversation.startTurn("Question from the desktop", [attachment.id]);
    const canonical = projection.getSnapshot();
    assert.deepEqual(canonical.queue.map((entry) => entry.id), [SCREENSHOT_ID]);
    assert.deepEqual(canonical.conversation.messages[0].attachmentIds, [ATTACHMENT_ID]);

    const phoneFetch = async (input, init = {}) => {
      const inputUrl = new URL(String(input), ready.origin);
      const headers = new Headers(init.headers);
      headers.set("Cookie", cookieHeader);
      return fetch(
        "http://127.0.0.1:" + port + inputUrl.pathname + inputUrl.search,
        { ...init, headers },
      );
    };
    class PhoneGatewayWebSocket {
      static OPEN = WebSocket.OPEN;

      constructor(url) {
        const inputUrl = new URL(url);
        this.socket = new WebSocket(
          "ws://127.0.0.1:" + port + inputUrl.pathname + inputUrl.search,
          {
            headers: { Cookie: cookieHeader },
            origin: ready.origin,
          },
        );
      }

      get readyState() {
        return this.socket.readyState;
      }

      addEventListener(type, listener) {
        this.socket.addEventListener(type, listener);
      }

      send(value) {
        this.socket.send(value);
      }

      close() {
        this.socket.close();
      }
    }

    dom = new JSDOM('<div id="phone-app"></div>', { url: ready.origin + "/" });
    globalThis.document = dom.window.document;
    const phoneRoot = dom.window.document.getElementById("phone-app");
    phoneClient = startPhoneClient(phoneRoot, {
      WebSocket: PhoneGatewayWebSocket,
      fetch: phoneFetch,
      location: { protocol: "http:", host: advertisedHost },
    });

    await waitFor(() => {
      const state = phoneClient.getState();
      return state.connection === "connected" &&
        state.snapshot?.queue.length === 1 &&
        state.snapshot.conversation.messages.some((message) => message.id === turn.assistant.id);
    });
    const initial = phoneClient.getState();
    const mediaCapability = initial.snapshot.mediaCapability;
    assert.match(mediaCapability, /^[0-9a-f]{64}$/);
    const contextUrl = "/api/context/" + mediaCapability + "/" + SCREENSHOT_ID;
    const attachmentUrl = "/api/attachments/" + mediaCapability + "/" + ATTACHMENT_ID;
    assert.equal(initial.snapshot.queue[0].previewUrl, contextUrl);
    assert.equal(
      initial.snapshot.conversation.messages.some((message) => message.text === "Question from the desktop"),
      true,
    );
    assert.equal(
      phoneRoot.querySelector('img[src="' + contextUrl + '"]') !== null,
      true,
    );
    assert.equal(
      phoneRoot.querySelector('img[src="' + attachmentUrl + '"]') !== null,
      true,
    );

    const initialRevision = initial.snapshot.revision;
    conversation.updateAssistant(turn.assistant.id, "Live answer from the desktop", "streaming");
    await waitFor(() => {
      const state = phoneClient.getState();
      return state.snapshot?.revision > initialRevision &&
        state.snapshot.conversation.messages.some((message) =>
          message.id === turn.assistant.id && message.text === "Live answer from the desktop");
    });
    const eventState = phoneClient.getState();
    assert.equal(eventState.snapshot.conversation.messages.some((message) =>
      message.id === turn.assistant.id && message.text === "Live answer from the desktop"), true);
    assert.equal(
      phoneRoot.querySelector('[data-message-id="' + turn.assistant.id + '"] .phone-message-text')?.textContent,
      "Live answer from the desktop",
    );

    const contextResponse = await requestOnce(
      port,
      contextUrl,
      { Host: advertisedHost, Cookie: cookieHeader },
    );
    const attachmentResponse = await requestOnce(
      port,
      attachmentUrl,
      { Host: advertisedHost, Cookie: cookieHeader },
    );
    assert.equal(contextResponse.statusCode, 200);
    assert.equal(attachmentResponse.statusCode, 200);
    assert.deepEqual(contextResponse.body, PNG_BYTES);
    assert.deepEqual(attachmentResponse.body, PNG_BYTES);
    assert.equal(contextResponse.body.equals(attachmentResponse.body), true);
    assert.equal(contextResponse.headers["content-type"], "image/png");
    assert.equal(attachmentResponse.headers["content-type"], "image/png");
    assert.equal(Number(contextResponse.headers["content-length"]), PNG_BYTES.byteLength);
    assert.equal(Number(attachmentResponse.headers["content-length"]), PNG_BYTES.byteLength);
  } finally {
    phoneClient?.stop();
    await gateway?.stop();
    projection?.dispose();
    screenshots?.dispose();
    await conversation?.dispose();
    await attachments?.dispose();
    dom?.window.close();
    globalThis.document = previousDocument;
    await rm(root, { recursive: true, force: true });
  }
});

test("first authenticated snapshot contains ordered multi-turn history, queued screenshots, and fetchable media after reconnect", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-history-integration-"));
  const queueListeners = new Set();
  let gateway;
  let projection;
  let screenshots;
  let attachments;
  let conversation;
  let socket;
  const screenshotIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const attachmentIds = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ];
  try {
    let screenshotIndex = 0;
    let attachmentIndex = 0;
    screenshots = new ScreenshotService({
      directory: path.join(root, "screenshots"),
      platform: "linux",
      desktopCapturer: {
        getSources: async () => [{
          display_id: "1",
          thumbnail: { toPNG: () => PNG_BYTES, getSize: () => ({ width: 1920, height: 1080 }) },
        }],
      },
      screen: {
        getCursorScreenPoint: () => ({ x: 1, y: 1 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      },
      idFactory: () => screenshotIds[screenshotIndex++],
      now: () => new Date(100),
      onStateChanged: (state) => { for (const listener of queueListeners) listener(state); },
    });
    attachments = new AttachmentStore({
      rootDirectory: path.join(root, "session-attachments"),
      sessionId: "session-phone-history",
      idFactory: () => attachmentIds[attachmentIndex++],
      now: () => 200,
    });
    await Promise.all([screenshots.whenIdle(), attachments.whenReady()]);
    const captured = [await screenshots.capture(), await screenshots.capture(), await screenshots.capture()];
    await screenshots.whenIdle();
    conversation = new ConversationStore({
      sessionId: attachments.sessionId,
      now: () => 300,
      idFactory: (() => { let index = 0; return () => `history-message-${++index}`; })(),
    });
    const conversationAttachments = [];
    for (const item of captured.slice(0, 2)) {
      const sourcePath = screenshots.getManagedPaths([item.id])[0];
      const attachment = await attachments.addFromScreenshot(item, sourcePath);
      conversation.addAttachment(attachment);
      conversationAttachments.push(attachment);
    }
    const firstTurn = conversation.startTurn("First question", [conversationAttachments[0].id]);
    conversation.finishAssistant(firstTurn.assistant.id, "completed", "First model reply");
    const secondTurn = conversation.startTurn("Second question", [conversationAttachments[1].id]);
    conversation.finishAssistant(secondTurn.assistant.id, "completed", "Second model reply");
    projection = new SessionProjectionStore({
      conversation,
      queue: {
        getState: () => screenshots.getState(),
        onStateChanged(listener) { queueListeners.add(listener); return () => queueListeners.delete(listener); },
      },
    });
    const qrUrls = [];
    gateway = new PhoneGateway({
      networkInterfaces: () => ({ en0: [{ address: "192.168.50.8", family: "IPv4", internal: false }] }),
      portCandidates: [0],
      projection,
      context: { getManagedPaths: (ids) => screenshots.getManagedPaths(ids), getManagedRoot: () => screenshots.getManagedRoot() },
      attachments: { getPath: (id) => attachments.getPath(id), getManagedRoot: () => attachments.directory },
      qrCode: { toDataURL: async (url) => { qrUrls.push(url); return "data:qr"; } },
    });
    const ready = await gateway.start();
    const port = Number(new URL(ready.origin).port);
    const host = new URL(ready.origin).host;
    const secret = new URL(qrUrls[0]).searchParams.get("secret");
    const exchange = await requestOnce(port, `/pair?secret=${encodeURIComponent(secret)}`, { Host: host });
    const cookie = exchange.headers["set-cookie"]?.[0]?.match(/^(fluely_phone_session=[^;]+)/)?.[1];
    assert.ok(cookie);
    const open = () => new Promise((resolve, reject) => {
      const nextFrames = [];
      const waiters = [];
      const current = new WebSocket("ws://127.0.0.1:" + port + "/ws", { headers: { Cookie: cookie }, origin: ready.origin });
      current.on("message", (data) => {
        const frame = JSON.parse(String(data));
        const waiter = waiters.shift();
        if (waiter) waiter(frame); else nextFrames.push(frame);
      });
      current.once("error", reject);
      current.once("open", () => resolve({ socket: current, next: () => nextFrames.length ? Promise.resolve(nextFrames.shift()) : new Promise((nextResolve) => waiters.push(nextResolve)) }));
    });
    const first = await open();
    socket = first.socket;
    const snapshotFrame = await first.next();
    assert.equal(snapshotFrame.type, "snapshot");
    assert.deepEqual(snapshotFrame.payload.queue.map((item) => item.id), screenshotIds);
    assert.deepEqual(snapshotFrame.payload.conversation.messages.map((message) => message.text), [
      "First question", "First model reply", "Second question", "Second model reply",
    ]);
    assert.deepEqual(snapshotFrame.payload.conversation.messages.map((message) => message.sequence), [1, 2, 3, 4]);
    const capability = snapshotFrame.payload.mediaCapability;
    for (const id of screenshotIds) {
      const response = await requestOnce(port, `/api/context/${capability}/${id}`, { Host: host, Cookie: cookie });
      assert.equal(response.statusCode, 200, id);
      assert.deepEqual(response.body, PNG_BYTES);
    }
    for (const id of attachmentIds) {
      const response = await requestOnce(port, `/api/attachments/${capability}/${id}`, { Host: host, Cookie: cookie });
      assert.equal(response.statusCode, 200, id);
      assert.deepEqual(response.body, PNG_BYTES);
    }
    socket.close();
    const reconnected = await open();
    socket = reconnected.socket;
    const reconnectFrame = await reconnected.next();
    assert.equal(reconnectFrame.type, "snapshot");
    assert.deepEqual(reconnectFrame.payload.conversation.messages.map((message) => message.text), snapshotFrame.payload.conversation.messages.map((message) => message.text));
    assert.deepEqual(reconnectFrame.payload.queue.map((item) => item.id), screenshotIds);
  } finally {
    try { socket?.close(); } catch { /* test cleanup */ }
    await gateway?.stop();
    projection?.dispose();
    screenshots?.dispose();
    await conversation?.dispose();
    await attachments?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop and phone commands share canonical order, idempotency, cancellation, reconnect, and session revocation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-commands-integration-"));
  const screenshotDirectory = path.join(root, "screenshots");
  const attachmentDirectory = path.join(root, "session-attachments");
  const queueListeners = new Set();
  const previousDocument = globalThis.document;
  let gateway;
  let projection;
  let screenshots;
  let attachments;
  let conversation;
  let analysis;
  let phoneClient;
  let dom;
  const phoneSockets = [];
  const phoneRouterCalls = [];
  let releaseStream;

  const getButton = (rootElement, label) => [...rootElement.querySelectorAll("button")]
    .find((button) => button.textContent.includes(label) || button.getAttribute("aria-label")?.includes(label));
  const waitForCommandFrame = (socket, startIndex) => waitFor(() => {
    const next = socket.sent.slice(startIndex).map((value) => JSON.parse(value))
      .find((frame) => frame.type === "command");
    return next;
  });
  const assertDesktopPhoneConverged = async () => {
    await waitFor(() => {
      const phoneSnapshot = phoneClient?.getState().snapshot;
      return phoneSnapshot && phoneSnapshot.revision === projection?.getSnapshot().revision;
    });
    assert.deepEqual(
      comparableCanonicalProjection(phoneClient.getState().snapshot),
      comparableCanonicalProjection(projection.getSnapshot()),
    );
  };

  try {
    let screenshotIndex = 0;
    screenshots = new ScreenshotService({
      directory: screenshotDirectory,
      platform: "linux",
      desktopCapturer: {
        getSources: async () => [{
          display_id: "1",
          thumbnail: {
            toPNG: () => PNG_BYTES,
            getSize: () => ({ width: 1920, height: 1080 }),
          },
        }],
      },
      screen: {
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      },
      idFactory: () => screenshotIndex++ === 0
        ? SCREENSHOT_ID
        : "22222222-2222-4222-8222-222222222222",
      now: () => new Date(100),
      onStateChanged: (state) => {
        for (const listener of queueListeners) listener(state);
      },
    });
    attachments = new AttachmentStore({
      rootDirectory: attachmentDirectory,
      sessionId: "session-phone-commands",
      idFactory: (() => {
        let attachmentIndex = 0;
        return () => attachmentIndex++ === 0
          ? ATTACHMENT_ID
          : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      })(),
      now: () => 200,
    });
    await Promise.all([screenshots.whenIdle(), attachments.whenReady()]);
    conversation = new ConversationStore({
      sessionId: attachments.sessionId,
      now: () => 300,
      idFactory: (() => {
        let messageIndex = 0;
        return () => `message-${++messageIndex}`;
      })(),
    });
    analysis = new AnalysisService({
      provider: {
        stream: (_path, options) => (async function* () {
          yield "partial";
          await new Promise((resolve) => {
            releaseStream = resolve;
            options.signal.addEventListener("abort", resolve, { once: true });
          });
          if (!options.signal.aborted) yield "late";
        })(),
      },
      screenshots,
      codex: {
        enabled: true,
        path: "codex",
        model: "test-model",
        fastModel: "fast-model",
        timeoutMs: 1_000,
        sandboxMode: "read-only",
        modelReasoningEffort: "medium",
      },
      now: () => new Date(400),
    });
    const router = new CommandRouter({
      screenshots: {
        getState: () => screenshots.getState(),
        getManagedPaths: (ids) => screenshots.getManagedPaths(ids),
        capture: () => screenshots.capture(),
        delete: (id) => screenshots.delete(id),
        clear: () => screenshots.clear(),
      },
      attachments,
      conversation,
      analysis,
    });
    const phoneRouter = {
      execute: async (command, source) => {
        phoneRouterCalls.push({ command, source });
        if (command.requestId === "integration-safe-error") {
          throw Object.assign(new Error("provider /Users/yu/private/session.json"), { code: "INTERNAL_ERROR" });
        }
        return router.execute(command, source);
      },
    };
    projection = new SessionProjectionStore({
      conversation,
      queue: {
        getState: () => screenshots.getState(),
        onStateChanged(listener) {
          queueListeners.add(listener);
          return () => queueListeners.delete(listener);
        },
      },
    });

    const qrUrls = [];
    gateway = new PhoneGateway({
      networkInterfaces: () => ({ en0: [{ address: "192.168.50.8", family: "IPv4", internal: false }] }),
      portCandidates: [0],
      projection,
      commandRouter: phoneRouter,
      context: {
        getManagedPaths: (ids) => screenshots.getManagedPaths(ids),
        getManagedRoot: () => screenshots.getManagedRoot(),
      },
      attachments: {
        getPath: (id) => attachments.getPath(id),
        getManagedRoot: () => attachments.directory,
      },
      qrCode: {
        toDataURL: async (url) => {
          qrUrls.push(url);
          return "data:qr";
        },
      },
    });
    const ready = await gateway.start();
    const port = Number(new URL(ready.origin).port);
    const advertisedHost = new URL(ready.origin).host;
    const pairingSecret = new URL(qrUrls[0]).searchParams.get("secret");
    const exchange = await requestOnce(port, "/pair?secret=" + encodeURIComponent(pairingSecret), { Host: advertisedHost });
    const cookieHeader = exchange.headers["set-cookie"]?.[0]?.match(/^(fluely_phone_session=[^;]+)/)?.[1];
    assert.ok(cookieHeader);

    const phoneFetch = async (input, init = {}) => {
      const inputUrl = new URL(String(input), ready.origin);
      const headers = new Headers(init.headers);
      headers.set("Cookie", cookieHeader);
      return fetch("http://127.0.0.1:" + port + inputUrl.pathname + inputUrl.search, { ...init, headers });
    };
    class PhoneGatewayWebSocket {
      static OPEN = WebSocket.OPEN;

      constructor(url) {
        const inputUrl = new URL(url);
        this.socket = new WebSocket("ws://127.0.0.1:" + port + inputUrl.pathname + inputUrl.search, {
          headers: { Cookie: cookieHeader },
          origin: ready.origin,
        });
        this.sent = [];
        this.received = [];
        phoneSockets.push(this);
      }

      get readyState() {
        return this.socket.readyState;
      }

      addEventListener(type, listener) {
        this.socket.addEventListener(type, (event) => {
          if (type === "message") {
            try {
              this.received.push(JSON.parse(String(event.data)));
            } catch {
              // The phone client owns malformed-frame handling.
            }
          }
          listener(event);
        });
      }

      send(value) {
        this.sent.push(String(value));
        this.socket.send(value);
      }

      close() {
        this.socket.close();
      }
    }

    dom = new JSDOM('<div id="phone-app"></div>', { url: ready.origin + "/" });
    globalThis.document = dom.window.document;
    const phoneRoot = dom.window.document.getElementById("phone-app");
    phoneClient = startPhoneClient(phoneRoot, {
      WebSocket: PhoneGatewayWebSocket,
      fetch: phoneFetch,
      location: { protocol: "http:", host: advertisedHost },
    });
    await waitFor(() => phoneClient.getState().connection === "connected" && phoneClient.getState().snapshot?.revision === 0);

    let sentIndex = phoneSockets[0].sent.length;
    const captureButton = getButton(phoneRoot, "Capture");
    captureButton.click();
    const captureFrame = await waitForCommandFrame(phoneSockets[0], sentIndex);
    assert.equal(captureFrame.command.type, "capture");
    await waitFor(() => phoneClient.getState().snapshot?.queue.map((item) => item.id).join(",") === SCREENSHOT_ID);
    assert.equal(getButton(phoneRoot, "Capture").disabled, false);
    await assertDesktopPhoneConverged();

    await router.execute({ type: "capture", requestId: "desktop-capture-order" }, "desktop");
    await waitFor(() => phoneClient.getState().snapshot?.queue.length === 2);
    assert.deepEqual(phoneClient.getState().snapshot.queue.map((item) => item.id), [
      SCREENSHOT_ID,
      "22222222-2222-4222-8222-222222222222",
    ]);

    const prompt = phoneRoot.querySelector("textarea");
    prompt.value = "   ";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    sentIndex = phoneSockets[0].sent.length;
    getButton(phoneRoot, "Ask").click();
    const askFrame = await waitForCommandFrame(phoneSockets[0], sentIndex);
    assert.equal(askFrame.command.type, "ask");
    assert.equal(askFrame.command.prompt, "   ");
    await waitFor(() => phoneClient.getState().snapshot?.conversation.messages.some((message) =>
      message.role === "user" && message.text === "Analyze the attached screenshots."));
    await waitFor(() => phoneClient.getState().snapshot?.conversation.messages.some((message) =>
      message.role === "assistant" && message.status === "streaming"));
    const streamingRevision = phoneClient.getState().snapshot.revision;
    const activeMessageId = phoneClient.getState().snapshot.conversation.activeMessageId;
    assert.ok(activeMessageId);
    const userMessage = phoneClient.getState().snapshot.conversation.messages.find((message) => message.role === "user");
    assert.deepEqual(userMessage.attachmentIds, [ATTACHMENT_ID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    await waitFor(() => phoneClient.getState().snapshot?.queue.length === 0);
    assert.deepEqual(phoneClient.getState().snapshot.queue.map((item) => item.id), []);

    await waitFor(() => phoneSockets[0].received.some((frame) =>
      frame.type === "ack" && frame.requestId === askFrame.command.requestId));
    const ackCountBeforeDuplicate = phoneSockets[0].received
      .filter((frame) => frame.type === "ack" && frame.requestId === askFrame.command.requestId).length;
    const routerCallCountBeforeDuplicate = phoneRouterCalls.length;
    const duplicate = JSON.stringify({ type: "command", command: askFrame.command });
    phoneSockets[0].send(duplicate);
    await waitFor(() => phoneSockets[0].received
      .filter((frame) => frame.type === "ack" && frame.requestId === askFrame.command.requestId).length >= ackCountBeforeDuplicate + 1);
    const duplicateAcks = phoneSockets[0].received
      .filter((frame) => frame.type === "ack" && frame.requestId === askFrame.command.requestId);
    assert.equal(duplicateAcks.length, ackCountBeforeDuplicate + 1);
    assert.deepEqual(duplicateAcks.at(-1), duplicateAcks.at(-2));
    assert.equal(phoneRouterCalls.length, routerCallCountBeforeDuplicate);
    assert.equal(phoneRouterCalls.filter(({ command }) => command.requestId === askFrame.command.requestId).length, 1);
    assert.equal(phoneClient.getState().snapshot.revision >= streamingRevision, true);

    const errorSocket = phoneSockets.at(-1);
    errorSocket.send(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId: "integration-safe-error" },
    }));
    await waitFor(() => errorSocket.received.find((frame) =>
      frame.type === "error" && frame.requestId === "integration-safe-error"));
    const safeError = errorSocket.received.find((frame) => frame.requestId === "integration-safe-error");
    assert.deepEqual(safeError, {
      type: "error",
      requestId: "integration-safe-error",
      code: "COMMAND_FAILED",
      message: "Phone command failed.",
    });
    assert.equal(errorSocket.readyState, WebSocket.OPEN);

    const serverClient = [...gateway.phoneClients].at(-1);
    assert.ok(serverClient);
    Object.defineProperty(serverClient.socket, "bufferedAmount", {
      configurable: true,
      value: 1_048_577,
    });
    conversation.updateAssistant(activeMessageId, "Backpressure snapshot", "streaming");
    await waitFor(() => phoneSockets.length >= 2 && phoneClient.getState().connection === "connected");
    await waitFor(() => phoneClient.getState().snapshot?.conversation.messages.some((message) =>
      message.id === activeMessageId && message.text === "Backpressure snapshot"));
    assert.equal(phoneClient.getState().snapshot.conversation.messages.some((message) =>
      message.id === activeMessageId && message.text === "Backpressure snapshot"), true);
    await assertDesktopPhoneConverged();

    phoneSockets.at(-1).close();
    await waitFor(() => phoneSockets.length >= 3 && phoneClient.getState().connection === "connected");
    await waitFor(() => phoneClient.getState().snapshot?.conversation.messages.some((message) =>
      message.role === "assistant" && message.status === "streaming"));

    getButton(phoneRoot, "Cancel").click();
    await waitFor(() => phoneClient.getState().snapshot?.conversation.messages.some((message) =>
      message.role === "assistant" && message.status === "cancelled"));
    assert.deepEqual(phoneClient.getState().snapshot.queue.map((item) => item.id), []);

    getButton(phoneRoot, "Clear conversation").click();
    await waitFor(() => phoneClient.getState().snapshot?.conversation.messages.length === 0);
    assert.deepEqual(phoneClient.getState().snapshot.queue.map((item) => item.id), []);
    await assertDesktopPhoneConverged();

    const refreshed = await gateway.regeneratePairing();
    await waitFor(() => phoneClient.getState().connection === "revoked");
    const refreshedPort = Number(new URL(refreshed.origin).port);
    const refreshedHost = new URL(refreshed.origin).host;
    const oldHttp = await requestOnce(refreshedPort, "/", { Host: refreshedHost, Cookie: cookieHeader });
    assert.equal(oldHttp.statusCode, 401);
    assert.equal(await expectRejectedWebSocket(refreshedPort, cookieHeader, refreshed.origin), 401);
  } finally {
    if (releaseStream) releaseStream();
    phoneClient?.stop();
    for (const client of phoneSockets) client.close();
    await gateway?.stop();
    projection?.dispose();
    screenshots?.dispose();
    await analysis?.whenIdle();
    await conversation?.dispose();
    await attachments?.dispose();
    dom?.window.close();
    globalThis.document = previousDocument;
    await rm(root, { recursive: true, force: true });
  }
});
