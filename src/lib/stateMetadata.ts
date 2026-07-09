import { ApplianceProfile } from "./types";

export interface StateCommonMetadata {
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  states?: Record<string, string>;
}

const KNOWN_FEATURE_METADATA: Array<{ pattern: RegExp; metadata: StateCommonMetadata }> = [
  { pattern: /(?:RemainingTime|Duration|StartInRelative|FinishInRelative)$/i, metadata: { unit: "s" } },
  { pattern: /ProgramProgress$/i, metadata: { unit: "%", min: 0, max: 100 } },
  { pattern: /Temperature/i, metadata: { unit: "°C" } },
  { pattern: /(?:^|\.)Power(?:\.|$)/i, metadata: { unit: "W" } },
  { pattern: /Energy/i, metadata: { unit: "kWh" } },
  { pattern: /(?:WaterForecast|EnergyForecast)$/i, metadata: { unit: "%" } },
];

export function metadataForFeature(featureName: string, uid: string, profile: ApplianceProfile): StateCommonMetadata {
  const metadata: StateCommonMetadata = {};
  for (const entry of KNOWN_FEATURE_METADATA) {
    if (entry.pattern.test(featureName)) Object.assign(metadata, entry.metadata);
  }

  const enumType = profile.featureMapping.enumTypeByUid[uid];
  const enumValues = enumType ? profile.featureMapping.enumValuesByType[enumType] : undefined;
  if (enumValues && Object.keys(enumValues).length > 0) metadata.states = enumValues;
  return metadata;
}

export function metadataFromDescriptionChange(change: Record<string, unknown>): StateCommonMetadata {
  const metadata: StateCommonMetadata = {};
  copyNumber(change, metadata, "min", ["min", "minimum", "minValue"]);
  copyNumber(change, metadata, "max", ["max", "maximum", "maxValue"]);
  copyNumber(change, metadata, "step", ["step", "stepSize", "increment"]);
  const unit = firstString(change, ["unit", "unitOfMeasure"]);
  if (unit) metadata.unit = unit;
  return metadata;
}

function copyNumber(source: Record<string, unknown>, target: StateCommonMetadata, key: "min" | "max" | "step", names: string[]): void {
  for (const name of names) {
    const value = Number(source[name]);
    if (Number.isFinite(value)) {
      target[key] = value;
      return;
    }
  }
}

function firstString(source: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function mergeMetadata(...items: Array<StateCommonMetadata | undefined>): StateCommonMetadata | undefined {
  const merged: StateCommonMetadata = {};
  for (const item of items) if (item) Object.assign(merged, item);
  return Object.keys(merged).length > 0 ? merged : undefined;
}
