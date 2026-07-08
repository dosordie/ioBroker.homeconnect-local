import * as utils from "@iobroker/adapter-core";

import { HomeConnectClient } from "./lib/client";
import { normalizeUid, sanitizeObjectId } from "./lib/ids";
import { loadProfiles } from "./lib/profile";
import { StateMapper } from "./lib/stateMapper";
import { AdapterNativeConfig, ApplianceProfile, ConfiguredDevice, HcMessage, RoValue, StateTarget } from "./lib/types";

const POWER_STATE_UID = "021B";
const POWER_STATE_UID_NUMBER = 0x021b;
const POWER_STATE_OFF = 1;
const POWER_STATE_ON = 2;
const SELECTED_PROGRAM_FEATURE = "BSH.Common.Root.SelectedProgram";
const ACTIVE_PROGRAM_FEATURE = "BSH.Common.Root.ActiveProgram";

interface RunningDevice {
  baseId: string;
  config: ConfiguredDevice;
  profile: ApplianceProfile;
  mapper: StateMapper;
  client?: HomeConnectClient;
  reconnectTimer?: NodeJS.Timeout;
  reconnecting: boolean;
  writableUids: Set<string>;
}

interface WritableState {
  deviceHaId: string;
  uid: number;
  featureName: string;
  kind: "value" | "command" | "startProgram";
  stateId: string;
}

