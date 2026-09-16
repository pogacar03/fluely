import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/renderer/components/SetupView.js");
const { SetupView } = await import(pathToFileURL(modulePath).href).catch(() => ({}));

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "https://fluely.test/",
});
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const roots = [];

const settings = {
  setupComplete: true,
  shortcuts: {
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+Shift+8",
    ask: "CommandOrControl+Enter",
    cancelAndClear: "CommandOrControl+R",
  },
  window: { width: 960, height: 720, opacity: 0.92 },
  privacy: { captureProtection: true },
  codex: {
    enabled: true,
    path: "codex",
    model: "gpt-5.6-sol",
    fastModel: "gpt-5.6-luna",
    timeoutMs: 120000,
    sandboxMode: "read-only",
    modelReasoningEffort: "medium",
  },
  phoneGateway: { enabled: false },
};

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "<div id=\"root\"></div>";
});

test("SetupView integrates the phone companion panel into Settings without exposing QR data while disabled", async () => {
  assert.equal(typeof SetupView, "function");
  const calls = [];
  const root = createRoot(document.getElementById("root"));
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(SetupView, {
      settings,
      codexStatus: { available: true, configuredPath: "codex" },
      phoneGatewayStatus: { state: "disabled" },
      onPhoneGatewayEnable: () => calls.push("enable"),
      onPhoneGatewayDisable: () => calls.push("disable"),
      onPhoneGatewayRegeneratePairing: () => calls.push("regenerate"),
      onStart: () => undefined,
      onBackToWork: () => undefined,
    }));
  });
  assert.match(document.body.textContent ?? "", /Phone companion/i);
  assert.match(document.body.textContent ?? "", /trusted local network/i);
  assert.equal(document.querySelector("img"), null);
  [...document.querySelectorAll("button")].find((button) => /start phone companion/i.test(button.textContent ?? "")).click();
  assert.deepEqual(calls, ["enable"]);
});
