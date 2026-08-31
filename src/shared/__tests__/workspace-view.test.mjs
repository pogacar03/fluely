import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/shared/workspace-view.js");
const {
  canOpenWork,
  initialWorkspaceView,
  navigateWorkspaceView,
  timeoutPolicyCopy,
} = await import(pathToFileURL(modulePath).href);

test("first launch starts in Settings and configured launch starts in Work", () => {
  assert.equal(initialWorkspaceView(false), "settings");
  assert.equal(initialWorkspaceView(true), "work");
});

test("Settings to Work navigation is allowed only after setup completes", () => {
  assert.equal(navigateWorkspaceView("settings", "work", true), "work");
  assert.equal(canOpenWork(true), true);
});

test("Work to Settings navigation stays in one workspace window", () => {
  const onboarding = { setupComplete: true };
  assert.equal(navigateWorkspaceView("work", "settings", onboarding.setupComplete), "settings");
  assert.equal(onboarding.setupComplete, true);
  assert.equal(initialWorkspaceView(true), "work");
});

test("incomplete setup cannot navigate into Work", () => {
  assert.equal(canOpenWork(false), false);
  assert.equal(navigateWorkspaceView("settings", "work", false), "settings");
});

test("timeout copy describes fixed startup, idle, and hard deadlines", () => {
  const copy = timeoutPolicyCopy();

  assert.match(copy, /fixed/i);
  assert.match(copy, /startup[^\d]*120,?000\s*ms/i);
  assert.match(copy, /idle[^\d]*120,?000\s*ms/i);
  assert.match(copy, /hard[^\d]*600,?000\s*ms/i);
  assert.match(copy, /not user-configurable/i);
  assert.doesNotMatch(copy, /choose|select|set your own|change this limit/i);
});
