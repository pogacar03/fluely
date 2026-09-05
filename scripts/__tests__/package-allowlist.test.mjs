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
