import { RunningDevice } from "./runtimeTypes";

export interface HobZoneInfo {
  zone: string;
  active: boolean;
  state?: ioBroker.StateValue;
  operationState?: ioBroker.StateValue;
  activeProgram?: ioBroker.StateValue;
  powerLevel?: ioBroker.StateValue;
}

export interface HobZoneSummary {
  activeZones: HobZoneInfo[];
  residualHeatZones: HobZoneInfo[];
  activeZonesText: string;
  residualHeatZonesText: string;
}

const HOB_ZONE_FEATURE_PATTERN = /^Cooking\.Hob\.Status\.Zone\.([^.]+)\.(State|OperationState|ActiveProgram|PowerLevel)$/;
const ACTIVE_OPERATION_STATES = new Set(["active", "run", "running", "on"]);
const IDLE_OPERATION_STATES = new Set(["ready", "off", "inactive"]);
const OFF_STATES = new Set(["off"]);
const DEFAULT_ACTIVE_PROGRAMS = new Set(["cooking.hob.program.powerlevelmode"]);
const RESIDUAL_HEAT_STATES = new Set(["residualheat", "residuelheat"]);

export function hobZoneFeature(featureName: string): { zone: string; field: "State" | "OperationState" | "ActiveProgram" | "PowerLevel" } | undefined {
  const match = featureName.match(HOB_ZONE_FEATURE_PATTERN);
  if (!match) return undefined;
  return { zone: match[1], field: match[2] as "State" | "OperationState" | "ActiveProgram" | "PowerLevel" };
}

export function isHobZoneFeature(featureName: string): boolean {
  return hobZoneFeature(featureName) !== undefined;
}

export function evaluateHobZoneSummary(device: Pick<RunningDevice, "stateValuesByFeature" | "rawValuesByFeature">): HobZoneSummary {
  const zones = new Map<string, Partial<HobZoneInfo>>();

  for (const [featureName, value] of device.stateValuesByFeature) {
    const zoneFeature = hobZoneFeature(featureName);
    if (!zoneFeature) continue;
    const zone = zones.get(zoneFeature.zone) ?? { zone: zoneFeature.zone };
    setZoneField(zone, zoneFeature.field, value);
    zones.set(zoneFeature.zone, zone);
  }

  const activeZones: HobZoneInfo[] = [];
  const residualHeatZones: HobZoneInfo[] = [];
  for (const partialZone of [...zones.values()].sort((a, b) => String(a.zone).localeCompare(String(b.zone), undefined, { numeric: true }))) {
    const zone = partialZone as HobZoneInfo;
    const residualHeat = isResidualHeatState(zone.state);
    zone.active = !residualHeat && isActiveZone(device, zone);
    if (zone.active) activeZones.push(zone);
    if (residualHeat) residualHeatZones.push({ ...zone, active: false });
  }

  return {
    activeZones,
    residualHeatZones,
    activeZonesText: activeZones.map(zone => zone.zone).join(", "),
    residualHeatZonesText: residualHeatZones.map(zone => zone.zone).join(", "),
  };
}

function setZoneField(zone: Partial<HobZoneInfo>, field: "State" | "OperationState" | "ActiveProgram" | "PowerLevel", value: ioBroker.StateValue): void {
  if (field === "State") zone.state = value;
  if (field === "OperationState") zone.operationState = value;
  if (field === "ActiveProgram") zone.activeProgram = value;
  if (field === "PowerLevel") zone.powerLevel = value;
}

function isActiveZone(device: Pick<RunningDevice, "rawValuesByFeature">, zone: HobZoneInfo): boolean {
  const stateOff = isOffState(zone.state);
  const operationStateIdle = isIdleOperationState(zone.operationState);
  const powerLevelOff = isOffPowerLevel(zone.powerLevel);

  if (stateOff && operationStateIdle && powerLevelOff) return false;

  return isTextValue(zone.state, "active")
    || isActiveOperationState(zone.operationState)
    || (!operationStateIdle && isRawOperationStateActive(device, zone.zone))
    || isPositiveNumber(zone.powerLevel)
    || isHeatingPowerLevel(zone.powerLevel)
    || (!stateOff && !operationStateIdle && isNonDefaultActiveProgram(zone.activeProgram));
}

function isActiveOperationState(value: ioBroker.StateValue | undefined): boolean {
  if (isNumeric(value)) return Number(value) === 1;
  return textEndsWithAny(value, ACTIVE_OPERATION_STATES);
}

function isRawOperationStateActive(device: Pick<RunningDevice, "rawValuesByFeature">, zone: string): boolean {
  return Number(device.rawValuesByFeature.get(`Cooking.Hob.Status.Zone.${zone}.OperationState`)) === 1;
}

function isResidualHeatState(value: ioBroker.StateValue | undefined): boolean {
  return textEndsWithAny(value, RESIDUAL_HEAT_STATES);
}

function isTextValue(value: ioBroker.StateValue | undefined, expected: string): boolean {
  return textEndsWithAny(value, new Set([expected]));
}

function isOffState(value: ioBroker.StateValue | undefined): boolean {
  return textEndsWithAny(value, OFF_STATES);
}

function isIdleOperationState(value: ioBroker.StateValue | undefined): boolean {
  return textEndsWithAny(value, IDLE_OPERATION_STATES);
}

function isOffPowerLevel(value: ioBroker.StateValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (isNumeric(value)) return Number(value) === 0;
  return isOffState(value);
}

function isHeatingPowerLevel(value: ioBroker.StateValue | undefined): boolean {
  return typeof value === "string" && value.trim() !== "" && !isOffState(value) && !isNumeric(value);
}

function normalizedText(value: ioBroker.StateValue | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function textEndsWithAny(value: ioBroker.StateValue | undefined, expectedValues: Set<string>): boolean {
  const text = normalizedText(value);
  if (!text) return false;
  for (const expected of expectedValues) {
    if (text === expected || text.endsWith(`.${expected}`)) return true;
  }
  return false;
}

function isNonDefaultActiveProgram(value: ioBroker.StateValue | undefined): boolean {
  if (!isNonZeroValue(value)) return false;
  if (typeof value !== "string") return true;
  return !DEFAULT_ACTIVE_PROGRAMS.has(normalizedText(value));
}

function isNonZeroValue(value: ioBroker.StateValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (isNumeric(value)) return Number(value) !== 0;
  return true;
}

function isPositiveNumber(value: ioBroker.StateValue | undefined): boolean {
  return isNumeric(value) && Number(value) > 0;
}

function isNumeric(value: ioBroker.StateValue | undefined): value is number | string {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}
