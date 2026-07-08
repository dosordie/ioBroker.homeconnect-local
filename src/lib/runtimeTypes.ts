import { HomeConnectClient } from "./client";
import { StateMapper } from "./stateMapper";
import { ApplianceProfile, ConfiguredDevice } from "./types";

export interface RunningDevice {
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
  stateValuesByFeature: Map<string, ioBroker.StateValue>;
}

export type WritableStateKind = "value" | "command" | "startProgram" | "startProgramWithOptions" | "startProgramName";

export interface WritableState {
  deviceHaId: string;
  uid: number;
  featureName: string;
  kind: WritableStateKind;
  stateId: string;
}
