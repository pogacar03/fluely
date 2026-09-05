import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  protocol,
  screen,
  systemPreferences,
} from "electron";
import { join } from "node:path";
import type {
  AnalysisStateChangedEvent,
  AppStatus,
  CodexStatus,
  ContextScreenshot,
  ConversationEvent,
  FluelySettings,
  IpcError,
  PhoneGatewayStatus,
  ScreenshotState,
} from "../src/shared/ipc";
import { AttachmentStore } from "./services/AttachmentStore";
import { bootstrapApplication } from "./services/application-bootstrap";
import { DEFAULT_SETTINGS } from "./services/settings-core";
import { AnalysisService } from "./services/AnalysisService";
import { CapturePrivacyController, DockPrivacyCoordinator } from "./services/CapturePrivacyController";
import {
  CodexCliService,
  createMainProcessCodexCliService,
} from "./services/CodexCliService";
import {
  acquireSingleInstance,
  createApplicationWindowFocusController,
  createApplicationInstancePort,
} from "./services/application-instance";
import { registerIpcHandlers, serializePhoneGatewayStatus } from "./services/ipcHandlers";
import { SettingsService } from "./services/SettingsService";
import { ScreenshotService } from "./services/ScreenshotService";
import { CommandRouter } from "./services/CommandRouter";
import { ConversationStore } from "./services/ConversationStore";
import { ShortcutManager } from "./services/ShortcutManager";
import { createShortcutCommandHandlers } from "./services/shortcut-command-routing";
import { createScreenshotWorkflow } from "./services/capture-workflow";
import { isScreenshotSessionActive, waitForScreenshotSessionIdle } from "./services/screenshot-session";
import { attachApplicationLifecycle, attachWindowLifecycle } from "./services/window-lifecycle";
import { SESSION_MEDIA_SCHEME, createSessionMediaHandler } from "./services/session-media-protocol";
import { getWindowPreferences } from "./windowConfig";
import { PhoneGateway } from "./services/PhoneGateway";
import { SessionProjectionStore } from "./services/SessionProjectionStore";
import {
  createPhoneGatewayLifecycle,
  type PhoneGatewayLifecycle,
} from "./services/phone-gateway-lifecycle";

let mainWindow: BrowserWindow | null = null;
let mainWindowReady = false;
let settingsService: SettingsService | null = null;
let shortcutManager: ShortcutManager | null = null;
let capturePrivacyController: CapturePrivacyController | null = null;
let screenshotService: ScreenshotService | null = null;
let codexCliService: CodexCliService | null = null;
let analysisService: AnalysisService | null = null;
let attachmentStore: AttachmentStore | null = null;
let conversationStore: ConversationStore | null = null;
let commandRouter: CommandRouter | null = null;
let phoneGateway: PhoneGateway | null = null;
let phoneGatewayLifecycle: PhoneGatewayLifecycle | null = null;
let sessionProjectionStore: SessionProjectionStore | null = null;
let dockPrivacyCoordinator: DockPrivacyCoordinator | null = null;
let ipcHandlersRegistered = false;
let contextMediaProtocolRegistered = false;
let sessionShutdownStarted = false;
const screenshotProjectionListeners = new Set<(state: ScreenshotState) => void>();

const MIN_WINDOW_OPACITY = 0.35;
const MAX_WINDOW_OPACITY = 1;
const mainWindowFocusController = createApplicationWindowFocusController({
  getWindow: () => mainWindow,
  isReady: () => mainWindowReady,
  isCaptureActive: isScreenshotSessionActive,
  waitForCaptureIdle: waitForScreenshotSessionIdle,
});

function clampWindowOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.window.opacity;
  }
  return Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, value));
}

function getDockPrivacyCoordinator(): DockPrivacyCoordinator | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  if (!dockPrivacyCoordinator) {
    dockPrivacyCoordinator = new DockPrivacyCoordinator({
      hide: () => app.dock?.hide(),
      show: () => app.dock?.show(),
    });
  }

  return dockPrivacyCoordinator;
}

