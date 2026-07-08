import type { RunningDevice } from "./runtimeTypes";

const KNOWN_PROGRAM_NAMES: Record<string, string> = {
  "Dishcare.Dishwasher.Program.Intensiv70": "Intensiv 70°",
  "Dishcare.Dishwasher.Program.Auto2": "Auto 45-65°",
  "Dishcare.Dishwasher.Program.Eco50": "Eco 50°",
  "Dishcare.Dishwasher.Program.Quick45": "Speed 45°",
  "Dishcare.Dishwasher.Program.PreRinse": "Vorspülen",
  "Dishcare.Dishwasher.Program.NightWash": "Leise 50°C",
  "Dishcare.Dishwasher.Program.Kurz60": "Speed 60°",
  "Dishcare.Dishwasher.Program.MachineCare": "Maschinenpflege",
  "Dishcare.Dishwasher.Program.MixedLoad": "Mischbeladung",
};

export function programStatesForDevice(device: RunningDevice): Record<string, string> {
  const result: Record<string, string> = {};
  for (const programKey of Object.values(device.profile.featureMapping.featuresByUid)) {
    if (!programKey.includes(".Program.") || programKey.includes(".Root.")) continue;
    result[programKey] = displayNameForProgram(programKey, favoriteNameForProgram(device, programKey));
  }
  return Object.fromEntries(Object.entries(result).sort(([, a], [, b]) => a.localeCompare(b)));
}

export function displayNameForProgram(programKey: string, favoriteName?: string): string {
  if (favoriteName?.trim()) return favoriteName.trim();
  const known = KNOWN_PROGRAM_NAMES[programKey];
  if (known) return known;

  const favorite = programKey.match(/^BSH\.Common\.Program\.Favorite\.(.+)$/);
  if (favorite) return `Favorit ${favorite[1]}`;

  return readableTechnicalName(programKey.split(".").pop() ?? programKey);
}

export function resolveProgramKeyForDevice(device: RunningDevice, value: ioBroker.StateValue): { key?: string; matches: string[] } {
  const text = String(value ?? "").trim();
  if (!text) return { matches: [] };

  const states = programStatesForDevice(device);
  const wanted = text.toLowerCase();
  const wantedCompact = compact(text);
  const matches = Object.entries(states)
    .filter(([key, label]) => {
      const lastPart = key.split(".").pop() ?? key;
      return key.toLowerCase() === wanted || label.toLowerCase() === wanted || lastPart.toLowerCase() === wanted || compact(label) === wantedCompact || compact(lastPart) === wantedCompact;
    })
    .map(([key]) => key);

  return { key: matches.length === 1 ? matches[0] : undefined, matches };
}

function favoriteNameForProgram(device: RunningDevice, programKey: string): string | undefined {
  const favorite = programKey.match(/^BSH\.Common\.Program\.Favorite\.(.+)$/);
  if (!favorite) return undefined;
  const value = device.stateValuesByFeature.get(`BSH.Common.Setting.Favorite.${favorite[1]}.Name`);
  return value === undefined || value === null ? undefined : String(value);
}

function readableTechnicalName(value: string): string {
  return value
    .replace(/([a-zäöüß])([A-ZÄÖÜ])/g, "$1 $2")
    .replace(/([A-Za-zÄÖÜäöüß])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-zÄÖÜäöüß])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
}
