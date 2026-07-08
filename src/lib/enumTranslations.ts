const TRANSLATIONS: Record<string, Record<string, string>> = {
  ProgramPhase: {
    None: "Keine",
    PreRinse: "Vorspülen",
    MainWash: "Hauptwäsche",
    FinalRinse: "Klarspülen",
    Drying: "Trocknen",
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

export function translateEnumValue(featureName: string | undefined, enumText: string): string {
  const featureKey = featureName?.split(".").pop();
  return (featureKey ? TRANSLATIONS[featureKey]?.[enumText] : undefined) ?? enumText;
}
