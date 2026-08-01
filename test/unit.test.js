const assert = require("node:assert/strict");
const { test } = require("node:test");

const { translateEnumValue, translatedCompanionValueForTarget } = require("../build/lib/enumTranslations");
const { metadataForFeature } = require("../build/lib/stateMetadata");
const { hasWritableProgramOption } = require("../build/lib/optionWriteability");
const { activeEventSummaryItems, activeEventSummaryTextDe } = require("../build/lib/eventSummary");

function profileWithProgramOptions(programOptionsByUid) {
  return {
    haId: "test",
    type: "Dryer",
    connectionType: "TLS",
    key: "",
    featureMapping: {
      featuresByUid: {
        "0100": "LaundryCare.Dryer.Program.Cottons",
        "0200": "LaundryCare.Dryer.Option.WrinkleGuard",
        "0300": "BSH.Common.Option.EnergyForecast",
        "0400": "BSH.Common.Option.WaterForecast",
      },
      enumTypeByUid: {},
      enumValuesByType: {},
      programOptionsByUid,
    },
  };
}

test("German ProcessPhase enum translations include laundry phases", () => {
  assert.equal(
    translateEnumValue("LaundryCare.Common.Option.ProcessPhase", "Fluffing", 18),
    "Auflockern",
  );
  assert.equal(translateEnumValue("LaundryCare.Common.Option.ProcessPhase", "Washing", 5), "Waschen");
  assert.equal(translateEnumValue("LaundryCare.Common.Option.ProcessPhase", "Drying", 21), "Trocknen");
  assert.equal(
    translateEnumValue("LaundryCare.Common.Option.ProcessPhase", "ColdRefreshing", 25),
    "Kalt auffrischen",
  );
});

test("German enum translations include EndTrigger and FlexStart", () => {
  assert.equal(translateEnumValue("BSH.Common.Status.ProgramRunDetail.EndTrigger", "ProgramFinished", 0), "Programm normal beendet");
  assert.equal(
    translateEnumValue("BSH.Common.Status.ProgramRunDetail.EndTrigger", "ProgramAbortedByUser", 1),
    "Programm vom Benutzer abgebrochen",
  );
  assert.equal(translateEnumValue("BSH.Common.Status.ProgramRunDetail.EndTrigger", "ProgramAbortedByAppliance", 2), "Programm vom Gerät abgebrochen");
  assert.equal(
    translateEnumValue("BSH.Common.Status.ProgramRunDetail.EndTrigger", "ProgramAbortedByApplianceCriticalError", 3),
    "Programm wegen kritischem Gerätefehler abgebrochen",
  );
  assert.equal(
    translateEnumValue("BSH.Common.Status.FlexStart", "Scheduled", 3),
    "Geplant",
  );
});

test("German enum translations include appliance companion values", () => {
  assert.equal(translateEnumValue("BSH.Common.Status.DoorState", "Locked", 2), "Verriegelt");
  assert.equal(translateEnumValue("LaundryCare.Washer.Option.IDos1Level", "Filled", 1), "Gefüllt");
  assert.equal(translateEnumValue("LaundryCare.Washer.Option.IDos2Level", "Poor", 2), "Niedrig");
  assert.equal(translateEnumValue("BSH.Common.Status.StopWatchState", "Running", 2), "Läuft");
  assert.equal(
    translateEnumValue("LaundryCare.Common.Status.OperationStatus", "NoProgramFound", 3),
    "Kein Programm gefunden",
  );
  assert.equal(translateEnumValue("LaundryCare.Common.Option.TextileType", "Cotton", 1), "Baumwolle");
  assert.equal(translateEnumValue("Cooking.Common.Status.State", "ResiduelHeat", 3), "Restwärme");
  assert.equal(translateEnumValue("Cooking.Hob.Option.PowerLevel", "KeepWarm", 1), "Warmhalten");
  assert.equal(translateEnumValue("Cooking.Hob.Option.FryingSensorLevel", "Level03", 3), "Stufe 3");
});

test("forecast metadata uses percent units", () => {
  const profile = profileWithProgramOptions({});
  assert.equal(metadataForFeature("BSH.Common.Option.EnergyForecast", "0300", profile).unit, "%");
  assert.equal(metadataForFeature("BSH.Common.Option.WaterForecast", "0400", profile).unit, "%");
});

test("program-specific writable user options are detected", () => {
  const profile = profileWithProgramOptions({
    "0100": [{ refUID: "0200", access: "readWrite", available: true }],
  });
  assert.equal(hasWritableProgramOption(profile, "0200"), true);
});

test("forecast and telemetry options stay read-only despite program readWrite access", () => {
  const profile = profileWithProgramOptions({
    "0100": [
      { refUID: "0300", access: "READWRITE", available: true },
      { refUID: "0400", access: "write", available: true },
    ],
  });
  assert.equal(hasWritableProgramOption(profile, "0300"), false);
  assert.equal(hasWritableProgramOption(profile, "0400"), false);
});

const { normalizeDnsName, normalizeMac, devicesFromResponse, matchDiscoveredDeviceToProfile } = require("../build/lib/mdnsDiscovery");

function discoveryProfile(overrides) {
  return {
    haId: "ha-1",
    type: "Dishwasher",
    brand: "Bosch",
    vib: "SMV123",
    mac: "AA:BB:CC:DD:EE:FF",
    connectionType: "TLS",
    key: "key",
    featureMapping: { featuresByUid: {}, enumTypeByUid: {}, enumValuesByType: {}, programOptionsByUid: {} },
    ...overrides,
  };
}

test("normalizeMac accepts common MAC address formats", () => {
  assert.equal(normalizeMac("AA:BB:CC:DD:EE:FF"), "aabbccddeeff");
  assert.equal(normalizeMac("aa-bb-cc-dd-ee-ff"), "aabbccddeeff");
  assert.equal(normalizeMac("aabb.ccdd.eeff"), "aabbccddeeff");
  assert.equal(normalizeMac("not-a-mac"), undefined);
});

test("normalizeDnsName treats trailing dot as equivalent", () => {
  assert.equal(normalizeDnsName("_homeconnect._tcp.local."), "_homeconnect._tcp.local");
  assert.equal(normalizeDnsName("_homeconnect._tcp.local"), "_homeconnect._tcp.local");
});

test("mDNS response parsing recognizes service names with trailing dots", () => {
  const devices = devicesFromResponse({
    answers: [{ name: "_homeconnect._tcp.local.", type: "PTR", data: "Appliance._homeconnect._tcp.local." }],
    additionals: [
      { name: "Appliance._homeconnect._tcp.local.", type: "SRV", data: { target: "appliance.local.", port: 443 } },
      { name: "Appliance._homeconnect._tcp.local.", type: "TXT", data: [Buffer.from("id=ha-1"), Buffer.from("brand=Bosch"), Buffer.from("type=Dishwasher"), Buffer.from("vib=SMV123")] },
      { name: "appliance.local", type: "A", data: "192.0.2.10" },
    ],
  });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "appliance");
  assert.equal(devices[0].host, "appliance.local");
  assert.equal(devices[0].address, "192.0.2.10");
  assert.equal(devices[0].id, "ha-1");
});

test("discovered appliance matches profile by haId first", () => {
  const profile = discoveryProfile({ haId: "ha-target", mac: "11:22:33:44:55:66" });
  const match = matchDiscoveredDeviceToProfile({ id: "ha-target", mac: "AA:BB:CC:DD:EE:FF" }, [profile]);
  assert.equal(match && match.profile.haId, "ha-target");
  assert.equal(match && match.match, "haId");
});

