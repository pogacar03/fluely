export interface PhoneGatewayStartupOptions<TSettings, TResult> {
  settings: TSettings;
  screenshotReady: () => Promise<void>;
  attachmentReady: () => Promise<void>;
  initializeGateway: (settings: TSettings) => Promise<TResult>;
}

/** Keeps pairing behind the two stores whose snapshots and media paths it exposes. */
export async function initializePhoneGatewayAfterStoresReady<TSettings, TResult>(
  options: PhoneGatewayStartupOptions<TSettings, TResult>,
): Promise<TResult> {
  await Promise.all([options.screenshotReady(), options.attachmentReady()]);
  return options.initializeGateway(options.settings);
}
