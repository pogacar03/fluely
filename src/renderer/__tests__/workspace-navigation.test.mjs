import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/renderer/workspace-navigation.js");
const {
  createWorkspaceNavigationCallbacks,
  selectWorkspaceRoot,
} = await import(pathToFileURL(modulePath).href);

test("App root selection can mount Settings or Work but never both", () => {
  assert.deepEqual(selectWorkspaceRoot("settings"), { settings: true, work: false });
  assert.deepEqual(selectWorkspaceRoot("work"), { settings: false, work: true });
});

test("App navigation callbacks change only WorkspaceView across Settings and Work", () => {
  const state = {
    workspaceView: "settings",
    setupComplete: true,
    configurationValid: true,
  };
  const callbacks = createWorkspaceNavigationCallbacks({
    setupComplete: state.setupComplete,
    getWorkspaceView: () => state.workspaceView,
    setWorkspaceView: (view) => { state.workspaceView = view; },
  });

  assert.equal(callbacks.openWork(), true);
  assert.deepEqual(state, {
    workspaceView: "work",
    setupComplete: true,
    configurationValid: true,
  });

  callbacks.openSettings();
  assert.deepEqual(state, {
    workspaceView: "settings",
    setupComplete: true,
    configurationValid: true,
  });
});

test("App navigation callback blocks Work without mutating onboarding or config validity", () => {
  const state = {
    workspaceView: "settings",
    setupComplete: false,
    configurationValid: false,
    blockedCalls: 0,
  };
  const callbacks = createWorkspaceNavigationCallbacks({
    setupComplete: state.setupComplete,
    getWorkspaceView: () => state.workspaceView,
    setWorkspaceView: (view) => { state.workspaceView = view; },
    onWorkBlocked: () => { state.blockedCalls += 1; },
  });

  assert.equal(callbacks.openWork(), false);
  assert.deepEqual(state, {
    workspaceView: "settings",
    setupComplete: false,
    configurationValid: false,
    blockedCalls: 1,
  });
});
