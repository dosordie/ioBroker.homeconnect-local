import { lastMeaningfulNamePart, normalizeUid, sanitizeObjectId } from "./ids";
import { ApplianceProfile, RoValue, StateTarget } from "./types";

const PHASE_NAMES = new Set(["ProgramPhase", "ProcessPhase"]);

export class StateMapper {
  public constructor(private readonly profile: ApplianceProfile) {}

  public valuesFromMessageData(data: unknown): RoValue[] {
    if (!Array.isArray(data)) {
      return [];
    }

    const result: RoValue[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as RoValue;
      if (record.uid !== undefined) {
        result.push(record);
      }
    }

    return result;
  }

  public toStateTarget(value: RoValue): StateTarget | undefined {
    const uid = normalizeUid(value.uid);
    if (!uid) {
      return undefined;
    }

    const featureName = this.profile.featureMapping.featuresByUid[uid] ?? `uid_${uid}`;
    const rawStateName = lastMeaningfulNamePart(featureName);
    const stateName = sanitizeObjectId(this.stateNameFor(featureName, rawStateName));
    const category = this.categoryFor(featureName, stateName);
    const translatedValue = this.translateValue(uid, value.value);
    const id = `${category}.${stateName}`;

    return {
      id,
      name: featureName,
      value: translatedValue,
      rawValue: value.value,
      category,
      uid,
    };
  }

  public describeUid(uid: number | string | undefined): string | undefined {
    const normalized = normalizeUid(uid);
    if (!normalized) {
      return undefined;
    }

    return this.profile.featureMapping.featuresByUid[normalized];
  }

  private stateNameFor(featureName: string, rawStateName: string): string {
    if (featureName.includes(".Root.")) {
      return `Root${rawStateName}`;
    }

    return rawStateName;
  }

  private categoryFor(featureName: string, stateName: string): string {
    if (PHASE_NAMES.has(stateName)) {
      return "phases";
    }

    if (featureName.includes(".Root.")) {
      return "program";
    }

    if (featureName.includes(".Status.")) {
      return "status";
    }

    if (featureName.includes(".Option.")) {
      return "options";
    }

    if (featureName.includes(".Setting.")) {
      return "settings";
    }

    if (featureName.includes(".Command.")) {
      return "commands";
    }

    if (featureName.includes(".Event.")) {
      return "events";
    }

    if (featureName.includes(".Program.")) {
      return "programs";
    }

    return "raw";
  }

  private translateValue(uid: string, rawValue: unknown): ioBroker.StateValue {
    if (rawValue === undefined || rawValue === null) {
      return null;
    }

    const enumType = this.profile.featureMapping.enumTypeByUid[uid];
    if (enumType) {
      const enumMap = this.profile.featureMapping.enumValuesByType[enumType];
      const key = String(rawValue);
      const mapped = enumMap?.[key];
      if (mapped !== undefined) {
        return mapped;
      }
    }

    if (typeof rawValue === "number") {
      const valueUid = normalizeUid(rawValue);
      if (valueUid) {
        const feature = this.profile.featureMapping.featuresByUid[valueUid];
        if (feature) {
          return feature;
        }
      }
    }

    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
      return rawValue;
    }

    return JSON.stringify(rawValue);
  }
}
