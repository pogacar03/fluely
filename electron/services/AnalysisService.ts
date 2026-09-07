import type {
  AnalysisIntent,
  AnalysisRequest,
  AnalysisState,
  AnalysisStateChangedEvent,
  AnalysisStateEventType,
  AnalysisStateListener,
  CodexCliSettings,
  IpcError,
  ScreenshotState,
} from "../../src/shared/ipc";
import type { CodexRunDiagnosticsSnapshot } from "./codex-run-diagnostics";
import { CodexCliService, type CodexCliStreamOptions } from "./CodexCliService";

const DEFAULT_CODEX_SETTINGS: CodexCliSettings = {
  enabled: true,
  path: "codex",
  model: "gpt-5.6-sol",
  fastModel: "gpt-5.6-luna",
  timeoutMs: 120000,
  sandboxMode: "read-only",
  modelReasoningEffort: "medium",
};

const CODEX_SANDBOX_MODES: readonly CodexCliSettings["sandboxMode"][] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

const CODEX_REASONING_EFFORTS: readonly NonNullable<CodexCliSettings["modelReasoningEffort"]>[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const SCREENSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPT_LENGTH = 4000;
const MAX_QUESTION_LENGTH = 3000;

export interface AnalysisProvider {
  stream(path: string, options: CodexCliStreamOptions): AsyncIterable<string>;
}

export interface AnalysisPathSource {
  getManagedPaths(ids?: readonly string[]): string[];
  getState?: () => ScreenshotState;
}

export interface AnalysisServiceOptions {
  /** Inject a fake in tests; production passes the main-process Codex service. */
  provider?: AnalysisProvider;
  screenshots?: AnalysisPathSource;
  /** Alias retained for callers that name the dependency after its class. */
  screenshotService?: AnalysisPathSource;
  /** A narrow accessor is useful for composition tests without a full queue. */
  getManagedPaths?: (ids?: readonly string[]) => string[];
  codex?: Partial<CodexCliSettings>;
  /** Alias accepted by callers that call the object a config. */
  config?: Partial<CodexCliSettings>;
  /** Alias for callers that pass the persisted settings object directly. */
  settings?: Partial<CodexCliSettings>;
  now?: () => Date;
  clock?: () => Date;
  onDiagnostics?: (snapshot: CodexRunDiagnosticsSnapshot) => void;
}

export type AnalysisServiceErrorCode =
  | "ANALYSIS_IN_PROGRESS"
  | "ANALYSIS_FAILED"
  | "CLI_START_TIMEOUT"
  | "CLI_IDLE_TIMEOUT"
  | "CLI_HARD_TIMEOUT";

export interface AnalysisServiceError extends Error {
  code: AnalysisServiceErrorCode;
  action: string;
}

interface ActiveRequest {
  token: symbol;
  controller: AbortController;
}

interface ResolvedSelection {
  ids: string[];
  paths: string[];
}

function isCodexSandboxMode(value: unknown): value is CodexCliSettings["sandboxMode"] {
  return typeof value === "string" && CODEX_SANDBOX_MODES.includes(value as CodexCliSettings["sandboxMode"]);
}

function isCodexReasoningEffort(
  value: unknown,
): value is NonNullable<CodexCliSettings["modelReasoningEffort"]> {
  return typeof value === "string" &&
    CODEX_REASONING_EFFORTS.includes(value as NonNullable<CodexCliSettings["modelReasoningEffort"]>);
}

function normalizeCodexSettings(settings: Partial<CodexCliSettings>): CodexCliSettings {
  const merged = { ...DEFAULT_CODEX_SETTINGS, ...settings };
  return {
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CODEX_SETTINGS.enabled,
    path: typeof merged.path === "string" && merged.path.trim()
      ? merged.path.trim()
      : DEFAULT_CODEX_SETTINGS.path,
    model: typeof merged.model === "string" && merged.model.trim()
      ? merged.model.trim()
      : DEFAULT_CODEX_SETTINGS.model,
    fastModel: typeof merged.fastModel === "string" && merged.fastModel.trim()
      ? merged.fastModel.trim()
      : DEFAULT_CODEX_SETTINGS.fastModel,
    timeoutMs: typeof merged.timeoutMs === "number" && Number.isFinite(merged.timeoutMs) && merged.timeoutMs > 0
      ? Math.max(1, Math.round(merged.timeoutMs))
      : DEFAULT_CODEX_SETTINGS.timeoutMs,
    sandboxMode: isCodexSandboxMode(merged.sandboxMode)
      ? merged.sandboxMode
      : DEFAULT_CODEX_SETTINGS.sandboxMode,
    modelReasoningEffort: isCodexReasoningEffort(merged.modelReasoningEffort)
      ? merged.modelReasoningEffort
      : DEFAULT_CODEX_SETTINGS.modelReasoningEffort,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createServiceError(
  code: AnalysisServiceErrorCode,
  message: string,
  action: string,
): AnalysisServiceError {
  const error = new Error(message) as AnalysisServiceError;
  error.name = "AnalysisServiceError";
  error.code = code;
  error.action = action;
  return error;
}

function normalizeIntent(value: unknown): AnalysisIntent {
  return value === "explain" || value === "follow-up" || value === "recap" || value === "answer"
    ? value
    : "answer";
}

function normalizeQuestion(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, MAX_QUESTION_LENGTH);
}

function normalizeScreenshotIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((id): id is string => typeof id === "string" && SCREENSHOT_ID_PATTERN.test(id));
}

function cloneError(error: IpcError | undefined): IpcError | undefined {
  return error ? { ...error } : undefined;
}

function cloneState(state: AnalysisState): AnalysisState {
  const copy: AnalysisState = {
    status: state.status,
    text: state.text,
    model: state.model,
    screenshotIds: [...state.screenshotIds],
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
  };
  const error = cloneError(state.error);
  if (error) {
    copy.error = error;
  }
  return copy;
}

function cloneEvent(state: AnalysisState, event: AnalysisStateEventType): AnalysisStateChangedEvent {
  return { ...cloneState(state), event };
}

function errorMessage(value: unknown): string {
  const code = errorCode(value);
  if (isCliTimeoutCode(code)) {
    return cliTimeoutMessage(code);
  }
  if (value instanceof Error && value.message.trim()) {
    return value.message.trim();
  }
  if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }
  return String(value || "Codex CLI analysis failed.");
}

