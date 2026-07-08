import * as utils from "@iobroker/adapter-core";

import { HomeConnectClient } from "./lib/client";
import { sanitizeObjectId } from "./lib/ids";
import { loadProfiles } from "./lib/profile";
import { StateMapper } from "./lib/stateMapper";
import { AdapterNativeConfig, ApplianceProfile, ConfiguredDevice, HcMessage, RoValue } from "./lib/types";

const POWER_STATE_UID = "021B";
const POWER_STATE_UID_NUMBER = 0x021b;
const POWER_STATE_OFF = 1;
const POWER_STATE_ON = 2;

interface RunningDevice {
  baseId: string;
  config: ConfiguredDevice;
  profile: ApplianceProfile;
  mapper: StateMapper;
  client?: HomeConnectClient;
  reconnectTimer?: NodeJS.Timeout;
  reconnecting: boolean;
}

class HomeconnectLocalAdapter extends utils.Adapter {
  private devices = new Map<string, RunningDevice>();
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
    await this.subscribeStatesAsync("*.settings.PowerState");

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

    for (const channel of ["status", "program", "phases", "options", "settings", "events", "programs", "raw"]) {
      await this.setObjectNotExistsAsync(`${baseId}.${channel}`, {
        type: "channel",
        common: { name: channel },
        native: {},
      });
    }

    await this.ensureStateObject(`${baseId}.settings.PowerState`, "BSH.Common.Setting.PowerState", false, "switch", true);
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
    const match = relativeId.match(/^(.+)\.settings\.PowerState$/);
    if (!match) {
      return;
    }

    const baseId = match[1];
    const device = Array.from(this.devices.values()).find(item => item.baseId === baseId);
    if (!device?.client) {
      this.log.warn(`${baseId}: cannot write PowerState, device is not connected`);
      return;
    }

    const powerOn = this.stateValueToPowerBoolean(state.val);
    const value = powerOn ? POWER_STATE_ON : POWER_STATE_OFF;

    try {
      this.log.info(`${device.profile.haId}: writing PowerState ${powerOn ? "On" : "Off"} (${value})`);
      await device.client.writeValue(POWER_STATE_UID_NUMBER, value);
      await this.setState(`${device.baseId}.settings.PowerState`, powerOn, true);
    } catch (error) {
      this.log.warn(`${device.profile.haId}: writing PowerState failed: ${String(error)}`);
    }
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

    if (message.resource?.startsWith("/ro/")) {
      if (this.currentConfig.debugRaw) {
        this.log.debug(`${device.profile.haId}: ${message.resource} ${JSON.stringify(message.data)}`);
      }

      const values = device.mapper.valuesFromMessageData(message.data);
      for (const value of values) {
        await this.writeRoValue(device, value);
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
    const isWritable = target.uid === POWER_STATE_UID;
    const role = target.uid === POWER_STATE_UID ? "switch" : undefined;
    const rawValue = JSON.stringify(value);

    await this.ensureStateObject(stateId, target.name, normalizedValue, role, isWritable);
    await this.setState(stateId, normalizedValue, true);

    if (this.currentConfig.debugRaw) {
      await this.ensureStateObject(rawStateId, `Raw ${target.uid} ${target.name}`, "", "json");
      await this.setState(rawStateId, rawValue, true);
    }
  }

  private normalizeTargetValue(target: { uid: string; value: unknown; rawValue: unknown }): ioBroker.StateValue {
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
