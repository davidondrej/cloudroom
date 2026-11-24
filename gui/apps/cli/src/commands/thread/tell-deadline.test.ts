import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";

// Only the deadline is shortened; the real CLI transport and timeout fetch run.
vi.mock("@cloudroom/sdk/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudroom/sdk/node")>()),
  DEFAULT_BB_REQUEST_TIMEOUT_MS: 300,
}));

import { postThreadMessage } from "./actions.js";

it("tell gives up on a send whose answer stalls, without resending (#1832)", async () => {
  const sends: string[] = [];
  // Headers, then a body that never ends: undici alone waits on this forever.
  const server = createServer((request, response) => {
    if (!request.url?.endsWith("/send")) return void response.writeHead(404).end();
    sends.push(request.url);
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await expect(
      postThreadMessage({
        getUrl: () => `http://127.0.0.1:${port}`,
        threadId: "thr_x",
        message: "hi",
        mode: "steer",
      }),
    ).rejects.toThrow(
      "may already have been sent (no answer within 0.3 seconds; it may be busy)",
    );
    expect(sends).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
