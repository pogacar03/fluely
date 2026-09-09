import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  CodexModelReasoningEffort,
  CodexSandboxMode,
} from "../../src/shared/ipc";
import {
  CodexRunDiagnostics,
  createCodexRunDiagnosticsSink,
  type CodexRunDiagnosticsSnapshot,
  type CodexRunDiagnosticsWriter,
} from "./codex-run-diagnostics";

const DEFAULT_TIMEOUT_MS = 120000;
export const CODEX_STARTUP_TIMEOUT_MS = 120000;
export const CODEX_IDLE_TIMEOUT_MS = 120000;
export const CODEX_HARD_TIMEOUT_MS = 600000;
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
  | "CLI_START_TIMEOUT"
  | "CLI_IDLE_TIMEOUT"
  | "CLI_HARD_TIMEOUT"
  | "ABORTED"
  | "PROCESS_FAILED"
  | "INVALID_OUTPUT"
  | "USAGE_LIMIT"
  | "AUTHENTICATION_REQUIRED"
  | "MODEL_UNAVAILABLE";

export type CodexTimeoutStage = "startup_timeout" | "idle_timeout" | "hard_timeout";

export interface CodexDeadlinePolicy {
  startupMs: number;
  idleMs: number;
  hardMs: number;
}

const DEFAULT_DEADLINE_POLICY: CodexDeadlinePolicy = {
  startupMs: CODEX_STARTUP_TIMEOUT_MS,
  idleMs: CODEX_IDLE_TIMEOUT_MS,
  hardMs: CODEX_HARD_TIMEOUT_MS,
};

