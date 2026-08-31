# Codex Workspace Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the existing Codex workspace milestone with reviewed renderer fixes, working global analysis shortcuts, correct cancellation/resource cleanup, reproducible packaging checks, and a clean Git history.

**Architecture:** Keep screenshots, provider execution, cancellation, and file paths in the Electron main process. Global analysis shortcuts emit a narrow typed event to the renderer so they can use the current prompt and intent already owned by `WorkView`; the renderer then calls the existing typed IPC commands. `cancelAndClear` stays in the main process and serializes provider cancellation before screenshot deletion.

**Tech Stack:** Electron 40, TypeScript, React 18, Vite, Node test runner, electron-builder, Codex CLI.

**Spec:** `docs/superpowers/specs/2026-08-30-codex-workspace-design.md`

## Global Constraints

- All implementation, code search, tests, and Git commits are performed by `gpt-5.6-luna` with reasoning effort `max`; the coordinating agent owns planning and final acceptance.
- One independently reviewable task per commit. Do not mix unrelated cleanup or deferred MVP features into these commits.
- The renderer must never receive screenshot file paths, PNG bytes, provider credentials, or child-process handles.
- `Ask queue` must not change window visibility.
- `Capture & ask` must execute hide-for-capture, capture, queue append, then analysis, and must restore the intended window state after capture.
- The screenshot queue remains capped at five managed items.
- Cancellation must terminate or settle the active provider before managed screenshot files are deleted.
- A task is not accepted from a written report alone: its requested diff, focused tests, full regression commands, and commit hash are mandatory evidence.

---

## File and Responsibility Map

- `src/shared/ipc.ts`: public, serializable IPC types and the narrow shortcut-invocation event contract.
- `electron/preloadBridge.ts`: testable bridge factory and listener cleanup behavior.
- `electron/preload.ts`: exposes only the documented shortcut subscription API.
- `electron/services/ShortcutManager.ts`: registers all five shortcuts and safely invokes supplied handlers.
- `electron/services/AnalysisService.ts`: owns provider cancellation and exposes an awaitable idle boundary before screenshot deletion.
- `electron/main.ts`: composes shortcut handlers, analysis lifecycle, screenshot workflow, BrowserWindow policy, and state publication.
- `electron/services/workspace-composition.ts`: small orchestration functions for cancel/clear and shortcut event delivery; no Electron globals.
- `electron/services/window-lifecycle.ts`: reapplies always-on-top and opacity policy when a window is created or recreated.
- `src/renderer/components/WorkView.tsx`: owns the current prompt/intent/fast draft and responds to typed shortcut events.
- `src/shared/shortcut-invocation.ts`: pure mapping from a shortcut invocation plus current draft to existing WorkView callbacks.
- `electron/services/__tests__/workspace-composition.test.mjs`: orchestration order, empty-state, cancellation, and window-policy tests.
- `electron/services/__tests__/ShortcutManager.test.mjs`: shortcut availability and handler dispatch tests.
- `electron/services/__tests__/ipc-contract.test.mjs`: public API/channel allowlist and listener-unsubscribe tests.
- `src/renderer/__tests__/shortcut-invocation.test.mjs`: pure renderer shortcut-routing tests.
- `README.md`: supported flows, shortcuts, setup, and known platform limitations.

---

### Task 1: Re-review and commit the staged Task 4 renderer fixes

**Files:**
- Review staged changes only in the 12 paths listed by `git diff --cached --name-only`.
- Test: `src/renderer/__tests__/workspace-state.test.mjs`
- Test: `electron/services/__tests__/ipc-contract.test.mjs`

**Interfaces:**
- Consumes: current staged Task 4 diff based on commit `dae01bef387e1467a85f60282bfa9ba75fdf8aac`.
- Produces: one accepted commit containing queue-ID selection, narrow `window.hide`, scroll-safe renderer layout, tests, and the Task 4 report.

- [ ] **Step 1: Prove the staged scope is unchanged and mechanically clean**

Run:

```bash
git status --short --branch
git diff --cached --name-status
git diff --cached --stat
git diff --cached --check
```