function isCliTimeoutCode(value: unknown): value is "CLI_START_TIMEOUT" | "CLI_IDLE_TIMEOUT" | "CLI_HARD_TIMEOUT" {
  return value === "CLI_START_TIMEOUT" || value === "CLI_IDLE_TIMEOUT" || value === "CLI_HARD_TIMEOUT";
}

function errorCode(value: unknown): AnalysisServiceErrorCode {
  if (isRecord(value) && isCliTimeoutCode(value.code)) {
    return value.code;
  }
  return "ANALYSIS_FAILED";
}

function cliTimeoutMessage(code: "CLI_START_TIMEOUT" | "CLI_IDLE_TIMEOUT" | "CLI_HARD_TIMEOUT"): string {
  switch (code) {
    case "CLI_START_TIMEOUT":
      return "Codex CLI startup timed out before producing a protocol event.";
    case "CLI_IDLE_TIMEOUT":
      return "Codex CLI became idle before completing the request.";
    case "CLI_HARD_TIMEOUT":
      return "Codex CLI reached its maximum run time.";
  }
}

function errorAction(value: unknown): string {
  if (isRecord(value) && typeof value.action === "string" && value.action.trim()) {
    return value.action.trim();
  }
  return "Check the Codex CLI configuration and try the request again.";
}

function isAbortLike(value: unknown): boolean {
  if (value instanceof Error && value.name === "AbortError") {
    return true;
  }
  return isRecord(value) && (value.code === "ABORTED" || value.name === "AbortError");
}

function basenameWithoutPng(value: string): string | null {
  const basename = value.split(/[\\/]/).at(-1) ?? "";
  const id = basename.endsWith(".png") ? basename.slice(0, -4) : "";
  return SCREENSHOT_ID_PATTERN.test(id) ? id : null;
}

const MAX_CONVERSATION_CONTEXT_LENGTH = 3000;

function normalizeConversationContext(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_CONVERSATION_CONTEXT_LENGTH) : "";
}

/**
 * Builds a bounded prompt while keeping queue IDs separate from filesystem
 * paths. The paths are passed to the provider's image arguments only.
 */
export function buildAnalysisPrompt(
  request: Pick<AnalysisRequest, "prompt" | "intent" | "conversationContext"> | {
    prompt?: unknown;
    intent?: unknown;
    conversationContext?: unknown;
  },
  screenshotIds: readonly string[],
): string {
  const intent = normalizeIntent(request.intent);
  const question = normalizeQuestion(request.prompt);
  const ids = screenshotIds.filter((id) => SCREENSHOT_ID_PATTERN.test(id));
  const screenshotLine = ids.length > 0 ? ids.join(", ") : "none";
  const header = [
    `Intent: ${intent}`,
    `Screenshots: ${screenshotLine}`,
  ];
  const questionLine = `Question: ${question || "Please analyze the selected screenshots."}`;
  const context = normalizeConversationContext(request.conversationContext);
  if (!context) {
    return [...header, questionLine].join("\n").slice(0, MAX_PROMPT_LENGTH);
  }

  const contextLabel = "Conversation context:";
  const framingLength = [...header, contextLabel, questionLine].join("\n").length;
  const available = MAX_PROMPT_LENGTH - framingLength - 1;
  if (available <= 0) {
    return [...header, questionLine].join("\n").slice(0, MAX_PROMPT_LENGTH);
  }
  return [...header, contextLabel, context.slice(0, available), questionLine].join("\n");
}

