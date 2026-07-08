import { FeatureMapping } from "./types";
import { normalizeUid } from "./ids";

export function parseFeatureMapping(featureMappingXml: string, deviceDescriptionXml: string): FeatureMapping {
  return {
    featuresByUid: parseFeatureNames(featureMappingXml),
    enumTypeByUid: parseEnumTypeReferences(deviceDescriptionXml),
    enumValuesByType: {
      ...parseDeviceDescriptionEnumValues(deviceDescriptionXml),
      ...parseFeatureMappingEnumValues(featureMappingXml),
    },
  };
}

function parseFeatureNames(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /<feature\s+[^>]*refUID="([0-9A-Fa-f]+)"[^>]*>([^<]+)<\/feature>/g;

  for (const match of xml.matchAll(regex)) {
    const uid = normalizeUid(match[1]);
    if (uid) {
      result[uid] = match[2].trim();
    }
  }

  return result;
}

function parseEnumTypeReferences(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const elementRegex = /<[^!?][^>]*\suid="([0-9A-Fa-f]+)"[^>]*\senumerationType="([0-9A-Fa-f]+)"[^>]*>/g;
  const reverseElementRegex = /<[^!?][^>]*\senumerationType="([0-9A-Fa-f]+)"[^>]*\suid="([0-9A-Fa-f]+)"[^>]*>/g;

  for (const match of xml.matchAll(elementRegex)) {
    const uid = normalizeUid(match[1]);
    const enumType = normalizeUid(match[2]);
    if (uid && enumType) {
      result[uid] = enumType;
    }
  }

  for (const match of xml.matchAll(reverseElementRegex)) {
    const enumType = normalizeUid(match[1]);
    const uid = normalizeUid(match[2]);
    if (uid && enumType) {
      result[uid] = enumType;
    }
  }

  return result;
}

function parseDeviceDescriptionEnumValues(xml: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  const typeRegex = /<enumerationType\s+[^>]*enid="([0-9A-Fa-f]+)"[^>]*>([\s\S]*?)<\/enumerationType>/g;

  for (const typeMatch of xml.matchAll(typeRegex)) {
    const enumType = normalizeUid(typeMatch[1]);
    if (!enumType) {
      continue;
    }

    const values: Record<string, string> = {};
    const body = typeMatch[2];
    const withCommentRegex = /<!--\s*([^<]*?)\s*-->\s*<enumeration\s+[^>]*value="([^"]+)"[^>]*\/>/g;
    const plainRegex = /<enumeration\s+[^>]*value="([^"]+)"[^>]*\/>/g;

    for (const valueMatch of body.matchAll(withCommentRegex)) {
      values[valueMatch[2]] = valueMatch[1].trim();
    }

    for (const valueMatch of body.matchAll(plainRegex)) {
      values[valueMatch[1]] ??= valueMatch[1];
    }

    result[enumType] = values;
  }

  return result;
}

function parseFeatureMappingEnumValues(xml: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  const typeRegex = /<enumDescription\s+[^>]*refENID="([0-9A-Fa-f]+)"[^>]*>([\s\S]*?)<\/enumDescription>/g;

  for (const typeMatch of xml.matchAll(typeRegex)) {
    const enumType = normalizeUid(typeMatch[1]);
    if (!enumType) {
      continue;
    }

    const values: Record<string, string> = {};
    const body = typeMatch[2];
    const memberRegex = /<enumMember\s+[^>]*refValue="([^"]+)"[^>]*>([^<]+)<\/enumMember>/g;

    for (const valueMatch of body.matchAll(memberRegex)) {
      values[valueMatch[1]] = valueMatch[2].trim();
    }

    if (Object.keys(values).length > 0) {
      result[enumType] = values;
    }
  }

  return result;
}
