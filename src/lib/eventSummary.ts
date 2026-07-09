import { lastMeaningfulNamePart } from "./ids";

export interface ActiveEventSummaryItem {
  feature: string;
  id: string;
  value: ioBroker.StateValue;
  text_de: string;
}

const EVENT_TEXT_DE: Record<string, string> = {
  // Common
  "BSH.Common.Event.ProgramAborted": "Abbruchmeldung offen",
  "BSH.Common.Event.ProgramFinished": "Programm beendet",
  "BSH.Common.Event.AquaStopOccured": "AquaStop ausgelöst",
  "BSH.Common.Event.LowWaterPressure": "Wasserdruck zu niedrig",
  "BSH.Common.Event.AlarmClockElapsed": "Timer abgelaufen",
  "BSH.Common.Event.CustomerServiceRequest": "Kundendienst erforderlich",
  "BSH.Common.Event.HomeConnectApplianceDataMissing": "Home-Connect-Gerätedaten fehlen",
  "BSH.Common.Event.SoftwareUpdateAvailable": "Softwareupdate verfügbar",
  "BSH.Common.Event.SoftwareDownloadAvailable": "Softwaredownload verfügbar",
  "BSH.Common.Event.SoftwareUpdateSuccessful": "Softwareupdate erfolgreich",
  "BSH.Common.Event.ConnectLocalWiFi": "Mit lokalem WLAN verbinden",
  "BSH.Common.Event.ConfirmPermanentRemoteStart": "Dauerhaften Fernstart am Gerät bestätigen",

  // Dishwasher
  "Dishcare.Dishwasher.Event.RinseAidNearlyEmpty": "Klarspüler bald leer",
  "Dishcare.Dishwasher.Event.RinseAidLack": "Klarspüler leer",
  "Dishcare.Dishwasher.Event.SaltNearlyEmpty": "Salz bald leer",
  "Dishcare.Dishwasher.Event.SaltLack": "Salz leer",
  "Dishcare.Dishwasher.Event.CheckFilterSystem": "Filtersystem prüfen",
  "Dishcare.Dishwasher.Event.DrainPumpBlocked": "Ablaufpumpe blockiert",
  "Dishcare.Dishwasher.Event.DrainingNotPossible": "Abpumpen nicht möglich",
  "Dishcare.Dishwasher.Event.InternalError": "Interner Fehler",
  "Dishcare.Dishwasher.Event.LowVoltage": "Unterspannung",
  "Dishcare.Dishwasher.Event.MachineCareReminder": "Maschinenpflege empfohlen",
  "Dishcare.Dishwasher.Event.MachineCareAndFilterCleaningReminder": "Maschinenpflege und Filterreinigung empfohlen",
  "Dishcare.Dishwasher.Event.SmartFilterCleaningReminder": "Filterreinigung empfohlen",
  "Dishcare.Dishwasher.Event.WaterheaterCalcified": "Wasserheizung verkalkt",

  // Laundry common
  "LaundryCare.Common.Event.DelayedShutdown": "Verzögertes Abschalten aktiv",
  "LaundryCare.Common.Event.DelayedShutdownCanceled": "Verzögertes Abschalten abgebrochen",
  "LaundryCare.Common.Event.DoorOpen": "Tür offen",
  "LaundryCare.Common.Event.FatalErrorOccured": "Schwerer Fehler aufgetreten",
  "LaundryCare.Common.Event.SupplyPower.SupplyVoltageTooLow": "Versorgungsspannung zu niedrig",

  // Washer
  "LaundryCare.Washer.Event.DrumCleanReminder": "Trommelreinigung empfohlen",
  "LaundryCare.Washer.Event.IDos.IDosOpenTray": "i-Dos Schublade offen",
  "LaundryCare.Washer.Event.IDos1FillLevelPoor": "i-Dos 1 Füllstand niedrig",
  "LaundryCare.Washer.Event.IDos2FillLevelPoor": "i-Dos 2 Füllstand niedrig",
  "LaundryCare.Washer.Event.IDosUnitDefect": "i-Dos Einheit defekt",
  "LaundryCare.Washer.Event.PumpError": "Pumpenfehler",
  "LaundryCare.Washer.Event.ReleaseRinseHoldPending": "Spülstopp-Freigabe ausstehend",
  "LaundryCare.Washer.Event.Spin.SpinAbort": "Schleudern abgebrochen",
  "LaundryCare.Common.Event.DoorLock.WaterLevelTooHigh": "Tür verriegelt: Wasserstand zu hoch",
  "LaundryCare.Common.Event.DoorNotLockable": "Tür nicht verriegelbar",
  "LaundryCare.Common.Event.DoorNotUnlockable": "Tür nicht entriegelbar",
  "LaundryCare.Common.Event.FoamDetection": "Schaumerkennung",

  // Dryer
  "LaundryCare.Dryer.Event.CondensateContainerFull": "Kondenswasserbehälter voll",
  "LaundryCare.Dryer.Event.CondensateTray.TrayOpen": "Kondensatschublade offen",
  "LaundryCare.Dryer.Event.LintFilterFull": "Flusensieb voll",
  "LaundryCare.Dryer.Event.RefresherContainerEmpty": "Refresher-Behälter leer",
  "LaundryCare.Dryer.Event.CoolDownPhaseRunning": "Abkühlphase läuft",
  "LaundryCare.Dryer.Event.DryingProcessFinished": "Trocknung beendet",
  "LaundryCare.Dryer.Event.DryerSelfCleaning.CleanLintFilter": "Flusensieb reinigen",
  "LaundryCare.Dryer.Event.DryerSelfCleaning.CleanSelfCleaningModule": "SelfCleaning-Modul reinigen",
  "LaundryCare.Dryer.Event.Maintenance.Remind": "Wartungshinweis",
  "LaundryCare.Dryer.Event.Maintenance.DepthFillAgent": "Depth-Fill-Mittel auffüllen",
  "LaundryCare.Dryer.Event.Maintenance.DepthFillWater": "Depth-Fill-Wasser auffüllen",
  "LaundryCare.Dryer.Event.Maintenance.DrainSet": "Ablauf-Set prüfen",
  "LaundryCare.Dryer.Event.Maintenance.QuickFillWater": "Quick-Fill-Wasser auffüllen",
  "LaundryCare.Dryer.Event.ConnectedDry.DontDry": "ConnectedDry: Nicht trocknen",
  "LaundryCare.Dryer.Event.ConnectedDry.DontDrySilk": "ConnectedDry: Seide nicht trocknen",
  "LaundryCare.Dryer.Event.ConnectedDry.LaundryTooMoist": "ConnectedDry: Wäsche zu feucht",
  "LaundryCare.Dryer.Event.ConnectedDry.NoDryingProgram": "ConnectedDry: Kein Trockenprogramm",
  "LaundryCare.Dryer.Event.ConnectedDry.SingleDryLargeItems": "ConnectedDry: Einzelne große Teile",
  "LaundryCare.Dryer.Event.ConnectedDry.UseBasket": "ConnectedDry: Korb verwenden",
  "LaundryCare.Dryer.Event.ConnectedDry.WasherTooLoaded": "ConnectedDry: Waschmaschine zu voll",

  // Cooking / Hob
  "Cooking.Common.Event.ApplianceModuleError": "Gerätemodulfehler",
  "Cooking.Common.Event.ApplianceOverheated": "Gerät überhitzt",
  "Cooking.Common.Event.ConfirmActionAtAppliance": "Aktion am Gerät bestätigen",
  "Cooking.Hob.Event.CookingSensorBatteryEmpty": "Kochsensor-Batterie leer",
  "Cooking.Hob.Event.CookingSensorDetected": "Kochsensor erkannt",
  "Cooking.Hob.Event.CookingSensorPairingSuccessful": "Kochsensor-Kopplung erfolgreich",
  "Cooking.Hob.Event.CookingSensorRequired": "Kochsensor erforderlich",
};

