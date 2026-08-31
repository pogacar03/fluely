import type { ScreenshotState } from "../../shared/ipc";
import { MAX_CONTEXT_SCREENSHOTS } from "../../shared/context-queue";

export interface ContextQueueProps {
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

function timestampLabel(capturedAt: number): string {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) {
    return "Queued";
  }
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function ContextQueue({ screenshotState, disabled = false, onRemove, onClear }: ContextQueueProps) {
  const items = screenshotState?.items ?? [];
  const capturing = screenshotState?.capturing ?? false;
  const actionDisabled = disabled || capturing;

  return (
    <section className="queue-strip" aria-labelledby="queue-title" aria-busy={capturing || undefined}>
      <div className="queue-heading">
        <div className="queue-title-wrap">
          <span className="queue-icon" aria-hidden="true">▦</span>
          <div>
            <div className="queue-title-line">
              <h3 id="queue-title">Context to send</h3>
              <span className="queue-count" aria-label={`${items.length} of ${MAX_CONTEXT_SCREENSHOTS} screenshots queued`}>
                {items.length}/{MAX_CONTEXT_SCREENSHOTS}
              </span>
            </div>
            <p>{permissionLabel(screenshotState?.permission)}</p>
          </div>
        </div>
        {items.length > 0 && onClear && (
          <button
            type="button"
            className="text-button"
            onClick={() => void onClear()}
            disabled={actionDisabled}
            aria-label="Clear all queued screenshots"
          >
            Clear all
          </button>
        )}
      </div>

      {items.length > 0 ? (
        <div className="queue-items" role="list" aria-label="Queued screenshots">
          {items.map((item, index) => (
            <figure className="queue-item" role="listitem" key={item.id}>
              <img
                className="queue-thumbnail"
                src={item.previewUrl}
                alt={`Screenshot ${index + 1} of ${items.length}, ${item.width} by ${item.height}`}
              />
              <figcaption className="queue-item-copy">
                <strong>{item.width} × {item.height}</strong>
                <small>{timestampLabel(item.capturedAt)}</small>
              </figcaption>
              <button
                type="button"
                className="queue-remove"
                aria-label={`Remove screenshot ${index + 1} of ${items.length}`}
                onClick={() => void onRemove(item.id)}
                disabled={actionDisabled}
              >
                <span aria-hidden="true">×</span>
              </button>
            </figure>
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
