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
}

export type AnalysisServiceErrorCode = "ANALYSIS_IN_PROGRESS" | "ANALYSIS_FAILED";

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
  if (value instanceof Error && value.message.trim()) {
    return value.message.trim();
  }
  if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }
  return String(value || "Codex CLI analysis failed.");
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

/**
 * Builds a bounded prompt while keeping queue IDs separate from filesystem
 * paths. The paths are passed to the provider's image arguments only.
 */
export function buildAnalysisPrompt(
  request: Pick<AnalysisRequest, "prompt" | "intent"> | { prompt?: unknown; intent?: unknown },
  screenshotIds: readonly string[],
): string {
  const intent = normalizeIntent(request.intent);
  const question = normalizeQuestion(request.prompt);
  const ids = screenshotIds.filter((id) => SCREENSHOT_ID_PATTERN.test(id));
  const screenshotLine = ids.length > 0 ? ids.join(", ") : "none";
  const prompt = [
    `Intent: ${intent}`,
    `Screenshots: ${screenshotLine}`,
    `Question: ${question || "Please analyze the selected screenshots."}`,
  ].join("\n");
  return prompt.slice(0, MAX_PROMPT_LENGTH);
}

export class AnalysisService {
  private readonly provider: AnalysisProvider;
  private readonly pathSource?: AnalysisPathSource;
  private readonly getManagedPathsAccessor?: (ids?: readonly string[]) => string[];
  private readonly codex: CodexCliSettings;
  private readonly now: () => Date;
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
    this.codex = {
      ...DEFAULT_CODEX_SETTINGS,
      ...providedCodex,
      path: typeof providedCodex.path === "string" && providedCodex.path.trim()
        ? providedCodex.path.trim()
        : DEFAULT_CODEX_SETTINGS.path,
      model: typeof providedCodex.model === "string" && providedCodex.model.trim()
        ? providedCodex.model.trim()
        : DEFAULT_CODEX_SETTINGS.model,
      fastModel: typeof providedCodex.fastModel === "string" && providedCodex.fastModel.trim()
        ? providedCodex.fastModel.trim()
        : DEFAULT_CODEX_SETTINGS.fastModel,
    };
    this.now = options.now ?? options.clock ?? (() => new Date());
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

  public start(request: AnalysisRequest): AnalysisState {
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
    const model = safeRequest.fast === true ? this.codex.fastModel : this.codex.model;
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
    this.runPromise = Promise.resolve().then(() => this.consume(token, controller, safeRequest, selection));
    this.emit("started");
    return this.getState();
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
  ): Promise<void> {
    const options: CodexCliStreamOptions = {
      prompt: buildAnalysisPrompt(request, selection.ids),
      model: this.state.model,
      imagePaths: selection.paths,
      sandboxMode: this.codex.sandboxMode,
      reasoningEffort: this.codex.modelReasoningEffort,
      timeoutMs: this.codex.timeoutMs,
      signal: controller.signal,
    };

    try {
      for await (const delta of this.provider.stream(this.codex.path, options)) {
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
        this.finish(token, "completed");
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
    this.active = null;
    this.emit(status === "completed" ? "completed" : "cancelled");
  }

  private fail(token: symbol, value: unknown): void {
    if (!this.isActive(token)) {
      return;
    }
    const timestamp = this.timestamp();
    const error: IpcError = {
      code: "ANALYSIS_FAILED",
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
    this.emit("error");
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
