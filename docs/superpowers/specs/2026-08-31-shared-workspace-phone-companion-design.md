# Shared Workspace and Phone Companion Design

**Status:** Approved in conversation on 2026-08-31; written specification pending final user review.

**Scope:** Replace the rejected Task 1 runtime flow with a reliable single-window desktop workspace, explicit screenshot actions, a canonical session conversation shared by desktop and phone, secure LAN QR pairing, and evidence-driven Codex CLI timeout handling.

## 1. Goals

1. Fluely runs as one application instance with one `BrowserWindow`.
2. Settings and Work are mutually exclusive views in that window, with navigation in both directions.
3. The desktop and phone expose only two primary actions: `Capture` adds context and `Ask` sends the current prompt and/or shared screenshot queue.
4. Desktop and phone render the same ordered session conversation: prompts, screenshot attachments, streaming answers, completed answers, errors, and cancellations.
5. A phone on the same LAN pairs by QR code, can see computer screenshots, submit questions, receive streaming answers, and trigger a computer screenshot.
6. Screenshot paths and provider/process details remain confined to the Electron main process.
7. Conversation text and screenshot attachments are session-scoped. Restarting or quitting Fluely clears them.
8. The Codex CLI timeout is fixed from runtime evidence, not by blindly increasing `120000ms`.

## 2. Non-goals

- No cross-restart conversation persistence.
- No cloud relay or internet-accessible phone endpoint.
- No phone image upload in the first phone slice.
- No arbitrary phone-provided filesystem path or image URL.
- No multi-device synchronization in the first phone slice; one paired phone is supported.
- No TLS certificate provisioning in the first LAN slice. The UI must disclose that an untrusted LAN can observe unencrypted traffic.
- No copy of Natively's renderer globals, old `IntelligenceManager`, path-returning screenshot API, or permanent query-token protocol.

## 3. Accepted Product Decisions

- Closing or restarting Fluely clears the full conversation and all attachment files.
- The first implementation sends all current queue screenshots when the user selects **Ask**. Per-image selection is deferred.
- An empty prompt is valid for **Ask** when the shared queue is non-empty. The domain command supplies the deterministic prompt `Analyze the attached screenshots.` and records that prompt in the shared conversation.
- **Capture** adds a computer screenshot to the queue and does not start analysis.
- **Ask** starts analysis using the current prompt and queue, and clears the shared queue only after the core accepts the request.
- Phone and desktop are projections of one main-process conversation; neither renderer owns canonical history.
- A phone-triggered screenshot is captured on the computer and appears as the same visible draft-context item on both clients; after Send it appears as the same conversation attachment on both clients.

## 4. Architecture

```text
Desktop React renderer
  ↕ typed preload / allow-listed IPC
Electron main process
  ├─ ApplicationInstanceGuard
  ├─ WorkspaceController
  ├─ CommandRouter
  ├─ ConversationStore
  ├─ AttachmentStore
  ├─ AnalysisService → CodexCliService
  ├─ ScreenshotService / screenshot-session
  └─ PhoneGateway (HTTP + WebSocket + QR pairing)
          ↕ authenticated session protocol
      Phone web client
```

### 4.1 Authority boundaries

- `ConversationStore` is the only authority for message order, status, and replay.
- `AttachmentStore` is the only authority for immutable conversation screenshots and their byte delivery.
- `ScreenshotService` continues to own the five-item working queue and managed capture paths. Its queue snapshot is the canonical shared draft context visible on both desktop and phone.
- `AnalysisService` continues to own one active provider run and cancellation.
- `CommandRouter` is the only entrypoint for user actions from desktop shortcuts, desktop UI, and phone commands.
- `PhoneGateway` owns transport, pairing, authentication, limits, and client lifecycle. It does not know filesystem paths, Codex arguments, or BrowserWindow internals.
- Desktop and phone receive typed snapshots/events. They never relay commands to each other.

## 5. Application Instance and View Modes

### 5.1 Single instance

The main process sets the stable application name/user-data identity before requesting `app.requestSingleInstanceLock()`.

- A process that fails to obtain the lock exits before creating services, IPC handlers, or a window.
- The first process listens for `second-instance` and restores, shows, and focuses its existing window.
- `activate` creates a window only when the first process has none.
- The implementation must prove that a packaged instance and a development launch cannot display two independent Fluely windows against the same user-data directory.

### 5.2 Onboarding state versus navigation state

`settings.setupComplete` only records whether first-run setup has succeeded. It no longer represents the currently displayed view.

The renderer owns a session-only `WorkspaceView = "settings" | "work"`:

