import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, afterEach } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "../smoke-packaged.mjs");
let smokeModule;
try {
  smokeModule = await import(pathToFileURL(scriptPath).href);
} catch {
  smokeModule = {};
}
const tempDirectories = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("packaged smoke locates exactly one app and rejects missing or ambiguous output", async () => {
  assert.equal(typeof smokeModule.findPackagedApp, "function");
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "fluely-packaged-test-"));
  tempDirectories.push(outputDirectory);
  const appPath = path.join(outputDirectory, "mac", "Fluely.app");
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  assert.equal(await smokeModule.findPackagedApp(outputDirectory), appPath);

  await assert.rejects(() => smokeModule.findPackagedApp(path.join(outputDirectory, "missing")));
  const second = path.join(outputDirectory, "other", "Other.app", "Contents", "MacOS");
  await mkdir(second, { recursive: true });
  await assert.rejects(() => smokeModule.findPackagedApp(outputDirectory));
});
