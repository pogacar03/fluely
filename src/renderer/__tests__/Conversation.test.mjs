import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const componentPath = path.resolve(__dirname, "../../../dist-electron/src/renderer/components/Conversation.js");

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
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { Conversation } = await import(pathToFileURL(componentPath).href);
const roots = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "<div id=\"root\"></div>";
});

test("Conversation renders ordered user/assistant messages and attachment IDs through private media URLs", async () => {
  const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const root = createRoot(document.getElementById("root"));
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(Conversation, {
      snapshot: {
        sessionId: "session-ui",
        revision: 2,
        messages: [
          {
            id: "user-1",
            sequence: 1,
            role: "user",
            text: "Question",
            attachmentIds: [attachmentId],
            status: "completed",
            createdAt: 1,
            finishedAt: 1,
          },
          {
            id: "assistant-1",
            sequence: 2,
            role: "assistant",
            text: "Answer",
            attachmentIds: [],
            status: "completed",
            createdAt: 1,
            finishedAt: 1,
          },
        ],
        attachments: [{
          id: attachmentId,
          mimeType: "image/png",
          width: 10,
          height: 20,
          byteLength: 30,
          createdAt: 1,
        }],
      },
    }));
  });

  assert.deepEqual(
    [...document.querySelectorAll("[data-message-sequence]")].map((node) => node.getAttribute("data-message-sequence")),
    ["1", "2"],
  );
  assert.match(document.body.textContent ?? "", /Question/);
  assert.match(document.body.textContent ?? "", /Answer/);
  assert.ok(document.querySelector(`img[src="fluely-media://attachment/${attachmentId}"]`));
  assert.equal(document.body.innerHTML.includes("/Users/"), false);
});
