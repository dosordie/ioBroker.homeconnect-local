export async function ensureChannel(adapter: ioBroker.Adapter, id: string, name: string): Promise<void> {
  await adapter.setObjectNotExistsAsync(id, { type: "channel", common: { name }, native: {} });
}

export async function ensureStateObject(adapter: ioBroker.Adapter, id: string, name: string, value: ioBroker.StateValue, role?: string, write = false): Promise<void> {
  const type = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
  const desiredRole = role ?? (type === "boolean" ? "indicator" : "value");
  const existing = await adapter.getObjectAsync(id);
  const common: ioBroker.StateCommon = { ...(existing?.common as ioBroker.StateCommon | undefined), name, type, role: desiredRole, read: true, write };
  if (!existing) {
    await adapter.setObjectNotExistsAsync(id, { type: "state", common, native: {} });
    return;
  }
  if (existing.type !== "state" || existing.common?.type !== type || existing.common?.role !== desiredRole || existing.common?.write !== write || existing.common?.name !== name) {
    await adapter.extendObjectAsync(id, { type: "state", common, native: existing.native ?? {} });
  }
}

export async function setTextState(adapter: ioBroker.Adapter, id: string, value: unknown): Promise<void> {
  await adapter.setState(id, value === undefined || value === null ? "" : String(value), true);
}

export async function setNumberState(adapter: ioBroker.Adapter, id: string, value: unknown): Promise<void> {
  const n = Number(value);
  await adapter.setState(id, Number.isFinite(n) ? n : 0, true);
}

export async function setBooleanState(adapter: ioBroker.Adapter, id: string, value: unknown): Promise<void> {
  await adapter.setState(id, value === true, true);
}
