import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/ScreenshotService.js");
const { ScreenshotService } = await import(pathToFileURL(modulePath).href);

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fluely-screenshots-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeThumbnail(bytes, width = 1920, height = 1080) {
  return {
    toPNG: () => Buffer.from(bytes),
    getSize: () => ({ width, height }),
  };
}

function makeAdapters({
  platform = "linux",
  permission = "granted",
  displayId = 42,
  sources = [{ display_id: "42", thumbnail: makeThumbnail("png-bytes") }],
  getSources,
} = {}) {
  const sourceCalls = [];
  const desktopCapturer = {
    getSources: async (options) => {
      sourceCalls.push(options);
      if (getSources) {
        return getSources(options);
      }
      return sources;
    },
  };
  const screen = {
    getCursorScreenPoint: () => ({ x: 100, y: 200 }),
    getDisplayNearestPoint: () => ({ id: displayId }),
  };
  const systemPreferences = {
    getMediaAccessStatus: () => permission,
  };

  return { platform, desktopCapturer, screen, systemPreferences, sourceCalls };
}

function makeService(directory, adapters, options = {}) {
  return new ScreenshotService({
    directory,
    ...adapters,
    idFactory: options.idFactory,
    now: options.now,
    sourceTimeoutMs: options.sourceTimeoutMs,
  });
}

test("ScreenshotService maps macOS screen permission states to actionable errors", async () => {
  const cases = [
    ["denied", "SCREEN_CAPTURE_DENIED"],
    ["restricted", "SCREEN_CAPTURE_RESTRICTED"],
    ["not-determined", "SCREEN_CAPTURE_PERMISSION_REQUIRED"],
  ];

  for (const [permission, code] of cases) {
    const directory = await makeDirectory();
    const adapters = makeAdapters({ platform: "darwin", permission });
    const service = makeService(directory, adapters);

    await assert.rejects(service.capture(), (error) => error?.code === code);
    assert.equal(service.getState().permission, permission);
    assert.equal(service.getState().capturing, false);
  }
});

test("ScreenshotService times out source enumeration after the configured five-second limit", async () => {
  const directory = await makeDirectory();
  const adapters = makeAdapters({ getSources: () => new Promise(() => undefined) });
  const service = makeService(directory, adapters, { sourceTimeoutMs: 5 });

  await assert.rejects(
    service.capture(),
    (error) => error?.code === "SCREEN_CAPTURE_FAILED",
  );
  assert.equal(service.getState().capturing, false);
});

test("ScreenshotService selects the source matching the display nearest the cursor", async () => {
  const directory = await makeDirectory();
  const adapters = makeAdapters({
    displayId: 9,
    sources: [
      { display_id: "42", thumbnail: makeThumbnail("wrong-display") },
      { display_id: "9", thumbnail: makeThumbnail("selected-display", 1440, 900) },
    ],
  });
  const service = makeService(directory, adapters, {
    idFactory: () => "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-08-30T10:20:30.000Z"),
  });

  const item = await service.capture();
  const stored = await readFile(path.join(directory, `${item.id}.png`), "utf8");

  assert.equal(stored, "selected-display");
  assert.deepEqual(adapters.sourceCalls, [{
    types: ["screen"],
    thumbnailSize: { width: 3840, height: 2160 },
  }]);
  assert.deepEqual(item, {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-08-30T10:20:30.000Z",
    width: 1440,
    height: 900,
  });
});

test("ScreenshotService persists PNG bytes through a temporary file and rename", async () => {
  const directory = await makeDirectory();
  const adapters = makeAdapters();
  const service = makeService(directory, adapters, {
    idFactory: () => "22222222-2222-4222-8222-222222222222",
    now: () => new Date("2026-08-30T11:00:00.000Z"),
  });

  const item = await service.capture();
  const files = await readdir(directory);

  assert.deepEqual(item, {
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-08-30T11:00:00.000Z",
    width: 1920,
    height: 1080,
  });
  assert.equal(await readFile(path.join(directory, `${item.id}.png`), "utf8"), "png-bytes");
  assert.deepEqual(files, [`${item.id}.png`]);
});

test("ScreenshotService evicts the oldest file when the queue exceeds five items", async () => {
  const directory = await makeDirectory();
  let nextId = 0;
  const adapters = makeAdapters();
  const service = makeService(directory, adapters, {
    idFactory: () => `shot-${++nextId}`,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  });

  for (let index = 0; index < 6; index += 1) {
    await service.capture();
  }

  const state = service.getState();
  const files = (await readdir(directory)).sort();

  assert.deepEqual(state.items.map((item) => item.id), ["shot-2", "shot-3", "shot-4", "shot-5", "shot-6"]);
  assert.equal(state.items.length, 5);
  assert.deepEqual(files, ["shot-2.png", "shot-3.png", "shot-4.png", "shot-5.png", "shot-6.png"]);
});

test("ScreenshotService deletes only known queue IDs and can clear the queue", async () => {
  const directory = await makeDirectory();
  let nextId = 0;
  const adapters = makeAdapters();
  const service = makeService(directory, adapters, {
    idFactory: () => `33333333-3333-4333-8333-33333333333${++nextId}`,
  });

  const first = await service.capture();
  const second = await service.capture();

  await assert.rejects(
    service.delete("../settings.json"),
    (error) => error?.code === "SCREENSHOT_NOT_FOUND",
  );
  assert.equal((await readdir(directory)).length, 2);

  const afterDelete = await service.delete(first.id);
  assert.deepEqual(afterDelete.items.map((item) => item.id), [second.id]);
  assert.equal((await readdir(directory)).includes(`${first.id}.png`), false);

  const afterClear = await service.clear();
  assert.deepEqual(afterClear.items, []);
  assert.deepEqual(await readdir(directory), []);
});

test("ScreenshotService releases its capturing flag after adapter errors", async () => {
  const directory = await makeDirectory();
  let shouldFail = true;
  const adapters = makeAdapters({
    getSources: () => {
      if (shouldFail) {
        throw new Error("desktop capture unavailable");
      }
      return [{ display_id: "42", thumbnail: makeThumbnail("recovered") }];
    },
  });
  let nextId = 0;
  const service = makeService(directory, adapters, {
    idFactory: () => `44444444-4444-4444-8444-44444444444${++nextId}`,
  });

  await assert.rejects(service.capture(), (error) => error?.code === "SCREEN_CAPTURE_FAILED");
  assert.equal(service.getState().capturing, false);

  shouldFail = false;
  const recovered = await service.capture();
  assert.equal(recovered.id, "44444444-4444-4444-8444-444444444441");
  assert.equal(service.getState().capturing, false);
});