export interface CodexCliError {
  code: CodexCliErrorCode;
  message: string;
  action: string;
  diagnostics?: CodexRunDiagnosticsSnapshot;
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

export interface CodexCliDependencies {
  spawn?: typeof nodeSpawn;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onDiagnostics?: (snapshot: CodexRunDiagnosticsSnapshot) => void;
  deadlinePolicy?: Partial<CodexDeadlinePolicy>;
}

interface ParsedEvent {
  type?: unknown;
  code?: unknown;
  errorCode?: unknown;
  error_code?: unknown;
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

interface ProviderErrorDetails {
  code?: string;
  message?: string;
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

function normalizeDeadlinePolicy(policy: Partial<CodexDeadlinePolicy> | undefined): CodexDeadlinePolicy {
  const normalize = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.round(value)
      : fallback;
  return {
    startupMs: normalize(policy?.startupMs, DEFAULT_DEADLINE_POLICY.startupMs),
    idleMs: normalize(policy?.idleMs, DEFAULT_DEADLINE_POLICY.idleMs),
    hardMs: normalize(policy?.hardMs, DEFAULT_DEADLINE_POLICY.hardMs),
  };
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

function normalizeProviderErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    const record = asRecord(value);
    if (typeof record?.message === "string" && record.message.trim().length > 0) {
      return record.message.trim();
    }
  }
  return undefined;
}

const GENERIC_PROVIDER_ERROR_MESSAGE = "Codex CLI reported an error.";

function hasProviderErrorMetadata(record: ParsedEvent): boolean {
  return record.code !== undefined ||
    record.errorCode !== undefined ||
    record.error_code !== undefined ||
    typeof record.message === "string" ||
    typeof record.error === "string" ||
    asRecord(record.error) !== null;
}

function collectProviderErrorDetails(
  value: unknown,
  depth = 0,
  inheritedErrorContext = false,
): ProviderErrorDetails[] {
  if (depth > 5) {
    return [];
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const item = asRecord(record.item);
  const itemError = asRecord(item?.error);
  const error = asRecord(record.error);
  const isItemError = type === "item.completed" && item?.type === "error";
  const isErrorEvent = type === "error" || type.endsWith(".error") || type.endsWith("_error") || type === "stream_error";
  const inErrorContext = inheritedErrorContext || isItemError || isErrorEvent;
  const details: ProviderErrorDetails[] = [];
  if (isItemError || isErrorEvent || (inErrorContext && hasProviderErrorMetadata(record))) {
    const code = normalizeProviderErrorCode(
      record.code ?? record.errorCode ?? record.error_code ??
      error?.code ?? error?.errorCode ?? error?.error_code ??
      item?.code ?? item?.errorCode ?? item?.error_code ??
      itemError?.code ?? itemError?.errorCode ?? itemError?.error_code,
    );
    const message = firstText(
      record.message,
      typeof record.error === "string" ? record.error : undefined,
      error?.message,
      item?.message,
      typeof item?.error === "string" ? item.error : undefined,
      itemError?.message,
    );
    details.push({
      ...(code ? { code } : {}),
      message: message ?? GENERIC_PROVIDER_ERROR_MESSAGE,
    });
  }

  for (const nested of [record.payload, record.event, record.data, record.error]) {
    details.push(...collectProviderErrorDetails(nested, depth + 1, inErrorContext));
  }

  return details;
}

function getProviderErrorDetails(value: unknown, depth = 0): ProviderErrorDetails | null {
  const details = collectProviderErrorDetails(value, depth);
  for (let index = details.length - 1; index >= 0; index -= 1) {
    if (classifyProviderCode(details[index].code)) {
      return details[index];
    }
  }
  for (let index = details.length - 1; index >= 0; index -= 1) {
    if (details[index].message !== GENERIC_PROVIDER_ERROR_MESSAGE) {
      return details[index];
    }
  }
  return details.at(-1) ?? null;
}

function getErrorMessage(value: unknown, depth = 0): string | null {
  return getProviderErrorDetails(value, depth)?.message ?? null;
}

const CODEX_LIVENESS_EVENT_TYPES = new Set([
  "thread_started",
  "thread_completed",
  "turn_started",
  "turn_progress",
  "turn_completed",
  "item_started",
  "item_progress",
  "item_updated",
  "item_delta",
  "item_completed",
  "message_delta",
  "output_text_delta",
  "agent_message_delta",
  "agent_message_content_delta",
  "response_created",
  "response_in_progress",
  "response_output_item_added",
  "response_content_part_added",
  "response_output_text_delta",
  "response_output_item_done",
  "response_content_part_done",
  "response_completed",
]);

function isLivenessProtocolEvent(value: unknown, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }

  const record = asRecord(value);
  if (!record || typeof record.type !== "string") {
    return false;
  }

  const type = record.type.toLowerCase().replace(/[.:]/g, "_");
  if (type === "event_msg") {
    return isLivenessProtocolEvent(record.payload, depth + 1);
  }

  if (type === "item_completed" && asRecord(record.item)?.type === "error") {
    return false;
  }

  return CODEX_LIVENESS_EVENT_TYPES.has(type);
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

function abortError(): Error & { code: "ABORTED" } {
  const error = new Error("Codex CLI request was aborted.") as Error & { code: "ABORTED" };
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

function timeoutError(stage: CodexTimeoutStage, diagnostics: CodexRunDiagnosticsSnapshot): Error & {
  code: Exclude<CodexCliErrorCode, "NOT_FOUND" | "VERSION_FAILED" | "TIMEOUT" | "ABORTED" | "PROCESS_FAILED" | "INVALID_OUTPUT">;
  action: string;
  diagnostics: CodexRunDiagnosticsSnapshot;
} {
  const details: Record<CodexTimeoutStage, {
    code: "CLI_START_TIMEOUT" | "CLI_IDLE_TIMEOUT" | "CLI_HARD_TIMEOUT";
    message: string;
    action: string;
  }> = {
    startup_timeout: {
      code: "CLI_START_TIMEOUT",
      message: "Codex CLI startup timed out before producing a protocol event.",
      action: "Check the Codex CLI configuration, then retry the request.",
    },
    idle_timeout: {
      code: "CLI_IDLE_TIMEOUT",
      message: "Codex CLI became idle before completing the request.",
      action: "Retry the request or check the Codex CLI connection.",
    },
    hard_timeout: {
      code: "CLI_HARD_TIMEOUT",
      message: "Codex CLI reached its maximum run time.",
      action: "Retry with a smaller request or check the Codex CLI configuration.",
    },
  };
  const detail = details[stage];
  const error = new Error(detail.message) as Error & {
    code: "CLI_START_TIMEOUT" | "CLI_IDLE_TIMEOUT" | "CLI_HARD_TIMEOUT";
    action: string;
    diagnostics: CodexRunDiagnosticsSnapshot;
  };
  error.name = "TimeoutError";
  error.code = detail.code;
  error.action = detail.action;
  Object.defineProperty(error, "diagnostics", {
    configurable: true,
    enumerable: false,
    value: diagnostics,
    writable: false,
  });
  return error;
}

function errorAsException(
  error: CodexCliError,
  diagnostics?: CodexRunDiagnosticsSnapshot,
): Error & { code: CodexCliErrorCode; action: string; diagnostics?: CodexRunDiagnosticsSnapshot } {
  const exception = new Error(error.message) as Error & {
    code: CodexCliErrorCode;
    action: string;
    diagnostics?: CodexRunDiagnosticsSnapshot;
  };
  exception.name = "CodexCliError";
  exception.code = error.code;
  exception.action = error.action;
  if (diagnostics) {
    Object.defineProperty(exception, "diagnostics", {
      configurable: true,
      enumerable: false,
      value: diagnostics,
      writable: false,
    });
  }
  return exception;
}

function classifyProviderCode(value: unknown): CodexCliErrorCode | undefined {
  switch (normalizeProviderErrorCode(value)) {
    case "rate_limit_exceeded":
    case "rate_limited":
    case "quota_exhausted":
    case "quota_exceeded":
    case "usage_limit":
    case "usage_limit_reached":
    case "too_many_requests":
      return "USAGE_LIMIT";
    case "authentication_required":
    case "authentication_failed":
    case "not_authenticated":
    case "login_required":
    case "unauthorized":
    case "invalid_api_key":
      return "AUTHENTICATION_REQUIRED";
    case "model_not_found":
    case "model_unavailable":
    case "model_not_available":
    case "invalid_model":
    case "unsupported_model":
      return "MODEL_UNAVAILABLE";
    default:
      return undefined;
  }
}

function classifyFailureText(value: unknown): CodexCliErrorCode | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const text = value.toLowerCase();
  if (/\b(?:rate[\s_-]*limit|quota[\s_-]*(?:exhausted|exceeded)|usage[\s_-]*limit(?:[\s_-]*reached)?)\b|\b429\b|too many requests/.test(text)) {
    return "USAGE_LIMIT";
  }
  if (/\b(?:not logged in|authentication required|authentication failed|not authenticated|login required|unauthori[sz]ed|invalid api key|credentials? required)\b|\bcodex login\b/.test(text)) {
    return "AUTHENTICATION_REQUIRED";
  }
  if (/\bmodel\b.{0,80}\b(?:unavailable|invalid|not found|does not exist|unsupported)\b|\b(?:unavailable|invalid|not found|does not exist|unsupported)\b.{0,80}\bmodel\b/.test(text)) {
    return "MODEL_UNAVAILABLE";
  }
  return undefined;
}

function classifyProviderFailure(
  stderr: string,
  providerError?: ProviderErrorDetails | readonly ProviderErrorDetails[],
): CodexCliError {
  const details = providerError === undefined
    ? []
    : Array.isArray(providerError) ? providerError : [providerError];
  let code: CodexCliErrorCode | undefined;
  for (let index = details.length - 1; index >= 0 && !code; index -= 1) {
    code = classifyProviderCode(details[index].code);
  }
  for (let index = details.length - 1; index >= 0 && !code; index -= 1) {
    code = classifyFailureText(details[index].message);
  }
  code ??= classifyFailureText(stderr);

  if (code === "USAGE_LIMIT") {
    return createError(
      "USAGE_LIMIT",
      "Codex usage limit reached. Restore your usage or switch to an available model, then retry.",
      "Restore your Codex usage or switch to an available model, then retry.",
    );
  }

  if (code === "AUTHENTICATION_REQUIRED") {
    return createError(
      "AUTHENTICATION_REQUIRED",
      "Check your Codex login, then retry the request.",
      "Check your Codex login, then retry the request.",
    );
  }

  if (code === "MODEL_UNAVAILABLE") {
    return createError(
      "MODEL_UNAVAILABLE",
      "The selected Codex model is unavailable. Choose an available model, then retry.",
      "Choose an available model, then retry the request.",
    );
  }

  return createError(
    "PROCESS_FAILED",
    "Codex CLI exited before producing a complete answer.",
    "Retry the request.",
  );
}

/**
 * Main-process-only transport for the local Codex executable. It deliberately
 * accepts a narrow options object and always constructs its own argv array;
 * renderer input can never become an arbitrary child-process argument.
 */
export class CodexCliService {
  private readonly spawn: typeof nodeSpawn;
  private readonly now: () => number;
  private readonly setTimeout: typeof setTimeout;
  private readonly clearTimeout: typeof clearTimeout;
  private readonly onDiagnostics?: (snapshot: CodexRunDiagnosticsSnapshot) => void;
  private readonly deadlinePolicy: CodexDeadlinePolicy;

  public constructor(dependencies: CodexCliDependencies = {}) {
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.now = dependencies.now ?? Date.now;
    this.setTimeout = dependencies.setTimeout ?? setTimeout;
    this.clearTimeout = dependencies.clearTimeout ?? clearTimeout;
    this.onDiagnostics = dependencies.onDiagnostics;
    this.deadlinePolicy = normalizeDeadlinePolicy(dependencies.deadlinePolicy);
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
        if (delta !== null && delta.length > 0) {
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
    if (options.signal?.aborted) {
      throw abortError();
    }
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
        "Codex executable could not be started.",
        "Install Codex CLI or choose its executable path in Fluely settings.",
      ));
    }

    const startedAtMs = this.now();
    const diagnostics = new CodexRunDiagnostics(startedAtMs);
    diagnostics.mark("spawn", startedAtMs);
    let diagnosticsPublished = false;
    const publishDiagnostics = (): void => {
      if (diagnosticsPublished) {
        return;
      }
      diagnosticsPublished = true;
      try {
        this.onDiagnostics?.(diagnostics.snapshot(this.now()));
      } catch {
        // Diagnostics observers must not change provider result handling.
      }
    };

    const pending: string[] = [];
    const waiters: Array<(value: IteratorResult<string>) => void> = [];
    let stderr = "";
    let rawOutput = "";
    let processError: Error | null = null;
    let closeCode: number | null = null;
    let closed = false;
    let termination: "abort" | CodexTimeoutStage | null = null;
    const providerErrors: ProviderErrorDetails[] = [];
    let sawAgentDelta = false;
    let sawValidProtocolEvent = false;
    const completedMessages: string[] = [];
    let startupTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
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

    const clearDeadlineTimers = (): void => {
      if (startupTimer) {
        this.clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      if (idleTimer) {
        this.clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (hardTimer) {
        this.clearTimeout(hardTimer);
        hardTimer = undefined;
      }
    };

    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearDeadlineTimers();
      if (forceKillTimer) {
        this.clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      while (waiters.length > 0) {
        finishWaiter({ value: undefined, done: true });
      }
    };

    const terminate = (reason: "abort" | CodexTimeoutStage): void => {
      if (termination || closed) {
        return;
      }
      termination = reason;
      clearDeadlineTimers();
      forceKillTimer = this.setTimeout(() => {
        forceKillTimer = undefined;
        if (closed) {
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // A failed signal must not leave the stream waiter pending.
        } finally {
          close();
        }
      }, 250);
      try {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      } catch {
        // The force-kill deadline still guarantees local settlement.
      }
    };

    const recordProtocolEvent = (atMs: number): void => {
      diagnostics.mark("first-jsonl", atMs);
      diagnostics.mark("last-event", atMs);
      if (!sawValidProtocolEvent) {
        sawValidProtocolEvent = true;
        if (startupTimer) {
          this.clearTimeout(startupTimer);
          startupTimer = undefined;
        }
      }
      if (idleTimer) {
        this.clearTimeout(idleTimer);
      }
      idleTimer = this.setTimeout(() => terminate("idle_timeout"), this.deadlinePolicy.idleMs);
    };

    const onAbort = (): void => terminate("abort");

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
        const details = getProviderErrorDetails(parsed);
        if (details) {
          providerErrors.push(details);
        }
        if (isLivenessProtocolEvent(parsed)) {
          recordProtocolEvent(this.now());
        }
        const completedMessage = getCompletedAgentText(parsed);
        if (completedMessage !== null) {
          completedMessages.push(completedMessage);
          return;
        }
        const delta = getAgentDelta(parsed);
        if (delta !== null && delta.length > 0) {
          diagnostics.mark("first-delta", this.now());
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
      diagnostics.mark("first-byte", this.now());
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
      const text = chunk.toString();
      stderr += text;
      diagnostics.appendStderr(text);
    });
    child.stdin.once("error", onStdinError);
    child.once("error", (error) => {
      processError = toError(error);
      close();
    });
    child.once("close", (code, signal) => {
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
      diagnostics.mark("exit", this.now());
      diagnostics.setExit(code, signal ?? null);
      publishDiagnostics();
      close();
    });

    startupTimer = this.setTimeout(() => terminate("startup_timeout"), this.deadlinePolicy.startupMs);
    hardTimer = this.setTimeout(() => terminate("hard_timeout"), this.deadlinePolicy.hardMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    try {
      if (!closed) {
        child.stdin.end(typeof options.prompt === "string" ? options.prompt : "");
      }
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
      clearDeadlineTimers();
      if (!closed) {
        terminate("abort");
      }
      if (closed) {
        publishDiagnostics();
      }
    }

    if (termination === "abort") {
      throw abortError();
    }
    if (termination === "startup_timeout" || termination === "idle_timeout" || termination === "hard_timeout") {
      throw timeoutError(termination, diagnostics.snapshot(this.now()));
    }
    const startupError = processError as Error | null;
    if (startupError) {
      const errno = startupError as NodeJS.ErrnoException;
      const errorCode: CodexCliErrorCode = errno.code === "ENOENT" ? "NOT_FOUND" : "PROCESS_FAILED";
      throw errorAsException(createError(
        errorCode,
        errno.code === "ENOENT"
          ? "Codex executable was not found."
          : "Codex CLI failed to start.",
        "Install Codex CLI or choose the correct executable path in Fluely settings.",
      ), diagnostics.snapshot(this.now()));
    }
    if (closeCode !== 0) {
      throw errorAsException(
        classifyProviderFailure(stderr, providerErrors),
        diagnostics.snapshot(this.now()),
      );
    }
    if (providerErrors.length > 0) {
      throw errorAsException(
        classifyProviderFailure(stderr, providerErrors),
        diagnostics.snapshot(this.now()),
      );
    }
    const extractedText = CodexCliService.extractText(rawOutput).trim();
    if (!extractedText && stderr.trim()) {
      const classified = classifyProviderFailure(stderr);
      if (classified.code !== "PROCESS_FAILED") {
        throw errorAsException(classified, diagnostics.snapshot(this.now()));
      }
      throw errorAsException(createError(
        "INVALID_OUTPUT",
        "Codex CLI returned no answer.",
        "Check the Codex CLI account and retry the request.",
      ), diagnostics.snapshot(this.now()));
    }

    if (!extractedText) {
      throw errorAsException(createError(
        "INVALID_OUTPUT",
        "Codex CLI returned an empty answer.",
        "Check the Codex CLI account and retry the request.",
      ), diagnostics.snapshot(this.now()));
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

export function createMainProcessCodexCliService(
  dependencies: Omit<CodexCliDependencies, "onDiagnostics"> = {},
  writeDiagnostics?: CodexRunDiagnosticsWriter,
): CodexCliService {
  return new CodexCliService({
    ...dependencies,
    onDiagnostics: createCodexRunDiagnosticsSink(writeDiagnostics),
  });
}
