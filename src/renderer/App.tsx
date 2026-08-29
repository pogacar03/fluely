import { useEffect, useState } from "react";
import { subscribeToScreenshotState } from "../shared/ipc";
import type {
  FluelySettings,
  IpcError,
  IpcResult,
  ScreenshotState,
  ShortcutAction,
  ShortcutStatus,
} from "../shared/ipc";

const shortcutRows: Array<{ action: ShortcutAction; label: string; fallback: string }> = [
  { action: "toggleVisibility", label: "Show / hide", fallback: "⌘ B" },
  { action: "captureScreenshot", label: "Capture screenshot", fallback: "⌘ ⇧ 8" },
  { action: "analyzeQueue", label: "Analyze queue", fallback: "⌘ Enter" },
  { action: "captureAndAnalyze", label: "Capture and analyze", fallback: "⌘ ⇧ Enter" },
  { action: "cancelAndClear", label: "Cancel / clear", fallback: "⌘ R" },
];

function getError<T>(result: IpcResult<T>): IpcError | null {
  return result.ok ? null : result.error;
}

function getShortcutEntry(status: ShortcutStatus | null, action: ShortcutAction) {
  return status?.entries.find((entry) => entry.action === action);
}

function permissionLabel(permission: ScreenshotState["permission"]): string {
  switch (permission) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "restricted":
      return "Restricted";
    case "not-determined":
      return "Needs permission";
    default:
      return "Unavailable";
  }
}

