import { EventEmitter } from "node:events";
import crypto from "node:crypto";

import WebSocket from "ws";

const ENCRYPT_DIRECTION = Buffer.from([0x45]); // E
const DECRYPT_DIRECTION = Buffer.from([0x43]); // C
const MINIMUM_MESSAGE_LENGTH = 32;

export interface AesSocketEvents {
  message: [payload: string];
  close: [code: number, reason: string];
  error: [error: Error];
}

export declare interface HomeConnectAesSocket {
  on<K extends keyof AesSocketEvents>(event: K, listener: (...args: AesSocketEvents[K]) => void): this;
  once<K extends keyof AesSocketEvents>(event: K, listener: (...args: AesSocketEvents[K]) => void): this;
  off<K extends keyof AesSocketEvents>(event: K, listener: (...args: AesSocketEvents[K]) => void): this;
  emit<K extends keyof AesSocketEvents>(event: K, ...args: AesSocketEvents[K]): boolean;
}

export class HomeConnectAesSocket extends EventEmitter {
  private readonly url: string;
  private readonly iv: Buffer;
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  private ws?: WebSocket;
  private cipher?: crypto.Cipher;
  private decipher?: crypto.Decipher;
  private lastRxHmac = Buffer.alloc(16);
  private lastTxHmac = Buffer.alloc(16);

  public constructor(host: string, psk64: string, iv64: string) {
    super();
    this.url = `ws://${formatHost(host)}:80/homeconnect`;

    const psk = base64UrlDecode(psk64);
    this.iv = base64UrlDecode(iv64);
    this.encKey = crypto.createHmac("sha256", psk).update("ENC").digest();
    this.macKey = crypto.createHmac("sha256", psk).update("MAC").digest();
  }

  public get closed(): boolean {
    return !this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
  }

  public async connect(timeoutMs = 15000): Promise<void> {
    this.resetCryptoState();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { perMessageDeflate: false });
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
      ws.on("message", data => this.handleIncoming(data));
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.cipher) {
      throw new Error("WebSocket is not connected");
    }

    const clearMessage = Buffer.from(clearText, "utf8");
    let padLen = 16 - (clearMessage.length % 16);
    if (padLen === 1) {
      padLen += 16;
    }

    const randomPadLength = padLen - 2;
    const padded = Buffer.concat([
      clearMessage,
      Buffer.from([0x00]),
      randomPadLength > 0 ? crypto.randomBytes(randomPadLength) : Buffer.alloc(0),
      Buffer.from([padLen]),
    ]);

    const encrypted = this.cipher.update(padded);
    const hmacPayload = Buffer.concat([this.iv, ENCRYPT_DIRECTION, this.lastTxHmac, encrypted]);
    this.lastTxHmac = crypto.createHmac("sha256", this.macKey).update(hmacPayload).digest().subarray(0, 16);

    await new Promise<void>((resolve, reject) => {
      this.ws?.send(Buffer.concat([encrypted, this.lastTxHmac]), error => {
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

  private resetCryptoState(): void {
    this.lastRxHmac = Buffer.alloc(16);
    this.lastTxHmac = Buffer.alloc(16);
    this.cipher = crypto.createCipheriv("aes-256-cbc", this.encKey, this.iv);
    this.cipher.setAutoPadding(false);
    this.decipher = crypto.createDecipheriv("aes-256-cbc", this.encKey, this.iv);
    this.decipher.setAutoPadding(false);
  }

  private handleIncoming(data: WebSocket.RawData): void {
    try {
      const payload = rawDataToBuffer(data);
      this.emit("message", this.decrypt(payload));
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  private decrypt(payload: Buffer): string {
    if (!this.decipher) {
      throw new Error("AES decryptor is not initialized");
    }

    if (payload.length < MINIMUM_MESSAGE_LENGTH) {
      throw new Error(`Message too short: ${payload.length} bytes`);
    }

    if (payload.length % 16 !== 0) {
      throw new Error(`Unaligned AES message: ${payload.length} bytes`);
    }

    const encrypted = payload.subarray(0, -16);
    const receivedHmac = payload.subarray(-16);
    const hmacPayload = Buffer.concat([this.iv, DECRYPT_DIRECTION, this.lastRxHmac, encrypted]);
    const expectedHmac = crypto.createHmac("sha256", this.macKey).update(hmacPayload).digest().subarray(0, 16);

    if (!crypto.timingSafeEqual(receivedHmac, expectedHmac)) {
      throw new Error("Home Connect AES HMAC validation failed");
    }

    this.lastRxHmac = Buffer.from(receivedHmac);

    const clear = this.decipher.update(encrypted);
    const padLen = clear[clear.length - 1];
    if (padLen <= 0 || padLen > clear.length) {
      throw new Error("Home Connect AES padding validation failed");
    }

    return clear.subarray(0, clear.length - padLen).toString("utf8");
  }
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
