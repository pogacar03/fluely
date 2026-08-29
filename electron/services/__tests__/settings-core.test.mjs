import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/settings-core.js");
const { DEFAULT_SETTINGS, normalizeSettings, validateSettingsPatch } = await import(pathToFileURL(modulePath).href);

test("normalizeSettings returns Fluely defaults for empty input", () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, {
    shortcuts: {
      toggleVisibility: "CommandOrControl+B",
      captureScreenshot: "CommandOrControl+Shift+8",
      analyzeQueue: "CommandOrControl+Enter",
      captureAndAnalyze: "CommandOrControl+Shift+Enter",
      cancelAndClear: "CommandOrControl+R",
    },
    window: { width: 960, height: 720 },
  });
});

test("normalizeSettings clamps unsafe window dimensions", () => {
  const settings = normalizeSettings({ window: { width: 20, height: 99999 } });

  assert.equal(settings.window.width, 480);
  assert.equal(settings.window.height, 1400);
});

test("normalizeSettings ignores unknown keys and blank shortcuts", () => {
  const settings = normalizeSettings({
    shortcuts: { toggleVisibility: "   " },
    leaked: "secret",
  });

  assert.equal(settings.shortcuts.toggleVisibility, DEFAULT_SETTINGS.shortcuts.toggleVisibility);
  assert.equal(Object.hasOwn(settings, "leaked"), false);
});

test("normalizeSettings returns defaults for non-object input", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("not settings"), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS);
});

test("validateSettingsPatch rejects malformed nested values", () => {
  const error = validateSettingsPatch({
    shortcuts: { analyzeQueue: 42 },
  });

  assert.deepEqual(error, {
    code: "INVALID_ARGUMENT",
    message: "Shortcut analyzeQueue must be a non-empty string.",
    action: "Enter a valid keyboard accelerator and try again.",
  });
});

test("validateSettingsPatch accepts clamped dimensions and partial shortcuts", () => {
  assert.equal(
    validateSettingsPatch({
      shortcuts: { toggleVisibility: "CommandOrControl+K" },
      window: { width: 200, height: 1200 },
    }),
    null,
  );
});