class HomeconnectLocalAdapter extends utils.Adapter {
  private devices = new Map<string, RunningDevice>();
  private writableStates = new Map<string, WritableState>();
  private unloaded = false;
  private currentConfig: AdapterNativeConfig = {} as AdapterNativeConfig;

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "homeconnect-local",
    });

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
    await this.subscribeStatesAsync("*.program.SelectedProgram");

    this.log.debug(`Native config at startup: ${JSON.stringify(this.currentConfig)}`);

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
    const profilesByHaId = new Map(profiles.map(profile => [profile.haId, profile]));
    const configuredDevices = this.currentConfig.devices ?? [];

    for (const configuredDevice of configuredDevices) {
      if (!configuredDevice.enabled) {
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

      const baseId = sanitizeObjectId(profile.haId);
      const runningDevice: RunningDevice = {
        baseId,
        config: configuredDevice,
        profile,
        mapper: new StateMapper(profile),
        reconnecting: false,
        writableUids: new Set<string>(),
      };

      this.devices.set(profile.haId, runningDevice);
      await this.prepareDeviceObjects(runningDevice);
      await this.connectDevice(runningDevice);
    }
  }

  private async ensureInfoConnectionObject(): Promise<void> {
    await this.ensureStateObject("info.connection", "If connected to at least one appliance", false, "indicator.connected");
  }

  private async prepareDeviceObjects(device: RunningDevice): Promise<void> {
    const { baseId, profile, config } = device;

    await this.setObjectNotExistsAsync(baseId, {
      type: "device",
      common: {
        name: `${profile.brand ?? "BSH"} ${profile.vib ?? profile.type}`,
      },
      native: {
        haId: profile.haId,
        type: profile.type,
        vib: profile.vib,
        mac: profile.mac,
        connectionType: profile.connectionType,
        host: config.host,
      },
    });

    await this.setObjectNotExistsAsync(`${baseId}.info`, {
      type: "channel",
      common: { name: "Information" },
      native: {},
    });

    await this.ensureStateObject(`${baseId}.info.connected`, "Connected", false, "indicator.connected");
    await this.ensureStateObject(`${baseId}.info.lastMessage`, "Last raw Home Connect message", "", "json");
    await this.ensureStateObject(`${baseId}.info.connectionType`, "Connection type", "", "text");
    await this.setState(`${baseId}.info.connectionType`, String(profile.connectionType), true);

    for (const channel of ["status", "program", "phases", "options", "settings", "events", "programs", "commands", "raw"]) {
      await this.setObjectNotExistsAsync(`${baseId}.${channel}`, {
        type: "channel",
        common: { name: channel },
        native: {},
      });
    }

    await this.ensureStateObject(`${baseId}.settings.PowerState`, "BSH.Common.Setting.PowerState", false, "switch", true);
    this.registerWritableState(device, `${baseId}.settings.PowerState`, POWER_STATE_UID_NUMBER, "BSH.Common.Setting.PowerState", "value");

    await this.prepareCommandObjects(device);
    await this.prepareStartProgramObject(device);
  }

  private async prepareCommandObjects(device: RunningDevice): Promise<void> {
    for (const [uid, featureName] of Object.entries(device.profile.featureMapping.featuresByUid)) {
      if (!featureName.includes(".Command.")) {
        continue;
      }

      const numericUid = this.uidStringToNumber(uid);
      if (numericUid === undefined) {
        continue;
      }

      const stateId = `${device.baseId}.commands.${sanitizeObjectId(featureName.split(".Command.")[1] ?? featureName)}`;
      await this.ensureStateObject(stateId, featureName, false, "button", true);
      this.registerWritableState(device, stateId, numericUid, featureName, "command");
    }
  }

  private async prepareStartProgramObject(device: RunningDevice): Promise<void> {
    const activeProgramUid = this.uidForFeature(device.profile, ACTIVE_PROGRAM_FEATURE);
    if (activeProgramUid === undefined) {
      return;
    }

    const stateId = `${device.baseId}.commands.StartProgram`;
    await this.ensureStateObject(stateId, "Start selected program", false, "button", true);
    this.registerWritableState(device, stateId, activeProgramUid, ACTIVE_PROGRAM_FEATURE, "startProgram");
  }

  private async connectDevice(device: RunningDevice): Promise<void> {
    if (this.unloaded) {
      return;
    }

    if (device.profile.connectionType !== "AES" && device.profile.connectionType !== "TLS") {
      this.log.warn(`${device.profile.haId}: unsupported connectionType ${device.profile.connectionType}. Expected AES or TLS.`);
      return;
    }

    if (device.profile.connectionType === "AES" && !device.profile.iv) {
      this.log.warn(`${device.profile.haId}: AES profile has no IV. Skipping device.`);
      return;
    }

    this.log.info(`${device.profile.haId}: connecting to ${device.config.host} via ${device.profile.connectionType}`);

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
      await this.setState(`${device.baseId}.info.connected`, true, true);
      await this.updateGlobalConnectionState();
      this.log.info(`${device.profile.haId}: connected`);
      await client.readInitialValues();
    } catch (error) {
      await client.close().catch(closeError => this.log.debug(`Close after failed connect failed: ${String(closeError)}`));
      await this.setState(`${device.baseId}.info.connected`, false, true);
      await this.updateGlobalConnectionState();
      this.log.warn(`${device.profile.haId}: connection failed: ${String(error)}`);
      this.scheduleReconnect(device, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (!state || state.ack) {
      return;
    }

    const relativeId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    const writableState = this.writableStates.get(relativeId);
    if (!writableState) {
      return;
    }

    const device = this.devices.get(writableState.deviceHaId);
    if (!device?.client) {
      this.log.warn(`${relativeId}: cannot write ${writableState.featureName}, device is not connected`);
      return;
    }

    try {
      const rawValue = await this.valueForWrite(device, writableState, state.val);
      if (rawValue === undefined) {
        return;
      }

      this.log.info(`${device.profile.haId}: writing ${writableState.featureName} = ${JSON.stringify(rawValue)}`);
      await device.client.writeValue(writableState.uid, rawValue);

      if (writableState.kind === "command" || writableState.kind === "startProgram") {
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
    if (writableState.kind === "command") {
      if (!this.isTruthyWrite(value)) {
        return undefined;
      }
      return true;
    }

    if (writableState.kind === "startProgram") {
      if (!this.isTruthyWrite(value)) {
        return undefined;
      }

      const selectedProgramUid = this.uidForFeature(device.profile, SELECTED_PROGRAM_FEATURE);
      if (selectedProgramUid === undefined) {
        this.log.warn(`${device.profile.haId}: cannot start program, SelectedProgram UID missing`);
        return undefined;
      }

      const selectedProgramState = await this.getStateAsync(`${device.baseId}.program.SelectedProgram`);
      if (selectedProgramState?.val === undefined) {
        this.log.warn(`${device.profile.haId}: cannot start program, no selected program is known`);
        return undefined;
      }

      const selectedProgramRaw = this.stateValueToRaw(device, selectedProgramUid, selectedProgramState.val);
      if (selectedProgramRaw === undefined || selectedProgramRaw === 0 || selectedProgramRaw === "") {
        this.log.warn(`${device.profile.haId}: cannot start program, no selected program is known`);
        return undefined;
      }

      return selectedProgramRaw;
    }

    if (writableState.uid === POWER_STATE_UID_NUMBER) {
      return this.stateValueToPowerBoolean(value) ? POWER_STATE_ON : POWER_STATE_OFF;
    }

    return this.stateValueToRaw(device, writableState.uid, value);
  }

  private normalizeWrittenAckValue(writableState: WritableState, rawValue: unknown): ioBroker.StateValue {
    if (writableState.uid === POWER_STATE_UID_NUMBER) {
      return Number(rawValue) === POWER_STATE_ON;
    }

    if (typeof rawValue === "boolean" || typeof rawValue === "number" || typeof rawValue === "string") {
      return rawValue;
    }

    return JSON.stringify(rawValue);
  }

  private stateValueToRaw(device: RunningDevice, uid: number, value: ioBroker.StateValue): unknown {
    if (value === undefined || value === null) {
      return undefined;
    }

    const normalizedUid = normalizeUid(uid);
    if (!normalizedUid) {
      return value;
    }

    if (typeof value === "boolean" || typeof value === "number") {
      return value;
    }

    const text = String(value);
    const numericText = Number(text);
    if (text.trim() !== "" && Number.isFinite(numericText)) {
      return numericText;
    }

    const enumType = device.profile.featureMapping.enumTypeByUid[normalizedUid];
    if (enumType) {
      const enumMap = device.profile.featureMapping.enumValuesByType[enumType] ?? {};
      const lower = text.toLowerCase();
      for (const [raw, label] of Object.entries(enumMap)) {
        if (String(label).toLowerCase() === lower || String(label).split(".").pop()?.toLowerCase() === lower) {
          const rawNumeric = Number(raw);
          return Number.isFinite(rawNumeric) ? rawNumeric : raw;
        }
      }
    }

    const wanted = text.toLowerCase();
    for (const [rawUid, featureName] of Object.entries(device.profile.featureMapping.featuresByUid)) {
      const lastPart = featureName.split(".").pop()?.toLowerCase();
      if (featureName.toLowerCase() === wanted || lastPart === wanted) {
        return this.uidStringToNumber(rawUid) ?? rawUid;
      }
    }

    return value;
  }

  private stateValueToPowerBoolean(value: ioBroker.StateValue): boolean {
    if (value === true || value === 1) {
      return true;
    }

    if (value === false || value === 0) {
      return false;
    }

    const text = String(value).toLowerCase();
    return text === "on" || text.endsWith(".on") || text === "true" || text === "1" || text === "ein";
  }

  private isTruthyWrite(value: ioBroker.StateValue): boolean {
    return value === true || value === 1 || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "1";
  }

  private scheduleReconnect(device: RunningDevice, error?: Error): void {
    if (this.unloaded || device.reconnecting) {
      return;
    }

    if (error) {
      this.log.warn(`${device.profile.haId}: scheduling reconnect after error: ${error.message}`);
    }

    device.reconnecting = true;
    void this.setState(`${device.baseId}.info.connected`, false, true);
    void this.updateGlobalConnectionState();

    const seconds = Math.max(5, Number(this.currentConfig.reconnectInterval ?? 30));
    device.reconnectTimer = setTimeout(() => {
      device.reconnecting = false;
      void this.connectDevice(device);
    }, seconds * 1000);
  }

  private async handleDeviceMessage(device: RunningDevice, message: HcMessage): Promise<void> {
    await this.ensureStateObject(`${device.baseId}.info.lastMessage`, "Last raw Home Connect message", "", "json");
    await this.setState(`${device.baseId}.info.lastMessage`, JSON.stringify(message), true);

    if (message.resource === "/ro/allDescriptionChanges" || message.resource === "/ro/descriptionChange") {
      await this.applyDescriptionChanges(device, message.data);
    }

    if (message.resource?.startsWith("/ro/")) {
      if (this.currentConfig.debugRaw) {
        this.log.debug(`${device.profile.haId}: ${message.resource} ${JSON.stringify(message.data)}`);
      }

      const values = device.mapper.valuesFromMessageData(message.data);
      for (const value of values) {
        if ("value" in value) {
          await this.writeRoValue(device, value);
        }
      }
    }
  }

  private async applyDescriptionChanges(device: RunningDevice, data: unknown): Promise<void> {
    const values = device.mapper.valuesFromMessageData(data);
    for (const value of values) {
      const uid = normalizeUid(value.uid);
      if (!uid) {
        continue;
      }

      const access = typeof value.access === "string" ? value.access : undefined;
      if (access === "READWRITE") {
        device.writableUids.add(uid);
      } else if (access === "READ" || access === "NONE") {
        device.writableUids.delete(uid);
      }

      const target = device.mapper.toStateTarget({ uid, value: "" });
      if (target && this.canWriteTarget(device, target)) {
        const stateId = `${device.baseId}.${target.id}`;
        const normalizedValue = target.uid === POWER_STATE_UID ? false : "";
        const role = target.uid === POWER_STATE_UID ? "switch" : undefined;
        await this.ensureStateObject(stateId, target.name, normalizedValue, role, true);
        this.registerWritableState(device, stateId, this.uidStringToNumber(uid) ?? Number(uid), target.name, "value");
      }
    }
  }

  private async writeRoValue(device: RunningDevice, value: RoValue): Promise<void> {
    const target = device.mapper.toStateTarget(value);
    if (!target) {
      return;
    }

    const stateId = `${device.baseId}.${target.id}`;
    const rawStateId = `${device.baseId}.raw.uid_${target.uid}`;
    const normalizedValue = this.normalizeTargetValue(target);
    const isWritable = this.canWriteTarget(device, target);
    const role = target.uid === POWER_STATE_UID ? "switch" : undefined;
    const rawValue = JSON.stringify(value);

    await this.ensureStateObject(stateId, target.name, normalizedValue, role, isWritable);
    await this.setState(stateId, normalizedValue, true);

    if (isWritable) {
      const numericUid = this.uidStringToNumber(target.uid);
      if (numericUid !== undefined) {
        this.registerWritableState(device, stateId, numericUid, target.name, "value");
      }
    }

    if (this.currentConfig.debugRaw) {
      await this.ensureStateObject(rawStateId, `Raw ${target.uid} ${target.name}`, "", "json");
      await this.setState(rawStateId, rawValue, true);
    }
  }

  private canWriteTarget(device: RunningDevice, target: StateTarget): boolean {
    if (target.uid === POWER_STATE_UID) {
      return true;
    }

    if (target.name === SELECTED_PROGRAM_FEATURE) {
      return true;
    }

    return device.writableUids.has(target.uid) && (target.category === "settings" || target.category === "options" || target.category === "program");
  }

  private registerWritableState(device: RunningDevice, stateId: string, uid: number, featureName: string, kind: WritableState["kind"]): void {
    this.writableStates.set(stateId, {
      deviceHaId: device.profile.haId,
      uid,
      featureName,
      kind,
      stateId,
    });
  }

  private normalizeTargetValue(target: StateTarget): ioBroker.StateValue {
    if (target.uid === POWER_STATE_UID) {
      return Number(target.rawValue) === POWER_STATE_ON;
    }

    return this.normalizeStateValue(target.value);
  }

  private normalizeStateValue(value: unknown): ioBroker.StateValue {
    if (value === undefined || value === null) {
      return "";
    }

    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      return value;
    }

    return JSON.stringify(value);
  }

  private async ensureStateObject(id: string, name: string, value: ioBroker.StateValue, role?: string, write = false): Promise<void> {
    const type = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
    const desiredRole = role ?? (type === "boolean" ? "indicator" : "value");
    const existing = await this.getObjectAsync(id);

    const common: ioBroker.StateCommon = {
      ...(existing?.common as ioBroker.StateCommon | undefined),
      name,
      type,
      role: desiredRole,
      read: true,
      write,
    };

    if (!existing) {
      await this.setObjectNotExistsAsync(id, {
        type: "state",
        common,
        native: {},
      });
      return;
    }

    if (existing.type !== "state" || existing.common?.type !== type || existing.common?.role !== desiredRole || existing.common?.write !== write) {
      await this.extendObjectAsync(id, {
        type: "state",
        common,
        native: existing.native ?? {},
      });
    }
  }

  private uidForFeature(profile: ApplianceProfile, featureName: string): number | undefined {
    for (const [uid, mappedFeatureName] of Object.entries(profile.featureMapping.featuresByUid)) {
      if (mappedFeatureName === featureName) {
        return this.uidStringToNumber(uid);
      }
    }

    return undefined;
  }

  private uidStringToNumber(uid: string): number | undefined {
    const normalized = normalizeUid(uid);
    if (!normalized) {
      return undefined;
    }

    const parsed = Number.parseInt(normalized, 16);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private async updateGlobalConnectionState(): Promise<void> {
    for (const device of this.devices.values()) {
      const state = await this.getStateAsync(`${device.baseId}.info.connected`);
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
        if (device.reconnectTimer) {
          clearTimeout(device.reconnectTimer);
        }

        await this.setState(`${device.baseId}.info.connected`, false, true);
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
