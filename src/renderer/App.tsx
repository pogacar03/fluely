import { useEffect, useRef, useState } from "react";
import { subscribeToAnalysisState, subscribeToScreenshotState } from "../shared/ipc";
import type {
  AnalysisState,
  CodexStatus,
  FluelySettings,
  IpcError,
  IpcResult,
  SettingsPatch,
  ScreenshotState,
} from "../shared/ipc";
import { getAnalysisScreenshotIds, getQueueIds, selectWorkspaceMode } from "../shared/workspace-state";
import { SetupView, type SetupNotice } from "./components/SetupView";
import { WorkView, type WorkAnalysisRequest } from "./components/WorkView";

function describeError(error: IpcError): string {
  return `${error.message} ${error.action}`;
}

function noticeFromResult(result: IpcResult<unknown>): SetupNotice | null {
  return result.ok ? null : { tone: "error", text: describeError(result.error) };
}

function toAnalysisState(event: AnalysisState): AnalysisState {
  return {
    status: event.status,
    text: event.text,
    model: event.model,
    screenshotIds: [...event.screenshotIds],
    startedAt: event.startedAt,
    updatedAt: event.updatedAt,
    completedAt: event.completedAt,
    ...(event.error ? { error: { ...event.error } } : {}),
  };
}

function emptyScreenshotState(): ScreenshotState {
  return { items: [], capturing: false, permission: "unavailable" };
}

function emptyAnalysisState(): AnalysisState {
  return {
    status: "idle",
    text: "",
    model: "",
    screenshotIds: [],
    startedAt: null,
    updatedAt: new Date(0).toISOString(),
    completedAt: null,
  };
}

