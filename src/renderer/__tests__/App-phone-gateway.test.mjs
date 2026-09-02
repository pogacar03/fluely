import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/src/renderer/App.js");
const { App } = await import(pathToFileURL(modulePath).href).catch(() => ({}));

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
  setupComplete: false,
  shortcuts: {
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+Shift+8",
    analyzeQueue: "CommandOrControl+Enter",
    captureAndAnalyze: "CommandOrControl+Shift+Enter",
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

let phoneStatusListener;
const api = {
  settings: {
    get: async () => ({ ok: true, value: settings }),
    update: async () => ({ ok: true, value: settings }),
    reset: async () => ({ ok: true, value: settings }),
  },
  shortcuts: { get: async () => ({ ok: true, value: { entries: [], updatedAt: "" } }) },
  app: { getStatus: async () => ({ ok: true, value: { name: "Fluely", version: "0.1.0", platform: "darwin", visible: true } }) },
  screenshots: {
    get: async () => ({ ok: true, value: { items: [], capturing: false, permission: "unavailable" } }),
    onStateChanged: () => () => undefined,
  },
  codex: { getStatus: async () => ({ ok: true, value: { available: true, configuredPath: "codex" } }) },
  analysis: {
    getStatus: async () => ({ ok: true, value: { status: "idle", text: "", model: "", screenshotIds: [], startedAt: null, updatedAt: "", completedAt: null } }),
    onStateChanged: () => () => undefined,
  },
  conversation: {
    getSnapshot: async () => ({ ok: true, value: { sessionId: "session", revision: 0, messages: [], attachments: [] } }),
    onEvent: () => () => undefined,
  },
  phoneGateway: {
    getStatus: async () => ({ ok: true, value: { state: "disabled" } }),
    enable: async () => ({ ok: true, value: { state: "disabled" } }),
    disable: async () => ({ ok: true, value: { state: "disabled" } }),
    regeneratePairing: async () => ({ ok: true, value: { state: "disabled" } }),
    onStatusChanged: (listener) => {
      phoneStatusListener = listener;
      return () => { phoneStatusListener = undefined; };
    },
  },
  window: { setOpacity: async () => ({ ok: true, value: settings.window }), hide: async () => ({ ok: true, value: undefined }) },
  workspace: { execute: async () => ({ ok: true, value: { queue: { items: [] }, conversation: { sessionId: "session", revision: 0, messages: [], attachments: [] } } }) },
};

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "<div id=\"root\"></div>";
  delete globalThis.window.fluely;
});

test("App refreshes and subscribes to main-process phone gateway status while Settings is mounted", async () => {
  assert.equal(typeof App, "function");
  globalThis.window.fluely = api;
  const root = createRoot(document.getElementById("root"));
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(App));
  });
  await act(async () => Promise.resolve());
  assert.match(document.body.textContent ?? "", /Phone companion/i);
  assert.equal(typeof phoneStatusListener, "function");
  assert.equal(document.querySelector("img"), null);

  await act(async () => {
    phoneStatusListener({
      state: "ready",
      origin: "http://192.168.50.8:4123",
      qrDataUrl: "data:image/png;base64,qr",
      pairingExpiresAt: Date.now() + 120000,
      paired: false,
    });
  });
  assert.equal(document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,qr");
  assert.match(document.body.textContent ?? "", /192\.168\.50\.8:4123/);
});