export function createMainWindow(settings: FluelySettings = DEFAULT_SETTINGS): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  mainWindowReady = false;

  const window = new BrowserWindow({
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: "#0a0b12",
    title: "Fluely",
    webPreferences: getWindowPreferences(join(__dirname, "preload.js")),
  });
  window.setOpacity(clampWindowOpacity(settings.window.opacity));

  capturePrivacyController?.dispose();
  capturePrivacyController = new CapturePrivacyController(
    process.platform,
    getDockPrivacyCoordinator(),
  );
  capturePrivacyController.apply(window, settings.privacy.captureProtection);

  attachWindowLifecycle({
    window,
    isCaptureActive: isScreenshotSessionActive,
    waitForCaptureIdle: waitForScreenshotSessionIdle,
    onReadyToShow: () => {
      mainWindowReady = true;
      if (!mainWindowFocusController.notifyGateChanged()) {
        window.show();
      }
    },
    onClosed: () => {
      if (mainWindow === window) {
        analysisService?.cancel();
        mainWindowFocusController.notifyWindowDestroyed();
        mainWindowReady = false;
        mainWindow = null;
        capturePrivacyController?.dispose();
        capturePrivacyController = null;
      }
    },
  });

  mainWindow = window;
  return window;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function loadMainRenderer(window: BrowserWindow): Promise<void> {
  return window.loadFile(join(__dirname, "../../dist/index.html"));
}

function getAppStatus(): AppStatus {
  return {
    name: "Fluely",
    version: app.getVersion(),
    platform: process.platform,
    visible: mainWindow?.isVisible() ?? false,
  };
}

function notifyScreenshotState(state?: ScreenshotState): void {
  const nextState = state ?? getScreenshotService().getState();
  for (const listener of [...screenshotProjectionListeners]) {
    try {
      listener(nextState);
    } catch {
      // Projection subscribers must not break renderer notifications or queue mutations.
    }
  }

  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    window.webContents.send("screenshots:state-changed", nextState);
  } catch {
    // The renderer may be tearing down while a background mutation completes.
  }
}

function notifyAnalysisState(event: AnalysisStateChangedEvent): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    window.webContents.send("analysis:state-changed", event);
  } catch {
    // The renderer may be tearing down while a background request completes.
  }
}

function notifyConversationEvent(event: ConversationEvent): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    window.webContents.send("conversation:event", event);
  } catch {
    // The renderer may be tearing down while a conversation mutation completes.
  }
}

function notifyPhoneGatewayStatus(status: PhoneGatewayStatus): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    window.webContents.send("phone-gateway:status-changed", serializePhoneGatewayStatus(status));
  } catch {
    // The renderer may be tearing down while the gateway changes state.
  }
}

function getPhoneGatewayLifecycle(settings: SettingsService): PhoneGatewayLifecycle {
  if (!phoneGatewayLifecycle) {
    phoneGateway = new PhoneGateway({
      commandRouter: getCommandRouter(settings),
      projection: getSessionProjectionStore(),
      context: {
        getManagedPaths: (ids) => getScreenshotService().getManagedPaths(ids),
        getManagedRoot: () => getScreenshotService().getManagedRoot(),
      },
      attachments: {
        getPath: (id) => getAttachmentStore().getPath(id),
        getManagedRoot: () => getAttachmentStore().directory,
      },
    });
    phoneGatewayLifecycle = createPhoneGatewayLifecycle({
      gateway: phoneGateway,
      settings,
      notifyStatus: notifyPhoneGatewayStatus,
    });
  }
  return phoneGatewayLifecycle;
}

function getSessionProjectionStore(): SessionProjectionStore {
  if (!sessionProjectionStore) {
    const screenshots = getScreenshotService();
    sessionProjectionStore = new SessionProjectionStore({
      conversation: getConversationStore(),
      queue: {
        getState: () => screenshots.getState(),
        onStateChanged: (listener) => {
          screenshotProjectionListeners.add(listener);
          return () => screenshotProjectionListeners.delete(listener);
        },
      },
    });
  }
  return sessionProjectionStore;
}

