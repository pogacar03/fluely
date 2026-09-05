import type {
  ConversationEvent,
  ConversationMessage,
  ConversationSnapshot,
  SessionProjectionSnapshot,
} from "../../src/shared/conversation";
import type {
  ServerFrame,
} from "../../src/shared/phone-gateway";
import type { WorkspaceCommand } from "../../src/shared/ipc";
import { getCanonicalWorkspaceBusyState } from "../../src/shared/workspace-state";

export type PhoneConnectionState = "connecting" | "connected" | "disconnected" | "error" | "revoked";

export interface PhoneClientState {
  snapshot: SessionProjectionSnapshot | null;
  connection: PhoneConnectionState;
  resyncPending: boolean;
  reconnectAttempt: number;
  errorMessage?: string;
  commandPending?: { requestId: string; type: WorkspaceCommand["type"] };
  commandMessage?: string;
  commandError?: boolean;
}

export type PhoneClientEffect = { type: "resync"; afterRevision: number } | null;

export interface PhoneFrameApplication {
  state: PhoneClientState;
  effect: PhoneClientEffect;
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    attachmentIds: [...message.attachmentIds],
    ...(message.error ? { error: { ...message.error } } : {}),
  };
}

function cloneConversation(snapshot: ConversationSnapshot): ConversationSnapshot {
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    messages: snapshot.messages.map(cloneMessage),
    attachments: snapshot.attachments.map((attachment) => ({ ...attachment })),
    ...(snapshot.activeMessageId ? { activeMessageId: snapshot.activeMessageId } : {}),
  };
}

function cloneProjection(snapshot: SessionProjectionSnapshot): SessionProjectionSnapshot {
  return {
    revision: snapshot.revision,
    conversation: cloneConversation(snapshot.conversation),
    queue: snapshot.queue.map((item) => ({ ...item })),
    ...(typeof snapshot.capturing === "boolean" ? { capturing: snapshot.capturing } : {}),
  };
}

function applyConversationEvent(
  current: ConversationSnapshot,
  event: ConversationEvent,
): { status: "applied" | "duplicate" | "gap"; snapshot: ConversationSnapshot } {
  const snapshot = cloneConversation(current);
  if (event.revision <= snapshot.revision) {
    return { status: "duplicate", snapshot };
  }
  if (event.revision !== snapshot.revision + 1) {
    return { status: "gap", snapshot };
  }

  if (event.type === "cleared" || event.type === "turn-evicted") {
    const next = cloneConversation(event.snapshot);
    next.revision = event.revision;
    if (event.activeMessageId) {
      next.activeMessageId = event.activeMessageId;
    } else {
      delete next.activeMessageId;
    }
    return { status: "applied", snapshot: next };
  }

  if (event.type === "attachment-added") {
    const index = snapshot.attachments.findIndex((item) => item.id === event.attachment.id);
    if (index >= 0) {
      snapshot.attachments[index] = { ...event.attachment };
    } else {
      snapshot.attachments.push({ ...event.attachment });
    }
  } else {
    const index = snapshot.messages.findIndex((item) => item.id === event.message.id);
    const nextMessage = cloneMessage(event.message);
    if (index >= 0) {
      snapshot.messages[index] = nextMessage;
    } else {
      snapshot.messages.push(nextMessage);
      snapshot.messages.sort((left, right) => left.sequence - right.sequence);
    }
  }

  snapshot.revision = event.revision;
  if (event.activeMessageId) {
    snapshot.activeMessageId = event.activeMessageId;
  } else {
    delete snapshot.activeMessageId;
  }
  return { status: "applied", snapshot };
}

export function createPhoneClientState(): PhoneClientState {
  return {
    snapshot: null,
    connection: "connecting",
    resyncPending: false,
    reconnectAttempt: 0,
  };
}