- Initial view is `settings` when `setupComplete` is false, otherwise `work`.
- Settings and Work are exclusive React branches under one root.
- Work has a **Settings** button that changes only `WorkspaceView`.
- Settings has a primary **Save and enter workspace** action and, after setup has completed, a **Back to workspace** action.
- Revisiting Settings does not set `setupComplete` false and does not erase the current conversation or answer state.
- A failed settings save/validation leaves the user in Settings and displays the specific error.

## 6. Desktop Screenshot and Ask UX

The Work action row contains three explicit operations:

1. **Capture** — capture only; append to the working queue; no model call.
2. **Ask** — send the current prompt and/or queue; no capture and no visibility change. It is enabled only when the app is not busy or hydrating and either the trimmed prompt or queue is non-empty.
3. **Cancel** — cancel the active analysis. Queue clearing remains a separate explicit action.

The queue remains capped at five screenshots. A successful Ask clears the shared queue and the projection updates both clients.

The Work view displays screenshot thumbnails for queued items and for conversation attachments. The phone displays the same current queue as a separate **Context to send** strip. Capture updates that shared draft queue on both clients but does not create a chat message. Sending materializes immutable attachments and creates the same chat message on both clients. Thumbnail rendering uses opaque IDs through a main-process-controlled scheme/API; no DOM attribute, IPC payload, log, or error includes a local path.

## 7. Canonical Session Conversation

### 7.1 Data model

```typescript
type MessageRole = "user" | "assistant" | "system"
type MessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "error"
  | "cancelled"

interface ConversationAttachment {
  id: string
  mimeType: "image/png"
  width: number
  height: number
  byteLength: number
  createdAt: number
}

interface ConversationMessage {
  id: string
  sequence: number
  role: MessageRole
  text: string
  attachmentIds: string[]
  status: MessageStatus
  createdAt: number
  finishedAt?: number
  error?: { code: string; message: string }
}

interface ConversationSnapshot {
  sessionId: string
  revision: number
  messages: ConversationMessage[]
  attachments: ConversationAttachment[]
  activeMessageId?: string
}
```

### 7.2 Event rules

- Every mutation increments `revision` and emits an event with the resulting revision.
- Starting analysis first appends one user message containing the effective prompt and immutable attachment IDs.
- It then creates one assistant message with `streaming` status.
- Provider deltas append to that same assistant message.
- Completion, error, and cancellation update that message rather than creating a second terminal message.
- Desktop and phone render snapshots/events by `sequence`; they do not invent local messages before the main process acknowledges the command.
- If a client detects a revision gap, it requests a complete snapshot and replaces its local projection.
- Phone reconnect receives the complete current session snapshot, then live events.
- Phone reconnect also receives the current five-item working-queue snapshot. Queue state is separate from conversation history and is never replayed as a chat message until a send command materializes it.
- Clear conversation cancels/settles active analysis, clears messages, deletes attachment files, resets the revisioned snapshot, and broadcasts the cleared state to both clients.

### 7.3 Limits

- At most one active analysis command.
- Up to 100 conversation messages and 100 MiB of session attachments.
- When a limit would be exceeded, evict the oldest complete turn and its unreferenced attachments from the canonical store; both clients receive the same eviction event.
- A single attachment is limited to 20 MiB and must be validated as a PNG generated by `ScreenshotService`.
- User prompt length remains bounded by the existing analysis contract.

## 8. Attachment Lifecycle and Delivery

### 8.1 Immutable session attachments

Working-queue screenshots can be deleted or evicted, so a screenshot used in the conversation is copied into:

```text
<userData>/session-attachments/<sessionId>/<attachmentId>.png
```

Files are created through a temporary file plus atomic rename with mode `0600`. Attachment IDs are generated by the main process and cannot encode paths.

At application startup, stale `session-attachments` directories are removed before a new session is created. Graceful quit also disposes the current store and removes the directory. Crash leftovers are therefore cleared on the next restart.

### 8.2 Desktop delivery

The main process registers a private media protocol or equivalent narrow handler with two explicit namespaces:

- `context/<screenshotId>` resolves only a screenshot currently present in `ScreenshotService`'s working queue;
- `attachment/<attachmentId>` resolves only an immutable file registered in `AttachmentStore`.

It returns `image/png` with `Cache-Control: no-store`. Unknown, malformed, cross-session, evicted, or deleted IDs return a controlled not-found response.

### 8.3 Phone delivery

The phone uses its authenticated paired session to request:

- `GET /api/context/:screenshotId` for a current draft-queue thumbnail resolved through `ScreenshotService`;
- `GET /api/attachments/:attachmentId` for a sent conversation image resolved through `AttachmentStore`.

The gateway streams bytes without exposing a path.

