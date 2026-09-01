import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/AttachmentStore.js");
const { AttachmentStore, MAX_ATTACHMENT_BYTES } = await import(pathToFileURL(modulePath).href);

const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x01, 0x02, 0x03,
]);

const temporaryDirectories = [];

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-attachments-"));
  temporaryDirectories.push(root);
  return root;
}

async function makeSource(root, bytes = PNG_BYTES) {
  const source = path.join(root, `${SOURCE_ID}.png`);
  await writeFile(source, bytes);
  return source;
}

function makeStore(root, overrides = {}) {
  return new AttachmentStore({
    rootDirectory: root,
    sessionId: "session-current",
    idFactory: () => ATTACHMENT_ID,
    now: () => 1234,
    ...overrides,
  });
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test("AttachmentStore cleans stale sessions and creates owner-only directories", async () => {
  const root = await makeRoot();
  const stale = path.join(root, "session-stale");
  await mkdir(stale, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stale, "old.png"), PNG_BYTES);

  const store = makeStore(root);
  await store.whenReady();

  await assert.rejects(stat(stale), { code: "ENOENT" });
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  await store.dispose();
});

test("AttachmentStore atomically copies PNG bytes with immutable metadata and mode 0600", async () => {
  const root = await makeRoot();
  const source = await makeSource(root);
  const store = makeStore(root);
  await store.whenReady();

  const attachment = await store.addFromFile(source, { width: 1920, height: 1080 });

  assert.equal(attachment.id, ATTACHMENT_ID);
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.byteLength, PNG_BYTES.byteLength);
  assert.equal(store.getPath(attachment.id), path.join(store.directory, `${ATTACHMENT_ID}.png`));
  assert.deepEqual(new Uint8Array(await readFile(store.getPath(attachment.id))), PNG_BYTES);
  assert.equal((await stat(store.getPath(attachment.id))).mode & 0o777, 0o600);
  await assert.rejects(stat(path.join(store.directory, `${ATTACHMENT_ID}.png.tmp`)), { code: "ENOENT" });
  assert.deepEqual(store.getMetadata(attachment.id), attachment);
  await store.dispose();
});

test("AttachmentStore rejects malformed, traversal, unknown, and cross-namespace IDs", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  await store.whenReady();

  for (const id of ["../settings.json", "context/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "attachment-1", ""]) {
    assert.equal(store.getPath(id), undefined);
    assert.equal(store.getMetadata(id), undefined);
  }
  assert.equal(store.getPath(ATTACHMENT_ID), undefined);
  await store.dispose();
});

test("AttachmentStore rejects a single source larger than 20 MiB before writing", async () => {
  const root = await makeRoot();
  const source = await makeSource(root, new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
  const store = makeStore(root);
  await store.whenReady();

  await assert.rejects(
    store.addFromFile(source, { width: 1, height: 1 }),
    (error) => error?.code === "ATTACHMENT_TOO_LARGE",
  );
  assert.equal(store.getMetadata(ATTACHMENT_ID), undefined);
  await store.dispose();
});

test("AttachmentStore deletes only unreferenced registered attachments", async () => {
  const root = await makeRoot();
  const source = await makeSource(root);
  let nextId = 0;
  const store = makeStore(root, {
    idFactory: () => [ATTACHMENT_ID, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"][nextId++],
  });
  await store.whenReady();
  const first = await store.addFromFile(source, { width: 1, height: 1 });
  const second = await store.addFromFile(source, { width: 1, height: 1 });

  const removed = await store.deleteUnreferenced([first.id, second.id], new Set([first.id]));

  assert.deepEqual(removed, [second.id]);
  assert.notEqual(store.getPath(first.id), undefined);
  assert.equal(store.getPath(second.id), undefined);
  await store.dispose();
});
