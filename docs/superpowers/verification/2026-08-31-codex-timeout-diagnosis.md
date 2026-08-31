# Codex CLI timeout diagnosis

Date: 2026-08-31

Task: Plan A / Task 1

Base HEAD: `a8a77c66e45f4503b674442f5b7e19952326b3f2`

Branch: `codex/fluely-foundation`

## Scope and safety

The configured CLI was exercised directly with the same executable name,
model, reasoning setting, sandbox, JSONL mode, and stdin prompt contract used
by Fluely. The Fluely Electron app was not launched. The pre-existing packaged
app was not modified or terminated. Prompts, image paths, credentials, home
directory paths, and raw model output are intentionally absent from this
report.

## Controlled matrix

Both probes were run through an external `alarm 600` wrapper. The effective
command shape was:

`codex exec --ephemeral --json --color never --sandbox read-only --model gpt-5.6-sol --config model_reasoning_effort=medium`

| Probe | Image count | Elapsed | First byte | First valid JSONL | Last valid event | First visible delta | Exit | Valid events | Timeout stage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| benign text | 0 | 117863 ms | 302 ms | 302 ms | 117108 ms | not emitted | 0 | 10 | none |
| generated test image | 1 | 121063 ms | 230 ms | 230 ms | 119110 ms | not emitted | 0 | 10 | none |

The observed valid event types included `thread.started`, `item.completed`,
`turn.started`, and `error`. Both runs emitted protocol events promptly, then
reported repeated provider sampling request timeouts and an HTTP fallback in
stderr before clean exit. The stderr evidence was reduced to that redacted
summary; no raw stderr is retained here.

## Timeout-policy gate

The gate passed because both controlled probes emitted valid lifecycle/result
events well before the 600000 ms ceiling. The implementation therefore uses:

- 120000 ms startup deadline until the first valid JSONL event;
- 120000 ms idle deadline refreshed by valid protocol events;
- 600000 ms absolute hard deadline that never resets;
- no idle refresh for malformed JSON or raw stderr;
- immediate, separately typed abort handling.

The probe results diagnose provider-side sampling instability rather than
startup silence. They do not prove a successful visible answer, so provider
availability remains a concern for the later user gate.

## Evidence limitations

The takeover inherited no prior Task 1 report or durable RED/GREEN/probe
ledger. The two early recovery probe attempts were invalid before child spawn:
one failed in the Perl locale wrapper and one had an inline probe syntax error.
Neither produced runtime evidence or a live child. Historical RED/GREEN claims
for the inherited implementation cannot be independently verified; the fresh
RED/GREEN cycle below is the authoritative recovery evidence.

## Fresh TDD evidence

The regression test `stream ignores empty deltas and still yields the completed
answer` first failed with `INVALID_OUTPUT: Codex CLI returned an empty answer`
against the inherited implementation. The minimal fix ignores empty deltas in
both the streaming path and aggregate text extraction. The focused service and
diagnostics run then passed 24/24 tests.

## Implementation summary

- Added `CodexRunDiagnostics` with milestone timestamps, immutable snapshots,
  a 4 KiB redacted stderr tail, and safe handling for bearer/cookie/home/path
  and sensitive environment-variable values.
- Instrumented Codex spawn, stdout bytes, valid JSONL events, visible deltas,
  exit, and timeout stage without exposing diagnostics through `IpcError`.
- Replaced the single stream wall-clock timer with startup/idle/hard deadlines
  and preserved abort/process termination behavior.
- Added typed timeout categories to the shared IPC error contract and kept
  renderer-facing messages concise and safe.
- Changed the repository test script to `node --test`.

## Verification commands

The inherited post-change comparison was rerun before the recovery fix:

- `npm run build:electron && node --test electron/services/__tests__/*.test.mjs` — 142/142 passed.
- `npm test -- --test-reporter=spec` — 151/151 passed.
- Focused RED: `npm run build:electron && node --test electron/services/__tests__/CodexCliService.test.mjs` — 20/21 passed, expected empty-delta failure.
- Focused GREEN: `npm run build:electron && node --test electron/services/__tests__/CodexCliService.test.mjs electron/services/__tests__/codex-run-diagnostics.test.mjs` — 24/24 passed.

Final `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and
commit details are recorded in the takeover report once the fresh final gates
complete.
