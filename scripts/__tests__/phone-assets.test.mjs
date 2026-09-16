import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

test("phone assets are fixed local files in source and development output", async () => {
  const sourceRoot = path.join(projectRoot, "electron", "phone");
  const outputRoot = path.join(projectRoot, "dist-phone");
  const [sourceHtml, sourceCss, sourceScript, outputHtml, outputCss, outputScript] = await Promise.all([
    readFile(path.join(sourceRoot, "index.html"), "utf8"),
    readFile(path.join(sourceRoot, "phone.css"), "utf8"),
    readFile(path.join(sourceRoot, "phone.ts"), "utf8"),
    readFile(path.join(outputRoot, "index.html"), "utf8"),
    readFile(path.join(outputRoot, "phone.css"), "utf8"),
    readFile(path.join(outputRoot, "phone.js"), "utf8"),
  ]);

  assert.equal(outputHtml, sourceHtml);
  assert.equal(outputCss, sourceCss);
  assert.match(outputHtml, /src="\/phone\.js"/);
  assert.match(outputHtml, /href="\/phone\.css"/);
  for (const asset of [sourceHtml, sourceCss, sourceScript, outputHtml, outputCss, outputScript]) {
    assert.doesNotMatch(asset, /https?:\/\//);
    assert.doesNotMatch(asset, /\/Users\//);
    assert.doesNotMatch(asset, /fluely_phone_session/);
  }
});

test("packaging allowlist includes the complete phone asset directory", async () => {
  const builderConfig = await readFile(path.join(projectRoot, "electron-builder.yml"), "utf8");
  assert.match(builderConfig, /^\s*- dist-phone\/\*\*\s*$/m);
});
