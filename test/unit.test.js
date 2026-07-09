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
