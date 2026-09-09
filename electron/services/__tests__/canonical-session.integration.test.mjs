import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const paths = {
  projection: path.resolve(__dirname, "../../../dist-electron/src/shared/conversation.js"),
  screenshot: path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js"),
  attachment: path.resolve(__dirname, "../../../dist-electron/electron/services/AttachmentStore.js"),
  conversation: path.resolve(__dirname, "../../../dist-electron/electron/services/ConversationStore.js"),
  analysis: path.resolve(__dirname, "../../../dist-electron/electron/services/AnalysisService.js"),
  router: path.resolve(__dirname, "../../../dist-electron/electron/services/CommandRouter.js"),
  media: path.resolve(__dirname, "../../../dist-electron/electron/services/session-media-protocol.js"),
};
const [{ createConversationProjection }, { ScreenshotService }, { AttachmentStore }, { ConversationStore }, { AnalysisService }, { CommandRouter }, { createSessionMediaHandler }] = await Promise.all(
  Object.values(paths).map((modulePath) => import(pathToFileURL(modulePath).href)),
);

const SCREENSHOT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeSession(provider) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-canonical-session-"));
  temporaryDirectories.push(root);
  const screenshotDirectory = path.join(root, "screenshots");
  const attachmentDirectory = path.join(root, "session-attachments");
  let screenshotCounter = 0;
  const screenshots = new ScreenshotService({
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
    idFactory: () => screenshotCounter++ === 0 ? SCREENSHOT_ID : "22222222-2222-4222-8222-222222222222",
    now: () => new Date(100),
  });
  const attachments = new AttachmentStore({
    rootDirectory: attachmentDirectory,
    sessionId: "session-integration",
    idFactory: () => ATTACHMENT_ID,
    now: () => 200,
  });
  await Promise.all([screenshots.whenIdle(), attachments.whenReady()]);
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
  return { screenshots, attachments, conversation, analysis, router };
}

test("real services capture, materialize, stream, complete, clear the queue, and serve the sent attachment", async () => {
  const session = await makeSession({
    stream: async function* () {
      yield "streamed";
      yield " answer";
    },
  });
  const events = [];
  session.conversation.subscribe((event) => events.push(event));

  await session.router.execute({ type: "capture", requestId: "capture-integration" }, "desktop");
  const started = await session.router.execute({ type: "ask", requestId: "ask-integration", prompt: "Question" }, "desktop");
  assert.deepEqual(started.queue.items.map((item) => item.id), [SCREENSHOT_ID]);
  await session.analysis.whenIdle();
  await session.router.whenIdle();

  const snapshot = session.conversation.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.status, message.text]), [
    ["user", "completed", "Question"],
    ["assistant", "completed", "streamed answer"],
  ]);
  assert.deepEqual(snapshot.messages[0].attachmentIds, [ATTACHMENT_ID]);
  assert.deepEqual(session.screenshots.getState().items.map((item) => item.id), []);
  assert.deepEqual(events.map((event) => event.type), [
    "attachment-added",
    "message-added",
    "message-added",
    "message-updated",
    "message-updated",
    "message-updated",
  ]);

  const media = createSessionMediaHandler({
    context: session.screenshots,
    attachments: session.attachments,
  });
  const response = await media(new Request(`fluely-media://attachment/${ATTACHMENT_ID}`));
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
  assert.deepEqual(new Uint8Array(await readFile(session.attachments.getPath(ATTACHMENT_ID))), PNG_BYTES);
});

test("real conversation projection replaces a stale desktop state after a revision gap and resumes ordered events", async () => {
  const session = await makeSession({
    stream: async function* () {
      yield "answer";
    },
  });
  const emitted = [];
  session.conversation.subscribe((event) => emitted.push(event));
  const projection = createConversationProjection(session.conversation.snapshot(), async () => session.conversation.snapshot());

  await session.router.execute({ type: "capture", requestId: "projection-capture" }, "desktop");
  await session.router.execute({ type: "ask", requestId: "projection-ask", prompt: "Question" }, "desktop");
  await session.analysis.whenIdle();

  const gap = await projection.apply(emitted.at(-1));
  assert.equal(gap.status, "gap");
  assert.deepEqual(projection.snapshot(), session.conversation.snapshot());
  assert.equal(projection.snapshot().revision, session.conversation.snapshot().revision);
});
