export function normalizeUid(uid: number | string | undefined): string | undefined {
  if (uid === undefined || uid === null) {
    return undefined;
  }

  if (typeof uid === "number") {
    return uid.toString(16).toUpperCase().padStart(4, "0");
  }

  const trimmed = String(uid).trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutPrefix = trimmed.replace(/^0x/i, "");
  const numeric = Number.parseInt(withoutPrefix, 16);
  if (Number.isFinite(numeric) && /^[0-9a-fA-F]+$/.test(withoutPrefix)) {
    return numeric.toString(16).toUpperCase().padStart(4, "0");
  }

  return undefined;
}

export function sanitizeObjectId(value: string): string {
  return value
    .replace(/^\.+|\.+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/_+/g, "_");
}

export function lastMeaningfulNamePart(featureName: string): string {
  const markers = [".Status.", ".Option.", ".Setting.", ".Event.", ".Command.", ".Program.", ".Root."];

  for (const marker of markers) {
    const idx = featureName.indexOf(marker);
    if (idx >= 0) {
      return featureName.slice(idx + marker.length);
    }
  }

  const parts = featureName.split(".");
  return parts[parts.length - 1] || featureName;
}