export function App() {
  const [settings, setSettings] = useState<FluelySettings | null>(null);
  const [draft, setDraft] = useState<FluelySettings | null>(null);
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus | null>(null);
  const [screenshotState, setScreenshotState] = useState<ScreenshotState | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [busy, setBusy] = useState(true);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;

    async function refreshScreenshotState() {
      const result = await window.fluely.screenshots.get();
      if (result.ok) {
        setScreenshotState(result.value);
      } else {
        setNotice({ tone: "error", text: `${result.error.message} ${result.error.action}` });
      }
    }

    Promise.all([
      window.fluely.settings.get(),
      window.fluely.shortcuts.get(),
      window.fluely.app.getStatus(),
      window.fluely.screenshots.get(),
    ]).then(([settingsResult, shortcutsResult, appResult, screenshotsResult]) => {
      if (!active) {
        return;
      }

      const error = getError(settingsResult) ?? getError(shortcutsResult) ?? getError(appResult) ?? getError(screenshotsResult);
      if (error) {
        setNotice({ tone: "error", text: `${error.message} ${error.action}` });
      } else {
        if (settingsResult.ok) {
          setSettings(settingsResult.value);
          setDraft(settingsResult.value);
        }
        if (shortcutsResult.ok) {
          setShortcutStatus(shortcutsResult.value);
        }
        if (appResult.ok) {
          setAppVersion(appResult.value.version);
        }
        if (screenshotsResult.ok) {
          setScreenshotState(screenshotsResult.value);
        }
      }
      setBusy(false);
    }).catch(() => {
      if (active) {
        setNotice({
          tone: "error",
          text: "Fluely could not connect to its main process. Restart the app and try again.",
        });
        setBusy(false);
      }
    });

    const refreshOnFocus = () => {
      void refreshScreenshotState().catch(() => {
        if (active) {
          setNotice({
            tone: "error",
            text: "Fluely could not refresh its screenshot queue. Restart the app and try again.",
          });
        }
      });
    };
    window.addEventListener("focus", refreshOnFocus);
    const unsubscribeScreenshotState = subscribeToScreenshotState(
      window.fluely.screenshots,
      (state) => setScreenshotState(state),
      () => active,
    );

    return () => {
      active = false;
      window.removeEventListener("focus", refreshOnFocus);
      unsubscribeScreenshotState();
    };
  }, []);

  async function captureScreenshot() {
    setScreenshotBusy(true);
    try {
      const result = await window.fluely.screenshots.capture();
      if (result.ok) {
        setNotice({
          tone: "success",
          text: `Captured ${result.value.width} × ${result.value.height} captured pixels.`,
        });
      } else {
        setNotice({ tone: "error", text: `${result.error.message} ${result.error.action}` });
      }
    } catch {
      setNotice({
        tone: "error",
        text: "Fluely could not capture the display. Restart the app and try again.",
      });
    } finally {
      try {
        const refreshed = await window.fluely.screenshots.get();
        if (refreshed.ok) {
          setScreenshotState(refreshed.value);
        }
      } catch {
        setNotice({
          tone: "error",
          text: "Fluely could not refresh its screenshot queue. Restart the app and try again.",
        });
      }
      setScreenshotBusy(false);
    }
  }

  async function clearScreenshots() {
    setScreenshotBusy(true);
    try {
      const result = await window.fluely.screenshots.clear();
      if (result.ok) {
        setScreenshotState(result.value);
        setNotice({ tone: "success", text: "Screenshot queue cleared." });
      } else {
        setNotice({ tone: "error", text: `${result.error.message} ${result.error.action}` });
      }
    } catch {
      setNotice({
        tone: "error",
        text: "Fluely could not clear its screenshot queue. Restart the app and try again.",
      });
    } finally {
      try {
        const refreshed = await window.fluely.screenshots.get();
        if (refreshed.ok) {
          setScreenshotState(refreshed.value);
        }
      } catch {
        setNotice({
          tone: "error",
          text: "Fluely could not refresh its screenshot queue. Restart the app and try again.",
        });
      }
      setScreenshotBusy(false);
    }
  }

  function updateShortcut(action: ShortcutAction, value: string) {
    setDraft((current) => current ? {
      ...current,
      shortcuts: { ...current.shortcuts, [action]: value },
    } : current);
  }

  async function saveSettings() {
    if (!draft) {
      return;
    }

    setBusy(true);
    const result = await window.fluely.settings.update({
      shortcuts: draft.shortcuts,
      window: draft.window,
    });
    if (result.ok) {
      setSettings(result.value);
      setDraft(result.value);
      const shortcutsResult = await window.fluely.shortcuts.get();
      if (shortcutsResult.ok) {
        setShortcutStatus(shortcutsResult.value);
      }
      setNotice({ tone: "success", text: "Settings saved locally." });
    } else {
      setNotice({ tone: "error", text: `${result.error.message} ${result.error.action}` });
    }
    setBusy(false);
  }

  async function resetSettings() {
    setBusy(true);
    const result = await window.fluely.settings.reset();
    if (result.ok) {
      setSettings(result.value);
      setDraft(result.value);
      const shortcutsResult = await window.fluely.shortcuts.get();
      if (shortcutsResult.ok) {
        setShortcutStatus(shortcutsResult.value);
      }
      setNotice({ tone: "success", text: "Defaults restored." });
    } else {
      setNotice({ tone: "error", text: `${result.error.message} ${result.error.action}` });
    }
    setBusy(false);
  }

  const activeSettings = draft ?? settings;
  const newestScreenshot = screenshotState?.items.at(-1);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">PRIVATE DESKTOP COPILOT</p>
            <h1>Fluely</h1>
          </div>
        </div>
        <div className="status-pill">
          <span className="status-dot" />
          {busy ? "Syncing" : "Foundation online"}
        </div>
      </header>

      <section className="hero-card" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow accent">MILESTONE 01 / FOUNDATION</p>
          <h2 id="hero-title">Stay in the flow.</h2>
          <p className="hero-description">
            Fluely is being rebuilt around a shorter path from what is on your
            screen to a useful answer. Capture context, ask clearly, and keep
            moving.
          </p>
          <div className="hero-actions">
            <span className="build-chip">v{appVersion} · local preview</span>
            <span className="muted-note">Capture protection and queue are local.</span>
          </div>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit orbit-large" />
          <div className="orbit orbit-small" />
          <div className="orbit-core">
            <div className="core-spark" />
          </div>
        </div>
      </section>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          <span>{notice.tone === "success" ? "✓" : "!"}</span>
          {notice.text}
        </div>
      )}

      <div className="content-grid">
        <section className="panel" aria-labelledby="shortcuts-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CONTROL SURFACE</p>
              <h3 id="shortcuts-title">Shortcuts</h3>
            </div>
            <span className="panel-count">{String(shortcutRows.length).padStart(2, "0")}</span>
          </div>
          <div className="shortcut-list">
            {shortcutRows.map(({ action, label, fallback }) => {
              const entry = getShortcutEntry(shortcutStatus, action);
              const value = activeSettings?.shortcuts[action] ?? fallback;
              return (
                <label className="shortcut-row" key={action}>
                  <span className="shortcut-label">
                    <span>{label}</span>
                    <small className={entry?.available === false ? "unavailable" : ""}>
                      {entry?.message ?? "Waiting for main process"}
                    </small>
                  </span>
                  <input
                    aria-label={`${label} shortcut`}
                    value={value}
                    onChange={(event) => updateShortcut(action, event.target.value)}
                    spellCheck={false}
                  />
                </label>
              );
            })}
          </div>
        </section>

        <section className="panel" aria-labelledby="status-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">RUNTIME</p>
              <h3 id="status-title">System status</h3>
            </div>
            <span className="status-label">{busy ? "SYNC" : "READY"}</span>
          </div>
          <div className="status-list">
            <div className="status-row">
              <span>Secure IPC boundary</span>
              <span className="status-value ready">Active</span>
            </div>
            <div className="status-row">
              <span>Local settings</span>
              <span className="status-value ready">{settings ? "Ready" : "Loading"}</span>
            </div>
            <div className="status-row">
              <span>AI provider</span>
              <span className="status-value pending">Not configured</span>
            </div>
            <div className="status-row">
              <span>Capture protection</span>
              <span className={`status-value ${activeSettings?.privacy.captureProtection ? "ready" : "pending"}`}>
                {activeSettings?.privacy.captureProtection ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="status-row">
              <span>Screen Recording</span>
              <span className={`status-value ${screenshotState?.permission === "granted" ? "ready" : "pending"}`}>
                {screenshotState ? permissionLabel(screenshotState.permission) : "Loading"}
              </span>
            </div>
            <div className="status-row">
              <span>Screenshot queue</span>
              <span className="status-value ready">
                {screenshotState?.items.length ?? 0} / 5
              </span>
            </div>
          </div>

          <div className="settings-block">
            <div className="settings-block-heading">
              <span>Window footprint</span>
              <span>px</span>
            </div>
            <div className="dimension-grid">
              <label>
                Width
                <input
                  type="number"
                  min="480"
                  max="1600"
                  value={activeSettings?.window.width ?? 960}
                  onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    window: { ...current.window, width: Number(event.target.value) },
                  } : current)}
                />
              </label>
              <label>
                Height
                <input
                  type="number"
                  min="360"
                  max="1400"
                  value={activeSettings?.window.height ?? 720}
                  onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    window: { ...current.window, height: Number(event.target.value) },
                  } : current)}
                />
              </label>
            </div>
          </div>

          <div className="settings-block screenshot-block">
            <div className="settings-block-heading">
              <span>Background screenshots</span>
              <span>{newestScreenshot ? `${newestScreenshot.width} × ${newestScreenshot.height}` : "No captures"}</span>
            </div>
            <p className="settings-help">
              Captures the display nearest the pointer while Fluely stays out of the frame.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void clearScreenshots()}
                disabled={busy || screenshotBusy || !screenshotState?.items.length}
              >
                Clear queue
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void captureScreenshot()}
                disabled={busy || screenshotBusy || screenshotState?.capturing === true}
              >
                {screenshotState?.capturing || screenshotBusy ? "Capturing…" : "Capture"}
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={() => void resetSettings()} disabled={busy}>
              Reset
            </button>
            <button type="button" className="primary-button" onClick={() => void saveSettings()} disabled={busy || !draft}>
              Save settings
            </button>
          </div>
        </section>
      </div>

      <footer className="footer-note">
        <span>Built for clarity, speed, and control.</span>
        <span>FLUELY / LOCAL FIRST</span>
      </footer>
    </main>
  );
}
