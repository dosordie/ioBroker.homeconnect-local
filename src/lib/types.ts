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
}

export interface AdapterNativeConfig {
  profilePath?: string;
  appName?: string;
  appId?: string;
  reconnectInterval?: number;
  debugRaw?: boolean;
  autoAddProfiles?: boolean;
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
