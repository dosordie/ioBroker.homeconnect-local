export const DEFAULT_POWER_RESET_THRESHOLD_WATTS = 5;
export const DEFAULT_POWER_RESET_IDLE_MINUTES = 15;
export const DEFAULT_POWER_RESET_FAILURES = 3;
export const POWER_RESET_OFF_MS = 10_000;
export const POWER_MEASUREMENT_MAX_AGE_MS = 2 * 60_000;
export const DEFAULT_WIFI_RECONNECT_WAIT_MINUTES = 2;
// Keep the trigger asserted long enough for polling automations (for example a
// Node-RED poll running every few seconds) to observe the true value reliably.
export const WIFI_RECONNECT_PULSE_MS = 10_000;

export interface PowerResetSafetyInput {
  enabled: boolean;
  failures: number;
  requiredFailures: number;
  watts: unknown;
  measurementTimestamp?: number;
  lowPowerSince?: number;
  now: number;
  thresholdWatts: number;
  idleMs: number;
  resetInProgress: boolean;
  powerSwitchFeedback: unknown;
}

export type StagedRecoveryAction = "none" | "wifiReconnect" | "waitForWifi" | "powerReset" | "lockedUntilRecovery";

export function stagedRecoveryAction(failures: number, requiredFailures: number, wifiTriggered: boolean, wifiWaitElapsed: boolean, powerResetPerformed: boolean): StagedRecoveryAction {
  if (failures < requiredFailures) return "none";
  if (!wifiTriggered) return "wifiReconnect";
  if (!wifiWaitElapsed) return "waitForWifi";
  if (powerResetPerformed) return "lockedUntilRecovery";
  return "powerReset";
}

export function wifiReconnectPulseValue(useMac: boolean, configuredMac?: string, profileMac?: string): boolean | string {
  if (!useMac) return true;
  return String(configuredMac || profileMac || "").trim();
}

export function shouldRestoreWifiReconnectLatch(enablePowerReset: boolean): boolean {
  // The timestamp is a safety latch for the second stage: it prevents an
  // adapter restart from allowing another immediate power cut. A standalone
  // Wi-Fi recovery has no destructive second stage, so a restart must begin a
  // fresh failure episode and allow its boolean/MAC pulse to fire again.
  return enablePowerReset;
}

export function powerResetBlockReason(input: PowerResetSafetyInput): string | undefined {
  if (!input.enabled) return "power reset is disabled";
  if (input.resetInProgress) return "a power reset is already in progress";
  if (input.failures < input.requiredFailures) return "not enough communication failures";
  if (input.powerSwitchFeedback !== true) return "power switch feedback is not confirmed on";
  if (typeof input.watts !== "number" || !Number.isFinite(input.watts) || input.watts < 0) return "power measurement is missing or invalid";
  if (input.measurementTimestamp === undefined || input.now - input.measurementTimestamp > POWER_MEASUREMENT_MAX_AGE_MS) return "power measurement is stale";
  if (input.watts >= input.thresholdWatts) return "appliance is not below the idle power threshold";
  if (input.lowPowerSince === undefined || input.now - input.lowPowerSince < input.idleMs) return "idle power has not been observed long enough";
  return undefined;
}
