import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const configPath = join(root, "electron-builder.yml");
const releasePath = join(root, "release");

function fail(message) {
  console.error(`Package allowlist check failed: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(configPath)) {
  fail("electron-builder.yml is missing.");
  process.exit();
}

const config = readFileSync(configPath, "utf8");
const filesBlock = config.split("files:")[1]?.split("asar:")[0] ?? "";
const positivePatterns = filesBlock
  .split("\n")
  .map((line) => line.match(/^\s+-\s+([^!].*)$/)?.[1]?.trim())
  .filter(Boolean);

for (const requiredPattern of ["dist/**", "dist-electron/**", "dist-phone/**", "package.json"]) {
  if (!positivePatterns.includes(requiredPattern)) {
    fail(`required allowlist entry is missing: ${requiredPattern}`);
  }
}

if (positivePatterns.some((pattern) => pattern.includes("node_modules"))) {
  fail("a blanket node_modules allowlist is forbidden.");
}

if (!/^asar:\s+true\s*$/m.test(config)) {
  fail("asar must be enabled.");
}

if (!existsSync(releasePath)) {
  fail("release/ does not exist; run npm run package:dir first.");
  process.exit();
}

const asarSearch = spawnSync("find", [releasePath, "-type", "f", "-name", "app.asar", "-print"], {
  encoding: "utf8",
});
const asarPath = asarSearch.stdout.trim().split("\n").filter(Boolean)[0];
if (!asarPath) {
  fail("no packaged app.asar was found under release/.");
  process.exit();
}

const asarCommand = join(root, "node_modules", ".bin", "asar");
if (!existsSync(asarCommand)) {
  fail("the asar inspection tool is unavailable.");
  process.exit();
}

const listing = spawnSync(asarCommand, ["list", asarPath], { encoding: "utf8" });
if (listing.status !== 0) {
  fail(`could not inspect ${relative(root, asarPath)}.`);
  process.exit();
}

const forbidden = listing.stdout.split("\n").filter((entry) =>
  entry.endsWith(".map") || entry.includes(".test.") || entry.endsWith("/.env") || entry.includes("/.env."),
);
if (forbidden.length > 0) {
  fail(`forbidden files are packaged: ${forbidden.join(", ")}`);
}

for (const requiredAsset of [
  "/dist-phone/index.html",
  "/dist-phone/phone.css",
  "/dist-phone/phone.js",
]) {
  if (!listing.stdout.split("\n").includes(requiredAsset)) {
    fail(`required phone asset is missing from app.asar: ${requiredAsset}`);
  }
}

if (process.exitCode !== 1) {
  console.log(`Package allowlist passed: ${relative(root, asarPath)}`);
}
