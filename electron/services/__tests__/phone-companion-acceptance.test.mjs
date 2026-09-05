import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePaths = {
  gateway: path.resolve(__dirname, "../../../dist-electron/electron/services/PhoneGateway.js"),
  screenshot: path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js"),
  attachment: path.resolve(__dirname, "../../../dist-electron/electron/services/AttachmentStore.js"),
  conversation: path.resolve(__dirname, "../../../dist-electron/electron/services/ConversationStore.js"),
  projection: path.resolve(__dirname, "../../../dist-electron/electron/services/SessionProjectionStore.js"),
};
const [{ PhoneGateway }, { ScreenshotService }, { AttachmentStore }, { ConversationStore }, { SessionProjectionStore }] =
  await Promise.all(Object.values(modulePaths).map((modulePath) => import(pathToFileURL(modulePath).href)));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const temporaryDirectories = [];

function requestOnce(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: requestPath, headers }, (response) => {
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

async function requestStatus(port, requestPath, headers = {}) {
  try {
    return await requestOnce(port, requestPath, headers);
  } catch (error) {
    return { error };
  }
}

async function createRuntime(root, suffix) {
  const screenshotId = suffix === "old" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
  const attachmentId = suffix === "old" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const queueListeners = new Set();
  const screenshots = new ScreenshotService({
    directory: path.join(root, `screenshots-${suffix}`),
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
      getCursorScreenPoint: () => ({ x: 1, y: 1 }),
      getDisplayNearestPoint: () => ({ id: 1, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
    },
    idFactory: () => screenshotId,
    now: () => new Date(100),
    onStateChanged: (state) => {
      for (const listener of queueListeners) listener(state);
    },
  });
  const attachments = new AttachmentStore({
    rootDirectory: path.join(root, "session-attachments"),
    sessionId: `session-${suffix}`,
    idFactory: () => attachmentId,
    now: () => 200,
  });
  await Promise.all([screenshots.whenIdle(), attachments.whenReady()]);
  const conversation = new ConversationStore({
    sessionId: attachments.sessionId,
    now: () => 300,
    idFactory: (() => {
      let index = 0;
      return () => `message-${suffix}-${++index}`;
    })(),
  });
  const projection = new SessionProjectionStore({
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
  const gateway = new PhoneGateway({
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
  return { gateway, screenshots, attachments, conversation, projection, qrUrls, screenshotId, attachmentId };
}

async function pair(runtime, port) {
  const secret = new URL(runtime.qrUrls.at(-1)).searchParams.get("secret");
  const exchange = await requestOnce(port, `/pair?secret=${encodeURIComponent(secret)}`);
  assert.equal(exchange.statusCode, 302);
  const cookie = exchange.headers["set-cookie"]?.[0]?.match(/^(fluely_phone_session=[^;]+)/)?.[1];
  assert.ok(cookie);
  return cookie;
}

async function disposeRuntime(runtime) {
  await runtime.gateway.stop();
  runtime.projection.dispose();
  runtime.screenshots.dispose();
  await runtime.conversation.dispose();
  await runtime.attachments.dispose();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("disable and replacement pairing revoke old cookies and old authenticated media requests", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-disable-"));
  temporaryDirectories.push(root);
  const runtime = await createRuntime(root, "old");
  try {
    const ready = await runtime.gateway.start();
    const port = Number(new URL(ready.origin).port);
    const oldCookie = await pair(runtime, port);
    const item = await runtime.screenshots.capture();
    const screenshotPath = runtime.screenshots.getManagedPaths([item.id])[0];
    const attachment = await runtime.attachments.addFromScreenshot(item, screenshotPath);
    runtime.conversation.addAttachment(attachment);
    runtime.conversation.startTurn("old session", [attachment.id]);

    const oldMedia = await requestOnce(port, `/api/attachments/${attachment.id}`, { Cookie: oldCookie });
    assert.equal(oldMedia.statusCode, 200);
    assert.deepEqual(oldMedia.body, PNG_BYTES);

    await runtime.gateway.regeneratePairing();
    assert.equal((await requestOnce(port, "/", { Cookie: oldCookie })).statusCode, 401);
    assert.equal((await requestOnce(port, `/api/attachments/${attachment.id}`, { Cookie: oldCookie })).statusCode, 401);

    const replacementCookie = await pair(runtime, port);
    assert.equal((await requestOnce(port, `/api/attachments/${attachment.id}`, { Cookie: replacementCookie })).statusCode, 200);

    await runtime.gateway.stop();
    const disabled = await requestStatus(port, "/", { Cookie: replacementCookie });
    assert.ok(disabled.error || disabled.statusCode === 401);

    const restarted = await runtime.gateway.start();
    const restartedPort = Number(new URL(restarted.origin).port);
    assert.equal((await requestOnce(restartedPort, "/", { Cookie: oldCookie })).statusCode, 401);
    assert.equal((await requestOnce(restartedPort, `/api/attachments/${attachment.id}`, { Cookie: oldCookie })).statusCode, 401);
  } finally {
    await disposeRuntime(runtime);
  }
});

test("a new session runtime starts empty and rejects old cookies and media IDs", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-restart-"));
  temporaryDirectories.push(root);
  const oldRuntime = await createRuntime(root, "old");
  let oldCookie;
  let oldPort;
  let oldAttachmentId;
  let oldScreenshotId;
  try {
    const ready = await oldRuntime.gateway.start();
    oldPort = Number(new URL(ready.origin).port);
    oldCookie = await pair(oldRuntime, oldPort);
    const item = await oldRuntime.screenshots.capture();
    oldScreenshotId = item.id;
    const screenshotPath = oldRuntime.screenshots.getManagedPaths([item.id])[0];
    const attachment = await oldRuntime.attachments.addFromScreenshot(item, screenshotPath);
    oldAttachmentId = attachment.id;
    oldRuntime.conversation.addAttachment(attachment);
    const turn = oldRuntime.conversation.startTurn("streaming before restart", [attachment.id]);
    assert.equal(oldRuntime.screenshots.getState().items.length, 1);
    assert.equal(oldRuntime.projection.getSnapshot().conversation.messages.some((message) => message.id === turn.assistant.id), true);
  } finally {
    await disposeRuntime(oldRuntime);
  }

  const newRuntime = await createRuntime(root, "new");
  try {
    assert.deepEqual(newRuntime.screenshots.getState().items, []);
    assert.equal(newRuntime.screenshots.getState().capturing, false);
    assert.deepEqual(newRuntime.attachments.list(), []);
    assert.deepEqual(newRuntime.conversation.snapshot().messages, []);
    assert.equal(newRuntime.conversation.snapshot().activeMessageId, undefined);
    assert.deepEqual(newRuntime.projection.getSnapshot().queue, []);
    assert.deepEqual(newRuntime.projection.getSnapshot().conversation.messages, []);
    assert.equal(newRuntime.projection.getSnapshot().capturing, false);

    const ready = await newRuntime.gateway.start();
    const port = Number(new URL(ready.origin).port);
    const newCookie = await pair(newRuntime, port);
    assert.equal((await requestOnce(port, "/", { Cookie: oldCookie })).statusCode, 401);
    assert.equal((await requestOnce(port, `/api/context/${oldScreenshotId}`, { Cookie: newCookie })).statusCode, 404);
    assert.equal((await requestOnce(port, `/api/attachments/${oldAttachmentId}`, { Cookie: newCookie })).statusCode, 404);
    assert.equal((await requestStatus(oldPort, "/", { Cookie: oldCookie })).error !== undefined, true);
  } finally {
    await disposeRuntime(newRuntime);
  }
});
