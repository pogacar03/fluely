import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
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
};
const [
  { PhoneGateway },
  { ScreenshotService },
  { AttachmentStore },
  { ConversationStore },
  { SessionProjectionStore },
  { AnalysisService },
  { CommandRouter },
] =
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

function openWebSocket(port, cookie, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookie },
      origin,
    });
    const frames = [];
    const waiters = [];
    const deliver = (frame) => {
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    };
    socket.on("message", (data) => deliver(JSON.parse(String(data))));
    socket.once("error", reject);
    socket.once("open", () => resolve({
      socket,
      frames,
      nextFrame: () => frames.length > 0
        ? Promise.resolve(frames.shift())
        : new Promise((frameResolve) => waiters.push(frameResolve)),
    }));
  });
}

function expectRejectedWebSocket(port, cookie, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookie },
      origin,
    });
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* handshake already ended */ }
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode);
    });
    socket.once("open", () => finish(undefined, new Error("Expected the phone session to be rejected.")));
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED") finish(undefined, error);
    });
  });
}

async function assertPortCanBind(port) {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for acceptance state.");
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

async function createRealCommandRuntime(root, control) {
  const screenshotId = "33333333-3333-4333-8333-333333333333";
  const attachmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const queueListeners = new Set();
  const screenshots = new ScreenshotService({
    directory: path.join(root, "screenshots"),
    platform: "linux",
    desktopCapturer: {
      getSources: async () => {
        await control.captureGate.promise;
        return [{
          display_id: "1",
          thumbnail: {
            toPNG: () => PNG_BYTES,
            getSize: () => ({ width: 1920, height: 1080 }),
          },
        }];
      },
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 1, y: 1 }),
      getDisplayNearestPoint: () => ({ id: 1, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }),
    },
    idFactory: () => screenshotId,
    now: () => new Date(500),
    onStateChanged: (state) => {
      for (const listener of queueListeners) listener(state);
    },
  });
  const attachments = new AttachmentStore({
    rootDirectory: path.join(root, "session-attachments"),
    sessionId: "restart-session",
    idFactory: () => attachmentId,
    now: () => 600,
  });
  await Promise.all([screenshots.whenIdle(), attachments.whenReady()]);
  const conversation = new ConversationStore({
    sessionId: attachments.sessionId,
    now: () => 700,
    idFactory: (() => {
      let sequence = 0;
      return () => `restart-message-${++sequence}`;
    })(),
  });
  const analysis = new AnalysisService({
    provider: {
      stream: async function* (_path, options) {
        yield "streaming delta";
        await new Promise((resolve) => {
          control.releaseAnalysis = resolve;
          options.signal.addEventListener("abort", resolve, { once: true });
        });
        if (!options.signal.aborted) yield "completed delta";
      },
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
    now: () => new Date(800),
  });
  const router = new CommandRouter({
    screenshots: {
      getState: () => screenshots.getState(),
      getManagedPaths: (ids) => screenshots.getManagedPaths(ids),
      capture: () => screenshots.capture(),
      delete: (id) => screenshots.delete(id),
      clear: () => screenshots.clear(),
      cancelPending: () => screenshots.cancelPending(),
    },
    attachments,
    conversation,
    analysis,
  });
  const commandRouter = {
    execute: async (command, source) => {
      const result = await router.execute(command, source);
      if (command.requestId === "restart-send") {
        await control.commandGate.promise;
      }
      return result;
    },
    quiesce: async (scope) => {
      await router.quiesce(scope);
      control.commandGate.resolve();
    },
  };
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
    commandRouter,
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
  return { gateway, screenshots, attachments, conversation, projection, analysis, router, qrUrls, screenshotId, attachmentId };
}

async function abandonRuntime(runtime) {
  await runtime.gateway.stop();
  await runtime.analysis?.cancel?.();
  await runtime.analysis?.whenIdle?.();
  runtime.projection.dispose();
  runtime.screenshots.dispose();
}

