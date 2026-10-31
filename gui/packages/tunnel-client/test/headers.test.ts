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
});
