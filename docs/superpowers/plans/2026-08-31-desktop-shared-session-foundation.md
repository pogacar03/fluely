# Desktop Shared Session Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop app reliable and unambiguous: one app window, mutually exclusive Settings and Work views, explicit screenshot actions, resilient Codex execution, and a canonical session-scoped conversation/attachment model that can later be projected to a phone.

**Architecture:** Electron main owns application lifetime, Codex execution, the screenshot working queue, immutable attachments, and the canonical ordered conversation. The renderer is a projection of main-process state and sends typed commands through preload IPC. `setupComplete` remains onboarding state only; renderer-local `WorkspaceView` controls Settings versus Work. Codex execution uses observable startup, idle, and hard deadlines. All session files and in-memory history are discarded on a clean restart, with stale session directories cleaned at startup.

**Tech Stack:** Electron 40, TypeScript, React 18, Vite, Node.js test runner, existing Codex CLI integration, Electron custom protocols and IPC.

**Spec:** `docs/superpowers/specs/2026-08-31-shared-workspace-phone-companion-design.md`

## Global Constraints

- Work on the existing `codex/fluely-foundation` branch and preserve unrelated user changes.
- Use test-driven development for each behavior change: add a failing test, run it to prove the failure, implement the smallest complete change, then rerun focused and full checks.
- A task is not accepted until a separate `gpt-5.6-luna` agent with `reasoning_effort=max` verifies its diff, tests, and spec coverage.
- Commit only the paths owned by the task. Never stage with `git add .` or `git add -A`.
- After every accepted task, a fresh `gpt-5.6-luna` agent with `reasoning_effort=max` must start the exact committed app state and keep it running. Report only the focused user checks for that task, then wait for explicit pass/fail before beginning the next task.
- Never kill an unrelated or pre-existing app process. Track and stop only processes created by the current task.
- Preserve the existing CLI command contract and renderer security settings unless this plan explicitly changes them.
- No phone HTTP/WebSocket server is implemented in this plan. Plan B consumes the typed ports created here.

---

## Task 1: Diagnose and harden Codex CLI execution

**Outcome:** The app no longer reports a fixed two-minute wall-clock timeout while Codex is making progress. Failures expose a safe diagnostic timeline, while every run still has a strict ten-minute ceiling.

**Files:**

- Modify: `package.json`
- Create: `electron/services/codex-run-diagnostics.ts`
- Create: `electron/services/__tests__/codex-run-diagnostics.test.mjs`
- Modify: `electron/services/CodexCliService.ts`
- Modify: `electron/services/__tests__/CodexCliService.test.mjs`
- Modify: `electron/services/AnalysisService.ts`
- Modify: `src/shared/ipc.ts` only if the current public error payload lacks a typed diagnostic category
- Create: `docs/superpowers/verification/2026-08-31-codex-timeout-diagnosis.md`

**Interfaces:**

```ts
export type CodexRunMilestone =
  | "spawn"
  | "first-byte"
  | "first-jsonl"
  | "last-event"
  | "first-delta"
  | "exit";

export interface CodexRunDiagnostics {
  readonly startedAtMs: number;
  mark(milestone: CodexRunMilestone, atMs?: number): void;
  setExit(code: number | null, signal: NodeJS.Signals | null): void;
  appendStderr(chunk: string): void;
  snapshot(nowMs?: number): Readonly<{
    elapsedMs: number;
    milestones: Partial<Record<CodexRunMilestone, number>>;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    stderrTail: string;
  }>;
}
```

The stderr tail is capped at 4 KiB and redacts bearer tokens, cookie values, home-directory paths, and values of environment variables whose names contain `KEY`, `TOKEN`, `SECRET`, or `PASSWORD`. Diagnostics may be written to application logs and the verification report, but the renderer receives only a stable error category plus a concise user-safe message.

Timeout policy after the controlled reproduction gate:

- startup deadline: 120,000 ms from successful spawn until the first valid JSONL lifecycle/progress/result event;
- idle deadline: 120,000 ms since the most recent valid lifecycle/progress/result event;
- hard deadline: 600,000 ms from successful spawn and never reset;
- raw stderr or malformed stdout does not reset the idle deadline;
- abort/cancel terminates immediately and is reported separately from timeout;
- whichever deadline fires records `startup_timeout`, `idle_timeout`, or `hard_timeout`.

**Steps:**

