# Capture Privacy and Background Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add best-effort capture protection and a permission-aware, bounded background screenshot queue that never exposes local paths to the renderer.

**Architecture:** A focused capture privacy controller owns BrowserWindow protection and a screenshot service owns capture, persistence, and queue cleanup. The main process coordinates hide/capture/restore sessions and exposes only typed, allow-listed operations to shortcuts and the sandboxed preload.

**Tech Stack:** Electron 40, TypeScript, Node built-in test runner, React 18, Vite

**Spec:** `docs/superpowers/specs/2026-08-30-capture-privacy-design.md`

## Global Constraints

- Use documented Electron and operating-system capabilities only; do not add monitoring/proctoring/security-product evasion.
- macOS capture protection is best-effort and must not be described as universally invisible to ScreenCaptureKit.
- Screen Recording permission remains mandatory; do not bypass or suppress it.
- Do not expose screenshot filesystem paths, generic IPC, filesystem, or shell access to the renderer.
- Store only managed PNGs below `<userData>/screenshots` and retain at most five.
- Follow strict TDD: add each behavior test, run it and record the expected failure, then implement.
- Do not add runtime dependencies.

---

### Task 1: Complete capture-privacy vertical slice

**Files:**

- Create: `electron/services/CapturePrivacyController.ts`
- Create: `electron/services/ScreenshotService.ts`
- Create: `electron/services/screenshot-session.ts`
- Create: `electron/services/__tests__/CapturePrivacyController.test.mjs`
- Create: `electron/services/__tests__/ScreenshotService.test.mjs`
- Create: `electron/services/__tests__/screenshot-session.test.mjs`
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
- `runScreenshotSession({ window, platform, capture, wait }): Promise<T>` owns concurrency-safe visibility restoration. Equivalent names are acceptable only if the resulting interfaces remain focused and typed.
- Renderer IPC group: `screenshots.get()`, `screenshots.capture()`, `screenshots.delete(id)`, and `screenshots.clear()`.

- [ ] **Step 1: Add failing capture-protection tests**

Test with a small fake window that a newly applied controller calls `setContentProtection(true)`, calls `setHiddenInMissionControl(true)` on Darwin, reapplies protection on `show`, does not call destroyed windows, and removes listeners on disposal. Run `npm test -- --test-name-pattern='capture protection'` and record failures caused by the missing module.

- [ ] **Step 2: Implement capture protection minimally**

Create the controller with dependency-injected platform detection. Avoid timers and private macOS APIs. Apply protection immediately and on `show`; `reassert()` must bypass any state deduplication. Run the focused tests to green.

- [ ] **Step 3: Add failing screenshot-session tests**

Cover visible and already-hidden windows, macOS `showInactive()` restoration, capture failure restoration, lock release after failure, and rejection of an overlapping capture. Use a controllable deferred promise for the overlap case; do not assert only on mocks—assert the session result and observable window state.

- [ ] **Step 4: Implement screenshot session minimally**

Hide only when initially visible, await 80 ms on Darwin or 40 ms elsewhere through an injected wait function, execute capture, and restore in `finally`. Never call `show()` on a window that started hidden. Run the focused tests to green.

- [ ] **Step 5: Add failing ScreenshotService tests**

Use temporary directories and a fake desktop-capture adapter. Cover permission mapping, five-second source timeout, display-ID matching, PNG bytes written by temp-file rename, five-item eviction, deletion only by a known opaque ID, clear, and release of the `capturing` flag after errors. Expected metadata must use hand-written literal values rather than helpers from production code.

- [ ] **Step 6: Implement ScreenshotService minimally**

Use `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })`, Electron `screen` to choose the display nearest the cursor, `source.display_id` for matching, `thumbnail.toPNG()` for bytes, and `thumbnail.getSize()` for dimensions. Use `crypto.randomUUID()` for IDs. Create the managed directory recursively, write `<id>.png.tmp`, rename to `<id>.png`, and unlink evicted files best-effort. On Darwin consult `systemPreferences.getMediaAccessStatus('screen')`; return stable `IpcError` codes/messages without prompting or bypassing permission.

- [ ] **Step 7: Extend settings, contracts, preload, and IPC test-first**

First update settings and IPC tests to expect `privacy.captureProtection: true` and a `screenshots` preload group with only `get`, `capture`, `delete`, and `clear`. Add `SCREEN_CAPTURE_DENIED`, `SCREEN_CAPTURE_RESTRICTED`, `SCREEN_CAPTURE_PERMISSION_REQUIRED`, `SCREEN_CAPTURE_FAILED`, `CAPTURE_IN_PROGRESS`, and `SCREENSHOT_NOT_FOUND` to the error-code union. Add strict ID validation in IPC. Run the focused tests red, implement the typed contracts and handlers, then run them green.

- [ ] **Step 8: Wire main-process lifecycle and shortcuts test-first**

Update `ShortcutManager` tests so `captureScreenshot` and `cancelAndClear` are active and invoke their supplied handlers while provider-dependent actions remain unavailable. In `main.ts`, load settings before creating the window, create/apply the privacy controller immediately after BrowserWindow construction, create the screenshot service below `userData`, wrap capture through the screenshot session, and connect shortcut/IPC dependencies. Shortcut errors must be caught and logged. On shutdown dispose controller, shortcuts, and screenshot resources. Run focused tests red then green.

- [ ] **Step 9: Add the renderer status and controls**

Display capture protection state, permission state, queue count, newest dimensions, Capture, and Clear controls in the existing status panel. Refresh screenshot state after renderer actions and when the window regains focus. Preserve the current visual language and do not render paths or raw image bytes.

- [ ] **Step 10: Document the actual guarantee**

Update `README.md` with background-capture behavior, macOS permission requirements, and the explicit ScreenCaptureKit limitation. Do not use “undetectable” as an absolute claim.

- [ ] **Step 11: Verify and self-review**

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run package:dir`. Inspect `git diff --check`, confirm no runtime dependency was added, confirm the package contains no test/source-map files, and review the diff against every acceptance criterion in the spec.

- [ ] **Step 12: Commit**

Commit the complete vertical slice with message `feat: add capture privacy and background screenshots`. Write the required implementation report with RED/GREEN evidence, files changed, verification output, and any platform limitations that still require manual macOS validation.

