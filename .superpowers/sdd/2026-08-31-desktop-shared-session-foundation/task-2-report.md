# Plan A Task 2 Report

## Result

Status: DONE_WITH_CONCERNS

Task 2 implements one Electron application instance, one owned workspace `BrowserWindow`, and session-only Settings/Work navigation. The required app launch/user-test gate was intentionally not run because the task instructions explicitly override it.

Base HEAD: `b4d489e24e5f4e5c242e9737e323697f8bbfca7e`

Worktree: `/Users/yu/Documents/cluely二开/fluely`

## TDD evidence

RED was run immediately after adding the two focused test files and before adding their production modules:

```text
$ npm run build:electron && node --test electron/services/__tests__/application-instance.test.mjs src/shared/__tests__/workspace-view.test.mjs
> fluely@0.1.0 build:electron
> tsc -p electron/tsconfig.json
ERR_MODULE_NOT_FOUND: .../electron/services/application-instance.js
ERR_MODULE_NOT_FOUND: .../src/shared/workspace-view.js
1..2
# tests 2
# pass 0
# fail 2
```

The failure was the intended missing-production-module RED. A first rerun exposed and corrected only an incorrect source-relative test import; the tests then failed for the expected missing-module reason.

GREEN focused run:

```text
$ npm run build:electron && node --test electron/services/__tests__/application-instance.test.mjs src/shared/__tests__/workspace-view.test.mjs
> tsc -p electron/tsconfig.json
1..9
# tests 9
# pass 9
# fail 0
```

## Instance and window lifecycle evidence

- `app.setName("Fluely")` remains before `createApplicationInstancePort(app)` and `acquireSingleInstance(...)` in `electron/main.ts`.
- A failed `requestSingleInstanceLock()` calls `app.quit()` and never enters the branch that registers `second-instance`, calls `app.whenReady()`, initializes services, or creates a window.
- The first process installs the `second-instance` listener before `app.whenReady()`.
- The listener targets `mainWindow` only. `restoreAndFocusWindow` ignores a missing/destroyed window, restores it when minimized, then calls `show()` and `focus()`; it never creates a window.
- A duplicate launch that arrives before the first window is ready records a pending focus and applies it after `ready-to-show`.
- `createMainWindow` returns the existing live `mainWindow`, preventing a second owned workspace window through the normal creation path.
- The second-instance listener is removed idempotently during `will-quit`.
- Focused tests cover lock delegation, early quit behavior, restore/show/focus ordering, listener forwarding, and listener cleanup.
- The pre-existing packaged process was observed read-only with `ps -p 34152 ...`; PID `34152` remained the existing Fluely process. It was never signaled or modified.

## Navigation and onboarding evidence

- `src/shared/workspace-view.ts` defines `WorkspaceView = "settings" | "work"`, `initialWorkspaceView`, `canOpenWork`, and the guarded session-only transition helper.
- First launch (`setupComplete: false`) selects `settings`; configured launch selects `work`.
- Settings → Work is allowed only when setup is complete; Work → Settings is always allowed for a configured workspace; incomplete setup remains in Settings.
- `App.tsx` now owns `workspaceView` independently from `settings`. It uses one exclusive `if (view === "settings")` branch and one Work fallback, so both roots cannot be mounted by the App render.
- Work’s visible `⚙ Settings` button and configured Settings’ `Back to workspace` button update only local workspace view state. They do not call `settings.update` or `window:set-mode`.
- Successful setup still persists `setupComplete: true` as onboarding completion, then enters Work locally. Failed validation/save stays in Settings.
- Queue, analysis, and conversation-related App state remain outside the view branch, so switching Settings/Work does not erase those main-renderer snapshots.
- The repository has no DOM renderer/test-library harness. The real pure state module is covered by five focused navigation/onboarding tests, including an assertion that navigation leaves the persisted onboarding value unchanged.

## Timeout-copy compatibility decision

- The old editable `Request timeout` input, validation, and generated `timeoutMs` patch were removed from `SetupView`.
- The Settings UI now states the fixed policy: startup `120,000 ms`, idle `120,000 ms`, hard ceiling `600,000 ms`, and that the limits are not user-configurable. It also explains that progress refreshes idle liveness while the hard ceiling never resets.
- The persisted `codex.timeoutMs` field remains in the shared settings shape and settings normalization for legacy compatibility. Because SetupView omits it from its update patch, an existing stored value is preserved rather than rewritten; no renderer copy promises that it controls the runtime hard stop.
- Task 1’s fixed runtime deadline implementation was not changed. The timeout-policy copy is covered by a focused test that requires all three values and rejects user-configurable wording.

## Changed paths

- `electron/main.ts`
- `electron/services/application-instance.ts`
- `electron/services/__tests__/application-instance.test.mjs`
- `src/shared/workspace-view.ts`
- `src/shared/__tests__/workspace-view.test.mjs`
- `src/renderer/App.tsx`
- `src/renderer/components/SetupView.tsx`
- `src/renderer/components/WorkView.tsx`
- `src/renderer/styles.css`
- `.superpowers/sdd/2026-08-31-desktop-shared-session-foundation/task-2-report.md`

No Codex/provider files were changed. No unrelated files were staged.

## Verification

```text
$ npm run build:electron && node --test electron/services/__tests__/application-instance.test.mjs src/shared/__tests__/workspace-view.test.mjs
exit 0; 9 passed, 0 failed

$ npm test
exit 0; 174 passed, 0 failed, 0 cancelled

$ npm run typecheck
exit 0

$ npm run build
exit 0; Vite transformed 34 modules; renderer and Electron builds completed

$ git diff --check
exit 0; no whitespace errors
```

## Commit

Required commit message: `fix: unify workspace window navigation`

## Concerns and explicit skips

1. The actual packaged app was not launched and no user gate was awaited, per the explicit Task 2 override. Unit/build evidence covers the lifecycle logic, but OS-level single-instance behavior remains for the combined post-Task-3 launch.
2. The pre-existing combined build spinner/no-visible-output issue remains an integration blocker. This task did not expand into Codex/provider changes because no deterministic cause was exposed by the navigation changes.
3. The legacy `window:set-mode` IPC compatibility channel remains registered and tested, but the renderer no longer uses it for navigation. A future IPC cleanup can remove that compatibility surface once callers no longer require it.
