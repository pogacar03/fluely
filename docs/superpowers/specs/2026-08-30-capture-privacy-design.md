# Fluely Capture Privacy and Background Screenshot Design

**Status:** Approved for implementation by the user on 2026-08-30

## Goal

Add the capture-related privacy behavior currently missing from Fluely: protect its window through the operating-system-supported Electron API, keep it out of its own screenshots, and let the existing global shortcut capture the active display without bringing Fluely to the foreground.

## Product Boundary

This feature uses documented operating-system and Electron capabilities. It does not attempt to bypass proctoring, endpoint-security, recording-detection, or user-consent mechanisms. macOS Screen Recording permission remains mandatory and errors must tell the user how to grant it.

`BrowserWindow.setContentProtection(true)` is best-effort on macOS. Electron documents that ScreenCaptureKit-based applications can still capture a protected window. The UI and documentation must therefore call this “capture protection,” not promise universal invisibility.

## Natively Behavior Being Ported

The local Natively build uses four distinct mechanisms:

1. It calls `setContentProtection(true)` for each live window.
2. It reapplies protection after window shows and macOS activation-policy/Dock transitions.
3. Before taking a screenshot, it snapshots window visibility, hides its own windows, waits for the compositor, captures through `desktopCapturer`, and restores the previous state without stealing focus.
4. It serializes screenshot operations and keeps a bounded on-disk queue.

Native non-activating panel attributes, global keyboard interception, application disguise, and monitoring-evasion behavior are not part of this feature.

## Architecture

### Capture protection

`CapturePrivacyController` owns the privacy state for the main `BrowserWindow`. It applies `setContentProtection`, hides the window from Mission Control on macOS, and reapplies protection when the window is shown. It exposes an explicit reassert operation for lifecycle transitions. The controller must degrade safely on platforms where a method is unavailable.

Fluely’s current macOS-first package will keep capture protection enabled by default. The setting is persisted as `privacy.captureProtection`. This release does not hide the application process or impersonate another application.

### Background screenshots

`ScreenshotService` owns the screenshot directory, capture serialization, queue metadata, and cleanup. It captures the display nearest the pointer with `desktopCapturer.getSources({ types: ['screen'] })`, matching sources by `display_id`. It writes PNG files below `app.getPath('userData')/screenshots` and retains at most five items.

The service receives platform adapters so pure behavior is testable without launching Electron. Renderer-facing values contain an opaque ID, timestamp, dimensions, and count; no arbitrary filesystem path is exposed.

### Capture session

The main process wraps every capture in a session:

1. reject a second capture while one is active;
2. remember whether the Fluely window was visible;
3. hide the window if necessary;
4. wait 80 ms on macOS and 40 ms elsewhere;
5. capture the selected display;
6. restore the window with `showInactive()` on macOS when it was previously visible;
7. restore state in `finally`, including failure paths.

This hiding step is what keeps Fluely out of its own screenshots even where macOS ignores content protection.

### IPC and shortcuts

The preload exposes a narrow `screenshots` group:

- `get()` returns queue metadata;
- `capture()` captures once;
- `delete(id)` removes one known queue item;
- `clear()` removes the queue.

The existing `captureScreenshot` shortcut invokes the same capture path. `cancelAndClear` clears the queue. Analysis shortcuts remain unavailable until a provider exists.

### Renderer

The existing status panel displays capture-protection state, screen-capture permission state, queue count, and the most recent capture dimensions. It provides explicit Capture and Clear buttons. Shortcut-triggered captures update main-process state; the renderer refreshes when focused and after its own actions. No screenshot pixels or local paths are placed in the DOM in this slice.

## Error Handling

- `denied`, `restricted`, and `not-determined` macOS permission states return distinct actionable errors.
- Source enumeration has a five-second timeout.
- An empty source list or unmatched display returns a stable capture error.
- Writes use a temporary file followed by rename.
- Capture restoration runs in `finally`.
- Queue deletion is restricted to IDs created by `ScreenshotService`.
- Shortcut-triggered errors are logged without crashing the main process.

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
- macOS permission failures are actionable and no permission bypass is attempted.
- The renderer never receives screenshot filesystem paths.
- At most five screenshots remain in the managed directory.
- `npm run typecheck`, `npm test`, and `npm run build` pass.

