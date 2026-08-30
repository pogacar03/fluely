import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  CodexModelReasoningEffort,
  CodexSandboxMode,
} from "../../src/shared/ipc";

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_SANDBOX_MODE: CodexSandboxMode = "read-only";
const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];
const CODEX_REASONING_EFFORTS: readonly CodexModelReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type CodexCliErrorCode =
  | "NOT_FOUND"
  | "VERSION_FAILED"
  | "TIMEOUT"
  | "ABORTED"
  | "PROCESS_FAILED"
  | "INVALID_OUTPUT";

export interface CodexCliError {
  code: CodexCliErrorCode;
  message: string;
  action: string;
}

export interface CodexExecutableValidation {
  success: boolean;
  resolvedPath?: string;
  error?: CodexCliError;
}

export interface CodexCliStreamOptions {
  prompt: string;
  model?: string;
  imagePaths?: readonly string[];
  /** Alias accepted for callers that use the shorter image terminology. */
  images?: readonly string[];
  sandboxMode?: CodexSandboxMode;
  reasoningEffort?: CodexModelReasoningEffort;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface SpawnedProcess extends ChildProcess {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
}

interface CodexCliDependencies {
  spawn?: typeof nodeSpawn;
}

interface ParsedEvent {
  type?: unknown;
  delta?: unknown;
  data?: unknown;
  payload?: unknown;
  event?: unknown;
  item?: unknown;
  text?: unknown;
  role?: unknown;
  message?: unknown;
  error?: unknown;
}

function asRecord(value: unknown): ParsedEvent | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ParsedEvent
    : null;
}

function isSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === "string" && CODEX_SANDBOX_MODES.includes(value as CodexSandboxMode);
}

function isReasoningEffort(value: unknown): value is CodexModelReasoningEffort {
  return typeof value === "string" && CODEX_REASONING_EFFORTS.includes(value as CodexModelReasoningEffort);
}

function isAgentDeltaType(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.toLowerCase().replace(/[.:]/g, "_");
  return normalized.includes("agent_message") && normalized.includes("delta");
}

function getAgentDelta(value: unknown, depth = 0): string | null {
  if (depth > 5) {
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (isAgentDeltaType(record.type) && typeof record.delta === "string") {
    return record.delta;
  }

  // Some versions expose assistant output as message.delta rather than the
  // longer agent_message_content_delta event name.
  if (record.type === "message.delta" &&
    (record.role === "assistant" || record.role === "agent") &&
    typeof record.delta === "string") {
    return record.delta;
  }

  // Responses-compatible event names are accepted only when they identify
  // assistant output, never arbitrary lifecycle or tool events.
  if ((record.type === "response.output_text.delta" || record.type === "output_text.delta") &&
    typeof record.delta === "string") {
    return record.delta;
  }

  if (record.type === "item.delta" && typeof record.delta === "string") {
    const item = asRecord(record.item);
    // Current Codex JSONL uses item.delta with only item_id and delta; the
    // item.started event is lifecycle-only, so a delta without item metadata
    // is the assistant's answer stream.
    if (!record.item || item?.type === "agent_message" || item?.type === "message" || item?.role === "assistant") {
      return record.delta;
    }
  }

  const completedAgentText = getCompletedAgentText(record);
  if (completedAgentText !== null) {
    return completedAgentText;
  }

  for (const nested of [record.payload, record.event, record.data]) {
    const delta = getAgentDelta(nested, depth + 1);
    if (delta !== null) {
      return delta;
    }
  }

  return null;
}

function getCompletedAgentText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record || record.type !== "item.completed") {
    return null;
  }

  const item = asRecord(record.item);
  return item?.type === "agent_message" && typeof item.text === "string"
    ? item.text
    : null;
}

function getErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 5) {
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "item.completed") {
    const item = asRecord(record.item);
    if (item?.type === "error") {
      if (typeof item.message === "string" && item.message.trim()) {
        return item.message.trim();
      }
      if (typeof item.error === "string" && item.error.trim()) {
        return item.error.trim();
      }
      return "Codex CLI reported an error.";
    }
  }
  if (type === "error" || type.endsWith(".error") || type.endsWith("_error") || type === "stream_error") {
    for (const candidate of [record.message, record.error]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      const candidateRecord = asRecord(candidate);
      if (typeof candidateRecord?.message === "string" && candidateRecord.message.trim()) {
        return candidateRecord.message.trim();
      }
      const nested = getErrorMessage(candidate, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return "Codex CLI reported an error.";
  }

  for (const nested of [record.payload, record.event, record.error]) {
    const message = getErrorMessage(nested, depth + 1);
    if (message) {
      return message;
    }
  }

  return null;
}

function normalizeExecutableInput(value: unknown): string {
  if (typeof value !== "string") {
    return "codex";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "codex";
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function isPathLike(value: string): boolean {
  return isAbsolute(value) || value.startsWith("~") || value.includes("/") || value.includes("\\");
}

function executableCandidates(value: unknown): string[] {
  const configured = normalizeExecutableInput(value);
  if (configured !== "codex" || isPathLike(configured)) {
    return [expandHome(configured)];
  }

  return [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(homedir(), ".local/bin/codex"),
    configured,
  ];
}

async function isExecutable(path: string): Promise<boolean> {
  if (!isPathLike(path)) {
    return true;
  }

  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function formatOutput(value: string, limit = 2000): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function createError(
  code: CodexCliErrorCode,
  message: string,
  action: string,
): CodexCliError {
  return { code, message, action };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(): Error {
  const error = new Error("Codex CLI request was aborted.");
  error.name = "AbortError";
  return error;
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Codex CLI request timed out after ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  return error;
}

function errorAsException(error: CodexCliError): Error & { code: CodexCliErrorCode; action: string } {
  const exception = new Error(error.message) as Error & { code: CodexCliErrorCode; action: string };
  exception.name = "CodexCliError";
  exception.code = error.code;
  exception.action = error.action;
  return exception;
}

/**
 * Main-process-only transport for the local Codex executable. It deliberately
 * accepts a narrow options object and always constructs its own argv array;
 * renderer input can never become an arbitrary child-process argument.
 */
export class CodexCliService {
  private readonly spawn: typeof nodeSpawn;

  public constructor(dependencies: CodexCliDependencies = {}) {
    this.spawn = dependencies.spawn ?? nodeSpawn;
  }

  public static buildArgs(
    model: string,
    imagePaths: readonly string[] = [],
    sandboxMode: CodexSandboxMode = DEFAULT_SANDBOX_MODE,
    reasoningEffort?: CodexModelReasoningEffort,
  ): string[] {
    const safeSandbox = isSandboxMode(sandboxMode) ? sandboxMode : DEFAULT_SANDBOX_MODE;
    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--sandbox",
      safeSandbox,
      "--model",
      typeof model === "string" && model.trim().length > 0 ? model.trim() : "gpt-5.6-sol",
    ];

    if (isReasoningEffort(reasoningEffort)) {
      args.push("--config", `model_reasoning_effort=${reasoningEffort}`);
    }

    for (const imagePath of imagePaths) {
      if (typeof imagePath === "string" && imagePath.trim().length > 0) {
        args.push("--image", imagePath);
      }
    }

    return args;
  }

  public buildArgs(
    model: string,
    imagePaths: readonly string[] = [],
    sandboxMode: CodexSandboxMode = DEFAULT_SANDBOX_MODE,
    reasoningEffort?: CodexModelReasoningEffort,
  ): string[] {
    return CodexCliService.buildArgs(model, imagePaths, sandboxMode, reasoningEffort);
  }

  /**
   * Extract only assistant answer deltas from Codex JSONL. Non-JSON output is
   * treated as the CLI's plain-text fallback, while lifecycle/error events are
   * intentionally suppressed.
   */
  public static extractText(raw: string): string {
    if (typeof raw !== "string" || raw.length === 0) {
      return "";
    }

    const deltas: string[] = [];
    const completedMessages: string[] = [];
    const plainText: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(line);
        const completedMessage = getCompletedAgentText(parsed);
        if (completedMessage !== null) {
          completedMessages.push(completedMessage);
          continue;
        }
        const delta = getAgentDelta(parsed);
        if (delta !== null) {
          deltas.push(delta);
        }
      } catch {
        plainText.push(line);
      }
    }

    if (deltas.length > 0) {
      return deltas.join("");
    }
    if (completedMessages.length > 0) {
      return completedMessages.join("");
    }
    return plainText.join("\n");
  }

  public extractText(raw: string): string {
    return CodexCliService.extractText(raw);
  }

  /** Extract a provider error message from a JSONL event or stderr text. */
  public static extractError(raw: string, stderr = ""): string | undefined {
    if (typeof raw === "string") {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        try {
          const message = getErrorMessage(JSON.parse(line));
          if (message) {
            return message;
          }
        } catch {
          // Plain text is handled by stderr or the stream's fallback parser.
        }
      }
    }

    const plainError = formatOutput(stderr);
    if (plainError.length > 0) {
      return plainError;
    }

    // A few CLI failures are printed as plain text to stdout instead of an
    // error event. Do not return JSON lifecycle records as if they were
    // errors, but preserve a useful non-JSON diagnostic when available.
    const plainOutput = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith("{"))
      .join("\n");
    return plainOutput.length > 0 ? formatOutput(plainOutput) : undefined;
  }

  public extractError(raw: string, stderr = ""): string | undefined {
    return CodexCliService.extractError(raw, stderr);
  }

  private async findExecutable(value: unknown): Promise<string> {
    const candidates = executableCandidates(value);
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }

    // Keep a bare command as the final candidate so spawn can provide the
    // platform's precise ENOENT/EACCES detail when PATH lookup is unavailable.
    return candidates[candidates.length - 1];
  }

  private runVersion(candidate: string, timeoutMs: number): Promise<CodexExecutableValidation> {
    return new Promise((resolve) => {
      let child: SpawnedProcess;
      try {
        child = this.spawn(candidate, ["--version"], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        }) as unknown as SpawnedProcess;
      } catch (error) {
        const message = toError(error).message;
        resolve({
          success: false,
          error: createError(
            "NOT_FOUND",
            `Codex executable could not be started: ${message}`,
            "Install Codex CLI or choose its executable path in Fluely settings.",
          ),
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const timeoutResult: CodexExecutableValidation = {
        success: false,
        error: createError(
          "TIMEOUT",
          `Codex CLI did not respond to --version within ${timeoutMs}ms.`,
          "Check that the Codex executable is healthy, then retry validation.",
        ),
      };

      const onStdout = (chunk: Buffer | string): void => {
        stdout += chunk.toString();
      };
      const onStderr = (chunk: Buffer | string): void => {
        stderr += chunk.toString();
      };
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
      };
      const finish = (result: CodexExecutableValidation): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };
      const onError = (error: Error): void => {
        if (timedOut) {
          finish(timeoutResult);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        finish({
          success: false,
          error: createError(
            code === "ENOENT" ? "NOT_FOUND" : "VERSION_FAILED",
            code === "ENOENT"
              ? `Codex executable was not found at ${candidate}.`
              : `Codex CLI could not run --version: ${toError(error).message}`,
            code === "ENOENT"
              ? "Install Codex CLI or choose the correct executable path in Fluely settings."
              : "Check the Codex executable permissions and try validation again.",
          ),
        });
      };
      const onClose = (code: number | null): void => {
        if (timedOut) {
          finish(timeoutResult);
          return;
        }
        if (code === 0) {
          finish({ success: true, resolvedPath: candidate });
          return;
        }

        const detail = formatOutput(stderr || stdout);
        finish({
          success: false,
          error: createError(
            "VERSION_FAILED",
            `Codex CLI --version exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : "."}`,
            "Check the Codex executable and run codex --version in Terminal.",
          ),
        });
      };
      const onTimeout = (): void => {
        if (settled || timedOut) {
          return;
        }
        timedOut = true;
        // Give a well-behaved CLI a chance to exit, then force-kill a child
        // that ignores SIGTERM. The result remains a validation timeout in
        // either case.
        forceKillTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          try {
            child.kill("SIGKILL");
          } finally {
            finish(timeoutResult);
          }
        }, 250);
        try {
          child.kill("SIGTERM");
        } catch {
          // The force-kill timer still settles the validation result.
        }
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      timer = setTimeout(onTimeout, timeoutMs);
    });
  }

  public static async validateExecutable(
    path: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CodexExecutableValidation> {
    return new CodexCliService().validateExecutable(path, timeoutMs);
  }

  public async validateExecutable(
    path: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CodexExecutableValidation> {
    const safeTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.round(timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const candidates = executableCandidates(path);
    let lastFailure: CodexExecutableValidation | undefined;
    for (const candidate of candidates) {
      const result = await this.runVersion(candidate, safeTimeout);
      if (result.success) {
        return result;
      }
      lastFailure = result;
      // Explicit paths and custom bare commands have no alternate candidates.
      if (candidates.length === 1 || result.error?.code === "TIMEOUT") {
        return result;
      }
    }

    return lastFailure ?? {
      success: false,
      error: createError(
        "NOT_FOUND",
        "Codex executable could not be found.",
        "Install Codex CLI or choose its executable path in Fluely settings.",
      ),
    };
  }

  private async *streamInternal(path: string, options: CodexCliStreamOptions): AsyncGenerator<string> {
    if (options.signal?.aborted) {
      throw abortError();
    }

    const executable = await this.findExecutable(path);
    const imagePaths = options.imagePaths ?? options.images ?? [];
    const args = CodexCliService.buildArgs(
      options.model ?? "gpt-5.6-sol",
      imagePaths,
      options.sandboxMode ?? DEFAULT_SANDBOX_MODE,
      options.reasoningEffort,
    );

    let child: SpawnedProcess;
    try {
      child = this.spawn(executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      }) as unknown as SpawnedProcess;
    } catch (error) {
      throw errorAsException(createError(
        "NOT_FOUND",
        `Codex executable could not be started: ${toError(error).message}`,
        "Install Codex CLI or choose its executable path in Fluely settings.",
      ));
    }

    const timeoutMs = typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.round(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const pending: string[] = [];
    const waiters: Array<(value: IteratorResult<string>) => void> = [];
    let stderr = "";
    let rawOutput = "";
    let processError: Error | null = null;
    let closeCode: number | null = null;
    let closed = false;
    let termination: "abort" | "timeout" | null = null;
    let providerError: string | undefined;
    let sawAgentDelta = false;
    const completedMessages: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stdoutBuffer = "";

    const finishWaiter = (value: IteratorResult<string>): void => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
      }
    };

    const enqueue = (value: string): void => {
      if (!value) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        pending.push(value);
      }
    };

    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      while (waiters.length > 0) {
        finishWaiter({ value: undefined, done: true });
      }
    };

    const terminate = (reason: "abort" | "timeout"): void => {
      if (termination || closed) {
        return;
      }
      termination = reason;
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 250);
    };

    const onAbort = (): void => terminate("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => terminate("timeout"), timeoutMs);

    const onStdinError = (error: Error): void => {
      processError = toError(error);
      if (closed) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already be exiting after closing its stdin pipe.
      }
      close();
    };

    const handleOutputLine = (line: string): void => {
      if (!line.trim()) {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        providerError ??= getErrorMessage(parsed) ?? undefined;
        const completedMessage = getCompletedAgentText(parsed);
        if (completedMessage !== null) {
          completedMessages.push(completedMessage);
          return;
        }
        const delta = getAgentDelta(parsed);
        if (delta !== null) {
          sawAgentDelta = true;
          enqueue(delta);
        }
      } catch {
        // A plain-text provider is supported. A malformed JSON-looking
        // line is held as an error detail rather than shown as an answer.
        if (!line.trim().startsWith("{")) {
          enqueue(line);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      rawOutput += text;
      // Buffering is intentionally line-based so a split JSON object cannot
      // be emitted as a partial answer.
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleOutputLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.stdin.once("error", onStdinError);
    child.once("error", (error) => {
      processError = toError(error);
      close();
    });
    child.once("close", (code) => {
      if (stdoutBuffer.trim()) {
        handleOutputLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      if (!sawAgentDelta) {
        for (const completedMessage of completedMessages) {
          enqueue(completedMessage);
        }
      }
      closeCode = code;
      close();
    });

    try {
      child.stdin.end(typeof options.prompt === "string" ? options.prompt : "");
      while (true) {
        if (pending.length > 0) {
          yield pending.shift() as string;
          continue;
        }
        if (closed) {
          break;
        }
        const next = await new Promise<IteratorResult<string>>((resolve) => {
          waiters.push(resolve);
        });
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      child.stdin.removeListener("error", onStdinError);
      if (timer) {
        clearTimeout(timer);
      }
      if (!closed) {
        terminate("abort");
      }
    }

    if (termination === "abort") {
      throw abortError();
    }
    if (termination === "timeout") {
      throw timeoutError(timeoutMs);
    }
    const startupError = processError as Error | null;
    if (startupError) {
      const errno = startupError as NodeJS.ErrnoException;
      const errorCode: CodexCliErrorCode = errno.code === "ENOENT" ? "NOT_FOUND" : "PROCESS_FAILED";
      throw errorAsException(createError(
        errorCode,
        errno.code === "ENOENT"
          ? `Codex executable was not found at ${executable}.`
          : `Codex CLI failed to start: ${startupError.message}`,
        "Install Codex CLI or choose the correct executable path in Fluely settings.",
      ));
    }
    if (closeCode !== 0) {
      const detail = CodexCliService.extractError(rawOutput, stderr);
      throw errorAsException(createError(
        "PROCESS_FAILED",
        `Codex CLI exited with code ${closeCode ?? "unknown"}${detail ? `: ${detail}` : "."}`,
        detail?.toLowerCase().includes("login")
          ? "Run codex login in Terminal, then retry the request."
          : "Check the Codex CLI output and retry the request.",
      ));
    }
    const extractedText = CodexCliService.extractText(rawOutput).trim();
    if (!extractedText && (stderr.trim() || providerError)) {
      throw errorAsException(createError(
        "INVALID_OUTPUT",
        `Codex CLI returned no answer: ${formatOutput(providerError ?? stderr)}.`,
        "Check the Codex CLI account and retry the request.",
      ));
    }

    if (!extractedText) {
      throw errorAsException(createError(
        "INVALID_OUTPUT",
        "Codex CLI returned an empty answer.",
        "Check the Codex CLI account and retry the request.",
      ));
    }

    while (pending.length > 0) {
      yield pending.shift() as string;
    }
  }

  public static stream(path: string, options: CodexCliStreamOptions): AsyncGenerator<string> {
    return new CodexCliService().streamInternal(path, options);
  }

  public stream(path: string, options: CodexCliStreamOptions): AsyncGenerator<string> {
    return this.streamInternal(path, options);
  }
}

export const buildCodexArgs = CodexCliService.buildArgs;
export const extractCodexText = CodexCliService.extractText;
