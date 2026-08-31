import { homedir } from "node:os";

const STDERR_TAIL_LIMIT = 4096;
const HOME_DIRECTORY = homedir();

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

function redactCookieValues(value: string): string {
  return value.replace(
    /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;,]+)/g,
    "$1=[REDACTED]",
  );
}

function redactSensitiveText(value: string): string {
  let redacted = value;

  if (HOME_DIRECTORY) {
    redacted = redacted.split(HOME_DIRECTORY).join("[HOME]");
  }

  redacted = redacted.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(
    /\b(Cookie|Set-Cookie)\s*:\s*([^\r\n]*)/gi,
    (_match, header: string, cookies: string) => `${header}: ${redactCookieValues(cookies)}`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/gi,
    (match: string, prefix: string, _value: string) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(prefix)
      ? `${prefix}[REDACTED]`
      : match,
  );
  redacted = redacted.replace(
    /(\b[A-Za-z0-9_-]*(?:cookie|session)[A-Za-z0-9_-]*\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/gi,
    "$1[REDACTED]",
  );

  return redacted;
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
    this.stderrTail = redactSensitiveText(`${this.stderrTail}${chunk}`).slice(-STDERR_TAIL_LIMIT);
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
