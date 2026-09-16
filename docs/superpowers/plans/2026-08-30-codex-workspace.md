# Fluely Codex Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-run Codex CLI setup flow, a compact work overlay, and a screenshot-question analysis loop with streamed answers.

**Architecture:** Keep all Codex process spawning, screenshot paths, and analysis cancellation in Electron main-process services. Extend the existing typed preload contract with narrow Codex, analysis, window-opacity, and setup-mode operations, then render a setup view or a work view from persisted settings. Reuse the existing capture/privacy session so Capture & ask hides Fluely before taking the screenshot.

**Tech Stack:** Electron 40, TypeScript, React 18, Vite, Node.js child processes, Node built-in test runner, electron-builder.

**Spec:** `docs/superpowers/specs/2026-08-30-codex-workspace-design.md`

## Global Constraints

- Keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- Codex CLI is invoked with `spawn` and an argument array; never construct a shell command string.
- Use `codex exec --ephemeral --json --color never --sandbox read-only --model <model> --image <path>` and write the prompt through stdin.
- Reuse saved local Codex CLI authentication; never expose API keys, filesystem paths, PNG bytes, or child-process handles to the renderer.
- Use public Electron APIs only; do not add process disguise, private display-server APIs, monitoring detection, or permission bypass.
- Preserve the existing capture-privacy behavior and its best-effort ScreenCaptureKit limitation.
- Every new production behavior has a failing test before implementation; existing tests must remain green.
- The default Codex CLI model is `gpt-5.6-sol`, the fast model is `gpt-5.6-luna`, and the default work-window opacity is `0.92`, clamped to `0.35..1.0`.
- Keep the managed screenshot queue at five items and analyze only IDs that are present in the main-process queue.

---

### Task 1: Extend shared settings and implement Codex CLI transport

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `electron/services/settings-core.ts`
- Modify: `electron/services/SettingsService.ts`
- Create: `electron/services/CodexCliService.ts`
- Create: `electron/services/__tests__/CodexCliService.test.mjs`
- Modify: `electron/services/__tests__/settings-core.test.mjs`

**Interfaces:**
- `CodexCliSettings` exposes `enabled`, `path`, `model`, `fastModel`, `timeoutMs`, `sandboxMode`, and optional `modelReasoningEffort`.
- `FluelySettings` adds `setupComplete`, `codex`, and `window.opacity` while preserving existing shortcut/privacy fields.
- `CodexCliService.buildArgs(model, imagePaths, sandboxMode, reasoningEffort)` returns an argv array beginning with `exec` and containing repeated `--image` pairs.
- `CodexCliService.extractText(raw)` extracts agent-message deltas from JSONL and passes through plain text.
- `CodexCliService.validateExecutable(path, timeoutMs)` returns `{ success, resolvedPath?, error? }` without throwing.
- `CodexCliService.stream(path, options)` yields answer deltas and terminates the spawned child on `AbortSignal` or timeout.

- [ ] **Step 1: Write failing settings tests**

Add assertions that `normalizeSettings({})` returns `setupComplete: false`, the Codex defaults, and `window.opacity === 0.92`; add assertions that invalid opacity, timeout, sandbox, or blank Codex paths normalize to safe defaults and that valid values survive.

- [ ] **Step 2: Run the settings tests and verify the expected failure**

Run `npm test -- electron/services/__tests__/settings-core.test.mjs`.

Expected: FAIL because the new settings fields and defaults do not exist.

- [ ] **Step 3: Implement settings contracts and normalization**

Add the exact interfaces and defaults from the spec, clamp opacity to `0.35..1.0`, keep dimensions clamped as before, normalize Codex path/model strings, and accept only the three sandbox values and six reasoning values.

- [ ] **Step 4: Run the settings tests green**

Run `npm test -- electron/services/__tests__/settings-core.test.mjs`; all settings-core tests must pass.

- [ ] **Step 5: Write failing Codex argv/parser tests**

