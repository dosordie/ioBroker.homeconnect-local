import { ApplianceProfile } from "./types";

export interface DiscoveredHomeConnectDevice {
  id?: string;
  name?: string;
  host?: string;
  address?: string;
  port?: number;
  brand?: string;
  type?: string;
  vib?: string;
  mac?: string;
  rawTxt?: Record<string, string>;
}

export interface HomeConnectDiscoveryOptions {
  timeoutSeconds?: number;
}

export interface DiscoveryProfileMatch {
  discovery: DiscoveredHomeConnectDevice;
  profile: {
    haId: string;
    brand?: string;
    type?: string;
    vib?: string;
    mac?: string;
    connectionType: string;
    profileFile?: string;
  };
  match: "haId" | "mac" | "brandTypeVib";
}

type DiscoveryCallback = (device: DiscoveredHomeConnectDevice) => void;
type MdnsInstance = {
  on(event: "response", handler: (response: MdnsResponse) => void): void;
  query(query: unknown): void;
  destroy(callback?: () => void): void;
};

type MdnsRecord = {
  name?: string;
  type?: string;
  data?: unknown;
};

type MdnsResponse = {
  answers?: MdnsRecord[];
  additionals?: MdnsRecord[];
  authorities?: MdnsRecord[];
};

const HOME_CONNECT_SERVICE = "_homeconnect._tcp.local";
let activeMdns: MdnsInstance | undefined;
let activeTimer: NodeJS.Timeout | undefined;

export function startHomeConnectDiscovery(adapter: ioBroker.Adapter, options: HomeConnectDiscoveryOptions, callback: DiscoveryCallback): void {
  stopHomeConnectDiscovery();

  // multicast-dns is pure JavaScript and avoids native build dependencies in ioBroker installations.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const createMdns = require("multicast-dns") as () => MdnsInstance;
  const mdns = createMdns();
  activeMdns = mdns;

  mdns.on("response", response => {
    for (const device of devicesFromResponse(response)) {
      callback(device);
    }
  });

  mdns.query({ questions: [{ name: HOME_CONNECT_SERVICE, type: "PTR" }] });

  const timeoutMs = Math.max(1, Number(options.timeoutSeconds ?? 10)) * 1000;
  activeTimer = setTimeout(() => stopHomeConnectDiscovery(), timeoutMs);
  adapter.log.debug(`mDNS discovery started for ${HOME_CONNECT_SERVICE} (${timeoutMs / 1000}s)`);
}

export function stopHomeConnectDiscovery(): void {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = undefined;
  }
  const mdns = activeMdns;
  activeMdns = undefined;
  if (mdns) mdns.destroy();
}

export function normalizeMac(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const hex = String(value).trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex : undefined;
}

export function normalizeDnsName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().toLowerCase().replace(/\.$/, "");
  return text || undefined;
}

export function matchDiscoveredDeviceToProfile(discovery: DiscoveredHomeConnectDevice, profiles: ApplianceProfile[]): DiscoveryProfileMatch | undefined {
  if (discovery.id) {
    const profile = profiles.find(candidate => candidate.haId === discovery.id);
    if (profile) return toMatch(discovery, profile, "haId");
  }

  const discoveryMac = normalizeMac(discovery.mac);
  if (discoveryMac) {
    const profile = profiles.find(candidate => normalizeMac(candidate.mac) === discoveryMac);
    if (profile) return toMatch(discovery, profile, "mac");
  }

  const brand = normalizeKey(discovery.brand);
  const type = normalizeKey(discovery.type);
  const vib = normalizeKey(discovery.vib);
  if (brand && type && vib) {
    const matches = profiles.filter(profile => normalizeKey(profile.brand) === brand && normalizeKey(profile.type) === type && normalizeKey(profile.vib) === vib);
    if (matches.length === 1) return toMatch(discovery, matches[0], "brandTypeVib");
  }

  return undefined;
}

function toMatch(discovery: DiscoveredHomeConnectDevice, profile: ApplianceProfile, match: DiscoveryProfileMatch["match"]): DiscoveryProfileMatch {
  return {
    discovery,
    profile: {
      haId: profile.haId,
      brand: profile.brand,
      type: profile.type,
      vib: profile.vib,
      mac: profile.mac,
      connectionType: String(profile.connectionType),
      profileFile: profile.profileFile,
    },
    match,
  };
}

function normalizeKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().toLowerCase();
  return text || undefined;
}

export function devicesFromResponse(response: MdnsResponse): DiscoveredHomeConnectDevice[] {
  const records = [...(response.answers ?? []), ...(response.additionals ?? []), ...(response.authorities ?? [])];
  const homeConnectService = normalizeDnsName(HOME_CONNECT_SERVICE);
  const ptrNames = records
    .filter(record => record.type === "PTR" && normalizeDnsName(record.name) === homeConnectService && typeof record.data === "string")
    .map(record => normalizeDnsName(record.data))
    .filter((name): name is string => name !== undefined);
  const serviceNames = new Set<string>(ptrNames);
  for (const record of records) {
    const recordName = normalizeDnsName(record.name);
    if ((record.type === "SRV" || record.type === "TXT") && recordName?.endsWith(`.${homeConnectService}`)) serviceNames.add(recordName);
  }

  const result: DiscoveredHomeConnectDevice[] = [];
  for (const serviceName of serviceNames) {
    const srv = records.find(record => record.type === "SRV" && normalizeDnsName(record.name) === serviceName);
    const target = srv && isSrvData(srv.data) ? srv.data.target : undefined;
    const normalizedTarget = normalizeDnsName(target);
    const addressRecord = records.find(record => (record.type === "A" || record.type === "AAAA") && normalizeDnsName(record.name) === normalizedTarget && typeof record.data === "string");
    const txt = parseTxt(records.find(record => record.type === "TXT" && normalizeDnsName(record.name) === serviceName)?.data);
    result.push({
      id: txt.id,
      name: instanceName(serviceName),
      host: normalizeDnsName(target),
      address: addressRecord?.data ? String(addressRecord.data) : undefined,
      port: srv && isSrvData(srv.data) ? srv.data.port : undefined,
      brand: txt.brand,
      type: txt.type,
      vib: txt.vib,
      mac: txt.mac,
      rawTxt: txt,
    });
  }
  return result;
}

function isSrvData(data: unknown): data is { target?: string; port?: number } {
  return data !== null && typeof data === "object";
}

function parseTxt(data: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = Array.isArray(data) ? data : [];
  for (const entry of entries) {
    const text = Buffer.isBuffer(entry) ? entry.toString("utf8") : String(entry);
    const separator = text.indexOf("=");
    if (separator > 0) result[text.slice(0, separator)] = text.slice(separator + 1);
  }
  return result;
}

function instanceName(serviceName: string): string | undefined {
  const normalizedService = normalizeDnsName(serviceName);
  const homeConnectService = normalizeDnsName(HOME_CONNECT_SERVICE);
  return normalizedService?.endsWith(`.${homeConnectService}`) ? normalizedService.slice(0, -(String(homeConnectService).length + 1)) : normalizedService;
}
