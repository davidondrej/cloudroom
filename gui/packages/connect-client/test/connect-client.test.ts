import { describe, expect, it } from "vitest";
import { connectPublicProtocol, deriveConnectBaseUrl } from "../src/index.js";

describe("connect URL helpers", () => {
  it("drops the routing label and picks the scheme", () => {
    expect(deriveConnectBaseUrl("https://laptop.cloudroom.run")).toBe("https://cloudroom.run");
    expect(deriveConnectBaseUrl("https://laptop.relay.example:8443")).toBe("https://relay.example:8443");
    expect(connectPublicProtocol("relay.localhost:42745")).toBe("http:");
    expect(connectPublicProtocol("cloudroom.run")).toBe("https:");
  });
});
