import { ApplianceProfile, ProgramOptionDescription } from "./types";
import { normalizeUid } from "./ids";

const PROGRAM_OPTION_TELEMETRY_DENYLIST = new Set([
  "BSH.Common.Option.EnergyForecast",
  "BSH.Common.Option.WaterForecast",
  "BSH.Common.Option.ProgramProgress",
  "BSH.Common.Option.RemainingProgramTime",
  "BSH.Common.Option.RemainingProgramTimeIsEstimated",
  "BSH.Common.Option.EstimatedTotalProgramTime",
  "BSH.Common.Option.ElapsedProgramTime",
  "LaundryCare.Common.Option.LoadRecommendation",
  "LaundryCare.Common.Option.ReferToProgram",
  "LaundryCare.Common.Option.ProcessPhase",
  "BSH.Common.Option.ProgramName",
  "BSH.Common.Option.BaseProgram",
  "LaundryCare.Dryer.Option.ConnectedDry.OriginalProgramTime",
]);

export function normalizedAccess(access: unknown): string {
  return typeof access === "string" ? access.replace(/[^a-z]/gi, "").toLowerCase() : "";
}

export function isWritableAccess(access: unknown): boolean {
  const normalized = normalizedAccess(access);
  return normalized === "readwrite" || normalized === "write";
}

export function isReadOnlyProgramOption(featureName: string | undefined): boolean {
  return featureName !== undefined && PROGRAM_OPTION_TELEMETRY_DENYLIST.has(featureName);
}

export function isProgramOptionAvailable(programOption: ProgramOptionDescription): boolean {
  return programOption.available !== false;
}

export function isProgramOptionDescriptionWritable(programOption: ProgramOptionDescription): boolean {
  return isProgramOptionAvailable(programOption) && isWritableAccess(programOption.access);
}

export function hasWritableProgramOption(profile: ApplianceProfile, uid: string): boolean {
  const normalizedTargetUid = normalizeUid(uid);
  if (!normalizedTargetUid) return false;
  const featureName = profile.featureMapping.featuresByUid[normalizedTargetUid];
  if (isReadOnlyProgramOption(featureName)) return false;

  return Object.values(profile.featureMapping.programOptionsByUid).some(programOptions =>
    programOptions.some(programOption => normalizeUid(programOption.refUID) === normalizedTargetUid && isProgramOptionDescriptionWritable(programOption)),
  );
}