Cover argv ordering, `--json`, `--ephemeral`, `--sandbox read-only`, `--model`, repeated `--image`, JSONL `agent_message.delta` concatenation, lifecycle-event suppression, plain-text fallback, and error extraction.

- [ ] **Step 6: Run the Codex tests and verify the expected failure**

Run `npm test -- electron/services/__tests__/CodexCliService.test.mjs`.

Expected: FAIL because the transport module is missing.

- [ ] **Step 7: Implement the minimal Codex CLI service**

Use `spawn` with `stdio: ['pipe', 'pipe', 'pipe']`, write the prompt to stdin, parse stdout line-by-line, collect stderr for actionable errors, kill the child on timeout/abort, and never pass through arbitrary renderer arguments. Include executable auto-detection for `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, `~/.local/bin/codex`, and the configured bare `codex` command.

- [ ] **Step 8: Run transport tests and typecheck**

Run `npm test -- electron/services/__tests__/CodexCliService.test.mjs` and `npm run typecheck`; both must pass.

- [ ] **Step 9: Commit the settings and transport slice**

```bash
git add src/shared/ipc.ts electron/services/settings-core.ts electron/services/SettingsService.ts electron/services/CodexCliService.ts electron/services/__tests__
git commit -m "feat: add Codex CLI settings and transport"
```

### Task 2: Add analysis service, queue path access, and typed main-process events

**Files:**
- Modify: `electron/services/ScreenshotService.ts`
- Create: `electron/services/AnalysisService.ts`
- Create: `electron/services/__tests__/AnalysisService.test.mjs`
- Modify: `electron/services/__tests__/ScreenshotService.test.mjs`
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- `ScreenshotService.getManagedPaths(ids?: string[]): string[]` returns paths for existing managed IDs only and never exposes them through IPC.
- `AnalysisService.start(request)` starts one request and returns an initial `AnalysisState`.
- `AnalysisService.cancel()` aborts the active Codex child and returns a cancelled state.
- `AnalysisService.getState()` returns a serializable state with status, text, model, screenshot IDs, timestamps, and optional error.
- `AnalysisService.onStateChanged(listener)` subscribes to ordered `started`, `delta`, `completed`, `cancelled`, and `error` snapshots.

- [ ] **Step 1: Write failing queue-path and analysis tests**

Test that only valid queued IDs resolve to managed PNG paths, unknown IDs are ignored/rejected, a second analysis is rejected while one is running, deltas accumulate in order, cancel terminates the provider, and a provider failure leaves the screenshot queue intact.

- [ ] **Step 2: Run the analysis tests and verify the expected failure**

Run `npm test -- electron/services/__tests__/AnalysisService.test.mjs`; expect a missing-module or missing-method failure.

- [ ] **Step 3: Implement managed path lookup**

Add a main-process-only method that maps queue IDs to `${directory}/${id}.png`, validates the strict UUID format, and returns copies of paths without changing `ScreenshotState` or the preload contract.

- [ ] **Step 4: Implement `AnalysisService` with an injected provider**

Build a bounded prompt from intent, user question, and the selected screenshot IDs. Choose `model` or `fastModel`, call `CodexCliService.stream`, append each yielded delta, emit state snapshots, and retain queued screenshots after success/error/cancel. Use one active `AbortController` and clear it in every terminal path.

- [ ] **Step 5: Run analysis tests green**

Run `npm test -- electron/services/__tests__/AnalysisService.test.mjs electron/services/__tests__/ScreenshotService.test.mjs`; all must pass.

- [ ] **Step 6: Commit the analysis slice**

```bash
git add src/shared/ipc.ts electron/services/ScreenshotService.ts electron/services/AnalysisService.ts electron/services/__tests__
git commit -m "feat: add streamed screenshot analysis"
```

### Task 3: Wire Codex, analysis, opacity, and setup-mode IPC

**Files:**
- Modify: `electron/services/ipcHandlers.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/preloadBridge.ts`
- Modify: `electron/main.ts`
- Create: `electron/services/__tests__/analysis-ipc.test.mjs`
- Modify: `electron/services/__tests__/ipc-contract.test.mjs`

**Interfaces:**
- `window.fluely.codex.getStatus()` and `.validate(path)` return `CodexStatus` without exposing child details.
- `window.fluely.analysis.start(request)`, `.cancel()`, `.getStatus()`, and `.onStateChanged(listener)` manage the stream.
- `window.fluely.window.setOpacity(opacity)` clamps and applies the value in the main process.
- `window.fluely.window.setMode(mode)` persists setup/work completion state through the existing settings service.
- Existing screenshot/settings/shortcut methods remain source-compatible.

- [ ] **Step 1: Write failing IPC contract tests**

Assert the exact new public groups and methods, reject malformed analysis requests, reject unknown screenshot IDs, clamp or reject invalid opacity, and confirm no generic shell, filesystem, or child-process API appears in the preload object.

- [ ] **Step 2: Run the IPC tests and verify the expected failure**

Run `npm test -- electron/services/__tests__/analysis-ipc.test.mjs electron/services/__tests__/ipc-contract.test.mjs`; expect failures for missing channels and bridge methods.

- [ ] **Step 3: Implement main-process dependency wiring**

Instantiate `AnalysisService` once after settings load, pass the service's managed path accessor and Codex config, apply persisted opacity to the BrowserWindow, and register `codex:*`, `analysis:*`, and `window:*` handlers with serializable error conversion.

- [ ] **Step 4: Implement narrow preload wrappers and event cleanup**

Expose fixed channel wrappers only; map the `analysis:state-changed` event to an unsubscribe function and do not pass the Electron event object into renderer callbacks.

- [ ] **Step 5: Run IPC tests green and typecheck**

Run `npm test -- electron/services/__tests__/analysis-ipc.test.mjs electron/services/__tests__/ipc-contract.test.mjs` and `npm run typecheck`.

- [ ] **Step 6: Commit the IPC slice**

```bash
git add electron/services/ipcHandlers.ts electron/preload.ts electron/preloadBridge.ts electron/main.ts electron/services/__tests__ src/shared/ipc.ts
git commit -m "feat: expose analysis and workspace IPC"
```

### Task 4: Replace the renderer with setup and work views

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`
- Create: `src/renderer/components/SetupView.tsx`
- Create: `src/renderer/components/WorkView.tsx`
- Create: `src/renderer/components/AnswerSurface.tsx`
- Create: `src/renderer/components/QueueStrip.tsx`
- Create: `src/renderer/__tests__/workspace-state.test.mjs`

