import type {
  ConversationAttachment,
  ConversationMessage,
  ConversationSnapshot,
} from "../../shared/conversation";

export interface ConversationProps {
  snapshot: ConversationSnapshot | null;
}

function attachmentUrl(id: string): string {
  return `fluely-media://attachment/${encodeURIComponent(id)}`;
}

function statusLabel(status: ConversationMessage["status"]): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "streaming":
      return "Thinking";
    case "completed":
      return "Complete";
    case "error":
      return "Error";
    case "cancelled":
      return "Cancelled";
  }
}

function timestampLabel(createdAt: number): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function attachmentMap(attachments: readonly ConversationAttachment[]): Map<string, ConversationAttachment> {
  return new Map(attachments.map((attachment) => [attachment.id, attachment]));
}

function ConversationAttachmentThumbnail({ attachment }: { attachment: ConversationAttachment }) {
  return (
    <img
      className="conversation-attachment"
      src={attachmentUrl(attachment.id)}
      alt={`Attached screenshot, ${attachment.width} by ${attachment.height}`}
      width={attachment.width}
      height={attachment.height}
    />
  );
}

function ConversationMessageView({
  message,
  attachments,
}: {
  message: ConversationMessage;
  attachments: Map<string, ConversationAttachment>;
}) {
  const messageAttachments = message.attachmentIds
    .map((id) => attachments.get(id))
    .filter((attachment): attachment is ConversationAttachment => attachment !== undefined);
  const hasText = message.text.trim().length > 0;

  return (
    <article
      className={`conversation-message conversation-${message.role} conversation-status-${message.status}`}
      data-message-id={message.id}
      data-message-sequence={message.sequence}
      data-message-status={message.status}
    >
      <div className="conversation-message-meta">
        <span>{message.role === "user" ? "You" : message.role === "assistant" ? "Fluely" : "System"}</span>
        <span>{statusLabel(message.status)}</span>
        {timestampLabel(message.createdAt) && <time>{timestampLabel(message.createdAt)}</time>}
      </div>
      {hasText ? (
        <p className="conversation-message-text" aria-live={message.status === "streaming" ? "polite" : undefined}>
          {message.text}
        </p>
      ) : message.status === "streaming" || message.status === "pending" ? (
        <p className="conversation-message-placeholder">
          <span className="conversation-spinner" aria-hidden="true" />
          {message.status === "pending" ? "Preparing your request…" : "Fluely is thinking…"}
        </p>
      ) : message.status === "error" ? (
        <p className="conversation-message-placeholder">Fluely could not finish this request.</p>
      ) : message.status === "cancelled" ? (
        <p className="conversation-message-placeholder">Request cancelled.</p>
      ) : null}
      {message.error && (
        <p className="conversation-message-error" role="alert">{message.error.message}</p>
      )}
      {messageAttachments.length > 0 && (
        <div className="conversation-attachments" role="list" aria-label="Attached screenshots">
          {messageAttachments.map((attachment) => (
            <figure key={attachment.id} role="listitem">
              <ConversationAttachmentThumbnail attachment={attachment} />
            </figure>
          ))}
        </div>
      )}
    </article>
  );
}

export function Conversation({ snapshot }: ConversationProps) {
  const messages = snapshot?.messages.slice().sort((left, right) => left.sequence - right.sequence) ?? [];
  const attachments = attachmentMap(snapshot?.attachments ?? []);

  return (
    <section className="conversation-card" aria-labelledby="conversation-title">
      <div className="conversation-heading">
        <div>
          <span className="eyebrow accent">SESSION CONVERSATION</span>
          <h2 id="conversation-title">Your screen, in context</h2>
        </div>
        {snapshot && <span className="conversation-revision">Revision {snapshot.revision}</span>}
      </div>
      {messages.length > 0 ? (
        <div className="conversation-messages" role="log" aria-live="polite" aria-label="Session conversation">
          {messages.map((message) => (
            <ConversationMessageView key={message.id} message={message} attachments={attachments} />
          ))}
        </div>
      ) : (
        <p className="conversation-empty">Your sent screenshots and answers will appear here.</p>
      )}
    </section>
  );
}
