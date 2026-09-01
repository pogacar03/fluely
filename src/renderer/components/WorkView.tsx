import { useEffect, useState } from "react";
import type {
  AnalysisState,
  CodexStatus,
  FluelySettings,
  ScreenshotState,
} from "../../shared/ipc";
import type { ConversationSnapshot } from "../../shared/conversation";
import {
  formatOpacityLabel,
  getQueueCount,
  getWorkspaceActionState,
} from "../../shared/workspace-state";
import { Conversation } from "./Conversation";
import { ContextQueue } from "./ContextQueue";
import type { SetupNotice } from "./SetupView";

export interface WorkAnalysisRequest {
  prompt: string;
}

export interface WorkViewProps {
  settings: FluelySettings;
  screenshotState: ScreenshotState | null;
  analysisState: AnalysisState | null;
  conversation: ConversationSnapshot | null;
  codexStatus: CodexStatus | null;
  notice?: SetupNotice | null;
  busy?: boolean;
  onCapture: () => Promise<void> | void;
  onSendImages: (request: WorkAnalysisRequest) => Promise<void> | void;
  onCaptureAsk: (request: WorkAnalysisRequest) => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  onOpacityChange: (opacity: number) => Promise<void> | void;
  onOpenSettings: () => Promise<void> | void;
  onHide?: () => Promise<void> | void;
  onRemoveScreenshot: (id: string) => Promise<void> | void;
  onClearQueue: () => Promise<void> | void;
}

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
  conversation,
  codexStatus,
  notice,
  busy = false,
  onCapture,
  onSendImages,
  onCaptureAsk,
  onCancel,
  onOpacityChange,
  onOpenSettings,
  onHide,
  onRemoveScreenshot,
  onClearQueue,
}: WorkViewProps) {
  const [prompt, setPrompt] = useState("");
  const [opacity, setOpacity] = useState(settings.window.opacity);
  const queueCount = getQueueCount(screenshotState);
  const actionState = getWorkspaceActionState(
    analysisState?.status,
    queueCount,
    busy,
    screenshotState?.capturing ?? false,
  );
  const disabled = actionState.isBusy;
  const actionLabel = (label: string) => actionState.isBusy ? (
    <><span className="button-spinner" aria-hidden="true" />{label}…</>
  ) : label;

  useEffect(() => {
    setOpacity(settings.window.opacity);
  }, [settings.window.opacity]);

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
          <button type="button" className="secondary-button settings-button" onClick={() => void onOpenSettings()} aria-label="Open Fluely settings">⚙ Settings</button>
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
        <Conversation snapshot={conversation} />
        <ContextQueue
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

          <div className="composer-actions" aria-busy={actionState.isBusy}>
            <span className="composer-tip">Capture adds context only · Send images uses every queued screenshot</span>
            <div className="action-button-group">
              {actionState.canCancel && (
                <button type="button" className="secondary-button cancel-button" onClick={() => void onCancel()} disabled={busy} aria-label="Cancel analysis">
                  <span className="cancel-glyph" aria-hidden="true">■</span>
                  {actionState.cancelLabel}
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onSendImages({ prompt })}
                disabled={!actionState.canSendImages}
                aria-label="Send all queued screenshots"
              >
                {actionLabel(actionState.sendImagesLabel)}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onCapture()}
                disabled={!actionState.canCapture}
                aria-label="Capture screenshot without sending"
              >
                {actionLabel(actionState.captureLabel)}
              </button>
              <button
                type="button"
                className="primary-button capture-button"
                onClick={() => void onCaptureAsk({ prompt })}
                disabled={!actionState.canCaptureAndSend}
                aria-label="Capture screenshot and ask"
              >
                <span className="capture-glyph" aria-hidden="true">＋</span>
                {actionLabel(actionState.captureAndSendLabel)}
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