test("discovered appliance matches profile by normalized mac", () => {
  const match = matchDiscoveredDeviceToProfile({ mac: "aa-bb-cc-dd-ee-ff" }, [discoveryProfile({})]);
  assert.equal(match && match.profile.haId, "ha-1");
  assert.equal(match && match.match, "mac");
});

test("discovered appliance matches by brand type and vib only when unique", () => {
  const match = matchDiscoveredDeviceToProfile({ brand: "bosch", type: "dishwasher", vib: "smv123" }, [discoveryProfile({ mac: undefined })]);
  assert.equal(match && match.profile.haId, "ha-1");
  assert.equal(match && match.match, "brandTypeVib");
});

test("discovered appliance has no brand type vib match when ambiguous", () => {
  const profiles = [
    discoveryProfile({ haId: "ha-1", mac: undefined }),
    discoveryProfile({ haId: "ha-2", mac: undefined }),
  ];
  assert.equal(matchDiscoveredDeviceToProfile({ brand: "Bosch", type: "Dishwasher", vib: "SMV123" }, profiles), undefined);
});

const { updateConfiguredDeviceHostsFromDiscovery } = require("../build/lib/discoveryConfigUpdate");

function hostUpdateMatch(overrides) {
  return {
    discovery: { address: "192.0.2.20", host: "appliance.local" },
    profile: { haId: "ha-1", connectionType: "TLS" },
    match: "haId",
    ...overrides,
  };
}

function configuredDevice(overrides) {
  return { enabled: true, haId: "ha-1", host: "192.0.2.10", name: "Device", connectionType: "TLS", ...overrides };
}

test("discovery host update changes configured host for haId matches", () => {
  const result = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({})], [hostUpdateMatch({ match: "haId" })]);
  assert.equal(result.devices[0].host, "192.0.2.20");
  assert.deepEqual(result.updates, [{ haId: "ha-1", oldHost: "192.0.2.10", newHost: "192.0.2.20", match: "haId" }]);
});

test("discovery host update changes configured host for mac matches", () => {
  const result = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({})], [hostUpdateMatch({ match: "mac" })]);
  assert.equal(result.devices[0].host, "192.0.2.20");
  assert.equal(result.updates[0].match, "mac");
});

test("discovery host update skips brand type vib matches", () => {
  const result = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({})], [hostUpdateMatch({ match: "brandTypeVib" })]);
  assert.equal(result.devices[0].host, "192.0.2.10");
  assert.equal(result.updates.length, 0);
});

test("discovery host update skips matches without discovered host", () => {
  const result = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({})], [hostUpdateMatch({ discovery: {} })]);
  assert.equal(result.devices[0].host, "192.0.2.10");
  assert.equal(result.updates.length, 0);
});

test("discovery host update skips unchanged hosts", () => {
  const result = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({ host: "192.0.2.20" })], [hostUpdateMatch({})]);
  assert.equal(result.devices[0].host, "192.0.2.20");
  assert.equal(result.updates.length, 0);
});

test("discovery host update exposes persisted condition via update count", () => {
  const changed = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({})], [hostUpdateMatch({})]);
  const unchanged = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({ host: "192.0.2.20" })], [hostUpdateMatch({})]);
  assert.equal(changed.updates.length > 0, true);
  assert.equal(unchanged.updates.length > 0, false);
});

test("discovery host update prefers IP address over local hostname", () => {
  const result = updateConfiguredDeviceHostsFromDiscovery([configuredDevice({})], [hostUpdateMatch({ discovery: { address: "192.0.2.30", host: "preferred-only-when-no-address.local" } })]);
  assert.equal(result.devices[0].host, "192.0.2.30");
});

const { addOrEnableConfiguredDevicesFromDiscovery } = require("../build/lib/discoveryConfigUpdate");

function autoAddMatch(overrides) {
  return hostUpdateMatch({
    profile: {
      haId: "ha-1",
      type: "Dishwasher",
      brand: "Bosch",
      vib: "SMV123",
      mac: "AA:BB:CC:DD:EE:FF",
      connectionType: "TLS",
      profileFile: "profile.zip",
    },
    ...overrides,
  });
}

test("discovery auto-add enables existing disabled device for haId matches and sets host", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([configuredDevice({ enabled: false, host: "" })], [autoAddMatch({ match: "haId" })]);
  assert.equal(result.devices[0].enabled, true);
  assert.equal(result.devices[0].host, "192.0.2.20");
  assert.deepEqual(result.enabled, [{ haId: "ha-1", oldEnabled: false, newEnabled: true, host: "192.0.2.20", match: "haId" }]);
});

test("discovery auto-add enables existing disabled device for mac matches and sets host", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([configuredDevice({ enabled: false, host: "" })], [autoAddMatch({ match: "mac" })]);
  assert.equal(result.devices[0].enabled, true);
  assert.equal(result.devices[0].host, "192.0.2.20");
  assert.equal(result.enabled[0].match, "mac");
});

test("discovery auto-add creates missing configured device for haId matches", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([], [autoAddMatch({ match: "haId" })]);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].enabled, true);
  assert.equal(result.devices[0].haId, "ha-1");
  assert.equal(result.devices[0].name, "Bosch SMV123 Dishwasher");
  assert.equal(result.devices[0].connectionType, "TLS");
  assert.deepEqual(result.added, [{ haId: "ha-1", host: "192.0.2.20", match: "haId" }]);
});

test("discovery auto-add exposes changed flag for persisted adapter config", () => {
  const changed = addOrEnableConfiguredDevicesFromDiscovery([], [autoAddMatch({})]);
  const unchanged = addOrEnableConfiguredDevicesFromDiscovery([configuredDevice({
    enabled: true,
    host: "192.0.2.20",
    name: "Bosch SMV123 Dishwasher",
    type: "Dishwasher",
    brand: "Bosch",
    vib: "SMV123",
    mac: "AA:BB:CC:DD:EE:FF",
    connectionType: "TLS",
    profileFile: "profile.zip",
  })], [autoAddMatch({})]);
  assert.equal(changed.changed, true);
  assert.equal(unchanged.changed, false);
});

test("discovery auto-add skips brand type vib matches", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([], [autoAddMatch({ match: "brandTypeVib" })]);
  assert.equal(result.devices.length, 0);
  assert.equal(result.added.length, 0);
});

test("discovery auto-add skips matches without discovered host", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([], [autoAddMatch({ discovery: {} })]);
  assert.equal(result.devices.length, 0);
  assert.equal(result.added.length, 0);
});

test("discovery auto-add ignores unmatched discoveries because only profile matches are accepted", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([], []);
  assert.equal(result.devices.length, 0);
  assert.equal(result.added.length, 0);
});

test("discovery auto-add prefers IP address over local hostname", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([], [autoAddMatch({ discovery: { address: "192.0.2.30", host: "appliance.local" } })]);
  assert.equal(result.devices[0].host, "192.0.2.30");
});

test("discovery auto-add keeps existing enabled devices enabled and does not duplicate them", () => {
  const result = addOrEnableConfiguredDevicesFromDiscovery([configuredDevice({ enabled: true })], [autoAddMatch({})]);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].enabled, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.enabled.length, 0);
});

const { shouldSendAutomaticStartOption, mergeStartOptionValues } = require("../build/lib/startOptions");

const START_IN_RELATIVE = "BSH.Common.Option.StartInRelative";

test("automatic start options skip StartInRelative zero", () => {
  assert.equal(shouldSendAutomaticStartOption(START_IN_RELATIVE, 0), false);
});

