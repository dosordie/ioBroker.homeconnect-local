import * as utils from "@iobroker/adapter-core";

import { HomeConnectClient } from "./lib/client";
import { ensureDiagnosticStates, writeApplianceInfo, writeNetworkInfo, writeRegisteredDevices } from "./lib/diagnosticsWriter";
import { ensureButtonStateObject, ensureChannel, ensureStateObject, setBooleanState, setNumberState, setTextState } from "./lib/objectHelpers";
import { translateEnumValue, translatedCompanionValueForTarget } from "./lib/enumTranslations";
import { displayNameForProgram, programStatesForDevice, resolveProgramKeyForDevice } from "./lib/programStates";
import { mergeMetadata, metadataForFeature, metadataFromDescriptionChange, StateCommonMetadata } from "./lib/stateMetadata";
import {
  ACTIVE_PROGRAM_FEATURE,
  DANGEROUS_COMMAND_MARKERS,
  FINISH_IN_FEATURE,
  POWER_STATE_OFF,
  POWER_STATE_ON,
  POWER_STATE_UID,
  POWER_STATE_UID_NUMBER,
  SELECTED_PROGRAM_FEATURE,
  START_IN_FEATURE,
} from "./lib/constants";
import { normalizeUid, sanitizeObjectId } from "./lib/ids";
import { loadProfiles } from "./lib/profile";
import { DiscoveredHomeConnectDevice, DiscoveryProfileMatch, matchDiscoveredDeviceToProfile, startHomeConnectDiscovery, stopHomeConnectDiscovery } from "./lib/mdnsDiscovery";
import { DiscoveryDeviceAdded, DiscoveryDeviceEnabled, DiscoveryHostUpdate, addOrEnableConfiguredDevicesFromDiscovery, updateConfiguredDeviceHostsFromDiscovery } from "./lib/discoveryConfigUpdate";
import { connectionFailureLogLevel, connectionFailureLogMessage } from "./lib/reconnectPolicy";
import { calculateIdleSeconds, DEFAULT_WATCHDOG_HEARTBEAT_IDLE_MS, recordHomeConnectFrame, RunningDevice, shouldHeartbeatDevice, WATCHDOG_HEARTBEAT_REQUEST, WritableState } from "./lib/runtimeTypes";
import { StateMapper } from "./lib/stateMapper";
import { activeEventSummaryItems, activeEventSummaryTextDe } from "./lib/eventSummary";
import { clearProgramPhaseDisplayTargets, coerceStateValueForObjectType, finalProgramEndCompanionTargets, finalProgramEndDisplayTargets, isActiveProgramFinishedEventValue, isFinishedOperationState, isIdleOperationState, isNoActiveProgramValue, isOffEffectivePowerState, nonEmptyClearProgramPhaseDisplayTargets, OPERATION_STATE_FEATURE, PROGRAM_FINISHED_EVENT_FEATURE } from "./lib/programTelemetryFinalizer";
import { durationToSeconds, isTruthyWrite, parseJsonObject, stateValueToPowerBoolean, stateValueToRaw, toStateValue } from "./lib/valueConverter";
import { mergeStartOptionValues, shouldSendAutomaticStartOption } from "./lib/startOptions";
import { evaluateStartAvailability, StartAvailability } from "./lib/startAvailability";
import { evaluateEffectivePowerState, POWER_STATE_FEATURE } from "./lib/effectivePowerState";
import { evaluateHobZoneSummary, isHobZoneFeature } from "./lib/hobActiveZones";
import { hasWritableProgramOption, isProgramOptionDescriptionWritable, isReadOnlyProgramOption, isWritableAccess, normalizedAccess } from "./lib/optionWriteability";
import { AdapterNativeConfig, ApplianceProfile, ConfiguredDevice, HcMessage, RoValue, StateTarget } from "./lib/types";
import { DEFAULT_POWER_RESET_FAILURES, DEFAULT_POWER_RESET_IDLE_MINUTES, DEFAULT_POWER_RESET_THRESHOLD_WATTS, DEFAULT_WIFI_RECONNECT_WAIT_MINUTES, POWER_RESET_OFF_MS, WIFI_RECONNECT_PULSE_MS, powerResetBlockReason, stagedRecoveryAction, wifiReconnectPulseValue } from "./lib/powerReset";

interface DiscoveryScanResult {
  found: DiscoveredHomeConnectDevice[];
  matched: DiscoveryProfileMatch[];
  unmatched: DiscoveredHomeConnectDevice[];
}

function homeConnectResponseCodeFromError(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/^Home Connect response code (\d+) /);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : undefined;
}

