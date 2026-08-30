import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  await assert.rejects(
    (async () => {
      for await (const _delta of CodexCliService.stream(executable, {
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
