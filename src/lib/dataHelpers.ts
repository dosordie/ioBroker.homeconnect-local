export function dataArray(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

export function firstRecord(data: unknown): Record<string, unknown> | undefined {
  return dataArray(data)[0];
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
