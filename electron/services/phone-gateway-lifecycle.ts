import type {
  FluelySettings,
  IpcError,
  IpcResult,
  PhoneGatewaySettings,
  PhoneGatewayStatus,
  PhoneGatewayStatusListener,
  SettingsPatch,
} from "../../src/shared/ipc";
import type { PhoneGatewayHandlerService } from "./ipcHandlers";

export interface PhoneGatewayLifecycleGateway {
  getStatus(): PhoneGatewayStatus;
  start(): Promise<PhoneGatewayStatus>;
  stop(): Promise<PhoneGatewayStatus>;
  regeneratePairing(): Promise<PhoneGatewayStatus>;
  onStatusChanged?(listener: PhoneGatewayStatusListener): () => void;
}

export interface PhoneGatewaySettingsStore {
  update(patch: SettingsPatch): Promise<IpcResult<FluelySettings>>;
}

export interface PhoneGatewayLifecycleOptions {
  gateway: PhoneGatewayLifecycleGateway;
  settings: PhoneGatewaySettingsStore;
  notifyStatus?: PhoneGatewayStatusListener;
}

export interface PhoneGatewayLifecycle {
  handler: PhoneGatewayHandlerService;
  initialize(settings: PhoneGatewaySettings): Promise<PhoneGatewayStatus>;
  applySettings(settings: PhoneGatewaySettings): Promise<PhoneGatewayStatus>;
  dispose(): Promise<void>;
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error };
}

function gatewayFailure(): IpcError {
  return {
    code: "INTERNAL_ERROR",
    message: "Fluely could not update the phone companion.",
    action: "Restart Fluely and try again.",
  };
}

export function createPhoneGatewayLifecycle({
  gateway,
  settings,
  notifyStatus,
}: PhoneGatewayLifecycleOptions): PhoneGatewayLifecycle {
  let unsubscribeStatus: (() => void) | undefined;
  if (notifyStatus && gateway.onStatusChanged) {
    unsubscribeStatus = gateway.onStatusChanged(notifyStatus);
  }

  const applySettings = async (nextSettings: PhoneGatewaySettings): Promise<PhoneGatewayStatus> => {
    const status = nextSettings.enabled
      ? await gateway.start()
      : await gateway.stop();
    if (!unsubscribeStatus) {
      notifyStatus?.(status);
    }
    return status;
  };

  const persistAndApply = async (enabled: boolean): Promise<IpcResult<PhoneGatewayStatus>> => {
    try {
      const result = await settings.update({ phoneGateway: { enabled } });
      if (!result.ok) {
        return failure<PhoneGatewayStatus>(result.error);
      }
      return success(await applySettings({ enabled }));
    } catch {
      return failure<PhoneGatewayStatus>(gatewayFailure());
    }
  };

  const handler: PhoneGatewayHandlerService = {
    getStatus: () => gateway.getStatus(),
    enable: () => persistAndApply(true),
    disable: () => persistAndApply(false),
    regeneratePairing: async () => {
      try {
        return success(await gateway.regeneratePairing());
      } catch {
        return failure<PhoneGatewayStatus>(gatewayFailure());
      }
    },
  };

  return {
    handler,
    initialize: applySettings,
    applySettings,
    dispose: async () => {
      try {
        await gateway.stop();
      } finally {
        unsubscribeStatus?.();
        unsubscribeStatus = undefined;
      }
    },
  };
}