**Interfaces:**
- `SetupView` receives settings/status and calls `onStart(settingsPatch)`.
- `WorkView` receives screenshot/analysis/Codex state and exposes `onCaptureAsk`, `onAskQueue`, `onCancel`, `onOpacityChange`, and `onOpenSettings` callbacks.
- `AnswerSurface` renders answer text as text content, never as unsanitized HTML.
- `QueueStrip` renders metadata-only items and invokes removal by ID.

- [ ] **Step 1: Write failing renderer state tests**

Test pure view-model helpers for setup mode selection, intent prompt construction, opacity label formatting, queue count, running/cancel button state, and transition from `setupComplete: false` to the work view after a successful start action.

- [ ] **Step 2: Run renderer tests and verify the expected failure**

Run `npm test -- electron/services/__tests__/workspace-state.test.mjs` after compiling the helpers; expect missing-module or missing-export failures.

- [ ] **Step 3: Implement SetupView**

Create a polished first-run card with Fluely identity, Codex path field, auto-detected status, model/fast-model fields, reasoning/timeout controls, privacy indicator, and a primary **Start using Fluely** button. Show actionable validation errors and disable the button while saving/validating.

- [ ] **Step 4: Implement WorkView and focused components**

Build the compact dark overlay layout: draggable header, connection pill, settings/hide controls, 35–100% opacity slider, central streamed answer area, intent chips, queue strip, multiline composer, and capture/ask/cancel actions. Keep responsive behavior usable at the existing minimum window size.