function getScreenshotService(): ScreenshotService {
  if (!screenshotService) {
    screenshotService = new ScreenshotService({
      directory: join(app.getPath("userData"), "screenshots"),
      platform: process.platform,
      desktopCapturer: {
        getSources: (options) => desktopCapturer.getSources({
          types: [...options.types],
          thumbnailSize: options.thumbnailSize,
        }),
      },
      screen: {
        getCursorScreenPoint: () => screen.getCursorScreenPoint(),
        getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
      },
      systemPreferences: {
        getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
      },
      onStateChanged: (state) => notifyScreenshotState(state),
    });
  }
  return screenshotService;
}

function getAttachmentStore(): AttachmentStore {
  if (!attachmentStore) {
    attachmentStore = new AttachmentStore({
      rootDirectory: join(app.getPath("userData"), "session-attachments"),
    });
  }
  return attachmentStore;
}

function getConversationStore(): ConversationStore {
  if (!conversationStore) {
    const attachments = getAttachmentStore();
    conversationStore = new ConversationStore({
      sessionId: attachments.sessionId,
      attachmentStore: attachments,
    });
  }
  return conversationStore;
}

function registerContextMediaProtocol(): void {
  if (contextMediaProtocolRegistered) {
    return;
  }

  protocol.handle(SESSION_MEDIA_SCHEME, createSessionMediaHandler({
    context: {
      getManagedPaths: (ids) => getScreenshotService().getManagedPaths(ids),
      getManagedRoot: () => getScreenshotService().getManagedRoot(),
    },
    attachments: {
      getPath: (id) => getAttachmentStore().getPath(id),
      getManagedRoot: () => getAttachmentStore().directory,
    },
  }));
  contextMediaProtocolRegistered = true;
}

function getCodexCliService(): CodexCliService {
  if (!codexCliService) {
    codexCliService = createMainProcessCodexCliService();
  }
  return codexCliService;
}

function getAnalysisService(settings: SettingsService): AnalysisService {
  if (!analysisService) {
    analysisService = new AnalysisService({
      provider: getCodexCliService(),
      getManagedPaths: (ids) => getScreenshotService().getManagedPaths(ids),
      codex: settings.get().codex,
    });
  }
  return analysisService;
}

function getCommandRouter(settings: SettingsService): CommandRouter {
  if (!commandRouter) {
    const screenshots = getScreenshotService();
    commandRouter = new CommandRouter({
      screenshots: {
        getState: () => screenshots.getState(),
        getManagedPaths: (ids) => screenshots.getManagedPaths(ids),
        capture: () => captureCurrentWindow(),
        delete: (id) => screenshots.delete(id),
        clear: () => screenshots.clear(),
        cancelPending: () => screenshots.cancelPending(),
      },
      attachments: getAttachmentStore(),
      conversation: getConversationStore(),
      analysis: getAnalysisService(settings),
    });
  }
  return commandRouter;
}

async function getCodexStatus(settings: SettingsService): Promise<CodexStatus> {
  const configuredPath = settings.get().codex.path;
  const validation = await getCodexCliService().validateExecutable(
    configuredPath,
    settings.get().codex.timeoutMs,
  );
  const status: CodexStatus = {
    available: validation.success,
    configuredPath,
  };
  if (validation.resolvedPath) {
    status.resolvedPath = validation.resolvedPath;
  }
  if (validation.error) {
    status.error = {
      code: "INTERNAL_ERROR",
      message: validation.error.message,
      action: validation.error.action,
    };
  }
  return status;
}

async function validateCodexPath(path: string, settings: SettingsService): Promise<CodexStatus> {
  const validation = await getCodexCliService().validateExecutable(
    path,
    settings.get().codex.timeoutMs,
  );
  const status: CodexStatus = {
    available: validation.success,
    configuredPath: path,
  };
  if (validation.resolvedPath) {
    status.resolvedPath = validation.resolvedPath;
  }
  if (validation.error) {
    status.error = {
      code: "INTERNAL_ERROR",
      message: validation.error.message,
      action: validation.error.action,
    };
  }
  return status;
}

