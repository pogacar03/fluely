import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/SettingsService.js");
const corePath = path.resolve(__dirname, "../../../dist-electron/electron/services/settings-core.js");
const { SettingsService } = await import(pathToFileURL(modulePath).href);
const { DEFAULT_SETTINGS } = await import(pathToFileURL(corePath).href);

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fluely-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("SettingsService loads defaults without requiring an existing file", async () => {
  const directory = await makeDirectory();
  const service = new SettingsService(directory);

  const result = await service.load();

  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
  assert.equal(result.warning, undefined);
});

test("SettingsService writes normalized settings through an atomic 0600 file", async () => {
  const directory = await makeDirectory();
  const service = new SettingsService(directory);
  await service.load();

  const result = await service.update({ window: { width: 200, height: 900 } });
  const settingsPath = path.join(directory, "settings.json");
  const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
  const fileInfo = await stat(settingsPath);
  const files = await readdir(directory);

  assert.equal(result.ok, true);
  assert.deepEqual(onDisk, result.value);
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.deepEqual(files.filter((file) => file.includes(".tmp-")), []);
  assert.equal(result.value.window.width, 480);
});

test("SettingsService backs up malformed JSON before returning defaults", async () => {
  const directory = await makeDirectory();
  await writeFile(path.join(directory, "settings.json"), "{malformed", "utf8");
  const service = new SettingsService(directory);

  const result = await service.load();
  const files = await readdir(directory);

  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
  assert.equal(result.warning.code, "SETTINGS_READ_FAILED");
  assert.equal(files.filter((file) => file.startsWith("settings.invalid-")).length, 1);
});

test("SettingsService rejects invalid update payloads without writing", async () => {
  const directory = await makeDirectory();
  const service = new SettingsService(directory);
  await service.load();

  const result = await service.update({ shortcuts: { analyzeQueue: 42 } });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal((await readdir(directory)).includes("settings.json"), false);
});
