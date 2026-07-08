export interface HomeConnectSocketLike {
  readonly closed: boolean;
  connect(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  send(clearText: string): Promise<void>;
  nextMessage(timeoutMs?: number): Promise<string>;
  on(event: "message", listener: (payload: string) => void): this;
  on(event: "close", listener: (code: number, reason: string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "message", listener: (payload: string) => void): this;
  once(event: "close", listener: (code: number, reason: string) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "message", listener: (payload: string) => void): this;
  off(event: "close", listener: (code: number, reason: string) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

export function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
