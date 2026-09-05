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
  phone: path.resolve(__dirname, "../../../dist-electron/electron/phone/phone.js"),
};
const [
  { PhoneGateway },
  { ScreenshotService },
  { AttachmentStore },
  { ConversationStore },
  { SessionProjectionStore },
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

function waitFor(predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for real phone projection state."));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
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
    assert.equal(initial.snapshot.queue[0].previewUrl, "/api/context/" + SCREENSHOT_ID);
    assert.equal(
      initial.snapshot.conversation.messages.some((message) => message.text === "Question from the desktop"),
      true,
    );
    assert.equal(
      phoneRoot.querySelector('img[src="/api/context/' + SCREENSHOT_ID + '"]') !== null,
      true,
    );
    assert.equal(
      phoneRoot.querySelector('img[src="/api/attachments/' + ATTACHMENT_ID + '"]') !== null,
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
      "/api/context/" + SCREENSHOT_ID,
      { Host: advertisedHost, Cookie: cookieHeader },
    );
    const attachmentResponse = await requestOnce(
      port,
      "/api/attachments/" + ATTACHMENT_ID,
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
