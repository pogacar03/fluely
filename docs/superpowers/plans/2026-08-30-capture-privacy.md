# Capture Privacy and Background Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add best-effort capture protection and a permission-aware, bounded background screenshot queue that never exposes local paths to the renderer.

**Architecture:** A focused capture privacy controller owns BrowserWindow protection and a screenshot service owns capture, persistence, and queue cleanup. The main process coordinates hide/capture/restore sessions and exposes only typed, allow-listed operations to shortcuts and the sandboxed preload.

**Tech Stack:** Electron 40, TypeScript, Node built-in test runner, React 18, Vite

**Spec:** `docs/superpowers/specs/2026-08-30-capture-privacy-design.md`

## Global Constraints

- Use documented Electron and operating-system capabilities only; do not add monitoring/proctoring/security-product evasion.
- macOS capture protection is best-effort and must not be described as universally invisible to ScreenCaptureKit.
- Screen Recording permission remains mandatory; do not bypass or suppress it. A first `not-determined` capture must call `desktopCapturer.getSources()` to let macOS present consent, then reread permission on failure.
- Do not expose screenshot filesystem paths, generic IPC, filesystem, or shell access to the renderer.
- Store only session-scoped managed PNGs below `<userData>/screenshots` and retain at most five. On initialization and clear, remove only strict UUID `.png`/`.png.tmp` files; preserve unrelated files.
- Use the public Electron Dock API on Darwin when capture protection is enabled; restore the Dock when disabled, and on dispose only when that controller owns the hide request.
- Follow strict TDD: add each behavior test, run it and record the expected failure, then implement.
- Do not add runtime dependencies.

### Fix round 1 decisions

- `ScreenshotService` initializes before any mutation. Capture, delete, clear, and eviction run on one async mutation tail. An overlapping capture returns `CAPTURE_IN_PROGRESS`; delete/clear wait behind it and do not fake-cancel it.
- Electron source enumeration has no AbortSignal. Fluely returns the stable five-second timeout error to the caller while retaining the underlying Promise as the active gate; an initial Darwin `not-determined` permission returns the actionable permission-required code instead, and `getState().capturing` stays true until it settles.
- The selected display adapter supplies `id`, `bounds`, and `scaleFactor`; source requests use rounded native captured-pixel dimensions rather than a fixed size.
- The main process emits full `screenshots:state-changed` snapshots. The preload allowlist adds only `onStateChanged(listener) => unsubscribe` to the four queue methods.
- Settings update/reset apply saved/default shortcuts through an injected registration dependency after persistence. Conflicts remain represented as unavailable status entries while the requested value is retained.
- `capture-workflow.ts` is the injectable composition boundary used by main and integration tests; no real Electron app is started by Node tests.

### Fix round 2 decisions

- `ScreenshotService.whenIdle()` returns the normalized mutation tail. `runScreenshotSession` returns the five-second caller error immediately but schedules a once-only visibility finalizer on that promise, keeping `isScreenshotSessionActive()` true until the late native source settles. A never-settling source intentionally leaves Fluely hidden and points the user to restart.
- `window-lifecycle.ts` owns injectable `ready-to-show` and `closed` wiring; `main.ts` uses it, and the ready handler checks the shared screenshot-session gate before showing.
- `DockPrivacyCoordinator.setHidden(hidden, onSettled?)` is shared by main-created privacy controllers, serializes public `app.dock.hide/show` actions, and lets only the current intent reassert protection. Controller ownership prevents an unowned dispose from showing the Dock.
- `validateShortcutSettings` is shared by settings-core and `ShortcutManager`. Registration throws return `INTERNAL_ERROR` with best-effort rollback; settings IPC propagates an `applyShortcuts` failure. The OS-conflict `ok:true`/unavailable status remains unchanged.
- `ScreenshotService` accepts a focused filesystem adapter (default `node:fs/promises`) so tests verify temp write → rename and temp unlink after either failure. The shared `subscribeToScreenshotState` helper owns renderer listener activity and idempotent cleanup.

### Final review decisions

- A Darwin permission transition is checked after source enumeration and before thumbnail bytes are generated or persisted. Native rejection and timeout errors use the current permission, except an initial `not-determined` timeout which retains the first-use permission-required guidance.
- The shared screenshot-session idle promise is the `ready-to-show` release signal. The lifecycle helper remembers readiness, retries after release, and keeps destroyed or never-settling windows hidden.
- Renderer settings save/reset are handled by `runSettingsAction`, which guards all post-await updates, reports transport failures, and clears busy state in `finally`; the App effect reactivates its mounted ref on each setup for React StrictMode.

