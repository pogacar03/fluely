import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const configPath = join(root, "electron-builder.yml");
const releasePath = join(root, "release");

const REQUIRED_PACKAGE_ENTRIES = [
  "/dist-electron/electron/main.js",
  "/dist/index.html",
  "/dist-phone/index.html",
  "/dist-phone/phone.css",
  "/dist-phone/phone.js",
  "/package.json",
];

const DEVELOPMENT_SOURCE_PATTERNS = [
  /^\/(?:electron|src|scripts|docs)(?:\/|$)/,
  /\.(?:ts|tsx)$/,
];

/** Validate the asar listing independently of the local release directory. */
export function validatePackageContents(listing, { packageJson } = {}) {
  const entries = String(listing)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const entrySet = new Set(entries);
  const errors = [];

  for (const requiredEntry of REQUIRED_PACKAGE_ENTRIES) {
    if (!entrySet.has(requiredEntry)) {
      errors.push(`required runtime entry is missing from app.asar: ${requiredEntry}`);
    }
  }

  const packageMain = typeof packageJson?.main === "string"
    ? `/${packageJson.main.replace(/^\/+/, "")}`
    : "";
  if (packageMain !== "/dist-electron/electron/main.js") {
    errors.push("package.json main must point to /dist-electron/electron/main.js");
  }

  const forbidden = entries.filter((entry) =>
    entry.endsWith(".map") ||
    entry.includes(".test.") ||
    entry.endsWith("/.env") ||
    entry.includes("/.env.") ||
    DEVELOPMENT_SOURCE_PATTERNS.some((pattern) => pattern.test(entry))
  );
  for (const entry of forbidden) {
    const reason = DEVELOPMENT_SOURCE_PATTERNS.some((pattern) => pattern.test(entry))
      ? "development source"
      : "forbidden development artifact";
    errors.push(`${reason} is packaged: ${entry}`);
  }

  return [...new Set(errors)];
}

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

function findAsarPath() {
  const asarSearch = spawnSync("find", [releasePath, "-type", "f", "-name", "app.asar", "-print"], {
    encoding: "utf8",
  });
  return asarSearch.stdout.trim().split("\n").filter(Boolean)[0];
}

export function runPackageAllowlistCheck() {
  const errors = [];
  if (!existsSync(configPath)) {
    return { errors: ["electron-builder.yml is missing."] };
  }

  const config = readFileSync(configPath, "utf8");
  const filesBlock = config.split("files:")[1]?.split("asar:")[0] ?? "";
  const positivePatterns = filesBlock
    .split("\n")
    .map((line) => line.match(/^\s+-\s+([^!].*)$/)?.[1]?.trim())
    .filter(Boolean);

  for (const requiredPattern of ["dist/**", "dist-electron/**", "dist-phone/**", "package.json"]) {
    if (!positivePatterns.includes(requiredPattern)) {
      errors.push(`required allowlist entry is missing: ${requiredPattern}`);
    }
  }
  if (positivePatterns.some((pattern) => pattern.includes("node_modules"))) {
    errors.push("a blanket node_modules allowlist is forbidden.");
  }
  if (!/^asar:\s+true\s*$/m.test(config)) {
    errors.push("asar must be enabled.");
  }

  if (!existsSync(releasePath)) {
    errors.push("release/ does not exist; run npm run package:dir first.");
    return { errors };
  }

  const asarPath = findAsarPath();
  if (!asarPath) {
    errors.push("no packaged app.asar was found under release/.");
    return { errors };
  }

  const asarCommand = join(root, "node_modules", ".bin", "asar");
  if (!existsSync(asarCommand)) {
    errors.push("the asar inspection tool is unavailable.");
    return { errors, asarPath };
  }

  const listing = spawnSync(asarCommand, ["list", asarPath], { encoding: "utf8" });
  if (listing.status !== 0) {
    errors.push(`could not inspect ${relative(root, asarPath)}.`);
    return { errors, asarPath };
  }

  errors.push(...validatePackageContents(listing.stdout, { packageJson: readPackageJson() }));
  return { errors: [...new Set(errors)], asarPath };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  const result = runPackageAllowlistCheck();
  if (result.errors.length > 0) {
    result.errors.forEach((message) => console.error(`Package allowlist check failed: ${message}`));
    process.exitCode = 1;
  } else {
    console.log(`Package allowlist passed: ${relative(root, result.asarPath)}`);
  }
}
