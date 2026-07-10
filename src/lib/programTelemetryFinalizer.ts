import { StateMapper } from "./stateMapper";
import { ApplianceProfile } from "./types";

export const PROGRAM_PROGRESS_FEATURE = "BSH.Common.Option.ProgramProgress";
export const REMAINING_PROGRAM_TIME_FEATURE = "BSH.Common.Option.RemainingProgramTime";
export const OPERATION_STATE_FEATURE = "BSH.Common.Status.OperationState";
export const PROGRAM_FINISHED_EVENT_FEATURE = "BSH.Common.Event.ProgramFinished";
const IDLE_OPERATION_STATES = new Set(["ready", "off", "inactive"]);
const OFF_EFFECTIVE_POWER_STATES = new Set(["off", "mainsoff", "offline"]);

const FINAL_PHASE_FEATURES = [
  "Dishcare.Dishwasher.Status.ProgramPhase",
  "LaundryCare.Common.Option.ProcessPhase",
  "LaundryCare.Dryer.Option.ProcessPhase",
];

export interface FinalProgramTelemetryTarget {
  feature: string;
  value: ioBroker.StateValue;
  stateId: string;
}

export function isFinishedOperationState(value: ioBroker.StateValue): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "finished";
}

export function isIdleOperationState(value: ioBroker.StateValue): boolean {
  return typeof value === "string" && IDLE_OPERATION_STATES.has(value.trim().toLowerCase());
}

export function isNoActiveProgramValue(value: ioBroker.StateValue): boolean {
  if (value === 0) return true;
  return typeof value === "string" && value.trim() === "0";
}

export function isOffEffectivePowerState(value: ioBroker.StateValue): boolean {
  return typeof value === "string" && OFF_EFFECTIVE_POWER_STATES.has(value.trim().toLowerCase());
}

export function isActiveProgramFinishedEventValue(value: ioBroker.StateValue): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "off" || normalized === "false" || normalized === "0") return false;
  if (normalized === "present" || normalized === "confirmed" || normalized === "true" || normalized === "1") return true;
  return true;
}

export function coerceStateValueForObjectType(value: ioBroker.StateValue, type: ioBroker.CommonType | undefined): ioBroker.StateValue {
  if (type === "string" && typeof value !== "string") return String(value);
  if (type === "number" && typeof value === "string" && value !== "") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  return value;
}

export function finalProgramTelemetryTargets(profile: ApplianceProfile, baseId: string): FinalProgramTelemetryTarget[] {
  const mapper = new StateMapper(profile);
  const targets: FinalProgramTelemetryTarget[] = [];
  addTarget(profile, mapper, baseId, targets, PROGRAM_PROGRESS_FEATURE, 100);
  addTarget(profile, mapper, baseId, targets, REMAINING_PROGRAM_TIME_FEATURE, 0);
  return targets;
}

export function finalProgramEndDisplayTargets(profile: ApplianceProfile, baseId: string): FinalProgramTelemetryTarget[] {
  const mapper = new StateMapper(profile);
  const targets = finalProgramTelemetryTargets(profile, baseId);
  for (const feature of FINAL_PHASE_FEATURES) {
    addTarget(profile, mapper, baseId, targets, feature, "Finished");
  }
  return targets;
}

export function finalProgramEndCompanionTargets(profile: ApplianceProfile, baseId: string): FinalProgramTelemetryTarget[] {
  return finalProgramEndDisplayTargets(profile, baseId)
    .filter(target => target.value === "Finished")
    .map(target => ({ feature: `${target.feature}_de`, value: "Fertig", stateId: `${target.stateId}_de` }));
}

export function clearProgramPhaseDisplayTargets(profile: ApplianceProfile, baseId: string): FinalProgramTelemetryTarget[] {
  const mapper = new StateMapper(profile);
  const targets: FinalProgramTelemetryTarget[] = [];
  for (const feature of FINAL_PHASE_FEATURES) {
    addTarget(profile, mapper, baseId, targets, feature, "");
  }
  return targets.flatMap(target => [
    target,
    { feature: `${target.feature}_de`, value: "", stateId: `${target.stateId}_de` },
  ]);
}

export function nonEmptyClearProgramPhaseDisplayTargets(
  targets: FinalProgramTelemetryTarget[],
  currentValuesByFeature: ReadonlyMap<string, ioBroker.StateValue>,
): FinalProgramTelemetryTarget[] {
  return targets.filter(target => currentValuesByFeature.get(target.feature) !== "");
}

function addTarget(
  profile: ApplianceProfile,
  mapper: StateMapper,
  baseId: string,
  targets: FinalProgramTelemetryTarget[],
  feature: string,
  value: ioBroker.StateValue,
): void {
  const uid = Object.entries(profile.featureMapping.featuresByUid).find(([, mappedFeature]) => mappedFeature === feature)?.[0];
  if (!uid) return;
  const target = mapper.toStateTarget({ uid, value });
  if (!target || target.name !== feature) return;
  targets.push({ feature, value, stateId: `${baseId}.${target.id}` });
}
