import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { test, afterEach } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const componentPath = path.resolve(__dirname, "../../../dist-electron/src/renderer/components/PhoneConnectionPanel.js");
let PhoneConnectionPanel;
try {
  ({ PhoneConnectionPanel } = await import(pathToFileURL(componentPath).href));
} catch {
  PhoneConnectionPanel = undefined;
}

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

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "<div id=\"root\"></div>";
});

test("phone panel hides QR credentials while disabled and renders LAN-only pairing details when ready", async () => {
  assert.equal(typeof PhoneConnectionPanel, "function");
  const root = createRoot(document.getElementById("root"));
  roots.push(root);
  const calls = [];
  await act(async () => {
    root.render(React.createElement(PhoneConnectionPanel, {
      status: { state: "disabled" },
      onEnable: () => calls.push("enable"),
      onDisable: () => calls.push("disable"),
      onRegeneratePairing: () => calls.push("regenerate"),
    }));
  });
  assert.equal(document.querySelector("img"), null);
  assert.match(document.body.textContent ?? "", /Start phone companion on LAN/);
  assert.match(document.body.textContent ?? "", /trusted local network/i);
  document.querySelector("button").click();
  assert.deepEqual(calls, ["enable"]);

  await act(async () => {
    root.render(React.createElement(PhoneConnectionPanel, {
      status: {
        state: "ready",
        origin: "http://192.168.50.8:45678",
        qrDataUrl: "data:image/png;base64,qr",
        pairingExpiresAt: Date.now() + 120_000,
        paired: true,
      },
      onEnable: () => calls.push("enable"),
      onDisable: () => calls.push("disable"),
      onRegeneratePairing: () => calls.push("regenerate"),
    }));
  });
  assert.equal(document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,qr");
  assert.match(document.body.textContent ?? "", /192\.168\.50\.8:45678/);
  assert.match(document.body.textContent ?? "", /paired/i);
  assert.match(document.body.textContent ?? "", /unencrypted/i);
});

test("phone panel supports regeneration and disable/revoke actions with an expiry countdown", async () => {
  assert.equal(typeof PhoneConnectionPanel, "function");
  const root = createRoot(document.getElementById("root"));
  roots.push(root);
  const calls = [];
  await act(async () => {
    root.render(React.createElement(PhoneConnectionPanel, {
      status: {
        state: "ready",
        origin: "http://192.168.50.8:45678",
        qrDataUrl: "data:image/png;base64,qr",
        pairingExpiresAt: Date.now() + 119_000,
        paired: true,
      },
      onEnable: () => calls.push("enable"),
      onDisable: () => calls.push("disable"),
      onRegeneratePairing: () => calls.push("regenerate"),
    }));
  });
  assert.match(document.body.textContent ?? "", /expires in/i);
  assert.match(document.body.textContent ?? "", /paired/i);
  const buttons = [...document.querySelectorAll("button")];
  buttons.find((button) => /regenerate/i.test(button.textContent ?? "")).click();
  buttons.find((button) => /disable/i.test(button.textContent ?? "")).click();
  assert.deepEqual(calls, ["regenerate", "disable"]);
});
