import { normalizeUid } from "./ids";
import { ApplianceProfile } from "./types";

export function toStateValue(value: unknown): ioBroker.StateValue {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

export function durationToSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return Number(record.hours ?? 0) * 3600 + Number(record.minutes ?? 0) * 60 + Number(record.seconds ?? 0);
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function isTruthyWrite(value: ioBroker.StateValue): boolean {
  return value === true || value === 1 || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "1";
}

export function stateValueToPowerBoolean(value: ioBroker.StateValue): boolean {
  if (value === true || value === 1) {
    return true;
  }

  if (value === false || value === 0) {
    return false;
  }

  const text = String(value).toLowerCase();
  return text === "on" || text.endsWith(".on") || text === "true" || text === "1" || text === "ein";
}

export function stateValueToRaw(profile: ApplianceProfile, uid: number, value: ioBroker.StateValue): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalizedUid = normalizeUid(uid);
  if (!normalizedUid) {
    return value;
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  const text = String(value);
  const numericText = Number(text);
  if (text.trim() !== "" && Number.isFinite(numericText)) {
    return numericText;
  }

  const enumType = profile.featureMapping.enumTypeByUid[normalizedUid];
  if (enumType) {
    const enumMap = profile.featureMapping.enumValuesByType[enumType] ?? {};
    const lower = text.toLowerCase();
    for (const [raw, label] of Object.entries(enumMap)) {
      if (String(label).toLowerCase() === lower || String(label).split(".").pop()?.toLowerCase() === lower) {
        const rawNumeric = Number(raw);
        return Number.isFinite(rawNumeric) ? rawNumeric : raw;
      }
    }
  }

  const wanted = text.toLowerCase();
  for (const [rawUid, featureName] of Object.entries(profile.featureMapping.featuresByUid)) {
    const lastPart = featureName.split(".").pop()?.toLowerCase();
    if (featureName.toLowerCase() === wanted || lastPart === wanted) {
      const rawNumeric = Number.parseInt(rawUid, 16);
      return Number.isFinite(rawNumeric) ? rawNumeric : rawUid;
    }
  }

  return value;
}