test("automatic start options skip boolean false", () => {
  assert.equal(shouldSendAutomaticStartOption("Dishcare.Dishwasher.Option.HygienePlus", false), false);
});

test("automatic start options send boolean true", () => {
  assert.equal(shouldSendAutomaticStartOption("Dishcare.Dishwasher.Option.HygienePlus", true), true);
});

test("automatic start options skip values equal to program option default", () => {
  assert.equal(shouldSendAutomaticStartOption("Dishcare.Dishwasher.Option.IntensivZone", "Off", "Off"), false);
});

test("explicit start options are preserved even when they look like automatic defaults", () => {
  assert.deepEqual(mergeStartOptionValues([{ uid: 558, value: 0 }], []), [{ uid: 558, value: 0 }]);
  assert.deepEqual(mergeStartOptionValues([{ uid: 5123, value: false }], []), [{ uid: 5123, value: false }]);
});

test("explicit start options win over automatic options for the same UID", () => {
  assert.deepEqual(
    mergeStartOptionValues([{ uid: 5127, value: false }], [{ uid: 5127, value: true }, { uid: 5128, value: true }]),
    [{ uid: 5127, value: false }, { uid: 5128, value: true }],
  );
});

const { evaluateStartAvailability } = require("../build/lib/startAvailability");

function startAvailabilityDevice(overrides = {}) {
  const featuresByUid = {
    "0101": "BSH.Common.Status.DoorState",
    "0102": "BSH.Common.Status.OperationState",
    "0103": "BSH.Common.Setting.PowerState",
    "0104": "BSH.Common.Status.RemoteControlStartAllowed",
    "0105": "BSH.Common.Root.SelectedProgram",
    "0106": "BSH.Common.Root.ActiveProgram",
  };
  return {
    baseId: "device",
    config: { type: overrides.type ?? "Washer" },
    profile: {
      haId: "device",
      type: overrides.type ?? "Washer",
      featureMapping: {
        featuresByUid,
        enumTypeByUid: {
          "0101": "DoorState",
          "0102": "OperationState",
          "0103": "PowerState",
        },
        enumValuesByType: {
          DoorState: { 1: "Open", 2: "Locked", 3: "Closed", 4: "Ajar" },
          OperationState: { 1: "Run", 2: "Ready", 3: "Running" },
          PowerState: { 1: "Off", 2: "On", 3: "MainsOff" },
        },
        programOptionsByUid: {},
      },
    },
    mapper: {},
    connected: true,
    reconnecting: false,
    reconnectFailures: 0,
    writableUids: new Set(["0106"]),
    readOnlyUids: new Set(),
    blockedCommands: [],
    stateValuesByFeature: new Map([
      ["BSH.Common.Status.DoorState", "Closed"],
      ["BSH.Common.Status.OperationState", "Ready"],
      ["BSH.Common.Setting.PowerState", "On"],
      ["BSH.Common.Status.RemoteControlStartAllowed", true],
      ["BSH.Common.Root.SelectedProgram", 100],
    ]),
    rawValuesByFeature: new Map(),
    eventValuesByFeature: new Map(),
    programExecutionByFeature: new Map(),
    ...overrides,
  };
}

function availabilityReason(overrides, connected = true) {
  return evaluateStartAvailability(startAvailabilityDevice(overrides), connected).reason;
}

test("start availability reports disconnected devices", () => {
  assert.equal(availabilityReason({}, false), "not_connected");
});

test("start availability handles door states", () => {
  assert.equal(availabilityReason({ stateValuesByFeature: new Map(startAvailabilityDevice().stateValuesByFeature).set("BSH.Common.Status.DoorState", "Open") }), "door_open");
  assert.equal(availabilityReason({ stateValuesByFeature: new Map(startAvailabilityDevice().stateValuesByFeature).set("BSH.Common.Status.DoorState", "Ajar") }), "door_open");
  assert.notEqual(availabilityReason({ stateValuesByFeature: new Map(startAvailabilityDevice().stateValuesByFeature).set("BSH.Common.Status.DoorState", "Closed") }), "door_open");
  assert.notEqual(availabilityReason({ stateValuesByFeature: new Map(startAvailabilityDevice().stateValuesByFeature).set("BSH.Common.Status.DoorState", "Locked") }), "door_open");
});

test("start availability handles running operation states", () => {
  assert.equal(availabilityReason({ stateValuesByFeature: new Map(startAvailabilityDevice().stateValuesByFeature).set("BSH.Common.Status.OperationState", "Run") }), "already_running");
  assert.equal(availabilityReason({ stateValuesByFeature: new Map(startAvailabilityDevice().stateValuesByFeature).set("BSH.Common.Status.OperationState", "Running") }), "already_running");
});

test("start availability requires a selected program", () => {
  const stateValuesByFeature = new Map(startAvailabilityDevice().stateValuesByFeature);
  stateValuesByFeature.delete("BSH.Common.Root.SelectedProgram");
  assert.equal(availabilityReason({ stateValuesByFeature }), "no_selected_program");
  stateValuesByFeature.set("BSH.Common.Root.SelectedProgram", "");
  assert.equal(availabilityReason({ stateValuesByFeature }), "no_selected_program");
});

test("start availability handles remote start allowance", () => {
  for (const type of ["Dishwasher", "Washer", "Dryer"]) {
    assert.equal(availabilityReason({ type, stateValuesByFeature: new Map(startAvailabilityDevice({ type }).stateValuesByFeature).set("BSH.Common.Status.RemoteControlStartAllowed", false) }), "remote_start_not_allowed");
  }
});

test("start availability handles appliance-specific power rules", () => {
  assert.equal(availabilityReason({ type: "Washer", stateValuesByFeature: new Map(startAvailabilityDevice({ type: "Washer" }).stateValuesByFeature).set("BSH.Common.Setting.PowerState", "MainsOff") }), "power_off");
  assert.equal(availabilityReason({ type: "Dryer", stateValuesByFeature: new Map(startAvailabilityDevice({ type: "Dryer" }).stateValuesByFeature).set("BSH.Common.Setting.PowerState", "Off") }), "power_off");
  const dishwasher = evaluateStartAvailability(startAvailabilityDevice({ type: "Dishwasher", stateValuesByFeature: new Map(startAvailabilityDevice({ type: "Dishwasher" }).stateValuesByFeature).set("BSH.Common.Setting.PowerState", "Off") }), true);
  assert.equal(dishwasher.reason, "ready");
  assert.equal(dishwasher.canStart, true);
});

test("start availability reports ready state", () => {
  for (const type of ["Dishwasher", "Washer", "Dryer"]) {
    const availability = evaluateStartAvailability(startAvailabilityDevice({ type }), true);
    assert.equal(availability.canStart, true);
    assert.equal(availability.reason, "ready");
  }
});

