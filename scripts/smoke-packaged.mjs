import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUTPUT_DIRECTORY = path.resolve(process.cwd(), "release");
const DEFAULT_ALIVE_MS = 5_000;
const TERMINATION_GRACE_MS = 3_000;

function isAppBundle(name) {
  return name.endsWith(".app");
}

async function collectAppBundles(directory, bundles) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (isAppBundle(entry.name)) {
      bundles.push(entryPath);
      continue;
    }
    await collectAppBundles(entryPath, bundles);
  }
}

export async function findPackagedApp(outputDirectory = DEFAULT_OUTPUT_DIRECTORY) {
  const bundles = [];
  try {
    await collectAppBundles(outputDirectory, bundles);
  } catch {
    throw new Error("Packaged application output is missing.");
  }

  if (bundles.length === 0) {
    throw new Error("Packaged application output contains no app bundle.");
  }
  if (bundles.length !== 1) {
    throw new Error("Packaged application output must contain exactly one app bundle.");
  }
  return bundles[0];
}

async function findPackagedExecutable(appPath) {
  const executable = path.join(appPath, "Contents", "MacOS", "Fluely");
  try {
    const details = await stat(executable);
    if (!details.isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error("Packaged application executable is missing.");
  }
  return executable;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function observeChild(child) {
  let settled = false;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const settle = (value) => {
    if (settled) {
      return;
    }
    settled = true;
    resolveExit(value);
  };
  child.once("exit", (code, signal) => settle({ code, signal }));
  child.once("error", () => settle({ code: null, signal: null, error: true }));
  return { exited, hasExited: () => settled };
}

async function terminateOwnedChild(child, observation) {
  if (observation.hasExited()) {
    return false;
  }
  if (!child.kill("SIGTERM")) {
    return false;
  }

  const firstExit = await Promise.race([
    observation.exited.then(() => true),
    wait(TERMINATION_GRACE_MS).then(() => false),
  ]);
  if (firstExit) {
    return true;
  }
  if (!child.kill("SIGKILL")) {
    return false;
  }
  const secondExit = await Promise.race([
    observation.exited.then(() => true),
    wait(TERMINATION_GRACE_MS).then(() => false),
  ]);
  return secondExit;
}

export async function runPackagedSmoke({
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  createTempUserData = () => mkdtemp(path.join(os.tmpdir(), "fluely-smoke-")),
  spawnProcess = spawn,
  aliveMs = DEFAULT_ALIVE_MS,
  waitFor = wait,
} = {}) {
  const appPath = await findPackagedApp(outputDirectory);
  const executable = await findPackagedExecutable(appPath);
  let userDataPath;
  try {
    userDataPath = await createTempUserData();
    const child = spawnProcess(executable, [`--user-data-dir=${userDataPath}`], {
      stdio: "ignore",
      detached: false,
    });
    const observation = observeChild(child);
    const alive = await Promise.race([
      observation.exited.then(() => false),
      waitFor(aliveMs).then(() => true),
    ]);
    if (!alive || observation.hasExited()) {
      throw new Error("Packaged application exited before the smoke interval completed.");
    }
    if (!(await terminateOwnedChild(child, observation))) {
      throw new Error("Packaged application child could not be terminated.");
    }
    return { aliveMs };
  } finally {
    if (userDataPath) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runPackagedSmoke().then(
    () => process.exitCode = 0,
    () => {
      console.error("smoke:packaged failed.");
      process.exitCode = 1;
    },
  );
}