/** Applies one server frame without inventing local conversation messages. */
export function applyPhoneServerFrame(
  current: PhoneClientState,
  frame: ServerFrame,
): PhoneFrameApplication {
  const state: PhoneClientState = {
    ...current,
    ...(current.snapshot ? { snapshot: cloneProjection(current.snapshot) } : {}),
  };

  if (frame.type === "snapshot") {
    if (!state.snapshot || frame.revision >= state.snapshot.revision) {
      state.snapshot = cloneProjection(frame.payload);
      state.resyncPending = false;
      state.errorMessage = undefined;
    }
    return { state, effect: null };
  }

  if (frame.type === "event") {
    if (!state.snapshot || state.resyncPending) {
      return {
        state: state.snapshot
          ? state
          : { ...state, resyncPending: true },
        effect: state.resyncPending ? null : {
          type: "resync",
          afterRevision: state.snapshot?.revision ?? 0,
        },
      };
    }
    if (frame.revision <= state.snapshot.revision) {
      return { state, effect: null };
    }
    if (frame.revision !== state.snapshot.revision + 1) {
      state.resyncPending = true;
      return {
        state,
        effect: {
          type: "resync",
          afterRevision: state.snapshot.revision,
        },
      };
    }
    const applied = applyConversationEvent(state.snapshot.conversation, frame.payload);
    if (applied.status === "gap") {
      state.resyncPending = true;
      return {
        state,
        effect: {
          type: "resync",
          afterRevision: state.snapshot.revision,
        },
      };
    }
    state.snapshot = {
      ...state.snapshot,
      revision: frame.revision,
      conversation: applied.snapshot,
    };
    return { state, effect: null };
  }

  if (frame.type === "error") {
    if (frame.code === "SESSION_REVOKED") {
      state.connection = "revoked";
      state.errorMessage = frame.message;
      state.commandPending = undefined;
    } else if (frame.requestId) {
      if (state.commandPending?.requestId === frame.requestId) {
        delete state.commandPending;
      }
      state.commandMessage = frame.message;
      state.commandError = true;
    } else {
      state.connection = "error";
      state.errorMessage = frame.message;
    }
    return { state, effect: null };
  }

  if (frame.type === "ack") {
    if (state.commandPending?.requestId === frame.requestId) {
      delete state.commandPending;
      state.commandMessage = "Command completed.";
      state.commandError = false;
    }
  }
  return { state, effect: null };
}

export function phoneImageUrl(namespace: "context" | "attachments", id: string): string {
  return `/api/${namespace}/${encodeURIComponent(id)}`;
}

export function reconnectDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(8_000, 250 * (2 ** normalizedAttempt));
}

