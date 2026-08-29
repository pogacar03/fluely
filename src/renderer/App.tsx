const shortcutRows = [
  ["Show / hide", "⌘ B"],
  ["Capture screenshot", "⌘ ⇧ 8"],
  ["Analyze queue", "⌘ Enter"],
];

export function App() {
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
          Foundation online
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
            <span className="build-chip">v0.1.0 · local preview</span>
            <span className="muted-note">Capture and providers are next.</span>
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

      <div className="content-grid">
        <section className="panel" aria-labelledby="shortcuts-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CONTROL SURFACE</p>
              <h3 id="shortcuts-title">Shortcuts</h3>
            </div>
            <span className="panel-count">03</span>
          </div>
          <div className="shortcut-list">
            {shortcutRows.map(([label, shortcut]) => (
              <div className="shortcut-row" key={label}>
                <span>{label}</span>
                <kbd>{shortcut}</kbd>
              </div>
            ))}
          </div>
        </section>

        <section className="panel" aria-labelledby="status-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">RUNTIME</p>
              <h3 id="status-title">System status</h3>
            </div>
            <span className="status-label">READY</span>
          </div>
          <div className="status-list">
            <div className="status-row">
              <span>Secure IPC boundary</span>
              <span className="status-value ready">Active</span>
            </div>
            <div className="status-row">
              <span>Local settings</span>
              <span className="status-value ready">Ready</span>
            </div>
            <div className="status-row">
              <span>AI provider</span>
              <span className="status-value pending">Not configured</span>
            </div>
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
