import { runHomeConnectHandshake } from "./clientHandshake";
import { extractInitialMessageId, parseServiceVersions, serviceKeyForResource } from "./clientProtocol";
import { dumpMessage, parseMessage } from "./message";
import { PendingResponses } from "./pendingResponses";
import { describeResponseCode } from "./responseCodes";
import { createHomeConnectSocket } from "./socketFactory";
import { HomeConnectSocketLike } from "./socket";
import { ConnectionType, HcMessage } from "./types";

const INITIAL_READ_RETRIES = 1;

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

interface PartialMessageIdentity {
  msgID?: number;
  resource?: string;
}

export class HomeConnectClient {
  private readonly socket: HomeConnectSocketLike;
  private readonly appName: string;
  private readonly appId: string;
  private readonly log?: HomeConnectClientOptions["log"];
  private readonly messageHandler?: HomeConnectClientOptions["messageHandler"];
  private readonly closeHandler?: HomeConnectClientOptions["closeHandler"];
  private readonly pendingResponses = new PendingResponses();

  private serviceVersions: Record<string, number> = {};
  private sid?: number;
  private lastMsgId?: number;
  private connected = false;

  public constructor(options: HomeConnectClientOptions) {
    this.socket = createHomeConnectSocket(options);
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
    this.lastMsgId = extractInitialMessageId(initial);

    this.socket.on("message", payload => void this.handleRawMessage(payload));
    this.socket.on("error", error => this.handleSocketError(error));
    this.socket.on("close", (code, reason) => this.handleSocketClose(code, reason));

    await runHomeConnectHandshake({
      appName: this.appName,
      appId: this.appId,
      initial,
      getServiceVersions: () => this.serviceVersions,
      send: message => this.send(message),
      sendSync: (message, timeoutMs) => this.sendSync(message, timeoutMs),
      forwardMessage: message => this.forwardMessage(message),
      setServiceVersions: message => this.setServiceVersions(message),
      log: this.log,
    });

    this.connected = true;
  }

  public async close(): Promise<void> {
    this.connected = false;
    this.pendingResponses.rejectAll(new Error("Home Connect client closed"));
    await this.socket.close();
  }

  public async readInitialValues(): Promise<void> {
    const resources = ["/ro/allDescriptionChanges", "/ro/allMandatoryValues"];

    for (const resource of resources) {
      let lastError: unknown;

      for (let attempt = 0; attempt <= INITIAL_READ_RETRIES; attempt += 1) {
        try {
          const response = await this.sendSync({ resource, action: "GET" }, 20000);
          await this.forwardMessage(response);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < INITIAL_READ_RETRIES && isMalformedJsonError(error)) {
            this.log?.warn(`GET ${resource} returned malformed JSON, retrying once: ${String(error)}`);
            continue;
          }
          break;
        }
      }

      if (lastError !== undefined) {
        this.log?.warn(`GET ${resource} failed: ${String(lastError)}`);
      }
    }
  }

  public async writeValue(uid: number, value: unknown): Promise<HcMessage> {
    return this.sendSync({
      resource: "/ro/values",
      action: "POST",
      data: [{ uid, value }],
    }, 20000);
  }

  public async selectProgram(programUid: number, options: Array<{ uid: number; value: unknown }> = []): Promise<HcMessage> {
    return this.sendSync({
      resource: "/ro/selectedProgram",
      action: "POST",
      data: {
        program: programUid,
        options,
      },
    }, 20000);
  }

  public async startProgram(programUid: number, options: Array<{ uid: number; value: unknown }> = []): Promise<HcMessage> {
    return this.sendSync({
      resource: "/ro/activeProgram",
      action: "POST",
      data: {
        program: programUid,
        options,
      },
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
    const responsePromise = this.pendingResponses.create(prepared.msgID, prepared.resource, timeoutMs);
    responsePromise.catch(() => undefined);

    await this.socket.send(serialized);
    const response = await responsePromise;

    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`Home Connect response code ${response.code} (${describeResponseCode(response.code)}) for ${response.resource}`);
    }

    return response;
  }

  private prepareMessage(message: HcMessage): HcMessage {
    return {
      ...message,
      sID: message.sID ?? this.sid,
      msgID: message.msgID ?? this.nextMsgId(),
      version: message.version ?? this.serviceVersions[serviceKeyForResource(message.resource)] ?? 1,
    };
  }

  private nextMsgId(): number {
    if (this.lastMsgId === undefined) {
      this.lastMsgId = 1;
    }

    const current = this.lastMsgId;
    this.lastMsgId += 1;
    return current;
  }

  private setServiceVersions(message: HcMessage): void {
    this.serviceVersions = parseServiceVersions(message);
    this.log?.debug(`HC services: ${JSON.stringify(this.serviceVersions)}`);
  }

  private async handleRawMessage(payload: string): Promise<void> {
    this.log?.debug(`HC RECV ${payload}`);

    let message: HcMessage;
    try {
      message = parseMessage(payload);
    } catch (error) {
      const identity = extractPartialMessageIdentity(payload);
      const parseError = new Error(`Malformed Home Connect JSON${identity.resource ? ` for ${identity.resource}` : ""}: ${String(error)}`);

      this.log?.warn(parseError.message);
      if (identity.msgID !== undefined && this.pendingResponses.reject(identity.msgID, parseError)) {
        return;
      }

      return;
    }

    if (message.action === "RESPONSE" && this.pendingResponses.resolve(message)) {
      return;
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
    this.pendingResponses.rejectAll(new Error(`Socket closed: ${code} ${reason}`));
    this.closeHandler?.();
  }
}

function extractPartialMessageIdentity(payload: string): PartialMessageIdentity {
  const msgIdMatch = payload.match(/"msgID"\s*:\s*(\d+)/);
  const resourceMatch = payload.match(/"resource"\s*:\s*"([^"]+)"/);
  const msgID = msgIdMatch ? Number(msgIdMatch[1]) : undefined;

  return {
    msgID: Number.isFinite(msgID) ? msgID : undefined,
    resource: resourceMatch?.[1],
  };
}

function isMalformedJsonError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Malformed Home Connect JSON");
}
