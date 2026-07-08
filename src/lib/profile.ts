import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";

import { ApplianceProfile, ApplianceProfileJson, FeatureMapping } from "./types";
import { normalizeUid } from "./ids";

interface ProfileFiles {
  baseDir: string;
  jsonPath: string;
  profile: ApplianceProfileJson;
}

export function loadProfiles(profilePath: string): ApplianceProfile[] {
  if (!profilePath) {
    return [];
  }

  const stat = fs.statSync(profilePath);
  const directories: string[] = [];

  if (stat.isDirectory()) {
    directories.push(profilePath);
  } else if (stat.isFile() && profilePath.toLowerCase().endsWith(".zip")) {
    directories.push(extractZipToTemp(profilePath));
  } else if (stat.isFile() && profilePath.toLowerCase().endsWith(".json")) {
    directories.push(path.dirname(profilePath));
  } else {
    throw new Error(`Unsupported profile path: ${profilePath}`);
  }

  const profileFiles = directories.flatMap(findProfileJsonFiles);
  return profileFiles.map(loadProfileFromFiles);
}

function extractZipToTemp(zipPath: string): string {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "iobroker-homeconnect-local-"));
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);
  return targetDir;
}

function findProfileJsonFiles(baseDir: string): ProfileFiles[] {
  const result: ProfileFiles[] = [];

  for (const file of fs.readdirSync(baseDir)) {
    const filePath = path.join(baseDir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      result.push(...findProfileJsonFiles(filePath));
      continue;
    }

    if (!file.toLowerCase().endsWith(".json")) {
      continue;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ApplianceProfileJson;
    if (parsed.haId && parsed.key) {
      result.push({ baseDir: path.dirname(filePath), jsonPath: filePath, profile: parsed });
    }
  }

  return result;
}

function loadProfileFromFiles(files: ProfileFiles): ApplianceProfile {
  const { baseDir, profile } = files;

  const featureMappingPath = profile.featureMappingFileName ? path.join(baseDir, profile.featureMappingFileName) : undefined;
  const deviceDescriptionPath = profile.deviceDescriptionFileName ? path.join(baseDir, profile.deviceDescriptionFileName) : undefined;

  const featureMappingXml = featureMappingPath && fs.existsSync(featureMappingPath)
    ? fs.readFileSync(featureMappingPath, "utf8")
    : "";

  const deviceDescriptionXml = deviceDescriptionPath && fs.existsSync(deviceDescriptionPath)
    ? fs.readFileSync(deviceDescriptionPath, "utf8")
    : "";

  return {
    haId: profile.haId,
    type: profile.type ?? "Unknown",
    serialNumber: profile.serialNumber,
    brand: profile.brand,
    vib: profile.vib,
    mac: profile.mac,
    connectionType: profile.connectionType ?? "AES",
    key: requiredString(profile.key, `Missing key in ${files.jsonPath}`),
    iv: profile.iv,
    featureMapping: parseFeatureMapping(featureMappingXml, deviceDescriptionXml),
  };
}

function requiredString(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

export function parseFeatureMapping(featureMappingXml: string, deviceDescriptionXml: string): FeatureMapping {
  return {
    featuresByUid: parseFeatureNames(featureMappingXml),
    enumTypeByUid: parseEnumTypeReferences(deviceDescriptionXml),
    enumValuesByType: parseEnumValues(deviceDescriptionXml),
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

function parseEnumValues(xml: string): Record<string, Record<string, string>> {
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
