import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/application-bootstrap.js");
const { bootstrapApplication } = await import(pathToFileURL(modulePath).href);

test("application bootstrap never loads the renderer before main preparation completes", async () => {
  const order = [];
  let resolvePreparation;
  const preparation = new Promise((resolve) => {
    resolvePreparation = resolve;
  });

  const loadPromise = bootstrapApplication({
    prepare: async () => {
      order.push("prepare-start");
      await preparation;
      order.push("session-cleanup-ready");
      order.push("protocol-ready");
      order.push("ipc-handlers-registered");
      return { settings: "ready" };
    },
    createWindow: (context) => {
      order.push(`create-window:${context.settings}`);
      return { destroyed: false };
    },
    initializeWindow: () => {
      order.push("window-services-ready");
    },
    loadRenderer: () => {
      order.push("load-file");
    },
  });

  await Promise.resolve();
  assert.deepEqual(order, ["prepare-start"]);

  resolvePreparation();
  await loadPromise;

  assert.deepEqual(order, [
    "prepare-start",
    "session-cleanup-ready",
    "protocol-ready",
    "ipc-handlers-registered",
    "create-window:ready",
    "window-services-ready",
    "load-file",
  ]);
});

test("preparation failure exits without creating or loading a window", async () => {
  const order = [];

  await assert.rejects(
    bootstrapApplication({
      prepare: async () => {
        order.push("prepare");
        throw new Error("settings/session initialization failed");
      },
      createWindow: () => {
        order.push("create-window");
        return {};
      },
      initializeWindow: () => {
        order.push("window-services");
      },
      loadRenderer: () => {
        order.push("load-file");
      },
    }),
    /settings\/session initialization failed/,
  );

  assert.deepEqual(order, ["prepare"]);
});

test("window-service initialization failure destroys the hidden shell without loading the renderer", async () => {
  const order = [];
  const window = {
    destroy() {
      order.push("destroy-window");
    },
  };

  await assert.rejects(
    bootstrapApplication({
      prepare: async () => ({ settings: "ready" }),
      createWindow: () => {
        order.push("create-window");
        return window;
      },
      initializeWindow: async () => {
        order.push("window-services-start");
        throw new Error("shortcut initialization failed");
      },
      loadRenderer: () => {
        order.push("load-file");
      },
      disposeWindow: (failedWindow) => {
        assert.equal(failedWindow, window);
        failedWindow.destroy();
      },
    }),
    /shortcut initialization failed/,
  );

  assert.deepEqual(order, ["create-window", "window-services-start", "destroy-window"]);
});