test("start availability resolves raw numeric values through enum mapping", () => {
  const base = startAvailabilityDevice({ stateValuesByFeature: new Map() });
  assert.equal(evaluateStartAvailability({ ...base, rawValuesByFeature: new Map([["BSH.Common.Status.DoorState", 1], ["BSH.Common.Status.OperationState", 2], ["BSH.Common.Setting.PowerState", 2], ["BSH.Common.Status.RemoteControlStartAllowed", true], ["BSH.Common.Root.SelectedProgram", 100]]) }, true).reason, "door_open");
  assert.notEqual(evaluateStartAvailability({ ...base, rawValuesByFeature: new Map([["BSH.Common.Status.DoorState", 2], ["BSH.Common.Status.OperationState", 2], ["BSH.Common.Setting.PowerState", 2], ["BSH.Common.Status.RemoteControlStartAllowed", true], ["BSH.Common.Root.SelectedProgram", 100]]) }, true).reason, "door_open");
  assert.equal(evaluateStartAvailability({ ...base, rawValuesByFeature: new Map([["BSH.Common.Status.DoorState", 3], ["BSH.Common.Status.OperationState", 1], ["BSH.Common.Setting.PowerState", 2], ["BSH.Common.Status.RemoteControlStartAllowed", true], ["BSH.Common.Root.SelectedProgram", 100]]) }, true).reason, "already_running");
  assert.equal(evaluateStartAvailability({ ...base, rawValuesByFeature: new Map([["BSH.Common.Status.DoorState", 3], ["BSH.Common.Status.OperationState", 2], ["BSH.Common.Setting.PowerState", 1], ["BSH.Common.Status.RemoteControlStartAllowed", true], ["BSH.Common.Root.SelectedProgram", 100]]) }, true).reason, "power_off");
  assert.notEqual(evaluateStartAvailability({ ...base, rawValuesByFeature: new Map([["BSH.Common.Status.DoorState", 3], ["BSH.Common.Status.OperationState", 2], ["BSH.Common.Setting.PowerState", 2], ["BSH.Common.Status.RemoteControlStartAllowed", true], ["BSH.Common.Root.SelectedProgram", 100]]) }, true).reason, "power_off");
});

const {
  clearProgramPhaseDisplayTargets,
  coerceStateValueForObjectType,
  finalProgramEndCompanionTargets,
  finalProgramEndDisplayTargets,
  finalProgramTelemetryTargets,
  isActiveProgramFinishedEventValue,
  isFinishedOperationState,
  isIdleOperationState,
  isNoActiveProgramValue,
  isOffEffectivePowerState,
  nonEmptyClearProgramPhaseDisplayTargets,
} = require("../build/lib/programTelemetryFinalizer");

function telemetryProfile() {
  return {
    haId: "ha-telemetry",
    type: "Washer",
    connectionType: "TLS",
    key: "",
    featureMapping: {
      featuresByUid: {
        "021C": "BSH.Common.Option.ProgramProgress",
        "0220": "BSH.Common.Option.RemainingProgramTime",
        "0228": "BSH.Common.Status.OperationState",
        "0210": "BSH.Common.Root.ActiveProgram",
        "0221": "LaundryCare.Common.Option.ProcessPhase",
      },
      enumTypeByUid: { "0228": "OperationState", "0221": "ProcessPhase" },
      enumValuesByType: { OperationState: { 1: "Run", 2: "Ready", 3: "Running", 6: "Finished" }, ProcessPhase: { 5: "Washing", 21: "Drying" } },
      programOptionsByUid: {},
    },
  };
}

test("OperationState Finished is detected for final program telemetry", () => {
  assert.equal(isFinishedOperationState("Finished"), true);
  assert.equal(isFinishedOperationState(" Run "), false);
  assert.equal(isFinishedOperationState("Running"), false);
});

test("ProgramFinished active values match event summary semantics", () => {
  for (const value of [true, 1, "Present", "Confirmed", "true", "1"]) {
    assert.equal(isActiveProgramFinishedEventValue(value), true);
  }
});

test("ProgramFinished inactive values do not finalize program telemetry", () => {
  for (const value of [false, 0, "Off", "false", "0", ""]) {
    assert.equal(isActiveProgramFinishedEventValue(value), false);
  }
});

test("final program telemetry targets write only mapped normal states", () => {
  assert.deepEqual(finalProgramTelemetryTargets(telemetryProfile(), "appliance"), [
    { feature: "BSH.Common.Option.ProgramProgress", value: 100, stateId: "appliance.options.ProgramProgress" },
    { feature: "BSH.Common.Option.RemainingProgramTime", value: 0, stateId: "appliance.options.RemainingProgramTime" },
  ]);
});

test("real ProgramProgress and RemainingProgramTime values map normally", () => {
  const { StateMapper } = require("../build/lib/stateMapper");
  const mapper = new StateMapper(telemetryProfile());
  assert.deepEqual(mapper.toStateTarget({ uid: "021C", value: 98 }), {
    id: "options.ProgramProgress",
    name: "BSH.Common.Option.ProgramProgress",
    value: 98,
    rawValue: 98,
    category: "options",
    uid: "021C",
  });
  assert.deepEqual(mapper.toStateTarget({ uid: "0220", value: 60 }), {
    id: "options.RemainingProgramTime",
    name: "BSH.Common.Option.RemainingProgramTime",
    value: 60,
    rawValue: 60,
    category: "options",
    uid: "0220",
  });
});

test("ActiveProgram zero is not a final telemetry target", () => {
  const { StateMapper } = require("../build/lib/stateMapper");
  const mapper = new StateMapper(telemetryProfile());
  const activeProgram = mapper.toStateTarget({ uid: "0210", value: 0 });
  assert.equal(activeProgram.id, "program.RootActiveProgram");
  assert.deepEqual(finalProgramTelemetryTargets(telemetryProfile(), "appliance").map(target => target.stateId), [
    "appliance.options.ProgramProgress",
    "appliance.options.RemainingProgramTime",
  ]);
});

test("final program telemetry targets do not include raw states", () => {
  assert.equal(finalProgramTelemetryTargets(telemetryProfile(), "appliance").some(target => target.stateId.includes(".raw.")), false);
});


function dishwasherTelemetryProfile() {
  return {
    ...telemetryProfile(),
    type: "Dishwasher",
    featureMapping: {
      ...telemetryProfile().featureMapping,
      featuresByUid: {
        ...telemetryProfile().featureMapping.featuresByUid,
        "0301": "Dishcare.Dishwasher.Status.ProgramPhase",
      },
      enumTypeByUid: { ...telemetryProfile().featureMapping.enumTypeByUid, "0301": "ProgramPhase" },
      enumValuesByType: { ...telemetryProfile().featureMapping.enumValuesByType, ProgramPhase: { 1: "MainWash", 2: "Drying" } },
    },
  };
}

test("final program end display targets include ProcessPhase and German companion but no raw states", () => {
  assert.deepEqual(finalProgramEndDisplayTargets(telemetryProfile(), "appliance"), [
    { feature: "BSH.Common.Option.ProgramProgress", value: 100, stateId: "appliance.options.ProgramProgress" },
    { feature: "BSH.Common.Option.RemainingProgramTime", value: 0, stateId: "appliance.options.RemainingProgramTime" },
    { feature: "LaundryCare.Common.Option.ProcessPhase", value: "Finished", stateId: "appliance.phases.ProcessPhase" },
  ]);
  assert.deepEqual(finalProgramEndCompanionTargets(telemetryProfile(), "appliance"), [
    { feature: "LaundryCare.Common.Option.ProcessPhase_de", value: "Fertig", stateId: "appliance.phases.ProcessPhase_de" },
  ]);
  assert.equal(finalProgramEndDisplayTargets(telemetryProfile(), "appliance").some(target => target.stateId.includes(".raw.") || target.stateId.endsWith("_raw")), false);
  assert.equal(finalProgramEndCompanionTargets(telemetryProfile(), "appliance").some(target => target.stateId.includes(".raw.") || target.stateId.endsWith("_raw")), false);
});

test("final program end display targets include dishwasher ProgramPhase when profile has it", () => {
  assert.equal(finalProgramEndDisplayTargets(dishwasherTelemetryProfile(), "appliance").some(target => target.stateId === "appliance.phases.ProgramPhase" && target.value === "Finished"), true);
  assert.equal(finalProgramEndCompanionTargets(dishwasherTelemetryProfile(), "appliance").some(target => target.stateId === "appliance.phases.ProgramPhase_de" && target.value === "Fertig"), true);
});

