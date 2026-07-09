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
