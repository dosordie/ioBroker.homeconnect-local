import { START_IN_FEATURE } from "./constants";

export interface StartOptionValue {
  uid: number;
  value: unknown;
}

export function shouldSendAutomaticStartOption(featureName: string, rawValue: unknown, defaultValue?: unknown): boolean {
  if (rawValue === undefined || rawValue === null || rawValue === "") return false;
  if (featureName === START_IN_FEATURE && rawValue === 0) return false;
  if (rawValue === false) return false;
  if (defaultValue !== undefined && rawValue == defaultValue) return false;
  return true;
}

export function mergeStartOptionValues(explicitOptions: StartOptionValue[], automaticOptions: StartOptionValue[]): StartOptionValue[] {
  const explicitUids = new Set(explicitOptions.map(option => option.uid));
  return [...explicitOptions, ...automaticOptions.filter(option => !explicitUids.has(option.uid))];
}
