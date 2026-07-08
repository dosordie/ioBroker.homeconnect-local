import { HcMessage } from "./types";

interface PendingResponse {
  resolve: (message: HcMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class PendingResponses {
  private readonly responses = new Map<number, PendingResponse>();

  public create(msgId: number, resource: string | undefined, timeoutMs: number): Promise<HcMessage> {
    return new Promise<HcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responses.delete(msgId);
        reject(new Error(`Timeout waiting for response to ${resource}`));
      }, timeoutMs);

      this.responses.set(msgId, { resolve, reject, timeout });
    });
  }

  public resolve(message: HcMessage): boolean {
    if (message.msgID === undefined) {
      return false;
    }

    const pending = this.responses.get(message.msgID);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.responses.delete(message.msgID);
    pending.resolve(message);
    return true;
  }

  public reject(msgId: number, error: Error): boolean {
    const pending = this.responses.get(msgId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.responses.delete(msgId);
    pending.reject(error);
    return true;
  }

  public rejectAll(error: Error): void {
    for (const [msgId, pending] of this.responses.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.responses.delete(msgId);
    }
  }
}
