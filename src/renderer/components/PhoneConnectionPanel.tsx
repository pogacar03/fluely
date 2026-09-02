import { useEffect, useState } from "react";
import type { PhoneGatewayStatus } from "../../shared/ipc";

export interface PhoneConnectionPanelProps {
  status: PhoneGatewayStatus | null;
  busy?: boolean;
  onEnable: () => Promise<void> | void;
  onDisable: () => Promise<void> | void;
  onRegeneratePairing: () => Promise<void> | void;
}

const SAFE_ERROR_COPY: Record<Extract<PhoneGatewayStatus, { state: "error" }>['code'], string> = {
  no_lan_address: "No private LAN address is available.",
  port_unavailable: "No gateway port is available.",
  start_failed: "Phone companion could not start.",
};

function formatPairingExpiry(remainingMs: number): string {
  if (remainingMs <= 0) {
    return "Pairing code expired. Generate a new code to continue.";
  }
  const seconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `Expires in ${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function statusLabel(status: PhoneGatewayStatus | null): string {
  if (!status) {
    return "Checking phone companion";
  }
  if (status.state === "starting") {
    return "Starting phone companion";
  }
  if (status.state === "ready") {
    return status.paired ? "Phone paired" : "Ready to pair a phone";
  }
  if (status.state === "error") {
    return "Phone companion needs attention";
  }
  return "Phone companion is off";
}

export function PhoneConnectionPanel({
  status,
  busy = false,
  onEnable,
  onDisable,
  onRegeneratePairing,
}: PhoneConnectionPanelProps) {
  const [now, setNow] = useState(() => Date.now());
  const readyExpiry = status?.state === "ready" ? status.pairingExpiresAt : 0;

  useEffect(() => {
    setNow(Date.now());
    if (status?.state !== "ready") {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status?.state, readyExpiry]);

  const isReady = status?.state === "ready";
  const remainingMs = isReady ? status.pairingExpiresAt - now : 0;
  const pairingActive = isReady && remainingMs > 0 && status.qrDataUrl.length > 0;

  return (
    <section className="phone-panel" aria-labelledby="phone-panel-title">
      <div className="phone-panel-heading">
        <div>
          <p className="eyebrow accent">PHONE COMPANION</p>
          <h3 id="phone-panel-title">Connect a phone on your LAN</h3>
          <p className="phone-panel-intro">
            Pair one phone to view the same Fluely session. The gateway is off until you explicitly start it.
          </p>
        </div>
        <div className={`phone-panel-status ${isReady ? "ready" : status?.state === "error" ? "error" : ""}`} role="status">
          <span className="connection-dot" />
          <span>{statusLabel(status)}</span>
        </div>
      </div>

      <div className="phone-lan-warning" role="note">
        <span className="phone-lan-warning-icon" aria-hidden="true">!</span>
        <span>LAN HTTP is unencrypted. Use Phone Companion only on a trusted local network; it is not internet-safe.</span>
      </div>

      {status?.state === "ready" && (
        <div className="phone-ready-grid">
          <div className="phone-qr-card">
            {pairingActive ? (
              <img className="phone-qr" src={status.qrDataUrl} alt="Scan to pair your phone" />
            ) : (
              <div className="phone-qr-expired" role="status">Pairing code expired</div>
            )}
            <span className="phone-expiry">{formatPairingExpiry(remainingMs)}</span>
          </div>
          <div className="phone-pairing-details">
            <span className="field-label">LAN address</span>
            <code className="phone-origin">{status.origin}</code>
            <span className="field-help">Scan the QR code or enter this URL on the phone.</span>
            <span className={`phone-paired-indicator ${status.paired ? "paired" : ""}`}>
              <span aria-hidden="true">{status.paired ? "✓" : "○"}</span>
              {status.paired ? "Paired phone connected" : "No phone paired yet"}
            </span>
            <div className="phone-panel-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onRegeneratePairing()}
                disabled={busy}
              >
                Regenerate pairing
              </button>
              <button
                type="button"
                className="secondary-button phone-disable-button"
                onClick={() => void onDisable()}
                disabled={busy}
              >
                Disable and revoke
              </button>
            </div>
          </div>
        </div>
      )}

      {status?.state === "error" && (
        <p className="phone-panel-error" role="alert">{SAFE_ERROR_COPY[status.code]}</p>
      )}

      {status?.state !== "ready" && (
        <div className="phone-panel-footer">
          <span className="field-help">
            {status?.state === "starting" ? "Opening the local listener…" : "No pairing QR or credential is available while the gateway is off."}
          </span>
          <button
            type="button"
            className="primary-button"
            onClick={() => void onEnable()}
            disabled={busy || status?.state === "starting"}
          >
            {status?.state === "error" ? "Try again" : "Start phone companion on LAN"}
          </button>
        </div>
      )}
    </section>
  );
}

export { formatPairingExpiry };
