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
  if (text === "On") return { effectivePowerState: text, effectivePowerStateDe: "Ein", isEffectivelyOn: true };
  if (text === "MainsOff" || text === "Off") return { effectivePowerState: text, effectivePowerStateDe: "Aus", isEffectivelyOn: false };
  if (text === "Standby") return { effectivePowerState: text, effectivePowerStateDe: "Standby", isEffectivelyOn: true };
  return { effectivePowerState: text, effectivePowerStateDe: translateEnumValue(POWER_STATE_FEATURE, text), isEffectivelyOn: true };
}

function resolvePowerState(device: Pick<RunningDevice, "stateValuesByFeature" | "rawValuesByFeature" | "profile">): ioBroker.StateValue | undefined {
  const stateValue = device.stateValuesByFeature.get(POWER_STATE_FEATURE);
  if (stateValue !== undefined && stateValue !== null && stateValue !== "") return stateValue;

  const rawValue = device.rawValuesByFeature.get(POWER_STATE_FEATURE);
  const uid = Object.entries(device.profile.featureMapping.featuresByUid).find(([, feature]) => feature === POWER_STATE_FEATURE)?.[0];
  const enumType = uid ? device.profile.featureMapping.enumTypeByUid[uid] : undefined;
  const enumText = enumType ? device.profile.featureMapping.enumValuesByType[enumType]?.[String(rawValue)] : undefined;
  if (enumText !== undefined) return enumText;

  if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") return rawValue;
  return undefined;
}
