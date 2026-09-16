import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
  if (typeof process.getuid === "function") {
    assert.equal((await stat(root)).uid, process.getuid());
    assert.equal((await stat(store.directory)).uid, process.getuid());
  }
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

test("AttachmentStore does not expose filesystem read errors from an invalid source", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  await store.whenReady();

  await assert.rejects(
    store.addFromFile(root, { width: 1, height: 1 }),
    (error) => error?.code === "INVALID_ATTACHMENT" &&
      !String(error?.message).includes(root) &&
      !String(error?.message).includes("EISDIR"),
  );
  assert.equal(store.list().length, 0);
  await store.dispose();
});

test("AttachmentStore retains the original stat failure as an internal cause", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  await store.whenReady();
  const missingSource = path.join(root, "missing-source.png");
  let failure;

  await assert.rejects(
    store.addFromFile(missingSource, { width: 1, height: 1 }),
    (error) => {
      failure = error;
      return error?.code === "INVALID_ATTACHMENT" && error?.cause?.code === "ENOENT";
    },
  );
  assert.doesNotMatch(failure.message, /missing-source|ENOENT/);
  await store.dispose();
});

test("AttachmentStore rejects symlink and non-directory roots before touching another target", async () => {
  const target = await makeRoot();
  const parent = await makeRoot();
  const linkedRoot = path.join(parent, "linked-root");
  await symlink(target, linkedRoot, "dir");

  const linkedStore = makeStore(linkedRoot);
  await assert.rejects(linkedStore.whenReady(), (error) => error?.code === "ATTACHMENT_STORE_INVALID_ROOT");
  await assert.rejects(stat(path.join(target, "session-current")), { code: "ENOENT" });

  const fileRoot = path.join(parent, "file-root");
  await writeFile(fileRoot, PNG_BYTES);
  const fileStore = makeStore(fileRoot);
  await assert.rejects(fileStore.whenReady(), (error) => error?.code === "ATTACHMENT_STORE_INVALID_ROOT");
});

test("AttachmentStore keeps a registration when delete fails and removes it on a later retry", async () => {
  const root = await makeRoot();
  const source = await makeSource(root);
  let failCleanup = true;
  const store = makeStore(root, {
    unlinkFile: async (filePath) => {
      if (failCleanup) {
        throw Object.assign(new Error("disk cleanup failed"), { code: "EIO" });
      }
      await unlink(filePath);
    },
  });
  await store.whenReady();
  const attachment = await store.addFromFile(source, { width: 1, height: 1 });
  const managedPath = store.getPath(attachment.id);

  await assert.rejects(store.delete(attachment.id), (error) => error?.code === "ATTACHMENT_CLEANUP_FAILED");
  assert.equal(store.getPath(attachment.id), managedPath);
  assert.deepEqual(store.list().map((item) => item.id), [attachment.id]);

  failCleanup = false;
  assert.equal(await store.delete(attachment.id), true);
  assert.equal(store.getPath(attachment.id), undefined);
  await assert.rejects(stat(managedPath), { code: "ENOENT" });
  await store.dispose();
});