const EVENT_ID_TEXT_DE: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_TEXT_DE).map(([feature, text]) => [lastMeaningfulNamePart(feature), text]),
);

export function activeEventSummaryItems(eventsByFeature: Map<string, ioBroker.StateValue>): ActiveEventSummaryItem[] {
  const items: ActiveEventSummaryItem[] = [];
  for (const [feature, value] of eventsByFeature.entries()) {
    if (!isActiveEventValue(value)) continue;
    const id = lastMeaningfulNamePart(feature);
    items.push({ feature, id, value, text_de: germanEventText(feature, id) });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export function activeEventSummaryTextDe(items: ActiveEventSummaryItem[]): string {
  return items.map(item => item.text_de).join(", ");
}

export function isActiveEventValue(value: ioBroker.StateValue): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "off" || normalized === "false" || normalized === "0") return false;
  if (normalized === "present" || normalized === "confirmed" || normalized === "true" || normalized === "1") return true;
  return true;
}

function germanEventText(feature: string, id: string): string {
  return EVENT_TEXT_DE[feature] ?? EVENT_ID_TEXT_DE[id] ?? readableTextFromId(id) ?? feature;
}

function readableTextFromId(id: string): string | undefined {
  const text = id
    .replace(/[_-]+/g, " ")
    .replace(/([a-zäöüß])([A-ZÄÖÜ])/g, "$1 $2")
    .trim();
  return text || undefined;
}
