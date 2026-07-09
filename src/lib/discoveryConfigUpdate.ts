import { DiscoveryProfileMatch } from "./mdnsDiscovery";
import { ConfiguredDevice } from "./types";

export interface DiscoveryHostUpdate {
  haId: string;
  oldHost: string;
  newHost: string;
  match: "haId" | "mac";
}

export interface DiscoveryHostUpdateResult {
  devices: ConfiguredDevice[];
  updates: DiscoveryHostUpdate[];
  skippedWithoutConfiguredDevice: DiscoveryProfileMatch[];
}

export interface DiscoveryDeviceAdded {
  haId: string;
  host: string;
  match: "haId" | "mac";
}

export interface DiscoveryDeviceEnabled {
  haId: string;
  oldEnabled: boolean | undefined;
  newEnabled: true;
  host: string;
  match: "haId" | "mac";
}

export interface DiscoveryDeviceAutoAddResult {
  devices: ConfiguredDevice[];
  added: DiscoveryDeviceAdded[];
  enabled: DiscoveryDeviceEnabled[];
  changed: boolean;
}

export function updateConfiguredDeviceHostsFromDiscovery(devices: ConfiguredDevice[] = [], matches: DiscoveryProfileMatch[]): DiscoveryHostUpdateResult {
  const devicesByHaId = new Map(devices.filter(device => device.haId).map(device => [device.haId as string, { ...device }]));
  const updates: DiscoveryHostUpdate[] = [];
  const skippedWithoutConfiguredDevice: DiscoveryProfileMatch[] = [];

  for (const match of matches) {
    if (match.match !== "haId" && match.match !== "mac") continue;
    const discoveredHost = match.discovery.address || match.discovery.host;
    if (!discoveredHost) continue;

    const haId = match.profile.haId;
    const device = devicesByHaId.get(haId);
    if (!device) {
      skippedWithoutConfiguredDevice.push(match);
      continue;
    }

    if (device.host === discoveredHost) continue;
    const oldHost = String(device.host ?? "");
    device.host = discoveredHost;
    devicesByHaId.set(haId, device);
    updates.push({ haId, oldHost, newHost: discoveredHost, match: match.match });
  }

  return {
    devices: devices.map(device => (device.haId && devicesByHaId.has(device.haId) ? devicesByHaId.get(device.haId)! : device)),
    updates,
    skippedWithoutConfiguredDevice,
  };
}

export function addOrEnableConfiguredDevicesFromDiscovery(devices: ConfiguredDevice[] = [], matches: DiscoveryProfileMatch[]): DiscoveryDeviceAutoAddResult {
  const devicesByHaId = new Map(devices.filter(device => device.haId).map(device => [device.haId as string, { ...device }]));
  const added: DiscoveryDeviceAdded[] = [];
  const enabled: DiscoveryDeviceEnabled[] = [];
  let changed = false;

  for (const match of matches) {
    if (match.match !== "haId" && match.match !== "mac") continue;
    const discoveredHost = match.discovery.address || match.discovery.host;
    if (!discoveredHost) continue;

    const metadata = profileMatchToDeviceConfig(match, discoveredHost, true);
    const existing = devicesByHaId.get(match.profile.haId);
    if (!existing) {
      devicesByHaId.set(match.profile.haId, metadata);
      changed = true;
      added.push({ haId: match.profile.haId, host: discoveredHost, match: match.match });
      continue;
    }

    const oldEnabled = existing.enabled;
    const enriched: ConfiguredDevice = {
      ...existing,
      enabled: true,
      host: discoveredHost,
      name: existing.name || metadata.name,
      type: existing.type || metadata.type,
      brand: existing.brand || metadata.brand,
      vib: existing.vib || metadata.vib,
      mac: existing.mac || metadata.mac,
      connectionType: existing.connectionType || metadata.connectionType,
      profileFile: existing.profileFile || metadata.profileFile,
    };
    if (JSON.stringify(enriched) !== JSON.stringify(existing)) changed = true;
    devicesByHaId.set(match.profile.haId, enriched);
    if (oldEnabled !== true) enabled.push({ haId: match.profile.haId, oldEnabled, newEnabled: true, host: discoveredHost, match: match.match });
  }

  const seen = new Set<string>();
  const merged: ConfiguredDevice[] = [];
  for (const device of devices) {
    if (device.haId && devicesByHaId.has(device.haId)) {
      merged.push(devicesByHaId.get(device.haId)!);
      seen.add(device.haId);
    } else {
      merged.push(device);
    }
  }
  for (const [haId, device] of devicesByHaId) {
    if (!seen.has(haId)) merged.push(device);
  }

  return { devices: merged, added, enabled, changed };
}

function profileMatchToDeviceConfig(match: DiscoveryProfileMatch, host: string, enabled: boolean): ConfiguredDevice {
  return {
    enabled,
    haId: match.profile.haId,
    host,
    name: profileDisplayName(match.profile),
    type: match.profile.type,
    brand: match.profile.brand,
    vib: match.profile.vib,
    mac: match.profile.mac,
    connectionType: match.profile.connectionType,
    profileFile: match.profile.profileFile,
  };
}

function profileDisplayName(profile: DiscoveryProfileMatch["profile"]): string {
  const parts = [profile.brand, profile.vib, profile.type].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : profile.haId;
}