test("final program end display targets skip phases when profile has no phase feature", () => {
  const profile = telemetryProfile();
  delete profile.featureMapping.featuresByUid["0221"];
  assert.deepEqual(finalProgramEndDisplayTargets(profile, "appliance").map(target => target.stateId), [
    "appliance.options.ProgramProgress",
    "appliance.options.RemainingProgramTime",
  ]);
  assert.deepEqual(finalProgramEndCompanionTargets(profile, "appliance"), []);
});

test("real phase values map normally and running states are not final states", () => {
  const { StateMapper } = require("../build/lib/stateMapper");
  const mapper = new StateMapper(telemetryProfile());
  assert.deepEqual(mapper.toStateTarget({ uid: "0221", value: 5 }), {
    id: "phases.ProcessPhase",
    name: "LaundryCare.Common.Option.ProcessPhase",
    value: "Washing",
    rawValue: 5,
    category: "phases",
    uid: "0221",
  });
  assert.equal(isFinishedOperationState("Run"), false);
  assert.equal(isFinishedOperationState("Running"), false);
});


test("Laundry Dryer ProcessPhase idle/no-phase values clear display value but keep raw value", () => {
  const { StateMapper } = require("../build/lib/stateMapper");
  const profile = telemetryProfile();
  profile.featureMapping.featuresByUid["0221"] = "LaundryCare.Dryer.Option.ProcessPhase";
  profile.featureMapping.enumValuesByType.ProcessPhase[0] = "NoPhase";
  const mapper = new StateMapper(profile);

  for (const rawValue of [0, "NoPhase", "No Phase", "Keine Phase", "LaundryCare.Dryer.Option.ProcessPhase.NoPhase"]) {
    assert.deepEqual(mapper.toStateTarget({ uid: "0221", value: rawValue }), {
      id: "phases.ProcessPhase",
      name: "LaundryCare.Dryer.Option.ProcessPhase",
      value: "",
      rawValue,
      category: "phases",
      uid: "0221",
    });
  }
});

test("translated companion values stay empty for intentionally cleared ProcessPhase targets", () => {
  const cases = [
    { name: "LaundryCare.Dryer.Option.ProcessPhase", value: "", rawValue: 0, enumText: "NoPhase" },
    { name: "LaundryCare.Dryer.Option.ProcessPhase", value: "", rawValue: "NoPhase", enumText: "NoPhase" },
    { name: "LaundryCare.Dryer.Option.ProcessPhase", value: "", rawValue: "Keine Phase", enumText: "Keine Phase" },
    { name: "LaundryCare.Common.Option.ProcessPhase", value: "", rawValue: 255, enumText: "NoPhase" },
  ];

  for (const item of cases) {
    const target = {
      id: "phases.ProcessPhase",
      name: item.name,
      value: item.value,
      rawValue: item.rawValue,
      category: "phases",
      uid: "0221",
    };
    assert.equal(translatedCompanionValueForTarget(target, item.enumText), "");
    assert.equal(target.rawValue, item.rawValue);
  }
});

test("translated companion values keep real and finished ProcessPhase translations", () => {
  const dryingTarget = {
    id: "phases.ProcessPhase",
    name: "LaundryCare.Dryer.Option.ProcessPhase",
    value: "Drying",
    rawValue: 21,
    category: "phases",
    uid: "0221",
  };
  const finishedTarget = { ...dryingTarget, value: "Finished", rawValue: 6 };

  assert.equal(translatedCompanionValueForTarget(dryingTarget, "Drying"), "Trocknen");
  assert.equal(translatedCompanionValueForTarget(finishedTarget, "Finished"), "Fertig");
  assert.equal(dryingTarget.rawValue, 21);
});

test("Laundry Dryer ProcessPhase real phase values map normally and keep raw companion input", () => {
  const { StateMapper } = require("../build/lib/stateMapper");
  const profile = telemetryProfile();
  profile.featureMapping.featuresByUid["0221"] = "LaundryCare.Dryer.Option.ProcessPhase";
  const mapper = new StateMapper(profile);
  const target = mapper.toStateTarget({ uid: "0221", value: 21 });

  assert.deepEqual(target, {
    id: "phases.ProcessPhase",
    name: "LaundryCare.Dryer.Option.ProcessPhase",
    value: "Drying",
    rawValue: 21,
    category: "phases",
    uid: "0221",
  });
  assert.equal(translateEnumValue(target.name, String(target.value), target.rawValue), "Trocknen");
});


test("Laundry ProcessPhase raw 255 clears display value but keeps raw value", () => {
  const { StateMapper } = require("../build/lib/stateMapper");
  for (const feature of ["LaundryCare.Common.Option.ProcessPhase", "LaundryCare.Dryer.Option.ProcessPhase"]) {
    const profile = telemetryProfile();
    profile.featureMapping.featuresByUid["0221"] = feature;
    const mapper = new StateMapper(profile);
    assert.deepEqual(mapper.toStateTarget({ uid: "0221", value: 255 }), {
      id: "phases.ProcessPhase",
      name: feature,
      value: "",
      rawValue: 255,
      category: "phases",
      uid: "0221",
    });
  }
});

test("Laundry ProcessPhase raw 255 does not clear raw companion input", () => {
  const { StateMapper } = require("../build/lib/stateMapper");
  const mapper = new StateMapper(telemetryProfile());
  const target = mapper.toStateTarget({ uid: "0221", value: 255 });
  assert.equal(target.value, "");
  assert.equal(target.rawValue, 255);
  assert.equal(target.id, "phases.ProcessPhase");
  assert.equal(translateEnumValue(target.name, String(target.value), target.rawValue), "");
});


test("idle/off program end signals clear displayed phases", () => {
  assert.deepEqual(clearProgramPhaseDisplayTargets(telemetryProfile(), "appliance"), [
    { feature: "LaundryCare.Common.Option.ProcessPhase", value: "", stateId: "appliance.phases.ProcessPhase" },
    { feature: "LaundryCare.Common.Option.ProcessPhase_de", value: "", stateId: "appliance.phases.ProcessPhase_de" },
  ]);
  assert.equal(isIdleOperationState("Ready"), true);
  assert.equal(isIdleOperationState("Off"), true);
  assert.equal(isIdleOperationState("Inactive"), true);
  assert.equal(isIdleOperationState("Running"), false);
  assert.equal(isNoActiveProgramValue(0), true);
  assert.equal(isNoActiveProgramValue("0"), true);
  assert.equal(isNoActiveProgramValue("Dishcare.Dishwasher.Program.Intensiv70"), false);
  assert.equal(isOffEffectivePowerState("Offline"), true);
  assert.equal(isOffEffectivePowerState("Off"), true);
  assert.equal(isOffEffectivePowerState("MainsOff"), true);
  assert.equal(isOffEffectivePowerState("Standby"), false);
});

test("clear phase targets include dishwasher ProgramPhase and German companion but no raw states", () => {
  assert.deepEqual(clearProgramPhaseDisplayTargets(dishwasherTelemetryProfile(), "appliance").filter(target => target.stateId.includes("ProgramPhase")), [
    { feature: "Dishcare.Dishwasher.Status.ProgramPhase", value: "", stateId: "appliance.phases.ProgramPhase" },
    { feature: "Dishcare.Dishwasher.Status.ProgramPhase_de", value: "", stateId: "appliance.phases.ProgramPhase_de" },
  ]);
  assert.equal(clearProgramPhaseDisplayTargets(dishwasherTelemetryProfile(), "appliance").some(target => target.stateId.includes(".raw.") || target.stateId.endsWith("_raw")), false);
});