function timestampLabel(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function messageStatusLabel(status: ConversationMessage["status"]): string {
  switch (status) {
    case "pending": return "Preparing";
    case "streaming": return "Streaming";
    case "completed": return "Complete";
    case "error": return "Error";
    case "cancelled": return "Cancelled";
  }
}

function appendText(parent: HTMLElement, tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  parent.append(element);
  return element;
}

export type PhoneCommandInput =
  | { type: "capture" }
  | { type: "remove"; screenshotId: string }
  | { type: "clear-queue" }
  | { type: "clear-conversation" }
  | { type: "send"; prompt: string }
  | { type: "capture-and-send"; prompt: string }
  | { type: "cancel" };

export interface PhoneActionState {
  isRunning: boolean;
  isCapturing: boolean;
  isBusy: boolean;
  canCapture: boolean;
  canSendImages: boolean;
  canCaptureAndSend: boolean;
  canRemove: boolean;
  canClearQueue: boolean;
  canClearConversation: boolean;
  canCancel: boolean;
}

export function getPhoneActionState(state: PhoneClientState): PhoneActionState {
  const canonical = getCanonicalWorkspaceBusyState({
    capturing: state.snapshot?.capturing,
    conversation: state.snapshot?.conversation,
    localPending: Boolean(state.commandPending),
  });
  const isRunning = canonical.isRunning;
  const isCapturing = canonical.isCapturing;
  const isBusy = canonical.isBusy;
  const connected = state.connection === "connected";
  const queueCount = state.snapshot?.queue.length ?? 0;
  return {
    isRunning,
    isCapturing,
    isBusy,
    canCapture: connected && !isBusy,
    canSendImages: connected && !isBusy && queueCount > 0,
    canCaptureAndSend: connected && !isBusy,
    canRemove: connected && !isBusy && queueCount > 0,
    canClearQueue: connected && !isBusy && queueCount > 0,
    canClearConversation: connected && !isBusy,
    canCancel: connected && isRunning && !state.commandPending,
  };
}

function renderPhoneClient(
  root: HTMLElement,
  state: PhoneClientState,
  promptValue: string,
  onPromptChange: (value: string) => void,
  onCommand: (command: PhoneCommandInput) => boolean,
): void {
  root.replaceChildren();
  const shell = document.createElement("main");
  shell.className = "phone-shell";
  appendText(shell, "p", "FLUELY PHONE COMPANION", "phone-eyebrow");
  appendText(shell, "h1", "Your workspace, in sync", "phone-title");
  const connectionText = state.connection === "connected"
    ? "Connected"
    : state.connection === "connecting"
      ? "Connecting…"
      : state.connection === "revoked"
        ? "Pairing revoked"
        : state.connection === "error"
          ? "Connection error"
          : "Disconnected — reconnecting…";
  appendText(shell, "p", connectionText, `phone-connection phone-connection-${state.connection}`);
  if (state.errorMessage) {
    appendText(shell, "p", state.errorMessage, "phone-error");
  }

  const queueSection = document.createElement("section");
  queueSection.className = "phone-card";
  appendText(queueSection, "h2", "Context to send");
  const queue = state.snapshot?.queue ?? [];
  if (queue.length === 0) {
    appendText(queueSection, "p", "No screenshots queued.", "phone-empty");
  } else {
    const queueList = document.createElement("div");
    queueList.className = "phone-thumbnail-row";
    for (const item of queue) {
      const itemContainer = document.createElement("div");
      itemContainer.className = "phone-queue-item";
      const image = document.createElement("img");
      image.src = phoneImageUrl("context", item.id);
      image.alt = `Queued screenshot, ${item.width} by ${item.height}`;
      image.width = 160;
      image.height = Math.max(1, Math.round(160 * item.height / item.width));
      itemContainer.append(image);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove screenshot ${item.id}`);
      remove.disabled = !getPhoneActionState(state).canRemove;
      remove.addEventListener("click", () => {
        onCommand({ type: "remove", screenshotId: item.id });
      });
      itemContainer.append(remove);
      queueList.append(itemContainer);
    }
    queueSection.append(queueList);
  }
  shell.append(queueSection);

  const conversationSection = document.createElement("section");
  conversationSection.className = "phone-card";
  appendText(conversationSection, "h2", "Conversation");
  const messages = state.snapshot?.conversation.messages.slice().sort((left, right) => left.sequence - right.sequence) ?? [];
  const attachments = new Map((state.snapshot?.conversation.attachments ?? []).map((item) => [item.id, item]));
  if (messages.length === 0) {
    appendText(conversationSection, "p", "Sent screenshots and answers will appear here.", "phone-empty");
  }
  for (const message of messages) {
    const article = document.createElement("article");
    article.className = `phone-message phone-message-${message.role}`;
    article.dataset.messageId = message.id;
    article.dataset.messageSequence = String(message.sequence);
    appendText(article, "div", `${message.role === "user" ? "You" : "Fluely"} · ${messageStatusLabel(message.status)}${timestampLabel(message.createdAt) ? ` · ${timestampLabel(message.createdAt)}` : ""}`, "phone-message-meta");
    if (message.text.trim()) {
      appendText(article, "p", message.text, "phone-message-text");
    } else if (message.status === "streaming" || message.status === "pending") {
      appendText(article, "p", message.status === "streaming" ? "Fluely is thinking…" : "Preparing your request…", "phone-message-placeholder");
    } else if (message.status === "error") {
      appendText(article, "p", "Fluely could not finish this request.", "phone-message-placeholder");
    } else if (message.status === "cancelled") {
      appendText(article, "p", "Request cancelled.", "phone-message-placeholder");
    }
    if (message.error) {
      appendText(article, "p", message.error.message, "phone-error");
    }
    const messageImages = document.createElement("div");
    messageImages.className = "phone-thumbnail-row";
    for (const attachmentId of message.attachmentIds) {
      const attachment = attachments.get(attachmentId);
      if (!attachment) continue;
      const image = document.createElement("img");
      image.src = phoneImageUrl("attachments", attachment.id);
      image.alt = `Sent screenshot, ${attachment.width} by ${attachment.height}`;
      image.width = 160;
      image.height = Math.max(1, Math.round(160 * attachment.height / attachment.width));
      messageImages.append(image);
    }
    if (messageImages.childElementCount > 0) {
      article.append(messageImages);
    }
    conversationSection.append(article);
  }
  shell.append(conversationSection);

  const controls = document.createElement("section");
  controls.className = "phone-card phone-controls";
  appendText(controls, "h2", "Phone controls");
  appendText(controls, "p", "Control the shared workspace from this phone.", "phone-empty");
  if (state.commandMessage) {
    appendText(controls, "p", state.commandMessage, state.commandError ? "phone-error" : "phone-command-status");
  }
  const actionState = getPhoneActionState(state);
  const fieldset = document.createElement("fieldset");
  fieldset.disabled = state.connection !== "connected";
  fieldset.setAttribute("aria-busy", String(actionState.isBusy));
  const prompt = document.createElement("textarea");
  prompt.rows = 3;
  prompt.value = promptValue;
  prompt.maxLength = 3000;
  prompt.placeholder = "Ask Fluely about your screenshots";
  prompt.disabled = state.connection !== "connected" || actionState.isBusy;
  prompt.addEventListener("input", () => onPromptChange(prompt.value));
  fieldset.append(prompt);
  const addCommandButton = (
    label: string,
    command: PhoneCommandInput,
    disabled: boolean,
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    const loading = state.commandPending?.type === command.type ||
      (command.type === "capture" && actionState.isCapturing);
    button.textContent = loading ? `${label}…` : label;
    button.disabled = disabled || Boolean(state.commandPending && !loading);
    button.setAttribute("aria-busy", String(loading));
    button.addEventListener("click", () => {
      const nextCommand = command.type === "send" || command.type === "capture-and-send"
        ? { ...command, prompt: prompt.value }
        : command;
      onCommand(nextCommand);
    });
    fieldset.append(button);
    return button;
  };
  addCommandButton("Capture", { type: "capture" }, !actionState.canCapture);
  addCommandButton("Send images", { type: "send", prompt: promptValue }, !actionState.canSendImages);
  addCommandButton("Capture & ask", { type: "capture-and-send", prompt: promptValue }, !actionState.canCaptureAndSend);
  addCommandButton("Clear queue", { type: "clear-queue" }, !actionState.canClearQueue);
  addCommandButton("Clear conversation", { type: "clear-conversation" }, !actionState.canClearConversation);
  addCommandButton("Cancel", { type: "cancel" }, !actionState.canCancel);
  controls.append(fieldset);
  shell.append(controls);
  root.append(shell);
}

function nextResyncRequestId(): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `phone-resync-${random}`;
}

function createPhoneCommandRequestIdFactory(): (type: WorkspaceCommand["type"]) => string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let sequence = 0;
  return (type) => {
    sequence += 1;
    return `phone-command-${random}-${type}-${sequence}`;
  };
}

export interface PhoneClientController {
  getState(): PhoneClientState;
  sendCommand(command: PhoneCommandInput): boolean;
  stop(): void;
  restart(): void;
  retry(): void;
}

export interface PhoneClientWebSocket {
  readyState: number;
  addEventListener(type: string, listener: (event?: { data?: unknown }) => void): void;
  send(value: string): void;
  close(): void;
}

export interface PhoneClientWebSocketConstructor {
  new (url: string): PhoneClientWebSocket;
  OPEN?: number;
}

export interface PhoneClientOptions {
  WebSocket?: PhoneClientWebSocketConstructor;
  fetch?: (input: string, init?: RequestInit) => Promise<{ status: number; ok?: boolean }>;
  fetchTimeoutMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  location?: { protocol: string; host: string };
}

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/** Starts the dependency-free browser client with bounded, authenticated reconnects. */
export function startPhoneClient(root: HTMLElement, options: PhoneClientOptions = {}): PhoneClientController {
  let state = createPhoneClientState();
  let promptValue = "";
  const WebSocketConstructor = options.WebSocket ?? (globalThis.WebSocket as unknown as PhoneClientWebSocketConstructor);
  const fetchImpl = options.fetch ?? (globalThis.fetch?.bind(globalThis) as PhoneClientOptions["fetch"] | undefined);
  const setTimeoutImpl = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearTimeoutImpl = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number));
  const fetchTimeoutMs = Number.isFinite(options.fetchTimeoutMs) && (options.fetchTimeoutMs ?? 0) > 0
    ? Math.floor(options.fetchTimeoutMs as number)
    : DEFAULT_FETCH_TIMEOUT_MS;
  const locationInfo = options.location ?? globalThis.location;
  let socket: PhoneClientWebSocket | null = null;
  let stopped = false;
  let reconnectTimer: unknown = null;
  let reconnectGeneration = 0;
  const nextCommandRequestId = createPhoneCommandRequestIdFactory();

  const publish = () => renderPhoneClient(root, state, promptValue, (value) => {
    promptValue = value;
  }, sendCommand);
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    const attempt = state.reconnectAttempt;
    state = { ...state, reconnectAttempt: attempt + 1 };
    publish();
    let handle: unknown;
    handle = setTimeoutImpl(() => {
      if (reconnectTimer !== handle) return;
      clearTimeoutImpl(handle);
      reconnectTimer = null;
      void reconnectAfterAuthentication(reconnectGeneration);
    }, reconnectDelayMs(attempt));
    reconnectTimer = handle;
  };
  const sendResync = (afterRevision: number) => {
    if (!socket || socket.readyState !== (WebSocketConstructor.OPEN ?? 1)) return;
    socket.send(JSON.stringify({
      type: "resync",
      requestId: nextResyncRequestId(),
      afterRevision,
    }));
  };
  function sendCommand(command: PhoneCommandInput): boolean {
    if (!socket || socket.readyState !== (WebSocketConstructor.OPEN ?? 1) || state.commandPending) {
      return false;
    }
    const requestId = nextCommandRequestId(command.type);
    const fullCommand = { ...command, requestId } as WorkspaceCommand;
    state = {
      ...state,
      commandPending: { requestId, type: command.type },
      commandMessage: undefined,
      commandError: false,
    };
    publish();
    try {
      socket.send(JSON.stringify({ type: "command", command: fullCommand }));
      return true;
    } catch {
      delete state.commandPending;
      state.commandMessage = "The phone companion could not send that command.";
      state.commandError = true;
      publish();
      return false;
    }
  }
  const handleMessage = (data: unknown) => {
    let frame: ServerFrame;
    try {
      const raw = typeof data === "string" ? data : String(data);
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      state = { ...state, connection: "error", errorMessage: "The phone companion sent an invalid update." };
      publish();
      return;
    }
    const applied = applyPhoneServerFrame(state, frame);
    state = applied.state;
    publish();
    if (applied.effect?.type === "resync") {
      sendResync(applied.effect.afterRevision);
    }
  };
  const probeAuthentication = async (): Promise<"authenticated" | "revoked" | "unavailable"> => {
    if (!fetchImpl || typeof AbortController !== "function") {
      return "unavailable";
    }
    const controller = new AbortController();
    const timeoutHandle = setTimeoutImpl(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetchImpl("/", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "text/html" },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return "revoked";
      }
      return response.status >= 200 && response.status < 300 ? "authenticated" : "unavailable";
    } catch {
      return "unavailable";
    } finally {
      clearTimeoutImpl(timeoutHandle);
    }
  };
  async function reconnectAfterAuthentication(generation: number): Promise<void> {
    if (stopped || generation !== reconnectGeneration) return;
    const authentication = await probeAuthentication();
    if (stopped || generation !== reconnectGeneration) return;
    if (authentication === "revoked") {
      state = { ...state, connection: "revoked", errorMessage: "Pairing revoked.", commandPending: undefined };
      publish();
      return;
    }
    if (authentication === "unavailable") {
      state = { ...state, connection: "error", errorMessage: "The phone companion authentication check failed." };
      publish();
      scheduleReconnect();
      return;
    }
    connect();
  }
  function connect() {
    if (stopped) return;
    if (!WebSocketConstructor) {
      state = { ...state, connection: "error", errorMessage: "The phone companion could not open a connection." };
      publish();
      scheduleReconnect();
      return;
    }
    state = { ...state, connection: "connecting", errorMessage: undefined, commandPending: undefined };
    publish();
    try {
      const protocol = locationInfo?.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocketConstructor(`${protocol}//${locationInfo?.host ?? ""}/ws`);
    } catch {
      state = { ...state, connection: "error", errorMessage: "The phone companion could not open a connection.", commandPending: undefined };
      publish();
      scheduleReconnect();
      return;
    }
    const currentSocket = socket;
    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket || stopped) return;
      state = { ...state, connection: "connected", reconnectAttempt: 0, errorMessage: undefined };
      publish();
    });
    currentSocket.addEventListener("message", (event) => {
      if (socket === currentSocket && !stopped) handleMessage(event?.data);
    });
    currentSocket.addEventListener("error", () => {
      if (socket === currentSocket && !stopped && state.connection !== "revoked") {
        state = { ...state, connection: "error", errorMessage: "The phone companion connection failed." };
        publish();
      }
    });
    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket || stopped) return;
      socket = null;
      if (state.connection === "revoked") return;
      state = { ...state, connection: "disconnected", commandPending: undefined };
      publish();
      scheduleReconnect();
    });
  }

  const restart = () => {
    stopped = false;
    reconnectGeneration += 1;
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
    const previousSocket = socket;
    socket = null;
    if (previousSocket && previousSocket.readyState !== 3) {
      try {
        previousSocket.close();
      } catch {
        // A closing socket cannot prevent an explicit retry.
      }
    }
    state = { ...state, connection: "connecting", reconnectAttempt: 0, errorMessage: undefined, commandPending: undefined };
    publish();
    connect();
  };

  publish();
  connect();
  return {
    getState: () => ({ ...state, ...(state.snapshot ? { snapshot: cloneProjection(state.snapshot) } : {}) }),
    sendCommand,
    stop: () => {
      stopped = true;
      reconnectGeneration += 1;
      if (reconnectTimer !== null) clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
    },
    restart,
    retry: restart,
  };
}

if (typeof document !== "undefined") {
  const root = document.getElementById("phone-app");
  if (root) {
    startPhoneClient(root);
  }
}