async function disposeRealRuntime(runtime) {
  await runtime.gateway.stop();
  await runtime.analysis?.cancel?.();
  await runtime.analysis?.whenIdle?.();
  runtime.projection.dispose();
  runtime.screenshots.dispose();
  await runtime.conversation.dispose();
  await runtime.attachments.dispose();
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
  let oldSocket;
  let replacementSocket;
  let restartSocket;
  try {
    const ready = await runtime.gateway.start();
    const port = Number(new URL(ready.origin).port);
    const oldCookie = await pair(runtime, port);
    const item = await runtime.screenshots.capture();
    const screenshotPath = runtime.screenshots.getManagedPaths([item.id])[0];
    const attachment = await runtime.attachments.addFromScreenshot(item, screenshotPath);
    runtime.conversation.addAttachment(attachment);
    runtime.conversation.startTurn("old session", [attachment.id]);

    const oldWs = await openWebSocket(port, oldCookie, ready.origin);
    oldSocket = oldWs.socket;
    const oldSnapshot = await oldWs.nextFrame();
    const oldMediaUrl = oldSnapshot.payload.queue[0].previewUrl
      .replace("/api/context/", "/api/attachments/")
      .replace(item.id, attachment.id);
    const oldMedia = await requestOnce(port, oldMediaUrl, { Cookie: oldCookie });
    assert.equal(oldMedia.statusCode, 200);
    assert.deepEqual(oldMedia.body, PNG_BYTES);

    await runtime.gateway.regeneratePairing();
    assert.equal((await requestOnce(port, "/", { Cookie: oldCookie })).statusCode, 401);
    assert.equal((await requestOnce(port, oldMediaUrl, { Cookie: oldCookie })).statusCode, 401);

    const replacementCookie = await pair(runtime, port);
    const replacementWs = await openWebSocket(port, replacementCookie, ready.origin);
    replacementSocket = replacementWs.socket;
    const replacementSnapshot = await replacementWs.nextFrame();
    const replacementMediaUrl = replacementSnapshot.payload.queue[0].previewUrl
      .replace("/api/context/", "/api/attachments/")
      .replace(item.id, attachment.id);
    assert.equal((await requestOnce(port, oldMediaUrl, { Cookie: replacementCookie })).statusCode, 404);
    assert.equal((await requestOnce(port, replacementMediaUrl, { Cookie: replacementCookie })).statusCode, 200);

    await runtime.gateway.stop();
    const disabled = await requestStatus(port, "/", { Cookie: replacementCookie });
    assert.ok(disabled.error || disabled.statusCode === 401);

    const restarted = await runtime.gateway.start();
    const restartedPort = Number(new URL(restarted.origin).port);
    assert.equal((await requestOnce(restartedPort, "/", { Cookie: oldCookie })).statusCode, 401);
    assert.equal((await requestOnce(restartedPort, oldMediaUrl, { Cookie: oldCookie })).statusCode, 401);
    const restartedCookie = await pair(runtime, restartedPort);
    const restartedWs = await openWebSocket(restartedPort, restartedCookie, restarted.origin);
    restartSocket = restartedWs.socket;
    const restartedSnapshot = await restartedWs.nextFrame();
    const restartedMediaUrl = restartedSnapshot.payload.queue[0].previewUrl
      .replace("/api/context/", "/api/attachments/")
      .replace(item.id, attachment.id);
    assert.equal((await requestOnce(restartedPort, oldMediaUrl, { Cookie: restartedCookie })).statusCode, 404);
    assert.equal((await requestOnce(restartedPort, restartedMediaUrl, { Cookie: restartedCookie })).statusCode, 200);
  } finally {
    try { oldSocket?.close(); } catch { /* test cleanup */ }
    try { replacementSocket?.close(); } catch { /* test cleanup */ }
    try { restartSocket?.close(); } catch { /* test cleanup */ }
    await disposeRuntime(runtime);
  }
});

test("real WS lifecycle closes on disable, releases the listener, and requires a new pairing after restart", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-ws-lifecycle-"));
  temporaryDirectories.push(root);
  const runtime = await createRuntime(root, "same");
  let oldSocket;
  let newSocket;
  try {
    const ready = await runtime.gateway.start();
    const port = Number(new URL(ready.origin).port);
    const oldCookie = await pair(runtime, port);
    const oldWs = await openWebSocket(port, oldCookie, ready.origin);
    oldSocket = oldWs.socket;
    await oldWs.nextFrame();

    const closed = new Promise((resolve, reject) => {
      oldSocket.once("close", (code) => resolve(code));
      oldSocket.once("error", reject);
    });
    await runtime.gateway.stop();
    assert.equal(await closed, 1001);
    await assertPortCanBind(port);

    const restarted = await runtime.gateway.start();
    const restartedPort = Number(new URL(restarted.origin).port);
    assert.equal((await requestOnce(restartedPort, "/", { Cookie: oldCookie })).statusCode, 401);
    assert.equal(await expectRejectedWebSocket(restartedPort, oldCookie, restarted.origin), 401);

    const newCookie = await pair(runtime, restartedPort);
    const newWs = await openWebSocket(restartedPort, newCookie, restarted.origin);
    newSocket = newWs.socket;
    assert.equal((await newWs.nextFrame()).type, "snapshot");
  } finally {
    try { oldSocket?.close(); } catch { /* test cleanup */ }
    try { newSocket?.close(); } catch { /* test cleanup */ }
    await disposeRuntime(runtime);
  }
});

