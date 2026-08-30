import type {
  AnalysisIntent,
  AnalysisStatus,
  FluelySettings,
  ScreenshotItem,
  ScreenshotState,
  WindowMode,
} from "./ipc";

const MIN_OPACITY = 0.35;
const MAX_OPACITY = 1;

const intentInstructions: Record<AnalysisIntent, string> = {
  answer: "Answer the question using the selected screenshots.",
  explain: "Explain the selected screenshots clearly.",
  "follow-up": "Follow up on the previous answer using the selected screenshots.",
  recap: "Recap the selected screenshots briefly.",
};

/** Selects the renderer surface from persisted first-run state. */
export function selectWorkspaceMode(
  settings: Pick<FluelySettings, "setupComplete"> | null | undefined,
): WindowMode {
  return settings?.setupComplete ? "work" : "setup";
}

/** Turns an intent chip and free-form question into a bounded prompt. */
export function buildIntentPrompt(intent: AnalysisIntent, question = ""): string {
  const instruction = intentInstructions[intent] ?? intentInstructions.answer;
  const trimmedQuestion = question.trim();
  return trimmedQuestion ? `${instruction}\n\nQuestion: ${trimmedQuestion}` : instruction;
}

/** Formats the work-window opacity control without exposing fractional values. */
export function formatOpacityLabel(opacity: number): string {
  const safeOpacity = Number.isFinite(opacity)
    ? Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, opacity))
    : MIN_OPACITY;
  return `${Math.round(safeOpacity * 100)}%`;
}

/** Counts queue metadata only; queue entries intentionally contain no paths. */
export function getQueueCount(
  value: Pick<ScreenshotState, "items"> | readonly ScreenshotItem[] | null | undefined,
): number {
  return value && "items" in value ? value.items.length : value?.length ?? 0;
}

export interface AnalysisActionState {
  isRunning: boolean;
  canCaptureAsk: boolean;
  canAskQueue: boolean;
  canCancel: boolean;
  captureLabel: string;
  queueLabel: string;
  cancelLabel: string;
}

/** Derives button labels/availability from one analysis state snapshot. */
export function getAnalysisActionState(
  status: AnalysisStatus | null | undefined,
  queueCount: number,
): AnalysisActionState {
  const isRunning = status === "running";
  return {
    isRunning,
    canCaptureAsk: !isRunning,
    canAskQueue: !isRunning && queueCount > 0,
    canCancel: isRunning,
    captureLabel: "Capture & ask",
    queueLabel: "Ask queue",
    cancelLabel: "Cancel",
  };
}
