# Fluely Capture Privacy and Background Screenshot Design

**Status:** Approved for implementation by the user on 2026-08-30

## Goal

Add the capture-related privacy behavior currently missing from Fluely: protect its window through the operating-system-supported Electron API, keep it out of its own screenshots, and let the existing global shortcut capture the active display without bringing Fluely to the foreground.

## Product Boundary

This feature uses documented operating-system and Electron capabilities. It does not attempt to bypass proctoring, endpoint-security, recording-detection, or user-consent mechanisms. macOS Screen Recording permission remains mandatory. The first capture may display the macOS system authorization dialog; Fluely cannot bypass or suppress that consent flow, and errors must tell the user how to grant permission.

`BrowserWindow.setContentProtection(true)` is best-effort on macOS. Electron documents that ScreenCaptureKit-based applications can still capture a protected window. The UI and documentation must therefore call this “capture protection,” not promise universal invisibility.

## Natively Behavior Being Ported

The local Natively build uses five distinct mechanisms:

1. It calls `setContentProtection(true)` for each live window.
2. It reapplies protection after window shows and macOS activation-policy/Dock transitions.
3. When capture protection is enabled on Darwin, it asks the public Electron `app.dock.hide()` API to hide the Dock; disabling the policy calls `app.dock.show()` to restore it.
4. Before taking a screenshot, it snapshots window visibility, hides its own windows, waits for the compositor, captures through `desktopCapturer`, and restores the previous state without stealing focus. A session-active gate prevents visibility toggles from showing the window until restoration completes.
5. It serializes screenshot operations and keeps a bounded session-scoped on-disk queue.

Native non-activating panel attributes, global keyboard interception, application disguise, and monitoring-evasion behavior are not part of this feature.

## Architecture

### Capture protection

`CapturePrivacyController` owns the privacy state for the main `BrowserWindow`. It applies `setContentProtection`, hides the window from Mission Control on macOS, and reapplies protection when the window is shown. On Darwin it delegates Dock changes to one shared public `DockPrivacyCoordinator`, whose serialized `setHidden(boolean)` operations are latest-intent ordered; each controller records whether it owns a hide request, so disposal only releases its own hide. A current-generation Dock settle reasserts content protection. The controller must degrade safely on platforms where a method is unavailable.

Fluely’s current macOS-first package will keep capture protection enabled by default. The setting is persisted as `privacy.captureProtection`. This release does not hide the application process or impersonate another application.

### Background screenshots

`ScreenshotService` owns the screenshot directory, capture serialization, queue metadata, and cleanup. It captures the display nearest the pointer with `desktopCapturer.getSources({ types: ['screen'] })`, matching sources by `display_id`. The adapter supplies display bounds and `scaleFactor`; `thumbnailSize` is `round(bounds × scaleFactor)` in native captured pixels. It writes PNG files below `app.getPath('userData')/screenshots` and retains at most five items.

The queue is session-scoped rather than a persisted manifest. During initialization the service removes only orphan files whose names are strict UUID `<id>.png` or `<id>.png.tmp` forms; `clear` repeats that managed-file cleanup. Other files in the directory are never touched. Capture, delete, clear, and eviction share one mutation serialization, and every mutation waits for initialization. A timed-out native source request remains the active gate until its underlying Promise settles, because Electron's `desktopCapturer` API has no `AbortSignal`.

The service receives platform adapters so pure behavior is testable without launching Electron, including a focused filesystem adapter (defaulting to `node:fs/promises`) for atomic-write ordering tests. Renderer-facing values contain an opaque ID, timestamp, dimensions, and count; no arbitrary filesystem path is exposed.

### Capture session

The main process wraps every capture in a session:

1. reject a second capture while one is active and expose the active gate to visibility toggles;
2. remember whether the Fluely window was visible;
3. hide the window if necessary;
4. wait 80 ms on macOS and 40 ms elsewhere;
5. capture the selected display;
6. restore the window with `showInactive()` on macOS when it was previously visible;
7. restore the visibility captured at session start through a once-only finalizer, including failure paths.

`ScreenshotService.whenIdle()` is the finalizer's hold promise. A five-second caller timeout does not cancel Electron's native request: the IPC caller receives the timeout error, while the session remains active and hidden until the mutation tail and late source promise settle. A never-settling native request therefore keeps the gate held and tells the user to restart. The extracted `attachWindowLifecycle` helper applies the same gate to `ready-to-show`; it never shows a window while a session is active.

The companion `attachApplicationLifecycle` helper is used by `main.ts` for `activate`: it reasserts the privacy controller and recreates the main window only when Electron reports no live windows.