class HomeconnectLocalAdapter extends utils.Adapter {
  private devices = new Map<string, RunningDevice>();
  private writableStates = new Map<string, WritableState>();
  private unloaded = false;
  private discoveryProfiles: ApplianceProfile[] = [];
  private discoveredDevices = new Map<string, DiscoveredHomeConnectDevice>();
  private currentConfig: AdapterNativeConfig = {} as AdapterNativeConfig;
  private connectionWatchdogTimer?: NodeJS.Timeout;

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "homeconnect-local" });
    this.on("ready", () => void this.onReady().catch(error => {
      if (!this.unloaded) this.log.error(`Startup failed: ${String(error)}`);
    }));
    this.on("unload", callback => void this.onUnload(callback));
    this.on("stateChange", (id, state) => void this.onStateChange(id, state).catch(error => {
      if (!this.unloaded) this.log.warn(`State change handling failed: ${String(error)}`);
    }));
  }

  private async onReady(): Promise<void> {
    this.currentConfig = this.config as AdapterNativeConfig;
    await this.ensureInfoConnectionObject();
    if (this.unloaded) return;
    await this.ensureDiscoveryObjects();
    if (this.unloaded) return;
    await this.setState("info.connection", false, true);
    if (this.unloaded) return;
    await this.setState("discovery.enabled", this.currentConfig.enableMdnsDiscovery === true, true);
    await this.subscribeStatesAsync("*.settings.*");
    await this.subscribeStatesAsync("*.options.*");
    await this.subscribeStatesAsync("*.commands.*");
    await this.subscribeStatesAsync("*.program.*");
    await this.subscribeStatesAsync("discovery.scanNow");

    const profilePath = this.currentConfig.profilePath?.trim();
    if (!profilePath) {
      this.log.warn("No profilePath configured. Add a profile ZIP or extracted profile directory in the adapter settings.");
      if (this.currentConfig.enableMdnsDiscovery === true && !this.unloaded) {
        await this.runMdnsDiscoveryScan([]);
      }
      return;
    }

    let profiles: ApplianceProfile[];
    try {
      profiles = loadProfiles(profilePath);
    } catch (error) {
      this.log.error(`Unable to load Home Connect profiles: ${String(error)}`);
      if (this.currentConfig.enableMdnsDiscovery === true && !this.unloaded) {
        await this.runMdnsDiscoveryScan([]);
      }
      return;
    }

    this.discoveryProfiles = profiles;
    this.log.info(`Loaded ${profiles.length} Home Connect profile(s) from ${profilePath}`);
    await this.syncConfiguredDevicesWithProfiles(profiles);
    if (this.unloaded) return;
    const profilesByHaId = new Map(profiles.map(profile => [profile.haId, profile]));

    for (const profile of profiles) {
      this.log.info(`${profile.haId}: profile found (${this.profileDisplayName(profile)}, ${profile.connectionType})`);
    }

    if (this.currentConfig.enableMdnsDiscovery === true) {
      const discoveryResult = await this.runMdnsDiscoveryScan(profiles);
      if (this.unloaded) return;

      let configPersisted = false;
      if (this.currentConfig.autoAddDiscoveredDevices === true) {
        const autoAddResult = await this.addOrEnableConfiguredDevicesFromDiscovery(discoveryResult.matched);
        if (this.unloaded) return;
        configPersisted ||= autoAddResult.persisted;
      }
      if (this.currentConfig.autoUpdateDiscoveredHosts === true) {
        const hostUpdateResult = await this.updateConfiguredHostsFromDiscovery(discoveryResult.matched);
        if (this.unloaded) return;
        configPersisted ||= hostUpdateResult.persisted;
      }
      if (configPersisted) {
        this.log.info("Adapter configuration was updated from mDNS discovery; waiting for ioBroker restart before connecting appliances.");
        return;
      }
    }

    if (this.unloaded) return;
    this.startConnectionWatchdog();

    for (const configuredDevice of this.currentConfig.devices ?? []) {
      if (!configuredDevice.enabled) {
        this.log.info(`${configuredDevice.haId || configuredDevice.name || "configured device"}: configured device is disabled, skipping connection`);
        continue;
      }
      if (!configuredDevice.haId || !configuredDevice.host) {
        this.log.warn(`Skipping incomplete device config: ${JSON.stringify(configuredDevice)}`);
        continue;
      }

      const profile = profilesByHaId.get(configuredDevice.haId);
      if (!profile) {
        this.log.warn(`No profile found for haId ${configuredDevice.haId}`);
        continue;
      }

      const device: RunningDevice = {
        baseId: sanitizeObjectId(profile.haId),
        config: configuredDevice,
        profile,
        mapper: new StateMapper(profile),
        connecting: false,
        reconnecting: false,
        reconnectFailures: 0,
        powerResetCommunicationFailures: 0,
        watchdogReconnectCount: 0,
        connected: false,
        writableUids: new Set<string>(),
        readOnlyUids: new Set<string>(),
        blockedCommands: [],
        stateValuesByFeature: new Map<string, ioBroker.StateValue>(),
        rawValuesByFeature: new Map<string, unknown>(),
        eventValuesByFeature: new Map<string, ioBroker.StateValue>(),
        programExecutionByFeature: new Map<string, string>(),
        lastSelectedProgramRaw: undefined,
        lastOptionContextProgramRaw: undefined,
      };

      if (this.unloaded) return;
      this.devices.set(profile.haId, device);
      await this.prepareDeviceObjects(device);
      await this.preparePowerReset(device);
      if (this.unloaded) return;
      await this.connectDevice(device);
      if (this.unloaded) return;
    }
  }

  private async ensureDiscoveryObjects(): Promise<void> {
    await this.ensureChannel("discovery", "mDNS Discovery");
    await this.ensureStateObject("discovery.enabled", "mDNS discovery enabled", false, "indicator");
    await this.ensureStateObject("discovery.lastScan", "Last mDNS discovery scan", "", "date");
    await this.ensureStateObject("discovery.count", "Discovered appliance count", 0, "value");
    await this.ensureStateObject("discovery.foundJson", "Discovered appliances JSON", "[]", "json");
    await this.ensureStateObject("discovery.matchedJson", "Matched discovered appliances JSON", "[]", "json");
    await this.ensureStateObject("discovery.unmatchedJson", "Unmatched discovered appliances JSON", "[]", "json");
    await this.ensureStateObject("discovery.matchedCount", "Matched discovered appliance count", 0, "value");
    await this.ensureStateObject("discovery.unmatchedCount", "Unmatched discovered appliance count", 0, "value");
    await this.ensureStateObject("discovery.updatedHostsCount", "Updated configured host count from discovery", 0, "value");
    await this.ensureStateObject("discovery.updatedHostsJson", "Updated configured hosts JSON", "[]", "json");
    await this.ensureStateObject("discovery.addedDevicesCount", "Added discovered appliance count", 0, "value");
    await this.ensureStateObject("discovery.addedDevicesJson", "Added discovered appliances JSON", "[]", "json");
    await this.ensureStateObject("discovery.enabledDevicesCount", "Enabled discovered appliance count", 0, "value");
    await this.ensureStateObject("discovery.enabledDevicesJson", "Enabled discovered appliances JSON", "[]", "json");
    await this.ensureCommandStateObject("discovery.scanNow", "Scan for Home Connect appliances now");
  }

  private async runMdnsDiscoveryScan(profiles = this.discoveryProfiles): Promise<DiscoveryScanResult> {
    if (this.unloaded) return { found: [], matched: [], unmatched: [] };
    this.discoveredDevices.clear();
    let result = await this.writeDiscoveryStates(profiles);
    if (this.unloaded) return result;
    startHomeConnectDiscovery(this, { timeoutSeconds: this.currentConfig.mdnsDiscoveryTimeout ?? 10 }, device => {
      if (this.unloaded) return;
      const key = device.id || device.mac || device.address || device.host || device.name || JSON.stringify(device.rawTxt ?? {});
      this.discoveredDevices.set(key, device);
      void this.writeDiscoveryStates(profiles).catch(error => {
        if (!this.unloaded) this.log.warn(`Writing mDNS discovery states failed: ${String(error)}`);
      });
    });
    const timeoutMs = Math.max(1, Number(this.currentConfig.mdnsDiscoveryTimeout ?? 10)) * 1000;
    await new Promise(resolve => setTimeout(resolve, timeoutMs + 100));
    if (this.unloaded) return result;
    result = await this.writeDiscoveryStates(profiles);
    if (this.unloaded) return result;
    this.log.info(`mDNS discovery finished: ${result.found.length} found, ${result.matched.length} matched, ${result.unmatched.length} unmatched`);
    return result;
  }

  private async writeDiscoveryStates(profiles: ApplianceProfile[]): Promise<DiscoveryScanResult> {
    const found = Array.from(this.discoveredDevices.values());
    const matched: DiscoveryProfileMatch[] = [];
    const unmatched: DiscoveredHomeConnectDevice[] = [];
    for (const discovery of found) {
      const match = matchDiscoveredDeviceToProfile(discovery, profiles);
      if (match) {
        matched.push(match);
        this.log.debug(`matched discovered appliance ${this.discoveryDisplayName(discovery)} to profile ${match.profile.haId} by ${match.match}`);
      } else {
        unmatched.push(discovery);
        this.log.debug(`unmatched discovered appliance ${this.discoveryDisplayName(discovery)}`);
      }
    }
    if (this.unloaded) return { found, matched, unmatched };
    await this.setState("discovery.enabled", this.currentConfig.enableMdnsDiscovery === true, true);
    await this.setState("discovery.lastScan", new Date().toISOString(), true);
    await this.setState("discovery.count", found.length, true);
    await this.setState("discovery.foundJson", JSON.stringify(found), true);
    await this.setState("discovery.matchedJson", JSON.stringify(matched), true);
    await this.setState("discovery.unmatchedJson", JSON.stringify(unmatched), true);
    await this.setState("discovery.matchedCount", matched.length, true);
    await this.setState("discovery.unmatchedCount", unmatched.length, true);
    return { found, matched, unmatched };
  }

  private async updateConfiguredHostsFromDiscovery(matches: DiscoveryProfileMatch[], updateRunningDevices = false): Promise<{ updates: DiscoveryHostUpdate[]; persisted: boolean }> {
    if (this.unloaded) return { updates: [], persisted: false };
    const result = updateConfiguredDeviceHostsFromDiscovery(this.currentConfig.devices ?? [], matches);
    for (const skipped of result.skippedWithoutConfiguredDevice) {
      this.log.info(
        `${skipped.profile.haId}: discovered matched appliance ${this.discoveryDisplayName(skipped.discovery)} has no configured device entry; auto-add is not implemented yet`,
      );
    }

    await this.writeUpdatedHostStates(result.updates);
    if (this.unloaded) return { updates: result.updates, persisted: false };
    if (result.updates.length === 0) return { updates: [], persisted: false };

    this.currentConfig = { ...this.currentConfig, devices: result.devices };
    await this.persistNativeConfig();
    if (this.unloaded) return { updates: result.updates, persisted: true };
    this.log.info(`Updated ${result.updates.length} configured Home Connect host(s) from mDNS discovery. Refresh admin page to see changes.`);

    if (updateRunningDevices) {
      await this.applyDiscoveredHostsToRunningDevices(result.updates);
    }
    return { updates: result.updates, persisted: true };
  }

  private async addOrEnableConfiguredDevicesFromDiscovery(matches: DiscoveryProfileMatch[], connectNewDevices = false): Promise<{ added: DiscoveryDeviceAdded[]; enabled: DiscoveryDeviceEnabled[]; persisted: boolean }> {
    if (this.unloaded) return { added: [], enabled: [], persisted: false };
    const result = addOrEnableConfiguredDevicesFromDiscovery(this.currentConfig.devices ?? [], matches);
    await this.writeAutoAddedDeviceStates(result.added, result.enabled);
    if (this.unloaded) return { added: result.added, enabled: result.enabled, persisted: false };
    if (!result.changed) return { added: [], enabled: [], persisted: false };

    this.currentConfig = { ...this.currentConfig, devices: result.devices };
    await this.persistNativeConfig();
    if (this.unloaded) return { added: result.added, enabled: result.enabled, persisted: result.changed };
    this.log.info(`Added/enabled ${result.added.length + result.enabled.length} Home Connect device(s) from mDNS discovery. Refresh admin page to see changes.`);

    if (connectNewDevices && !this.unloaded) await this.prepareAndConnectConfiguredDevices([...result.added, ...result.enabled].map(device => device.haId));
    return { added: result.added, enabled: result.enabled, persisted: result.changed };
  }

  private async writeAutoAddedDeviceStates(added: DiscoveryDeviceAdded[], enabled: DiscoveryDeviceEnabled[]): Promise<void> {
    await this.setState("discovery.addedDevicesCount", added.length, true);
    await this.setState("discovery.addedDevicesJson", JSON.stringify(added), true);
    await this.setState("discovery.enabledDevicesCount", enabled.length, true);
    await this.setState("discovery.enabledDevicesJson", JSON.stringify(enabled), true);
  }

  private async writeUpdatedHostStates(updates: DiscoveryHostUpdate[]): Promise<void> {
    await this.setState("discovery.updatedHostsCount", updates.length, true);
    await this.setState("discovery.updatedHostsJson", JSON.stringify(updates), true);
  }

  private async applyDiscoveredHostsToRunningDevices(updates: DiscoveryHostUpdate[]): Promise<void> {
    for (const update of updates) {
      const device = this.devices.get(update.haId);
      if (!device) continue;
      device.config.host = update.newHost;
      const connected = (await this.getStateAsync(`${device.baseId}.general.connected`))?.val === true;
      if (connected) {
        this.log.info(`${update.haId}: host updated in config; active connection remains until reconnect/restart`);
        continue;
      }
      this.log.info(`${update.haId}: host updated in config while disconnected; reconnect will use ${update.newHost}`);
      if (!device.reconnecting) void this.connectDevice(device);
    }
  }

  private discoveryDisplayName(discovery: DiscoveredHomeConnectDevice): string {
    return discovery.id || discovery.name || discovery.address || discovery.host || discovery.mac || JSON.stringify(discovery.rawTxt ?? {});
  }

  private async syncConfiguredDevicesWithProfiles(profiles: ApplianceProfile[]): Promise<void> {
    if (this.currentConfig.autoAddProfiles === false) return;

    const devicesByHaId = new Map((this.currentConfig.devices ?? []).filter(device => device.haId).map(device => [device.haId as string, { ...device }]));
    let changed = false;

    for (const profile of profiles) {
      const existing = devicesByHaId.get(profile.haId);
      const metadata = this.profileToDeviceConfig(profile);
      if (!existing) {
        devicesByHaId.set(profile.haId, metadata);
        changed = true;
        this.log.info(`${profile.haId}: added profile to adapter config as disabled device suggestion`);
        continue;
      }

      const enriched: ConfiguredDevice = {
        ...existing,
        name: existing.name || metadata.name,
        type: metadata.type,
        brand: metadata.brand,
        vib: metadata.vib,
        mac: metadata.mac,
        connectionType: metadata.connectionType,
        profileFile: metadata.profileFile,
      };
      if (JSON.stringify(enriched) !== JSON.stringify(existing)) {
        devicesByHaId.set(profile.haId, enriched);
        changed = true;
      }
    }

    if (!changed) return;
    this.currentConfig = {
      ...this.currentConfig,
      devices: Array.from(devicesByHaId.values()).sort((a, b) => String(a.name ?? a.haId).localeCompare(String(b.name ?? b.haId))),
    };
    await this.persistNativeConfig();
    this.log.info("Updated adapter device table from scanned Home Connect profiles. Refresh the admin page to see new devices.");
  }

  private profileToDeviceConfig(profile: ApplianceProfile): ConfiguredDevice {
    return {
      enabled: false,
      haId: profile.haId,
      host: "",
      name: this.profileDisplayName(profile),
      type: profile.type,
      brand: profile.brand,
      vib: profile.vib,
      mac: profile.mac,
      connectionType: String(profile.connectionType),
      profileFile: profile.profileFile,
    };
  }

  private profileDisplayName(profile: ApplianceProfile): string {
    const parts = [profile.brand, profile.vib, profile.type].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : profile.haId;
  }

  private deviceDisplayName(profile: ApplianceProfile, config: ConfiguredDevice): string {
    return config.name || this.profileDisplayName(profile);
  }


  private async prepareAndConnectConfiguredDevices(haIds: string[]): Promise<void> {
    const requestedHaIds = new Set(haIds);
    if (requestedHaIds.size === 0) return;
    const profilesByHaId = new Map(this.discoveryProfiles.map(profile => [profile.haId, profile]));

    for (const configuredDevice of this.currentConfig.devices ?? []) {
      if (!configuredDevice.haId || !requestedHaIds.has(configuredDevice.haId) || !configuredDevice.enabled) continue;
      if (this.devices.has(configuredDevice.haId)) continue;
      if (!configuredDevice.host) {
        this.log.warn(`Skipping incomplete device config: ${JSON.stringify(configuredDevice)}`);
        continue;
      }

      const profile = profilesByHaId.get(configuredDevice.haId);
      if (!profile) {
        this.log.warn(`No profile found for haId ${configuredDevice.haId}`);
        continue;
      }

      const device: RunningDevice = {
        baseId: sanitizeObjectId(profile.haId),
        config: configuredDevice,
        profile,
        mapper: new StateMapper(profile),
        connecting: false,
        reconnecting: false,
        reconnectFailures: 0,
        powerResetCommunicationFailures: 0,
        watchdogReconnectCount: 0,
        connected: false,
        writableUids: new Set<string>(),
        readOnlyUids: new Set<string>(),
        blockedCommands: [],
        stateValuesByFeature: new Map<string, ioBroker.StateValue>(),
        rawValuesByFeature: new Map<string, unknown>(),
        eventValuesByFeature: new Map<string, ioBroker.StateValue>(),
        programExecutionByFeature: new Map<string, string>(),
        lastSelectedProgramRaw: undefined,
        lastOptionContextProgramRaw: undefined,
      };

      if (this.unloaded) return;
      this.devices.set(profile.haId, device);
      await this.prepareDeviceObjects(device);
      await this.preparePowerReset(device);
      if (this.unloaded) return;
      await this.connectDevice(device);
      if (this.unloaded) return;
    }
  }

  private async persistNativeConfig(): Promise<void> {
    if (this.unloaded) return;
    const instanceObjectId = `system.adapter.${this.namespace}`;
    const instanceObject = await this.getForeignObjectAsync(instanceObjectId);
    if (!instanceObject || instanceObject.type !== "instance") {
      this.log.warn(`Cannot persist device table, instance object ${instanceObjectId} not found`);
      return;
    }
    const instanceNative = (instanceObject.native ?? {}) as Record<string, unknown>;
    if (this.unloaded) return;
    await this.setForeignObjectAsync(instanceObjectId, {
      ...instanceObject,
      type: "instance",
      native: { ...instanceNative, ...(this.currentConfig as Record<string, unknown>) },
    } as ioBroker.InstanceObject);
  }

  private async ensureInfoConnectionObject(): Promise<void> {
    await this.ensureStateObject("info.connection", "If connected to at least one appliance", false, "indicator.connected");
  }

  private async prepareDeviceObjects(device: RunningDevice): Promise<void> {
    if (this.unloaded) return;
    const { baseId, profile, config } = device;
    const deviceName = this.deviceDisplayName(profile, config);

    await this.setObjectNotExistsAsync(baseId, {
      type: "device",
      common: { name: deviceName, statusStates: { onlineId: `${this.namespace}.${baseId}.general.connected` } },
      native: { haId: profile.haId, type: profile.type, brand: profile.brand, vib: profile.vib, mac: profile.mac, connectionType: profile.connectionType, profileFile: profile.profileFile, host: config.host },
    });
    await this.extendObjectAsync(baseId, {
      common: { name: deviceName, statusStates: { onlineId: `${this.namespace}.${baseId}.general.connected` } },
      native: { haId: profile.haId, type: profile.type, brand: profile.brand, vib: profile.vib, mac: profile.mac, connectionType: profile.connectionType, profileFile: profile.profileFile, host: config.host },
    });

    if (this.unloaded) return;
    await this.cleanupLegacyDeviceFolders(device);
    if (this.unloaded) return;

    await this.ensureChannel(`${baseId}.general`, "General Information");
    await this.ensureStateObject(`${baseId}.general.connected`, "Connected", false, "indicator.connected");
    for (const id of ["name", "deviceID", "deviceType", "type", "brand", "vib", "eNumber", "mac", "serialNumber", "customerIndex", "fdString", "haVersion", "swVersion", "hwVersion", "deviceInfo"]) {
      await this.ensureStateObject(`${baseId}.general.${id}`, id, "", "text");
    }
    await this.ensureStateObject(`${baseId}.general.rawInfo`, "Raw appliance info", "", "json");
    await this.setState(`${baseId}.general.connected`, false, true);
    await this.setState(`${baseId}.general.name`, deviceName, true);
    await this.setState(`${baseId}.general.deviceID`, profile.haId, true);
    await this.setState(`${baseId}.general.deviceType`, String(profile.type ?? ""), true);
    await this.setState(`${baseId}.general.type`, String(profile.type ?? ""), true);
    await this.setState(`${baseId}.general.brand`, String(profile.brand ?? ""), true);
    await this.setState(`${baseId}.general.vib`, String(profile.vib ?? ""), true);
    await this.setState(`${baseId}.general.mac`, String(profile.mac ?? ""), true);
    await this.setState(`${baseId}.general.serialNumber`, String(profile.serialNumber ?? ""), true);

    await this.ensureChannel(`${baseId}.info`, "Information");
    await this.ensureStateObject(`${baseId}.info.connected`, "Connected", false, "indicator.connected");
    await this.ensureStateObject(`${baseId}.info.reconnecting`, "Reconnect in progress", false, "indicator");
    await this.ensureStateObject(`${baseId}.info.lastSeen`, "Last successful contact", "", "date");
    await this.ensureStateObject(`${baseId}.info.lastError`, "Last connection error", "", "text");
    await this.ensureStateObject(`${baseId}.info.lastMessage`, "Last raw Home Connect message", "", "json");
    await this.ensureStateObject(`${baseId}.info.connectionType`, "Connection type", "", "text");
    await this.setState(`${baseId}.info.connectionType`, String(profile.connectionType), true);

    for (const channel of ["status", "program", "phases", "options", "settings", "events", "availablePrograms", "commands", "network", "registeredDevices", "expertCommands"]) {
      await this.ensureChannel(`${baseId}.${channel}`, channel);
    }
    await ensureDiagnosticStates(this, device);
    await this.ensureEffectivePowerStateObjects(device);
    await this.ensureHobActiveZoneObjects(device);
    await this.ensureStartAvailabilityStates(device);
    await this.ensureProgramStates(device);
    await this.ensureEventSummaryStates(device);
    await this.prepareRootProgramAliasObjects(device);

    await this.ensureStateObject(`${baseId}.settings.PowerState`, "BSH.Common.Setting.PowerState", false, "switch", true);
    this.registerWritableState(device, `${baseId}.settings.PowerState`, POWER_STATE_UID_NUMBER, "BSH.Common.Setting.PowerState", "value");

    await this.prepareCommandObjects(device);
    if (this.unloaded) return;
    await this.prepareStartProgramObjects(device);
    if (this.unloaded) return;
    await this.updateProgramList(device);
  }

  private async preparePowerReset(device: RunningDevice): Promise<void> {
    if (device.config.enableWifiReconnect === true || device.config.enablePowerReset === true) {
      await this.ensureChannel(`${device.baseId}.recovery`, "Staged recovery");
      const wifiOutputInitialValue = device.config.wifiReconnectUseMac === true ? "" : false;
      await this.ensureStateObject(`${device.baseId}.recovery.wifiReconnectRequested`, "Request external Wi-Fi reconnect", wifiOutputInitialValue, device.config.wifiReconnectUseMac === true ? "text" : "indicator");
      await this.ensureStateObject(`${device.baseId}.info.wifiReconnectTriggeredAt`, "Last staged Wi-Fi reconnect trigger", 0, "value");
      await this.ensureStateObject(`${device.baseId}.info.powerResetLocked`, "Power reset locked until valid RO communication", false, "indicator");
      const wifiTriggeredAt = await this.getStateAsync(`${device.baseId}.info.wifiReconnectTriggeredAt`);
      const powerResetLocked = await this.getStateAsync(`${device.baseId}.info.powerResetLocked`);
      if (typeof wifiTriggeredAt?.val === "number" && wifiTriggeredAt.val > 0) device.wifiReconnectTriggeredAt = wifiTriggeredAt.val;
      device.powerResetPerformed = powerResetLocked?.val === true;
      await this.setState(`${device.baseId}.recovery.wifiReconnectRequested`, wifiOutputInitialValue, true);
    }
    if (device.config.enableWifiReconnect === true) {
      this.log.info(`${device.profile.haId}: Wi-Fi reconnect recovery armed (output ${device.baseId}.recovery.wifiReconnectRequested)`);
    }
    if (device.config.enablePowerReset !== true) return;
    await this.ensureStateObject(`${device.baseId}.recovery.powerMeasurementWatts`, "Power measurement supplied externally", 0, "value.power.consumption", true, { unit: "W" });
    await this.ensureStateObject(`${device.baseId}.recovery.powerSwitchFeedback`, "Power switch feedback supplied externally", false, "indicator", true);
    const switchStateIdObject = `${device.baseId}.recovery.powerSwitchStateId`;
    await this.ensureStateObject(switchStateIdObject, "Power switch output state ID supplied externally", "", "text", true);
    const configuredSwitchId = device.config.powerSwitchStateId?.trim() ?? "";
    if (!(await this.getStateAsync(switchStateIdObject))) {
      await this.setState(switchStateIdObject, configuredSwitchId, true);
    }
    const measurementId = this.powerMeasurementStateId(device);
    const switchId = await this.powerSwitchStateId(device);
    const switchFeedbackId = this.powerSwitchFeedbackStateId(device);
    if (device.config.enableWifiReconnect !== true) {
      this.log.warn(`${device.profile.haId}: power reset requires the first-stage Wi-Fi reconnect to be enabled; automatic power cuts are disabled`);
      return;
    }
    if (!measurementId || !switchId || !switchFeedbackId) {
      this.log.warn(`${device.profile.haId}: power switch output state ID is missing; automatic power cuts are disabled`);
      return;
    }
    await this.subscribeForeignStatesAsync(measurementId);
    const state = await this.getForeignStateAsync(measurementId);
    if (state) this.recordPowerMeasurement(device, state);
    this.log.info(`${device.profile.haId}: conservative power reset armed (wattage ${measurementId}, output ${switchId}, feedback ${switchFeedbackId})`);
  }

  private recordPowerMeasurement(device: RunningDevice, state: ioBroker.State): void {
    const watts = typeof state.val === "number" ? state.val : Number.NaN;
    const threshold = this.powerResetThresholdWatts(device);
    if (Number.isFinite(watts) && watts >= 0 && watts < threshold) {
      device.powerResetLowPowerSince ??= Date.now();
    } else {
      device.powerResetLowPowerSince = undefined;
    }
    if (device.powerResetCommunicationFailures >= this.powerResetRequiredFailures(device)) this.schedulePowerResetEvaluation(device);
  }

  private recordCommunicationFailure(device: RunningDevice, error: unknown): void {
    if (device.config.enableWifiReconnect !== true && device.config.enablePowerReset !== true) return;
    device.powerResetCommunicationFailures += 1;
    this.log.warn(`${device.profile.haId}: communication failure ${device.powerResetCommunicationFailures}/${this.powerResetRequiredFailures(device)} recorded for staged recovery: ${String(error)}`);
    this.schedulePowerResetEvaluation(device);
  }

  private schedulePowerResetEvaluation(device: RunningDevice): void {
    if (this.unloaded || device.powerResetTimer || device.powerResetInProgress) return;
    const lowSince = device.powerResetLowPowerSince;
    const delay = device.wifiReconnectTriggeredAt === undefined || lowSince === undefined
      ? 0
      : Math.max(0, lowSince + this.powerResetIdleMs(device) - Date.now());
    device.powerResetTimer = setTimeout(() => {
      device.powerResetTimer = undefined;
      void this.tryStagedRecovery(device).catch(error => {
        if (!this.unloaded) this.log.error(`${device.profile.haId}: staged recovery failed safely: ${String(error)}`);
      });
    }, delay);
    device.powerResetTimer.unref?.();
  }

  private async tryStagedRecovery(device: RunningDevice): Promise<void> {
    if (this.unloaded) return;
    const remainingWaitMs = device.wifiReconnectTriggeredAt === undefined
      ? this.wifiReconnectWaitMs(device)
      : device.wifiReconnectTriggeredAt + this.wifiReconnectWaitMs(device) - Date.now();
    const action = stagedRecoveryAction(
      device.powerResetCommunicationFailures,
      this.powerResetRequiredFailures(device),
      device.wifiReconnectTriggeredAt !== undefined,
      remainingWaitMs <= 0,
      device.powerResetPerformed === true,
    );
    if (action === "none" || action === "lockedUntilRecovery") return;
    if (action === "wifiReconnect") {
      if (device.config.enableWifiReconnect !== true) return;
      const wifiStateId = `${device.baseId}.recovery.wifiReconnectRequested`;
      const wifiRequestValue = wifiReconnectPulseValue(device.config.wifiReconnectUseMac === true, device.config.mac, device.profile.mac);
      if (device.config.wifiReconnectUseMac === true && wifiRequestValue === "") {
        this.log.warn(`${device.profile.haId}: Wi-Fi reconnect MAC output is enabled but the profile/configuration has no MAC address`);
        return;
      }
      device.wifiReconnectTriggeredAt = Date.now();
      try {
        await this.setState(wifiStateId, wifiRequestValue, true);
      } catch (error) {
        device.wifiReconnectTriggeredAt = undefined;
        throw error;
      }
      await this.setState(`${device.baseId}.info.wifiReconnectTriggeredAt`, device.wifiReconnectTriggeredAt, true).catch(error => {
        if (!this.unloaded) this.log.error(`${device.profile.haId}: persisting Wi-Fi recovery latch failed: ${String(error)}`);
      });
      this.log.warn(`${device.profile.haId}: first recovery stage triggered ${wifiStateId}=${JSON.stringify(wifiRequestValue)}; waiting for communication to recover`);
      void (async () => {
        await new Promise(resolve => setTimeout(resolve, WIFI_RECONNECT_PULSE_MS));
        await this.setState(wifiStateId, device.config.wifiReconnectUseMac === true ? "" : false, true).catch(error => {
          if (!this.unloaded) this.log.debug(`${device.profile.haId}: resetting Wi-Fi reconnect trigger to False failed: ${String(error)}`);
        });
      })();
      this.schedulePowerResetEvaluation(device);
      return;
    }
    if (action === "waitForWifi") {
      device.powerResetTimer = setTimeout(() => {
        device.powerResetTimer = undefined;
        void this.tryStagedRecovery(device).catch(error => {
          if (!this.unloaded) this.log.error(`${device.profile.haId}: staged recovery failed safely: ${String(error)}`);
        });
      }, remainingWaitMs);
      device.powerResetTimer.unref?.();
      return;
    }
    await this.tryPowerReset(device);
  }

  private recordCommunicationRecovery(device: RunningDevice): void {
    if (device.powerResetCommunicationFailures === 0 && device.wifiReconnectTriggeredAt === undefined && device.powerResetPerformed !== true) return;
    if (device.powerResetTimer) {
      clearTimeout(device.powerResetTimer);
      device.powerResetTimer = undefined;
    }
    device.powerResetCommunicationFailures = 0;
    device.wifiReconnectTriggeredAt = undefined;
    device.powerResetPerformed = false;
    void this.setState(`${device.baseId}.info.wifiReconnectTriggeredAt`, 0, true).catch(error => {
      if (!this.unloaded) this.log.debug(`${device.profile.haId}: clearing persisted Wi-Fi recovery latch failed: ${String(error)}`);
    });
    void this.setState(`${device.baseId}.info.powerResetLocked`, false, true).catch(error => {
      if (!this.unloaded) this.log.debug(`${device.profile.haId}: clearing persisted power-reset lock failed: ${String(error)}`);
    });
    this.log.info(`${device.profile.haId}: valid RO communication recovered; staged Wi-Fi/power reset is re-armed`);
  }

  private async tryPowerReset(device: RunningDevice): Promise<void> {
    const measurementId = this.powerMeasurementStateId(device);
    const switchId = await this.powerSwitchStateId(device);
    const switchFeedbackId = this.powerSwitchFeedbackStateId(device);
    if (!measurementId || !switchId || !switchFeedbackId || this.unloaded || device.powerResetPerformed === true) return;
    const measurement = await this.getForeignStateAsync(measurementId);
    const switchFeedback = await this.getForeignStateAsync(switchFeedbackId);
    const reason = powerResetBlockReason({
      enabled: device.config.enablePowerReset === true,
      failures: device.powerResetCommunicationFailures,
      requiredFailures: this.powerResetRequiredFailures(device),
      watts: measurement?.val,
      measurementTimestamp: measurement?.ts,
      lowPowerSince: device.powerResetLowPowerSince,
      now: Date.now(),
      thresholdWatts: this.powerResetThresholdWatts(device),
      idleMs: this.powerResetIdleMs(device),
      resetInProgress: device.powerResetInProgress === true,
      powerSwitchFeedback: switchFeedback?.val,
    });
    if (reason) {
      this.log.debug(`${device.profile.haId}: power reset blocked: ${reason}`);
      return;
    }
    device.powerResetInProgress = true;
    if (device.reconnectTimer) {
      clearTimeout(device.reconnectTimer);
      device.reconnectTimer = undefined;
    }
    device.reconnecting = true;
    const client = device.client;
    device.client = undefined;
    await client?.close().catch(error => this.log.debug(`${device.profile.haId}: closing client before power reset failed: ${String(error)}`));
    this.log.warn(`${device.profile.haId}: all safety conditions passed; switching ${switchId} False for ${POWER_RESET_OFF_MS / 1000}s`);
    let switchedOff = false;
    try {
      await this.setForeignStateAsync(switchId, false, false);
      switchedOff = true;
      device.powerResetPerformed = true;
      await this.setState(`${device.baseId}.info.powerResetLocked`, true, true).catch(error => {
        if (!this.unloaded) this.log.error(`${device.profile.haId}: persisting power-reset lock failed: ${String(error)}`);
      });
      await new Promise(resolve => setTimeout(resolve, POWER_RESET_OFF_MS));
    } finally {
      try {
        if (switchedOff) await this.setForeignStateAsync(switchId, true, false);
      } finally {
        device.powerResetInProgress = false;
        device.powerResetLowPowerSince = undefined;
        device.reconnecting = false;
      }
    }
    if (!this.unloaded) this.scheduleReconnect(device, new Error("Reconnect after controlled power reset"));
  }

  private powerResetThresholdWatts(device: RunningDevice): number {
    const value = Number(device.config.powerResetThresholdWatts ?? DEFAULT_POWER_RESET_THRESHOLD_WATTS);
    return Number.isFinite(value) ? Math.max(0.1, value) : DEFAULT_POWER_RESET_THRESHOLD_WATTS;
  }

  private powerMeasurementStateId(device: RunningDevice): string {
    return device.config.powerMeasurementStateId?.trim() || `${this.namespace}.${device.baseId}.recovery.powerMeasurementWatts`;
  }

  private powerSwitchFeedbackStateId(device: RunningDevice): string {
    return device.config.powerSwitchFeedbackStateId?.trim() || `${this.namespace}.${device.baseId}.recovery.powerSwitchFeedback`;
  }

  private async powerSwitchStateId(device: RunningDevice): Promise<string> {
    const state = await this.getStateAsync(`${device.baseId}.recovery.powerSwitchStateId`);
    return typeof state?.val === "string" ? state.val.trim() : (device.config.powerSwitchStateId?.trim() ?? "");
  }

  private powerResetIdleMs(device: RunningDevice): number {
    const value = Number(device.config.powerResetIdleMinutes ?? DEFAULT_POWER_RESET_IDLE_MINUTES);
    return (Number.isFinite(value) ? Math.max(5, value) : DEFAULT_POWER_RESET_IDLE_MINUTES) * 60_000;
  }

  private powerResetRequiredFailures(device: RunningDevice): number {
    const value = Number(device.config.powerResetFailureCount ?? DEFAULT_POWER_RESET_FAILURES);
    return Number.isFinite(value) ? Math.max(3, Math.floor(value)) : DEFAULT_POWER_RESET_FAILURES;
  }

  private wifiReconnectWaitMs(device: RunningDevice): number {
    const value = Number(device.config.wifiReconnectWaitMinutes ?? DEFAULT_WIFI_RECONNECT_WAIT_MINUTES);
    return (Number.isFinite(value) ? Math.max(1, value) : DEFAULT_WIFI_RECONNECT_WAIT_MINUTES) * 60_000;
  }


  private async cleanupLegacyDeviceFolders(device: RunningDevice): Promise<void> {
    const folders = ["programs", "services", "metadata"];
    if (this.currentConfig.enableRawStates !== true) folders.push("raw");
    for (const folder of folders) {
      await this.deleteDeviceFolder(device, folder);
    }
  }

  private async deleteDeviceFolder(device: RunningDevice, folder: string): Promise<void> {
    const safeFolder = sanitizeObjectId(folder);
    if (safeFolder !== folder || folder.includes(".") || folder.includes("/")) {
      this.log.warn(`${device.profile.haId}: refusing to delete unsafe folder ${JSON.stringify(folder)}`);
      return;
    }
    const id = `${device.baseId}.${folder}`;
    if (!id.startsWith(`${device.baseId}.`)) {
      this.log.warn(`${device.profile.haId}: refusing to delete ${id} outside ${device.baseId}`);
      return;
    }
    try {
      const existing = await this.getObjectAsync(id);
      if (!existing) return;
      await this.delObjectAsync(id, { recursive: true });
      this.log.info(`${device.profile.haId}: deleted obsolete object folder ${id}`);
    } catch (error) {
      this.log.warn(`${device.profile.haId}: deleting obsolete object folder ${id} failed: ${String(error)}`);
    }
  }

  private async ensureEffectivePowerStateObjects(device: RunningDevice): Promise<void> {
    await this.ensureStateObject(`${device.baseId}.status.effectivePowerState`, "Effective power state", "Offline", "text");
    await this.ensureStateObject(`${device.baseId}.status.effectivePowerState_de`, "Effective power state (German)", "Aus / offline", "text");
    await this.ensureStateObject(`${device.baseId}.status.isEffectivelyOn`, "Device is effectively on", false, "indicator");
    await this.updateEffectivePowerState(device);
  }

  private async updateEffectivePowerState(device: RunningDevice): Promise<void> {
    const state = evaluateEffectivePowerState(device);
    await this.setState(`${device.baseId}.status.effectivePowerState`, state.effectivePowerState, true);
    await this.setState(`${device.baseId}.status.effectivePowerState_de`, state.effectivePowerStateDe, true);
    await this.setState(`${device.baseId}.status.isEffectivelyOn`, state.isEffectivelyOn, true);
    if (isOffEffectivePowerState(state.effectivePowerState)) await this.clearProgramPhaseDisplay(device);
  }

  private async ensureHobActiveZoneObjects(device: RunningDevice): Promise<void> {
    if (device.profile.type !== "Hob") return;
    await this.ensureStateObject(`${device.baseId}.status.hobAnyZoneActive`, "Any hob zone active", false, "indicator");
    await this.ensureStateObject(`${device.baseId}.status.hobActiveZonesJson`, "Active hob zones JSON", "[]", "json");
    await this.ensureStateObject(`${device.baseId}.status.hobActiveZonesText`, "Active hob zones text", "", "text");
    await this.ensureStateObject(`${device.baseId}.status.hobAnyResidualHeat`, "Any hob zone has residual heat", false, "indicator");
    await this.ensureStateObject(`${device.baseId}.status.hobResidualHeatZonesJson`, "Residual heat hob zones JSON", "[]", "json");
    await this.ensureStateObject(`${device.baseId}.status.hobResidualHeatZonesText`, "Residual heat hob zones text", "", "text");
    await this.updateHobActiveZoneStates(device);
  }

  private async updateHobActiveZoneStates(device: RunningDevice): Promise<void> {
    if (device.profile.type !== "Hob") return;
    const summary = evaluateHobZoneSummary(device);
    await this.setState(`${device.baseId}.status.hobAnyZoneActive`, summary.activeZones.length > 0, true);
    await this.setState(`${device.baseId}.status.hobActiveZonesJson`, JSON.stringify(summary.activeZones), true);
    await this.setState(`${device.baseId}.status.hobActiveZonesText`, summary.activeZonesText, true);
    await this.setState(`${device.baseId}.status.hobAnyResidualHeat`, summary.residualHeatZones.length > 0, true);
    await this.setState(`${device.baseId}.status.hobResidualHeatZonesJson`, JSON.stringify(summary.residualHeatZones), true);
    await this.setState(`${device.baseId}.status.hobResidualHeatZonesText`, summary.residualHeatZonesText, true);
  }

  private async ensureStartAvailabilityStates(device: RunningDevice): Promise<void> {
    await this.ensureStateObject(`${device.baseId}.status.canStart`, "Can start selected program", false, "indicator");
    await this.ensureStateObject(`${device.baseId}.status.startBlockedReason`, "Start blocked reason", "unknown", "text");
    await this.ensureStateObject(`${device.baseId}.status.startBlockedReason_de`, "Start blocked reason (German)", "unbekannt", "text");
    await this.updateStartAvailability(device);
  }

  private async updateStartAvailability(device: RunningDevice): Promise<StartAvailability> {
    const availability = evaluateStartAvailability(device, device.connected);
    await this.setState(`${device.baseId}.status.canStart`, availability.canStart, true);
    await this.setState(`${device.baseId}.status.startBlockedReason`, availability.reason, true);
    await this.setState(`${device.baseId}.status.startBlockedReason_de`, availability.reasonDe, true);
    return availability;
  }

  private async warnIfStartUnavailable(device: RunningDevice): Promise<void> {
    const availability = await this.updateStartAvailability(device);
    if (!availability.canStart) {
      this.log.warn(`${device.profile.haId}: cannot start, startBlockedReason=${availability.reason} (${availability.reasonDe})`);
    }
  }

  private async ensureProgramStates(device: RunningDevice): Promise<void> {
    await this.ensureStateObject(`${device.baseId}.program.startOptionsJson`, "Start options JSON", "{}", "json", true);
    await this.ensureProgramDropdownStateObjects(device);
    await this.ensureStateObject(`${device.baseId}.program.selectedProgramName`, "Selected program name", "", "text");
    await this.ensureStateObject(`${device.baseId}.program.activeProgramName`, "Active program name", "", "text");
    await this.ensureStateObject(`${device.baseId}.availablePrograms.availableList`, "Available programs list", "", "text");
    await this.ensureStateObject(`${device.baseId}.availablePrograms.availableJson`, "Available programs JSON", "", "json");
  }

  private async ensureProgramDropdownStateObjects(device: RunningDevice): Promise<void> {
    await this.ensureStateObject(`${device.baseId}.program.startProgramName`, "Start program by name", "", "text", true, this.programStatesMetadata(device));
  }

  private programStatesMetadata(device: RunningDevice): StateCommonMetadata | undefined {
    const states = programStatesForDevice(device);
    return Object.keys(states).length > 0 ? { states } : undefined;
  }

  private async prepareRootProgramAliasObjects(device: RunningDevice): Promise<void> {
    const programStates = this.programStatesMetadata(device);
    const selectedUid = this.uidForFeature(device.profile, SELECTED_PROGRAM_FEATURE);
    if (selectedUid !== undefined) {
      await this.ensureStateObject(`${device.baseId}.program.RootSelectedProgram`, SELECTED_PROGRAM_FEATURE, "", "value", true, programStates);
      this.registerWritableState(device, `${device.baseId}.program.RootSelectedProgram`, selectedUid, SELECTED_PROGRAM_FEATURE, "value");
    }

    const activeUid = this.uidForFeature(device.profile, ACTIVE_PROGRAM_FEATURE);
    if (activeUid !== undefined) {
      await this.ensureStateObject(`${device.baseId}.program.RootActiveProgram`, ACTIVE_PROGRAM_FEATURE, "", "value", true, programStates);
      this.registerWritableState(device, `${device.baseId}.program.RootActiveProgram`, activeUid, ACTIVE_PROGRAM_FEATURE, "value");
    }
  }


  private async ensureEventSummaryStates(device: RunningDevice): Promise<void> {
    await this.ensureStateObject(`${device.baseId}.status.eventSummary_de`, "Active event summary (German)", "", "text");
    await this.ensureStateObject(`${device.baseId}.status.activeEventsJson`, "Active events JSON", "[]", "json");
    await this.updateEventSummary(device);
  }

  private async updateEventSummary(device: RunningDevice): Promise<void> {
    const items = activeEventSummaryItems(device.eventValuesByFeature);
    await this.setState(`${device.baseId}.status.eventSummary_de`, activeEventSummaryTextDe(items), true);
    await this.setState(`${device.baseId}.status.activeEventsJson`, JSON.stringify(items), true);
  }

  private async prepareCommandObjects(device: RunningDevice): Promise<void> {
    device.blockedCommands = [];
    for (const [uid, featureName] of Object.entries(device.profile.featureMapping.featuresByUid)) {
      if (!featureName.includes(".Command.")) continue;
      if (this.isDangerousCommand(featureName)) {
        device.blockedCommands.push(featureName);
        continue;
      }
      const numericUid = this.uidStringToNumber(uid);
      if (numericUid === undefined) continue;
      const stateId = `${device.baseId}.commands.${sanitizeObjectId(featureName.split(".Command.")[1] ?? featureName)}`;
      await this.ensureCommandStateObject(stateId, featureName);
      this.registerWritableState(device, stateId, numericUid, featureName, "command");
    }
    await this.setState(`${device.baseId}.expertCommands.blockedList`, JSON.stringify(device.blockedCommands), true);
  }

  private isDangerousCommand(featureName: string): boolean {
    return DANGEROUS_COMMAND_MARKERS.some(marker => featureName.includes(marker));
  }

  private async prepareStartProgramObjects(device: RunningDevice): Promise<void> {
    const activeProgramUid = this.uidForFeature(device.profile, ACTIVE_PROGRAM_FEATURE);
    if (activeProgramUid === undefined) return;
    this.registerWritableState(device, `${device.baseId}.program.startProgramName`, activeProgramUid, ACTIVE_PROGRAM_FEATURE, "startProgramName");
    await this.ensureCommandStateObject(`${device.baseId}.commands.StartProgram`, "Start selected program");
    this.registerWritableState(device, `${device.baseId}.commands.StartProgram`, activeProgramUid, ACTIVE_PROGRAM_FEATURE, "startProgram");
    await this.ensureCommandStateObject(`${device.baseId}.commands.StartProgramWithOptions`, "Start selected program with program.startOptionsJson");
    this.registerWritableState(device, `${device.baseId}.commands.StartProgramWithOptions`, activeProgramUid, ACTIVE_PROGRAM_FEATURE, "startProgramWithOptions");
  }

  private async connectDevice(device: RunningDevice): Promise<void> {
    if (this.unloaded || device.connecting || device.reconnecting) return;
    if (device.profile.connectionType !== "AES" && device.profile.connectionType !== "TLS") {
      this.log.warn(`${device.profile.haId}: unsupported connectionType ${device.profile.connectionType}. Expected AES or TLS.`);
      return;
    }
    if (device.profile.connectionType === "AES" && !device.profile.iv) {
      this.log.warn(`${device.profile.haId}: AES profile has no IV. Skipping device.`);
      return;
    }

    device.connecting = true;
    if (device.reconnectTimer) {
      clearTimeout(device.reconnectTimer);
      device.reconnectTimer = undefined;
    }

    const previousClient = device.client;
    if (previousClient) {
      device.client = undefined;
      await previousClient.close().catch(closeError => this.log.debug(`${device.profile.haId}: closing previous client before reconnect failed: ${String(closeError)}`));
    }

    this.log.debug(`${device.profile.haId}: connecting to ${device.config.host} via ${device.profile.connectionType}`);
    const client = new HomeConnectClient({
      host: device.config.host as string,
      connectionType: device.profile.connectionType,
      key: device.profile.key,
      iv: device.profile.iv,
      appName: this.currentConfig.appName || "ioBroker HomeConnect Local",
      appId: this.currentConfig.appId || "iobroker-homeconnect-local",
      log: this.log,
      deviceLabel: device.profile.haId,
      messageHandler: message => this.handleDeviceMessage(device, message),
      frameHandler: message => recordHomeConnectFrame(device, message.resource),
      closeHandler: error => this.handleDeviceClientClose(device, client, error),
      communicationFailureHandler: error => this.recordCommunicationFailure(device, error),
    });
    device.client = client;

    try {
      await client.connect();
      if (this.unloaded) {
        if (device.client === client) device.client = undefined;
        await client.close().catch(closeError => this.log.debug(`Close after unload failed: ${String(closeError)}`));
        return;
      }
      recordHomeConnectFrame(device);
      await this.setDeviceConnectionState(device, true);
      this.log.info(`${device.profile.haId}: connected`);
      if (this.unloaded) return;
      await client.readInitialValues();
    } catch (error) {
      if (device.client === client) device.client = undefined;
      await client.close().catch(closeError => this.log.debug(`Close after failed connect failed: ${String(closeError)}`));
      if (this.unloaded) return;
      await this.setDeviceConnectionState(device, false, error);
      this.logConnectionFailure(device, error);
      this.scheduleReconnect(device, error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (device.client === client || !device.client) device.connecting = false;
    }
  }

  private handleDeviceClientClose(device: RunningDevice, client: HomeConnectClient, error?: Error): void {
    if (device.client !== client) return;
    device.client = undefined;
    void (async () => {
      try {
        await this.setDeviceConnectionState(device, false, error);
      } catch (setStateError) {
        if (!this.unloaded) this.log.debug(`${device.profile.haId}: updating closed connection state failed: ${String(setStateError)}`);
      }
      this.scheduleReconnect(device, error);
    })();
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (this.unloaded || !state) return;
    for (const device of this.devices.values()) {
      if (device.config.enablePowerReset === true && id === this.powerMeasurementStateId(device)) {
        this.recordPowerMeasurement(device, state);
        return;
      }
    }
    if (state.ack) return;
    const relativeId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    if (relativeId === "discovery.scanNow") {
      if (this.currentConfig.enableMdnsDiscovery === true) {
        const discoveryResult = await this.runMdnsDiscoveryScan();
        if (this.unloaded) return;
        if (this.currentConfig.autoAddDiscoveredDevices === true) {
          await this.addOrEnableConfiguredDevicesFromDiscovery(discoveryResult.matched, true);
          if (this.unloaded) return;
        }
        if (this.currentConfig.autoUpdateDiscoveredHosts === true) {
          await this.updateConfiguredHostsFromDiscovery(discoveryResult.matched, true);
          if (this.unloaded) return;
        }
      } else {
        this.log.warn("mDNS discovery scan requested but enableMdnsDiscovery is false");
      }
      await this.setState("discovery.scanNow", false, true);
      return;
    }
    const writableState = this.writableStates.get(relativeId);
    if (!writableState) return;
    const resetCommandState = writableState.kind === "command" || writableState.kind === "startProgram" || writableState.kind === "startProgramWithOptions";
    const device = this.devices.get(writableState.deviceHaId);
    if (!device?.client) {
      this.log.warn(`${relativeId}: cannot write ${writableState.featureName}, device is not connected`);
      if (resetCommandState) await this.resetCommandState(writableState);
      return;
    }

    try {
      const rawValue = await this.valueForWrite(device, writableState, state.val);
      if (rawValue === undefined) {
        if (resetCommandState) await this.resetCommandState(writableState);
        return;
      }

      if (writableState.kind === "startProgramWithOptions") {
        await this.warnIfStartUnavailable(device);
        await this.writeStartProgram(device, rawValue, await this.startOptionValuesFromState(device, rawValue));
      } else if (writableState.kind === "startProgram") {
        await this.warnIfStartUnavailable(device);
        this.warnIfSelectedProgramNotSelectAndStart(device, rawValue);
        await this.writeStartProgram(device, rawValue, this.buildAutomaticStartOptionValues(device, rawValue));
      } else if (writableState.kind === "startProgramName" || writableState.featureName === ACTIVE_PROGRAM_FEATURE) {
        await this.warnIfStartUnavailable(device);
        this.warnIfDirectProgramNotSelectAndStart(device, rawValue);
        await this.selectProgramBeforeDirectStartIfNeeded(device, rawValue);
        await this.writeStartProgram(device, rawValue, await this.startOptionValuesFromState(device, rawValue));
      } else if (writableState.featureName === SELECTED_PROGRAM_FEATURE) {
        await this.writeSelectedProgram(device, rawValue, []);
      } else {
        const programKey = this.programKeyFromRaw(writableState, rawValue);
        const programSuffix = programKey ? ` (${programKey})` : "";
        this.log.info(`${device.profile.haId}: writing ${writableState.featureName} = ${JSON.stringify(rawValue)}${programSuffix}`);
        await device.client.writeValue(writableState.uid, rawValue);
      }

      if (resetCommandState) {
        await this.resetCommandState(writableState);
      } else {
        await this.setState(writableState.stateId, this.normalizeWrittenAckValue(writableState, rawValue), true);
      }
    } catch (error) {
      this.log.warn(`${device.profile.haId}: writing ${writableState.featureName} failed: ${String(error)}`);
      if (resetCommandState) await this.resetCommandState(writableState);
    }
  }

  private async resetCommandState(writableState: WritableState): Promise<void> {
    try {
      await this.setState(writableState.stateId, false, true);
    } catch (error) {
      this.log.warn(`${writableState.stateId}: resetting command state failed: ${String(error)}`);
    }
  }

  private async valueForWrite(device: RunningDevice, writableState: WritableState, value: ioBroker.StateValue): Promise<unknown> {
    if (writableState.kind === "command") return isTruthyWrite(value) ? true : undefined;
    if (writableState.kind === "startProgramName") return this.rawProgramForName(device, value);
    if (writableState.kind === "startProgram" || writableState.kind === "startProgramWithOptions") {
      if (!isTruthyWrite(value)) return undefined;
      const selectedProgramUid = this.uidForFeature(device.profile, SELECTED_PROGRAM_FEATURE);
      if (selectedProgramUid === undefined) {
        this.log.warn(`${device.profile.haId}: cannot start program, SelectedProgram UID missing`);
        return undefined;
      }
      let selectedProgramState = await this.getStateAsync(`${device.baseId}.program.SelectedProgram`);
      if (selectedProgramState?.val === undefined || selectedProgramState.val === null || selectedProgramState.val === "") {
        selectedProgramState = await this.getStateAsync(`${device.baseId}.program.RootSelectedProgram`);
      }
      if (selectedProgramState?.val === undefined || selectedProgramState.val === null || selectedProgramState.val === "") {
        this.log.warn(`${device.profile.haId}: cannot start program, no selected program is known`);
        return undefined;
      }
      return this.rawProgramForName(device, selectedProgramState.val);
    }
    if (writableState.featureName === SELECTED_PROGRAM_FEATURE || writableState.featureName === ACTIVE_PROGRAM_FEATURE) {
      const key = this.programKeyForWrite(device, value, writableState.featureName);
      if (key === undefined) return undefined;
      const rawUid = this.rawProgramUidForKey(device, key);
      if (rawUid === undefined) {
        this.log.warn(`${device.profile.haId}: cannot resolve program ${JSON.stringify(value)} to raw UID, not writing`);
      }
      return rawUid;
    }
    if (writableState.uid === POWER_STATE_UID_NUMBER) return stateValueToPowerBoolean(value) ? POWER_STATE_ON : POWER_STATE_OFF;
    return stateValueToRaw(device.profile, writableState.uid, value);
  }

  private async startOptionValuesFromState(device: RunningDevice, programRaw: unknown): Promise<Array<{ uid: number; value: unknown }>> {
    const optionsState = await this.getStateAsync(`${device.baseId}.program.startOptionsJson`);
    const explicitOptions = this.buildStartOptionValues(device, parseJsonObject(optionsState?.val));
    return mergeStartOptionValues(explicitOptions, this.buildAutomaticStartOptionValues(device, programRaw));
  }

  private async selectProgramBeforeDirectStartIfNeeded(device: RunningDevice, programRaw: unknown): Promise<void> {
    const programUid = Number(programRaw);
    if (!Number.isFinite(programUid)) return;
    if (Number(device.lastSelectedProgramRaw) === programUid && device.lastOptionContextProgramRaw === programUid) return;

    if (Number(device.lastSelectedProgramRaw) !== programUid) {
      this.log.info(`${device.profile.haId}: selecting program before start = ${programUid}`);
      await this.writeSelectedProgram(device, programUid, []);
    }

    this.log.info(`${device.profile.haId}: waiting for selected program option refresh`);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (Number(device.lastSelectedProgramRaw) === programUid && device.lastOptionContextProgramRaw === programUid) return;
      await this.sleep(100);
    }
    this.log.warn(`${device.profile.haId}: selected program option refresh timed out for ${programUid}; automatic start options will be omitted unless explicit options are configured`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async writeStartProgram(device: RunningDevice, selectedProgramRaw: unknown, options: Array<{ uid: number; value: unknown }>): Promise<void> {
    if (!device.client) throw new Error("Device is not connected");
    const programUid = Number(selectedProgramRaw);
    if (!Number.isFinite(programUid)) throw new Error(`Invalid program UID ${JSON.stringify(selectedProgramRaw)}`);
    const programKey = this.programKeyFromRawUid(device, programUid);
    const programSuffix = programKey ? ` (${programKey})` : "";
    this.log.info(`${device.profile.haId}: starting program via /ro/activeProgram = ${programUid}${programSuffix}`);
    await device.client.startProgram(programUid, options);
  }

  private async writeSelectedProgram(device: RunningDevice, selectedProgramRaw: unknown, options: Array<{ uid: number; value: unknown }>): Promise<void> {
    if (!device.client) throw new Error("Device is not connected");
    const programUid = Number(selectedProgramRaw);
    if (!Number.isFinite(programUid)) throw new Error(`Invalid program UID ${JSON.stringify(selectedProgramRaw)}`);
    const programKey = this.programKeyFromRawUid(device, programUid);
    const programSuffix = programKey ? ` (${programKey})` : "";
    this.log.info(`${device.profile.haId}: selecting program via /ro/selectedProgram = ${programUid}${programSuffix}`);
    await device.client.selectProgram(programUid, options);
  }

  private buildStartOptionValues(device: RunningDevice, options: Record<string, unknown>): Array<{ uid: number; value: unknown }> {
    const result: Array<{ uid: number; value: unknown }> = [];
    const add = (featureName: string, value: unknown): void => {
      const uid = this.uidForFeature(device.profile, featureName);
      if (uid !== undefined && value !== undefined) result.push({ uid, value: stateValueToRaw(device.profile, uid, toStateValue(value)) });
    };
    add(START_IN_FEATURE, durationToSeconds(options.start_in));
    add(FINISH_IN_FEATURE, durationToSeconds(options.finish_in));

    const optionMap = options.options;
    if (optionMap && typeof optionMap === "object" && !Array.isArray(optionMap)) {
      for (const [key, value] of Object.entries(optionMap as Record<string, unknown>)) {
        const uid = this.uidForFeature(device.profile, key) ?? this.uidStringToNumber(key);
        if (uid !== undefined) result.push({ uid, value: stateValueToRaw(device.profile, uid, toStateValue(value)) });
      }
    }
    return result;
  }


  private buildAutomaticStartOptionValues(device: RunningDevice, programRaw: unknown): Array<{ uid: number; value: unknown }> {
    const programUid = Number(programRaw);
    const programKey = Number.isFinite(programUid) ? this.programKeyFromRawUid(device, programUid) : undefined;
    const programUidKey = Number.isFinite(programUid) ? normalizeUid(programUid) : undefined;
    const programOptions = programUidKey ? device.profile.featureMapping.programOptionsByUid[programUidKey] : undefined;
    const result: Array<{ uid: number; value: unknown }> = [];
    const skippedDefaults: Array<{ uid: number; value: unknown }> = [];

    if (Number.isFinite(programUid) && device.lastOptionContextProgramRaw !== programUid) {
      this.log.debug(`${device.profile.haId}: start options for ${programUid}${programKey ? ` (${programKey})` : ""}: none; automatic options source: unsafe context (selected=${JSON.stringify(device.lastSelectedProgramRaw)}, optionContext=${JSON.stringify(device.lastOptionContextProgramRaw)})`);
      return result;
    }

    if (programOptions) {
      for (const programOption of programOptions) {
        const uid = programOption.refUID;
        const featureName = device.profile.featureMapping.featuresByUid[normalizeUid(uid) ?? uid];
        if (!featureName || !featureName.includes(".Option.")) continue;
        if (isReadOnlyProgramOption(featureName)) continue;
        const programOptionWritable = isProgramOptionDescriptionWritable(programOption);
        const normalizedUid = normalizeUid(uid) ?? uid;
        if (!device.writableUids.has(normalizedUid) && !programOptionWritable) continue;
        if (!device.rawValuesByFeature.has(featureName) && !device.stateValuesByFeature.has(featureName)) continue;

        const numericUid = this.uidStringToNumber(uid);
        if (numericUid === undefined) continue;
        const stateValue = device.stateValuesByFeature.get(featureName);
        const rawValue = device.rawValuesByFeature.has(featureName)
          ? device.rawValuesByFeature.get(featureName)
          : stateValue === undefined
            ? undefined
            : stateValueToRaw(device.profile, numericUid, stateValue);
        if (!shouldSendAutomaticStartOption(featureName, rawValue, programOption.default)) {
          if (rawValue !== undefined && rawValue !== null && rawValue !== "") skippedDefaults.push({ uid: numericUid, value: rawValue });
          continue;
        }
        result.push({ uid: numericUid, value: rawValue });
      }
    }

    const optionList = result.map(option => `${option.uid}=${JSON.stringify(option.value)}`).join(", ") || "none";
    const skippedList = skippedDefaults.map(option => `${option.uid}=${JSON.stringify(option.value)}`).join(", ") || "none";
    const source = programOptions ? "program-specific" : "unknown (empty)";
    this.log.debug(`${device.profile.haId}: start options for ${programUid}${programKey ? ` (${programKey})` : ""}: automatic sent: ${optionList}; automatic skipped defaults: ${skippedList}; automatic options source: ${source}`);
    return result;
  }


  private warnIfSelectedProgramNotSelectAndStart(device: RunningDevice, programRaw: unknown): void {
    this.warnIfProgramNotSelectAndStart(device, programRaw, "starting selected program");
  }

  private warnIfDirectProgramNotSelectAndStart(device: RunningDevice, programRaw: unknown): void {
    this.warnIfProgramNotSelectAndStart(device, programRaw, "directly starting program");
  }

  private warnIfProgramNotSelectAndStart(device: RunningDevice, programRaw: unknown, action: string): void {
    const programUid = Number(programRaw);
    const programKey = Number.isFinite(programUid) ? this.programKeyFromRawUid(device, programUid) : undefined;
    if (!programKey) return;
    const execution = device.programExecutionByFeature.get(programKey);
    if (execution && execution !== "SELECTANDSTART") {
      this.log.warn(`${device.profile.haId}: ${action} ${programKey} although execution is ${execution}, expected SELECTANDSTART`);
    }
  }

  private normalizeWrittenAckValue(writableState: WritableState, rawValue: unknown): ioBroker.StateValue {
    if (writableState.uid === POWER_STATE_UID_NUMBER) return Number(rawValue) === POWER_STATE_ON;
    if (writableState.featureName === SELECTED_PROGRAM_FEATURE || writableState.featureName === ACTIVE_PROGRAM_FEATURE) {
      return this.programKeyFromRaw(writableState, rawValue) ?? toStateValue(rawValue);
    }
    return toStateValue(rawValue);
  }

  private programKeyFromRaw(writableState: WritableState, rawValue: unknown): string | undefined {
    const device = this.devices.get(writableState.deviceHaId);
    if (!device) return undefined;
    if (typeof rawValue === "string" && rawValue.includes(".Program.")) return rawValue;
    if (typeof rawValue !== "number") return undefined;
    return this.programKeyFromRawUid(device, rawValue);
  }

  private programKeyFromRawUid(device: RunningDevice, rawUid: number): string | undefined {
    const uid = normalizeUid(rawUid);
    return uid ? device.profile.featureMapping.featuresByUid[uid] : undefined;
  }

  private scheduleReconnect(device: RunningDevice, error?: Error): void {
    if (this.unloaded || device.reconnecting) return;
    if (device.reconnectTimer) return;
    const existingClient = device.client;
    if (existingClient) {
      device.client = undefined;
      void existingClient.close().catch(closeError => {
        if (!this.unloaded) this.log.debug(`${device.profile.haId}: closing client before scheduled reconnect failed: ${String(closeError)}`);
      });
    }
    if (error) void this.setState(`${device.baseId}.info.lastError`, error.message, true).catch(setStateError => {
      if (!this.unloaded) this.log.debug(`${device.profile.haId}: writing reconnect error state failed: ${String(setStateError)}`);
    });
    device.reconnecting = true;
    void this.setState(`${device.baseId}.info.reconnecting`, true, true).catch(setStateError => {
      if (!this.unloaded) this.log.debug(`${device.profile.haId}: writing reconnect state failed: ${String(setStateError)}`);
    });
    void this.updateGlobalConnectionState().catch(setStateError => {
      if (!this.unloaded) this.log.debug(`Updating global connection state failed: ${String(setStateError)}`);
    });
    const seconds = Math.max(5, Number(this.currentConfig.reconnectInterval ?? 30));
    device.reconnectTimer = setTimeout(() => {
      device.reconnectTimer = undefined;
      if (this.unloaded) return;
      device.reconnecting = false;
      void this.setState(`${device.baseId}.info.reconnecting`, false, true).catch(setStateError => {
        if (!this.unloaded) this.log.debug(`${device.profile.haId}: clearing reconnect state failed: ${String(setStateError)}`);
      });
      void this.connectDevice(device).catch(connectError => {
        if (!this.unloaded) this.log.warn(`${device.profile.haId}: reconnect failed: ${String(connectError)}`);
      });
    }, seconds * 1000);
  }

  private startConnectionWatchdog(): void {
    if (this.connectionWatchdogTimer) return;
    this.connectionWatchdogTimer = setInterval(() => {
      void this.runConnectionWatchdog().catch(error => {
        if (!this.unloaded) this.log.debug(`Connection watchdog failed: ${String(error)}`);
      });
    }, 60 * 1000);
  }

  private async runConnectionWatchdog(now = Date.now()): Promise<void> {
    if (this.unloaded) return;
    for (const device of this.devices.values()) {
      if (!this.shouldHeartbeatDevice(device, now)) continue;
      await this.checkDeviceHeartbeat(device, now);
    }
  }


  private shouldHeartbeatDevice(device: RunningDevice, now = Date.now()): boolean {
    return shouldHeartbeatDevice(device, now, this.watchdogHeartbeatIdleMs());
  }

  private watchdogHeartbeatIdleMs(): number {
    const configuredMinutes = Number(this.currentConfig.watchdogHeartbeatIdleMinutes ?? DEFAULT_WATCHDOG_HEARTBEAT_IDLE_MS / 60_000);
    const effectiveMinutes = Number.isFinite(configuredMinutes) ? Math.max(1, configuredMinutes) : DEFAULT_WATCHDOG_HEARTBEAT_IDLE_MS / 60_000;
    return effectiveMinutes * 60_000;
  }

  private async checkDeviceHeartbeat(device: RunningDevice, now = Date.now()): Promise<void> {
    if (this.unloaded || !this.shouldHeartbeatDevice(device, now)) return;
    const client = device.client;
    if (!client) return;
    const idleSeconds = calculateIdleSeconds(device.lastRxAt, now);
    device.watchdogHeartbeatInFlight = true;
    try {
      await client.sendSync(WATCHDOG_HEARTBEAT_REQUEST, 15000);
      recordHomeConnectFrame(device, WATCHDOG_HEARTBEAT_REQUEST.resource);
    } catch (error) {
      if (this.unloaded) return;
      const responseCode = homeConnectResponseCodeFromError(error);
      if (responseCode !== undefined && responseCode >= 400) {
        this.log.debug(`${device.profile.haId}: heartbeat returned HomeConnect code ${responseCode} for ${WATCHDOG_HEARTBEAT_REQUEST.resource}, reconnecting`);
      }
      device.watchdogReconnectCount += 1;
      this.recordCommunicationFailure(device, error);
      this.log.warn(`${device.profile.haId}: no HomeConnect traffic for ${idleSeconds}s and heartbeat failed, reconnecting`);
      device.connected = false;
      await client.close().catch(closeError => this.log.debug(`${device.profile.haId}: watchdog close failed: ${String(closeError)}`));
      await this.setDeviceConnectionState(device, false, error).catch(stateError => {
        this.log.debug(`${device.profile.haId}: updating disconnected state after heartbeat failure failed: ${String(stateError)}`);
      });
      this.scheduleReconnect(device, error instanceof Error ? error : new Error(String(error)));
    } finally {
      device.watchdogHeartbeatInFlight = false;
    }
  }

  private logConnectionFailure(device: RunningDevice, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    device.reconnectFailures += 1;
    const level = connectionFailureLogLevel(message, device.reconnectFailures);
    this.log[level](connectionFailureLogMessage(device.profile.haId, message, device.reconnectFailures));
    this.recordCommunicationFailure(device, error);
  }

  private async setDeviceConnectionState(device: RunningDevice, connected: boolean, error?: unknown): Promise<void> {
    device.connected = connected;
    await this.setState(`${device.baseId}.info.connected`, connected, true);
    await this.setState(`${device.baseId}.general.connected`, connected, true);
    await this.setState(`${device.baseId}.info.reconnecting`, false, true);
    if (connected) {
      device.reconnecting = false;
      device.reconnectFailures = 0;
      await this.setState(`${device.baseId}.info.lastSeen`, new Date().toISOString(), true);
      await this.setState(`${device.baseId}.info.lastError`, "", true);
    } else if (error !== undefined) {
      await this.setState(`${device.baseId}.info.lastError`, error instanceof Error ? error.message : String(error), true);
    }
    await this.updateGlobalConnectionState();
    await this.updateEffectivePowerState(device);
    await this.updateStartAvailability(device);
  }

  private async handleDeviceMessage(device: RunningDevice, message: HcMessage): Promise<void> {
    recordHomeConnectFrame(device, message.resource);
    if (message.resource?.startsWith("/ro/")) this.recordCommunicationRecovery(device);
    await this.setState(`${device.baseId}.info.lastSeen`, new Date().toISOString(), true);
    await this.setState(`${device.baseId}.info.lastMessage`, JSON.stringify(message), true);
    if (message.resource === "/ci/info" || message.resource === "/iz/info") await writeApplianceInfo(this, device, message.data);
    if (message.resource === "/ni/info") await writeNetworkInfo(this, device, message.data);
    if (message.resource === "/ci/registeredDevices") await writeRegisteredDevices(this, device, message.data);
    if (message.resource === "/ro/allDescriptionChanges" || message.resource === "/ro/descriptionChange") await this.applyDescriptionChanges(device, message.data);
    if (message.resource?.startsWith("/ro/")) {
      if (this.currentConfig.debugRaw) this.log.debug(`${device.profile.haId}: ${message.resource} ${JSON.stringify(message.data)}`);
      for (const value of device.mapper.valuesFromMessageData(message.data)) if ("value" in value) await this.writeRoValue(device, value);
    }
  }

  private async applyDescriptionChanges(device: RunningDevice, data: unknown): Promise<void> {
    for (const value of device.mapper.valuesFromMessageData(data)) {
      const uid = normalizeUid(value.uid);
      if (!uid) continue;
      const access = normalizedAccess(value.access);
      const targetFeature = device.profile.featureMapping.featuresByUid[uid];
      const execution = typeof value.execution === "string" ? value.execution : undefined;
      if (execution && targetFeature?.includes(".Program.")) device.programExecutionByFeature.set(targetFeature, execution);
      if (isWritableAccess(access)) {
        device.writableUids.add(uid);
        device.readOnlyUids.delete(uid);
      } else if (access) {
        device.writableUids.delete(uid);
        if (access === "read" || access === "none") {
          device.readOnlyUids.add(uid);
        } else {
          device.readOnlyUids.delete(uid);
        }
      }
      const target = device.mapper.toStateTarget({ uid, value: "" });
      if (!target) continue;
      const stateId = `${device.baseId}.${target.id}`;
      if (target.category === "commands") {
        await this.prepareWritableCommandState(device, stateId, target);
        continue;
      }
      const writable = this.canWriteTarget(device, target);
      await this.ensureStateObject(stateId, target.name, this.initialTargetValue(target), target.uid === POWER_STATE_UID ? "switch" : undefined, writable, this.commonMetadata(device, target, value));
      if (writable) this.registerWritableState(device, stateId, this.uidStringToNumber(uid) ?? Number(uid), target.name, "value");
      if (target.name === SELECTED_PROGRAM_FEATURE || target.name === ACTIVE_PROGRAM_FEATURE) await this.prepareRootProgramAliasObjects(device);
    }
    await this.updateStartAvailability(device);
  }

  private async writeRoValue(device: RunningDevice, value: RoValue): Promise<void> {
    const target = device.mapper.toStateTarget(value);
    if (!target) return;
    const stateId = `${device.baseId}.${target.id}`;
    if (target.category === "commands") {
      await this.prepareWritableCommandState(device, stateId, target);
      await this.setState(stateId, false, true);
      return;
    }
    const normalizedValue = this.normalizeTargetValue(device, target);
    const isWritable = this.canWriteTarget(device, target);
    await this.ensureStateObject(stateId, target.name, normalizedValue, target.uid === POWER_STATE_UID ? "switch" : undefined, isWritable, this.commonMetadata(device, target, value));
    await this.setState(stateId, normalizedValue, true);
    await this.writeEnumCompanionStates(device, target);
    device.stateValuesByFeature.set(target.name, normalizedValue);
    device.rawValuesByFeature.set(target.name, target.rawValue);
    if (target.category === "events") device.eventValuesByFeature.set(target.name, normalizedValue);
    this.updateProgramOptionContextMarker(device, target);
    await this.writeRootProgramAliasValues(device, target, normalizedValue);
    await this.updateStartAvailability(device);
    if (target.name === POWER_STATE_FEATURE) await this.updateEffectivePowerState(device);
    if (isHobZoneFeature(target.name)) await this.updateHobActiveZoneStates(device);
    if (isWritable) {
      const numericUid = this.uidStringToNumber(target.uid);
      if (numericUid !== undefined) this.registerWritableState(device, stateId, numericUid, target.name, "value");
    }
    if (this.currentConfig.enableRawStates === true) {
      await this.ensureChannel(`${device.baseId}.raw`, "raw");
      await this.ensureStateObject(`${device.baseId}.raw.uid_${target.uid}`, `Raw ${target.uid} ${target.name}`, "", "json");
      await this.setState(`${device.baseId}.raw.uid_${target.uid}`, JSON.stringify(value), true);
    }
    if (target.category === "events") await this.updateEventSummary(device);
    await this.finalizeProgramEndDisplayIfFinished(device, target, normalizedValue);
    await this.clearProgramPhaseDisplayIfIdle(device, target, normalizedValue);
    if (target.name.includes(".Program.") || target.name.includes(".Setting.Favorite.")) await this.updateProgramList(device);
  }


  private async finalizeProgramEndDisplayIfFinished(device: RunningDevice, target: StateTarget, value: ioBroker.StateValue): Promise<void> {
    const operationFinished = target.name === OPERATION_STATE_FEATURE && isFinishedOperationState(value);
    const programFinishedEventActive = target.name === PROGRAM_FINISHED_EVENT_FEATURE && isActiveProgramFinishedEventValue(value);
    if (!operationFinished && !programFinishedEventActive) return;

    const targets = [...finalProgramEndDisplayTargets(device.profile, device.baseId), ...finalProgramEndCompanionTargets(device.profile, device.baseId)];
    if (targets.length === 0) return;

    for (const telemetryTarget of targets) {
      await this.setStateRespectingObjectType(telemetryTarget.stateId, telemetryTarget.value);
      device.stateValuesByFeature.set(telemetryTarget.feature, telemetryTarget.value);
    }

    this.log.debug(`${device.profile.haId}: finalizing program end display after finished state: ProgramProgress=100, RemainingProgramTime=0, phases=Finished/Fertig`);
  }

  private async clearProgramPhaseDisplayIfIdle(device: RunningDevice, target: StateTarget, value: ioBroker.StateValue): Promise<void> {
    const operationIdle = target.name === OPERATION_STATE_FEATURE && isIdleOperationState(value);
    const noActiveProgram = target.name === ACTIVE_PROGRAM_FEATURE && isNoActiveProgramValue(value);
    if (!operationIdle && !noActiveProgram) return;
    await this.clearProgramPhaseDisplay(device);
  }

  private async clearProgramPhaseDisplay(device: RunningDevice): Promise<void> {
    const targets = clearProgramPhaseDisplayTargets(device.profile, device.baseId);
    if (targets.length === 0) return;

    const currentValuesByFeature = new Map<string, ioBroker.StateValue>();
    for (const target of targets) {
      if (device.stateValuesByFeature.has(target.feature)) {
        currentValuesByFeature.set(target.feature, device.stateValuesByFeature.get(target.feature)!);
        continue;
      }
      const state = await this.getStateAsync(target.stateId);
      currentValuesByFeature.set(target.feature, state?.val ?? "");
      device.stateValuesByFeature.set(target.feature, state?.val ?? "");
    }

    const targetsToClear = nonEmptyClearProgramPhaseDisplayTargets(targets, currentValuesByFeature);
    if (targetsToClear.length === 0) return;

    for (const phaseTarget of targetsToClear) {
      await this.setStateRespectingObjectType(phaseTarget.stateId, phaseTarget.value);
      device.stateValuesByFeature.set(phaseTarget.feature, phaseTarget.value);
    }
    this.log.debug(`${device.profile.haId}: clearing program phase display after idle/off state`);
  }

  private async setStateRespectingObjectType(id: string, value: ioBroker.StateValue): Promise<void> {
    const object = await this.getObjectAsync(id);
    const valueToWrite = coerceStateValueForObjectType(value, object?.common?.type);
    await this.setState(id, valueToWrite, true);
  }

  private updateProgramOptionContextMarker(device: RunningDevice, target: StateTarget): void {
    if (target.name === SELECTED_PROGRAM_FEATURE) {
      const selectedRaw = target.rawValue;
      if (device.lastSelectedProgramRaw !== selectedRaw) {
        device.lastOptionContextProgramRaw = undefined;
      }
      device.lastSelectedProgramRaw = selectedRaw;
      return;
    }

    const selectedUid = Number(device.lastSelectedProgramRaw);
    if (!Number.isFinite(selectedUid)) return;
    const selectedUidKey = normalizeUid(selectedUid);
    const programOptions = selectedUidKey ? device.profile.featureMapping.programOptionsByUid[selectedUidKey] : undefined;
    const isCurrentProgramOption = programOptions?.some(option => normalizeUid(option.refUID) === normalizeUid(target.uid)) === true;
    if (isCurrentProgramOption || target.name.includes(".Option.")) {
      device.lastOptionContextProgramRaw = selectedUid;
    }
  }

  private async writeRootProgramAliasValues(device: RunningDevice, target: StateTarget, value: ioBroker.StateValue): Promise<void> {
    if (target.name === SELECTED_PROGRAM_FEATURE) {
      await this.setState(`${device.baseId}.program.RootSelectedProgram`, value, true);
      await this.setState(`${device.baseId}.program.selectedProgramName`, this.programDisplayName(device, String(value)), true);
    }
    if (target.name === ACTIVE_PROGRAM_FEATURE) {
      await this.setState(`${device.baseId}.program.RootActiveProgram`, value, true);
      await this.setState(`${device.baseId}.program.activeProgramName`, this.programDisplayName(device, String(value)), true);
    }
    if (target.name === SELECTED_PROGRAM_FEATURE || target.name === ACTIVE_PROGRAM_FEATURE) {
      await this.updateStartAvailability(device);
    }
  }

  private async updateProgramList(device: RunningDevice): Promise<void> {
    const programs = Object.entries(device.profile.featureMapping.featuresByUid)
      .filter(([, featureName]) => featureName.includes(".Program."))
      .map(([uid, featureName]) => ({ uid: this.uidStringToNumber(uid), featureName, name: this.programDisplayName(device, featureName) }))
      .filter(item => item.uid !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
    await this.setState(`${device.baseId}.availablePrograms.availableJson`, JSON.stringify(programs), true);
    await this.setState(`${device.baseId}.availablePrograms.availableList`, programs.map(item => item.name).join(", "), true);
    await this.ensureProgramDropdownStateObjects(device);
    await this.prepareRootProgramAliasObjects(device);
  }

  private commonMetadata(device: RunningDevice, target: StateTarget, raw: unknown): StateCommonMetadata | undefined {
    const change = raw && typeof raw === "object" && !Array.isArray(raw) ? metadataFromDescriptionChange(raw as Record<string, unknown>) : undefined;
    const programStates = target.name === SELECTED_PROGRAM_FEATURE || target.name === ACTIVE_PROGRAM_FEATURE ? this.programStatesMetadata(device) : undefined;
    return mergeMetadata(change, metadataForFeature(target.name, target.uid, device.profile), programStates);
  }

  private async writeEnumCompanionStates(device: RunningDevice, target: StateTarget): Promise<void> {
    if (!this.shouldWriteEnumCompanionStates(target)) return;

    const enumType = device.profile.featureMapping.enumTypeByUid[target.uid];
    const enumText = enumType ? device.profile.featureMapping.enumValuesByType[enumType]?.[String(target.rawValue)] : undefined;
    const companionText = enumText ?? (target.category === "phases" ? String(target.value) : undefined);
    if (companionText === undefined) return;
    const baseId = `${device.baseId}.${target.id}`;
    await this.ensureStateObject(`${baseId}_raw`, `${target.name} raw`, 0, "value");
    await this.setState(`${baseId}_raw`, Number(target.rawValue), true);
    await this.ensureStateObject(`${baseId}_de`, `${target.name} German`, "", "text");
    await this.setState(`${baseId}_de`, translatedCompanionValueForTarget(target, companionText), true);
  }

  private shouldWriteEnumCompanionStates(target: StateTarget): boolean {
    return target.category === "phases" || target.category === "status" || target.category === "program";
  }

  private rawProgramForName(device: RunningDevice, value: ioBroker.StateValue): unknown {
    const key = this.programKeyForWrite(device, value, "start program by name");
    if (!key) return undefined;
    const rawUid = this.rawProgramUidForKey(device, key);
    if (rawUid === undefined) {
      this.log.warn(`${device.profile.haId}: cannot resolve program ${JSON.stringify(value)} to raw UID, not writing`);
    }
    return rawUid;
  }

  private rawProgramUidForKey(device: RunningDevice, programKey: string): number | undefined {
    const matchingUids = Object.entries(device.profile.featureMapping.featuresByUid)
      .filter(([, featureName]) => featureName === programKey)
      .map(([uid]) => Number.parseInt(uid, 16))
      .filter(uid => Number.isFinite(uid));

    return matchingUids.length === 1 ? matchingUids[0] : undefined;
  }

  private programDisplayName(device: RunningDevice, featureName: string): string {
    return displayNameForProgram(featureName, this.favoriteNameForProgram(device, featureName));
  }

  private favoriteNameForProgram(device: RunningDevice, featureName: string): string | undefined {
    const favorite = featureName.match(/^BSH\.Common\.Program\.Favorite\.(.+)$/);
    if (!favorite) return undefined;
    const favName = device.stateValuesByFeature.get(`BSH.Common.Setting.Favorite.${favorite[1]}.Name`);
    return favName === undefined || favName === null ? undefined : String(favName);
  }

  private programKeyForWrite(device: RunningDevice, value: ioBroker.StateValue, context: string): string | undefined {
    const text = String(value ?? "").trim();
    const result = resolveProgramKeyForDevice(device, value);
    if (result.key) return result.key;
    this.log.warn(`${device.profile.haId}: cannot resolve program ${JSON.stringify(text)} to raw UID, not writing (${context}, ${result.matches.length === 0 ? "unknown" : "not unique"})`);
    return undefined;
  }

  private canWriteTarget(device: RunningDevice, target: StateTarget): boolean {
    if (target.uid === POWER_STATE_UID) return true;
    if (target.name === SELECTED_PROGRAM_FEATURE) return true;
    if (target.name === ACTIVE_PROGRAM_FEATURE) return true;
    if (target.category === "options") {
      if (isReadOnlyProgramOption(target.name)) return false;
      return device.writableUids.has(target.uid) || hasWritableProgramOption(device.profile, target.uid);
    }
    return device.writableUids.has(target.uid) && (target.category === "settings" || target.category === "program");
  }

  private registerWritableState(device: RunningDevice, stateId: string, uid: number, featureName: string, kind: WritableState["kind"]): void {
    this.writableStates.set(stateId, { deviceHaId: device.profile.haId, uid, featureName, kind, stateId });
  }

  private initialTargetValue(target: StateTarget): ioBroker.StateValue {
    if (target.uid === POWER_STATE_UID) return false;
    if (target.name === ACTIVE_PROGRAM_FEATURE || target.name === SELECTED_PROGRAM_FEATURE) return "";
    if (this.isProgramProgress(target)) return 0;
    return "";
  }

  private normalizeTargetValue(device: RunningDevice, target: StateTarget): ioBroker.StateValue {
    if (target.uid === POWER_STATE_UID) return Number(target.rawValue) === POWER_STATE_ON;
    if (target.name === ACTIVE_PROGRAM_FEATURE || target.name === SELECTED_PROGRAM_FEATURE) {
      if (target.rawValue === 0 || target.rawValue === null || target.rawValue === undefined) return "";
      if (typeof target.value === "string" && target.value.includes(".Program.")) return target.value;
      if (typeof target.rawValue === "number") return this.programKeyFromRawUid(device, target.rawValue) ?? "";
      if (typeof target.rawValue === "string" && target.rawValue.includes(".Program.")) return target.rawValue;
      return "";
    }
    if (this.isProgramProgress(target)) {
      const progress = Number(target.rawValue);
      return Number.isFinite(progress) ? progress : 0;
    }
    return toStateValue(target.value);
  }

  private isProgramProgress(target: StateTarget): boolean {
    return /ProgramProgress$/i.test(target.name);
  }

  private async setTextState(id: string, value: unknown): Promise<void> { await setTextState(this, id, value); }
  private async setNumberState(id: string, value: unknown): Promise<void> { await setNumberState(this, id, value); }
  private async setBooleanState(id: string, value: unknown): Promise<void> { await setBooleanState(this, id, value); }

  private async ensureChannel(id: string, name: string): Promise<void> { await ensureChannel(this, id, name); }

  private async ensureStateObject(id: string, name: string, value: ioBroker.StateValue, role?: string, write = false, metadata?: StateCommonMetadata): Promise<void> {
    await ensureStateObject(this, id, name, value, role, write, metadata);
  }

  private async ensureCommandStateObject(id: string, name: string): Promise<void> {
    await ensureButtonStateObject(this, id, name);
  }

  private async prepareWritableCommandState(device: RunningDevice, stateId: string, target: StateTarget): Promise<void> {
    if (this.isDangerousCommand(target.name)) return;
    await this.ensureCommandStateObject(stateId, target.name);
    const numericUid = this.uidStringToNumber(target.uid);
    if (numericUid !== undefined) this.registerWritableState(device, stateId, numericUid, target.name, "command");
  }

  private uidForFeature(profile: ApplianceProfile, featureName: string): number | undefined {
    for (const [uid, mappedFeatureName] of Object.entries(profile.featureMapping.featuresByUid)) {
      if (mappedFeatureName === featureName) return this.uidStringToNumber(uid);
    }
    return undefined;
  }

  private uidStringToNumber(uid: string): number | undefined {
    const normalized = normalizeUid(uid);
    if (!normalized) return undefined;
    const parsed = Number.parseInt(normalized, 16);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private async updateGlobalConnectionState(): Promise<void> {
    for (const device of this.devices.values()) {
      const state = await this.getStateAsync(`${device.baseId}.general.connected`);
      if (state?.val === true) {
        await this.setState("info.connection", true, true);
        return;
      }
    }
    await this.setState("info.connection", false, true);
  }

  private async onUnload(callback: () => void): Promise<void> {
    this.unloaded = true;
    try {
      stopHomeConnectDiscovery();
      if (this.connectionWatchdogTimer) {
        clearInterval(this.connectionWatchdogTimer);
        this.connectionWatchdogTimer = undefined;
      }
      for (const device of this.devices.values()) {
        if (device.reconnectTimer) clearTimeout(device.reconnectTimer);
        if (device.powerResetTimer) clearTimeout(device.powerResetTimer);
        await this.setDeviceConnectionState(device, false);
        await device.client?.close();
      }
      await this.setState("info.connection", false, true);
      callback();
    } catch (error) {
      this.log.error(`Unload failed: ${String(error)}`);
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HomeconnectLocalAdapter(options);
} else {
  void new HomeconnectLocalAdapter();
}
