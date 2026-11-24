import { BlockList, isIP } from "node:net";

const loopbackAddressBlockList = new BlockList();
loopbackAddressBlockList.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddressBlockList.addAddress("::1", "ipv6");

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
}

export function isLoopbackAddress(value: string): boolean {
  const normalized = normalizeHostname(value);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return loopbackAddressBlockList.check(normalized, "ipv4");
  }
  if (ipVersion === 6) {
    return loopbackAddressBlockList.check(normalized, "ipv6");
  }
  return false;
}

export function isLoopbackHostname(value: string): boolean {
  const normalized = normalizeHostname(value);
  return normalized === "localhost" || isLoopbackAddress(normalized);
}

/** An https URL, or one on this machine (RFC 6761 `*.localhost` included). Credentials sent anywhere else would travel unencrypted (#2194). */
export function isSecureOrLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    return (
      parsed.protocol === "https:" ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      isLoopbackHostname(host)
    );
  } catch {
    return false;
  }
}