export function App() {
  const [settings, setSettings] = useState<FluelySettings | null>(null);
  const [screenshotState, setScreenshotState] = useState<ScreenshotState | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<SetupNotice | null>(null);
  const mountedRef = useRef(true);
  const opacityRequestRef = useRef(0);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;

    async function refreshScreenshotState() {
      try {
        const result = await window.fluely.screenshots.get();
        if (!active) {
          return;
        }
        if (result.ok) {
          setScreenshotState(result.value);
        } else {
          setNotice(noticeFromResult(result));
        }
      } catch {
        if (active) {
          setNotice({
            tone: "error",
            text: "Fluely could not refresh its screenshot queue. Restart the app and try again.",
          });
        }
      }
    }

    async function loadWorkspace() {
      try {
        const [settingsResult, shortcutsResult, appResult, screenshotsResult, codexResult, analysisResult] = await Promise.all([
          window.fluely.settings.get(),
          window.fluely.shortcuts.get(),
          window.fluely.app.getStatus(),
          window.fluely.screenshots.get(),
          window.fluely.codex.getStatus(),
          window.fluely.analysis.getStatus(),
        ]);

        if (!active) {
          return;
        }

        const firstError = [settingsResult, shortcutsResult, appResult, screenshotsResult, codexResult, analysisResult]
          .map((result) => noticeFromResult(result))
          .find((value): value is SetupNotice => value !== null);
        if (firstError) {
          setNotice(firstError);
        }
        if (settingsResult.ok) {
          setSettings(settingsResult.value);
        }
        if (appResult.ok) {
          setAppVersion(appResult.value.version);
        }
        if (screenshotsResult.ok) {
          setScreenshotState(screenshotsResult.value);
        }
        if (codexResult.ok) {
          setCodexStatus(codexResult.value);
        }
        if (analysisResult.ok) {
          setAnalysisState(toAnalysisState(analysisResult.value));
        }
      } catch {
        if (active) {
          setNotice({
            tone: "error",
            text: "Fluely could not connect to its main process. Restart the app and try again.",
          });
        }
      } finally {
        if (active) {
          setBusy(false);
        }
      }
    }

    const refreshOnFocus = () => {
      void refreshScreenshotState();
    };
    window.addEventListener("focus", refreshOnFocus);
    const unsubscribeScreenshotState = subscribeToScreenshotState(
      window.fluely.screenshots,
      (state) => setScreenshotState(state),
      () => active,
    );
    const unsubscribeAnalysisState = subscribeToAnalysisState(
      window.fluely.analysis,
      (event) => setAnalysisState(toAnalysisState(event)),
      () => active,
    );
    void loadWorkspace();

    return () => {
      active = false;
      mountedRef.current = false;
      window.removeEventListener("focus", refreshOnFocus);
      unsubscribeScreenshotState();
      unsubscribeAnalysisState();
    };
  }, []);

  function showError(error: IpcError) {
    if (mountedRef.current) {
      setNotice({ tone: "error", text: describeError(error) });
    }
  }

  async function startSetup(patch: SettingsPatch) {
    if (!mountedRef.current) {
      return;
    }
    setBusy(true);
    try {
      const requestedPath = patch.codex?.path;
      if (typeof requestedPath !== "string" || !requestedPath.trim()) {
        setNotice({
          tone: "error",
          text: "Add a Codex executable path before starting. Use codex when it is on your PATH.",
        });
        return;
      }

      const validation = await window.fluely.codex.validate(requestedPath.trim());
      if (!mountedRef.current) {
        return;
      }
      if (!validation.ok) {
        showError(validation.error);
        return;
      }
      setCodexStatus(validation.value);
      if (!validation.value.available) {
        showError(validation.value.error ?? {
          code: "INTERNAL_ERROR",
          message: `Fluely could not find ${requestedPath.trim()}.`,
          action: "Install Codex or update the executable path, then try again.",
        });
        return;
      }

      const saveResult = await window.fluely.settings.update({ ...patch, setupComplete: true });
      if (!mountedRef.current) {
        return;
      }
      if (!saveResult.ok) {
        showError(saveResult.error);
        return;
      }

      const modeResult = await window.fluely.window.setMode("work");
      if (!mountedRef.current) {
        return;
      }
      if (!modeResult.ok) {
        setSettings(saveResult.value);
        showError(modeResult.error);
        return;
      }

      setSettings(modeResult.value);
      setNotice({ tone: "success", text: "Fluely is ready. Capture a screen and ask your first question." });
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not finish setup. Check the Codex path and try again.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }

  async function openSettings() {
    try {
      const result = await window.fluely.window.setMode("setup");
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setSettings(result.value);
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not open settings. Restart the app and try again.",
        });
      }
    }
  }

  async function changeOpacity(opacity: number) {
    const requestId = ++opacityRequestRef.current;
    try {
      const result = await window.fluely.window.setOpacity(opacity);
      if (!mountedRef.current || requestId !== opacityRequestRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setSettings((current) => current ? { ...current, window: { ...current.window, ...result.value } } : current);
    } catch {
      if (mountedRef.current && requestId === opacityRequestRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not save the window opacity. Try again.",
        });
      }
    }
  }

  async function startAnalysis(request: WorkAnalysisRequest, screenshotIds: string[]) {
    setActionBusy(true);
    try {
      const result = await window.fluely.analysis.start({
        prompt: request.prompt,
        screenshotIds,
        intent: request.intent,
        fast: request.fast,
      });
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setAnalysisState(result.value);
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not start analysis. Check the Codex connection and try again.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setActionBusy(false);
      }
    }
  }

  async function captureAndAsk(request: WorkAnalysisRequest) {
    setActionBusy(true);
    let queueRefreshAttempted = false;
    let queueRefreshWarning: string | null = null;
    try {
      const capture = await window.fluely.screenshots.capture();
      if (!mountedRef.current) {
        return;
      }
      if (!capture.ok) {
        showError(capture.error);
        return;
      }

      let screenshotIds = [capture.value.id];
      try {
        const refreshed = await window.fluely.screenshots.get();
        queueRefreshAttempted = true;
        if (refreshed.ok) {
          setScreenshotState(refreshed.value);
          screenshotIds = getAnalysisScreenshotIds(refreshed.value, capture.value.id);
        } else {
          queueRefreshWarning = `Fluely could not refresh the context queue. ${describeError(refreshed.error)} Only this screen is being analyzed.`;
        }
      } catch {
        queueRefreshAttempted = true;
        queueRefreshWarning = "Fluely could not refresh the context queue. Only this screen is being analyzed.";
      }

      const result = await window.fluely.analysis.start({
        prompt: request.prompt,
        screenshotIds,
        intent: request.intent,
        fast: request.fast,
      });
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setAnalysisState(result.value);
      setNotice({
        tone: queueRefreshWarning ? "error" : "success",
        text: queueRefreshWarning
          ? `Captured the current screen. ${queueRefreshWarning}`
          : queueRefreshAttempted && screenshotIds.length > 1
            ? `Captured the current screen. Fluely is preparing an answer from all ${screenshotIds.length} queued contexts.`
            : "Captured the current screen. Fluely is preparing your answer.",
      });
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not capture the display. Check Screen Recording permission and try again.",
        });
      }
    } finally {
      if (!queueRefreshAttempted) {
        try {
          const refreshed = await window.fluely.screenshots.get();
          if (mountedRef.current && refreshed.ok) {
            setScreenshotState(refreshed.value);
          }
        } catch {
          // The capture result and analysis state remain useful if the refresh races teardown.
        }
      }
      if (mountedRef.current) {
        setActionBusy(false);
      }
    }
  }

  async function askQueue(request: WorkAnalysisRequest) {
    const ids = getQueueIds(screenshotState);
    if (ids.length === 0) {
      setNotice({ tone: "error", text: "Capture a screen before asking the queue." });
      return;
    }
    await startAnalysis(request, ids);
  }

  async function cancelAnalysis() {
    setActionBusy(true);
    try {
      const result = await window.fluely.analysis.cancel();
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setAnalysisState(result.value);
      setNotice({ tone: "success", text: "Analysis cancelled. Your context queue is unchanged." });
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not cancel the active request. Try again.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setActionBusy(false);
      }
    }
  }

  async function removeScreenshot(id: string) {
    setActionBusy(true);
    try {
      const result = await window.fluely.screenshots.delete(id);
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setScreenshotState(result.value);
    } catch {
      if (mountedRef.current) {
        setNotice({ tone: "error", text: "Fluely could not remove that screenshot. Refresh the queue and try again." });
      }
    } finally {
      if (mountedRef.current) {
        setActionBusy(false);
      }
    }
  }

  async function clearQueue() {
    setActionBusy(true);
    try {
      const result = await window.fluely.screenshots.clear();
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setScreenshotState(result.value);
      setNotice({ tone: "success", text: "Context queue cleared." });
    } catch {
      if (mountedRef.current) {
        setNotice({ tone: "error", text: "Fluely could not clear the screenshot queue. Try again." });
      }
    } finally {
      if (mountedRef.current) {
        setActionBusy(false);
      }
    }
  }

  async function hideWindow() {
    try {
      const result = await window.fluely.window.hide();
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
      }
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not hide its window. Use the Fluely shortcut and try again.",
        });
      }
    }
  }

  if (busy && !settings) {
    return (
      <main className="loading-shell" aria-busy="true">
        <div className="loading-mark" aria-hidden="true"><span /><span /><span /></div>
        <p className="eyebrow accent">FLUELY</p>
        <h1>Preparing your workspace…</h1>
        <p>Connecting to your local settings and Codex CLI.</p>
      </main>
    );
  }

  if (!settings) {
    return (
      <main className="loading-shell">
        <div className="loading-mark" aria-hidden="true"><span /><span /><span /></div>
        <p className="eyebrow accent">FLUELY</p>
        <h1>Workspace unavailable</h1>
        {notice && <p className="loading-error">{notice.text}</p>}
      </main>
    );
  }

  const mode = selectWorkspaceMode(settings);
  if (mode === "setup") {
    return (
      <SetupView
        settings={settings}
        codexStatus={codexStatus}
        busy={busy}
        notice={notice}
        onStart={startSetup}
      />
    );
  }

  return (
    <WorkView
      settings={settings}
      screenshotState={screenshotState ?? emptyScreenshotState()}
      analysisState={analysisState ?? emptyAnalysisState()}
      codexStatus={codexStatus}
      notice={notice}
      busy={actionBusy}
      onCaptureAsk={captureAndAsk}
      onAskQueue={askQueue}
      onCancel={cancelAnalysis}
      onOpacityChange={changeOpacity}
      onOpenSettings={openSettings}
      onHide={hideWindow}
      onRemoveScreenshot={removeScreenshot}
      onClearQueue={clearQueue}
    />
  );
}

export {
  buildIntentPrompt,
  formatOpacityLabel,
  getAnalysisActionState,
  getAnalysisScreenshotIds,
  getQueueCount,
  getQueueIds,
  selectWorkspaceMode,
} from "../shared/workspace-state";
