import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../check-package-allowlist.mjs");
const packageAllowlist = await import(pathToFileURL(modulePath).href);

const REQUIRED_ENTRIES = [
  "/dist-electron/electron/main.js",
  "/dist/index.html",
  "/dist-phone/index.html",
  "/dist-phone/phone.css",
  "/dist-phone/phone.js",
  "/package.json",
];

test("packaged contents require runtime entrypoints and reject development source leakage", () => {
  assert.equal(typeof packageAllowlist.validatePackageContents, "function");

  const listing = [
    ...REQUIRED_ENTRIES,
    "/electron/main.ts",
    "/src/renderer/App.tsx",
    "/scripts/smoke-packaged.mjs",
  ].join("\n");

  const errors = packageAllowlist.validatePackageContents(listing, {
    packageJson: { main: "dist-electron/electron/main.js" },
  });

  assert.ok(errors.some((error) => /development source/i.test(error)));
  assert.ok(errors.some((error) => error.includes("/electron/main.ts")));
});

test("packaged contents accept the exact compiled runtime allowlist", () => {
  const listing = REQUIRED_ENTRIES.join("\n");
  assert.deepEqual(
    packageAllowlist.validatePackageContents(listing, {
      packageJson: { main: "dist-electron/electron/main.js" },
    }),
    [],
  );
});

test("renderer assets must be hashed files referenced by the packaged index", () => {
  const referenced = "/dist/assets/index-Ab_C12.js";
  const listing = [...REQUIRED_ENTRIES, referenced, "/dist/assets/index-Unreferenced.css"].join("\n");
  const errors = packageAllowlist.validatePackageContents(listing, {
    packageJson: { main: "dist-electron/electron/main.js" },
    rendererAssetPaths: [referenced],
  });
  assert.equal(errors.some((error) => error.includes(referenced)), false);
  assert.ok(errors.some((error) => error.includes("/dist/assets/index-Unreferenced.css")));
  assert.deepEqual(
    packageAllowlist.rendererAssetsFromIndex('<script src="./assets/index-Ab_C12.js"></script>'),
    [referenced],
  );
  assert.throws(
    () => packageAllowlist.rendererAssetsFromIndex('<script src="./assets/dev.js"></script>'),
    /unexpected asset/i,
  );

  const missingErrors = packageAllowlist.validatePackageContents(REQUIRED_ENTRIES.join("\n"), {
    packageJson: { main: "dist-electron/electron/main.js" },
    rendererAssetPaths: [referenced],
  });
  assert.ok(missingErrors.some((error) => error.includes(referenced) && /missing/i.test(error)));
});

test("manifest rejects app-owned malicious fixtures while allowing a runtime dependency test file", () => {
  const listing = [
    ...REQUIRED_ENTRIES,
    "/dist/__tests__/leaked.mjs",
    "/dist/test-helper.js",
    "/dist/foo.spec.mjs",
    "/dist/config.env",
    "/dist/coverage/report.json",
    "/dist/secret.json",
    "/dist/dev.js",
    "/secret.txt",
    "/node_modules/pkg/test.js",
    "/node_modules/pkg/.npmrc",
    "/node_modules/pkg/credentials.json",
    "/node_modules/pkg/private.key",
    "/node_modules/pkg/coverage/report.json",
    "/node_modules/pkg/config.env",
  ].join("\n");

  const errors = packageAllowlist.validatePackageContents(listing, {
    packageJson: { main: "dist-electron/electron/main.js" },
    runtimePackageRoots: ["/node_modules/pkg"],
  });

  for (const fixture of [
    "/dist/__tests__/leaked.mjs",
    "/dist/test-helper.js",
    "/dist/foo.spec.mjs",
    "/dist/config.env",
    "/dist/coverage/report.json",
    "/dist/secret.json",
    "/dist/dev.js",
    "/secret.txt",
    "/node_modules/pkg/.npmrc",
    "/node_modules/pkg/credentials.json",
    "/node_modules/pkg/private.key",
    "/node_modules/pkg/coverage/report.json",
    "/node_modules/pkg/config.env",
  ]) {
    assert.ok(errors.some((error) => error.includes(fixture)), fixture);
  }
  assert.equal(errors.some((error) => error.includes("/node_modules/pkg/test.js")), false);
});

test("package:dir runs the strict checker after electron-builder with fail-fast propagation", () => {
  const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
  const builderConfig = readFileSync(path.resolve(__dirname, "../../electron-builder.yml"), "utf8");
  assert.equal(
    packageJson.scripts["package:dir"],
    "npm run build && electron-builder --dir && node scripts/check-package-allowlist.mjs",
  );
  assert.equal(packageJson.scripts["package:dir"].includes("npm run package:dir"), false);
  for (const pattern of [
    "!**/coverage{,/**}",
    "!**/*.env",
    "!**/.env{,.*}",
    "!**/.npmrc",
    "!**/*.{pem,key}",
    "!**/credentials*",
    "!**/secret*",
  ]) {
    assert.ok(builderConfig.includes(pattern), pattern);
  }
});

test("manifest rejects unknown dependencies, unsafe paths, and unpacked sensitive entries", () => {
  const errors = packageAllowlist.validatePackageContents([
    ...REQUIRED_ENTRIES,
    "/node_modules/unknown/index.js",
    "/dist/../secret.txt",
    "/dist\\evil.js",
  ].join("\n"), {
    packageJson: { main: "dist-electron/electron/main.js" },
    runtimePackageRoots: ["/node_modules/pkg"],
    unpackedListing: ["/app.asar.unpacked/secret.txt", "SYMLINK:/app.asar.unpacked/link.js"],
  });

  assert.ok(errors.some((error) => error.includes("/node_modules/unknown/index.js")));
  assert.ok(errors.some((error) => error.includes("unsafe package path")));
  assert.ok(errors.some((error) => error.includes("app.asar.unpacked/secret.txt")));
  assert.ok(errors.some((error) => error.includes("symlink")));
});

test("asar discovery requires exactly one candidate", () => {
  assert.equal(typeof packageAllowlist.findAsarPath, "function");
  assert.equal(packageAllowlist.findAsarPath(["/release/Fluely.app/app.asar"]), "/release/Fluely.app/app.asar");
  assert.throws(() => packageAllowlist.findAsarPath([]), /exactly one app\.asar/);
  assert.throws(() => packageAllowlist.findAsarPath([
    "/release/one/app.asar",
    "/release/two/app.asar",
  ]), /exactly one app\.asar/);
});
