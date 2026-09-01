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

  const started = service.start({
    prompt: "What is shown?",
    screenshotIds: [FIRST_ID],
    intent: "answer",
    fast: false,
  });

  assert.equal(started.status, "running");
  assert.throws(
    () => service.start({
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

  const initial = service.start({
    prompt: "  Summarize this screen  ",
    screenshotIds: [FIRST_ID, "unknown", SECOND_ID],
    intent: "explain",
    fast: true,
  });
  assert.equal(initial.status, "running");

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

  service.start({ prompt: "Question", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
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

  service.start({ prompt: "First", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  for (let attempt = 0; attempt < 20 && releases.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(releases.length, 1);

  service.cancel();
  assert.throws(
    () => service.start({ prompt: "Overlapping", screenshotIds: [FIRST_ID], intent: "answer", fast: false }),
    (error) => error?.code === "ANALYSIS_IN_PROGRESS",
  );

  releases.shift()();
  await service.whenIdle();

  service.start({ prompt: "After cleanup", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
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

  service.start({ prompt: "Question", screenshotIds: undefined, intent: "recap", fast: false });
  await service.whenIdle();

  const after = screenshots.getState();
  assert.deepEqual(after, before);
  assert.equal(service.getState().status, "error");
  assert.equal(service.getState().text, "partial");
  assert.match(service.getState().error.message, /not logged in/i);
  assert.deepEqual(events.map((event) => event.event), ["started", "delta", "error"]);
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

  service.start({ prompt: "Question", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
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

  service.start({ prompt: "Question", screenshotIds: [FIRST_ID], intent: "answer", fast: false });
  await service.whenIdle();

  const state = service.getState();
  assert.equal(state.status, "error");
  assert.equal(state.error.code, "CLI_IDLE_TIMEOUT");
  assert.equal(state.error.message, "Codex CLI became idle before completing the request.");
  assert.equal(state.error.diagnostics, undefined);
  assert.deepEqual(observedDiagnostics, [diagnostics]);
});
