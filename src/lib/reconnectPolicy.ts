export function isExpectedOfflineError(message: string): boolean {
  return [
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EHOSTDOWN",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "Timeout while connecting",
    "Duplicate connection to this deviceID detected",
  ].some(marker => message.includes(marker));
}

export function connectionFailureLogLevel(message: string, reconnectFailures: number): "info" | "warn" | "debug" {
  if (reconnectFailures > 1) return "debug";
  return isExpectedOfflineError(message) ? "info" : "warn";
}

export function connectionFailureLogMessage(haId: string, message: string, reconnectFailures: number): string {
  if (reconnectFailures > 1) return `${haId}: still offline, retrying: ${message}`;
  return isExpectedOfflineError(message) ? `${haId}: offline: ${message}` : `${haId}: connection failed: ${message}`;
}
