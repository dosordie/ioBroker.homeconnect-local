import { HcMessage } from "./types";

export function parseMessage(payload: string): HcMessage {
  const parsed = JSON.parse(payload) as HcMessage;
  if (!parsed.action || !parsed.resource) {
    throw new Error(`Invalid Home Connect message: ${payload}`);
  }
  return parsed;
}

export function dumpMessage(message: HcMessage): string {
  const payload: Record<string, unknown> = {
    sID: message.sID,
    msgID: message.msgID,
    resource: message.resource,
    version: message.version,
    action: message.action,
  };

  if (message.data !== undefined && message.data !== null) {
    payload.data = Array.isArray(message.data) ? message.data : [message.data];
  }

  if (message.code !== undefined) {
    payload.code = message.code;
  }

  return JSON.stringify(payload);
}

export function responseFor(message: HcMessage, data?: Record<string, unknown>): HcMessage {
  return {
    sID: message.sID,
    msgID: message.msgID,
    resource: message.resource,
    version: message.version,
    action: "RESPONSE",
    data: data ? [data] : undefined,
  };
}