test("clear phase targets only select non-empty display values", () => {
  const targets = clearProgramPhaseDisplayTargets(telemetryProfile(), "appliance");
  const currentValues = new Map([
    ["LaundryCare.Common.Option.ProcessPhase", "Finished"],
    ["LaundryCare.Common.Option.ProcessPhase_de", "Fertig"],
    ["LaundryCare.Common.Option.ProcessPhase_raw", 255],
  ]);

  assert.deepEqual(nonEmptyClearProgramPhaseDisplayTargets(targets, currentValues), targets);
  assert.equal(targets.some(target => target.stateId.includes(".raw.") || target.stateId.endsWith("_raw")), false);
});

test("clear phase targets do not select already empty display values", () => {
  const targets = clearProgramPhaseDisplayTargets(telemetryProfile(), "appliance");
  const currentValues = new Map([
    ["LaundryCare.Common.Option.ProcessPhase", ""],
    ["LaundryCare.Common.Option.ProcessPhase_de", ""],
    ["LaundryCare.Common.Option.ProcessPhase_raw", 255],
  ]);

  assert.deepEqual(nonEmptyClearProgramPhaseDisplayTargets(targets, currentValues), []);
  assert.equal(currentValues.get("LaundryCare.Common.Option.ProcessPhase_raw"), 255);
});

test("repeated idle/off clear only writes phase display targets once", () => {
  const targets = clearProgramPhaseDisplayTargets(telemetryProfile(), "appliance");
  const currentValues = new Map([
    ["LaundryCare.Common.Option.ProcessPhase", "Finished"],
    ["LaundryCare.Common.Option.ProcessPhase_de", "Fertig"],
  ]);
  const firstTargets = nonEmptyClearProgramPhaseDisplayTargets(targets, currentValues);
  for (const target of firstTargets) currentValues.set(target.feature, target.value);

  assert.deepEqual(firstTargets, targets);
  assert.deepEqual(nonEmptyClearProgramPhaseDisplayTargets(targets, currentValues), []);
});

test("finalized telemetry values respect object types", () => {
  assert.equal(coerceStateValueForObjectType(0, "number"), 0);
  assert.equal(coerceStateValueForObjectType(0, "string"), "0");
  assert.equal(coerceStateValueForObjectType(100, "number"), 100);
  assert.equal(coerceStateValueForObjectType(100, "string"), "100");
  assert.equal(coerceStateValueForObjectType(0, undefined), 0);
});

test("ProgramAborted event summary text is neutral", () => {
  const items = activeEventSummaryItems(new Map([["BSH.Common.Event.ProgramAborted", "Present"]]));
  assert.equal(activeEventSummaryTextDe(items), "Abbruchmeldung offen");
});

const { parseMessage } = require("../build/lib/message");
const { parseRepairedAllMandatoryValuesResponse } = require("../build/lib/client");
const { calculateIdleSeconds, recordHomeConnectFrame, shouldHeartbeatDevice, WATCHDOG_HEARTBEAT_REQUEST } = require("../build/lib/runtimeTypes");
const { connectionFailureLogLevel, connectionFailureLogMessage, isExpectedOfflineError } = require("../build/lib/reconnectPolicy");

function watchdogDevice(overrides = {}) {
  return {
    connected: true,
    reconnecting: false,
    client: { sendSync: async () => ({ resource: "/ni/info", version: 1, action: "RESPONSE" }) },
    ...overrides,
  };
}


test("duplicate connection close is treated as reconnectable offline condition", () => {
  const message = "Socket closed: 1000 Duplicate connection to this deviceID detected.";

  assert.equal(isExpectedOfflineError(message), true);
  assert.equal(connectionFailureLogLevel(message, 1), "info");
  assert.equal(connectionFailureLogLevel(message, 2), "debug");
  assert.equal(connectionFailureLogMessage("ha-1", message, 1), `ha-1: offline: ${message}`);
  assert.equal(connectionFailureLogMessage("ha-1", message, 2), `ha-1: still offline, retrying: ${message}`);
});

test("device connect and reconnect flags guard duplicate connection attempts", () => {
  const device = watchdogDevice({ connecting: false, reconnecting: false, reconnectTimer: undefined });
  let connects = 0;
  function guardedConnect() {
    if (device.connecting || device.reconnecting) return;
    device.connecting = true;
    connects += 1;
  }

  guardedConnect();
  guardedConnect();

  assert.equal(connects, 1);
});

test("reconnect scheduling keeps only one retry timer per device", () => {
  const timers = [];
  const device = watchdogDevice({ reconnecting: false, reconnectTimer: undefined });
  function scheduleReconnect() {
    if (device.reconnecting || device.reconnectTimer) return;
    device.reconnecting = true;
    device.reconnectTimer = setTimeout(() => {}, 30_000);
    timers.push(device.reconnectTimer);
  }

  scheduleReconnect();
  scheduleReconnect();

  for (const timer of timers) clearTimeout(timer);
  assert.equal(timers.length, 1);
});

test("watchdog timestamps are updated for every frame and RO frames", () => {
  const device = watchdogDevice();
  recordHomeConnectFrame(device, "/ni/info", 1000);
  assert.equal(device.lastRxAt, 1000);
  assert.equal(device.lastRoRxAt, undefined);
  recordHomeConnectFrame(device, "/ro/values", 2000);
  assert.equal(device.lastRxAt, 2000);
  assert.equal(device.lastRoRxAt, 2000);
  recordHomeConnectFrame(device, "/ro/descriptionChange", 3000);
  assert.equal(device.lastRoRxAt, 3000);
  recordHomeConnectFrame(device, "/ro/allMandatoryValues", 4000);
  assert.equal(device.lastRoRxAt, 4000);
});

test("watchdog skips fresh idle devices and unloaded/disconnected style states", () => {
  assert.equal(shouldHeartbeatDevice(watchdogDevice({ lastRxAt: 1_000 }), 60_000), false);
  assert.equal(shouldHeartbeatDevice(watchdogDevice({ connected: false, lastRxAt: 1_000 }), 400_000), false);
  assert.equal(shouldHeartbeatDevice(watchdogDevice({ reconnecting: true, lastRxAt: 1_000 }), 400_000), false);
  assert.equal(shouldHeartbeatDevice(watchdogDevice({ watchdogHeartbeatInFlight: true, lastRxAt: 1_000 }), 400_000), false);
  assert.equal(shouldHeartbeatDevice(watchdogDevice({ client: undefined, lastRxAt: 1_000 }), 400_000), false);
});

test("watchdog requests heartbeat when last traffic is too old", () => {
  assert.equal(shouldHeartbeatDevice(watchdogDevice({ lastRxAt: 1_000 }), 301_000), false);
  assert.equal(shouldHeartbeatDevice(watchdogDevice({ lastRxAt: 1_000 }), 601_000), true);
});


test("watchdog heartbeat request uses /ni/info version 1", () => {
  assert.deepEqual(WATCHDOG_HEARTBEAT_REQUEST, { resource: "/ni/info", version: 1, action: "GET" });
  assert.notDeepEqual(WATCHDOG_HEARTBEAT_REQUEST, { resource: "/ci/services", version: 3, action: "GET" });
});