This hiding step is what keeps Fluely out of its own screenshots even where macOS ignores content protection.

### IPC and shortcuts

The preload exposes a narrow `screenshots` group plus one state subscription:

- `get()` returns queue metadata;
- `capture()` captures once;
- `delete(id)` removes one known queue item;
- `clear()` removes the queue.
- `onStateChanged(listener)` subscribes to complete `ScreenshotState` snapshots and returns an unsubscribe function. It does not expose paths, bytes, or a generic event bridge.

The existing `captureScreenshot` shortcut invokes the same capture path. `cancelAndClear` clears the queue. Analysis shortcuts remain unavailable until a provider exists.

### Renderer

The existing status panel displays capture-protection state, screen-capture permission state, queue count, and the most recent capture dimensions. It provides explicit Capture and Clear buttons. Main sends complete state snapshots after capture/delete/clear transitions, including failures and the final state of a pending operation; the renderer subscribes and still refreshes when focused and after its own actions. No screenshot pixels or local paths are placed in the DOM in this slice.

## Error Handling

- `denied` and `restricted` states return distinct actionable errors. `not-determined` is allowed through the first protected `getSources()` call so macOS can register consent; after a failure the service rereads the status and maps the resulting state explicitly.
- Darwin permission is reread after `getSources()` resolves and before `thumbnail.toPNG()` or persistence. A transition from `granted` to a non-granted state therefore produces the current actionable permission error and no PNG; native rejection and timeout paths likewise map the current state, while an initial `not-determined` timeout retains the first-use permission-required guidance.
- Source enumeration has a five-second caller timeout. The native Promise remains tracked until settle; while it is pending, `capturing` stays true and no second enumeration can start.
- If capture began with Darwin permission `not-determined`, that five-second caller error is `SCREEN_CAPTURE_PERMISSION_REQUIRED` with System Settings guidance; the eventual state is reread after native settlement.
- An empty source list or unmatched display returns a stable capture error.
- Writes use a temporary file followed by rename.
- Capture restoration uses a once-only finalizer; on timeout it waits for `whenIdle()` before restoring the start-of-session visibility.
- Queue deletion is restricted to IDs created by `ScreenshotService`.
- Shortcut-triggered errors are logged without crashing the main process.
- OS shortcut conflicts preserve the requested setting while exposing an unavailable status entry.
- Duplicate accelerators are rejected by settings validation before persistence. Shortcut registration catches adapter throws, best-effort rolls back the previous requested/registration state, and reports a non-active status if rollback cannot restore it. `settings:update` and `settings:reset` propagate an `applyShortcuts` `ok:false` result to the renderer rather than reporting a saved success.

## Testing

Automated tests cover:

- immediate and show-time protection application;
- screenshot capture hides and restores a previously visible window without focus theft;
- failure restores visibility and releases the concurrency lock;
- a concurrent capture is rejected;
- source selection by display ID;
- atomic PNG persistence and five-item eviction;
- opaque-ID deletion and clear;
- permission error mapping;
- IPC/preload allowlists;
- shortcut availability and invocation.
- Darwin Dock hide/show policy and reassertion;
- shared async Dock ordering, controller ownership, and rejection handling;
- session-scoped UUID orphan cleanup, shared mutation serialization, timeout gating, native Retina thumbnail sizing, atomic temp-write/rename cleanup, and state subscriptions;
- composition of shortcut → session → service → state notification, ready-to-show gating, timeout-held restoration, failure recovery, settings reset reapplication, and renderer subscription cleanup.

Manual macOS checks cover:

- capture shortcut while another application is focused;
- Fluely absent from its own screenshot;
- no foreground focus change after capture;
- supported capture tools respect content protection where the OS allows it;
- ScreenCaptureKit limitation is documented rather than reported as a passing guarantee.

## Acceptance Criteria

- `CommandOrControl+Shift+8` captures the display nearest the pointer while Fluely is hidden or in the background.
- Fluely does not appear in the PNG it creates.
- A visible Fluely window returns to the same visible state without becoming the active app on macOS.
- Capture protection is enabled by default and reapplied after show.
- On Darwin, enabled privacy policy hides the Dock through the public Electron API and disabled policy restores it.
- macOS permission failures are actionable and no permission bypass is attempted.
- The renderer never receives screenshot filesystem paths.
- At most five screenshots remain in the managed directory.
- State subscribers receive a final non-capturing snapshot after every queue mutation.
- A timed-out capture returns to IPC within five seconds but keeps the session/window gate until native settlement; a never-settling request requires restart.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
