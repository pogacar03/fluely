export interface PhoneGatewaySettings {
  enabled: boolean;
}

export type PhoneGatewayStatus =
  | { state: "disabled" }
  | { state: "starting" }
  | {
    state: "ready";
    origin: string;
    qrDataUrl: string;
    pairingExpiresAt: number;
    paired: boolean;
  }
  | {
    state: "error";
    code: "no_lan_address" | "port_unavailable" | "start_failed";
    message: string;
  };

export type PhoneGatewayStatusListener = (status: PhoneGatewayStatus) => void;

export const PHONE_GATEWAY_PAIRING_TTL_MS = 120_000;

export const PHONE_GATEWAY_PORTS = [
  4123, 4124, 4125, 4126, 4127, 4128,
  4129, 4130, 4131, 4132, 4133, 4134,
] as const;

export const DEFAULT_PHONE_GATEWAY_SETTINGS: PhoneGatewaySettings = {
  enabled: false,
};