test("watchdog idle seconds are calculated before heartbeat response updates lastRxAt and never negative", () => {
  const device = watchdogDevice({ lastRxAt: 1_000 });
  const idleSeconds = calculateIdleSeconds(device.lastRxAt, 301_000);
  recordHomeConnectFrame(device, WATCHDOG_HEARTBEAT_REQUEST.resource, 302_000);
  assert.equal(idleSeconds, 300);
  assert.equal(calculateIdleSeconds(device.lastRxAt, 301_000), 0);
});

test("watchdog idle seconds for Home Connect error responses are clamped to zero", () => {
  const device = watchdogDevice({ lastRxAt: 301_500 });
  recordHomeConnectFrame(device, WATCHDOG_HEARTBEAT_REQUEST.resource, 302_000);
  const error = new Error(`Home Connect response code 404 (Not found) for ${WATCHDOG_HEARTBEAT_REQUEST.resource}`);
  assert.equal(error.message.includes("404"), true);
  assert.equal(calculateIdleSeconds(device.lastRxAt, 301_000), 0);
});

test("watchdog heartbeat success does not imply reconnect condition", async () => {
  let heartbeatCalls = 0;
  const device = watchdogDevice({
    lastRxAt: 1_000,
    client: { sendSync: async () => { heartbeatCalls += 1; return { resource: "/ni/info", version: 1, action: "RESPONSE" }; } },
  });
  assert.equal(shouldHeartbeatDevice(device, 601_000), true);
  await device.client.sendSync(WATCHDOG_HEARTBEAT_REQUEST);
  recordHomeConnectFrame(device, WATCHDOG_HEARTBEAT_REQUEST.resource, 601_000);
  assert.equal(heartbeatCalls, 1);
  assert.equal(shouldHeartbeatDevice(device, 601_001), false);
});

test("watchdog heartbeat failure can be guarded to exactly one reconnect", async () => {
  let reconnects = 0;
  const device = watchdogDevice({
    lastRxAt: 1_000,
    watchdogHeartbeatInFlight: false,
    client: { sendSync: async () => { throw new Error("timeout"); } },
  });
  if (shouldHeartbeatDevice(device, 601_000)) {
    device.watchdogHeartbeatInFlight = true;
    try { await device.client.sendSync(WATCHDOG_HEARTBEAT_REQUEST); }
    catch { reconnects += 1; device.reconnecting = true; }
    finally { device.watchdogHeartbeatInFlight = false; }
  }
  assert.equal(reconnects, 1);
  assert.equal(shouldHeartbeatDevice(device, 302_000), false);
});

test("watchdog interval guard prevents duplicate intervals", () => {
  const state = { timer: undefined, starts: 0 };
  function start() {
    if (state.timer) return;
    state.starts += 1;
    state.timer = setInterval(() => {}, 60_000);
  }
  start();
  start();
  clearInterval(state.timer);
  assert.equal(state.starts, 1);
});

test("unload-style connected flag prevents further watchdog actions", () => {
  const device = watchdogDevice({ lastRxAt: 1_000 });
  assert.equal(shouldHeartbeatDevice(device, 601_000), true);
  device.connected = false;
  assert.equal(shouldHeartbeatDevice(device, 602_000), false);
});

function allMandatoryPayload(dataSuffix, resource = "/ro/allMandatoryValues") {
  return `{"sID":1,"msgID":7,"resource":"${resource}","version":1,"action":"RESPONSE","data":[${dataSuffix}}`;
}

test("truncated allMandatoryValues response is repaired and parsed", () => {
  const payload = allMandatoryPayload('{"uid":100,"value":1},{"uid":8334,"value":0}');
  const repaired = parseRepairedAllMandatoryValuesResponse(payload, new SyntaxError("Expected ',' or ']' after array element"));
  assert.equal(repaired.resource, "/ro/allMandatoryValues");
  assert.deepEqual(repaired.data.map(item => item.uid), [100, 8334]);
});

test("valid allMandatoryValues response remains valid without repair", () => {
  const payload = '{"sID":1,"msgID":7,"resource":"/ro/allMandatoryValues","version":1,"action":"RESPONSE","data":[{"uid":100,"value":1}]}';
  assert.deepEqual(parseMessage(payload).data, [{ uid: 100, value: 1 }]);
  assert.equal(parseRepairedAllMandatoryValuesResponse(payload, new SyntaxError("unused")), undefined);
});

test("malformed response for other resources is not repaired", () => {
  const payload = allMandatoryPayload('{"uid":100,"value":1}', "/ro/values");
  assert.equal(parseRepairedAllMandatoryValuesResponse(payload, new SyntaxError("Expected ',' or ']' after array element")), undefined);
});

test("strongly broken allMandatoryValues response is not repaired", () => {
  const payload = '{"sID":1,"msgID":7,"resource":"/ro/allMandatoryValues","version":1,"action":"RESPONSE","data":[{"uid":100,"value":';
  assert.equal(parseRepairedAllMandatoryValuesResponse(payload, new SyntaxError("Unexpected end of JSON input")), undefined);
});

test("malformed allMandatoryValues retry classification remains available", () => {
  const payload = allMandatoryPayload('{"uid":100,"value":1');
  const repaired = parseRepairedAllMandatoryValuesResponse(payload, new SyntaxError("Expected ',' or ']' after array element"));
  assert.equal(repaired, undefined);
  assert.throws(() => parseMessage(payload), SyntaxError);
});

test("initial RO snapshot retries timeouts and malformed responses", () => {
  const { INITIAL_SNAPSHOT_BACKGROUND_RETRY_MS, isRetryableInitialReadError } = require("../build/lib/client");
  assert.equal(INITIAL_SNAPSHOT_BACKGROUND_RETRY_MS, 30_000);
  assert.equal(isRetryableInitialReadError(new Error("Timeout waiting for response to /ro/allMandatoryValues")), true);
  assert.equal(isRetryableInitialReadError(new Error("Malformed Home Connect JSON for /ro/allMandatoryValues")), true);
  assert.equal(isRetryableInitialReadError(new Error("Home Connect client closed")), false);
  assert.equal(isRetryableInitialReadError(new Error("Timeout waiting for response to /ni/info")), false);
});

function effectivePowerDevice(overrides = {}) {
  return {
    connected: true,
    stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "On"]]),
    rawValuesByFeature: new Map([["BSH.Common.Setting.PowerState", 2]]),
    profile: {
      featureMapping: {
        featuresByUid: { "0103": "BSH.Common.Setting.PowerState" },
        enumTypeByUid: { "0103": "PowerState" },
        enumValuesByType: { PowerState: { 1: "Off", 2: "On", 3: "MainsOff", 4: "Standby" } },
        programOptionsByUid: {},
      },
    },
    ...overrides,
  };
}

test("effective power state reports disconnected devices as offline without changing stored values", () => {
  const { evaluateEffectivePowerState } = require("../build/lib/effectivePowerState");
  const device = effectivePowerDevice({ connected: false });
  const stateValuesBefore = new Map(device.stateValuesByFeature);
  const rawValuesBefore = new Map(device.rawValuesByFeature);
  assert.deepEqual(evaluateEffectivePowerState(device), {
    effectivePowerState: "Offline",
    effectivePowerStateDe: "Aus / offline",
    isEffectivelyOn: false,
  });
  assert.deepEqual(device.stateValuesByFeature, stateValuesBefore);
  assert.deepEqual(device.rawValuesByFeature, rawValuesBefore);
});

