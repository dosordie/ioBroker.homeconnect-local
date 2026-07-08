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
const DANGEROUS_COMMAND_MARKERS = [
  "FactoryReset",
  "NetworkReset",
  "DeactivateWiFi",
  "AllowSoftwareUpdate",
  "AllowSoftwareDownload",
  "SoftwareUpdate",
  "SoftwareDownload",
];

interface RunningDevice {
  baseId: string;
  config: ConfiguredDevice;
  profile: ApplianceProfile;
  mapper: StateMapper;
  client?: HomeConnectClient;
  reconnectTimer?: NodeJS.Timeout;
  reconnecting: boolean;
  reconnectFailures: number;
  writableUids: Set<string>;
  blockedCommands: string[];
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
    await this.syncConfiguredDevicesWithProfiles(profiles);

    const profilesByHaId = new Map(profiles.map(profile => [profile.haId, profile]));
    const configuredDevices = this.currentConfig.devices ?? [];

    for (const profile of profiles) {
      this.log.info(`${profile.haId}: profile found (${this.profileDisplayName(profile)}, ${profile.connectionType})`);
    }

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
        reconnectFailures: 0,
        writableUids: new Set<string>(),
        blockedCommands: [],
      };

      this.devices.set(profile.haId, runningDevice);
      await this.prepareDeviceObjects(runningDevice);
      await this.connectDevice(runningDevice);
    }
  }

  private async syncConfiguredDevicesWithProfiles(profiles: ApplianceProfile[]): Promise<void> {
    if (this.currentConfig.autoAddProfiles === false) {
      return;
    }

    const existingDevices = this.currentConfig.devices ?? [];
    const devicesByHaId = new Map(existingDevices.filter(device => device.haId).map(device => [device.haId as string, { ...device }]));
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

    if (!changed) {
      return;
    }

    const orderedDevices = Array.from(devicesByHaId.values()).sort((a, b) => String(a.name ?? a.haId).localeCompare(String(b.name ?? b.haId)));
    this.currentConfig = {
      ...this.currentConfig,
      devices: orderedDevices,
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
      native: {
        ...instanceNative,
        ...(this.currentConfig as Record<string, unknown>),
      },
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
      common: {
        name: deviceName,
        statusStates: {
          onlineId: `${this.namespace}.${baseId}.general.connected`,
        },
      },
      native: {
        haId: profile.haId,
        type: profile.type,
        brand: profile.brand,
        vib: profile.vib,
        mac: profile.mac,
        connectionType: profile.connectionType,
        profileFile: profile.profileFile,
        host: config.host,
      },
    });

    await this.extendObjectAsync(baseId, {
      common: {
        name: deviceName,
        statusStates: {
          onlineId: `${this.namespace}.${baseId}.general.connected`,
        },
      },
      native: {
        haId: profile.haId,
        type: profile.type,
        brand: profile.brand,
        vib: profile.vib,
        mac: profile.mac,
        connectionType: profile.connectionType,
        profileFile: profile.profileFile,
        host: config.host,
      },
    });

    await this.setObjectNotExistsAsync(`${baseId}.general`, {
      type: "channel",
      common: { name: "General Information" },
      native: {},
    });

    await this.ensureStateObject(`${baseId}.general.connected`, "Connected", false, "indicator.connected");
    await this.ensureStateObject(`${baseId}.general.name`, "Name", "", "text");
    await this.ensureStateObject(`${baseId}.general.deviceID`, "Device ID", "", "text");
    await this.ensureStateObject(`${baseId}.general.deviceType`, "Device type", "", "text");
    await this.ensureStateObject(`${baseId}.general.type`, "Type", "", "text");
    await this.ensureStateObject(`${baseId}.general.brand`, "Brand", "", "text");
    await this.ensureStateObject(`${baseId}.general.vib`, "VIB", "", "text");
    await this.ensureStateObject(`${baseId}.general.eNumber`, "E-number", "", "text");
    await this.ensureStateObject(`${baseId}.general.mac`, "MAC", "", "text");
    await this.ensureStateObject(`${baseId}.general.serialNumber`, "Serial number", "", "text");
    await this.ensureStateObject(`${baseId}.general.customerIndex`, "Customer index", "", "text");
    await this.ensureStateObject(`${baseId}.general.fdString`, "FD", "", "text");
    await this.ensureStateObject(`${baseId}.general.haVersion`, "Home Connect module version", "", "text");
    await this.ensureStateObject(`${baseId}.general.swVersion`, "Software version", "", "text");
    await this.ensureStateObject(`${baseId}.general.hwVersion`, "Hardware version", "", "text");
    await this.ensureStateObject(`${baseId}.general.deviceInfo`, "Device info", "", "text");
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

    await this.setObjectNotExistsAsync(`${baseId}.info`, {
      type: "channel",
      common: { name: "Information" },
      native: {},
    });

    await this.ensureStateObject(`${baseId}.info.connected`, "Connected", false, "indicator.connected");
    await this.ensureStateObject(`${baseId}.info.reconnecting`, "Reconnect in progress", false, "indicator");
    await this.ensureStateObject(`${baseId}.info.lastSeen`, "Last successful contact", "", "date");
    await this.ensureStateObject(`${baseId}.info.lastError`, "Last connection error", "", "text");
    await this.ensureStateObject(`${baseId}.info.lastMessage`, "Last raw Home Connect message", "", "json");
    await this.ensureStateObject(`${baseId}.info.connectionType`, "Connection type", "", "text");
    await this.setState(`${baseId}.info.connectionType`, String(profile.connectionType), true);

    await this.prepareDiagnosticChannels(device);

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

  private async prepareDiagnosticChannels(device: RunningDevice): Promise<void> {
    const { baseId } = device;

    await this.setObjectNotExistsAsync(`${baseId}.network`, {
      type: "channel",
      common: { name: "Network" },
      native: {},
    });
    await this.ensureStateObject(`${baseId}.network.json`, "Raw network info", "", "json");
    await this.ensureStateObject(`${baseId}.network.type`, "Interface type", "", "text");
    await this.ensureStateObject(`${baseId}.network.ssid`, "SSID", "", "text");
    await this.ensureStateObject(`${baseId}.network.rssi`, "RSSI", 0, "value");
    await this.ensureStateObject(`${baseId}.network.status`, "Network status", "", "text");
    await this.ensureStateObject(`${baseId}.network.configured`, "Configured", false, "indicator");
    await this.ensureStateObject(`${baseId}.network.primary`, "Primary interface", false, "indicator");
    await this.ensureStateObject(`${baseId}.network.euiAddress`, "EUI address", "", "text");
    await this.ensureStateObject(`${baseId}.network.ipv4Address`, "IPv4 address", "", "text");
    await this.ensureStateObject(`${baseId}.network.ipv4PrefixSize`, "IPv4 prefix size", 0, "value");
    await this.ensureStateObject(`${baseId}.network.ipv4Gateway`, "IPv4 gateway", "", "text");
    await this.ensureStateObject(`${baseId}.network.ipv4DnsServer`, "IPv4 DNS server", "", "text");
    await this.ensureStateObject(`${baseId}.network.ipv6Address`, "IPv6 address", "", "text");

    await this.setObjectNotExistsAsync(`${baseId}.services`, {
      type: "channel",
      common: { name: "Services" },
      native: {},
    });
    await this.ensureStateObject(`${baseId}.services.json`, "Raw service versions", "", "json");

    await this.setObjectNotExistsAsync(`${baseId}.registeredDevices`, {
      type: "channel",
      common: { name: "Registered apps/devices" },
      native: {},
    });
    await this.ensureStateObject(`${baseId}.registeredDevices.json`, "Raw registered apps/devices", "", "json");
    await this.ensureStateObject(`${baseId}.registeredDevices.count`, "Registered apps/devices count", 0, "value");
    await this.ensureStateObject(`${baseId}.registeredDevices.connectedCount`, "Connected registered apps/devices count", 0, "value");

    await this.setObjectNotExistsAsync(`${baseId}.expertCommands`, {
      type: "channel",
      common: { name: "Blocked expert commands" },
      native: {},
    });
    await this.ensureStateObject(`${baseId}.expertCommands.blockedList`, "Blocked dangerous commands", "", "json");
  }

  private async prepareCommandObjects(device: RunningDevice): Promise<void> {
    device.blockedCommands = [];

    for (const [uid, featureName] of Object.entries(device.profile.featureMapping.featuresByUid)) {
      if (!featureName.includes(".Command.")) {
        continue;
      }

      if (this.isDangerousCommand(featureName)) {
        device.blockedCommands.push(featureName);
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

    await this.setState(`${device.baseId}.expertCommands.blockedList`, JSON.stringify(device.blockedCommands), true);
  }

  private isDangerousCommand(featureName: string): boolean {
    return DANGEROUS_COMMAND_MARKERS.some(marker => featureName.includes(marker));
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
      void this.setState(`${device.baseId}.info.lastError`, error.message, true);
    }

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

    if (device.reconnectFailures === 1) {
      this.log.warn(`${device.profile.haId}: connection failed: ${message}`);
      return;
    }

    this.log.debug(`${device.profile.haId}: still offline, retrying: ${message}`);
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
      const message = error instanceof Error ? error.message : String(error);
      await this.setState(`${device.baseId}.info.lastError`, message, true);
    }

    await this.updateGlobalConnectionState();
  }

  private async touchLastSeen(device: RunningDevice): Promise<void> {
    await this.setState(`${device.baseId}.info.lastSeen`, new Date().toISOString(), true);
  }

  private async handleDeviceMessage(device: RunningDevice, message: HcMessage): Promise<void> {
    await this.touchLastSeen(device);
    await this.ensureStateObject(`${device.baseId}.info.lastMessage`, "Last raw Home Connect message", "", "json");
    await this.setState(`${device.baseId}.info.lastMessage`, JSON.stringify(message), true);

    if (message.resource === "/ci/info" || message.resource === "/iz/info") {
      await this.writeApplianceInfo(device, message.data);
    }

    if (message.resource === "/ni/info") {
      await this.writeNetworkInfo(device, message.data);
    }

    if (message.resource === "/ci/services") {
      await this.writeServiceInfo(device, message.data);
    }

    if (message.resource === "/ci/registeredDevices") {
      await this.writeRegisteredDevices(device, message.data);
    }

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

  private async writeApplianceInfo(device: RunningDevice, data: unknown): Promise<void> {
    const record = this.firstRecord(data);
    if (!record) {
      return;
    }

    await this.setState(`${device.baseId}.general.rawInfo`, JSON.stringify(record), true);
    await this.setTextState(`${device.baseId}.general.deviceID`, record.deviceID);
    await this.setTextState(`${device.baseId}.general.eNumber`, record.eNumber);
    await this.setTextState(`${device.baseId}.general.brand`, record.brand);
    await this.setTextState(`${device.baseId}.general.vib`, record.vib);
    await this.setTextState(`${device.baseId}.general.mac`, record.mac);
    await this.setTextState(`${device.baseId}.general.haVersion`, record.haVersion);
    await this.setTextState(`${device.baseId}.general.swVersion`, record.swVersion);
    await this.setTextState(`${device.baseId}.general.hwVersion`, record.hwVersion);
    await this.setTextState(`${device.baseId}.general.deviceType`, record.deviceType);
    await this.setTextState(`${device.baseId}.general.type`, record.deviceType ?? device.profile.type);
    await this.setTextState(`${device.baseId}.general.deviceInfo`, record.deviceInfo);
    await this.setTextState(`${device.baseId}.general.customerIndex`, record.customerIndex);
    await this.setTextState(`${device.baseId}.general.serialNumber`, record.serialNumber);
    await this.setTextState(`${device.baseId}.general.fdString`, record.fdString);
  }

  private async writeNetworkInfo(device: RunningDevice, data: unknown): Promise<void> {
    const record = this.firstRecord(data);
    if (!record) {
      return;
    }

    const ipv4 = this.recordValue(record.ipV4);
    const ipv6 = this.recordValue(record.ipV6);

    await this.setState(`${device.baseId}.network.json`, JSON.stringify(data), true);
    await this.setTextState(`${device.baseId}.network.type`, record.type);
    await this.setTextState(`${device.baseId}.network.ssid`, record.ssid);
    await this.setNumberState(`${device.baseId}.network.rssi`, record.rssi);
    await this.setTextState(`${device.baseId}.network.status`, record.status);
    await this.setBooleanState(`${device.baseId}.network.configured`, record.configured);
    await this.setBooleanState(`${device.baseId}.network.primary`, record.primary);
    await this.setTextState(`${device.baseId}.network.euiAddress`, record.euiAddress);
    await this.setTextState(`${device.baseId}.network.ipv4Address`, ipv4?.ipAddress);
    await this.setNumberState(`${device.baseId}.network.ipv4PrefixSize`, ipv4?.prefixSize);
    await this.setTextState(`${device.baseId}.network.ipv4Gateway`, ipv4?.gateway);
    await this.setTextState(`${device.baseId}.network.ipv4DnsServer`, ipv4?.dnsServer);
    await this.setTextState(`${device.baseId}.network.ipv6Address`, ipv6?.ipAddress);
  }

  private async writeServiceInfo(device: RunningDevice, data: unknown): Promise<void> {
    const services: Record<string, number> = {};
    for (const item of this.dataArray(data)) {
      const service = typeof item.service === "string" ? item.service : undefined;
      const version = Number(item.version);
      if (!service || !Number.isFinite(version)) {
        continue;
      }

      services[service] = version;
      const id = `${device.baseId}.services.${sanitizeObjectId(service)}`;
      await this.ensureStateObject(id, `Service ${service} version`, 0, "value");
      await this.setState(id, version, true);
    }

    await this.setState(`${device.baseId}.services.json`, JSON.stringify(services), true);
  }

  private async writeRegisteredDevices(device: RunningDevice, data: unknown): Promise<void> {
    const devices = this.dataArray(data);
    const connectedCount = devices.filter(item => item.connected === true).length;
    await this.setState(`${device.baseId}.registeredDevices.json`, JSON.stringify(devices), true);
    await this.setState(`${device.baseId}.registeredDevices.count`, devices.length, true);
    await this.setState(`${device.baseId}.registeredDevices.connectedCount`, connectedCount, true);
  }

  private firstRecord(data: unknown): Record<string, unknown> | undefined {
    return this.dataArray(data)[0];
  }

  private dataArray(data: unknown): Record<string, unknown>[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private async setTextState(id: string, value: unknown): Promise<void> {
    await this.setState(id, value === undefined || value === null ? "" : String(value), true);
  }

  private async setNumberState(id: string, value: unknown): Promise<void> {
    const numberValue = Number(value);
    await this.setState(id, Number.isFinite(numberValue) ? numberValue : 0, true);
  }

  private async setBooleanState(id: string, value: unknown): Promise<void> {
    await this.setState(id, value === true, true);
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
        if (device.reconnectTimer) {
          clearTimeout(device.reconnectTimer);
        }

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
