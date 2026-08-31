import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/application-instance.js");
const {
  acquireSingleInstance,
  createApplicationInstancePort,
  restoreAndFocusWindow,
} = await import(pathToFileURL(modulePath).href);

test("application instance port delegates lock acquisition to Electron", () => {
  let lockCalls = 0;
  const port = createApplicationInstancePort({
    requestSingleInstanceLock: () => {
      lockCalls += 1;
      return true;
    },
    on: () => undefined,
    removeListener: () => undefined,
  });

  assert.equal(port.acquire(), true);
  assert.equal(lockCalls, 1);
});

test("lock failure quits before first-instance initialization can run", () => {
  let quitCalls = 0;
  let initializationCalls = 0;
  const port = {
    acquire: () => false,
    onSecondInstance: () => () => undefined,
  };

  const acquired = acquireSingleInstance(port, () => { quitCalls += 1; });
  if (acquired) {
    initializationCalls += 1;
  }

  assert.equal(acquired, false);
  assert.equal(quitCalls, 1);
  assert.equal(initializationCalls, 0);
});

test("second-instance focus restores, shows, and focuses the owned window", () => {
  const calls = [];
  restoreAndFocusWindow({
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  });

  assert.deepEqual(calls, ["restore", "show", "focus"]);
});

test("second-instance listener cleanup is idempotent and stops forwarding events", () => {
  let listener;
  let removeCalls = 0;
  const app = {
    requestSingleInstanceLock: () => true,
    on: (event, nextListener) => {
      assert.equal(event, "second-instance");
      listener = nextListener;
    },
    removeListener: (event, nextListener) => {
      assert.equal(event, "second-instance");
      assert.equal(nextListener, listener);
      removeCalls += 1;
      listener = undefined;
    },
  };
  const port = createApplicationInstancePort(app);
  let focusCalls = 0;
  const unsubscribe = port.onSecondInstance(() => { focusCalls += 1; });

  listener();
  unsubscribe();
  unsubscribe();
  listener?.();

  assert.equal(focusCalls, 1);
  assert.equal(removeCalls, 1);
});
