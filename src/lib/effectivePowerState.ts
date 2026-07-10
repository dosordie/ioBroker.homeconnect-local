import { translateEnumValue } from "./enumTranslations";
import { RunningDevice } from "./runtimeTypes";

export const POWER_STATE_FEATURE = "BSH.Common.Setting.PowerState";

export interface EffectivePowerState {
  effectivePowerState: string;
  effectivePowerStateDe: string;
  isEffectivelyOn: boolean;
}

export function evaluateEffectivePowerState(device: Pick<RunningDevice, "connected" | "stateValuesByFeature" | "rawValuesByFeature" | "profile">): EffectivePowerState {
  if (!device.connected) {
    return { effectivePowerState: "Offline", effectivePowerStateDe: "Aus / offline", isEffectivelyOn: false };
  }

  const powerState = resolvePowerState(device);
  const text = powerState === undefined || powerState === null || powerState === "" ? "Unknown" : String(powerState);
  const normalized = normalizePowerStateText(text);
  if (normalized === "On") return { effectivePowerState: normalized, effectivePowerStateDe: "Ein", isEffectivelyOn: true };
  if (normalized === "MainsOff" || normalized === "Off") return { effectivePowerState: normalized, effectivePowerStateDe: "Aus", isEffectivelyOn: false };
  if (normalized === "Standby") return { effectivePowerState: normalized, effectivePowerStateDe: "Standby", isEffectivelyOn: true };
  return { effectivePowerState: text, effectivePowerStateDe: translateEnumValue(POWER_STATE_FEATURE, text), isEffectivelyOn: true };
}

function resolvePowerState(device: Pick<RunningDevice, "stateValuesByFeature" | "rawValuesByFeature" | "profile">): ioBroker.StateValue | undefined {
  const stateValue = device.stateValuesByFeature.get(POWER_STATE_FEATURE);
  if (stateValue !== undefined && stateValue !== null && stateValue !== "") {
    const mappedStateValue = resolvePowerStateEnumText(device, stateValue);
    return mappedStateValue ?? stateValue;
  }

  const rawValue = device.rawValuesByFeature.get(POWER_STATE_FEATURE);
  const enumText = resolvePowerStateEnumText(device, rawValue);
  if (enumText !== undefined) return enumText;

  if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") return rawValue;
  return undefined;
}

function resolvePowerStateEnumText(device: Pick<RunningDevice, "profile">, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const uid = Object.entries(device.profile.featureMapping.featuresByUid).find(([, feature]) => feature === POWER_STATE_FEATURE)?.[0];
  const enumType = uid ? device.profile.featureMapping.enumTypeByUid[uid] : undefined;
  return enumType ? device.profile.featureMapping.enumValuesByType[enumType]?.[String(value)] : undefined;
}

function normalizePowerStateText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "On" || trimmed.endsWith(".On")) return "On";
  if (trimmed === "Off" || trimmed.endsWith(".Off")) return "Off";
  if (trimmed === "MainsOff" || trimmed.endsWith(".MainsOff")) return "MainsOff";
  if (trimmed === "Standby" || trimmed.endsWith(".Standby")) return "Standby";
  return trimmed;
}
