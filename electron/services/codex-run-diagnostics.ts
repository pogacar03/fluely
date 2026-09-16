import { homedir } from "node:os";

const STDERR_TAIL_LIMIT = 4096;
const HOME_DIRECTORY = homedir();
const DIAGNOSTICS_LOG_LABEL = "Fluely Codex CLI diagnostics";

export type CodexRunMilestone =
  | "spawn"
  | "first-byte"
  | "first-jsonl"
  | "last-event"
  | "first-delta"
  | "exit";

export type CodexRunDiagnosticsSnapshot = Readonly<{
  elapsedMs: number;
  milestones: Partial<Record<CodexRunMilestone, number>>;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stderrTail: string;
}>;

export interface CodexRunDiagnostics {
  readonly startedAtMs: number;
  mark(milestone: CodexRunMilestone, atMs?: number): void;
  setExit(code: number | null, signal: NodeJS.Signals | null): void;
  appendStderr(chunk: string): void;
  snapshot(nowMs?: number): CodexRunDiagnosticsSnapshot;
}

export type CodexRunDiagnosticsWriter = (
  message: string,
  snapshot: CodexRunDiagnosticsSnapshot,
) => void;

function redactSensitiveText(value: string): string {
  let redacted = value;

  if (HOME_DIRECTORY) {
    redacted = redacted.split(HOME_DIRECTORY).join("[HOME]");
  }

  redacted = redacted.replace(/\b(Bearer\s+)[^\r\n]*/gi, "$1[REDACTED]");
  redacted = redacted.replace(
    /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]*/gi,
    "$1: [REDACTED]",
  );
  redacted = redacted.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[=:]\s*)[^\r\n]*/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(
    /(\b[A-Za-z0-9_-]*(?:cookie|session)[A-Za-z0-9_-]*\s*=\s*)[^\r\n]*/gi,
    "$1[REDACTED]",
  );

  return redacted;
}

function truncateUtf8Tail(value: string, maxBytes = STDERR_TAIL_LIMIT): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

function sanitizedSnapshot(snapshot: CodexRunDiagnosticsSnapshot): CodexRunDiagnosticsSnapshot {
  return Object.freeze({
    elapsedMs: snapshot.elapsedMs,
    milestones: Object.freeze({ ...snapshot.milestones }),
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
    stderrTail: truncateUtf8Tail(redactSensitiveText(snapshot.stderrTail)),
  });
}

export function createCodexRunDiagnosticsSink(
  write: CodexRunDiagnosticsWriter = (message, snapshot) => console.warn(message, snapshot),
): (snapshot: CodexRunDiagnosticsSnapshot) => void {
  return (snapshot) => write(DIAGNOSTICS_LOG_LABEL, sanitizedSnapshot(snapshot));
}

function elapsedSince(startedAtMs: number, atMs: number): number {
  return Math.max(0, Math.round(atMs - startedAtMs));
}

export class CodexRunDiagnosticsImpl implements CodexRunDiagnostics {
  public readonly startedAtMs: number;

  private readonly milestones: Partial<Record<CodexRunMilestone, number>> = {};
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private stderrTail = "";

  public constructor(startedAtMs = Date.now()) {
    this.startedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  }

  public mark(milestone: CodexRunMilestone, atMs = Date.now()): void {
    const elapsedMs = elapsedSince(this.startedAtMs, atMs);
    if (milestone === "last-event" || this.milestones[milestone] === undefined) {
      this.milestones[milestone] = elapsedMs;
    }
  }

  public setExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.exitSignal = signal;
    this.mark("exit");
  }

  public appendStderr(chunk: string): void {
    if (typeof chunk !== "string" || chunk.length === 0) {
      return;
    }
    this.stderrTail = truncateUtf8Tail(redactSensitiveText(`${this.stderrTail}${chunk}`));
  }

  public snapshot(nowMs = Date.now()): CodexRunDiagnosticsSnapshot {
    const milestones = Object.freeze({ ...this.milestones });
    return Object.freeze({
      elapsedMs: elapsedSince(this.startedAtMs, nowMs),
      milestones,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      stderrTail: this.stderrTail,
    });
  }
}

export const CodexRunDiagnostics = CodexRunDiagnosticsImpl;
