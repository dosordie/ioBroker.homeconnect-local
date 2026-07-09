import { START_IN_FEATURE } from "./constants";
import { ProgramOptionDescription } from "./types";

export interface StartOptionValue {
  uid: number;
  value: unknown;
}

export function mergeStartOptionValues(explicitOptions: StartOptionValue[], automaticOptions: StartOptionValue[]): StartOptionValue[] {
  const explicitUids = new Set(explicitOptions.map(option => option.uid));
  return [...explicitOptions, ...automaticOptions.filter(option => !explicitUids.has(option.uid))];
}

export function shouldSendAutomaticStartOption(featureName: string, value: unknown, programOption?: ProgramOptionDescription): boolean {
  if (featureName === START_IN_FEATURE && value === 0) return false;
  if (value === false) return false;
  if (programOption && valuesEqual(value, programOption.default)) return false;
  return true;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}