- Authentication is mandatory.
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and exact `Content-Length` are returned.
- Range requests, directory traversal syntax, arbitrary filenames, and content-type overrides are rejected.
- A revoked/expired phone session receives `401`; an unknown/evicted context item or attachment receives `404`.

## 9. Codex CLI Diagnosis and Timeout Design

### 9.1 Evidence collection before behavior change

The first implementation slice adds structured, redacted run diagnostics:

- spawn timestamp;
- first stdout byte timestamp;
- first valid JSONL event timestamp;
- last protocol/progress event timestamp;
- first visible delta timestamp;
- close/exit timestamp and signal;
- bounded stderr tail;
- model, reasoning effort, image count, and timeout stage;
- no prompt text, image path, token, or credential.

The worker then runs controlled benign text and generated-image requests using the same executable, model, reasoning effort, sandbox, and stdin behavior as Fluely. The current fixed `120000ms` behavior is not changed until this matrix distinguishes startup delay, active-but-long processing, protocol silence, and a genuinely stuck child.

### 9.2 Result-driven timeout policy

Once the controlled run proves where time is spent, replace the single wall-clock timer with three explicit stages:

- **Startup timeout:** no stdout/protocol activity before the evidenced startup limit.
- **Idle timeout:** no stdout/protocol/progress activity for the evidenced idle limit after startup.
- **Hard timeout:** absolute safety ceiling of 600000ms.

Any parsed lifecycle/progress event refreshes idle liveness even when it produces no visible answer text. The hard ceiling never resets. Errors identify the stage (`CLI_START_TIMEOUT`, `CLI_IDLE_TIMEOUT`, or `CLI_HARD_TIMEOUT`) and preserve a safe diagnostic summary.

If a controlled request has no protocol activity and no completion by the hard ceiling, the task remains a CLI/configuration failure investigation; increasing a limit is not an accepted fix.

## 10. Phone Pairing and Network Security

### 10.1 Startup and binding

- Phone Companion is disabled by default.
- The Settings view has an explicit **Start phone companion on LAN** control and a visible unencrypted-LAN warning.
- When enabled, `PhoneGateway` binds to `0.0.0.0`, probes ports `4123..4134`, then uses an OS-assigned port if all are unavailable.
- The desktop displays candidate private IPv4 URLs and a QR code for the preferred reachable address.
- Stopping Phone Companion closes clients, invalidates pairing/session credentials, clears gateway timers, and stops listening.

### 10.2 One-time QR pairing

- The QR URL contains a random 32-byte one-time pairing secret with a two-minute lifetime.
- The phone loads the page through that secret once. A successful exchange sets a random 32-byte, HttpOnly, SameSite=Strict session cookie and redirects to `/` without the secret in the URL.
- The pairing secret becomes unusable immediately after exchange.
- Only one phone session is active. Pairing a replacement requires the desktop user to choose **Replace paired phone**, which revokes and disconnects the old session.
- Stopping, replacing, or quitting invalidates every phone credential.
- Missing, empty, malformed, expired, replayed, or wrong credentials fail without throwing and are rate-limited.

### 10.3 HTTP and WebSocket controls

- Only the fixed phone page, pairing endpoint, authenticated context/attachment media endpoints, and authenticated WebSocket upgrade exist.
- `Host` and `Origin` are validated against the gateway's advertised addresses.
- The page uses `no-store`, `no-referrer`, `nosniff`, a restrictive CSP, and escaped model output.
- WebSocket heartbeat is 15 seconds; a client missing pong is closed.
- Incoming command messages are limited to 16 KiB, 10 commands per 10 seconds, and one active analysis globally.
- Outbound buffering is limited to 1 MiB per client; revision gaps force snapshot resynchronization.
- The LAN warning states that first-slice HTTP/WS traffic is not encrypted and must only be used on a trusted local network.

## 11. Phone Protocol and UX

The phone page displays:

- connection/pairing state;
- the same current screenshot queue as desktop, including authenticated thumbnails;
- the same canonical message list and screenshot attachments as desktop;
- live assistant text as the canonical assistant message streams;
- a text field and **Send** button;
- a **Capture computer screen** button;
- a **Clear conversation** button;
- explicit busy, error, cancelled, disconnected, and revoked states.

Phone commands are typed and carry a `requestId`:

```typescript
type PhoneCommand =
  | { type: "ask"; requestId: string; prompt: string }
  | { type: "capture"; requestId: string }
  | { type: "clear"; requestId: string }
  | { type: "cancel"; requestId: string }
  | { type: "resync"; requestId: string; revision: number }
```

