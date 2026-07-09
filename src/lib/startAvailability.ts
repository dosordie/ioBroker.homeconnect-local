import { ACTIVE_PROGRAM_FEATURE, POWER_STATE_OFF, POWER_STATE_ON, SELECTED_PROGRAM_FEATURE } from "./constants";
import { RunningDevice } from "./runtimeTypes";

const DOOR_STATE_FEATURE = "BSH.Common.Status.DoorState";
const OPERATION_STATE_FEATURE = "BSH.Common.Status.OperationState";
const POWER_STATE_FEATURE = "BSH.Common.Setting.PowerState";
const REMOTE_CONTROL_START_ALLOWED_FEATURE = "BSH.Common.Status.RemoteControlStartAllowed";

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

  const doorState = normalizedFeatureValue(device, DOOR_STATE_FEATURE);
  if (doorState === "open" || doorState === "ajar") return availability("door_open");

  const operationState = normalizedFeatureValue(device, OPERATION_STATE_FEATURE);
  if (operationState === "run" || operationState === "running") return availability("already_running");

  if (!hasSelectedProgram(device)) return availability("no_selected_program");

  if (activeProgramReadOnly(device)) return availability("active_program_not_writable");

  if (isDishwasher(device) || isWasher(device) || isDryer(device)) {
    const remoteStartAllowed = normalizedFeatureValue(device, REMOTE_CONTROL_START_ALLOWED_FEATURE);
    if (remoteStartAllowed !== undefined && remoteStartAllowed !== "true") return availability("remote_start_not_allowed");
  }

  if (isWasher(device) || isDryer(device)) {
    const powerState = normalizedFeatureValue(device, POWER_STATE_FEATURE);
    if (powerState === "off" || powerState === "mainsoff" || powerState === "false") return availability("power_off");
  }

  return availability("ready");
}

function availability(reason: StartBlockedReason): StartAvailability {
  return { canStart: reason === "ready", reason, reasonDe: REASON_DE[reason] };
}

function hasSelectedProgram(device: RunningDevice): boolean {
  const selected = featureValue(device, SELECTED_PROGRAM_FEATURE);
  if (selected !== undefined && selected !== null && selected !== "") return true;
  const rootSelected = featureValue(device, "BSH.Common.Root.SelectedProgram");
  return rootSelected !== undefined && rootSelected !== null && rootSelected !== "";
}

function activeProgramReadOnly(device: RunningDevice): boolean {
  const uid = uidForFeature(device, ACTIVE_PROGRAM_FEATURE);
  return uid !== undefined && device.readOnlyUids.has(uid) && !device.writableUids.has(uid);
}

function normalizedFeatureValue(device: RunningDevice, featureName: string): string | undefined {
  const value = featureValue(device, featureName);
  if (value === undefined || value === null) return undefined;
  if (featureName === POWER_STATE_FEATURE) {
    if (value === POWER_STATE_ON || value === String(POWER_STATE_ON)) return "on";
    if (value === POWER_STATE_OFF || value === String(POWER_STATE_OFF)) return "off";
  }
  return String(value).trim().toLowerCase();
}

function featureValue(device: RunningDevice, featureName: string): unknown {
  if (device.stateValuesByFeature.has(featureName)) return device.stateValuesByFeature.get(featureName);
  if (!device.rawValuesByFeature.has(featureName)) return undefined;
  const rawValue = device.rawValuesByFeature.get(featureName);
  const enumText = enumTextForRawValue(device, featureName, rawValue);
  return enumText ?? rawValue;
}

function enumTextForRawValue(device: RunningDevice, featureName: string, rawValue: unknown): string | undefined {
  const uid = uidForFeature(device, featureName);
  if (!uid) return undefined;
  const enumType = device.profile.featureMapping.enumTypeByUid[uid];
  if (!enumType) return undefined;
  return device.profile.featureMapping.enumValuesByType[enumType]?.[String(rawValue)];
}

function uidForFeature(device: RunningDevice, featureName: string): string | undefined {
  return Object.entries(device.profile.featureMapping.featuresByUid).find(([, name]) => name === featureName)?.[0];
}

function typeText(device: RunningDevice): string {
  return String(device.config.type ?? device.profile.type ?? "").toLowerCase();
}

function isDishwasher(device: RunningDevice): boolean {
  return typeText(device).includes("dishwasher");
}

function isWasher(device: RunningDevice): boolean {
  const type = typeText(device);
  return !type.includes("dishwasher") && type.includes("washer");
}

function isDryer(device: RunningDevice): boolean {
  return typeText(device).includes("dryer");
}