export class AnalysisService {
  private readonly provider: AnalysisProvider;
  private readonly pathSource?: AnalysisPathSource;
  private readonly getManagedPathsAccessor?: (ids?: readonly string[]) => string[];
  private codex: CodexCliSettings;
  private pendingCodexSettings: CodexCliSettings | null = null;
  private readonly now: () => Date;
  private readonly onDiagnostics?: (snapshot: CodexRunDiagnosticsSnapshot) => void;
  private readonly listeners = new Set<AnalysisStateListener>();
  private state: AnalysisState;
  private active: ActiveRequest | null = null;
  private runPromise: Promise<void> | null = null;
  private runToken: symbol | null = null;

  public constructor(options: AnalysisServiceOptions) {
    this.provider = options.provider ?? new CodexCliService();
    this.pathSource = options.screenshots ?? options.screenshotService;
    this.getManagedPathsAccessor = options.getManagedPaths;
    if (!this.pathSource && !this.getManagedPathsAccessor) {
      throw new Error("AnalysisService requires a managed screenshot path source.");
    }
    const providedCodex = {
      ...(options.settings ?? {}),
      ...(options.config ?? {}),
      ...(options.codex ?? {}),
    };
    this.codex = normalizeCodexSettings(providedCodex);
    this.now = options.now ?? options.clock ?? (() => new Date());
    this.onDiagnostics = options.onDiagnostics;
    const timestamp = this.timestamp();
    this.state = {
      status: "idle",
      text: "",
      model: this.codex.model,
      screenshotIds: [],
      startedAt: null,
      updatedAt: timestamp,
      completedAt: null,
    };
  }