function captureFailure(): IpcError {
  return {
    code: "SCREEN_CAPTURE_FAILED",
    message: "Fluely could not capture the selected display.",
    action: "Check that a display is available and try again.",
  };
}

function captureCurrentWindow(): Promise<ContextScreenshot> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return Promise.reject(captureFailure());
  }

  return createScreenshotWorkflow({
    window,
    platform: process.platform,
    capture: () => getScreenshotService().capture(),
    whenIdle: () => getScreenshotService().whenIdle(),
    delete: (id) => getScreenshotService().delete(id),
    clear: () => getScreenshotService().clear(),
  }).capture().catch((error) => {
    notifyScreenshotState();
    throw error;
  });
}

async function ensureSettingsService(): Promise<SettingsService> {
  if (!settingsService) {
    settingsService = new SettingsService(app.getPath("userData"));
    const loadResult = await settingsService.load();
    if (loadResult.warning) {
      console.warn(loadResult.warning.message);
    }
  }
  return settingsService;
}

async function initializeMainServices(): Promise<SettingsService> {
  const loadedSettings = await ensureSettingsService();
  const phoneLifecycle = getPhoneGatewayLifecycle(loadedSettings);
  await phoneLifecycle.initialize(loadedSettings.get().phoneGateway);
  const screenshots = getScreenshotService();
  const attachments = getAttachmentStore();
  const conversation = getConversationStore();
  const analysis = getAnalysisService(loadedSettings);
  const router = getCommandRouter(loadedSettings);

  await Promise.all([attachments.whenReady(), screenshots.whenIdle()]);
  registerContextMediaProtocol();

  if (!ipcHandlersRegistered) {
    registerIpcHandlers({
      ipcMain,
      settings: loadedSettings,
      shortcuts: {
        getStatus: () => shortcutManager?.getStatus() ?? {
          entries: [],
          updatedAt: new Date(0).toISOString(),
        },
        update: (shortcuts) => shortcutManager?.update(shortcuts) ?? {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Fluely shortcut services are not ready.",
            action: "Restart Fluely and try again.",
          },
        },
      },
      screenshots: {
        getState: () => screenshots.getState(),
      },
      analysis,
      codex: {
        getStatus: () => getCodexStatus(loadedSettings),
        validate: (path) => validateCodexPath(path, loadedSettings),
      },
      applyCodexSettings: (codexSettings) => analysis.updateCodexSettings(codexSettings),
      workspace: router,
      conversation,
      phoneGateway: phoneLifecycle.handler,
      applyPhoneGatewaySettings: async (phoneSettings) => {
        await phoneLifecycle.applySettings(phoneSettings);
      },
      window: {
        setOpacity: (opacity) => {
          const currentWindow = mainWindow;
          if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.setOpacity(opacity);
          }
        },
        hide: () => {
          const currentWindow = mainWindow;
          if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.hide();
          }
        },
      },
      applyPrivacy: (enabled) => {
        if (mainWindow && capturePrivacyController) {
          capturePrivacyController.apply(mainWindow, enabled);
        }
      },
      applyOpacity: (opacity) => {
        const currentWindow = mainWindow;
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.setOpacity(opacity);
        }
      },
      applyShortcuts: (shortcuts) => shortcutManager?.update(shortcuts) ?? {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Fluely shortcut services are not ready.",
          action: "Restart Fluely and try again.",
        },
      },
      notifyAnalysisState,
      notifyConversationEvent,
      getAppStatus,
    });
    ipcHandlersRegistered = true;
  }

  return loadedSettings;
}

interface MainBootstrapContext {
  settings: SettingsService;
  values: FluelySettings;
}

