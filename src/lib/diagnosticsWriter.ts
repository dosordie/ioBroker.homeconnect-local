import { dataArray, firstRecord, recordValue } from "./dataHelpers";
import { sanitizeObjectId } from "./ids";
import { ensureStateObject, setBooleanState, setNumberState, setTextState } from "./objectHelpers";
import { RunningDevice } from "./runtimeTypes";

export async function ensureDiagnosticStates(adapter: ioBroker.Adapter, device: RunningDevice): Promise<void> {
  const baseId = device.baseId;
  for (const [id, type] of Object.entries({
    "network.json": "json", "network.type": "text", "network.ssid": "text", "network.status": "text", "network.euiAddress": "text", "network.ipv4Address": "text", "network.ipv4Gateway": "text", "network.ipv4DnsServer": "text", "network.ipv6Address": "text",
  })) await ensureStateObject(adapter, `${baseId}.${id}`, id, "", type);
  await ensureStateObject(adapter, `${baseId}.network.rssi`, "RSSI", 0, "value");
  await ensureStateObject(adapter, `${baseId}.network.configured`, "Configured", false, "indicator");
  await ensureStateObject(adapter, `${baseId}.network.primary`, "Primary interface", false, "indicator");
  await ensureStateObject(adapter, `${baseId}.network.ipv4PrefixSize`, "IPv4 prefix size", 0, "value");
  await ensureStateObject(adapter, `${baseId}.services.json`, "Raw service versions", "", "json");
  await ensureStateObject(adapter, `${baseId}.registeredDevices.json`, "Raw registered apps/devices", "", "json");
  await ensureStateObject(adapter, `${baseId}.registeredDevices.count`, "Registered apps/devices count", 0, "value");
  await ensureStateObject(adapter, `${baseId}.registeredDevices.connectedCount`, "Connected registered apps/devices count", 0, "value");
  await ensureStateObject(adapter, `${baseId}.expertCommands.blockedList`, "Blocked dangerous commands", "", "json");
}

export async function writeApplianceInfo(adapter: ioBroker.Adapter, device: RunningDevice, data: unknown): Promise<void> {
  const record = firstRecord(data);
  if (!record) return;
  await adapter.setState(`${device.baseId}.general.rawInfo`, JSON.stringify(record), true);
  for (const id of ["deviceID", "eNumber", "brand", "vib", "mac", "haVersion", "swVersion", "hwVersion", "deviceType", "deviceInfo", "customerIndex", "serialNumber", "fdString"]) {
    await setTextState(adapter, `${device.baseId}.general.${id}`, record[id]);
  }
  await setTextState(adapter, `${device.baseId}.general.type`, record.deviceType ?? device.profile.type);
}

export async function writeNetworkInfo(adapter: ioBroker.Adapter, device: RunningDevice, data: unknown): Promise<void> {
  const record = firstRecord(data);
  if (!record) return;
  const ipv4 = recordValue(record.ipV4);
  const ipv6 = recordValue(record.ipV6);
  await adapter.setState(`${device.baseId}.network.json`, JSON.stringify(data), true);
  await setTextState(adapter, `${device.baseId}.network.type`, record.type);
  await setTextState(adapter, `${device.baseId}.network.ssid`, record.ssid);
  await setNumberState(adapter, `${device.baseId}.network.rssi`, record.rssi);
  await setTextState(adapter, `${device.baseId}.network.status`, record.status);
  await setBooleanState(adapter, `${device.baseId}.network.configured`, record.configured);
  await setBooleanState(adapter, `${device.baseId}.network.primary`, record.primary);
  await setTextState(adapter, `${device.baseId}.network.euiAddress`, record.euiAddress);
  await setTextState(adapter, `${device.baseId}.network.ipv4Address`, ipv4?.ipAddress);
  await setNumberState(adapter, `${device.baseId}.network.ipv4PrefixSize`, ipv4?.prefixSize);
  await setTextState(adapter, `${device.baseId}.network.ipv4Gateway`, ipv4?.gateway);
  await setTextState(adapter, `${device.baseId}.network.ipv4DnsServer`, ipv4?.dnsServer);
  await setTextState(adapter, `${device.baseId}.network.ipv6Address`, ipv6?.ipAddress);
}

export async function writeServiceInfo(adapter: ioBroker.Adapter, device: RunningDevice, data: unknown): Promise<void> {
  const services: Record<string, number> = {};
  for (const item of dataArray(data)) {
    const service = typeof item.service === "string" ? item.service : undefined;
    const version = Number(item.version);
    if (!service || !Number.isFinite(version)) continue;
    services[service] = version;
    const id = `${device.baseId}.services.${sanitizeObjectId(service)}`;
    await ensureStateObject(adapter, id, `Service ${service} version`, 0, "value");
    await adapter.setState(id, version, true);
  }
  await adapter.setState(`${device.baseId}.services.json`, JSON.stringify(services), true);
}

export async function writeRegisteredDevices(adapter: ioBroker.Adapter, device: RunningDevice, data: unknown): Promise<void> {
  const devices = dataArray(data);
  await adapter.setState(`${device.baseId}.registeredDevices.json`, JSON.stringify(devices), true);
  await adapter.setState(`${device.baseId}.registeredDevices.count`, devices.length, true);
  await adapter.setState(`${device.baseId}.registeredDevices.connectedCount`, devices.filter(item => item.connected === true).length, true);
}
