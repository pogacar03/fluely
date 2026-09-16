import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const preloadSource = await readFile(
  new URL("../../../dist-electron/electron/preload.js", import.meta.url),
  "utf8",
);

test("sandboxed preload does not require local application modules", () => {
  assert.doesNotMatch(preloadSource, /require\(["']\.\//);
  assert.match(preloadSource, /exposeInMainWorld/);
});
