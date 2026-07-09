import { HomeConnectClient } from "./client";
import { StateMapper } from "./stateMapper";
import { ApplianceProfile, ConfiguredDevice, HcMessage } from "./types";

export const WATCHDOG_HEARTBEAT_REQUEST: HcMessage = { resource: "/ni/info", version: 1, action: "GET" };

export function calculateIdleSeconds(lastRxAt: number | undefined, now = Date.now()): number {
  const effectiveLastRxAt = lastRxAt ?? now;
  return Math.max(0, Math.floor((now - effectiveLastRxAt) / 1000));
}

export interface RunningDevice {
  baseId: string;
  config: ConfiguredDevice;
  profile: ApplianceProfile;
  mapper: StateMapper;
  client?: HomeConnectClient;
  reconnectTimer?: NodeJS.Timeout;
  watchdogHeartbeatInFlight?: boolean;
  lastRxAt?: number;
  lastRoRxAt?: number;
  watchdogReconnectCount: number;
  reconnecting: boolean;
  reconnectFailures: number;
  connected: boolean;
  writableUids: Set<string>;
  readOnlyUids: Set<string>;
  blockedCommands: string[];
  stateValuesByFeature: Map<string, ioBroker.StateValue>;
  rawValuesByFeature: Map<string, unknown>;
  eventValuesByFeature: Map<string, ioBroker.StateValue>;
  programExecutionByFeature: Map<string, string>;
  lastSelectedProgramRaw?: unknown;
  lastOptionContextProgramRaw?: unknown;
}

export function recordHomeConnectFrame(device: RunningDevice, resource?: string, now = Date.now()): void {
  device.lastRxAt = now;
  if (resource === "/ro/values" || resource === "/ro/descriptionChange" || resource === "/ro/allMandatoryValues") {
    device.lastRoRxAt = now;
  }
}

export function shouldHeartbeatDevice(device: RunningDevice, now = Date.now(), maxIdleMs = 5 * 60 * 1000): boolean {
  if (!device.connected || device.reconnecting || device.watchdogHeartbeatInFlight || !device.client) return false;
  const lastRxAt = device.lastRxAt ?? now;
  return now - lastRxAt >= maxIdleMs;
}

export type WritableStateKind = "value" | "command" | "startProgram" | "startProgramWithOptions" | "startProgramName";

export interface WritableState {
  deviceHaId: string;
  uid: number;
  featureName: string;
  kind: WritableStateKind;
  stateId: string;
}
