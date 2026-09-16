import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/codex-run-diagnostics.js");
const {
  CodexRunDiagnostics,
  createCodexRunDiagnosticsSink,
} = await import(pathToFileURL(modulePath).href);

test("CodexRunDiagnostics records first milestones and refreshes last-event", () => {
  const diagnostics = new CodexRunDiagnostics(1000);

  diagnostics.mark("spawn", 1000);
  diagnostics.mark("first-byte", 1042);
  diagnostics.mark("first-jsonl", 1100);
  diagnostics.mark("last-event", 1100);
  diagnostics.mark("last-event", 1160);
  diagnostics.mark("first-delta", 1200);
  diagnostics.mark("exit", 1300);
  diagnostics.setExit(0, null);

  assert.deepEqual(diagnostics.snapshot(1500), {
    elapsedMs: 500,
    milestones: {
      spawn: 0,
      "first-byte": 42,
      "first-jsonl": 100,
      "last-event": 160,
      "first-delta": 200,
      exit: 300,
    },
    exitCode: 0,
    exitSignal: null,
    stderrTail: "",
  });
});

test("CodexRunDiagnostics caps stderr and redacts sensitive values", () => {
  const diagnostics = new CodexRunDiagnostics(1000);
  diagnostics.appendStderr("x".repeat(5000));
  diagnostics.appendStderr([
    "Authorization: Bearer redacted-bearer-value",
    "Cookie: session=redacted-cookie-value; refresh=redacted-refresh-value",
    "FLUELY_API_KEY=redacted-key-value TOKEN=redacted-token-value PASSWORD=redacted-password-value",
    `home=${homedir()}/private-workspace`,
  ].join("\n"));

  const snapshot = diagnostics.snapshot(1500);

  assert.ok(snapshot.stderrTail.length <= 4096);
  assert.match(snapshot.stderrTail, /\[REDACTED\]/);
  assert.doesNotMatch(snapshot.stderrTail, /redacted-bearer-value|redacted-cookie-value|redacted-refresh-value/);
  assert.doesNotMatch(snapshot.stderrTail, /redacted-key-value|redacted-token-value|redacted-password-value/);
  assert.doesNotMatch(snapshot.stderrTail, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CodexRunDiagnostics redacts complete unquoted assignments through line boundaries", () => {
  const diagnostics = new CodexRunDiagnostics(1000);
  diagnostics.appendStderr([
    "FLUELY_API_KEY=alpha bravo; charlie,delta]omega",
    "refresh_token: first segment; second segment, third segment",
    "Cookie: session=one two; Path=/private, refresh=three four",
    "session_cookie=primary value; trailing value, final value",
    "safe=value remains visible",
  ].join("\n"));

  const { stderrTail } = diagnostics.snapshot(1500);

  assert.doesNotMatch(stderrTail, /alpha|bravo|charlie|delta|omega/);
  assert.doesNotMatch(stderrTail, /first segment|second segment|third segment/);
  assert.doesNotMatch(stderrTail, /one two|\/private|three four/);
  assert.doesNotMatch(stderrTail, /primary value|trailing value|final value/);
  assert.match(stderrTail, /safe=value remains visible/);
});

test("CodexRunDiagnostics caps stderr at 4096 UTF-8 bytes without splitting code points", () => {
  const diagnostics = new CodexRunDiagnostics(1000);
  diagnostics.appendStderr("🙂".repeat(1025));

  const { stderrTail } = diagnostics.snapshot(1500);

  assert.equal(Buffer.byteLength(stderrTail, "utf8"), 4096);
  assert.doesNotMatch(stderrTail, /�/);
  assert.equal([...stderrTail].length, 1024);
});

test("main-process diagnostics sink logs only re-sanitized structured snapshots", () => {
  const writes = [];
  const sink = createCodexRunDiagnosticsSink((message, snapshot) => {
    writes.push({ message, snapshot });
  });

  sink({
    elapsedMs: 42,
    milestones: { spawn: 0, "last-event": 20 },
    exitCode: 1,
    exitSignal: "SIGTERM",
    stderrTail: `workspace=${homedir()}/private\nAPI_TOKEN=alpha beta; trailing-secret`,
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].message, "Fluely Codex CLI diagnostics");
  assert.equal(writes[0].snapshot.elapsedMs, 42);
  const logged = JSON.stringify(writes[0].snapshot);
  assert.match(logged, /\[HOME\]|\[REDACTED\]/);
  assert.doesNotMatch(logged, /alpha beta|trailing-secret/);
  assert.doesNotMatch(logged, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CodexRunDiagnostics snapshots are immutable and isolated from later marks", () => {
  const diagnostics = new CodexRunDiagnostics(1000);
  diagnostics.mark("spawn", 1000);
  const snapshot = diagnostics.snapshot(1100);

  assert.throws(() => {
    snapshot.milestones.spawn = 999;
  }, TypeError);

  diagnostics.mark("last-event", 1200);
  assert.equal(snapshot.milestones["last-event"], undefined);
  assert.equal(snapshot.elapsedMs, 100);
});
