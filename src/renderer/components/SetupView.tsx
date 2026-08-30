import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  CodexModelReasoningEffort,
  CodexStatus,
  FluelySettings,
  SettingsPatch,
} from "../../shared/ipc";

export interface SetupNotice {
  tone: "success" | "error";
  text: string;
}

export interface SetupViewProps {
  settings: FluelySettings;
  codexStatus: CodexStatus | null;
  busy?: boolean;
  notice?: SetupNotice | null;
  onStart: (settingsPatch: SettingsPatch) => Promise<void> | void;
}

interface SetupDraft {
  path: string;
  model: string;
  fastModel: string;
  timeoutMs: string;
  reasoning: CodexModelReasoningEffort;
  captureProtection: boolean;
}

type SetupErrors = Partial<Record<keyof SetupDraft, string>>;

const reasoningOptions: Array<{ value: CodexModelReasoningEffort; label: string; detail: string }> = [
  { value: "none", label: "None", detail: "Lowest latency" },
  { value: "low", label: "Low", detail: "Quick, focused" },
  { value: "medium", label: "Medium", detail: "Balanced" },
  { value: "high", label: "High", detail: "More deliberate" },
  { value: "xhigh", label: "X-high", detail: "Deep reasoning" },
  { value: "max", label: "Max", detail: "Maximum effort" },
];

function makeDraft(settings: FluelySettings): SetupDraft {
  return {
    path: settings.codex.path,
    model: settings.codex.model,
    fastModel: settings.codex.fastModel,
    timeoutMs: String(settings.codex.timeoutMs),
    reasoning: settings.codex.modelReasoningEffort ?? "medium",
    captureProtection: settings.privacy.captureProtection,
  };
}

function validateDraft(draft: SetupDraft): SetupErrors {
  const errors: SetupErrors = {};
  if (!draft.path.trim()) {
    errors.path = "Add the Codex executable path, or leave codex to use the system command.";
  }
  if (!draft.model.trim()) {
    errors.model = "Choose the model Fluely should use for full answers.";
  }
  if (!draft.fastModel.trim()) {
    errors.fastModel = "Choose a fast model for quick follow-ups.";
  }

  const timeout = Number(draft.timeoutMs);
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 600_000) {
    errors.timeoutMs = "Use a timeout between 1,000 ms and 600,000 ms.";
  }

  // The status shown above can be stale (for example, Codex may have been
  // installed while this card was open). The App validates the current path
  // immediately before saving, so an unavailable health check should not trap
  // the user on this form.
  return errors;
}

function statusCopy(codexStatus: CodexStatus | null): { label: string; detail: string; tone: "ready" | "pending" | "error" } {
  if (!codexStatus) {
    return {
      label: "Checking for Codex",
      detail: "Looking for a local Codex CLI installation…",
      tone: "pending",
    };
  }
  if (codexStatus.available) {
    return {
      label: "Codex is ready",
      detail: codexStatus.resolvedPath
        ? `Using ${codexStatus.resolvedPath}`
        : `Using ${codexStatus.configuredPath}`,
      tone: "ready",
    };
  }
  return {
    label: "Codex needs attention",
    detail: codexStatus.error
      ? `${codexStatus.error.message} ${codexStatus.error.action}`
      : `Fluely could not find ${codexStatus.configuredPath}.`,
    tone: "error",
  };
}

