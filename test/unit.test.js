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
