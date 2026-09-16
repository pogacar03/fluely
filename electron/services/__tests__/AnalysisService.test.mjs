import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/AnalysisService.js");
const { AnalysisService } = await import(pathToFileURL(modulePath).href);

const FIRST_ID = "12345678-1234-4123-8123-123456789012";
const SECOND_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const THIRD_ID = "fedcba98-7654-4321-8765-fedcba987654";

function makeClock() {
  let tick = 0;
  return () => new Date(`2026-08-30T10:00:0${tick++}.000Z`);
}

function makeScreenshots(ids = [FIRST_ID, SECOND_ID]) {
  const paths = new Map(ids.map((id) => [id, `/managed/${id}.png`]));
  return {
    getState() {
      return {
        items: ids.map((id) => ({ id, createdAt: "2026-08-30T09:00:00.000Z", width: 1920, height: 1080 })),
        capturing: false,
        permission: "unavailable",
      };
    },
    getManagedPaths(requestedIds) {
      const selected = requestedIds === undefined ? ids : requestedIds;
      return selected.filter((id) => paths.has(id)).map((id) => paths.get(id));
    },
  };
}

function makeService({ provider, screenshots = makeScreenshots(), now = makeClock(), onDiagnostics } = {}) {
  return new AnalysisService({
    provider,
    screenshots,
    codex: {
      enabled: true,
      path: "/usr/local/bin/codex",
      model: "normal-model",
      fastModel: "fast-model",
      timeoutMs: 5000,
      sandboxMode: "read-only",
      modelReasoningEffort: "medium",
    },
    now,
    onDiagnostics,
  });
}

test("AnalysisService rejects a second request while the first stream is running", async () => {
  let release;
  const provider = {
    stream: () => (async function* () {
      await new Promise((resolve) => { release = resolve; });
      yield "answer";
    })(),
  };
  const service = makeService({ provider });

  await service.start({
    prompt: "What is shown?",
    screenshotIds: [FIRST_ID],
    intent: "answer",
    fast: false,
  });

  assert.equal(service.getState().status, "running");
  await assert.rejects(
    service.start({
      prompt: "Another question",
      screenshotIds: [SECOND_ID],
      intent: "explain",
      fast: true,
    }),
    (error) => error?.code === "ANALYSIS_IN_PROGRESS",
  );

  for (let attempt = 0; attempt < 20 && typeof release !== "function"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof release, "function");
  await service.cancel();
  release();
  await service.whenIdle();
  assert.equal(service.getState().status, "cancelled");
});

test("AnalysisService accumulates provider deltas in order and emits typed snapshots", async () => {
  const calls = [];
  const provider = {
    stream: async function* (executable, options) {
      calls.push({ executable, options });
      yield "first";
      await new Promise((resolve) => setImmediate(resolve));
      yield " second";
    },
  };
  const service = makeService({ provider });
  const events = [];
  const unsubscribe = service.onStateChanged((event) => events.push(event));

  await service.start({
    prompt: "  Summarize this screen  ",
    screenshotIds: [FIRST_ID, "unknown", SECOND_ID],
    intent: "explain",
    fast: true,
  });
  assert.equal(service.getState().status, "running");

  await service.whenIdle();
  unsubscribe();

  assert.deepEqual(events.map((event) => event.event), ["started", "delta", "delta", "completed"]);
  assert.deepEqual(events.map((event) => event.status), ["running", "running", "running", "completed"]);
  assert.equal(events.at(-1).text, "first second");
  assert.deepEqual(service.getState().screenshotIds, [FIRST_ID, SECOND_ID]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "/usr/local/bin/codex");
  assert.equal(calls[0].options.model, "fast-model");
  assert.deepEqual(calls[0].options.imagePaths, [
    `/managed/${FIRST_ID}.png`,
    `/managed/${SECOND_ID}.png`,
  ]);
  assert.match(calls[0].options.prompt, /Intent: explain/);
  assert.match(calls[0].options.prompt, /Summarize this screen/);
  assert.match(calls[0].options.prompt, new RegExp(FIRST_ID));
  assert.match(calls[0].options.prompt, new RegExp(SECOND_ID));
});

