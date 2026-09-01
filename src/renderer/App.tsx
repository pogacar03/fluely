import { useEffect, useRef, useState } from "react";
import { subscribeToAnalysisState, subscribeToScreenshotState } from "../shared/ipc";
import {
  createConversationProjection,
  type ConversationEvent,
  type ConversationProjection,
  type ConversationSnapshot,
} from "../shared/conversation";
import type {
  AnalysisState,
  CodexStatus,
  FluelySettings,
  IpcError,
  IpcResult,
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
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<SetupNotice | null>(null);
  const mountedRef = useRef(true);
  const opacityRequestRef = useRef(0);
  const workspaceRequestIdFactoryRef = useRef<WorkspaceRequestIdFactory | null>(null);
  const workspaceCommandBusyRef = useRef(false);
  const conversationProjectionRef = useRef<ConversationProjection | null>(null);

  if (!workspaceRequestIdFactoryRef.current) {
    workspaceRequestIdFactoryRef.current = createWorkspaceRequestIdFactory();
  }

  useEffect(() => {
    let active = true;
    let conversationHydrated = false;
    const pendingConversationEvents: ConversationEvent[] = [];
    mountedRef.current = true;

    const readConversationSnapshot = async (): Promise<ConversationSnapshot> => {
      const result = await window.fluely.conversation.getSnapshot();
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    };

    const applyConversationEvent = (event: ConversationEvent): void => {
      if (!conversationHydrated || !conversationProjectionRef.current) {
        pendingConversationEvents.push(event);
        return;
      }

      void conversationProjectionRef.current.apply(event).then((result) => {
        if (active) {
          setConversationSnapshot(result.snapshot);
        }
      }).catch(() => {
        if (active) {
          setNotice({
            tone: "error",
            text: "Fluely could not resynchronize the conversation. Restart the app and try again.",
          });
        }
      });
    };

    const hydrateConversation = (snapshot: ConversationSnapshot): void => {
      const projection = conversationProjectionRef.current;
      if (projection && projection.snapshot().sessionId === snapshot.sessionId) {
        projection.replace(snapshot);
      } else {
        conversationProjectionRef.current = createConversationProjection(snapshot, readConversationSnapshot);
      }
      conversationHydrated = true;
      const hydratedProjection = conversationProjectionRef.current;
      if (!hydratedProjection) {
        return;
      }
      setConversationSnapshot(hydratedProjection.snapshot());
      const events = pendingConversationEvents.splice(0);
      for (const event of events) {
        applyConversationEvent(event);
      }
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

    async function loadWorkspace() {
      try {
        const [settingsResult, shortcutsResult, appResult, screenshotsResult, codexResult, analysisResult, conversationResult] = await Promise.all([
          window.fluely.settings.get(),
          window.fluely.shortcuts.get(),
          window.fluely.app.getStatus(),
          window.fluely.screenshots.get(),
          window.fluely.codex.getStatus(),
          window.fluely.analysis.getStatus(),
          window.fluely.conversation.getSnapshot(),
        ]);

        if (!active) {
          return;
        }

        const firstError = [settingsResult, shortcutsResult, appResult, screenshotsResult, codexResult, analysisResult, conversationResult]
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
          hydrateConversation(conversationResult.value);
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
    const unsubscribeConversation = window.fluely.conversation.onEvent(applyConversationEvent);
    void loadWorkspace();

    return () => {
      active = false;
      mountedRef.current = false;
      window.removeEventListener("focus", refreshOnFocus);
      unsubscribeScreenshotState();
      unsubscribeAnalysisState();
      unsubscribeConversation();
      conversationProjectionRef.current = null;
      pendingConversationEvents.length = 0;
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
      const projection = conversationProjectionRef.current;
      if (projection) {
        projection.replace(result.value.conversation);
        setConversationSnapshot(projection.snapshot());
      } else {
        conversationProjectionRef.current = createConversationProjection(result.value.conversation, async () => {
          const snapshotResult = await window.fluely.conversation.getSnapshot();
          if (!snapshotResult.ok) {
            throw new Error(snapshotResult.error.message);
          }
          return snapshotResult.value;
        });
        setConversationSnapshot(conversationProjectionRef.current.snapshot());
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

  async function sendImages(request: WorkAnalysisRequest) {
    const succeeded = await executeWorkspaceCommand({
      type: "send",
      requestId: nextWorkspaceRequestId("send"),
      prompt: request.prompt,
    });
    if (succeeded && mountedRef.current) {
      setNotice({ tone: "success", text: "Screenshots sent. Your context queue remains available." });
    }
  }

  async function captureAndAsk(request: WorkAnalysisRequest) {
    const succeeded = await executeWorkspaceCommand({
      type: "capture-and-send",
      requestId: nextWorkspaceRequestId("capture-and-send"),
      prompt: request.prompt,
    });
    if (succeeded && mountedRef.current) {
      setNotice({ tone: "success", text: "Screenshot captured and sent. Your context queue remains available." });
    }
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
      />
    );
  }

  return (
    <WorkView
      settings={settings}
      screenshotState={screenshotState ?? emptyScreenshotState()}
      analysisState={analysisState ?? emptyAnalysisState()}
      conversation={conversationSnapshot ?? emptyConversationSnapshot()}
      codexStatus={codexStatus}
      notice={notice}
      busy={actionBusy}
      onCapture={captureScreenshot}
      onSendImages={sendImages}
      onCaptureAsk={captureAndAsk}
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
