export type ConnectionType = "AES" | "TLS";

export interface ApplianceProfileJson {
  haId: string;
  type?: string;
  serialNumber?: string;
  brand?: string;
  vib?: string;
  mac?: string;
  featureMappingFileName?: string;
  deviceDescriptionFileName?: string;
  created?: string;
  connectionType?: ConnectionType | string;
  key?: string;
  iv?: string;
}

export interface ApplianceProfile {
  haId: string;
  type: string;
  serialNumber?: string;
  brand?: string;
  vib?: string;
  mac?: string;
  connectionType: ConnectionType | string;
  key: string;
  iv?: string;
  profileFile?: string;
  featureMapping: FeatureMapping;
}

export interface FeatureMapping {
  featuresByUid: Record<string, string>;
  enumTypeByUid: Record<string, string>;
  enumValuesByType: Record<string, Record<string, string>>;
  programOptionsByUid: Record<string, ProgramOptionDescription[]>;
}

export interface ProgramOptionDescription {
  refUID: string;
  access?: string;
  available?: boolean;
  default?: unknown;
}

export interface ConfiguredDevice {
  enabled?: boolean;
  haId?: string;
  host?: string;
  name?: string;
  type?: string;
  brand?: string;
  vib?: string;
  mac?: string;
  connectionType?: string;
  profileFile?: string;
  enablePowerReset?: boolean;
  enableWifiReconnect?: boolean;
  wifiReconnectWaitMinutes?: number;
  wifiReconnectUseMac?: boolean;
  powerMeasurementStateId?: string;
  powerSwitchFeedbackStateId?: string;
  powerResetThresholdWatts?: number;
  powerResetIdleMinutes?: number;
  powerResetFailureCount?: number;
}

export interface AdapterNativeConfig {
  profilePath?: string;
  appName?: string;
  appId?: string;
  reconnectInterval?: number;
  watchdogHeartbeatIdleMinutes?: number;
  debugRaw?: boolean;
  enableRawStates?: boolean;
  autoAddProfiles?: boolean;
  enableMdnsDiscovery?: boolean;
  mdnsDiscoveryTimeout?: number;
  autoUpdateDiscoveredHosts?: boolean;
  autoAddDiscoveredDevices?: boolean;
  devices?: ConfiguredDevice[];
}

export type HcAction = "GET" | "POST" | "PUT" | "RESPONSE" | "NOTIFY";

export interface HcMessage {
  sID?: number;
  msgID?: number;
  resource?: string;
  version?: number;
  action: HcAction;
  data?: unknown[] | Record<string, unknown> | null;
  code?: number;
}

export interface RoValue {
  uid?: number | string;
  value?: unknown;
  [key: string]: unknown;
}

export interface StateTarget {
  id: string;
  name: string;
  value: ioBroker.StateValue;
  rawValue: unknown;
  category: string;
  uid: string;
}
