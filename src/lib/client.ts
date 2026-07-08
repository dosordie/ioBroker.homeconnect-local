import crypto from "node:crypto";

import { HomeConnectAesSocket } from "./aesSocket";
import { dumpMessage, parseMessage, responseFor } from "./message";
import { HomeConnectSocketLike } from "./socket";
import { HomeConnectTlsSocket } from "./tlsSocket";
import { ConnectionType, HcMessage } from "./types";

export interface HomeConnectClientOptions {
  host: string;
  connectionType: ConnectionType | string;
  key: string;
  iv?: string;
  appName: string;
  appId: string;
  log?: Pick<ioBroker.Logger, "debug" | "info" | "warn" | "error">;
  messageHandler?: (message: HcMessage) => Promise<void> | void;
  closeHandler?: (error?: Error) => void;
}

interface PendingResponse {
  resolve: (message: HcMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class HomeConnectClient {
  private readonly socket: HomeConnectSocketLike;
  private readonly appName: string;
  private readonly appId: string;
  private readonly log?: HomeConnectClientOptions["log"];
  private readonly messageHandler?: HomeConnectClientOptions["messageHandler"];
  private readonly closeHandler?: HomeConnectClientOptions["closeHandler"];

  private serviceVersions: Record<string, number> = {};
  private sid?: number;
  private lastMsgId?: number;
  private readonly pendingResponses = new Map<number, PendingResponse>();
  private connected = false;

  public constructor(options: HomeConnectClientOptions) {
    if (options.connectionType === "TLS") {
      this.socket = new HomeConnectTlsSocket(options.host, options.key);
    } else {
      if (!options.iv) {
        throw new Error("AES connection requires an IV from the appliance profile");
      }
      this.socket = new HomeConnectAesSocket(options.host, options.key, options.iv);
    }

    this.appName = options.appName;
    this.appId = options.appId;
    this.log = options.log;
    this.messageHandler = options.messageHandler;
    this.closeHandler = options.closeHandler;
  }

  public async connect(): Promise<void> {
    await this.socket.connect();

    const initialRaw = await this.socket.nextMessage();
    const initial = parseMessage(initialRaw);

    if (initial.resource !== "/ei/initialValues") {
      throw new Error(`First message was ${initial.resource}, expected /ei/initialValues`);
    }

    this.sid = initial.sID;
    this.lastMsgId = this.extractInitialMessageId(initial);

    this.socket.on("message", payload => void this.handleRawMessage(payload));
    this.socket.on("error", error => this.handleSocketError(error));
    this.socket.on("close", (code, reason) => this.handleSocketClose(code, reason));

    await this.send(responseFor(initial, {
      deviceType: initial.version === 1 ? 2 : "Application",
      deviceName: this.appName,
      deviceID: this.appId,
    }));

    const services = await this.sendSync({ resource: "/ci/services", version: 1, action: "GET" });
    this.setServiceVersions(services);
    await this.forwardMessage(services);

    if ((this.serviceVersions.ci ?? 1) < 3) {
      const nonce = crypto.randomBytes(32).toString("base64url");
      await this.sendSync({ resource: "/ci/authentication", action: "GET", data: { nonce } });

      try {
        const ciInfo = await this.sendSync({ resource: "/ci/info", action: "GET" });
        await this.forwardMessage(ciInfo);
      } catch (error) {
        this.log?.debug(`Optional /ci/info failed: ${String(error)}`);
      }
    }

    if (this.serviceVersions.iz !== undefined) {
      const izInfo = await this.sendSync({ resource: "/iz/info", action: "GET" });
      await this.forwardMessage(izInfo);
    }

    if ((this.serviceVersions.ei ?? 1) === 2) {
      await this.send({ resource: "/ei/deviceReady", action: "NOTIFY" });
    }

    if (this.serviceVersions.ni !== undefined) {
      const niInfo = await this.sendSync({ resource: "/ni/info", action: "GET" });
      await this.forwardMessage(niInfo);
    }

    this.connected = true;
  }

  public async close(): Promise<void> {
    this.connected = false;
    this.rejectPending(new Error("Home Connect client closed"));
    await this.socket.close();
  }

  public async readInitialValues(): Promise<void> {
    const resources = ["/ro/allDescriptionChanges", "/ro/allMandatoryValues"];

    for (const resource of resources) {
      try {
        const response = await this.sendSync({ resource, action: "GET" }, 20000);
        await this.forwardMessage(response);
      } catch (error) {
        this.log?.warn(`GET ${resource} failed: ${String(error)}`);
      }
    }
  }

  public async writeValue(uid: number, value: unknown): Promise<HcMessage> {
    return this.sendSync({
      resource: "/ro/values",
      action: "PUT",
      data: [{ uid, value }],
    }, 20000);
  }

  public async send(message: HcMessage): Promise<void> {
    const prepared = this.prepareMessage(message);
    const serialized = dumpMessage(prepared);
    this.log?.debug(`HC SEND ${serialized}`);
    await this.socket.send(serialized);
  }

  public async sendSync(message: HcMessage, timeoutMs = 15000): Promise<HcMessage> {
    const prepared = this.prepareMessage(message);
    if (prepared.msgID === undefined) {
      throw new Error("Message ID missing after prepareMessage");
    }

    const serialized = dumpMessage(prepared);
    this.log?.debug(`HC SEND ${serialized}`);

    const responsePromise = new Promise<HcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(prepared.msgID as number);
        reject(new Error(`Timeout waiting for response to ${prepared.resource}`));
      }, timeoutMs);

      this.pendingResponses.set(prepared.msgID as number, { resolve, reject, timeout });
    });

    await this.socket.send(serialized);
    const response = await responsePromise;

    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`Home Connect response code ${response.code} for ${response.resource}`);
    }

    return response;
  }

  private prepareMessage(message: HcMessage): HcMessage {
    const resource = message.resource ?? "";
    const service = resource.startsWith("/") ? resource.slice(1, 3) : resource.slice(0, 2);

    const prepared: HcMessage = {
      ...message,
      sID: message.sID ?? this.sid,
      msgID: message.msgID ?? this.nextMsgId(),
      version: message.version ?? this.serviceVersions[service] ?? 1,
    };

    return prepared;
  }

  private nextMsgId(): number {
    if (this.lastMsgId === undefined) {
      this.lastMsgId = 1;
    }

    const current = this.lastMsgId;
    this.lastMsgId += 1;
    return current;
  }

  private extractInitialMessageId(message: HcMessage): number {
    const firstData = Array.isArray(message.data) ? message.data[0] : undefined;
    if (firstData && typeof firstData === "object" && "edMsgID" in firstData) {
      const edMsgId = Number((firstData as Record<string, unknown>).edMsgID);
      if (Number.isFinite(edMsgId)) {
        return edMsgId;
      }
    }

    return (message.msgID ?? 0) + 1;
  }

  private setServiceVersions(message: HcMessage): void {
    const data = Array.isArray(message.data) ? message.data : [];
    const versions: Record<string, number> = {};

    for (const item of data) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const service = String(record.service ?? "");
      const version = Number(record.version ?? 1);
      if (service) {
        versions[service] = version;
      }
    }

    this.serviceVersions = versions;
    this.log?.debug(`HC services: ${JSON.stringify(this.serviceVersions)}`);
  }

  private async handleRawMessage(payload: string): Promise<void> {
    this.log?.debug(`HC RECV ${payload}`);

    let message: HcMessage;
    try {
      message = parseMessage(payload);
    } catch (error) {
      this.log?.warn(`Unable to parse Home Connect message: ${String(error)}`);
      return;
    }

    if (message.action === "RESPONSE" && message.msgID !== undefined) {
      const pending = this.pendingResponses.get(message.msgID);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingResponses.delete(message.msgID);
        pending.resolve(message);
        return;
      }
    }

    await this.forwardMessage(message);
  }

  private async forwardMessage(message: HcMessage): Promise<void> {
    if (!this.messageHandler) {
      return;
    }

    try {
      await this.messageHandler(message);
    } catch (error) {
      this.log?.error(`Message handler failed: ${String(error)}`);
    }
  }

  private handleSocketError(error: Error): void {
    this.log?.warn(`Home Connect socket error: ${error.message}`);
    if (this.connected) {
      this.closeHandler?.(error);
    }
  }

  private handleSocketClose(code: number, reason: string): void {
    this.log?.warn(`Home Connect socket closed: ${code} ${reason}`);
    this.connected = false;
    this.rejectPending(new Error(`Socket closed: ${code} ${reason}`));
    this.closeHandler?.();
  }

  private rejectPending(error: Error): void {
    for (const [msgId, pending] of this.pendingResponses.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingResponses.delete(msgId);
    }
  }
}