- [ ] **Step 5: Replace App orchestration**

Load settings/status/queue/Codex/analysis in parallel, select SetupView or WorkView from `setupComplete`, subscribe/unsubscribe to both screenshot and analysis events, preserve notices across async actions, and return to setup without clearing the analysis conversation.

- [ ] **Step 6: Run renderer tests and build**

Run `npm test -- electron/services/__tests__/workspace-state.test.mjs`, `npm run typecheck`, and `npm run build`.

- [ ] **Step 7: Commit the renderer slice**

```bash
git add src/renderer src/shared/ipc.ts
git commit -m "feat: add setup and work overlay views"
```

### Task 5: Integrate window behavior, shortcuts, and capture-and-analyze composition

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/services/ShortcutManager.ts`
- Modify: `electron/services/capture-workflow.ts`
- Modify: `electron/services/window-lifecycle.ts`
- Create: `electron/services/__tests__/workspace-composition.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Existing `captureAndAnalyze` and `analyzeQueue` shortcuts invoke the same `AnalysisService` paths used by renderer buttons.
- `createScreenshotWorkflow` gains a capture-and-analyze composition that hides the window only for capture, then streams analysis without an implicit visibility toggle.
- `main.ts` creates a frameless-feeling always-on-top work window with persisted opacity and a safe setup fallback.

- [ ] **Step 1: Write failing composition tests**

Cover shortcut-to-analysis wiring, capture-before-analysis ordering, cancel-and-clear cleanup, opacity reapplication after window recreation, and the rule that Ask queue does not change window visibility.

- [ ] **Step 2: Run composition tests and verify the expected failure**

Run `npm test -- electron/services/__tests__/workspace-composition.test.mjs`; expect missing behavior failures.

- [ ] **Step 3: Implement main-process composition and window options**

Wire the two analysis shortcut callbacks, apply `setAlwaysOnTop(true)` and persisted `setOpacity`, retain the existing content-protection controller, and make all capture/analysis terminal paths notify the renderer with complete state snapshots.

- [ ] **Step 4: Run focused composition tests green**

Run `npm test -- electron/services/__tests__/workspace-composition.test.mjs electron/services/__tests__/ShortcutManager.test.mjs electron/services/__tests__/capture-workflow.test.mjs`.

- [ ] **Step 5: Update product documentation**

Document first-run setup, Codex CLI authentication (`codex login`), `Capture & ask`, `Ask queue`, opacity behavior, and the best-effort capture-protection limitation without claiming universal invisibility.

- [ ] **Step 6: Commit the integration slice**

```bash
git add electron/main.ts electron/services/ShortcutManager.ts electron/services/capture-workflow.ts electron/services/window-lifecycle.ts electron/services/__tests__ README.md
git commit -m "feat: connect workspace shortcuts and capture analysis"
```

### Task 6: Full verification and packaging review

**Files:**
- No new production files; review all commits from the feature branch.

- [ ] **Step 1: Run the complete verification suite**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run package:dir
node scripts/check-package-allowlist.mjs
git diff --check
```

- [ ] **Step 2: Inspect the packaged preload and renderer boundary**

Confirm the package contains no test files/source maps, the preload exposes only the documented Fluely API groups, and no renderer bundle contains `require`, `process`, `fs`, `path`, `child_process`, or generic Electron access.

- [ ] **Step 3: Perform available local Codex smoke checks**

Confirm `command -v codex`, `codex --version`, and `codex login status` work. Run the service's fake-provider tests and, only when credentials are available, a harmless text-only `codex exec --ephemeral --json` smoke request; do not upload user screenshots outside the app's intended provider call.

- [ ] **Step 4: Record remaining manual macOS checks**

Record that real macOS validation is still needed for TCC prompts, ScreenCaptureKit behavior, always-on-top/focus restoration, Dock animation, and visual fit of the packaged app.

- [ ] **Step 5: Commit documentation/verification notes if needed**

Only commit tracked source or documentation changes; keep screenshots, credentials, build output, and test reports ignored.
