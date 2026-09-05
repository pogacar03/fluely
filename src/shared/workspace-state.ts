import type {
  AnalysisIntent,
  AnalysisStatus,
  ScreenshotItem,
  ScreenshotState,
} from "./ipc";
import type { ConversationSnapshot } from "./conversation";

const MIN_OPACITY = 0.35;
const MAX_OPACITY = 1;

const intentInstructions: Record<AnalysisIntent, string> = {
  answer: "Answer the question using the selected screenshots.",
  explain: "Explain the selected screenshots clearly.",
  "follow-up": "Follow up on the previous answer using the selected screenshots.",
  recap: "Recap the selected screenshots briefly.",
};

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

/** Returns the opaque IDs represented by a queue snapshot in display order. */
export function getQueueIds(
  value: Pick<ScreenshotState, "items"> | readonly ScreenshotItem[] | null | undefined,
): string[] {
  const items = value && "items" in value ? value.items : value;
  return items?.map((item) => item.id) ?? [];
}

/** Builds a deduplicated analysis selection from the refreshed queue and capture result. */
export function getAnalysisScreenshotIds(
  value: Pick<ScreenshotState, "items"> | readonly ScreenshotItem[] | null | undefined,
  capturedId: string | null | undefined,
): string[] {
  return [...new Set([...getQueueIds(value), ...(capturedId ? [capturedId] : [])])];
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
    queueLabel: "Send images",
    cancelLabel: "Cancel",
  };
}

export interface WorkspaceActionState {
  isRunning: boolean;
  isBusy: boolean;
  canCapture: boolean;
  canSendImages: boolean;
  canCaptureAndSend: boolean;
  canCancel: boolean;
  captureLabel: string;
  sendImagesLabel: string;
  captureAndSendLabel: string;
  cancelLabel: string;
}

export interface CanonicalWorkspaceBusyInput {
  capturing?: boolean;
  conversation?: ConversationSnapshot | null;
  localPending?: boolean;
}

export interface CanonicalWorkspaceBusyState {
  isCapturing: boolean;
  isRunning: boolean;
  isBusy: boolean;
}

/** Derives canonical capture/analysis activity identically for every UI projection. */
export function getCanonicalWorkspaceBusyState({
  capturing = false,
  conversation,
  localPending = false,
}: CanonicalWorkspaceBusyInput): CanonicalWorkspaceBusyState {
  const activeMessage = conversation?.activeMessageId
    ? conversation.messages.find((message) => message.id === conversation.activeMessageId)
    : undefined;
  const isRunning = activeMessage?.status === "pending" ||
    activeMessage?.status === "streaming";
  const isCapturing = capturing === true;
  return {
    isCapturing,
    isRunning,
    isBusy: isCapturing || isRunning || localPending,
  };
}

/** Derives explicit screenshot action availability from canonical queue/analysis state. */
export function getWorkspaceActionState(
  status: AnalysisStatus | null | undefined,
  queueCount: number,
  commandBusy = false,
  capturing = false,
  conversation?: ConversationSnapshot | null,
): WorkspaceActionState {
  const isRunning = status === "running";
  const canonical = getCanonicalWorkspaceBusyState({
    capturing,
    conversation,
    localPending: isRunning || commandBusy,
  });
  const canCancel = (isRunning || canonical.isRunning) && !commandBusy;
  return {
    isRunning: isRunning || canonical.isRunning,
    isBusy: canonical.isBusy,
    canCapture: !canonical.isBusy,
    canSendImages: !canonical.isBusy && queueCount > 0,
    canCaptureAndSend: !canonical.isBusy,
    canCancel,
    captureLabel: "Capture",
    sendImagesLabel: "Send images",
    captureAndSendLabel: "Capture & ask",
    cancelLabel: "Cancel",
  };
}
