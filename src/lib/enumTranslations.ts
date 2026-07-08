const TRANSLATIONS: Record<string, Record<string, string>> = {
  ProgramPhase: {
    None: "Keine",
    PreRinse: "Vorspülen",
    MainWash: "Hauptwäsche",
    FinalRinse: "Klarspülen",
    Drying: "Trocknen",
  },
  ProcessPhase: {
    NoPhase: "Keine Phase",
    DepthCarePhase1: "Pflegephase 1",
    DepthCarePhase2: "Pflegephase 2",
    AnyPhase: "Beliebige Phase",
  },
  PowerState: { Off: "Aus", On: "Ein" },
  OperationState: {
    Inactive: "Inaktiv",
    Ready: "Bereit",
    Run: "Läuft",
    Finished: "Fertig",
    Pause: "Pause",
    DelayedStart: "Startvorwahl",
    Aborting: "Abbruch",
    ActionRequired: "Aktion erforderlich",
  },
  DoorState: { Open: "Offen", Closed: "Geschlossen", Locked: "Verriegelt" },
  RemoteControl: { Active: "Aktiv", Inactive: "Inaktiv" },
};

export function translateEnumValue(featureName: string | undefined, enumText: string, rawValue?: unknown): string {
  const featureKey = featureName?.split(".").pop();
  const translated = (featureKey ? TRANSLATIONS[featureKey]?.[enumText] : undefined) ?? enumText;
  if (translated.startsWith("Unknown(")) {
    return `Unbekannt (${String(rawValue)})`;
  }
  return translated;
}
