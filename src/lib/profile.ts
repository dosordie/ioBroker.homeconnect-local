import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";

import { ApplianceProfile, ApplianceProfileJson } from "./types";
import { parseFeatureMapping } from "./profileXml";

interface ProfileFiles {
  baseDir: string;
  jsonPath: string;
  profile: ApplianceProfileJson;
  profileFile?: string;
}

export function loadProfiles(profilePath: string): ApplianceProfile[] {
  if (!profilePath) {
    return [];
  }

  const stat = fs.statSync(profilePath);
  const profileFiles: ProfileFiles[] = [];

  if (stat.isDirectory()) {
    profileFiles.push(...findProfileJsonFiles(profilePath));
    profileFiles.push(...findZipProfileFiles(profilePath));
  } else if (stat.isFile() && profilePath.toLowerCase().endsWith(".zip")) {
    profileFiles.push(...findProfileJsonFiles(extractZipToTemp(profilePath), profilePath));
  } else if (stat.isFile() && profilePath.toLowerCase().endsWith(".json")) {
    profileFiles.push(...findProfileJsonFiles(path.dirname(profilePath)));
  } else {
    throw new Error(`Unsupported profile path: ${profilePath}`);
  }

  return deduplicateProfiles(profileFiles).map(loadProfileFromFiles);
}

function extractZipToTemp(zipPath: string): string {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "iobroker-homeconnect-local-"));
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);
  return targetDir;
}

function findZipProfileFiles(baseDir: string): ProfileFiles[] {
  const result: ProfileFiles[] = [];

  for (const filePath of findFiles(baseDir, file => file.toLowerCase().endsWith(".zip"))) {
    try {
      result.push(...findProfileJsonFiles(extractZipToTemp(filePath), filePath));
    } catch {
      // Ignore non-profile or broken ZIP files in the configured profile directory.
    }
  }

  return result;
}

function findProfileJsonFiles(baseDir: string, profileFile?: string): ProfileFiles[] {
  const result: ProfileFiles[] = [];

  for (const filePath of findFiles(baseDir, file => file.toLowerCase().endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ApplianceProfileJson;
      if (parsed.haId && parsed.key) {
        result.push({ baseDir: path.dirname(filePath), jsonPath: filePath, profile: parsed, profileFile });
      }
    } catch {
      // Ignore unrelated JSON files in profile directories.
    }
  }

  return result;
}

function findFiles(baseDir: string, predicate: (fileName: string) => boolean): string[] {
  const result: string[] = [];

  for (const file of fs.readdirSync(baseDir)) {
    const filePath = path.join(baseDir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      result.push(...findFiles(filePath, predicate));
      continue;
    }

    if (stat.isFile() && predicate(file)) {
      result.push(filePath);
    }
  }

  return result;
}

function deduplicateProfiles(files: ProfileFiles[]): ProfileFiles[] {
  const result = new Map<string, ProfileFiles>();

  for (const file of files) {
    const existing = result.get(file.profile.haId);
    if (!existing || (!existing.profileFile && file.profileFile)) {
      result.set(file.profile.haId, file);
    }
  }

  return Array.from(result.values());
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
    profileFile: files.profileFile,
    featureMapping: parseFeatureMapping(featureMappingXml, deviceDescriptionXml),
  };
}

function requiredString(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}