export function SetupView({ settings, codexStatus, busy = false, notice, onStart }: SetupViewProps) {
  const [draft, setDraft] = useState<SetupDraft>(() => makeDraft(settings));
  const [errors, setErrors] = useState<SetupErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const status = useMemo(() => statusCopy(codexStatus), [codexStatus]);

  useEffect(() => {
    setDraft(makeDraft(settings));
    setErrors({});
  }, [settings]);

  function updateDraft<Key extends keyof SetupDraft>(key: Key, value: SetupDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || busy || submitting) {
      return;
    }

    setSubmitting(true);
    try {
      await onStart({
        setupComplete: true,
        privacy: { captureProtection: draft.captureProtection },
        codex: {
          enabled: true,
          path: draft.path.trim(),
          model: draft.model.trim(),
          fastModel: draft.fastModel.trim(),
          timeoutMs: Number(draft.timeoutMs),
          sandboxMode: "read-only",
          modelReasoningEffort: draft.reasoning,
        },
      });
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = busy || submitting;
  return (
    <main className="setup-shell" aria-busy={disabled}>
      <div className="setup-glow setup-glow-one" aria-hidden="true" />
      <div className="setup-glow setup-glow-two" aria-hidden="true" />

      <header className="setup-topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">PRIVATE SCREEN COPILOT</p>
            <h1>Fluely</h1>
          </div>
        </div>
        <span className="setup-version">LOCAL FIRST · SETUP</span>
      </header>

      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-card-heading">
          <div>
            <p className="eyebrow accent">WELCOME TO FLUELY</p>
            <h2 id="setup-title">A quieter way to ask about your screen.</h2>
            <p className="setup-intro">
              Connect your local Codex CLI once. Fluely keeps screenshots in its managed queue and sends only the context you choose.
            </p>
          </div>
          <div className="setup-orbit" aria-hidden="true">
            <div className="setup-orbit-ring setup-orbit-ring-large" />
            <div className="setup-orbit-ring setup-orbit-ring-small" />
            <div className="setup-orbit-core"><span /></div>
          </div>
        </div>

        {notice && (
          <div className={`notice ${notice.tone}`} role="status">
            <span>{notice.tone === "success" ? "✓" : "!"}</span>
            <span>{notice.text}</span>
          </div>
        )}

        <form className="setup-form" onSubmit={submit} noValidate>
          <div className="setup-section-heading">
            <div>
              <span className="section-number">01</span>
              <div>
                <h3>Connect Codex</h3>
                <p>Fluely calls your local CLI and never handles an API key.</p>
              </div>
            </div>
            <div className={`connection-status ${status.tone}`}>
              <span className="connection-dot" />
              <span>{status.label}</span>
            </div>
          </div>

          <label className="field field-wide">
            <span className="field-label">Codex executable</span>
            <span className="field-control-with-status">
              <input
                aria-label="Codex executable path"
                className={errors.path ? "has-error" : ""}
                value={draft.path}
                onChange={(event) => updateDraft("path", event.target.value)}
                placeholder="codex"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="input-trailing-icon" aria-hidden="true">⌁</span>
            </span>
            <span className={`field-help ${errors.path ? "error-text" : ""}`}>
              {errors.path ?? status.detail}
            </span>
          </label>

          <div className="field-grid">
            <label className="field">
              <span className="field-label">Primary model</span>
              <input
                aria-label="Primary Codex model"
                className={errors.model ? "has-error" : ""}
                value={draft.model}
                onChange={(event) => updateDraft("model", event.target.value)}
                placeholder="gpt-5.6-sol"
                autoComplete="off"
                spellCheck={false}
              />
              <span className={`field-help ${errors.model ? "error-text" : ""}`}>
                {errors.model ?? "Used for considered answers."}
              </span>
            </label>
            <label className="field">
              <span className="field-label">Fast model</span>
              <input
                aria-label="Fast Codex model"
                className={errors.fastModel ? "has-error" : ""}
                value={draft.fastModel}
                onChange={(event) => updateDraft("fastModel", event.target.value)}
                placeholder="gpt-5.6-luna"
                autoComplete="off"
                spellCheck={false}
              />
              <span className={`field-help ${errors.fastModel ? "error-text" : ""}`}>
                {errors.fastModel ?? "Used when speed matters."}
              </span>
            </label>
          </div>

          <div className="setup-section-heading setup-section-heading-spaced">
            <div>
              <span className="section-number">02</span>
              <div>
                <h3>Choose how Fluely thinks</h3>
                <p>These defaults stay local and can be changed later.</p>
              </div>
            </div>
          </div>

          <div className="field-grid setup-controls-grid">
            <label className="field">
              <span className="field-label">Reasoning effort</span>
              <select
                aria-label="Reasoning effort"
                value={draft.reasoning}
                onChange={(event) => updateDraft("reasoning", event.target.value as CodexModelReasoningEffort)}
              >
                {reasoningOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label} · {option.detail}
                  </option>
                ))}
              </select>
              <span className="field-help">Balanced is a good place to start.</span>
            </label>
            <label className="field">
              <span className="field-label">Request timeout</span>
              <span className="input-suffix">
                <input
                  aria-label="Codex request timeout"
                  className={errors.timeoutMs ? "has-error" : ""}
                  type="number"
                  min="1000"
                  max="600000"
                  step="1000"
                  value={draft.timeoutMs}
                  onChange={(event) => updateDraft("timeoutMs", event.target.value)}
                />
                <span>ms</span>
              </span>
              <span className={`field-help ${errors.timeoutMs ? "error-text" : ""}`}>
                {errors.timeoutMs ?? "The CLI is stopped when this limit is reached."}
              </span>
            </label>
          </div>

          <div className="privacy-row">
            <div className="privacy-icon" aria-hidden="true">◌</div>
            <div className="privacy-copy">
              <strong>Capture protection</strong>
              <span>Keep Fluely out of its own screen captures where the platform allows it.</span>
            </div>
            <button
              type="button"
              className={`switch ${draft.captureProtection ? "on" : ""}`}
              role="switch"
              aria-checked={draft.captureProtection}
              onClick={() => updateDraft("captureProtection", !draft.captureProtection)}
              disabled={disabled}
            >
              <span />
              <span className="switch-label">{draft.captureProtection ? "On" : "Off"}</span>
            </button>
          </div>

          <div className="setup-footer">
            <div className="setup-footnote">
              <span className="safe-badge">✓</span>
              <span>Local queue · read-only sandbox · no API keys in Fluely</span>
            </div>
            <button className="primary-button setup-submit" type="submit" disabled={disabled}>
              <span>{submitting ? "Checking Codex…" : "Start using Fluely"}</span>
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </section>

      <footer className="setup-bottom-note">
        <span>FLUELY / LOCAL FIRST</span>
        <span>Authentication stays in your Codex CLI session.</span>
      </footer>
    </main>
  );
}
