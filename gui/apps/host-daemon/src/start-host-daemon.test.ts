import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usesSecureInternalFetchTransport } from "./server-client.js";
import { startHostDaemon } from "./start-host-daemon.js";

describe("startHostDaemon over a remote http:// server URL (#2194)", () => {
  let dataDir = "";
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function start(
    allowInsecure: boolean,
    serverUrl = "http://192.0.2.10:38886",
    stubFetch = true,
  ) {
    dataDir = await mkdtemp(join(tmpdir(), "bb-insecure-url-"));
    vi.stubEnv("BB_DATA_DIR", dataDir);
    vi.stubEnv("BB_SERVER_URL", serverUrl);
    if (allowInsecure) vi.stubEnv("BB_ALLOW_INSECURE_SERVER_URL", "1");
    const bearers: string[] = [];
    if (stubFetch)
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          const auth = new Headers(init?.headers).get("authorization");
          if (auth) bearers.push(auth);
          return new Response("{}", { status: 500 });
        }),
      );
    const error = await startHostDaemon({
      enrollKey: "fake-enroll-key",
      hostId: "host-test",
      hostName: "test",
    }).catch((caught: unknown) => caught);
    return { bearers, error };
  }

  it("refuses before sending any bearer credential", async () => {
    const { bearers, error } = await start(false);
    expect(String(error)).toMatch(/over plain HTTP/u);
    expect(bearers).toEqual([]);
  });

  it("connects when BB_ALLOW_INSECURE_SERVER_URL=1 opts in", async () => {
    const { bearers } = await start(true);
    expect(bearers).toContain("Bearer fake-enroll-key");
  });

  it("treats every loopback address as local", () => {
    for (const url of [
      "http://127.0.0.2:1",
      "http://[::1]:1",
      "http://localhost:1",
      "http://localhost.:1",
      "http://owner.bb.localhost:42745",
    ])
      expect(usesSecureInternalFetchTransport(url)).toBe(true);
    expect(usesSecureInternalFetchTransport("http://192.0.2.10:1")).toBe(false);
  });

  it("does not follow a server redirect to another origin", async () => {
    let elsewhereHits = 0;
    const listen = async (handler: Parameters<typeof createServer>[1]) => {
      const server = createServer(handler);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      return server;
    };
    const port = (server: Server) =>
      (server.address() as { port: number }).port;
    const elsewhere = await listen((_req, res) => {
      elsewhereHits += 1;
      res.end("{}");
    });
    const redirecting = await listen((req, res) => {
      res
        .writeHead(307, {
          location: `http://127.0.0.1:${port(elsewhere)}${req.url}`,
        })
        .end();
    });
    try {
      const { error } = await start(
        false,
        `http://127.0.0.1:${port(redirecting)}`,
        false,
      );
      expect(error).toBeInstanceOf(Error);
      expect(elsewhereHits).toBe(0);
    } finally {
      redirecting.close();
      elsewhere.close();
    }
  });
});
