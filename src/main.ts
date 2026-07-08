import * as utils from "@iobroker/adapter-core";

import { HomeConnectClient } from "./lib/client";
import { ensureDiagnosticStates, writeApplianceInfo, writeNetworkInfo, writeRegisteredDevices, writeServiceInfo } from "./lib/diagnosticsWriter";
import { ensureChannel, ensureStateObject, setBooleanState, setNumberState, setTextState } from "./lib/objectHelpers";
import { translateEnumValue } from "./lib/enumTranslations";
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
import { connectionFailureLogLevel, connectionFailureLogMessage } from "./lib/reconnectPolicy";
import { RunningDevice, WritableState } from "./lib/runtimeTypes";
import { StateMapper } from "./lib/stateMapper";
import { durationToSeconds, isTruthyWrite, parseJsonObject, stateValueToPowerBoolean, stateValueToRaw, toStateValue } from "./lib/valueConverter";
import { AdapterNativeConfig, ApplianceProfile, ConfiguredDevice, HcMessage, RoValue, StateTarget } from "./lib/types";

class HomeconnectLocalAdapter extends utils.Adapter {
  private devices = new Map<string, RunningDevice>();
  private writableStates = new Map<string, WritableState>();
  private unloaded = false;
  private currentConfig: AdapterNativeConfig = {} as AdapterNativeConfig;

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "homeconnect-local" });
    this.on("ready", () => void this.onReady());
    this.on("unload", callback => void this.onUnload(callback));
    this.on("stateChange", (id, state) => void this.onStateChange(id, state));
  }

  private async onReady(): Promise<void> {
    this.currentConfig = this.config as AdapterNativeConfig;
    await this.ensureInfoConnectionObject();
    await this.setState("info.connection", false, true);
    await this.subscribeStatesAsync("*.settings.*");
    await this.subscribeStatesAsync("*.options.*");
    await this.subscribeStatesAsync("*.commands.*");
    await this.subscribeStatesAsync("*.program.*");

    const profilePath = this.currentConfig.profilePath?.trim();
    if (!profilePath) {
      this.log.warn("No profilePath configured. Add a profile ZIP or extracted profile directory in the adapter settings.");
      return;
    }

    let profiles: ApplianceProfile[];
    try {
      profiles = loadProfiles(profilePath);
    } catch (error) {
      this.log.error(`Unable to load Home Connect profiles: ${String(error)}`);
      return;
    }

    this.log.info(`Loaded ${profiles.length} Home Connect profile(s) from ${profilePath}`);
    await this.syncConfiguredDevicesWithProfiles(profiles);
    const profilesByHaId = new Map(profiles.map(profile => [profile.haId, profile]));

    for (const profile of profiles) {
      this.log.info(`${profile.haId}: profile found (${this.profileDisplayName(profile)}, ${profile.connectionType})`);
    }

    for (const configuredDevice of this.currentConfig.devices ?? []) {
      if (!configuredDevice.enabled) continue;
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
        reconnecting: false,
        reconnectFailures: 0,
        writableUids: new Set<string>(),
        blockedCommands: [],
        stateValuesByFeature: new Map<string, ioBroker.StateValue>(),
      };

      this.devices.set(profile.haId, device);
      await this.prepareDeviceObjects(device);
      await this.connectDevice(device);
    }
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

  private async persistNativeConfig(): Promise<void> {
    const instanceObjectId = `system.adapter.${this.namespace}`;
    const instanceObject = await this.getForeignObjectAsync(instanceObjectId);
    if (!instanceObject || instanceObject.type !== "instance") {
      this.log.warn(`Cannot persist device table, instance object ${instanceObjectId} not found`);
      return;
    }
    const instanceNative = (instanceObject.native ?? {}) as Record<string, unknown>;
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

    for (const channel of ["status", "program", "phases", "options", "settings", "events", "programs", "commands", "raw", "metadata", "network", "services", "registeredDevices", "expertCommands"]) {
      await this.ensureChannel(`${baseId}.${channel}`, channel);
    }
    await ensureDiagnosticStates(this, device);
    await this.ensureProgramStates(device);
    await this.prepareRootProgramAliasObjects(device);

    await this.ensureStateObject(`${baseId}.settings.PowerState`, "BSH.Common.Setting.PowerState", false, "switch", true);
    this.registerWritableState(device, `${baseId}.settings.PowerState`, POWER_STATE_UID_NUMBER, "BSH.Common.Setting.PowerState", "value");

    await this.prepareCommandObjects(device);
    await this.prepareStartProgramObjects(device);
    await this.updateProgramList(device);
  }

  private async ensureProgramStates(device: RunningDevice): Promise<void> {
    await this.ensureStateObject(`${device.baseId}.program.startOptionsJson`, "Start options JSON", "{}", "json", true);
    await this.ensureProgramDropdownStateObjects(device);
    await this.ensureStateObject(`${device.baseId}.program.selectedProgramName`, "Selected program name", "", "text");
    await this.ensureStateObject(`${device.baseId}.program.activeProgramName`, "Active program name", "", "text");
    await this.ensureStateObject(`${device.baseId}.programs.availableList`, "Available programs list", "", "text");
    await this.ensureStateObject(`${device.baseId}.programs.availableJson`, "Available programs JSON", "", "json");
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
      await this.ensureStateObject(stateId, featureName, false, "button", true);
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
    await this.ensureStateObject(`${device.baseId}.commands.StartProgram`, "Start selected program", false, "button", true);
    this.registerWritableState(device, `${device.baseId}.commands.StartProgram`, activeProgramUid, ACTIVE_PROGRAM_FEATURE, "startProgram");
    await this.ensureStateObject(`${device.baseId}.commands.StartProgramWithOptions`, "Start selected program with program.startOptionsJson", false, "button", true);
    this.registerWritableState(device, `${device.baseId}.commands.StartProgramWithOptions`, activeProgramUid, ACTIVE_PROGRAM_FEATURE, "startProgramWithOptions");
  }

  private async connectDevice(device: RunningDevice): Promise<void> {
    if (this.unloaded) return;
    if (device.profile.connectionType !== "AES" && device.profile.connectionType !== "TLS") {
      this.log.warn(`${device.profile.haId}: unsupported connectionType ${device.profile.connectionType}. Expected AES or TLS.`);
      return;
    }
    if (device.profile.connectionType === "AES" && !device.profile.iv) {
      this.log.warn(`${device.profile.haId}: AES profile has no IV. Skipping device.`);
      return;
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
      messageHandler: message => this.handleDeviceMessage(device, message),
      closeHandler: error => this.scheduleReconnect(device, error),
    });
    device.client = client;

    try {
      await client.connect();
      await this.setDeviceConnectionState(device, true);
      this.log.info(`${device.profile.haId}: connected`);
      await client.readInitialValues();
    } catch (error) {
      await client.close().catch(closeError => this.log.debug(`Close after failed connect failed: ${String(closeError)}`));
      await this.setDeviceConnectionState(device, false, error);
      this.logConnectionFailure(device, error);
      this.scheduleReconnect(device, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (!state || state.ack) return;
    const relativeId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    const writableState = this.writableStates.get(relativeId);
    if (!writableState) return;
    const device = this.devices.get(writableState.deviceHaId);
    if (!device?.client) {
      this.log.warn(`${relativeId}: cannot write ${writableState.featureName}, device is not connected`);
      return;
    }

    try {
      const rawValue = await this.valueForWrite(device, writableState, state.val);
      if (rawValue === undefined) return;

      if (writableState.kind === "startProgramWithOptions") {
        await this.writeStartProgramWithOptions(device, writableState.uid, rawValue);
      } else if (writableState.kind === "startProgramName") {
        this.log.info(`${device.profile.haId}: starting program by name = ${JSON.stringify(rawValue)}`);
        await device.client.writeValue(writableState.uid, rawValue);
      } else {
        this.log.info(`${device.profile.haId}: writing ${writableState.featureName} = ${JSON.stringify(rawValue)}`);
        await device.client.writeValue(writableState.uid, rawValue);
      }

      if (writableState.kind === "command" || writableState.kind === "startProgram" || writableState.kind === "startProgramWithOptions") {
        await this.setState(writableState.stateId, true, true);
        setTimeout(() => void this.setState(writableState.stateId, false, true), 750);
      } else {
        await this.setState(writableState.stateId, this.normalizeWrittenAckValue(writableState, rawValue), true);
      }
    } catch (error) {
      this.log.warn(`${device.profile.haId}: writing ${writableState.featureName} failed: ${String(error)}`);
    }
  }

  private async valueForWrite(device: RunningDevice, writableState: WritableState, value: ioBroker.StateValue): Promise<unknown> {
    if (writableState.kind === "command") return isTruthyWrite(value) ? true : undefined;
    if (writableState.kind === "startProgramName") return this.rawProgramForName(device, value);
    if (writableState.featureName === SELECTED_PROGRAM_FEATURE || writableState.featureName === ACTIVE_PROGRAM_FEATURE) {
      const key = this.programKeyForWrite(device, value, writableState.featureName);
      return key === undefined ? undefined : stateValueToRaw(device.profile, writableState.uid, key);
    }
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
      const raw = stateValueToRaw(device.profile, selectedProgramUid, selectedProgramState.val);
      this.log.info(`${device.profile.haId}: starting selected program ${JSON.stringify(raw)} (${this.programDisplayName(device, String(selectedProgramState.val))})`);
      return raw;
    }
    if (writableState.uid === POWER_STATE_UID_NUMBER) return stateValueToPowerBoolean(value) ? POWER_STATE_ON : POWER_STATE_OFF;
    return stateValueToRaw(device.profile, writableState.uid, value);
  }

  private async writeStartProgramWithOptions(device: RunningDevice, activeProgramUid: number, selectedProgramRaw: unknown): Promise<void> {
    if (!device.client) throw new Error("Device is not connected");
    const optionsState = await this.getStateAsync(`${device.baseId}.program.startOptionsJson`);
    const options = parseJsonObject(optionsState?.val);
    const values = this.buildStartOptionValues(device, options);
    for (const entry of values) {
      this.log.info(`${device.profile.haId}: writing start option uid ${entry.uid} = ${JSON.stringify(entry.value)}`);
      await device.client.writeValue(entry.uid, entry.value);
    }
    this.log.info(`${device.profile.haId}: starting selected program = ${JSON.stringify(selectedProgramRaw)}`);
    await device.client.writeValue(activeProgramUid, selectedProgramRaw);
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
    const uid = normalizeUid(rawValue);
    return uid ? device.profile.featureMapping.featuresByUid[uid] : undefined;
  }

  private scheduleReconnect(device: RunningDevice, error?: Error): void {
    if (this.unloaded || device.reconnecting) return;
    if (error) void this.setState(`${device.baseId}.info.lastError`, error.message, true);
    device.reconnecting = true;
    void this.setState(`${device.baseId}.info.reconnecting`, true, true);
    void this.updateGlobalConnectionState();
    const seconds = Math.max(5, Number(this.currentConfig.reconnectInterval ?? 30));
    device.reconnectTimer = setTimeout(() => {
      device.reconnecting = false;
      void this.setState(`${device.baseId}.info.reconnecting`, false, true);
      void this.connectDevice(device);
    }, seconds * 1000);
  }

  private logConnectionFailure(device: RunningDevice, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    device.reconnectFailures += 1;
    const level = connectionFailureLogLevel(message, device.reconnectFailures);
    this.log[level](connectionFailureLogMessage(device.profile.haId, message, device.reconnectFailures));
  }

  private async setDeviceConnectionState(device: RunningDevice, connected: boolean, error?: unknown): Promise<void> {
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
  }

  private async handleDeviceMessage(device: RunningDevice, message: HcMessage): Promise<void> {
    await this.setState(`${device.baseId}.info.lastSeen`, new Date().toISOString(), true);
    await this.setState(`${device.baseId}.info.lastMessage`, JSON.stringify(message), true);
    if (message.resource === "/ci/info" || message.resource === "/iz/info") await writeApplianceInfo(this, device, message.data);
    if (message.resource === "/ni/info") await writeNetworkInfo(this, device, message.data);
    if (message.resource === "/ci/services") await writeServiceInfo(this, device, message.data);
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
      const access = typeof value.access === "string" ? value.access : "";
      if (access === "READWRITE") device.writableUids.add(uid);
      else if (access === "READ" || access === "NONE") device.writableUids.delete(uid);
      const target = device.mapper.toStateTarget({ uid, value: "" });
      if (!target) continue;
      const stateId = `${device.baseId}.${target.id}`;
      const writable = this.canWriteTarget(device, target);
      await this.ensureStateObject(stateId, target.name, this.initialTargetValue(target), target.uid === POWER_STATE_UID ? "switch" : undefined, writable, this.commonMetadata(device, target, value));
      await this.writeStateMetadata(device, target, access, value.available !== false, writable, value.raw ?? value);
      if (writable) this.registerWritableState(device, stateId, this.uidStringToNumber(uid) ?? Number(uid), target.name, "value");
      if (target.name === SELECTED_PROGRAM_FEATURE || target.name === ACTIVE_PROGRAM_FEATURE) await this.prepareRootProgramAliasObjects(device);
    }
  }

  private async writeRoValue(device: RunningDevice, value: RoValue): Promise<void> {
    const target = device.mapper.toStateTarget(value);
    if (!target) return;
    const stateId = `${device.baseId}.${target.id}`;
    const normalizedValue = this.normalizeTargetValue(target);
    const isWritable = this.canWriteTarget(device, target);
    await this.ensureStateObject(stateId, target.name, normalizedValue, target.uid === POWER_STATE_UID ? "switch" : undefined, isWritable, this.commonMetadata(device, target, value));
    await this.setState(stateId, normalizedValue, true);
    await this.writeEnumCompanionStates(device, target);
    device.stateValuesByFeature.set(target.name, normalizedValue);
    await this.writeRootProgramAliasValues(device, target, normalizedValue);
    await this.writeStateMetadata(device, target, undefined, true, isWritable, value);
    if (isWritable) {
      const numericUid = this.uidStringToNumber(target.uid);
      if (numericUid !== undefined) this.registerWritableState(device, stateId, numericUid, target.name, "value");
    }
    if (this.currentConfig.debugRaw) {
      await this.ensureStateObject(`${device.baseId}.raw.uid_${target.uid}`, `Raw ${target.uid} ${target.name}`, "", "json");
      await this.setState(`${device.baseId}.raw.uid_${target.uid}`, JSON.stringify(value), true);
    }
    if (target.name.includes(".Program.") || target.name.includes(".Setting.Favorite.")) await this.updateProgramList(device);
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
  }

  private async writeStateMetadata(device: RunningDevice, target: StateTarget, access: string | undefined, available: boolean, writable: boolean, raw: unknown): Promise<void> {
    const metaId = `${device.baseId}.metadata.${sanitizeObjectId(target.id)}`;
    await this.ensureStateObject(`${metaId}_available`, `${target.name} available`, available, "indicator");
    await this.ensureStateObject(`${metaId}_access`, `${target.name} access`, "", "text");
    await this.ensureStateObject(`${metaId}_writable`, `${target.name} writable`, writable, "indicator");
    await this.ensureStateObject(`${metaId}_raw`, `${target.name} raw metadata`, "", "json");
    await this.setState(`${metaId}_available`, available, true);
    if (access !== undefined) await this.setState(`${metaId}_access`, access, true);
    await this.setState(`${metaId}_writable`, writable, true);
    await this.setState(`${metaId}_raw`, JSON.stringify(raw), true);
  }

  private async updateProgramList(device: RunningDevice): Promise<void> {
    const programs = Object.entries(device.profile.featureMapping.featuresByUid)
      .filter(([, featureName]) => featureName.includes(".Program."))
      .map(([uid, featureName]) => ({ uid: this.uidStringToNumber(uid), featureName, name: this.programDisplayName(device, featureName) }))
      .filter(item => item.uid !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
    await this.setState(`${device.baseId}.programs.availableJson`, JSON.stringify(programs), true);
    await this.setState(`${device.baseId}.programs.availableList`, programs.map(item => item.name).join(", "), true);
    await this.ensureProgramDropdownStateObjects(device);
    await this.prepareRootProgramAliasObjects(device);
  }

  private commonMetadata(device: RunningDevice, target: StateTarget, raw: unknown): StateCommonMetadata | undefined {
    const change = raw && typeof raw === "object" && !Array.isArray(raw) ? metadataFromDescriptionChange(raw as Record<string, unknown>) : undefined;
    const programStates = target.name === SELECTED_PROGRAM_FEATURE || target.name === ACTIVE_PROGRAM_FEATURE ? this.programStatesMetadata(device) : undefined;
    return mergeMetadata(metadataForFeature(target.name, target.uid, device.profile), change, programStates);
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
    await this.setState(`${baseId}_de`, translateEnumValue(target.name, companionText, target.rawValue), true);
  }

  private shouldWriteEnumCompanionStates(target: StateTarget): boolean {
    return target.category === "phases" || target.category === "status" || target.category === "program";
  }

  private rawProgramForName(device: RunningDevice, value: ioBroker.StateValue): unknown {
    const key = this.programKeyForWrite(device, value, "start program by name");
    if (!key) return undefined;
    return stateValueToRaw(device.profile, this.uidForFeature(device.profile, ACTIVE_PROGRAM_FEATURE) ?? 0, key);
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
    this.log.warn(`${device.profile.haId}: cannot ${context} ${JSON.stringify(text)}, ${result.matches.length === 0 ? "unknown" : "not unique"}`);
    return undefined;
  }

  private canWriteTarget(device: RunningDevice, target: StateTarget): boolean {
    if (target.uid === POWER_STATE_UID) return true;
    if (target.name === SELECTED_PROGRAM_FEATURE) return true;
    if (target.name === ACTIVE_PROGRAM_FEATURE) return true;
    return device.writableUids.has(target.uid) && (target.category === "settings" || target.category === "options" || target.category === "program");
  }

  private registerWritableState(device: RunningDevice, stateId: string, uid: number, featureName: string, kind: WritableState["kind"]): void {
    this.writableStates.set(stateId, { deviceHaId: device.profile.haId, uid, featureName, kind, stateId });
  }

  private initialTargetValue(target: StateTarget): ioBroker.StateValue {
    if (target.uid === POWER_STATE_UID) return false;
    if (this.isProgramProgress(target)) return 0;
    return "";
  }

  private normalizeTargetValue(target: StateTarget): ioBroker.StateValue {
    if (target.uid === POWER_STATE_UID) return Number(target.rawValue) === POWER_STATE_ON;
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
      for (const device of this.devices.values()) {
        if (device.reconnectTimer) clearTimeout(device.reconnectTimer);
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