---

### Task 1: Complete capture-privacy vertical slice

**Files:**

- Create: `electron/services/CapturePrivacyController.ts`
- Create: `electron/services/ScreenshotService.ts`
- Create: `electron/services/screenshot-session.ts`
- Create: `electron/services/capture-workflow.ts`
- Create: `electron/services/window-lifecycle.ts`
- Create: `electron/services/__tests__/CapturePrivacyController.test.mjs`
- Create: `electron/services/__tests__/ScreenshotService.test.mjs`
- Create: `electron/services/__tests__/screenshot-session.test.mjs`
- Create: `electron/services/__tests__/capture-workflow.test.mjs`
- Create: `electron/services/__tests__/screenshot-state.test.mjs`
- Modify: `src/shared/ipc.ts`
- Modify: `electron/services/settings-core.ts`
- Modify: `electron/services/ShortcutManager.ts`
- Modify: `electron/services/ipcHandlers.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/preloadBridge.ts`
- Modify: `electron/main.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css` only if the new controls need existing-style layout rules
- Modify existing tests under `electron/services/__tests__`
- Modify: `README.md`

**Interfaces:**

- `PrivacySettings = { captureProtection: boolean }`, default `true`.
- `ScreenshotItem = { id: string; createdAt: string; width: number; height: number }`.
- `ScreenshotState = { items: ScreenshotItem[]; capturing: boolean; permission: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unavailable' }`.
- `CapturePrivacyController.apply(window, enabled)`, `reassert()`, and `dispose()` own window protection listeners.
- `ScreenshotService.capture(): Promise<ScreenshotItem>`, `getState(): ScreenshotState`, `delete(id): Promise<ScreenshotState>`, and `clear(): Promise<ScreenshotState>` own the managed queue.
- `runScreenshotSession({ window, platform, capture, whenIdle, wait }): Promise<T>` owns concurrency-safe visibility restoration; `whenIdle` is optional for callers that do not have a native mutation tail.
- `attachWindowLifecycle({ window, isCaptureActive, waitForCaptureIdle, onReadyToShow, onClosed })` retains a ready event observed during capture and retries only after the injected idle gate releases.
- `waitForScreenshotSessionIdle(): Promise<void>` resolves when the shared screenshot-session visibility gate has restored and released.
- `attachApplicationLifecycle({ app, hasWindows, reassertPrivacy, createWindow })` keeps activation reassertion and recreation injectable and is used by `main.ts`.
- `DockPrivacyCoordinator.setHidden(hidden, onSettled?)` serializes documented Darwin Dock visibility operations.
- `ScreenshotService.whenIdle(): Promise<void>` and its injected filesystem adapter are internal main-process seams.
- Renderer IPC group: `screenshots.get()`, `screenshots.capture()`, `screenshots.delete(id)`, `screenshots.clear()`, and `screenshots.onStateChanged(listener)` with an unsubscribe return.

- [ ] **Step 1: Add failing capture-protection tests**

Test with a small fake window that a newly applied controller calls `setContentProtection(true)`, calls `setHiddenInMissionControl(true)` on Darwin, reapplies protection on `show`, does not call destroyed windows, and removes listeners on disposal. Run `npm test -- --test-name-pattern='capture protection'` and record failures caused by the missing module.

- [ ] **Step 2: Implement capture protection minimally**

Create the controller with dependency-injected platform detection. Avoid timers and private macOS APIs. Apply protection immediately and on `show`; `reassert()` must bypass any state deduplication. Run the focused tests to green.

- [ ] **Step 3: Add failing screenshot-session tests**

Cover visible and already-hidden windows, macOS `showInactive()` restoration, capture failure restoration, lock release after failure, and rejection of an overlapping capture. Use a controllable deferred promise for the overlap case; do not assert only on mocks—assert the session result and observable window state.

- [ ] **Step 4: Implement screenshot session minimally**

Hide only when initially visible, await 80 ms on Darwin or 40 ms elsewhere through an injected wait function, execute capture, and restore through the once-only finalizer. If `whenIdle` is supplied, a timeout holds that finalizer until native settlement; never call `show()` on a window that started hidden. Run the focused tests to green.

