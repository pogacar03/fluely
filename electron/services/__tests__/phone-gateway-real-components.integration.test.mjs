import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePaths = {
  gateway: path.resolve(__dirname, "../../../dist-electron/electron/services/PhoneGateway.js"),
  screenshot: path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js"),
  attachment: path.resolve(__dirname, "../../../dist-electron/electron/services/AttachmentStore.js"),
  conversation: path.resolve(__dirname, "../../../dist-electron/electron/services/ConversationStore.js"),
  projection: path.resolve(__dirname, "../../../dist-electron/electron/services/SessionProjectionStore.js"),
};
const [{ PhoneGateway }, { ScreenshotService }, { AttachmentStore }, { ConversationStore }, { SessionProjectionStore }] = await Promise.all(
  Object.values(modulePaths).map((modulePath) => import(pathToFileURL(modulePath).href)),
);

const SCREENSHOT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

class FakeServer {
  constructor(handler) {
    this.handler = handler;
    this.listeners = new Map();
    this.port = null;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event, listener) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
    return this;
  }

  listen(port, _host, callback) {
    this.port = port === 0 ? 45679 : port;
    queueMicrotask(() => callback?.());
    return this;
  }

  address() {
    return this.port === null ? null : { port: this.port };
  }

  close(callback) {
    this.port = null;
    queueMicrotask(() => callback?.());
  }
}

function invokeHandler(gateway, requestPath, headers = {}) {
  return new Promise((resolve) => {
    const responseHeaders = {};
    const response = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders[name.toLowerCase()] = value;
      },
      end(body = "") {
        resolve({
          statusCode: response.statusCode,
          headers: responseHeaders,
          body: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body)),
        });
      },
    };
    const status = gateway.getStatus();
    gateway.handleRequest({
      method: "GET",
      url: requestPath,
      headers: {
        host: status.state === "ready" ? new URL(status.origin).host : "",
        ...headers,
      },
      socket: { remoteAddress: "192.168.50.20" },
    }, response);
  });
}

test("real screenshot, attachment, projection, and gateway components preserve opaque authenticated media boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-real-components-"));
  const screenshotDirectory = path.join(root, "screenshots");
  const attachmentDirectory = path.join(root, "session-attachments");
  const queueListeners = new Set();
  let gateway;
  let projection;
  let screenshots;
  let attachments;
  let conversation;

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
        return () => `message-${++sequence}`;
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

    const servers = [];
    const qrUrls = [];
    gateway = new PhoneGateway({
      networkInterfaces: () => ({ en0: [{ address: "192.168.50.8", family: "IPv4", internal: false }] }),
      createServer: (handler) => {
        const server = new FakeServer(handler);
        servers.push(server);
        return server;
      },
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
      qrCode: { toDataURL: async (url) => { qrUrls.push(url); return "data:qr"; } },
    });
    const ready = await gateway.start();
    assert.equal(ready.state, "ready");

    const item = await screenshots.capture();
    assert.deepEqual(Buffer.from(await readFile(screenshots.getManagedPaths([item.id])[0])), PNG_BYTES);
    const attachment = await attachments.addFromScreenshot(item, screenshots.getManagedPaths([item.id])[0]);
    conversation.addAttachment(attachment);
    conversation.startTurn("Question", [attachment.id]);
    const canonical = projection.getSnapshot();
    assert.deepEqual(canonical.queue.map((entry) => entry.id), [SCREENSHOT_ID]);
    assert.deepEqual(canonical.conversation.messages[0].attachmentIds, [ATTACHMENT_ID]);

    const pairingSecret = new URL(qrUrls[0]).searchParams.get("secret");
    const exchange = await invokeHandler(gateway, `/pair?secret=${pairingSecret}`);
    const cookie = exchange.headers["set-cookie"].match(/^(fluely_phone_session=[^;]+)/)[1];
    const contextResponse = await invokeHandler(gateway, `/api/context/${SCREENSHOT_ID}`, { cookie });
    const attachmentResponse = await invokeHandler(gateway, `/api/attachments/${ATTACHMENT_ID}`, { cookie });
    assert.equal(contextResponse.statusCode, 200);
    assert.equal(attachmentResponse.statusCode, 200);
    assert.deepEqual(contextResponse.body, PNG_BYTES);
    assert.deepEqual(attachmentResponse.body, PNG_BYTES);
    assert.equal(String(contextResponse.headers["content-length"]), String(PNG_BYTES.byteLength));
    assert.equal(String(attachmentResponse.headers["content-length"]), String(PNG_BYTES.byteLength));
    assert.equal(JSON.stringify([contextResponse, attachmentResponse]).includes(root), false);

    for (const target of [
      `http://192.168.50.8:45679/api/context/${SCREENSHOT_ID}`,
      `/api/context/../context/${SCREENSHOT_ID}`,
      `/api/context/%2e%2e/context/${SCREENSHOT_ID}`,
      `/api/context/%252e%252e/context/${SCREENSHOT_ID}`,
      `/api/context/${SCREENSHOT_ID}?cache=1`,
    ]) {
      const rejected = await invokeHandler(gateway, target, { cookie });
      assert.equal(rejected.statusCode, 404, target);
      assert.equal(rejected.body.toString("utf8"), "Not found.");
      assert.equal(rejected.body.toString("utf8").includes(root), false);
    }

    await screenshots.clear();
    const removedContext = await invokeHandler(gateway, `/api/context/${SCREENSHOT_ID}`, { cookie });
    const retainedAttachment = await invokeHandler(gateway, `/api/attachments/${ATTACHMENT_ID}`, { cookie });
    assert.equal(removedContext.statusCode, 404);
    assert.equal(retainedAttachment.statusCode, 200);
  } finally {
    await gateway?.stop();
    projection?.dispose();
    screenshots?.dispose();
    await attachments?.dispose();
    await conversation?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
