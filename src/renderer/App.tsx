import { useEffect, useRef, useState } from "react";
import {
  subscribeToAnalysisState,
  subscribeToPhoneGatewayStatus,
  subscribeToScreenshotState,
} from "../shared/ipc";
import type { ConversationEvent, ConversationSnapshot } from "../shared/conversation";
import type {
  AnalysisState,
  CodexStatus,
  FluelySettings,
  IpcError,
  IpcResult,
  PhoneGatewayStatus,
  SettingsPatch,
  ScreenshotState,
  WorkspaceCommand,
} from "../shared/ipc";
import {
  initialWorkspaceView,
  navigateWorkspaceView,
  type WorkspaceView,
} from "../shared/workspace-view";
import {
  createWorkspaceRequestIdFactory,
  type WorkspaceRequestIdFactory,
} from "../shared/context-queue";
import {
  createConversationHydrationCoordinator,
  type ConversationHydrationCoordinator,
} from "./conversation-hydration";
import { SetupView, type SetupNotice } from "./components/SetupView";
import { WorkView, type WorkAnalysisRequest } from "./components/WorkView";
import {
  createWorkspaceNavigationCallbacks,
  selectWorkspaceRoot,
} from "./workspace-navigation";

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

function emptyConversationSnapshot(): ConversationSnapshot {
  return {
    sessionId: "unhydrated",
    revision: 0,
    messages: [],
    attachments: [],
  };
}

