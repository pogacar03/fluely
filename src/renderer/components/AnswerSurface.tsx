import type { AnalysisState, CodexStatus } from "../../shared/ipc";

export interface AnswerSurfaceProps {
  analysis: AnalysisState | null;
  codexStatus?: CodexStatus | null;
}

function statusLabel(analysis: AnalysisState | null): string {
  switch (analysis?.status) {
    case "running":
      return "Thinking with your selected context";
    case "completed":
      return "Answer ready";
    case "cancelled":
      return "Request cancelled";
    case "error":
      return "Could not finish that request";
    default:
      return "Ready when you are";
  }
}

function emptyMessage(analysis: AnalysisState | null, codexStatus?: CodexStatus | null): string {
  if (codexStatus && !codexStatus.available) {
    return "Connect a working Codex CLI in settings to start asking questions.";
  }
  if (analysis?.status === "cancelled") {
    return "The request was cancelled. Your screenshot queue is still available for another ask.";
  }
  if (analysis?.status === "error") {
    return "Try again, or open settings to check the Codex CLI connection.";
  }
  return "Capture a screen or choose a queued screenshot, then ask Fluely anything about it.";
}

export function AnswerSurface({ analysis, codexStatus }: AnswerSurfaceProps) {
  const text = analysis?.text ?? "";
  const hasText = text.trim().length > 0;
  const error = analysis?.error;
  return (
    <section className={`answer-surface answer-${analysis?.status ?? "idle"}`} aria-labelledby="answer-title">
      <div className="answer-surface-topline">
        <div className="answer-label-wrap">
          <span className={`answer-state-dot ${analysis?.status ?? "idle"}`} aria-hidden="true" />
          <span id="answer-title">{statusLabel(analysis)}</span>
        </div>
        {analysis?.model && <span className="answer-model">{analysis.model}</span>}
      </div>

      {hasText ? (
        <div className="answer-copy" aria-live={analysis?.status === "running" ? "polite" : undefined}>
          {text}
        </div>
      ) : (
        <div className="answer-empty">
          {analysis?.status === "running" && <span className="thinking-bars" aria-hidden="true"><i /><i /><i /></span>}
          <p>{emptyMessage(analysis, codexStatus)}</p>
        </div>
      )}

      {error && (
        <div className="answer-error" role="alert">
          <strong>{error.message}</strong>
          <span>{error.action}</span>
        </div>
      )}

      {analysis?.status === "cancelled" && hasText && (
        <p className="answer-footnote">Partial response · cancelled before completion</p>
      )}
    </section>
  );
}