Expected: exactly 12 staged files, no unstaged/untracked changes, and no `diff --check` output. If the scope differs, stop and report the exact difference; do not reset or amend user work.

- [ ] **Step 2: Run the focused Task 4 tests**

Run:

```bash
npm test -- src/renderer/__tests__/workspace-state.test.mjs electron/services/__tests__/ipc-contract.test.mjs
```

Expected: the five named regression tests for queue IDs, analysis screenshot IDs, preload groups, registered channels, and narrow hide adapter pass.

- [ ] **Step 3: Run the full pre-commit gate**

Run:

```bash
npm run typecheck
npm test
npm run build
git diff --cached --check
```

Expected: typecheck succeeds, all 130 or more tests pass, build exits zero, and the staged diff remains clean.

- [ ] **Step 4: Hand the evidence to the coordinating agent for acceptance**

Return the staged file list, focused/full command exit codes, test count, build result, and any generated but ignored paths. The coordinating agent must review the staged diff against the previous Task 4 rejection before authorizing commit.

- [ ] **Step 5: Commit only after explicit acceptance**

Run:

```bash
git commit -m "fix: close Codex workspace renderer review"
git status --short --branch
```

Expected: one new commit and no tracked working-tree changes. Return the full commit hash.

---

### Task 2: Add a typed global-shortcut invocation bridge

**Files:**
- Modify: `src/shared/ipc.ts`
- Create: `src/shared/shortcut-invocation.ts`
- Modify: `electron/preloadBridge.ts`
- Modify: `electron/preload.ts`
- Modify: `src/renderer/components/WorkView.tsx`
- Modify: `electron/services/__tests__/ipc-contract.test.mjs`
- Create: `src/renderer/__tests__/shortcut-invocation.test.mjs`

**Interfaces:**
- Consumes: existing `ShortcutAction`, `AnalysisRequest`, `onCaptureAsk`, and `onAskQueue` callbacks.
- Produces: shared `WorkAnalysisRequest = Omit<AnalysisRequest, "screenshotIds">`; `AnalysisShortcutInvocation = "analyzeQueue" | "captureAndAnalyze"`; `window.fluely.shortcuts.onInvoked(listener): () => void`; and `dispatchAnalysisShortcut(action, request, handlers): Promise<void>`.

- [ ] **Step 1: Write failing public-contract tests**

Add assertions that the preload exposes only this listener shape and removes the exact wrapped Electron listener on unsubscribe:

```javascript
assert.equal(typeof api.shortcuts.onInvoked, "function")
const unsubscribe = api.shortcuts.onInvoked(listener)
assert.equal(typeof unsubscribe, "function")
assert.deepEqual(ipcRenderer.onCalls, [["shortcut:invoked", wrappedListener]])
unsubscribe()
assert.deepEqual(ipcRenderer.removeListenerCalls, [["shortcut:invoked", wrappedListener]])
```

Run:

```bash
npm test -- electron/services/__tests__/ipc-contract.test.mjs
```

Expected: FAIL because the subscription API and allowlisted channel do not exist.

- [ ] **Step 2: Write failing pure renderer-routing tests**

Test these exact mappings with a non-empty draft `{ prompt: "Explain this", intent: "question", fast: true }`:

```javascript
await dispatchAnalysisShortcut("analyzeQueue", request, handlers)
assert.deepEqual(calls, [["askQueue", request]])

await dispatchAnalysisShortcut("captureAndAnalyze", request, handlers)
assert.deepEqual(calls, [["captureAndAsk", request]])
```

Also assert an unknown runtime value is ignored and does not invoke either handler.

Run:

```bash
npm test -- src/renderer/__tests__/shortcut-invocation.test.mjs
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the minimal shared types and routing helper**

Use this public contract:

```typescript
export type AnalysisShortcutInvocation = Extract<
  ShortcutAction,
  "analyzeQueue" | "captureAndAnalyze"
>

export type WorkAnalysisRequest = Omit<AnalysisRequest, "screenshotIds">

export interface ShortcutInvocationApi {
  onInvoked(
    listener: (action: AnalysisShortcutInvocation) => void,
  ): () => void
}