- [ ] Generate the isolated task brief and record the pre-task HEAD and clean/dirty status in the Plan A SDD ledger.
- [ ] Replace the service-only `test` script with `node --test` so the repository test gate discovers `.test.mjs` files under `electron`, `src/shared`, renderer test directories, and later phone test directories. Run the old and new commands before adding tests, and record the discovered test counts to prove the gate did not lose existing coverage.
- [ ] Add unit tests for milestone timestamps, bounded stderr, redaction, and immutable snapshots; run the focused test and capture the expected failure caused by the missing module.
- [ ] Implement `CodexRunDiagnostics` without changing timeout behavior; rerun the focused test.
- [ ] Instrument `CodexCliService` at spawn, first byte, first valid JSONL, each valid event, first content delta, and exit. Ensure diagnostics do not change result parsing or cancellation.
- [ ] Add deterministic tests using the existing fake child-process/clock harness for milestone recording and safe error output.
- [ ] Run a controlled matrix against the configured CLI: one benign text request and one generated test image request, recording command shape, model/reasoning settings, milestone elapsed times, exit status, and redacted stderr in the verification report. Stop each probe at 600,000 ms; do not expose prompts, screenshots, tokens, or absolute home paths in the report.
- [ ] Gate the timeout behavior change on the matrix: if at least one probe emits a valid lifecycle/progress/result event, continue with the exact three-deadline policy above. If neither probe emits any valid event before the hard deadline, do not change timeout semantics; mark the task blocked with the diagnostic report and escalate the CLI/configuration fault for main-agent review.
- [ ] Add failing fake-clock tests proving: startup timeout before any valid event; lifecycle/progress refreshes idle; malformed output does not refresh idle; idle timeout after silence; hard timeout despite continuous progress; completion clears all timers; cancellation remains distinct.
- [ ] Replace the single 120,000 ms wall-clock timer with the result-driven startup/idle/hard deadline controller, preserving the existing process-tree termination path.
- [ ] Run the focused service tests, then `npm test`, `npm run typecheck`, and `npm run build`. Record exact commands and outcomes in the ledger.
- [ ] Request a `gpt-5.6-luna` (`reasoning_effort=max`) spec/code review and resolve every blocking finding with another red-green-refactor cycle.
- [ ] Commit only the task paths with message `fix: harden Codex CLI run deadlines`.
- [ ] Have a fresh `gpt-5.6-luna` (`reasoning_effort=max`) verifier confirm commit parent, path set, clean status, focused tests, full tests, typecheck, and build.
- [ ] Have a fresh `gpt-5.6-luna` (`reasoning_effort=max`) launch agent start the committed app and keep the process/session alive. The user gate checks one normal analysis, one run lasting beyond two minutes while progress continues, cancellation, and the absence of credential/path leakage in the displayed error.

---

## Task 2: Enforce one application instance and mutually exclusive workspace views

**Outcome:** Only one Electron application instance and one `BrowserWindow` can own the workspace. Settings and Work are two mutually exclusive views in that window, with an explicit control in each direction.

**Files:**

- Create: `electron/services/application-instance.ts`
- Create: `electron/services/__tests__/application-instance.test.mjs`
- Modify: `electron/main.ts`
- Create: `src/shared/workspace-view.ts`
- Create: `src/shared/__tests__/workspace-view.test.mjs`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/SetupView.tsx`
- Modify: `src/renderer/components/WorkView.tsx`
- Modify: renderer styles colocated with those components, using the existing style organization
- Modify: existing renderer component tests, or create `src/renderer/__tests__/workspace-navigation.test.tsx` if the current harness supports DOM rendering

**Interfaces:**

```ts
export type WorkspaceView = "settings" | "work";

export function initialWorkspaceView(setupComplete: boolean): WorkspaceView;
export function canOpenWork(setupComplete: boolean): boolean;
```

```ts
export interface ApplicationInstancePort {
  acquire(): boolean;
  onSecondInstance(focus: () => void): () => void;
}
```

`setupComplete` is persisted onboarding/configuration state. It must never be toggled merely to navigate between Settings and Work. A second-instance event restores a minimized window, shows it, and focuses it; it never creates another window.

**Steps:**

- [ ] Add failing unit tests for lock acquisition, early quit on lock failure, second-instance focus/restore, and listener cleanup.
- [ ] Implement the application-instance adapter around `app.requestSingleInstanceLock()` and integrate it before `app.whenReady()` and window creation.
- [ ] Add failing pure-state tests for first launch, configured launch, Settings → Work, Work → Settings, and rejection of Work before setup is complete.
- [ ] Implement `WorkspaceView` state in `App.tsx`; preserve `setupComplete` solely for onboarding/config validity.
- [ ] Give Setup/Settings a clear `Start` or `Back to Work` action depending on configuration state. Give Work a clear `Settings` action. Render exactly one root view for every state.
- [ ] Add/adjust renderer tests to assert that Settings and Work content are never mounted simultaneously and that navigation does not mutate onboarding completion.
- [ ] Run focused tests, `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Request a `gpt-5.6-luna` (`reasoning_effort=max`) review focused on instance timing, macOS activation behavior, window ownership, and state separation; resolve blocking findings.
- [ ] Commit only the task paths with message `fix: unify workspace window navigation`.
- [ ] Independently verify the commit and full checks with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent.
- [ ] Launch the committed app with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent and keep it running. The user gate checks: opening/starting again does not create a second workspace window; Settings and Work never appear together; both navigation buttons work; relaunch opens the expected onboarding/configured entry view.

