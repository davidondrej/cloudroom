import type { HeaderPair } from "@cloudroom/tunnel-contract";

const SKIP_REQUEST_HEADERS = new Set(["host", "content-length", "connection"]);
const GATE_AUTH_HEADER = "x-bb-gate-auth";

interface LoopbackHeaderRewrite {
  publicOrigin: string;
  loopbackOrigin: string;
  host?: string;
  headers?: Readonly<Record<string, string>>;
  /**
   * When true (Connect tunnel traffic to this Mac's own server), always mark the request with
   * `x-bb-gate-auth` ("machine" if sent by the relay, otherwise "session"), so a compromised or
   * misconfigured relay can never omit or spoof the header to impersonate a local desktop caller.
   */
  enforceGateAuth?: boolean;
}

export function headersForLoopbackRequest(
  headers: HeaderPair[],
  rewrite: LoopbackHeaderRewrite,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const replaced = new Set(
    Object.keys(rewrite.headers ?? {}).map((name) => name.toLowerCase()),
  );
  let gateAuth: "machine" | "session" = "session";
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (rewrite.enforceGateAuth && lowerName === GATE_AUTH_HEADER) {
      if (value === "machine") gateAuth = "machine";
      continue;
    }
    if (SKIP_REQUEST_HEADERS.has(lowerName) || replaced.has(lowerName))
      continue;
    forwarded[name] =
      lowerName === "origin" && value === rewrite.publicOrigin
        ? rewrite.loopbackOrigin
        : value;
  }
  if (rewrite.host !== undefined) {
    forwarded.Host = rewrite.host;
  }
  const result = { ...forwarded, ...rewrite.headers };
  if (rewrite.enforceGateAuth) {
    for (const key of Object.keys(result)) {
      if (key.toLowerCase() === GATE_AUTH_HEADER) delete result[key];
    }
    result[GATE_AUTH_HEADER] = gateAuth;
  }
  return result;
}