  public async start(request: AnalysisRequest): Promise<void> {
    if (this.active) {
      throw createServiceError(
        "ANALYSIS_IN_PROGRESS",
        "An analysis request is already running.",
        "Wait for the current answer to finish or cancel it before starting another request.",
      );
    }

    const safeRequest: Record<string, unknown> = isRecord(request) ? request : {};
    const requestedIds = normalizeScreenshotIds(safeRequest.screenshotIds);
    const selection = this.resolveSelection(requestedIds);
    const codex = this.codex;
    const model = safeRequest.fast === true ? codex.fastModel : codex.model;
    const timestamp = this.timestamp();
    const controller = new AbortController();
    const token = Symbol("analysis");
    this.active = { token, controller };
    this.state = {
      status: "running",
      text: "",
      model,
      screenshotIds: selection.ids,
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    // Defer provider startup until after the synchronous `started` snapshot.
    // This also makes a listener-triggered cancel safe: the consume loop sees
    // the cancelled token and never starts a child with an already-aborted
    // request.
    this.runToken = token;
    this.runPromise = Promise.resolve().then(() => this.consume(token, controller, safeRequest, selection, codex));
    this.emit("started");
  }

  public cancel(): AnalysisState {
    const active = this.active;
    if (!active || this.state.status !== "running") {
      return this.getState();
    }

    active.controller.abort();
    this.finish(active.token, "cancelled");
    return this.getState();
  }

  /**
   * Refreshes the Codex configuration used by future requests. If a stream is
   * active, the normalized settings are applied after it settles so the active
   * provider invocation keeps its original executable and options.
   */
  public updateCodexSettings(settings: Partial<CodexCliSettings>): void {
    const next = normalizeCodexSettings({ ...this.codex, ...settings });
    if (this.active) {
      this.pendingCodexSettings = next;
      return;
    }

    this.codex = next;
    this.pendingCodexSettings = null;
  }

  public getState(): AnalysisState {
    return cloneState(this.state);
  }

  public onStateChanged(listener: AnalysisStateListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  /** Resolves when the currently active provider stream has settled. */
  public async whenIdle(): Promise<void> {
    const run = this.runPromise;
    if (run) {
      await run;
    }
  }

  private resolveSelection(requestedIds: string[] | undefined): ResolvedSelection {
    const queuedIds = this.pathSource?.getState?.().items
      .map((item) => item.id)
      .filter((id) => SCREENSHOT_ID_PATTERN.test(id));
    const candidates = requestedIds === undefined ? queuedIds : requestedIds;
    const uniqueCandidates = candidates === undefined ? undefined : [...new Set(candidates)];
    const paths = this.pathSource
      ? this.pathSource.getManagedPaths(uniqueCandidates)
      : this.getManagedPathsAccessor?.(uniqueCandidates) ?? [];

    // A real ScreenshotService preserves order, but derive IDs from the
    // returned managed filenames as an extra guard for injected sources.
    const returnedIds = paths
      .map((path) => basenameWithoutPng(path))
      .filter((id): id is string => id !== null && (uniqueCandidates?.includes(id) ?? true));
    const ids = returnedIds.length === paths.length
      ? returnedIds
      : (uniqueCandidates ?? []).slice(0, paths.length);
    return { ids, paths: [...paths] };
  }

  private async consume(
    token: symbol,
    controller: AbortController,
    request: Record<string, unknown>,
    selection: ResolvedSelection,
    codex: CodexCliSettings,
  ): Promise<void> {
    try {
      if (!this.isActive(token)) {
        return;
      }

      const options: CodexCliStreamOptions = {
        prompt: buildAnalysisPrompt(request, selection.ids),
        model: this.state.model,
        imagePaths: selection.paths,
        sandboxMode: codex.sandboxMode,
        reasoningEffort: codex.modelReasoningEffort,
        timeoutMs: codex.timeoutMs,
        signal: controller.signal,
      };

      for await (const delta of this.provider.stream(codex.path, options)) {
        if (!this.isActive(token)) {
          return;
        }
        if (typeof delta !== "string" || delta.length === 0) {
          continue;
        }
        this.state = {
          ...this.state,
          text: `${this.state.text}${delta}`,
          updatedAt: this.timestamp(),
        };
        this.emit("delta");
      }

      if (this.isActive(token)) {
        if (this.state.text.trim().length === 0) {
          this.fail(
            token,
            createServiceError(
              "ANALYSIS_FAILED",
              "Codex CLI returned no visible answer.",
              "Retry the analysis request or check the Codex CLI connection.",
            ),
          );
        } else {
          this.finish(token, "completed");
        }
      }
    } catch (error) {
      if (!this.isActive(token)) {
        return;
      }
      if (controller.signal.aborted || isAbortLike(error)) {
        this.finish(token, "cancelled");
        return;
      }
      this.fail(token, error);
    } finally {
      if (this.active?.token === token) {
        this.active = null;
      }
      this.applyPendingCodexSettings();
      if (this.runToken === token) {
        this.runPromise = null;
        this.runToken = null;
      }
    }
  }

  private isActive(token: symbol): boolean {
    return this.active?.token === token && this.state.status === "running";
  }

  private finish(token: symbol, status: "completed" | "cancelled"): void {
    if (!this.isActive(token)) {
      return;
    }
    const timestamp = this.timestamp();
    this.state = {
      ...this.state,
      status,
      updatedAt: timestamp,
      completedAt: timestamp,
    };
    // Cancellation publishes the terminal state immediately, but keeps the
    // active lock until the provider iterator's finally block settles. This
    // prevents a new child from overlapping one still being terminated.
    if (status === "completed") {
      this.active = null;
      this.applyPendingCodexSettings();
    }
    this.emit(status === "completed" ? "completed" : "cancelled");
  }

  private fail(token: symbol, value: unknown): void {
    if (!this.isActive(token)) {
      return;
    }
    const timestamp = this.timestamp();
    const code = errorCode(value);
    const diagnostics = isRecord(value) && isRecord(value.diagnostics)
      ? value.diagnostics as CodexRunDiagnosticsSnapshot
      : undefined;
    if (diagnostics) {
      try {
        this.onDiagnostics?.(diagnostics);
      } catch {
        // Diagnostics observers must not change the public analysis state.
      }
    }
    const error: IpcError = {
      code,
      message: errorMessage(value),
      action: errorAction(value),
    };
    this.state = {
      ...this.state,
      status: "error",
      updatedAt: timestamp,
      completedAt: timestamp,
      error,
    };
    this.active = null;
    this.applyPendingCodexSettings();
    this.emit("error");
  }

  private applyPendingCodexSettings(): void {
    if (!this.active && this.pendingCodexSettings) {
      this.codex = this.pendingCodexSettings;
      this.pendingCodexSettings = null;
    }
  }

  private emit(event: AnalysisStateEventType): void {
    const snapshot = cloneEvent(this.state, event);
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Analysis subscribers are observers; one renderer error must not
        // break provider consumption or state cleanup.
      }
    }
  }

  private timestamp(): string {
    const value = this.now();
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString()
      : new Date().toISOString();
  }
}
