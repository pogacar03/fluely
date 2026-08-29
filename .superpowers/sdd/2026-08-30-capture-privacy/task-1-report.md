# Task 1: Capture privacy and background screenshots

## Status

Implemented and verified on the Linux build host from baseline `8e999ede590b4de2ad22935300d10d7b85fcead9`.

## RED evidence

Tests were added before each production slice and run against the missing or incomplete behavior.

- `npm test -- --test-name-pattern='capture protection'` initially failed because `dist-electron/electron/services/CapturePrivacyController.js` did not exist; the other 20 baseline tests passed.
- `npm test -- --test-name-pattern='screenshot session'` initially failed because `dist-electron/electron/services/screenshot-session.js` did not exist; the other 25 loaded tests passed.
- `npm test -- --test-name-pattern='ScreenshotService'` initially failed because `dist-electron/electron/services/ScreenshotService.js` did not exist; after the first implementation, five service cases exposed the non-Darwin permission-gate bug. The gate was corrected so `unavailable` is informational off macOS and a failure only on Darwin.
- The first contracts run failed on the missing screenshots preload/IPC groups, missing privacy defaults/validation, and strict-ID handler. The first shortcuts run failed because `captureScreenshot` and `cancelAndClear` were still marked placeholders.
- The reset lifecycle test then failed with an empty privacy-application log until `settings:reset` was wired to reapply the returned privacy setting.

## GREEN evidence

- Capture-protection focused behavior: 5/5 passing.
- Screenshot-session focused behavior: 6/6 passing.
- ScreenshotService focused behavior: 7/7 passing, including permission mapping, timeout, display matching, atomic persistence, five-item eviction, opaque-ID deletion, clear, and error cleanup.
- IPC/settings/shortcut focused behavior: 43/43 passing in the final full test run.

## Implementation

- Added `CapturePrivacyController` with immediate protection, Darwin Mission Control hiding, show-time reassertion, destroyed-window guards, and listener disposal.
- Added `runScreenshotSession` with process-local capture serialization, 80 ms Darwin / 40 ms other-platform compositor waits, visibility restoration in `finally`, and macOS `showInactive()` restoration.
- Added `ScreenshotService` with injected desktop/display/permission adapters, five-second source timeout, nearest-cursor display selection by `display_id`, PNG temp-file rename, opaque `randomUUID()` IDs, bounded five-item queue, deletion allowlist, and stable capture errors.
- Added typed privacy/screenshot IPC contracts, settings normalization and validation, four narrow preload methods, strict UUID-shaped ID validation, and screenshot handlers.
- Activated capture and cancel/clear shortcuts, caught and logged shortcut failures, loaded settings before window creation, applied protection at construction, and disposed lifecycle services on shutdown.
- Added renderer status rows and Capture/Clear controls that expose only permission, protection, queue count, timestamps/dimensions, never paths or bytes.
- Documented background capture, Screen Recording permission, best-effort content protection, and the ScreenCaptureKit limitation in `README.md`.

## Files

Created:

- `electron/services/CapturePrivacyController.ts`
- `electron/services/ScreenshotService.ts`
- `electron/services/screenshot-session.ts`
- `electron/services/__tests__/CapturePrivacyController.test.mjs`
- `electron/services/__tests__/ScreenshotService.test.mjs`
- `electron/services/__tests__/screenshot-session.test.mjs`

Modified:

- `src/shared/ipc.ts`
- `electron/services/settings-core.ts`
- `electron/services/ShortcutManager.ts`
- `electron/services/ipcHandlers.ts`
- `electron/preload.ts`
- `electron/preloadBridge.ts`
- `electron/main.ts`
- `src/renderer/App.tsx`
- `src/renderer/styles.css`
- `electron/services/__tests__/ShortcutManager.test.mjs`
- `electron/services/__tests__/ipc-contract.test.mjs`
- `electron/services/__tests__/settings-core.test.mjs`
- `README.md`

## Complete verification

The final verification commands were run after the implementation stabilized:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass: renderer and Electron TypeScript checks completed with exit 0 |
| `npm test` | Pass: 43/43 tests, 0 failures |
| `npm run build` | Pass: Vite renderer build and Electron build completed with exit 0 |
| `npm run package:dir` | Pass: generated `release/mac-arm64/Fluely.app` |
| `node scripts/check-package-allowlist.mjs` | Pass: packaged ASAR contains no test/source-map/env files |
| `git diff --check` | Run after this report is written; must remain clean before commit |

No runtime dependency was added. The package configuration continues to allowlist only the built application assets and `package.json`.

## Self-review

- The default shortcut `CommandOrControl+Shift+8` uses the display nearest the pointer and routes through the hide/capture/restore session.
- A visible window is restored without activation on macOS; an initially hidden window is never shown.
- Capture protection defaults to `true`, applies immediately, and is reapplied on `show` and app activation.
- macOS denied, restricted, and not-determined states have distinct actionable errors; no permission prompt or bypass is attempted.
- Renderer IPC contains no filesystem path or image-byte field; screenshot deletion is restricted to IDs created by the service.
- The managed directory retains at most five queue items and writes through `<id>.png.tmp` followed by rename.
- Documentation does not make a universal invisibility claim and explicitly states the ScreenCaptureKit limitation.

## Remaining manual macOS validation

The Linux host cannot validate live macOS compositor and permission behavior. On macOS, manually verify the shortcut while another application is focused, that Fluely is absent from the PNG, that restoring the window does not steal focus, and that supported capture tools honor content protection where the OS permits it. Also validate the documented ScreenCaptureKit limitation rather than treating it as a passing guarantee. The directory package emitted environment warnings about the default Electron icon and unavailable valid Developer ID signing; release signing and final artwork remain deployment work.