test("phone media URLs are bound to the issuing paired session and rotate on replacement", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-media-capability-"));
  temporaryDirectories.push(root);
  const runtime = await createRuntime(root, "same");
  let oldSocket;
  let newSocket;
  try {
    const ready = await runtime.gateway.start();
    const port = Number(new URL(ready.origin).port);
    const oldCookie = await pair(runtime, port);
    const item = await runtime.screenshots.capture();
    const screenshotPath = runtime.screenshots.getManagedPaths([item.id])[0];
    const attachment = await runtime.attachments.addFromScreenshot(item, screenshotPath);
    runtime.conversation.addAttachment(attachment);
    const oldWs = await openWebSocket(port, oldCookie, ready.origin);
    oldSocket = oldWs.socket;
    const oldSnapshot = await oldWs.nextFrame();
    const oldContextUrl = oldSnapshot.payload.queue[0].previewUrl;
    assert.match(oldContextUrl, /^\/api\/context\/[0-9a-f]{64}\//);
    const oldAttachmentUrl = oldContextUrl.replace("/api/context/", "/api/attachments/").replace(item.id, attachment.id);
    assert.equal((await requestOnce(port, oldAttachmentUrl, { Cookie: oldCookie })).statusCode, 200);

    await runtime.gateway.regeneratePairing();
    const newCookie = await pair(runtime, port);
    const newWs = await openWebSocket(port, newCookie, ready.origin);
    newSocket = newWs.socket;
    const newSnapshot = await newWs.nextFrame();
    const newContextUrl = newSnapshot.payload.queue[0].previewUrl;
    const newAttachmentUrl = newContextUrl.replace("/api/context/", "/api/attachments/").replace(item.id, attachment.id);
    assert.notEqual(newContextUrl, oldContextUrl);
    assert.equal((await requestOnce(port, oldAttachmentUrl, { Cookie: newCookie })).statusCode, 404);
    assert.equal((await requestOnce(port, newAttachmentUrl, { Cookie: newCookie })).statusCode, 200);
    assert.equal((await requestOnce(port, oldAttachmentUrl, { Cookie: oldCookie })).statusCode, 401);
  } finally {
    try { oldSocket?.close(); } catch { /* test cleanup */ }
    try { newSocket?.close(); } catch { /* test cleanup */ }
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

test("disable quiesces a gated real phone capture before closing and prevents late persistence", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-capture-stop-"));
  temporaryDirectories.push(root);
  const control = { captureGate: deferred(), commandGate: deferred() };
  const runtime = await createRealCommandRuntime(root, control);
  let socket;
  try {
    const ready = await runtime.gateway.start();
    const port = Number(new URL(ready.origin).port);
    const cookie = await pair(runtime, port);
    const phone = await openWebSocket(port, cookie, ready.origin);
    socket = phone.socket;
    await phone.nextFrame();
    socket.send(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId: "capture-stop-quiesce" },
    }));
    await waitFor(() => runtime.screenshots.getState().capturing === true);
    await waitFor(() => [...runtime.gateway.phoneSessions.values()].some((session) => session.inFlight.has("capture-stop-quiesce")));

    await Promise.race([
      runtime.gateway.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("gateway stop did not quiesce capture")), 2_000)),
    ]);
    assert.equal(runtime.screenshots.getState().capturing, false);
    assert.deepEqual(runtime.screenshots.getState().items, []);
    await assertPortCanBind(port);

    control.captureGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(runtime.screenshots.getState().items, []);
  } finally {
    control.captureGate.resolve();
    control.commandGate.resolve();
    try { socket?.close(); } catch { /* test cleanup */ }
    await disposeRealRuntime(runtime);
  }
});

