import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/CodexCliService.js");
const { CodexCliService } = await import(pathToFileURL(modulePath).href);

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeExecutable(body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fluely-codex-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-codex");
  await writeFile(executable, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

function makeFakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.killed = true;
    return true;
  };
  return child;
}

function makeClosingFakeProcess() {
  const child = makeFakeProcess();
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.killed = true;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

function makeFakeTimers(start = 0) {
  let now = start;
  let nextId = 0;
  const timers = new Map();
  const history = [];

  function setTimeoutFake(callback, delay) {
    const timer = { id: nextId++, at: now + delay, callback };
    timers.set(timer.id, timer);
    history.push(delay);
    return timer;
  }

  function clearTimeoutFake(timer) {
    if (timer) {
      timers.delete(timer.id);
    }
  }

  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const due = [...timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) {
        break;
      }
      timers.delete(due.id);
      now = due.at;
      due.callback();
    }
    now = target;
  }

  return {
    now: () => now,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    advance,
    history,
    pending: () => timers.size,
  };
}

function runFakeStream(service, options = {}) {
  const result = { deltas: [], error: null };
  const promise = (async () => {
    try {
      for await (const delta of service.stream("fake-codex", {
        prompt: "question",
        timeoutMs: 100,
        ...options,
      })) {
        result.deltas.push(delta);
      }
    } catch (error) {
      result.error = error;
    }
  })();
  return { result, promise };
}

function makeDeadlineService(timers, child, deadlinePolicy) {
  return new CodexCliService({
    spawn: () => child,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    deadlinePolicy,
  });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("buildArgs preserves the Codex exec contract and repeats image flags", () => {
  assert.deepEqual(
    CodexCliService.buildArgs(
      "gpt-custom",
      ["/tmp/one.png", "/tmp/two.png"],
      "read-only",
      "high",
    ),
    [
      "exec",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-custom",
      "--config",
      "model_reasoning_effort=high",
      "--image",
      "/tmp/one.png",
      "--image",
      "/tmp/two.png",
    ],
  );
});

test("extractText concatenates agent-message deltas and suppresses lifecycle events", () => {
  const raw = [
    JSON.stringify({ type: "agent_message.delta", delta: "Hello" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.delta", item_id: "answer-1", delta: " world" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ignored duplicate" } }),
  ].join("\n");

  assert.equal(CodexCliService.extractText(raw), "Hello world");
});

test("extractText supports event-msg agent deltas, plain text, and ignores errors", () => {
  assert.equal(
    CodexCliService.extractText([
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message_content_delta", delta: "A" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message_content_delta", delta: "B" } }),
      JSON.stringify({ type: "error", message: "provider failed" }),
    ].join("\n")),
    "AB",
  );
  assert.equal(CodexCliService.extractText("plain text answer"), "plain text answer");
  assert.equal(CodexCliService.extractText(JSON.stringify({ type: "error", message: "provider failed" })), "");
  assert.equal(
    CodexCliService.extractError(JSON.stringify({ type: "error", message: "provider failed" })),
    "provider failed",
  );
});

test("extractText reads completed agent messages and exposes completed item errors", () => {
  assert.equal(
    CodexCliService.extractText(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "completed answer" },
    })),
    "completed answer",
  );
  assert.equal(
    CodexCliService.extractError(JSON.stringify({
      type: "item.completed",
      item: { type: "error", message: "completed provider failure" },
    })),
    "completed provider failure",
  );
});

test("validateExecutable returns a resolved executable without throwing", async () => {
  const executable = await makeExecutable('printf "codex-cli test-version\\n"');

  const result = await CodexCliService.validateExecutable(executable, 500);

  assert.deepEqual(result, { success: true, resolvedPath: executable });
});

test("validateExecutable reports missing executables as actionable errors", async () => {
  const result = await CodexCliService.validateExecutable("/definitely/missing/fluely-codex", 500);

  assert.equal(result.success, false);
  assert.equal(result.resolvedPath, undefined);
  assert.equal(result.error.code, "NOT_FOUND");
  assert.match(result.error.message, /not found|could not start/i);
  assert.match(result.error.action, /codex/i);
});