test("AnalysisService cancellation aborts the provider and never completes the partial answer", async () => {
  let observedSignal;
  let release;
  const provider = {
    stream: (_path, options) => {
      observedSignal = options.signal;
      return (async function* () {
        yield "partial";
        await new Promise((resolve) => { release = resolve; });
        yield " late";
      })();
    },
  };
  const service = makeService({ provider });
  const events = [];
  service.onStateChanged((event) => events.push(event));

  await service.start({ prompt: "Question", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = service.cancel();

  assert.equal(observedSignal.aborted, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.text, "partial");
  assert.equal(events.at(-1).event, "cancelled");

  release();
  await service.whenIdle();
  assert.equal(service.getState().status, "cancelled");
  assert.equal(events.some((event) => event.event === "completed"), false);
});

test("AnalysisService holds its start lock until a cancelled provider stream settles", async () => {
  const releases = [];
  const provider = {
    stream: (_path, options) => {
      return (async function* () {
        yield "partial";
        await new Promise((resolve) => releases.push(resolve));
        if (options.signal.aborted) {
          return;
        }
        yield "late";
      })();
    },
  };
  const service = makeService({ provider });

  await service.start({ prompt: "First", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  for (let attempt = 0; attempt < 20 && releases.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(releases.length, 1);

  service.cancel();
  await assert.rejects(
    service.start({ prompt: "Overlapping", screenshotIds: [FIRST_ID], intent: "answer", fast: false }),
    (error) => error?.code === "ANALYSIS_IN_PROGRESS",
  );

  releases.shift()();
  await service.whenIdle();

  await service.start({ prompt: "After cleanup", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  assert.equal(service.getState().status, "running");
  for (let attempt = 0; attempt < 20 && releases.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(releases.length, 1);
  service.cancel();
  releases.shift()();
  await service.whenIdle();
});

test("AnalysisService reports provider failures without changing the screenshot queue", async () => {
  const screenshots = makeScreenshots([FIRST_ID, SECOND_ID]);
  const provider = {
    stream: async function* () {
      yield "partial";
      throw Object.assign(new Error("Codex is not logged in"), { code: "PROCESS_FAILED", action: "Run codex login." });
    },
  };
  const service = makeService({ provider, screenshots });
  const before = screenshots.getState();
  const events = [];
  service.onStateChanged((event) => events.push(event));

  await service.start({ prompt: "Question", screenshotIds: undefined, intent: "recap", fast: false });
  await service.whenIdle();

  const after = screenshots.getState();
  assert.deepEqual(after, before);
  assert.equal(service.getState().status, "error");
  assert.equal(service.getState().text, "partial");
  assert.deepEqual(service.getState().error, {
    code: "ANALYSIS_FAILED",
    message: "Codex CLI analysis failed.",
    action: "Check the Codex CLI configuration and try the request again.",
  });
  assert.deepEqual(events.map((event) => event.event), ["started", "delta", "error"]);
});

test("AnalysisService normalizes unknown provider errors before publishing state", async () => {
  const provider = {
    stream: async function* () {
      throw Object.assign(new Error("raw stderr /Users/private token=secret"), {
        code: "PROCESS_FAILED",
        action: "run codex --model private with cookie=session",
      });
    },
  };
  const service = makeService({ provider });

  await service.start({ prompt: "Question", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  await service.whenIdle();

  assert.deepEqual(service.getState().error, {
    code: "ANALYSIS_FAILED",
    message: "Codex CLI analysis failed.",
    action: "Check the Codex CLI configuration and try the request again.",
  });
  assert.doesNotMatch(JSON.stringify(service.getState()), /raw stderr|\/Users\/private|secret|cookie/i);
});

test("AnalysisService preserves safe provider classifications without leaking details", async () => {
  const screenshots = makeScreenshots([FIRST_ID, SECOND_ID]);
  const provider = {
    stream: async function* () {
      throw Object.assign(new Error("raw stderr /Users/private token=secret"), {
        code: "USAGE_LIMIT",
        action: "raw codex exec --model secret cookie=session",
      });
    },
  };
  const service = makeService({ provider, screenshots });
  const before = screenshots.getState();

  await service.start({ prompt: "Question", screenshotIds: undefined, intent: "recap", fast: false });
  await service.whenIdle();

  const after = screenshots.getState();
  assert.deepEqual(after, before);
  assert.deepEqual(service.getState().error, {
    code: "USAGE_LIMIT",
    message: "Codex usage limit reached. Restore your usage or switch to an available model, then retry.",
    action: "Restore your Codex usage or switch to an available model, then retry.",
  });
  assert.doesNotMatch(JSON.stringify(service.getState().error), /raw stderr|\/Users\/private|secret|cookie/i);
});

test("AnalysisService normalizes synchronous selection failures before activation", async () => {
  const screenshots = makeScreenshots([FIRST_ID, SECOND_ID]);
  const before = screenshots.getState();
  screenshots.getManagedPaths = () => {
    throw Object.assign(new Error("raw selection failure /private token=secret"), {
      code: "PROCESS_FAILED",
      action: "run codex --model private cookie=session",
    });
  };
  const service = makeService({ screenshots });

  await assert.rejects(
    service.start({ prompt: "Question", screenshotIds: undefined, intent: "answer", fast: false }),
    (error) => {
      assert.equal(error.code, "ANALYSIS_FAILED");
      assert.equal(error.message, "Codex CLI analysis failed.");
      assert.equal(error.action, "Check the Codex CLI configuration and try the request again.");
      assert.doesNotMatch(JSON.stringify(error), /raw selection|\/private|secret|cookie|PROCESS_FAILED/i);
      return true;
    },
  );

  assert.deepEqual(screenshots.getState(), before);
  assert.equal(service.getState().status, "idle");
});

test("AnalysisService preserves safe startup classifications without leaking synchronous details", async () => {
  const screenshots = makeScreenshots([FIRST_ID]);
  screenshots.getManagedPaths = () => {
    throw Object.assign(new Error("raw usage detail token=secret"), {
      code: "USAGE_LIMIT",
      action: "raw provider action cookie=session",
    });
  };
  const service = makeService({ screenshots });

  await assert.rejects(
    service.start({ prompt: "Question", screenshotIds: undefined, intent: "answer", fast: false }),
    (error) => {
      assert.equal(error.code, "USAGE_LIMIT");
      assert.equal(error.message, "Codex usage limit reached. Restore your usage or switch to an available model, then retry.");
      assert.equal(error.action, "Restore your Codex usage or switch to an available model, then retry.");
      assert.doesNotMatch(JSON.stringify(error), /raw usage|secret|cookie/i);
      return true;
    },
  );
  assert.equal(service.getState().status, "idle");
});

test("AnalysisService turns a clean empty provider completion into a terminal error", async () => {
  const provider = {
    stream: async function* () {
      // The provider completed without producing a visible answer.
    },
  };
  const service = makeService({ provider });
  const events = [];
  service.onStateChanged((event) => events.push(event));

  await service.start({ prompt: "Question", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  await service.whenIdle();

  const state = service.getState();
  assert.equal(state.status, "error");
  assert.equal(state.text, "");
  assert.equal(state.error.code, "ANALYSIS_FAILED");
  assert.deepEqual(events.map((event) => event.event), ["started", "error"]);
});

test("AnalysisService preserves typed timeout categories and keeps diagnostics out of public state", async () => {
  const diagnostics = Object.freeze({
    elapsedMs: 120000,
    milestones: Object.freeze({ spawn: 0, "first-jsonl": 40, "last-event": 40 }),
    exitCode: null,
    exitSignal: "SIGTERM",
    stderrTail: "safe diagnostic tail",
  });
  const observedDiagnostics = [];
  const provider = {
    stream: async function* () {
      throw Object.assign(new Error("raw provider detail must stay internal"), {
        name: "CodexCliError",
        code: "CLI_IDLE_TIMEOUT",
        action: "Retry the request or check the Codex CLI connection.",
        diagnostics,
      });
    },
  };
  const service = makeService({
    provider,
    onDiagnostics: (snapshot) => observedDiagnostics.push(snapshot),
  });

  await service.start({ prompt: "Question", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  await service.whenIdle();

  const state = service.getState();
  assert.equal(state.status, "error");
  assert.equal(state.error.code, "CLI_IDLE_TIMEOUT");
  assert.equal(state.error.message, "Codex CLI became idle before completing the request.");
  assert.equal(state.error.diagnostics, undefined);
  assert.deepEqual(observedDiagnostics, [diagnostics]);
});
