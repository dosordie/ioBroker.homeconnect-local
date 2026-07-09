export async function ensureChannel(adapter: ioBroker.Adapter, id: string, name: string): Promise<void> {
  await adapter.setObjectNotExistsAsync(id, { type: "channel", common: { name }, native: {} });
}

export async function ensureStateObject(adapter: ioBroker.Adapter, id: string, name: string, value: ioBroker.StateValue, role?: string, write = false, metadata: Partial<ioBroker.StateCommon> = {}): Promise<void> {
  const valueType = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
  const type = write && valueType === "string" && hasNumericStateKeys(metadata.states) ? "mixed" : valueType;
  const desiredRole = role ?? (type === "boolean" ? "indicator" : "value");
  const sanitizedMetadata = sanitizeMetadataForType(metadata, type);
  const existing = await adapter.getObjectAsync(id);
  const existingCommon = sanitizeMetadataForType((existing?.common as ioBroker.StateCommon | undefined) ?? {}, type);
  const common: ioBroker.StateCommon = { ...existingCommon, name, type, role: desiredRole, read: true, write, ...sanitizedMetadata };
  if (!existing) {
    await adapter.setObjectNotExistsAsync(id, { type: "state", common, native: {} });
    return;
  }
  if (existing.type !== "state" || existing.common?.type !== type || existing.common?.role !== desiredRole || existing.common?.write !== write || existing.common?.name !== name || commonChanged(existing.common as ioBroker.StateCommon | undefined, common)) {
    await adapter.extendObjectAsync(id, { type: "state", common, native: existing.native ?? {} });
  }
}

export async function ensureButtonStateObject(adapter: ioBroker.Adapter, id: string, name: string): Promise<void> {
  const common = {
    name,
    type: "boolean",
    role: "button",
    read: false,
    write: true,
    def: false,
    states: undefined,
    min: undefined,
    max: undefined,
    step: undefined,
  } as ioBroker.StateCommon;
  const existing = await adapter.getObjectAsync(id);
  if (!existing) {
    await adapter.setObjectNotExistsAsync(id, { type: "state", common, native: {} });
    return;
  }
  if (existing.type !== "state" || commonChanged(existing.common as ioBroker.StateCommon | undefined, common)) {
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

function sanitizeMetadataForType(metadata: Partial<ioBroker.StateCommon>, type: ioBroker.CommonType): Partial<ioBroker.StateCommon> {
  if (type === "number" || type === "mixed") {
    return metadata;
  }

  const { min: _min, max: _max, step: _step, ...rest } = metadata;
  return rest;
}

function hasNumericStateKeys(states: ioBroker.StateCommon["states"] | undefined): boolean {
  if (!states || typeof states !== "object") {
    return false;
  }

  return Object.keys(states).some(key => key.trim() !== "" && Number.isFinite(Number(key)));
}

function commonChanged(existing: ioBroker.StateCommon | undefined, metadata: Partial<ioBroker.StateCommon>): boolean {
  return Object.entries(metadata).some(([key, value]) => JSON.stringify((existing as Record<string, unknown> | undefined)?.[key]) !== JSON.stringify(value));
}
