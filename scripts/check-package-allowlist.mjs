import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
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
const ALLOWED_ROOT_ENTRIES = new Set([
  "/assets",
  "/assets/icon.svg",
  "/dist",
  "/dist-electron",
  "/dist-phone",
  "/package.json",
  "/node_modules",
]);
const DIST_PHONE_FILES = new Set([
  "/dist-phone/index.html",
  "/dist-phone/phone.css",
  "/dist-phone/phone.js",
]);
const APP_OWNED_PREFIXES = ["/assets", "/dist", "/dist-electron", "/dist-phone"];
const RUNTIME_FILE_EXTENSIONS = /\.(?:css|html|ico|js|json|mjs|node|png|svg|wasm|webp|woff2)$/i;
const GLOBAL_SENSITIVE_PATTERNS = [
  /\.map$/i,
  /(?:^|\/)\.env(?:\..*)?$/i,
];
const APP_SENSITIVE_SEGMENTS = new Set([
  "__tests__",
  "__fixtures__",
  "fixture",
  "fixtures",
  "test",
  "tests",
]);
const APP_TEST_OR_SPEC_PATTERN = /(?:^|[._-])(test|spec)(?:[._-]|$)/i;
const APP_SOURCE_PATTERN = /\.(?:cjs|cts|jsx|mts|mjs|ts|tsx)$/i;
const APP_CONFIG_PATTERN = /(?:^|\/)(?:babel|electron-builder|jest|rollup|tsconfig|vite|webpack)(?:\.|\/)|\.config\.(?:cjs|js|mjs|ts|tsx)$/i;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return String(value ?? "").split(/\r?\n/);
}

function normalizeListedEntry(rawEntry) {
  const raw = String(rawEntry ?? "").trim();
  const symlink = raw.startsWith("SYMLINK:");
  const entry = symlink ? raw.slice("SYMLINK:".length) : raw;
  if (!entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")) {
    return { raw, error: `unsafe package path: ${raw}` };
  }
  const normalized = posix.normalize(entry);
  if (normalized !== entry || entry.includes("//") || entry === "/.." || entry.startsWith("/../")) {
    return { raw, error: `unsafe package path: ${raw}` };
  }
  return { raw, path: entry, symlink };
}

function parseListing(listing) {
  return asArray(listing)
    .map(normalizeListedEntry)
    .filter((entry) => entry.raw.length > 0);
}

function isDirectory(path, paths) {
  return paths.some((candidate) => candidate !== path && candidate.startsWith(`${path}/`));
}