export async function dispatchAnalysisShortcut(
  action: AnalysisShortcutInvocation,
  request: WorkAnalysisRequest,
  handlers: {
    captureAndAsk(request: WorkAnalysisRequest): Promise<void> | void
    askQueue(request: WorkAnalysisRequest): Promise<void> | void
  },
): Promise<void>
```

The bridge must validate that the payload is one of the two allowed string literals before invoking the renderer listener.

- [ ] **Step 4: Subscribe from `WorkView` without stale draft values**

Register the listener in a React effect, build the request at invocation time from the current prompt/intent/fast state, dispatch through `dispatchAnalysisShortcut`, and call the returned unsubscribe during effect cleanup. Do not introduce a default prompt in the main process.

- [ ] **Step 5: Verify, hand off, and commit the bridge after acceptance**

Run:

```bash
npm run typecheck
npm test -- electron/services/__tests__/ipc-contract.test.mjs src/renderer/__tests__/shortcut-invocation.test.mjs
git diff --check
```

Return the diff summary and command output to the coordinating agent. After explicit acceptance, run:

```bash
git add src/shared/ipc.ts src/shared/shortcut-invocation.ts electron/preloadBridge.ts electron/preload.ts src/renderer/components/WorkView.tsx electron/services/__tests__/ipc-contract.test.mjs src/renderer/__tests__/shortcut-invocation.test.mjs
git commit -m "feat: bridge analysis shortcuts to workspace draft"
```

Expected: focused tests pass and the commit contains only the listed files. Return the full commit hash.

---

### Task 3: Compose global analysis shortcuts and safe cancel-and-clear

**Files:**
- Create: `electron/services/workspace-composition.ts`
- Modify: `electron/main.ts`
- Modify: `electron/services/ShortcutManager.ts`
- Modify: `electron/services/AnalysisService.ts`
- Modify: `electron/services/__tests__/ShortcutManager.test.mjs`
- Modify: `electron/services/__tests__/AnalysisService.test.mjs`
- Create: `electron/services/__tests__/workspace-composition.test.mjs`

**Interfaces:**
- Consumes: `AnalysisShortcutInvocation`, `AnalysisService.cancel(): AnalysisState`, screenshot workflow `clear(): Promise<void>`, and a narrow renderer event sender.
- Produces: `AnalysisService.whenIdle(): Promise<void>`, `createWorkspaceShortcutHandlers(deps): ShortcutActionHandlers`, and `cancelAndClearWorkspace(deps): Promise<void>`.

- [ ] **Step 1: Write failing ShortcutManager availability tests**

Replace the test that expects provider shortcuts to remain unavailable. Assert all five configured actions register, `analyzeQueue` invokes its supplied handler once, and `captureAndAnalyze` invokes its supplied handler once. Retain the existing async rejection coverage through `invokeSafely`.

Run:

```bash
npm test -- electron/services/__tests__/ShortcutManager.test.mjs
```

Expected: FAIL while `PLACEHOLDER_ACTIONS` still contains the two analysis actions.

- [ ] **Step 2: Write failing workspace-composition tests**

Use fakes that append labels to a `calls` array. Assert:

```javascript
await handlers.analyzeQueue()
assert.deepEqual(calls, ["emit:analyzeQueue"])

await handlers.captureAndAnalyze()
assert.deepEqual(calls, ["emit:captureAndAnalyze"])