function initializeWindowServices(window: BrowserWindow, context: MainBootstrapContext): void {
  const { settings } = context;
  const router = getCommandRouter(settings);

  shortcutManager?.dispose();
  shortcutManager = new ShortcutManager(
    {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregisterAll: () => globalShortcut.unregisterAll(),
    },
    {
      isVisible: () => window.isVisible(),
      show: () => window.show(),
      hide: () => window.hide(),
      isCaptureActive: () => isScreenshotSessionActive(),
      toggleVisibility: () => createScreenshotWorkflow({
        window,
        platform: process.platform,
        capture: () => getScreenshotService().capture(),
        delete: (id) => getScreenshotService().delete(id),
        clear: () => getScreenshotService().clear(),
      }).toggleVisibility(),
    },
    createShortcutCommandHandlers(router),
  );
  const shortcutResult = shortcutManager.registerAll(settings.get().shortcuts);
  if (!shortcutResult.ok) {
    console.warn(shortcutResult.error.message);
  }
}

function disposeFailedMainWindow(window: BrowserWindow): void {
  shortcutManager?.dispose();
  if (!window.isDestroyed()) {
    window.destroy();
  }
  if (mainWindow === window) {
    mainWindowFocusController.notifyWindowDestroyed();
    mainWindowReady = false;
    mainWindow = null;
    capturePrivacyController?.dispose();
    capturePrivacyController = null;
  }
}

async function bootstrapMainWindow(): Promise<BrowserWindow> {
  return bootstrapApplication({
    prepare: async (): Promise<MainBootstrapContext> => {
      const settings = await initializeMainServices();
      return { settings, values: settings.get() };
    },
    createWindow: (context) => createMainWindow(context.values),
    initializeWindow: (window, context) => initializeWindowServices(window, context),
    loadRenderer: (window) => loadMainRenderer(window),
    disposeWindow: disposeFailedMainWindow,
  });
}

protocol.registerSchemesAsPrivileged([{
  scheme: SESSION_MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}]);

app.setName("Fluely");

const applicationInstance = createApplicationInstancePort(app);
if (acquireSingleInstance(applicationInstance, () => app.quit())) {
  const removeSecondInstanceListener = applicationInstance.onSecondInstance(
    mainWindowFocusController.requestFocus,
  );

  app.whenReady().then(async () => {
    await bootstrapMainWindow();

    attachApplicationLifecycle({
      app,
      hasWindows: () => BrowserWindow.getAllWindows().length > 0,
      reassertPrivacy: () => capturePrivacyController?.reassert(),
      createWindow: () => {
        void bootstrapMainWindow().catch((error) => {
          console.error("Fluely could not restore its main window.", error);
          app.quit();
        });
      },
    });
  }).catch((error) => {
    console.error("Fluely could not initialize its main process.", error);
    app.quit();
  });

  const clearSessionStores = async (): Promise<void> => {
    try {
      await phoneGatewayLifecycle?.dispose();
    } catch {
      // Best-effort gateway shutdown must not prevent the app from quitting.
    }
    try {
      await commandRouter?.quiesce("all");
    } catch {
      // Best-effort global quiescence must not prevent the app from quitting.
    }
    try {
      analysisService?.cancel();
      await analysisService?.whenIdle();
    } catch {
      // Best-effort cancellation must not prevent the app from quitting.
    }
    try {
      await screenshotService?.clear();
      await screenshotService?.whenIdle();
    } catch {
      // Best-effort queue cleanup is retried by the next startup sweep.
    }
    try {
      await conversationStore?.clear();
    } catch {
      // Best-effort conversation cleanup is retried by the next startup sweep.
    }
    try {
      await attachmentStore?.dispose();
    } catch {
      // Best-effort attachment cleanup is retried by the next startup sweep.
    }
    sessionProjectionStore?.dispose();
  };

  app.on("before-quit", (event) => {
    if (sessionShutdownStarted) {
      return;
    }
    sessionShutdownStarted = true;
    event.preventDefault();
    void clearSessionStores().then(
      () => app.quit(),
      () => app.quit(),
    );
  });

  app.on("will-quit", () => {
    removeSecondInstanceListener();
    mainWindowFocusController.dispose();
    capturePrivacyController?.dispose();
    shortcutManager?.dispose();
    analysisService?.cancel();
    screenshotService?.dispose();
    sessionProjectionStore?.dispose();
    void phoneGatewayLifecycle?.dispose();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
