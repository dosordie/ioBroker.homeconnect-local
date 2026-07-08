import { responseFor } from "./message";
import { HcMessage } from "./types";

export function appIdentityResponse(initial: HcMessage, appName: string, appId: string): HcMessage {
  return responseFor(initial, {
    deviceType: initial.version === 1 ? 2 : "Application",
    deviceName: appName,
    deviceID: appId,
  });
}

export function extractInitialMessageId(message: HcMessage): number {
  const firstData = Array.isArray(message.data) ? message.data[0] : undefined;
  if (firstData && typeof firstData === "object" && "edMsgID" in firstData) {
    const edMsgId = Number((firstData as Record<string, unknown>).edMsgID);
    if (Number.isFinite(edMsgId)) {
      return edMsgId;
    }
  }

  return (message.msgID ?? 0) + 1;
}

export function parseServiceVersions(message: HcMessage): Record<string, number> {
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

  return versions;
}

export function serviceKeyForResource(resource: string | undefined): string {
  const value = resource ?? "";
  return value.startsWith("/") ? value.slice(1, 3) : value.slice(0, 2);
}
