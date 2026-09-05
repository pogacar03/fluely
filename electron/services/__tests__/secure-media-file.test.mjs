import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/secure-media-file.js");
const {
  createSecureMediaReader,
  MAX_SECURE_MEDIA_BYTES,
  readSecureMediaFile,
} = await import(pathToFileURL(modulePath).href);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x02, 0x03,
]);

async function makeRoot() {
  return mkdtemp(path.join(os.tmpdir(), "fluely-secure-media-"));
}

async function makePrivateFile(filePath, bytes = PNG_BYTES) {
  await writeFile(filePath, bytes, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

test("secure media reads only owner-only regular files through O_NOFOLLOW and rejects unsafe size/type/mode", async () => {
  assert.equal(typeof createSecureMediaReader, "function");
  assert.equal(typeof readSecureMediaFile, "function");
  assert.equal(Number.isSafeInteger(MAX_SECURE_MEDIA_BYTES), true);

  const root = await makeRoot();
  try {
    const safePath = path.join(root, "safe.png");
    const symlinkPath = path.join(root, "linked.png");
    const directoryPath = path.join(root, "directory.png");
    const wrongModePath = path.join(root, "wrong-mode.png");
    const oversizedPath = path.join(root, "oversized.png");
    await makePrivateFile(safePath);
    await symlink(safePath, symlinkPath);
    await mkdir(directoryPath, { mode: 0o700 });
    await makePrivateFile(wrongModePath);
    await chmod(wrongModePath, 0o644);
    await makePrivateFile(oversizedPath, new Uint8Array(1));
    await (await import("node:fs/promises")).truncate(oversizedPath, MAX_SECURE_MEDIA_BYTES + 1);

    assert.deepEqual(new Uint8Array(await readSecureMediaFile(safePath, root)), PNG_BYTES);
    for (const unsafePath of [symlinkPath, directoryPath, wrongModePath, oversizedPath]) {
      await assert.rejects(
        readSecureMediaFile(unsafePath, root),
        (error) => error instanceof Error &&
          !error.message.includes(unsafePath) &&
          !error.message.includes("ENOENT"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure media keeps reading the opened inode when its pathname is swapped and closes the fd", async () => {
  const root = await makeRoot();
  try {
    const racePath = path.join(root, "race.png");
    const originalPath = path.join(root, "race-original.png");
    const replacementPath = path.join(root, "race-replacement.png");
    const originalBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x10, 0x11, 0x12,
    ]);
    const replacementBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0xf0, 0xf1, 0xf2,
    ]);
    await makePrivateFile(racePath, originalBytes);
    await makePrivateFile(replacementPath, replacementBytes);

    let openFlags = 0;
    let closed = false;
    const reader = createSecureMediaReader({
      openFile: async (filePath, flags) => {
        openFlags = flags;
        const handle = await open(filePath, flags);
        await rename(filePath, originalPath);
        await rename(replacementPath, filePath);
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          closed = true;
          return originalClose();
        };
        return handle;
      },
    });

    assert.deepEqual(new Uint8Array(await reader(racePath, root)), originalBytes);
    assert.equal(openFlags & constants.O_RDONLY, constants.O_RDONLY);
    assert.equal(openFlags & (constants.O_WRONLY | constants.O_RDWR), 0);
    assert.equal(openFlags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
    assert.equal(closed, true);
    assert.deepEqual(new Uint8Array(await readFile(racePath)), replacementBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure media fails closed when the owner or no-follow primitive is unavailable", async () => {
  const root = await makeRoot();
  try {
    const safePath = path.join(root, "safe.png");
    await makePrivateFile(safePath);
    let openCalls = 0;
    const openFile = async (filePath, flags) => {
      openCalls += 1;
      return open(filePath, flags);
    };

    await assert.rejects(
      createSecureMediaReader({
        openFile,
        getUid: () => undefined,
        noFollowFlag: constants.O_NOFOLLOW,
      })(safePath, root),
      (error) => error instanceof Error && !error.message.includes(safePath),
    );
    await assert.rejects(
      createSecureMediaReader({
        openFile,
        getUid: () => process.getuid?.(),
        noFollowFlag: null,
      })(safePath, root),
      (error) => error instanceof Error && !error.message.includes(safePath),
    );
    assert.equal(openCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure media rejects an owner-only file reached through an intermediate directory symlink", async () => {
  const root = await makeRoot();
  try {
    const managedRoot = path.join(root, "managed");
    const outsideRoot = path.join(root, "outside");
    await mkdir(managedRoot, { mode: 0o700 });
    await mkdir(outsideRoot, { mode: 0o700 });
    const outsidePath = path.join(outsideRoot, "secret.png");
    await makePrivateFile(outsidePath, new Uint8Array([...PNG_BYTES, 0xf0]));
    const linkedDirectory = path.join(managedRoot, "nested");
    await symlink(outsideRoot, linkedDirectory, "dir");

    await assert.rejects(
      readSecureMediaFile(path.join(linkedDirectory, "secret.png"), managedRoot),
      (error) => error instanceof Error && !error.message.includes(outsidePath),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure media rejects a device/inode change that happens before the descriptor is opened", async () => {
  const root = await makeRoot();
  try {
    const racePath = path.join(root, "race-before-open.png");
    const originalPath = path.join(root, "race-before-open-original.png");
    const replacementPath = path.join(root, "race-before-open-replacement.png");
    await makePrivateFile(racePath, PNG_BYTES);
    await makePrivateFile(replacementPath, new Uint8Array([...PNG_BYTES, 0xf0]));

    let closed = false;
    const reader = createSecureMediaReader({
      openFile: async (filePath, flags) => {
        await rename(filePath, originalPath);
        await rename(replacementPath, filePath);
        const handle = await open(filePath, flags);
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          closed = true;
          return originalClose();
        };
        return handle;
      },
    });

    await assert.rejects(
      reader(racePath, root),
      (error) => error instanceof Error && !error.message.includes(racePath),
    );
    assert.equal(closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
