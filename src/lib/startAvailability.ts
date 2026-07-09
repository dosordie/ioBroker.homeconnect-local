import { ACTIVE_PROGRAM_FEATURE, POWER_STATE_OFF, POWER_STATE_ON, SELECTED_PROGRAM_FEATURE } from "./constants";
import { normalizeUid } from "./ids";
import { RunningDevice } from "./runtimeTypes";

export type StartBlockedReason =
  | "ready"
  | "not_connected"
  | "door_open"
  | "already_running"
  | "no_selected_program"
  | "remote_start_not_allowed"
  | "power_off"
  | "active_program_not_writable"
  | "unknown";

export interface StartAvailability {
  canStart: boolean;
  reason: StartBlockedReason;
  reasonDe: string;
}

const DOOR_STATE_FEATURE = "BSH.Common.Status.DoorState";
const OPERATION_STATE_FEATURE = "BSH.Common.Status.OperationState";
const REMOTE_CONTROL_START_ALLOWED_FEATURE = "BSH.Common.Status.RemoteControlStartAllowed";
const POWER_STATE_FEATURE = "BSH.Common.Setting.PowerState";

const REASON_DE: Record<StartBlockedReason, string> = {
  ready: "startbereit",
  not_connected: "Gerät nicht verbunden",
  door_open: "Tür offen",
  already_running: "Programm läuft bereits",
  no_selected_program: "Kein Programm ausgewählt",
  remote_start_not_allowed: "Fernstart nicht erlaubt",
  power_off: "Gerät ist ausgeschaltet",
  active_program_not_writable: "ActiveProgram aktuell nicht schreibbar",
  unknown: "unbekannt",
};

export function evaluateStartAvailability(device: RunningDevice, connected: boolean): StartAvailability {
  if (!connected) return availability("not_connected");

  const doorState = normalizeDoorState(featureValue(device, DOOR_STATE_FEATURE));
  if (doorState === "open" || doorState === "ajar") return availability("door_open");

  const operationState = normalizeOperationState(featureValue(device, OPERATION_STATE_FEATURE));
  if (operationState === "running") return availability("already_running");

  if (!hasSelectedProgram(device)) return availability("no_selected_program");

  if (isDishwasher(device) || isWasher(device) || isDryer(device)) {
    const remoteValue = featureValue(device, REMOTE_CONTROL_START_ALLOWED_FEATURE);
    if (remoteValue !== undefined && remoteValue !== true) return availability("remote_start_not_allowed");
  }

  if (isWasher(device) || isDryer(device)) {
    const powerState = normalizePowerState(featureValue(device, POWER_STATE_FEATURE));
    if (powerState === "off") return availability("power_off");
  }

  if (isActiveProgramLiveReadOnly(device)) return availability("active_program_not_writable");

  return availability("ready");
}

function availability(reason: StartBlockedReason): StartAvailability {
  return { canStart: reason === "ready", reason, reasonDe: REASON_DE[reason] };
}

function featureValue(device: RunningDevice, featureName: string): unknown {
  if (device.stateValuesByFeature.has(featureName)) return device.stateValuesByFeature.get(featureName);
  if (!device.rawValuesByFeature.has(featureName)) return undefined;
  const rawValue = device.rawValuesByFeature.get(featureName);
  return enumTextForRawValue(device, featureName, rawValue) ?? rawValue;
}

function enumTextForRawValue(device: RunningDevice, featureName: string, rawValue: unknown): string | undefined {
  const uid = Object.entries(device.profile.featureMapping.featuresByUid).find(([, feature]) => feature === featureName)?.[0];
  const normalizedUid = normalizeUid(uid);
  const enumType = normalizedUid ? device.profile.featureMapping.enumTypeByUid[normalizedUid] : undefined;
  if (!enumType) return undefined;
  return device.profile.featureMapping.enumValuesByType[enumType]?.[String(rawValue)];
}

function hasSelectedProgram(device: RunningDevice): boolean {
  const value = featureValue(device, SELECTED_PROGRAM_FEATURE);
  return value !== undefined && value !== null && value !== "";
}

function normalizeDoorState(value: unknown): "open" | "ajar" | "closed" | "locked" | undefined {
  const normalized = normalizeEnumLike(value);
  if (normalized === "open") return "open";
  if (normalized === "ajar") return "ajar";
  if (normalized === "closed") return "closed";
  if (normalized === "locked") return "locked";
  return undefined;
}

function normalizeOperationState(value: unknown): "running" | undefined {
  const normalized = normalizeEnumLike(value);
  return normalized === "run" || normalized === "running" ? "running" : undefined;
}

function normalizePowerState(value: unknown): "on" | "off" | undefined {
  if (value === POWER_STATE_ON) return "on";
  if (value === POWER_STATE_OFF) return "off";
  const normalized = normalizeEnumLike(value);
  if (normalized === "on") return "on";
  if (normalized === "mainsoff" || normalized === "off" || normalized === "standby") return "off";
  return undefined;
}

function normalizeEnumLike(value: unknown): string {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return "";
  return value.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
}

function isDishwasher(device: RunningDevice): boolean {
  return normalizedDeviceType(device).includes("dishwasher");
}

function isWasher(device: RunningDevice): boolean {
  const type = normalizedDeviceType(device);
  return !type.includes("dishwasher") && (type.includes("washer") || type.includes("washingmachine"));
}

function isDryer(device: RunningDevice): boolean {
  return normalizedDeviceType(device).includes("dryer");
}

function normalizedDeviceType(device: RunningDevice): string {
  return `${device.profile.type ?? ""} ${device.config.type ?? ""}`.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isActiveProgramLiveReadOnly(device: RunningDevice): boolean {
  const activeProgramUid = Object.entries(device.profile.featureMapping.featuresByUid).find(([, feature]) => feature === ACTIVE_PROGRAM_FEATURE)?.[0];
  const normalizedActiveProgramUid = normalizeUid(activeProgramUid);
  return normalizedActiveProgramUid !== undefined && device.readOnlyUids.has(normalizedActiveProgramUid);
}