test("validateExecutable force-kills timed out children and removes process listeners", async () => {
  const child = makeFakeProcess();
  const service = new CodexCliService({ spawn: () => child });

  const resultPromise = service.validateExecutable("/tmp/fake-codex", 10);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await resultPromise;

  assert.equal(result.success, false);
  assert.equal(result.error.code, "TIMEOUT");
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("stream yields parsed deltas and writes the prompt to stdin", async () => {
  const executable = await makeExecutable([
    "input=$(cat)",
    "[ \"$input\" = \"question\" ] || exit 41",
    "printf '%s\\n' '{\"type\":\"agent_message.delta\",\"delta\":\"answer\"}'",
  ].join("\n"));

  const deltas = [];
  for await (const delta of CodexCliService.stream(executable, {
    prompt: "question",
    model: "gpt-custom",
    imagePaths: [],
    sandboxMode: "read-only",
    timeoutMs: 1000,
  })) {
    deltas.push(delta);
  }

  assert.deepEqual(deltas, ["answer"]);
});

test("stream yields completed agent item text", async () => {
  const executable = await makeExecutable([
    "cat >/dev/null",
    "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"completed answer\"}}'",
  ].join("\n"));

  const deltas = [];
  for await (const delta of CodexCliService.stream(executable, {
    prompt: "question",
    model: "gpt-custom",
    timeoutMs: 1000,
  })) {
    deltas.push(delta);
  }

  assert.deepEqual(deltas, ["completed answer"]);
});

test("stream ignores empty deltas and still yields the completed answer", async () => {
  const executable = await makeExecutable([
    "cat >/dev/null",
    "printf '%s\\n' '{\"type\":\"agent_message.delta\",\"delta\":\"\"}'",
    "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"completed after empty delta\"}}'",
  ].join("\n"));

  const deltas = [];
  for await (const delta of CodexCliService.stream(executable, {
    prompt: "question",
    model: "gpt-custom",
  })) {
    deltas.push(delta);
  }

  assert.deepEqual(deltas, ["completed after empty delta"]);
});

test("stream records protocol milestones and publishes a redacted diagnostic snapshot", async () => {
  const child = makeFakeProcess();
  const snapshots = [];
  let clock = 1000;
  const service = new CodexCliService({
    spawn: () => {
      queueMicrotask(() => {
        child.stderr.write(`Authorization: Bearer fake-bearer-value home=${os.homedir()}/private`);
        child.stdout.write("{malformed json\n");
        child.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "agent_message.delta", delta: "answer" })}\n`);
        child.emit("close", 0, null);
      });
      return child;
    },
    now: () => {
      const value = clock;
      clock += 10;
      return value;
    },
    onDiagnostics: (snapshot) => snapshots.push(snapshot),
  });

  const deltas = [];
  for await (const delta of service.stream("fake-codex", {
    prompt: "question",
    model: "gpt-custom",
  })) {
    deltas.push(delta);
  }

  assert.deepEqual(deltas, ["answer"]);
  assert.equal(snapshots.length, 1);
  const { milestones, exitCode, exitSignal, stderrTail } = snapshots[0];
  assert.equal(exitCode, 0);
  assert.equal(exitSignal, null);
  assert.equal(milestones.spawn, 0);
  assert.ok(milestones["first-byte"] >= milestones.spawn);
  assert.ok(milestones["first-jsonl"] >= milestones["first-byte"]);
  assert.ok(milestones["last-event"] >= milestones["first-jsonl"]);
  assert.ok(milestones["first-delta"] >= milestones["first-jsonl"]);
  assert.ok(milestones.exit >= milestones["last-event"]);
  assert.match(stderrTail, /\[REDACTED\]/);
  assert.doesNotMatch(stderrTail, /fake-bearer-value/);
  assert.doesNotMatch(stderrTail, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("stream errors carry safe diagnostics without exposing raw stderr", async () => {
  const child = makeFakeProcess();
  const snapshots = [];
  const service = new CodexCliService({
    spawn: () => {
      queueMicrotask(() => {
        child.stderr.write("Cookie: session=fake-cookie-value\nFLUELY_API_KEY=fake-key-value");
        child.emit("close", 2, "SIGTERM");
      });
      return child;
    },
    onDiagnostics: (snapshot) => snapshots.push(snapshot),
  });

  await assert.rejects(
    (async () => {
      for await (const _delta of service.stream("fake-codex", { prompt: "question" })) {
        // The fixture exits with a process failure.
      }
    })(),
    (error) => {
      assert.equal(error.code, "PROCESS_FAILED");
      assert.equal(error.diagnostics.exitCode, 2);
      assert.equal(error.diagnostics.exitSignal, "SIGTERM");
      assert.match(error.diagnostics.stderrTail, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /fake-cookie-value|fake-key-value/);
      assert.equal(snapshots.length, 1);
      return true;
    },
  );
});

test("stream handles stdin EPIPE without an unhandled error", async () => {
  const child = makeFakeProcess();
  const service = new CodexCliService({
    spawn: () => {
      queueMicrotask(() => {
        child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        child.emit("close", 0);
      });
      return child;
    },
  });

  await assert.rejects(
    (async () => {
      for await (const _delta of service.stream("fake-codex", {
        prompt: "question",
        model: "gpt-custom",
        timeoutMs: 1000,
      })) {
        // The fake process fails before producing an answer.
      }
    })(),
    /EPIPE|stdin|failed/i,
  );
});

test("stream terminates the child when its AbortSignal is aborted", async () => {
  const executable = await makeExecutable("trap 'exit 130' TERM INT\nwhile :; do sleep 1; done");
  const controller = new AbortController();
  const stream = CodexCliService.stream(executable, {
    prompt: "question",
    model: "gpt-custom",
    signal: controller.signal,
    timeoutMs: 5000,
  });

  const reading = (async () => {
    for await (const _delta of stream) {
      // The fixture never emits a delta; this loop should terminate by abort.
    }
  })();
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(reading, /abort|cancel/i);
});

test("stream terminates the child and reports timeout", async () => {
  const executable = await makeExecutable("while :; do sleep 1; done");
  const service = new CodexCliService({
    deadlinePolicy: { startupMs: 30, idleMs: 30, hardMs: 60 },
  });

  await assert.rejects(
    (async () => {
      for await (const _delta of service.stream(executable, {
        prompt: "question",
        model: "gpt-custom",
        timeoutMs: 30,
      })) {
        // The fixture never emits a delta; this loop should terminate by timeout.
      }
    })(),
    /timed out|timeout/i,
  );
});

test("stream reports a startup timeout before any valid protocol event", async () => {
  const timers = makeFakeTimers();
  const child = makeClosingFakeProcess();
  const service = makeDeadlineService(timers, child, { startupMs: 100, idleMs: 100, hardMs: 300 });
  const run = runFakeStream(service);
  await flush();

  timers.advance(99);
  await flush();
  assert.equal(run.result.error, null);

  timers.advance(1);
  await flush();
  await run.promise;

  assert.equal(run.result.error.code, "CLI_START_TIMEOUT");
  assert.equal(run.result.error.diagnostics.milestones.spawn, 0);
  assert.equal(run.result.error.diagnostics.milestones["first-jsonl"], undefined);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("valid lifecycle events refresh the idle deadline", async () => {
  const timers = makeFakeTimers();
  const child = makeClosingFakeProcess();
  const service = makeDeadlineService(timers, child, { startupMs: 100, idleMs: 100, hardMs: 500 });
  const run = runFakeStream(service);
  await flush();

  child.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  await flush();
  timers.advance(80);
  child.stdout.write(`${JSON.stringify({ type: "turn.progress" })}\n`);
  await flush();
  timers.advance(99);
  await flush();
  assert.equal(run.result.error, null);

  timers.advance(1);
  await flush();
  await run.promise;
  assert.equal(run.result.error.code, "CLI_IDLE_TIMEOUT");
  assert.equal(run.result.error.diagnostics.milestones["last-event"], 80);
});

test("malformed stdout and raw stderr do not refresh the idle deadline", async () => {
  const timers = makeFakeTimers();
  const child = makeClosingFakeProcess();
  const service = makeDeadlineService(timers, child, { startupMs: 100, idleMs: 100, hardMs: 500 });
  const run = runFakeStream(service);
  await flush();

  child.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  await flush();
  timers.advance(80);
  child.stdout.write("{malformed json\n");
  child.stderr.write("still working\n");
  await flush();
  timers.advance(19);
  await flush();
  assert.equal(run.result.error, null);

  timers.advance(1);
  await flush();
  await run.promise;
  assert.equal(run.result.error.code, "CLI_IDLE_TIMEOUT");
  assert.equal(run.result.error.diagnostics.milestones["last-event"], 0);
});

test("the hard deadline fires despite continuous valid progress", async () => {
  const timers = makeFakeTimers();
  const child = makeClosingFakeProcess();
  const service = makeDeadlineService(timers, child, { startupMs: 100, idleMs: 100, hardMs: 300 });
  const run = runFakeStream(service);
  await flush();

  child.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  await flush();
  for (let elapsed = 50; elapsed <= 250; elapsed += 50) {
    timers.advance(50);
    child.stdout.write(`${JSON.stringify({ type: "turn.progress" })}\n`);
    await flush();
  }
  timers.advance(49);
  await flush();
  assert.equal(run.result.error, null);

  timers.advance(1);
  await flush();
  await run.promise;
  assert.equal(run.result.error.code, "CLI_HARD_TIMEOUT");
  assert.equal(run.result.error.diagnostics.milestones["last-event"], 250);
});

test("completion clears startup, idle, hard, and force-kill timers", async () => {
  const timers = makeFakeTimers();
  const child = makeClosingFakeProcess();
  const service = makeDeadlineService(timers, child, { startupMs: 100, idleMs: 100, hardMs: 300 });
  const run = runFakeStream(service);
  await flush();

  child.stdout.write(`${JSON.stringify({ type: "agent_message.delta", delta: "answer" })}\n`);
  child.emit("close", 0, null);
  await run.promise;

  assert.deepEqual(run.result.deltas, ["answer"]);
  assert.equal(run.result.error, null);
  assert.deepEqual([...timers.history].sort((left, right) => left - right), [100, 100, 300]);
  assert.equal(timers.pending(), 0);
});

test("cancellation is distinct from every timeout category", async () => {
  const timers = makeFakeTimers();
  const child = makeClosingFakeProcess();
  const service = makeDeadlineService(timers, child, { startupMs: 100, idleMs: 100, hardMs: 300 });
  const controller = new AbortController();
  const run = runFakeStream(service, { signal: controller.signal });
  await flush();

  controller.abort();
  await flush();
  await run.promise;

  assert.equal(run.result.error.name, "AbortError");
  assert.equal(run.result.error.code, "ABORTED");
  assert.equal(run.result.error.diagnostics, undefined);
  assert.equal(timers.pending(), 0);
});