- [ ] **Step 5: Add failing ScreenshotService tests**

Use temporary directories and a fake desktop-capture adapter. Cover permission mapping, five-second source timeout, display-ID matching, PNG bytes written by temp-file rename, five-item eviction, deletion only by a known opaque ID, clear, and release of the `capturing` flag after errors. Expected metadata must use hand-written literal values rather than helpers from production code.

- [ ] **Step 6: Implement ScreenshotService minimally**

Use `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })`, Electron `screen` to choose the display nearest the cursor, `source.display_id` for matching, `thumbnail.toPNG()` for bytes, and `thumbnail.getSize()` for dimensions. Derive `thumbnailSize` from the selected display's rounded native bounds × scale factor. Use `crypto.randomUUID()` for IDs. Create the managed directory recursively, write `<id>.png.tmp`, rename to `<id>.png`, and unlink evicted files best-effort. On Darwin consult `systemPreferences.getMediaAccessStatus('screen')`; allow an initial `not-determined` source request to trigger consent, reread status after failure, and return stable `IpcError` codes without bypassing permission. Track a timed-out source Promise until settle because Electron provides no AbortSignal.

- [ ] **Step 7: Extend settings, contracts, preload, and IPC test-first**

First update settings and IPC tests to expect `privacy.captureProtection: true` and a `screenshots` preload group with `get`, `capture`, `delete`, `clear`, and the narrow `onStateChanged`/unsubscribe subscription. Add `SCREEN_CAPTURE_DENIED`, `SCREEN_CAPTURE_RESTRICTED`, `SCREEN_CAPTURE_PERMISSION_REQUIRED`, `SCREEN_CAPTURE_FAILED`, `CAPTURE_IN_PROGRESS`, and `SCREENSHOT_NOT_FOUND` to the error-code union. Add strict ID validation in IPC. Run the focused tests red, implement the typed contracts and handlers, then run them green.

- [ ] **Step 8: Wire main-process lifecycle and shortcuts test-first**

Update `ShortcutManager` tests so `captureScreenshot` and `cancelAndClear` are active and invoke their supplied handlers while provider-dependent actions remain unavailable. In `main.ts`, load settings before creating the window, create/apply the privacy controller immediately after BrowserWindow construction, apply the public Darwin Dock policy, create the screenshot service below `userData`, wrap capture through the screenshot session and active visibility gate, emit full screenshot state snapshots, and connect shortcut/IPC dependencies. Shortcut errors must be caught and logged. On shutdown dispose controller, shortcuts, and screenshot resources. Run focused tests red then green.

- [ ] **Step 9: Add the renderer status and controls**

Display capture protection state, permission state, queue count, newest dimensions, Capture, and Clear controls in the existing status panel. Subscribe to `screenshots.onStateChanged` with cleanup, and retain refreshes after renderer actions and when the window regains focus. Preserve the current visual language and do not render paths or raw image bytes.

- [ ] **Step 10: Document the actual guarantee**

Update `README.md` with background-capture behavior, macOS permission requirements, and the explicit ScreenCaptureKit limitation. Do not use “undetectable” as an absolute claim.

- [ ] **Step 11: Verify and self-review**

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run package:dir`. Inspect `git diff --check`, confirm no runtime dependency was added, confirm the package contains no test/source-map files, and review the diff against every acceptance criterion in the spec.

- [x] **Step 12: Commit (baseline vertical slice)**

The baseline vertical slice was committed as `feat: add capture privacy and background screenshots`; fix-round-2 changes are tracked separately with their own RED/GREEN evidence and verification.

### Fix round 2 implementation checklist

- [x] Hold the screenshot session gate through `ScreenshotService.whenIdle()` after a caller-facing timeout, including the never-settling/restart guidance.
- [x] Gate the real `ready-to-show` lifecycle through `attachWindowLifecycle` and use that helper from `main.ts`.
- [x] Preserve an actionable first-use TCC timeout and emit the final reread permission state after native settlement.
- [x] Serialize shared public Dock hide/show intents with latest-generation reassertion and controller ownership.
- [x] Reject duplicate persisted accelerators, propagate settings shortcut-application failures, and rollback shortcut registration throws without stale active status.
- [x] Add composition and renderer subscription tests, plus the injected filesystem write/rename/unlink seam.