export function App() {
  const [settings, setSettings] = useState<FluelySettings | null>(null);
  // View navigation is session-only; setupComplete remains persisted onboarding state.
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  const [screenshotState, setScreenshotState] = useState<ScreenshotState | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState | null>(null);
  const [conversationSnapshot, setConversationSnapshot] = useState<ConversationSnapshot | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [phoneGatewayStatus, setPhoneGatewayStatus] = useState<PhoneGatewayStatus | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [phoneGatewayBusy, setPhoneGatewayBusy] = useState(false);
  const [notice, setNotice] = useState<SetupNotice | null>(null);
  const mountedRef = useRef(true);
  const opacityRequestRef = useRef(0);
  const workspaceRequestIdFactoryRef = useRef<WorkspaceRequestIdFactory | null>(null);
  const workspaceCommandBusyRef = useRef(false);
  const conversationHydrationRef = useRef<ConversationHydrationCoordinator | null>(null);

  if (!workspaceRequestIdFactoryRef.current) {
    workspaceRequestIdFactoryRef.current = createWorkspaceRequestIdFactory();
  }

  useEffect(() => {
    let active = true;
    mountedRef.current = true;

    const readConversationSnapshot = async (): Promise<ConversationSnapshot> => {
      const result = await window.fluely.conversation.getSnapshot();
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    };

    const conversationHydration = createConversationHydrationCoordinator({
      readSnapshot: readConversationSnapshot,
      onSnapshot: (snapshot) => {
        if (active) {
          setConversationSnapshot(snapshot);
        }
      },
      onUnavailable: () => {
        if (active) {
          setNotice({
            tone: "error",
            text: "Fluely could not resynchronize the conversation. Restart the app or retry the workspace action.",
          });
        }
      },
    });
    conversationHydrationRef.current = conversationHydration;

    const applyConversationEvent = (event: ConversationEvent): void => {
      void conversationHydration.queueEvent(event).catch(() => undefined);
    };

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

    async function refreshPhoneGatewayStatus() {
      try {
        const result = await window.fluely.phoneGateway.getStatus();
        if (!active) {
          return;
        }
        if (result.ok) {
          setPhoneGatewayStatus(result.value);
        } else {
          setNotice(noticeFromResult(result));
        }
      } catch {
        if (active) {
          setNotice({
            tone: "error",
            text: "Fluely could not refresh the phone companion. Restart the app and try again.",
          });
        }
      }
    }

    async function loadWorkspace() {
      try {
        const conversationSnapshotPromise: Promise<IpcResult<ConversationSnapshot>> = window.fluely.conversation.getSnapshot()
          .catch(() => ({
            ok: false,
            error: {
              code: "INTERNAL_ERROR",
              message: "Fluely could not read the current conversation.",
              action: "Retry the workspace action.",
            },
          }));
        const [settingsResult, shortcutsResult, appResult, screenshotsResult, codexResult, analysisResult, conversationResult, phoneGatewayResult] = await Promise.all([
          window.fluely.settings.get(),
          window.fluely.shortcuts.get(),
          window.fluely.app.getStatus(),
          window.fluely.screenshots.get(),
          window.fluely.codex.getStatus(),
          window.fluely.analysis.getStatus(),
          conversationSnapshotPromise,
          window.fluely.phoneGateway.getStatus(),
        ]);

        if (!active) {
          return;
        }

        const firstError = [settingsResult, shortcutsResult, appResult, screenshotsResult, codexResult, analysisResult, conversationResult, phoneGatewayResult]
          .map((result) => noticeFromResult(result))
          .find((value): value is SetupNotice => value !== null);
        if (firstError) {
          setNotice(firstError);
        }
        if (settingsResult.ok) {
          setSettings(settingsResult.value);
          setWorkspaceView((current) => current ?? initialWorkspaceView(settingsResult.value.setupComplete));
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
        if (conversationResult.ok) {
          conversationHydration.promote(conversationResult.value);
        } else {
          void conversationHydration.retryHydration();
        }
        if (phoneGatewayResult.ok) {
          setPhoneGatewayStatus(phoneGatewayResult.value);
        }
      } catch {
        if (active) {
          setNotice({
            tone: "error",
            text: "Fluely could not connect to its main process. Restart the app and try again.",
          });
        }
        void conversationHydration.retryHydration();
      } finally {
        if (active) {
          setBusy(false);
        }
      }
    }

    const refreshOnFocus = () => {
      void refreshScreenshotState();
      void refreshPhoneGatewayStatus();
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
    const unsubscribeConversation = window.fluely.conversation.onEvent(applyConversationEvent);
    const unsubscribePhoneGateway = subscribeToPhoneGatewayStatus(
      window.fluely.phoneGateway,
      (status) => setPhoneGatewayStatus(status),
      () => active,
    );
    void loadWorkspace();

    return () => {
      active = false;
      mountedRef.current = false;
      window.removeEventListener("focus", refreshOnFocus);
      unsubscribeScreenshotState();
      unsubscribeAnalysisState();
      unsubscribeConversation();
      unsubscribePhoneGateway();
      conversationHydrationRef.current = null;
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

      setSettings(saveResult.value);
      setWorkspaceView((current) => navigateWorkspaceView(
        current ?? initialWorkspaceView(saveResult.value.setupComplete),
        "work",
        saveResult.value.setupComplete,
      ));
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

  async function enablePhoneGateway() {
    if (!mountedRef.current || phoneGatewayBusy) {
      return;
    }
    setPhoneGatewayBusy(true);
    try {
      const result = await window.fluely.phoneGateway.enable();
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setPhoneGatewayStatus(result.value);
      setSettings((current) => current ? { ...current, phoneGateway: { enabled: true } } : current);
      if (result.value.state === "ready") {
        setNotice({ tone: "success", text: "Phone companion is ready on your trusted local network." });
      }
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not start the phone companion. Check the LAN connection and try again.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setPhoneGatewayBusy(false);
      }
    }
  }

  async function disablePhoneGateway() {
    if (!mountedRef.current || phoneGatewayBusy) {
      return;
    }
    setPhoneGatewayBusy(true);
    try {
      const result = await window.fluely.phoneGateway.disable();
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setPhoneGatewayStatus(result.value);
      setSettings((current) => current ? { ...current, phoneGateway: { enabled: false } } : current);
      setNotice({ tone: "success", text: "Phone companion disabled and paired sessions revoked." });
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not disable the phone companion. Try again.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setPhoneGatewayBusy(false);
      }
    }
  }

  async function regeneratePhonePairing() {
    if (!mountedRef.current || phoneGatewayBusy) {
      return;
    }
    setPhoneGatewayBusy(true);
    try {
      const result = await window.fluely.phoneGateway.regeneratePairing();
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setPhoneGatewayStatus(result.value);
      setNotice({ tone: "success", text: "A new pairing code was generated. Any previous phone session was revoked." });
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not generate a new pairing code. Try again.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setPhoneGatewayBusy(false);
      }
    }
  }

  function nextWorkspaceRequestId(action: WorkspaceCommand["type"]): string {
    return workspaceRequestIdFactoryRef.current!.next(action);
  }

  async function executeWorkspaceCommand(command: WorkspaceCommand): Promise<boolean> {
    if (workspaceCommandBusyRef.current) {
      return false;
    }

    workspaceCommandBusyRef.current = true;
    setActionBusy(true);
    try {
      const result = await window.fluely.workspace.execute(command);
      if (!mountedRef.current) {
        return result.ok;
      }
      if (!result.ok) {
        showError(result.error);
        return false;
      }

      setScreenshotState(result.value.queue);
      const hydration = conversationHydrationRef.current;
      if (hydration) {
        hydration.promote(result.value.conversation);
      } else {
        setConversationSnapshot(result.value.conversation);
      }
      if (result.value.analysis) {
        setAnalysisState(result.value.analysis);
      }
      return true;
    } catch {
      if (mountedRef.current) {
        setNotice({
          tone: "error",
          text: "Fluely could not reach its workspace command service. Try again.",
        });
      }
      return false;
    } finally {
      workspaceCommandBusyRef.current = false;
      if (mountedRef.current) {
        setActionBusy(false);
      }
    }
  }

  async function captureScreenshot() {
    const succeeded = await executeWorkspaceCommand({
      type: "capture",
      requestId: nextWorkspaceRequestId("capture"),
    });
    if (succeeded && mountedRef.current) {
      setNotice({ tone: "success", text: "Screenshot captured. It was added to your context queue." });
    }
  }

  async function ask(request: WorkAnalysisRequest): Promise<boolean> {
    const succeeded = await executeWorkspaceCommand({
      type: "ask",
      requestId: nextWorkspaceRequestId("ask"),
      prompt: request.prompt,
    });
    if (succeeded && mountedRef.current) {
      setNotice({ tone: "success", text: "Question sent. Your context queue was cleared." });
    }
    return succeeded;
  }

  async function cancelAnalysis() {
    const succeeded = await executeWorkspaceCommand({
      type: "cancel",
      requestId: nextWorkspaceRequestId("cancel"),
    });
    if (succeeded && mountedRef.current) {
      setNotice({ tone: "success", text: "Analysis cancelled. Your context queue is unchanged." });
    }
  }

  async function removeScreenshot(id: string) {
    const succeeded = await executeWorkspaceCommand({
      type: "remove",
      requestId: nextWorkspaceRequestId("remove"),
      screenshotId: id,
    });
    if (succeeded && mountedRef.current) {
      setNotice({ tone: "success", text: "Screenshot removed from the context queue." });
    }
  }

  async function clearQueue() {
    const succeeded = await executeWorkspaceCommand({
      type: "clear-queue",
      requestId: nextWorkspaceRequestId("clear-queue"),
    });
    if (succeeded && mountedRef.current) {
      setNotice({ tone: "success", text: "Context queue cleared." });
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

  const view = workspaceView ?? initialWorkspaceView(settings.setupComplete);
  const navigation = createWorkspaceNavigationCallbacks({
    setupComplete: settings.setupComplete,
    getWorkspaceView: () => view,
    setWorkspaceView,
    onWorkBlocked: () => {
      if (mountedRef.current) {
        setNotice({ tone: "error", text: "Finish setup before entering the workspace." });
      }
    },
  });
  const root = selectWorkspaceRoot(view);
  if (root.settings) {
    return (
      <SetupView
        settings={settings}
        codexStatus={codexStatus}
        busy={busy}
        notice={notice}
        onStart={startSetup}
        onBackToWork={settings.setupComplete ? () => { navigation.openWork(); } : undefined}
        phoneGatewayStatus={phoneGatewayStatus}
        phoneGatewayBusy={phoneGatewayBusy}
        onPhoneGatewayEnable={enablePhoneGateway}
        onPhoneGatewayDisable={disablePhoneGateway}
        onPhoneGatewayRegeneratePairing={regeneratePhonePairing}
      />
    );
  }

  return (
    <WorkView
      settings={settings}
      screenshotState={screenshotState ?? emptyScreenshotState()}
      analysisState={analysisState ?? emptyAnalysisState()}
      conversation={conversationSnapshot}
      codexStatus={codexStatus}
      notice={notice}
      busy={actionBusy}
      onCapture={captureScreenshot}
      onAsk={ask}
      onCancel={cancelAnalysis}
      onOpacityChange={changeOpacity}
      onOpenSettings={navigation.openSettings}
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
} from "../shared/workspace-state";
