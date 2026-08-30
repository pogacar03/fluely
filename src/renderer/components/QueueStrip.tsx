import type { ScreenshotState } from "../../shared/ipc";
import { getQueueCount } from "../../shared/workspace-state";

export interface QueueStripProps {
  screenshotState: ScreenshotState | null;
  disabled?: boolean;
  onRemove: (id: string) => Promise<void> | void;
  onClear?: () => Promise<void> | void;
}

function permissionLabel(permission: ScreenshotState["permission"] | undefined): string {
  switch (permission) {
    case "granted":
      return "Screen access ready";
    case "denied":
      return "Screen access denied";
    case "restricted":
      return "Screen access restricted";
    case "not-determined":
      return "Screen access needs permission";
    default:
      return "Screen access unavailable";
  }
}

function timestampLabel(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "Queued";
  }
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function QueueStrip({ screenshotState, disabled = false, onRemove, onClear }: QueueStripProps) {
  const items = screenshotState?.items ?? [];
  const count = getQueueCount(screenshotState);
  return (
    <section className="queue-strip" aria-labelledby="queue-title">
      <div className="queue-heading">
        <div className="queue-title-wrap">
          <span className="queue-icon" aria-hidden="true">▦</span>
          <div>
            <div className="queue-title-line">
              <h3 id="queue-title">Context queue</h3>
              <span className="queue-count">{count}/5</span>
            </div>
            <p>{permissionLabel(screenshotState?.permission)}</p>
          </div>
        </div>
        {count > 0 && onClear && (
          <button type="button" className="text-button" onClick={() => void onClear()} disabled={disabled}>
            Clear all
          </button>
        )}
      </div>

      {items.length > 0 ? (
        <div className="queue-items" role="list">
          {items.map((item) => (
            <div className="queue-item" role="listitem" key={item.id}>
              <span className="queue-item-glyph" aria-hidden="true">✦</span>
              <span className="queue-item-copy">
                <strong>{item.width} × {item.height}</strong>
                <small>{timestampLabel(item.createdAt)}</small>
              </span>
              <button
                type="button"
                className="queue-remove"
                aria-label={`Remove screenshot ${item.width} by ${item.height}`}
                onClick={() => void onRemove(item.id)}
                disabled={disabled}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="queue-empty">
          <span aria-hidden="true">＋</span>
          <span>Your next capture will appear here.</span>
        </div>
      )}
    </section>
  );
}

