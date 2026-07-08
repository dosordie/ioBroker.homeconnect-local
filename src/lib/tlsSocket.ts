import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { base64UrlDecode, formatHost } from "./socket";

export interface TlsSocketEvents {
  message: [payload: string];
  close: [code: number, reason: string];
  error: [error: Error];
}

export declare interface HomeConnectTlsSocket {
  on<K extends keyof TlsSocketEvents>(event: K, listener: (...args: TlsSocketEvents[K]) => void): this;
  once<K extends keyof TlsSocketEvents>(event: K, listener: (...args: TlsSocketEvents[K]) => void): this;
  off<K extends keyof TlsSocketEvents>(event: K, listener: (...args: TlsSocketEvents[K]) => void): this;
  emit<K extends keyof TlsSocketEvents>(event: K, ...args: TlsSocketEvents[K]): boolean;
}

export class HomeConnectTlsSocket extends EventEmitter {
  private readonly url: string;
  private readonly psk: Buffer;
  private ws?: WebSocket;

  public constructor(host: string, psk64: string) {
    super();
    this.url = `wss://${formatHost(host)}:443/homeconnect`;
    this.psk = base64UrlDecode(psk64);
  }

  public get closed(): boolean {
    return !this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
  }

  public async connect(timeoutMs = 15000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        perMessageDeflate: false,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        ciphers: "PSK:@SECLEVEL=0",
        checkServerIdentity: () => undefined,
        pskCallback: () => ({
          identity: "iobroker-homeconnect-local",
          psk: this.psk,
        }),
      } as WebSocket.ClientOptions);

      this.ws = ws;

      const timeout = setTimeout(() => {
        cleanup();
        ws.close();
        reject(new Error(`Timeout while connecting to ${this.url}`));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        ws.off("open", onOpen);
        ws.off("error", onError);
      };

      const onOpen = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.on("message", data => this.emit("message", rawDataToString(data)));
      ws.on("close", (code, reason) => this.emit("close", code, reason.toString("utf8")));
      ws.on("error", error => this.emit("error", error));
    });
  }

  public async close(): Promise<void> {
    const current = this.ws;
    if (!current || current.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>(resolve => {
      current.once("close", () => resolve());
      current.close();
      setTimeout(() => resolve(), 2000).unref();
    });
  }

  public async send(clearText: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      this.ws?.send(clearText, error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  public nextMessage(timeoutMs = 15000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout while waiting for Home Connect message"));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        this.off("message", onMessage);
        this.off("error", onError);
        this.off("close", onClose);
      };

      const onMessage = (payload: string): void => {
        cleanup();
        resolve(payload);
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const onClose = (code: number, reason: string): void => {
        cleanup();
        reject(new Error(`Socket closed while waiting for message: ${code} ${reason}`));
      };

      this.once("message", onMessage);
      this.once("error", onError);
      this.once("close", onClose);
    });
  }
}

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}