await handlers.cancelAndClear()
assert.deepEqual(calls, ["analysis.cancel", "analysis.whenIdle", "screenshots.clear", "publish"])
```

Also assert cancellation and clearing are idempotent when no analysis is active and the queue is empty, and that a cancellation failure prevents deletion and is reported through the existing error channel.

In `AnalysisService.test.mjs`, start a provider run whose settlement is manually controlled, call `cancel()`, then assert `whenIdle()` remains pending until that provider promise settles and resolves immediately afterward. Also assert `whenIdle()` resolves immediately when no run is active.

- [ ] **Step 3: Implement orchestration with narrow dependencies**

Use this dependency surface:

```typescript
interface WorkspaceCompositionDependencies {
  emitShortcut(action: AnalysisShortcutInvocation): void
  cancelAnalysis(): AnalysisState
  waitForAnalysisIdle(): Promise<void>
  clearScreenshots(): Promise<void>
  publishState(): void
  reportError(error: unknown): void
}
```

Remove `analyzeQueue` and `captureAndAnalyze` from `PLACEHOLDER_ACTIONS`. Wire both to `emitShortcut`. Implement `cancelAndClear` as cancel, wait for provider settlement, clear managed screenshots, then publish complete analysis and screenshot snapshots. Never delete screenshot files while the provider still owns them.

Add `AnalysisService.whenIdle()` as the only public wait primitive. It must snapshot the current active run promise, resolve immediately when none exists, and resolve after that specific run's cleanup finishes; it must not poll or use an arbitrary timeout.

- [ ] **Step 4: Run focused and full regression tests**

Run:

```bash
npm test -- electron/services/__tests__/workspace-composition.test.mjs electron/services/__tests__/ShortcutManager.test.mjs electron/services/__tests__/AnalysisService.test.mjs electron/services/__tests__/capture-workflow.test.mjs
npm run typecheck
npm test
git diff --check
```

Expected: focused tests and the full suite pass; the UI no longer advertises unavailable analysis shortcuts.

- [ ] **Step 5: Hand off, then commit the orchestration slice after acceptance**

Return the diff summary, focused/full test output, and cancellation-order evidence to the coordinating agent. After explicit acceptance, run:

```bash
git add electron/main.ts electron/services/ShortcutManager.ts electron/services/AnalysisService.ts electron/services/workspace-composition.ts electron/services/__tests__/ShortcutManager.test.mjs electron/services/__tests__/AnalysisService.test.mjs electron/services/__tests__/workspace-composition.test.mjs
git commit -m "feat: wire global analysis workspace shortcuts"
```

Expected: one commit containing only the composition slice. Return the full commit hash.

---

### Task 4: Enforce and restore Work window policy

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/services/window-lifecycle.ts`
- Modify: `electron/services/__tests__/workspace-composition.test.mjs`

**Interfaces:**
- Consumes: persisted normalized opacity and the existing BrowserWindow narrow adapter.
- Produces: `applyWorkWindowPolicy(window, opacity): void`, which always applies always-on-top and normalized opacity after creation/recreation.

- [ ] **Step 1: Write failing policy and recreation tests**

Assert a fresh and a recreated Work window each receive calls equivalent to:

```javascript
assert.deepEqual(window.calls, [
  ["setAlwaysOnTop", true],
  ["setOpacity", 0.86],
])
```

Assert out-of-range persisted opacity is normalized through the existing settings rules before application, not clamped a second time in the lifecycle service.

- [ ] **Step 2: Implement the minimal lifecycle policy**

Call `setAlwaysOnTop(true)` and `setOpacity(settings.window.opacity)` whenever the Work window is created or replaced. Keep capture privacy behavior separate: temporary hide/exclusion for capture must not erase the intended opacity or always-on-top state.

- [ ] **Step 3: Verify, hand off, and commit after acceptance**

Run:

```bash
npm test -- electron/services/__tests__/workspace-composition.test.mjs
npm run typecheck
npm test
git diff --check
```

Return the diff summary and command output to the coordinating agent. After explicit acceptance, run:

```bash
git add electron/main.ts electron/services/window-lifecycle.ts electron/services/__tests__/workspace-composition.test.mjs
git commit -m "fix: restore Work window policy after recreation"
```

Expected: policy tests and the full suite pass. Return the full commit hash.

---

### Task 5: Update user-facing milestone documentation

**Files:**
- Modify: `README.md`
- Modify: `.superpowers/sdd/2026-08-30-codex-workspace/progress.md`

**Interfaces:**
- Consumes: accepted commits from Tasks 1-4 and their verified command output.
- Produces: documentation that matches implemented behavior and does not claim unverified macOS or release status.

- [ ] **Step 1: Correct the milestone table and shortcut instructions**

Document Setup, `codex login status`, Capture & ask, Ask queue, cancellation/clear, opacity, always-on-top, and capture privacy. Mark Codex visual request/streaming as implemented only after Tasks 1-4 pass. Keep phone mirror, multi-provider support, conversation context, region capture, and voice in planned milestones.

