import assert from "node:assert/strict";
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

test("manifest rejects app-owned malicious fixtures while allowing a runtime dependency test file", () => {
  const listing = [
    ...REQUIRED_ENTRIES,
    "/dist/__tests__/leaked.mjs",
    "/dist/test-helper.js",
    "/dist/foo.spec.mjs",
    "/dist/config.env",
    "/secret.txt",
    "/node_modules/pkg/test.js",
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
    "/secret.txt",
  ]) {
    assert.ok(errors.some((error) => error.includes(fixture)), fixture);
  }
  assert.equal(errors.some((error) => error.includes("/node_modules/pkg/test.js")), false);
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
