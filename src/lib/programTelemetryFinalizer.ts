import { StateMapper } from "./stateMapper";
import { ApplianceProfile } from "./types";

export const PROGRAM_PROGRESS_FEATURE = "BSH.Common.Option.ProgramProgress";
export const REMAINING_PROGRAM_TIME_FEATURE = "BSH.Common.Option.RemainingProgramTime";
export const OPERATION_STATE_FEATURE = "BSH.Common.Status.OperationState";
export const PROGRAM_FINISHED_EVENT_FEATURE = "BSH.Common.Event.ProgramFinished";

export interface FinalProgramTelemetryTarget {
  feature: string;
  value: ioBroker.StateValue;
  stateId: string;
}

export function isFinishedOperationState(value: ioBroker.StateValue): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "finished";
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

export function finalProgramTelemetryTargets(profile: ApplianceProfile, baseId: string): FinalProgramTelemetryTarget[] {
  const mapper = new StateMapper(profile);
  const targets: FinalProgramTelemetryTarget[] = [];
  addTarget(profile, mapper, baseId, targets, PROGRAM_PROGRESS_FEATURE, 100);
  addTarget(profile, mapper, baseId, targets, REMAINING_PROGRAM_TIME_FEATURE, 0);
  return targets;
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
