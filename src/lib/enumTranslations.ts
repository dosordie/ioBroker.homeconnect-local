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
    Prewash: "Vorwäsche",
    IntermediateSpin: "Zwischenschleudern",
    FillingDetergent: "Waschmittel einspülen",
    DetectingLoad: "Beladungserkennung",
    Heating: "Aufheizen",
    Washing: "Waschen",
    Cooldown: "Abkühlen",
    RinsingFoam: "Schaum ausspülen",
    Rinsing: "Spülen",
    RinsingAquaSensor: "Spülen mit AquaSensor",
    RinseOnly: "Nur Spülen",
    WaterProofing: "Imprägnieren",
    RinsingSoftener: "Weichspüler einspülen",
    HoldAfterRinse: "Spülstopp",
    Pumping: "Abpumpen",
    SpinningFinal: "Endschleudern",
    LessIroning: "Knitterschutz",
    Fluffing: "Auflockern",
    Soaking: "Einweichen",
    HygienicSteamFogging: "Hygiene-Dampf",
    Drying: "Trocknen",
    CoolingDown: "Abkühlen",
    AdditionalCoolingDown: "Zusätzliches Abkühlen",
    GuardingWrinkle: "Knitterschutz läuft",
    DetectingTextile: "Textilerkennung",
    DetectingSoil: "Verschmutzungserkennung",
    Disinfecting: "Desinfizieren",
    LowTemperatureHygiene: "Niedertemperatur-Hygiene",
    SteamingActive: "Dampf aktiv",
    IronDryReached: "Bügeltrocken erreicht",
    CupboardDryReached: "Schranktrocken erreicht",
    CupboardDryPlusReached: "Schranktrocken Plus erreicht",
    CleaningHeatExchanger: "Wärmetauscher reinigen",
    SlightlyDampReached: "Leicht feucht erreicht",
  },
  PowerState: { Off: "Aus", On: "Ein", MainsOff: "Aus", Standby: "Standby" },
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
  DoorState: { Open: "Offen", Closed: "Geschlossen", Locked: "Verriegelt", Ajar: "Angelehnt" },
  RemoteControl: { Active: "Aktiv", Inactive: "Inaktiv" },
  EndTrigger: {
    ProgramFinished: "Programm beendet",
    ProgramAbortedByUser: "Programm vom Benutzer abgebrochen",
    ProgramAbortedByAppliance: "Programm vom Gerät abgebrochen",
    ProgramAbortedByApplianceCriticalError: "Programm wegen kritischem Gerätefehler abgebrochen",
  },
  FlexStart: {
    Disabled: "Deaktiviert",
    Enabled: "Aktiviert",
    Pending: "Ausstehend",
    Scheduled: "Geplant",
    Started: "Gestartet",
    Finished: "Beendet",
  },
};

const DEFAULT_TRANSLATIONS: Record<string, string> = {
  Error: "Fehler",
  MainsOff: "Aus",
  Standby: "Standby",
  Ajar: "Angelehnt",
};

export function translateEnumValue(featureName: string | undefined, enumText: string, rawValue?: unknown): string {
  const featureKey = featureName?.split(".").pop();
  const translated = (featureKey ? TRANSLATIONS[featureKey]?.[enumText] : undefined) ?? DEFAULT_TRANSLATIONS[enumText] ?? enumText;
  if (translated.startsWith("Unknown(")) {
    return `Unbekannt (${String(rawValue)})`;
  }
  return translated;
}
