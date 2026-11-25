import { describe, expect, it } from "vitest";
import { headersForLoopbackRequest } from "../src/headers.js";

describe("headersForLoopbackRequest", () => {
  const rewrite = {
    loopbackOrigin: "http://127.0.0.1:39886",
    publicOrigin: "https://mac.cloudroom.run",
  };

  it("replaces a forwarded header with the origin's own value", () => {
    expect(
      headersForLoopbackRequest(
        [
          ["X-Cloudroom-Caller", "from-the-phone"],
          ["Authorization", "Bearer daemon-key"],
        ],
        { ...rewrite, headers: { "x-cloudroom-caller": "server-token" } },
      ),
    ).toEqual({
      Authorization: "Bearer daemon-key",
      "x-cloudroom-caller": "server-token",
    });
  });

  it("adds nothing for an origin without its own headers", () => {
    expect(
      headersForLoopbackRequest([["Accept", "text/html"]], rewrite),
    ).toEqual({ Accept: "text/html" });
  });

  it("forces x-bb-gate-auth on Connect server requests even if omitted or spoofed by the relay", () => {
    expect(
      headersForLoopbackRequest([["Accept", "application/json"]], {
        ...rewrite,
        enforceGateAuth: true,
      }),
    ).toEqual({ Accept: "application/json", "x-bb-gate-auth": "session" });

    expect(
      headersForLoopbackRequest(
        [["X-BB-Gate-Auth", "local"]],
        { ...rewrite, enforceGateAuth: true },
      ),
    ).toEqual({ "x-bb-gate-auth": "session" });

    expect(
      headersForLoopbackRequest(
        [
          ["X-BB-Gate-Auth", "machine"],
          ["x-bb-gate-auth", "session"],
        ],
        { ...rewrite, enforceGateAuth: true },
      ),
    ).toEqual({ "x-bb-gate-auth": "machine" });
  });
});
