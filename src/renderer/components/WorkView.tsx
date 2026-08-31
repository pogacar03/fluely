import { useEffect, useState } from "react";
import type {
  AnalysisIntent,
  AnalysisState,
  CodexStatus,
  FluelySettings,
  ScreenshotState,
} from "../../shared/ipc";
import {
  buildIntentPrompt,
  formatOpacityLabel,
  getAnalysisActionState,
  getQueueCount,
} from "../../shared/workspace-state";
import { AnswerSurface } from "./AnswerSurface";
import { QueueStrip } from "./QueueStrip";
import type { SetupNotice } from "./SetupView";

export interface WorkAnalysisRequest {
  prompt: string;
  intent: AnalysisIntent;
  fast: boolean;
}

export interface WorkViewProps {
  settings: FluelySettings;
  screenshotState: ScreenshotState | null;
  analysisState: AnalysisState | null;
  codexStatus: CodexStatus | null;
  notice?: SetupNotice | null;
  busy?: boolean;
  onCaptureAsk: (request: WorkAnalysisRequest) => Promise<void> | void;
  onAskQueue: (request: WorkAnalysisRequest) => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  onOpacityChange: (opacity: number) => Promise<void> | void;
  onOpenSettings: () => Promise<void> | void;
  onHide?: () => Promise<void> | void;
  onRemoveScreenshot: (id: string) => Promise<void> | void;
  onClearQueue: () => Promise<void> | void;
}

const intents: Array<{ value: AnalysisIntent; label: string; hint: string }> = [
  { value: "answer", label: "Answer", hint: "Get to the point" },
  { value: "explain", label: "Explain", hint: "Make it clear" },
  { value: "follow-up", label: "Follow-up", hint: "Continue the thread" },
  { value: "recap", label: "Recap", hint: "Summarize context" },
];

function connectionLabel(status: CodexStatus | null, analysis: AnalysisState | null): string {
  if (analysis?.status === "running") {
    return "Codex is thinking";
  }
  if (!status) {
    return "Checking Codex";
  }
  return status.available ? "Codex ready" : "Codex offline";
}

export function WorkView({
  settings,
  screenshotState,
  analysisState,
  codexStatus,
  notice,
  busy = false,
  onCaptureAsk,
  onAskQueue,
  onCancel,
  onOpacityChange,
  onOpenSettings,
  onHide,
  onRemoveScreenshot,
  onClearQueue,
}: WorkViewProps) {
  const [prompt, setPrompt] = useState("");
  const [intent, setIntent] = useState<AnalysisIntent>("answer");
  const [fast, setFast] = useState(false);
  const [opacity, setOpacity] = useState(settings.window.opacity);
  const queueCount = getQueueCount(screenshotState);
  const actionState = getAnalysisActionState(analysisState?.status, queueCount);
  const disabled = busy || actionState.isRunning;

  useEffect(() => {
    setOpacity(settings.window.opacity);
  }, [settings.window.opacity]);

  function buildRequest(): WorkAnalysisRequest {
    return {
      prompt: buildIntentPrompt(intent, prompt),
      intent,
      fast,
    };
  }

  function submit(kind: "capture" | "queue") {
    const request = buildRequest();
    if (kind === "capture") {
      void onCaptureAsk(request);
    } else {
      void onAskQueue(request);
    }
  }

  return (
    <main className="work-shell">
      <header className="work-header">
        <div className="drag-handle" aria-hidden="true" />
        <div className="work-brand">
          <div className="mini-brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <strong>Fluely</strong>
            <span>screen copilot</span>
          </div>
        </div>
        <div className="work-header-actions">
          <div className={`connection-pill ${codexStatus?.available === false ? "offline" : ""}`}>
            <span className="connection-dot" />
            {connectionLabel(codexStatus, analysisState)}
          </div>
          <label className="opacity-control" title="Window opacity">
            <span aria-hidden="true">◒</span>
            <input
              aria-label="Window opacity"
              type="range"
              min="0.35"
              max="1"
              step="0.01"
              value={opacity}
              onChange={(event) => {
                const next = Number(event.target.value);
                setOpacity(next);
                void onOpacityChange(next);
              }}
            />
            <output>{formatOpacityLabel(opacity)}</output>
          </label>
          <button type="button" className="icon-button" onClick={() => void onOpenSettings()} aria-label="Open Fluely settings" title="Settings">⚙</button>
          <button type="button" className="icon-button" onClick={() => void onHide?.()} disabled={!onHide} aria-label="Hide Fluely" title="Hide">—</button>
        </div>
      </header>

      {notice && (
        <div className={`notice work-notice ${notice.tone}`} role="status">
          <span>{notice.tone === "success" ? "✓" : "!"}</span>
          <span>{notice.text}</span>
        </div>
      )}

      <div className="work-content">
        <AnswerSurface analysis={analysisState} codexStatus={codexStatus} />
        <QueueStrip
          screenshotState={screenshotState}
          disabled={disabled}
          onRemove={onRemoveScreenshot}
          onClear={onClearQueue}
        />

        <section className="composer-card" aria-labelledby="composer-title">
          <div className="composer-heading">
            <div>
              <span className="eyebrow accent">ASK ABOUT YOUR SCREEN</span>
              <h2 id="composer-title">What do you want to know?</h2>
            </div>
            <label className="fast-toggle">
              <input
                type="checkbox"
                checked={fast}
                onChange={(event) => setFast(event.target.checked)}
                disabled={disabled}
              />
              <span className="fast-toggle-track"><span /></span>
              <span>Fast model</span>
            </label>
          </div>

          <div className="intent-row" aria-label="Question intent">
            {intents.map((item) => (
              <button
                type="button"
                key={item.value}
                className={`intent-chip ${intent === item.value ? "selected" : ""}`}
                onClick={() => setIntent(item.value)}
                disabled={disabled}
                title={item.hint}
              >
                <span className="intent-chip-dot" aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>

          <textarea
            className="composer-input"
            aria-label="Question for Fluely"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask anything about the context you captured…"
            rows={3}
            disabled={disabled}
            maxLength={3000}
          />

          <div className="composer-actions">
            <span className="composer-tip">⌘↵ asks the queue · ⇧⌘↵ captures first</span>
            <div className="action-button-group">
              {actionState.canCancel && (
                <button type="button" className="secondary-button cancel-button" onClick={() => void onCancel()} disabled={busy}>
                  <span className="cancel-glyph" aria-hidden="true">■</span>
                  {actionState.cancelLabel}
                </button>
              )}
              <button type="button" className="secondary-button" onClick={() => submit("queue")} disabled={disabled || !actionState.canAskQueue}>
                {actionState.queueLabel}
              </button>
              <button type="button" className="primary-button capture-button" onClick={() => submit("capture")} disabled={disabled || !actionState.canCaptureAsk}>
                <span className="capture-glyph" aria-hidden="true">＋</span>
                {actionState.captureLabel}
              </button>
            </div>
          </div>
        </section>
      </div>

      <footer className="work-footer">
        <span>{queueCount > 0 ? `${queueCount} context ${queueCount === 1 ? "item" : "items"} ready` : "No context queued yet"}</span>
        <span className="work-footer-right">LOCAL QUEUE · READ-ONLY</span>
      </footer>
    </main>
  );
}