test("same storage paths and real command services clear active capture, streaming, and phone in-flight state on restart", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-real-restart-"));
  temporaryDirectories.push(root);
  const oldControl = {
    captureGate: deferred(),
    commandGate: deferred(),
  };
  const oldRuntime = await createRealCommandRuntime(root, oldControl);
  let oldSocket;
  let freshRuntime;
  let freshSocket;
  let oldContextUrl;
  let oldAttachmentUrl;
  try {
    const ready = await oldRuntime.gateway.start();
    const port = Number(new URL(ready.origin).port);
    const cookie = await pair(oldRuntime, port);
    const phone = await openWebSocket(port, cookie, ready.origin);
    oldSocket = phone.socket;
    assert.equal((await phone.nextFrame()).type, "snapshot");

    oldSocket.send(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId: "restart-capture" },
    }));
    await waitFor(() => oldRuntime.screenshots.getState().capturing === true);
    await waitFor(() => [...oldRuntime.gateway.phoneSessions.values()].some((session) => session.inFlight.has("restart-capture")));
    assert.equal(oldRuntime.projection.getSnapshot().capturing, true);
    oldControl.captureGate.resolve();
    await waitFor(() => oldRuntime.screenshots.getState().items.length === 1);
    await waitFor(() => phone.frames.some((frame) => frame.type === "ack" && frame.requestId === "restart-capture"));
    const queueFrame = phone.frames.find((frame) => frame.type === "snapshot" && frame.payload.queue.length === 1);
    assert.ok(queueFrame);
    oldContextUrl = queueFrame.payload.queue[0].previewUrl;

    oldSocket.send(JSON.stringify({
      type: "command",
      command: { type: "send", requestId: "restart-send", prompt: "hold this real stream" },
    }));
    await waitFor(() => oldRuntime.analysis.getState().status === "running");
    await waitFor(() => oldRuntime.conversation.snapshot().messages.some((message) => message.status === "streaming"));
    await waitFor(() => [...oldRuntime.gateway.phoneSessions.values()].some((session) => session.inFlight.has("restart-send")));
    assert.equal(oldRuntime.projection.getSnapshot().conversation.activeMessageId !== undefined, true);
    assert.equal(oldRuntime.projection.getSnapshot().conversation.messages.some((message) => message.status === "streaming"), true);
    assert.equal(oldRuntime.analysis.getState().status, "running");
    assert.equal(oldRuntime.screenshots.getState().capturing, false);
    assert.equal(oldRuntime.conversation.snapshot().attachments.length, 1);
    oldAttachmentUrl = oldContextUrl
      .replace("/api/context/", "/api/attachments/")
      .replace(oldRuntime.screenshotId, oldRuntime.attachmentId);
    const oldScreenshotPath = oldRuntime.screenshots.getManagedPaths([oldRuntime.screenshotId])[0];
    const oldAttachmentPath = oldRuntime.attachments.getPath(oldRuntime.attachmentId);
    assert.ok(oldScreenshotPath);
    assert.ok(oldAttachmentPath);
    assert.deepEqual(await readFile(oldScreenshotPath), PNG_BYTES);
    assert.deepEqual(await readFile(oldAttachmentPath), PNG_BYTES);

    await abandonRuntime(oldRuntime);
    const stoppedSnapshot = oldRuntime.projection.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(oldRuntime.projection.getSnapshot(), stoppedSnapshot);

    const freshControl = {
      captureGate: deferred(),
      commandGate: deferred(),
    };
    freshControl.captureGate.resolve();
    freshControl.commandGate.resolve();
    freshRuntime = await createRealCommandRuntime(root, freshControl);
    assert.deepEqual(freshRuntime.screenshots.getState().items, []);
    assert.equal(freshRuntime.screenshots.getState().capturing, false);
    assert.deepEqual(freshRuntime.attachments.list(), []);
    assert.deepEqual(freshRuntime.conversation.snapshot().messages, []);
    assert.deepEqual(freshRuntime.conversation.snapshot().attachments, []);
    assert.equal(freshRuntime.conversation.snapshot().activeMessageId, undefined);
    assert.deepEqual(freshRuntime.projection.getSnapshot().queue, []);
    assert.deepEqual(freshRuntime.projection.getSnapshot().conversation.messages, []);
    assert.deepEqual(freshRuntime.projection.getSnapshot().conversation.attachments, []);
    assert.equal(freshRuntime.projection.getSnapshot().capturing, false);
    assert.equal(freshRuntime.analysis.getState().status, "idle");
    await assert.rejects(readFile(oldScreenshotPath));
    await assert.rejects(readFile(oldAttachmentPath));

    const freshReady = await freshRuntime.gateway.start();
    const freshPort = Number(new URL(freshReady.origin).port);
    const freshCookie = await pair(freshRuntime, freshPort);
    const freshPhone = await openWebSocket(freshPort, freshCookie, freshReady.origin);
    freshSocket = freshPhone.socket;
    const freshSnapshot = await freshPhone.nextFrame();
    assert.deepEqual(freshSnapshot.payload.queue, []);
    assert.deepEqual(freshSnapshot.payload.conversation.messages, []);
    assert.deepEqual(freshSnapshot.payload.conversation.attachments, []);
    assert.equal(freshSnapshot.payload.capturing, false);
    assert.match(freshSnapshot.payload.mediaCapability, /^[0-9a-f]{64}$/);
    assert.equal((await requestOnce(freshPort, oldAttachmentUrl, { Cookie: freshCookie })).statusCode, 404);
    assert.equal(freshRuntime.analysis.getState().status, "idle");
    await freshRuntime.router.whenIdle();
    assert.equal([...freshRuntime.gateway.phoneSessions.values()].every((session) =>
      session.inFlight.size === 0 && session.settledLedger.size === 0), true);
  } finally {
    oldControl.commandGate.resolve();
    oldControl.releaseAnalysis?.();
    try { oldSocket?.close(); } catch { /* test cleanup */ }
    try { freshSocket?.close(); } catch { /* test cleanup */ }
    if (freshRuntime) {
      await disposeRealRuntime(freshRuntime);
    } else {
      await abandonRuntime(oldRuntime);
    }
  }
});