- [ ] **Step 2: Record exact limitations**

State that signed/notarized distribution, real multi-display/Retina capture, TCC permission recovery, Dock/focus transitions, and real Codex visual smoke remain unverified until Task 6.

- [ ] **Step 3: Verify docs, hand off, and commit after acceptance**

Run:

```bash
git diff --check
npm run typecheck
npm test
```

Return the documentation diff and command output to the coordinating agent. After explicit acceptance, run:

```bash
git add README.md .superpowers/sdd/2026-08-30-codex-workspace/progress.md
git commit -m "docs: align Codex workspace milestone status"
```

Expected: no stale claim that implemented Codex analysis is merely planned, and no claim that macOS release acceptance has passed. Return the full commit hash.

---

### Task 6: Run final development and release-readiness acceptance

**Files:**
- Modify only if a factual result must be recorded: `.superpowers/sdd/2026-08-30-codex-workspace/progress.md`
- Generated/ignored: `dist/`, `dist-electron/`, `release/`

**Interfaces:**
- Consumes: clean commits from Tasks 1-5.
- Produces: a development-milestone verdict and a separate release-readiness verdict with command logs and manual-check evidence.

- [ ] **Step 1: Prove repository state and run the automated gate**

Run:

```bash
git status --short --branch
npm ci
npm run typecheck
npm test
npm run build
npm run package:dir
node scripts/check-package-allowlist.mjs
git diff --check
```

Expected: clean tracked tree before and after, all tests pass, build/package exit zero, and allowlist reports no tests, source maps, `.env` files, or undeclared resources in the package.

- [ ] **Step 2: Run the local Codex smoke gate**

Run:

```bash
command -v codex
codex --version
codex login status
```

Then run one ephemeral JSON visual request through the application using a disposable captured screenshot. Expected: streamed JSONL reaches a terminal completed state; cancellation of a second request terminates it without promoting partial output to a completed answer.

- [ ] **Step 3: Run macOS manual acceptance**

Verify and capture evidence for: first-run TCC denial and recovery, background screenshot, Fluely exclusion from capture, multi-display mouse-target selection, Retina dimensions, five-item eviction, Capture & ask ordering, Ask queue with no visibility change, cancel-and-clear during an active request, Work always-on-top, opacity after window recreation, hide/show focus behavior, and no Dock animation regression.

- [ ] **Step 4: Separate the two verdicts**

Development milestone passes only if Tasks 1-5 are committed, the automated gate is green, real Codex start/stream/cancel works, and all listed macOS functional checks pass.

Release readiness passes only if development acceptance passes and the packaged app also has a production icon, Developer ID signature, successful strict `codesign` verification, notarization/stapling, install-and-launch smoke, and verified DMG/ZIP contents. Missing credentials produce `NOT RELEASE READY`, not a failure of the development milestone.

- [ ] **Step 5: Return evidence for coordinating-agent acceptance**

Return command exit codes, total tests, package size, allowlist result, Codex version/login status, manual checklist evidence, `git status`, and all commit hashes. The coordinating agent issues the final pass/fail decision; the worker must not self-approve.

---

## Deferred Scope Requiring Separate Specs and Plans

Do not add these to the closeout commits. Plan them independently after the development milestone passes:

1. Conversation context retention and Provider abstraction (`DeepSeek` and OpenAI-compatible APIs).
2. Region screenshot selection and its privacy/focus lifecycle.
3. Phone LAN mirror, WebSocket history sync, authentication, and screenshot delivery.
4. VAD, microphone/system-audio capture, STT, and permission UX.
5. Configuration import/export and Java ACM-specific prompt profiles.

## Coordinating-Agent Acceptance Checklist

- Every task has exactly one scoped commit and a full hash.
- No user-owned or unrelated changes were overwritten, unstaged, or folded into a commit.
- Focused tests fail before implementation where new behavior is introduced, then pass afterward.
- Full typecheck and test suite pass after every implementation slice.
- The final tracked tree is clean and the local branch relationship to upstream is reported.
- Documentation matches code and distinguishes code-level completion, macOS functional acceptance, and signed release readiness.
- Deferred features remain explicitly out of scope for this milestone.