function isAppOwnedPath(path) {
  return APP_OWNED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isDependencyPath(path, runtimePackageRoots) {
  if (path === "/node_modules") return true;
  return runtimePackageRoots.some((packageRoot) =>
    path === packageRoot ||
    path.startsWith(`${packageRoot}/`) ||
    packageRoot.startsWith(`${path}/`));
}

function sensitiveAppOwnedReason(path) {
  if (GLOBAL_SENSITIVE_PATTERNS.some((pattern) => pattern.test(path))) return "sensitive development artifact";
  const segments = path.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  if (segments.some((segment) => APP_SENSITIVE_SEGMENTS.has(segment.toLowerCase()))) return "development test/fixture path";
  if (APP_TEST_OR_SPEC_PATTERN.test(basename)) return "development test/spec file";
  if (APP_SOURCE_PATTERN.test(path)) return "development source file";
  if (APP_CONFIG_PATTERN.test(path)) return "development configuration file";
  return null;
}

function validateEntry(entry, allPaths, runtimePackageRoots, errors, sourceLabel = "") {
  const path = entry.path;
  if (entry.symlink) {
    errors.push(`symlink is not allowed in packaged contents: ${sourceLabel}${path}`);
    return;
  }

  const appOwned = isAppOwnedPath(path);
  if (/^\/(?:electron|src|scripts|docs)(?:\/|$)/.test(path)) {
    errors.push(`development source is packaged: ${sourceLabel}${path}`);
    return;
  }
  const sensitiveReason = appOwned ? sensitiveAppOwnedReason(path) :
    GLOBAL_SENSITIVE_PATTERNS.some((pattern) => pattern.test(path))
      ? "sensitive development artifact"
      : null;
  if (sensitiveReason) {
    errors.push(`${sensitiveReason} is packaged: ${sourceLabel}${path}`);
    return;
  }

  if (path === "/package.json") return;
  const directory = isDirectory(path, allPaths);
  if (appOwned) {
    if (ALLOWED_ROOT_ENTRIES.has(path) || path === "/dist-phone" || path === "/package.json") return;
    if (path.startsWith("/assets/")) {
      errors.push(`package manifest rejects app-owned asset: ${sourceLabel}${path}`);
      return;
    }
    if (path.startsWith("/dist-phone/") && !DIST_PHONE_FILES.has(path)) {
      errors.push(`package manifest rejects phone runtime path: ${sourceLabel}${path}`);
      return;
    }
    if (!directory && !RUNTIME_FILE_EXTENSIONS.test(path)) {
      errors.push(`package manifest rejects app-owned runtime extension: ${sourceLabel}${path}`);
    }
    return;
  }

  if (!isDependencyPath(path, runtimePackageRoots)) {
    errors.push(`package manifest rejects non-runtime path: ${sourceLabel}${path}`);
  }
}

/** Validate the asar listing and an optional app.asar.unpacked listing. */
export function validatePackageContents(
  listing,
  { packageJson, runtimePackageRoots = [], unpackedListing = [] } = {},
) {
  const parsed = parseListing(listing);
  const unpacked = parseListing(unpackedListing).map((entry) => ({
    ...entry,
    sourcePath: entry.path,
    path: entry.path?.startsWith("/app.asar.unpacked/")
      ? entry.path.slice("/app.asar.unpacked".length)
      : entry.path,
  }));
  const errors = parsed.flatMap((entry) => entry.error ? [entry.error] : []);
  errors.push(...unpacked.flatMap((entry) => entry.error ? [entry.error] : []));
  const asarEntries = parsed.filter((entry) => entry.path);
  const paths = asarEntries.map((entry) => entry.path);
  const entrySet = new Set(paths);

  for (const requiredEntry of REQUIRED_PACKAGE_ENTRIES) {
    if (!entrySet.has(requiredEntry)) errors.push(`required runtime entry is missing from app.asar: ${requiredEntry}`);
  }

  const packageMain = typeof packageJson?.main === "string"
    ? `/${packageJson.main.replace(/^\/+/, "")}`
    : "";
  if (packageMain !== "/dist-electron/electron/main.js") {
    errors.push("package.json main must point to /dist-electron/electron/main.js");
  }

  for (const entry of asarEntries) validateEntry(entry, paths, runtimePackageRoots, errors);
  const unpackedPaths = unpacked.filter((entry) => entry.path).map((entry) => entry.path);
  for (const entry of unpacked.filter((candidate) => candidate.path)) {
    validateEntry(entry, unpackedPaths, runtimePackageRoots, errors, "app.asar.unpacked");
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

function readPackageLock() {
  try {
    return JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Production dependencies are allowed by package root, including their own
 * test/coverage files when electron-builder retains them. App-owned paths are
 * strict; dependency-owned test files are not blanket-rejected.
 */
export function getRuntimePackageRoots(packageJson = {}, packageLock = {}) {
  const roots = new Set();
  for (const [packagePath, metadata] of Object.entries(packageLock.packages ?? {})) {
    if (packagePath.startsWith("node_modules/") && metadata && metadata.dev !== true) {
      roots.add(`/${packagePath}`);
    }
  }
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    roots.add(`/node_modules/${dependency}`);
  }
  return [...roots];
}

export function findAsarPath(candidates) {
  const paths = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (paths.length !== 1) throw new Error(`release must contain exactly one app.asar; found ${paths.length}.`);
  return paths[0];
}

function findAsarCandidates() {
  const result = spawnSync("find", [releasePath, "-type", "f", "-name", "app.asar", "-print"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
}

function collectUnpackedEntries(directory) {
  const entries = [];
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      const childPath = `${prefix}/${entry.name}`.replaceAll("\\", "/");
      if (entry.isSymbolicLink()) {
        entries.push(`SYMLINK:${childPath}`);
        continue;
      }
      entries.push(childPath);
      if (entry.isDirectory()) visit(child, childPath);
    }
  };
  visit(directory, "/app.asar.unpacked");
  return entries;
}

export function runPackageAllowlistCheck() {
  const errors = [];
  if (!existsSync(configPath)) return { errors: ["electron-builder.yml is missing."] };

  const config = readFileSync(configPath, "utf8");
  const filesBlock = config.split("files:")[1]?.split("asar:")[0] ?? "";
  const positivePatterns = filesBlock
    .split("\n")
    .map((line) => line.match(/^\s+-\s+([^!].*)$/)?.[1]?.trim())
    .filter(Boolean);
  for (const requiredPattern of ["dist/**", "dist-electron/**", "dist-phone/**", "package.json"]) {
    if (!positivePatterns.includes(requiredPattern)) errors.push(`required allowlist entry is missing: ${requiredPattern}`);
  }
  if (positivePatterns.some((pattern) => pattern.includes("node_modules"))) errors.push("a blanket node_modules allowlist is forbidden.");
  if (!/^asar:\s+true\s*$/m.test(config)) errors.push("asar must be enabled.");
  if (!existsSync(releasePath)) {
    errors.push("release/ does not exist; run npm run package:dir first.");
    return { errors };
  }

  let asarPath;
  try {
    asarPath = findAsarPath(findAsarCandidates());
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "release must contain exactly one app.asar.");
    return { errors };
  }

  const asarCommand = join(root, "node_modules", ".bin", "asar");
  if (!existsSync(asarCommand)) return { errors: [...errors, "the asar inspection tool is unavailable."], asarPath };
  const listing = spawnSync(asarCommand, ["list", asarPath], { encoding: "utf8" });
  if (listing.status !== 0) {
    errors.push(`could not inspect ${relative(root, asarPath)}.`);
    return { errors, asarPath };
  }

  const unpackedPath = join(dirname(asarPath), "app.asar.unpacked");
  let unpackedListing = [];
  try {
    const unpackedStats = lstatSync(unpackedPath);
    unpackedListing = unpackedStats.isSymbolicLink()
      ? ["SYMLINK:/app.asar.unpacked"]
      : unpackedStats.isDirectory() ? collectUnpackedEntries(unpackedPath) : ["/app.asar.unpacked"];
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push("could not inspect app.asar.unpacked.");
  }

  const packageJson = readPackageJson();
  errors.push(...validatePackageContents(listing.stdout, {
    packageJson,
    runtimePackageRoots: getRuntimePackageRoots(packageJson, readPackageLock()),
    unpackedListing,
  }));
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
