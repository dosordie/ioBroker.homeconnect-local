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

const { evaluateStartAvailability } = require("../build/lib/startAvailability");

function startAvailabilityDevice(type, values = {}, rawValues = {}, featuresByUid = {}, enumTypeByUid = {}, enumValuesByType = {}) {
  const device = {
    baseId: "device",
    config: { type },
    profile: {
      haId: "ha-start",
      type,
      connectionType: "TLS",
      key: "key",
      featureMapping: {
        featuresByUid: { "0100": "BSH.Common.Root.ActiveProgram", ...featuresByUid },
        enumTypeByUid,
        enumValuesByType,
        programOptionsByUid: {},
      },
    },
    mapper: {},
    reconnecting: false,
    connected: true,
    reconnectFailures: 0,
    writableUids: new Set(["0100"]),
    readOnlyUids: new Set(),
    blockedCommands: [],
    stateValuesByFeature: new Map(Object.entries(values)),
    rawValuesByFeature: new Map(Object.entries(rawValues)),
    eventValuesByFeature: new Map(),
    programExecutionByFeature: new Map(),
  };
  return device;
}

function readyValues(extra = {}) {
  return {
    "BSH.Common.Root.SelectedProgram": 123,
    "BSH.Common.Status.DoorState": "Closed",
    "BSH.Common.Status.OperationState": "Ready",
    "BSH.Common.Status.RemoteControlStartAllowed": true,
    "BSH.Common.Setting.PowerState": "On",
    ...extra,
  };
}

test("start availability reports disconnected appliances", () => {
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Washer", readyValues()), false).reason, "not_connected");
});

test("start availability blocks open and ajar doors but not closed or locked doors", () => {
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Status.DoorState": "Open" })), true).reason, "door_open");
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Status.DoorState": "Ajar" })), true).reason, "door_open");
  assert.notEqual(evaluateStartAvailability(startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Status.DoorState": "Closed" })), true).reason, "door_open");
  assert.notEqual(evaluateStartAvailability(startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Status.DoorState": "Locked" })), true).reason, "door_open");
});

test("start availability blocks running operation state", () => {
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Dryer", readyValues({ "BSH.Common.Status.OperationState": "Run" })), true).reason, "already_running");
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Dryer", readyValues({ "BSH.Common.Status.OperationState": "Running" })), true).reason, "already_running");
});

test("start availability requires a selected program", () => {
  const values = readyValues({ "BSH.Common.Root.SelectedProgram": "" });
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Dishwasher", values), true).reason, "no_selected_program");
});

test("start availability checks remote-start allowance for dishwasher washer and dryer", () => {
  for (const type of ["Dishwasher", "Washer", "Dryer"]) {
    assert.equal(evaluateStartAvailability(startAvailabilityDevice(type, readyValues({ "BSH.Common.Status.RemoteControlStartAllowed": false })), true).reason, "remote_start_not_allowed");
  }
});

test("start availability checks power-on for washer and dryer but not dishwasher", () => {
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Setting.PowerState": "MainsOff" })), true).reason, "power_off");
  assert.equal(evaluateStartAvailability(startAvailabilityDevice("Dryer", readyValues({ "BSH.Common.Setting.PowerState": "Off" })), true).reason, "power_off");
  const dishwasherAvailability = evaluateStartAvailability(startAvailabilityDevice("Dishwasher", readyValues({ "BSH.Common.Setting.PowerState": "Off" })), true);
  assert.equal(dishwasherAvailability.reason, "ready");
  assert.equal(dishwasherAvailability.canStart, true);
});

test("start availability reports ready when all known start conditions pass", () => {
  const availability = evaluateStartAvailability(startAvailabilityDevice("Washer", readyValues()), true);
  assert.deepEqual(availability, { canStart: true, reason: "ready", reasonDe: "startbereit" });
});

test("start availability resolves raw numeric DoorState enum values", () => {
  const featuresByUid = { "0200": "BSH.Common.Status.DoorState" };
  const enumProfile = { "0200": "BSH.Common.EnumType.DoorState" };
  const enumValues = { "BSH.Common.EnumType.DoorState": { "1": "Open", "2": "Locked" } };
  const openDevice = startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Status.DoorState": undefined }), { "BSH.Common.Status.DoorState": 1 }, featuresByUid, enumProfile, enumValues);
  const lockedDevice = startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Status.DoorState": undefined }), { "BSH.Common.Status.DoorState": 2 }, featuresByUid, enumProfile, enumValues);
  openDevice.stateValuesByFeature.delete("BSH.Common.Status.DoorState");
  lockedDevice.stateValuesByFeature.delete("BSH.Common.Status.DoorState");
  assert.equal(evaluateStartAvailability(openDevice, true).reason, "door_open");
  assert.notEqual(evaluateStartAvailability(lockedDevice, true).reason, "door_open");
});

test("start availability resolves raw numeric OperationState enum values", () => {
  const featuresByUid = { "0300": "BSH.Common.Status.OperationState" };
  const enumProfile = { "0300": "BSH.Common.EnumType.OperationState" };
  const enumValues = { "BSH.Common.EnumType.OperationState": { "5": "Run" } };
  const device = startAvailabilityDevice("Dryer", readyValues({ "BSH.Common.Status.OperationState": undefined }), { "BSH.Common.Status.OperationState": 5 }, featuresByUid, enumProfile, enumValues);
  device.stateValuesByFeature.delete("BSH.Common.Status.OperationState");
  assert.equal(evaluateStartAvailability(device, true).reason, "already_running");
});

test("start availability handles raw numeric PowerState constants", () => {
  const offDevice = startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Setting.PowerState": undefined }), { "BSH.Common.Setting.PowerState": 1 });
  const onDevice = startAvailabilityDevice("Washer", readyValues({ "BSH.Common.Setting.PowerState": undefined }), { "BSH.Common.Setting.PowerState": 2 });
  offDevice.stateValuesByFeature.delete("BSH.Common.Setting.PowerState");
  onDevice.stateValuesByFeature.delete("BSH.Common.Setting.PowerState");
  assert.equal(evaluateStartAvailability(offDevice, true).reason, "power_off");
  assert.notEqual(evaluateStartAvailability(onDevice, true).reason, "power_off");
});