- Duplicate `requestId` values are idempotently acknowledged and do not repeat the action.
- Phone `ask` uses the current main-process working queue, materializes immutable attachments, and enters the same `CommandRouter` path as desktop **Ask**.
- Phone `capture` runs the existing privacy-safe screenshot workflow and adds the screenshot to the shared working queue. Both clients display the updated draft context; no conversation message is created until a send command materializes the queue.
- Phone never supplies a screenshot path, URL, model name, sandbox option, or provider credential.

## 12. Error and Cancellation Semantics

- Busy analysis commands return a structured `ANALYSIS_IN_PROGRESS` acknowledgement without creating a phantom conversation message.
- Capture permission denial creates a synchronized error event but no attachment.
- Codex timeout/error updates the canonical assistant message to `error`; both clients display the same safe message and code.
- Cancel updates the active assistant message to `cancelled`, waits for the provider to settle, and preserves the conversation attachments.
- Clear waits for active provider and screenshot work to settle before deleting attachments.
- A phone disconnect does not cancel an analysis started on desktop or phone; the desktop remains authoritative and the phone receives the result on reconnect.
- App quit cancels active work, closes the gateway, clears session stores, and deletes session attachment files.

## 13. Test Strategy

### 13.1 Desktop foundation

- Single-instance lock failure exits before service/window creation.
- `second-instance` restores and focuses the existing window.
- Packaged/dev smoke proves only one visible Fluely instance.
- Settings and Work roots are mutually exclusive.
- First setup validates/saves; later navigation does not change `setupComplete` or erase conversation state.
- Capture-only never calls analysis.
- Ask never captures or changes visibility and sends the current prompt plus all queue IDs.
- Ask clears the queue only after the core accepts the request.
- Renderer contracts contain IDs/metadata only.

### 13.2 Conversation and attachments

- Sequence/revision monotonicity, snapshot replacement, gap recovery, streaming update, terminal update, clear, limit eviction, and attachment reference cleanup.
- Queue deletion/eviction does not remove an attachment already referenced by the conversation.
- Startup and quit remove stale/current session files.
- Desktop protocol and phone endpoint reject malformed, cross-session, deleted, and traversal IDs.
- Desktop and phone projection fixtures produce byte-for-byte-equivalent message/attachment metadata.

### 13.3 Codex reliability

- Diagnostic timestamps are redacted and stage-correct.
- Lifecycle events refresh idle liveness; hard timeout never resets.
- Startup, idle, and hard timeout errors are distinct.
- Cancel and timeout terminate the child and settle iterator locks.
- A real benign text request and generated-image request reach a terminal result or produce evidence that identifies the failing stage.

### 13.4 Phone gateway

- Loopback/LAN binding, port fallback, address selection, start/stop/restart, and quit disposal.
- One-time secret success, expiry, replay, malformed token, rate limiting, session replacement, and revocation.
- Host/Origin enforcement, CSP/headers, authenticated WebSocket, heartbeat, backpressure, and command size/rate limits.
- Initial snapshot, event revisions, reconnect replay, gap resync, identical screenshot rendering, phone question, phone capture, cancellation, clear, and duplicate request idempotency.
- No HTTP, WebSocket, IPC, renderer state, log, or error exposes a local screenshot path.

### 13.5 User gates

After every accepted commit, `gpt-5.6-luna` (`reasoning_effort=max`) launches the exact application state and keeps it running. The workflow pauses for explicit user pass/fail before the next slice.

The phone slice is not accepted until the user scans the QR code on a real phone on the same LAN and confirms:

1. pairing succeeds;
2. existing desktop messages and screenshots appear on the phone;
3. new desktop screenshots and streaming answers appear on the phone;
4. a phone question and phone-triggered screenshot appear identically on desktop;
5. clear removes the session on both sides;
6. restarting Fluely presents an empty conversation and invalidates the old phone session.

## 14. Implementation Decomposition

This design is implemented as two plans with separate final reviews:

### Plan A — Desktop reliability and shared session foundation

1. Controlled Codex diagnosis and evidence-driven timeout fix.
2. Single-instance application guard.
3. Separation of onboarding state from Settings/Work navigation.
4. Explicit Capture and Ask actions.
5. Canonical `ConversationStore` and immutable `AttachmentStore`.
6. Desktop conversation/attachment projection and full user gate.

### Plan B — Phone companion gateway

1. Typed phone settings and lifecycle.
2. Address selection, HTTP server, one-time pairing, session authentication, and QR generation.
3. Authenticated attachment delivery.
4. WebSocket snapshot/event protocol and phone page.
5. CommandRouter integration for phone send/capture/cancel/clear.
6. Security, reconnect, limits, packaging, and real-phone user gate.

Plan B starts only after Plan A's shared store and desktop projection pass the user gate.
