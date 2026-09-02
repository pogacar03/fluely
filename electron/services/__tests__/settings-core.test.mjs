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
    window: { width: 960, height: 720, opacity: 0.92 },
    privacy: { captureProtection: true },
    setupComplete: false,
    codex: {
      enabled: true,
      path: "codex",
      model: "gpt-5.6-sol",
      fastModel: "gpt-5.6-luna",
      timeoutMs: 120000,
      sandboxMode: "read-only",
      modelReasoningEffort: "medium",
    },
    phoneGateway: {
      enabled: false,
    },
  });
});

test("phone gateway settings default off and discard every credential-shaped field", () => {
  assert.deepEqual(normalizeSettings({
    phoneGateway: {
      enabled: true,
      pairingSecret: "secret-that-must-not-persist",
      cookieToken: "cookie-that-must-not-persist",
    },
  }).phoneGateway, { enabled: true });
  assert.deepEqual(normalizeSettings({}).phoneGateway, { enabled: false });
});

test("validateSettingsPatch accepts only a boolean phone gateway enabled flag", () => {
  assert.equal(validateSettingsPatch({ phoneGateway: { enabled: true } }), null);
  const error = validateSettingsPatch({ phoneGateway: { enabled: "yes" } });
  assert.deepEqual(error, {
    code: "INVALID_ARGUMENT",
    message: "Phone gateway enabled must be a boolean.",
    action: "Choose whether to start the phone companion on the LAN and try again.",
  });
});

test("normalizeSettings applies safe Codex and window defaults for invalid values", () => {
  const settings = normalizeSettings({
    setupComplete: "yes",
    window: { opacity: "opaque" },
    codex: {
      enabled: "yes",
      path: "   ",
      model: "   ",
      fastModel: "   ",
      timeoutMs: -1,
      sandboxMode: "unrestricted",
      modelReasoningEffort: "extreme",
    },
  });

  assert.equal(settings.setupComplete, false);
  assert.equal(settings.window.opacity, 0.92);
  assert.deepEqual(settings.codex, DEFAULT_SETTINGS.codex);
});

test("normalizeSettings clamps opacity and preserves valid Codex configuration", () => {
  const settings = normalizeSettings({
    setupComplete: true,
    window: { opacity: 4 },
    codex: {
      enabled: false,
      path: " /custom/bin/codex ",
      model: " gpt-custom ",
      fastModel: " gpt-fast ",
      timeoutMs: 45000,
      sandboxMode: "workspace-write",
      modelReasoningEffort: "xhigh",
    },
  });

  assert.equal(settings.setupComplete, true);
  assert.equal(settings.window.opacity, 1);
  assert.deepEqual(settings.codex, {
    enabled: false,
    path: "/custom/bin/codex",
    model: "gpt-custom",
    fastModel: "gpt-fast",
    timeoutMs: 45000,
    sandboxMode: "workspace-write",
    modelReasoningEffort: "xhigh",
  });
});

test("normalizeSettings clamps opacity at the minimum safe value", () => {
  assert.equal(normalizeSettings({ window: { opacity: 0 } }).window.opacity, 0.35);
});

test("normalizeSettings keeps capture protection enabled by default and accepts an explicit choice", () => {
  assert.equal(normalizeSettings({}).privacy.captureProtection, true);
  assert.equal(normalizeSettings({ privacy: { captureProtection: false } }).privacy.captureProtection, false);
  assert.equal(normalizeSettings({ privacy: { captureProtection: "no" } }).privacy.captureProtection, true);
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

test("validateSettingsPatch rejects duplicate accelerator values before persistence", () => {
  const error = validateSettingsPatch({
    shortcuts: {
      toggleVisibility: "CommandOrControl+K",
      captureScreenshot: "CommandOrControl+K",
    },
  });

  assert.equal(error.code, "INVALID_ARGUMENT");
  assert.match(error.message, /duplicates another shortcut/i);
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

test("validateSettingsPatch rejects a non-boolean capture protection setting", () => {
  const error = validateSettingsPatch({ privacy: { captureProtection: "disabled" } });

  assert.deepEqual(error, {
    code: "INVALID_ARGUMENT",
    message: "Privacy captureProtection must be a boolean.",
    action: "Choose whether Fluely should protect its window from capture and try again.",
  });
});
