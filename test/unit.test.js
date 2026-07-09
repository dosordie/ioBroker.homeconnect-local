const assert = require("node:assert/strict");
const { test } = require("node:test");

const { translateEnumValue } = require("../build/lib/enumTranslations");
const { metadataForFeature } = require("../build/lib/stateMetadata");
const { hasWritableProgramOption } = require("../build/lib/optionWriteability");

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
  assert.equal(
    translateEnumValue("BSH.Common.Status.ProgramRunDetail.EndTrigger", "ProgramAbortedByUser", 1),
    "Programm vom Benutzer abgebrochen",
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
  finalProgramTelemetryTargets,
  isActiveProgramFinishedEventValue,
  isFinishedOperationState,
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
      },
      enumTypeByUid: { "0228": "OperationState" },
      enumValuesByType: { OperationState: { 1: "Run", 2: "Ready", 3: "Running", 6: "Finished" } },
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