---

## Task 3: Add explicit capture and image-send controls with a canonical working queue

**Outcome:** Capturing, selecting, previewing, removing, and sending screenshots are explicit operations. Sending all queued images works with or without typed text and creates a deterministic prompt when text is empty.

**Files:**

- Create: `src/shared/context-queue.ts`
- Create: `src/shared/__tests__/context-queue.test.mjs`
- Modify: `src/shared/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/WorkView.tsx`
- Create or modify: `src/renderer/components/ContextQueue.tsx`
- Modify: renderer styles colocated with the Work view/queue
- Modify: relevant screenshot and renderer tests

**Interfaces:**

```ts
export interface ContextScreenshot {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  mimeType: "image/png";
  previewUrl: string;
}

export type WorkspaceCommand =
  | { type: "capture"; requestId: string }
  | { type: "remove"; requestId: string; screenshotId: string }
  | { type: "clear-queue"; requestId: string }
  | { type: "clear-conversation"; requestId: string }
  | { type: "send"; requestId: string; prompt: string }
  | { type: "capture-and-send"; requestId: string; prompt: string }
  | { type: "cancel"; requestId: string };
```

Queue invariants:

- maximum five screenshots;
- capture appends and does not send;
- remove and clear affect only draft context;
- `Send images` sends every queued screenshot;
- empty prompt is normalized to exactly `Analyze the attached screenshots.`;
- `Capture & ask` is a convenience composition of capture followed by send only after capture succeeds;
- successful, failed, and cancelled sends all leave the draft queue unchanged; only `clear-queue` or per-item remove changes it;
- controls have disabled/loading states that prevent accidental duplicate commands.

**Steps:**

- [ ] Add failing pure tests for queue capacity, append order, remove, clear, empty-prompt normalization, send-all selection, and request-id deduplication.
- [ ] Implement the queue reducer/helpers and typed IPC payloads.
- [ ] Expose the minimum preload command method for the shared `WorkspaceCommand` union; validate every payload in main before executing it.
- [ ] Refactor the existing screenshot flow so capture returns queue metadata and a private preview URL without triggering analysis.
- [ ] Add visible controls: `Capture`, standalone `Send images`, `Capture & ask`, `Cancel`, per-thumbnail remove, and clear-all. Keep the text prompt optional.
- [ ] Render ordered thumbnails with count/capacity and accessible labels. Do not expose filesystem paths in renderer state or DOM.
- [ ] Wire `Send images` and `Capture & ask` to the hardened Codex runner. Preserve the queue on success, failure, and cancellation; sent messages use immutable attachment copies, so later draft removal cannot alter history.
- [ ] Add renderer/service tests for explicit action semantics, five-item cap, duplicate command suppression, disabled states, and error retry.
- [ ] Run focused tests, `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Request a `gpt-5.6-luna` (`reasoning_effort=max`) review focused on accidental-send paths, queue ownership, IPC validation, accessibility, and retries; resolve blocking findings.
- [ ] Commit only the task paths with message `feat: add explicit screenshot send controls`.
- [ ] Have a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent independently verify commit contents and full checks.
- [ ] Launch the committed app with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent and keep it running. The user gate checks standalone Capture, visible thumbnails, remove/clear, standalone Send images with no text, Capture & ask, the five-image cap, queue retention after send, and retry after cancel/failure.

---

## Task 4: Establish the canonical session conversation and desktop projection

**Outcome:** Main owns one ordered, session-scoped conversation with immutable screenshot attachments. Desktop messages reference attachments by opaque IDs and render through a private protocol. Restarting the app clears conversation, queue, and attachment files.

**Files:**

- Create: `src/shared/conversation.ts`
- Create: `src/shared/__tests__/conversation.test.mjs`
- Create: `electron/services/AttachmentStore.ts`
- Create: `electron/services/__tests__/AttachmentStore.test.mjs`
- Create: `electron/services/ConversationStore.ts`
- Create: `electron/services/__tests__/ConversationStore.test.mjs`
- Create: `electron/services/CommandRouter.ts`
- Create: `electron/services/__tests__/CommandRouter.test.mjs`
- Create: `electron/services/session-media-protocol.ts`
- Create: `electron/services/__tests__/session-media-protocol.test.mjs`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/services/AnalysisService.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/WorkView.tsx`
- Create or modify: `src/renderer/components/Conversation.tsx`
- Modify: relevant styles and tests

**Interfaces:**

