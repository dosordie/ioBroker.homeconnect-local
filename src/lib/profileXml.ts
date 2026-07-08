import { XMLParser } from "fast-xml-parser";

import { FeatureMapping, ProgramOptionDescription } from "./types";
import { normalizeUid } from "./ids";

export function parseFeatureMapping(featureMappingXml: string, deviceDescriptionXml: string): FeatureMapping {
  return {
    featuresByUid: parseFeatureNames(featureMappingXml),
    enumTypeByUid: parseEnumTypeReferences(deviceDescriptionXml),
    enumValuesByType: {
      ...parseDeviceDescriptionEnumValues(deviceDescriptionXml),
      ...parseFeatureMappingEnumValues(featureMappingXml),
    },
    programOptionsByUid: parseProgramOptions(deviceDescriptionXml),
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


function parseProgramOptions(xml: string): Record<string, ProgramOptionDescription[]> {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  }).parse(xml) as unknown;
  const result: Record<string, ProgramOptionDescription[]> = {};

  visitXml(parsed, (name, element) => {
    if (name.toLowerCase() !== "program" || !isXmlElement(element)) return;

    const programUid = uidFromElement(element, ["uid", "refUID", "refUid"]);
    if (!programUid) return;

    const options = parseOptions(element);
    if (options.length > 0) {
      result[programUid] = options;
    }
  });

  return result;
}

function parseOptions(element: Record<string, unknown>): ProgramOptionDescription[] {
  const result = new Map<string, ProgramOptionDescription>();
  const addOption = (optionElement: unknown): void => {
    if (!isXmlElement(optionElement)) return;
    const refUID = uidFromElement(optionElement, ["refUID", "refUid", "uid"]);
    if (!refUID) return;

    result.set(refUID, {
      refUID,
      access: stringAttribute(optionElement, "access"),
      available: booleanAttribute(optionElement, "available"),
      default: optionElement.default,
    });
  };

  for (const option of arrayValues(element.option)) addOption(option);

  for (const containerName of ["options", "programOptions"]) {
    for (const container of arrayValues(element[containerName])) {
      if (!isXmlElement(container)) continue;
      for (const option of arrayValues(container.option)) addOption(option);
      for (const option of arrayValues(container.optionRef)) addOption(option);
      for (const option of arrayValues(container.programOption)) addOption(option);
    }
  }

  return [...result.values()];
}

function visitXml(value: unknown, visitor: (name: string, element: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitXml(item, visitor);
    return;
  }

  if (!isXmlElement(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (isAttributeOrTextKey(key)) continue;
    for (const item of arrayValues(child)) {
      visitor(key, item);
      visitXml(item, visitor);
    }
  }
}

function uidFromElement(element: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const uid = normalizeUid(stringAttribute(element, name));
    if (uid) return uid;
  }
  return undefined;
}

function stringAttribute(element: Record<string, unknown>, name: string): string | undefined {
  const value = element[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function booleanAttribute(element: Record<string, unknown>, name: string): boolean | undefined {
  const value = stringAttribute(element, name);
  if (value === undefined) return undefined;
  if (/^(true|1)$/i.test(value)) return true;
  if (/^(false|0)$/i.test(value)) return false;
  return undefined;
}

function arrayValues(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isXmlElement(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAttributeOrTextKey(key: string): boolean {
  return key === "#text" || key === "__text";
}