test("effective power state maps connected known power states", () => {
  const { evaluateEffectivePowerState } = require("../build/lib/effectivePowerState");
  assert.equal(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "On"]]) })).isEffectivelyOn, true);
  assert.equal(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "MainsOff"]]) })).isEffectivelyOn, false);
  assert.equal(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "Off"]]) })).isEffectivelyOn, false);
  assert.equal(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "BSH.Common.EnumType.PowerState.Off"]]) })).isEffectivelyOn, false);
  assert.equal(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "PowerState.Off"]]) })).isEffectivelyOn, false);
  assert.equal(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "BSH.Common.EnumType.PowerState.MainsOff"]]) })).isEffectivelyOn, false);
  assert.equal(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "BSH.Common.EnumType.PowerState.On"]]) })).isEffectivelyOn, true);
  assert.deepEqual(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", "Standby"]]) })), {
    effectivePowerState: "Standby",
    effectivePowerStateDe: "Standby",
    isEffectivelyOn: true,
  });
});

test("effective power state resolves numeric PowerState through enum mapping", () => {
  const { evaluateEffectivePowerState } = require("../build/lib/effectivePowerState");
  assert.deepEqual(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map(), rawValuesByFeature: new Map([["BSH.Common.Setting.PowerState", 3]]) })), {
    effectivePowerState: "MainsOff",
    effectivePowerStateDe: "Aus",
    isEffectivelyOn: false,
  });
  assert.deepEqual(evaluateEffectivePowerState(effectivePowerDevice({ stateValuesByFeature: new Map([["BSH.Common.Setting.PowerState", 1]]) })), {
    effectivePowerState: "Off",
    effectivePowerStateDe: "Aus",
    isEffectivelyOn: false,
  });
});

function hobZoneDevice(entries, rawEntries = []) {
  return {
    stateValuesByFeature: new Map(entries),
    rawValuesByFeature: new Map(rawEntries),
  };
}

function hobFeature(zone, field) {
  return `Cooking.Hob.Status.Zone.${zone}.${field}`;
}

test("hob active zone summary treats ActiveProgram with zero PowerLevel as active", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const summary = evaluateHobZoneSummary(hobZoneDevice([
    [hobFeature("120", "ActiveProgram"), 12289],
    [hobFeature("120", "PowerLevel"), 0],
  ]));
  assert.equal(summary.activeZones.length, 1);
  assert.equal(summary.activeZones[0].zone, "120");
  assert.equal(summary.activeZones[0].activeProgram, 12289);
  assert.equal(summary.activeZones[0].powerLevel, 0);
});

test("hob active zone summary ignores default ActiveProgram when zone is explicitly off and ready", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  for (const activeProgram of ["Cooking.Hob.Program.PowerLevelMode", 12289]) {
    const summary = evaluateHobZoneSummary(hobZoneDevice([
      [hobFeature("100", "State"), "Off"],
      [hobFeature("100", "OperationState"), "Ready"],
      [hobFeature("100", "PowerLevel"), "Off"],
      [hobFeature("100", "ActiveProgram"), activeProgram],
    ]));
    assert.equal(summary.activeZones.length, 0);
  }
});

test("hob active zone summary treats State Active as active despite default ActiveProgram and off PowerLevel", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const summary = evaluateHobZoneSummary(hobZoneDevice([
    [hobFeature("120", "State"), "Active"],
    [hobFeature("120", "ActiveProgram"), "Cooking.Hob.Program.PowerLevelMode"],
    [hobFeature("120", "PowerLevel"), "Off"],
  ]));
  assert.deepEqual(summary.activeZones.map(zone => zone.zone), ["120"]);
});

test("hob active zone summary treats active OperationState as active with off PowerLevel", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const summary = evaluateHobZoneSummary(hobZoneDevice([
    [hobFeature("130", "OperationState"), "Active"],
    [hobFeature("130", "PowerLevel"), "Off"],
  ]));
  assert.deepEqual(summary.activeZones.map(zone => zone.zone), ["130"]);
});

test("hob active zone summary treats positive PowerLevel as active", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const summary = evaluateHobZoneSummary(hobZoneDevice([[hobFeature("340", "PowerLevel"), 5]]));
  assert.deepEqual(summary.activeZones.map(zone => zone.zone), ["340"]);
});

test("hob active zone summary treats State Active as active", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const summary = evaluateHobZoneSummary(hobZoneDevice([[hobFeature("560", "State"), "Active"]]));
  assert.deepEqual(summary.activeZones.map(zone => zone.zone), ["560"]);
});

test("hob active zone summary treats active OperationState values as active", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  for (const operationState of ["Active", "Run", "Running", "On", 1]) {
    const summary = evaluateHobZoneSummary(hobZoneDevice([[hobFeature("780", "OperationState"), operationState]]));
    assert.deepEqual(summary.activeZones.map(zone => zone.zone), ["780"]);
  }
});

test("hob active zone summary can use raw numeric OperationState enum value", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const summary = evaluateHobZoneSummary(hobZoneDevice(
    [[hobFeature("901", "OperationState"), "Unknown(1)"]],
    [[hobFeature("901", "OperationState"), 1]],
  ));
  assert.deepEqual(summary.activeZones.map(zone => zone.zone), ["901"]);
});

test("hob inactive zone states are not active", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const offSummary = evaluateHobZoneSummary(hobZoneDevice([
    [hobFeature("120", "State"), "Off"],
    [hobFeature("120", "ActiveProgram"), 0],
    [hobFeature("120", "PowerLevel"), 0],
  ]));
  const notSelectableSummary = evaluateHobZoneSummary(hobZoneDevice([[hobFeature("340", "State"), "NotSelectable"]]));
  assert.equal(offSummary.activeZones.length, 0);
  assert.equal(notSelectableSummary.activeZones.length, 0);
});

test("hob residual heat zones are not active but are reported separately", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const summary = evaluateHobZoneSummary(hobZoneDevice([
    [hobFeature("120", "State"), "ResidualHeat"],
    [hobFeature("340", "State"), "ResiduelHeat"],
  ]));
  assert.equal(summary.activeZones.length, 0);
  assert.deepEqual(summary.residualHeatZones.map(zone => zone.zone), ["120", "340"]);
  assert.equal(summary.residualHeatZonesText, "120, 340");
});

test("hob active zone summary exposes boolean, JSON, and text friendly values", () => {
  const { evaluateHobZoneSummary } = require("../build/lib/hobActiveZones");
  const activeSummary = evaluateHobZoneSummary(hobZoneDevice([
    [hobFeature("340", "PowerLevel"), 3],
    [hobFeature("120", "ActiveProgram"), 12289],
    [hobFeature("120", "PowerLevel"), 0],
  ]));
  const inactiveSummary = evaluateHobZoneSummary(hobZoneDevice([[hobFeature("560", "State"), "Off"]]));
  assert.equal(activeSummary.activeZones.length > 0, true);
  assert.equal(activeSummary.activeZonesText, "120, 340");
  assert.equal(JSON.parse(JSON.stringify(activeSummary.activeZones))[0].zone, "120");
  assert.equal(inactiveSummary.activeZones.length > 0, false);
  assert.equal(inactiveSummary.activeZonesText, "");
});

test("hob zone feature detection is generic and not UID based", () => {
  const { isHobZoneFeature } = require("../build/lib/hobActiveZones");
  assert.equal(isHobZoneFeature(hobFeature("120", "State")), true);
  assert.equal(isHobZoneFeature(hobFeature("120", "OperationState")), true);
  assert.equal(isHobZoneFeature(hobFeature("120", "ActiveProgram")), true);
  assert.equal(isHobZoneFeature(hobFeature("120", "PowerLevel")), true);
  assert.equal(isHobZoneFeature("Cooking.Hob.Status.Zone.120.Temperature"), false);
});