```ts
export type MessageRole = "user" | "assistant" | "system";

export type MessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "error"
  | "cancelled";

export interface ConversationAttachment {
  id: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteLength: number;
  createdAt: number;
}

export interface ConversationMessage {
  id: string;
  sequence: number;
  role: MessageRole;
  text: string;
  attachmentIds: string[];
  status: MessageStatus;
  createdAt: number;
  finishedAt?: number;
  error?: { code: string; message: string };
}

export interface ConversationSnapshot {
  sessionId: string;
  revision: number;
  messages: ConversationMessage[];
  attachments: ConversationAttachment[];
  activeMessageId?: string;
}

export interface SessionProjectionSnapshot {
  conversation: ConversationSnapshot;
  queue: ContextScreenshot[];
}

export interface ConversationPort {
  snapshot(): ConversationSnapshot;
  subscribe(listener: (event: ConversationEvent) => void): () => void;
}

export interface CommandRouter {
  execute(command: WorkspaceCommand, source: "desktop" | "phone"): Promise<CommandResult>;
}
```

Storage and retention invariants:

- create a unique session directory beneath Electron `sessionData`/`userData` at startup with owner-only permissions;
- clean stale Fluely session directories at startup, then create the current directory;
- atomically write attachments via temporary file plus rename and set mode `0600`;
- renderer never receives an absolute path;
- private desktop URLs use `fluely-media://context/<screenshotId>` and `fluely-media://attachment/<attachmentId>`;
- attachment lookup rejects traversal, malformed IDs, unknown IDs, and namespace mismatch;
- maximum single attachment size is 20 MiB;
- retain at most 100 messages and 100 MiB of immutable attachments;
- enforce limits by evicting the oldest complete user/assistant turn and its now-unreferenced attachments; never evict the active turn;
- conversation and files are not restored after restart.

**Steps:**

- [ ] Add failing shared-model tests for monotonically increasing sequence/revision, immutable attachment references, event ordering, active-request transitions, and complete-turn eviction.
- [ ] Add failing `AttachmentStore` tests using a temporary directory for atomic writes, file mode, opaque lookup, traversal rejection, 20 MiB rejection, reference-aware deletion, and stale-session cleanup.
- [ ] Implement `AttachmentStore` and `ConversationStore` with dependency-injected clock/ID generation for deterministic tests.
- [ ] Add failing `CommandRouter` tests for source-independent command semantics, request-id idempotency, capture, send, cancel, clear, successful materialization, failure retry, and event order.
- [ ] Implement `CommandRouter`; route existing desktop commands through it. On send, copy queued captures into immutable attachments, append the user message, and append/update the assistant message from `AnalysisService`. Never mutate the working queue as a side effect of send.
- [ ] Register the privileged `fluely-media` scheme before app readiness and implement namespace-safe media responses with exact MIME type, `nosniff`, and `no-store` headers.
- [ ] Expose snapshot subscription and typed command methods through preload. The renderer must hydrate from one snapshot and then apply revision-ordered events; on a revision gap it requests a fresh snapshot.
- [ ] Render the canonical conversation and attachment thumbnails on desktop. Remove any parallel renderer-only history that could diverge.
- [ ] Add integration tests proving capture → send → streaming/done, cancel, retry, eviction, protocol retrieval, revision-gap resync, and restart cleanup.
- [ ] Run focused tests, `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Request a `gpt-5.6-luna` (`reasoning_effort=max`) review focused on single-writer ownership, ordering, atomicity, private-media boundaries, cleanup, and Plan B port compatibility; resolve all blocking findings.
- [ ] Commit only the task paths with message `feat: add canonical session conversation`.
- [ ] Independently verify commit parent/path set, focused tests, full tests, typecheck, build, and clean status with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent.
- [ ] Launch the exact committed app with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent and keep it running. The user gate checks that screenshots appear in sent messages, message/attachment order is stable, sending does not clear the draft queue, cancellation and retry are coherent, navigation preserves the current session, and a full app restart clears queue, chat, and images.

---

## Plan A Completion Gate

- [ ] A fresh `gpt-5.6-luna` (`reasoning_effort=max`) verifier runs `npm test`, `npm run typecheck`, and `npm run build` from the final Plan A commit and records exact output summaries.
- [ ] Verify `npm test` discovers tests outside `electron/services/__tests__`; a service-only test count is a failed gate.
- [ ] Verify there is one BrowserWindow creation path, one command router, one conversation owner, and no absolute media path exposed through IPC or rendered DOM.
- [ ] Verify every Plan A task has an accepted review, a path-scoped commit, an independent commit audit, and an explicit user pass.
- [ ] Update the Plan A SDD ledger with final HEAD and remaining Plan B dependency notes.
- [ ] Do not begin Plan B until the user explicitly passes the final Plan A running build.
