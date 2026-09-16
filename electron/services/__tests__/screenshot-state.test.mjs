import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedPath = path.resolve(__dirname, "../../../dist-electron/src/shared/ipc.js");
const { subscribeToScreenshotState } = await import(pathToFileURL(sharedPath).href);

test("screenshot state subscription cleans up and preserves final state ordering", () => {
  const listeners = new Set();
  let unsubscribeCalls = 0;
  const source = {
    onStateChanged(listener) {
      listeners.add(listener);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(listener);
      };
    },
  };
  const received = [];
  const unsubscribe = subscribeToScreenshotState(source, (state) => received.push(state));

  for (const capturing of [true, false]) {
    for (const listener of listeners) {
      listener({ items: [], capturing, permission: "granted" });
    }
  }
  unsubscribe();
  unsubscribe();
  for (const listener of listeners) {
    listener({ items: [], capturing: true, permission: "granted" });
  }

  assert.deepEqual(received.map((state) => state.capturing), [true, false]);
  assert.equal(unsubscribeCalls, 1);
  assert.equal(listeners.size, 0);
});

test("screenshot state subscription ignores events after its owner becomes inactive", () => {
  const listeners = new Set();
  const source = {
    onStateChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let active = true;
  const received = [];
  subscribeToScreenshotState(source, (state) => received.push(state), () => active);

  for (const listener of listeners) {
    listener({ items: [], capturing: true, permission: "granted" });
  }
  active = false;
  for (const listener of listeners) {
    listener({ items: [], capturing: false, permission: "granted" });
  }

  assert.deepEqual(received.map((state) => state.capturing), [true]);
});
