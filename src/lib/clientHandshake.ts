import crypto from "node:crypto";

import { appIdentityResponse } from "./clientProtocol";
import { HcMessage } from "./types";

export interface HandshakeContext {
  appName: string;
  appId: string;
  initial: HcMessage;
  getServiceVersions: () => Record<string, number>;
  send: (message: HcMessage) => Promise<void>;
  sendSync: (message: HcMessage, timeoutMs?: number) => Promise<HcMessage>;
  forwardMessage: (message: HcMessage) => Promise<void>;
  setServiceVersions: (message: HcMessage) => void;
  log?: Pick<ioBroker.Logger, "debug">;
}

export async function runHomeConnectHandshake(context: HandshakeContext): Promise<void> {
  await context.send(appIdentityResponse(context.initial, context.appName, context.appId));

  const services = await context.sendSync({ resource: "/ci/services", version: 1, action: "GET" });
  context.setServiceVersions(services);
  await context.forwardMessage(services);

  const serviceVersions = context.getServiceVersions();

  if ((serviceVersions.ci ?? 1) < 3) {
    const nonce = crypto.randomBytes(32).toString("base64url");
    await context.sendSync({ resource: "/ci/authentication", action: "GET", data: { nonce } });

    try {
      const ciInfo = await context.sendSync({ resource: "/ci/info", action: "GET" });
      await context.forwardMessage(ciInfo);
    } catch (error) {
      context.log?.debug(`Optional /ci/info failed: ${String(error)}`);
    }
  }

  if (serviceVersions.iz !== undefined) {
    const izInfo = await context.sendSync({ resource: "/iz/info", action: "GET" });
    await context.forwardMessage(izInfo);
  }

  if ((serviceVersions.ei ?? 1) === 2) {
    await context.send({ resource: "/ei/deviceReady", action: "NOTIFY" });
  }

  if (serviceVersions.ni !== undefined) {
    const niInfo = await context.sendSync({ resource: "/ni/info", action: "GET" });
    await context.forwardMessage(niInfo);
  }
}
