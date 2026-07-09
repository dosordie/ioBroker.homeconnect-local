const RESPONSE_CODE_DESCRIPTIONS: Record<number, string> = {
  200: "OK",
  202: "Accepted",
  400: "BadRequest",
  403: "Forbidden",
  404: "NotFound",
  405: "MethodNotAllowed",
  412: "RequestUriTooLong",
  413: "RequestEntityTooLong",
  429: "TooManyRequests",
  500: "InternalServerError",
  501: "NotImplemented",
  502: "BadGateway",
  503: "ServiceUnavailable",
  504: "GatewayTimeout",
  507: "InsufficientMemory",
  512: "UnknownUID",
  513: "WriteRequest UnknownUID",
  514: "ReadRequest UnknownUID",
  515: "Busy",
  516: "WriteRequest Busy",
  517: "ReadRequest Busy",
  518: "NoAccess",
  519: "WriteRequest NoAccess",
  520: "ReadRequest NoAccess",
  521: "NoAccessByList",
  522: "WriteRequest NoAccessByList",
  523: "ReadRequest NoAccessByList",
  524: "NotAvailable",
  525: "WriteRequest NotAvailable",
  526: "ReadRequest NotAvailable",
  527: "NotAvailableByList",
  528: "WriteRequest NotAvailableByList",
  529: "ReadRequest NotAvailableByList",
  530: "NoExecution",
  531: "ValueOutOfRange",
  532: "InvalidUIDValue",
  533: "Incomplete",
  534: "Inconsistent",
  535: "CmdViolation",
  536: "InvalidFormat",
  537: "RemoteControlNotActive",
  538: "RemoteStartNotActive",
  539: "LockedByLocalControl",
  540: "DeviceStateNotCompliant",
  541: "ProcessStateNotCompliant",
  542: "BackendNotConnected",
  543: "EnergyManagementNotConnected",
  544: "NotInLocalWiFi",
};

const RESPONSE_CODE_HINTS: Record<number, string> = {
  519: "write/start is not allowed in the current state, e.g. RemoteControlStartAllowed=false",
  531: "written value is outside the currently allowed range, e.g. option combination restricts the value",
};

export function describeResponseCode(code: number): string {
  const description = RESPONSE_CODE_DESCRIPTIONS[code];
  const hint = RESPONSE_CODE_HINTS[code];
  if (description && hint) return `${description} (${hint})`;
  return description ?? "Unknown response code";
}
