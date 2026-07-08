import { HomeConnectAesSocket } from "./aesSocket";
import { HomeConnectSocketLike } from "./socket";
import { HomeConnectTlsSocket } from "./tlsSocket";
import { ConnectionType } from "./types";

export interface HomeConnectSocketOptions {
  host: string;
  connectionType: ConnectionType | string;
  key: string;
  iv?: string;
}

export function createHomeConnectSocket(options: HomeConnectSocketOptions): HomeConnectSocketLike {
  if (options.connectionType === "TLS") {
    return new HomeConnectTlsSocket(options.host, options.key);
  }

  if (!options.iv) {
    throw new Error("AES connection requires an IV from the appliance profile");
  }

  return new HomeConnectAesSocket(options.host, options.key, options.iv);
}
