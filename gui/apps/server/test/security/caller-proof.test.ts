import { once } from "node:events";
import { chmod } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import {
  CALLER_PROOF_STATUS_HEADER,
  CALLER_TOKEN_HEADER,
} from "@cloudroom/config/caller-proof";
import { createNodeRoomSdk } from "@cloudroom/sdk/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertHost } from "@cloudroom/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";
import {
  createTestDaemonHostKey,
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function send(
  path: string,
  init: {
    body?: unknown;
    headers?: Record<string, string>;
    method?: string;
  } = {},
): Promise<Response> {
  return fetch(new URL(path, server!.baseUrl), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe("local caller proof", () => {
  it("refuses privileged requests that carry no caller token", async () => {
    server = await startTestServer();

    const terminal = await send("/api/v1/terminals", {
      body: {
        target: { kind: "host_path", cwd: "/" },
        start: { mode: "shell" },
        cols: 80,
        rows: 24,
      },
    });
    expect(terminal.status).toBe(401);
    expect(terminal.headers.get(CALLER_PROOF_STATUS_HEADER)).toBe("required");
    expect((await send("/api/v1/hosts")).status).toBe(401);
    expect(
      (await send("/api/v1/settings/general", { method: "PUT", body: {} }))
        .status,
    ).toBe(401);
    expect(
      (await send("/internal/hosts/enroll-key", { body: {} })).status,
    ).toBe(401);

    expect((await send("/api/v1/threads")).status).toBe(200);
    expect((await send("/api/v1/system/version")).status).toBe(200);
  });

  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find(
      (entry) => entry && !entry.internal && entry.family === "IPv4",
    )?.address;

  it.skipIf(lanAddress === undefined)(
    "refuses a daemon key on the loopback port even from a LAN source address",
    async () => {
      server = await startTestServer();
      const hostId = "host-lan-source";
      upsertHost(server.db, server.hub, { id: hostId, name: "LAN source" });
      const url = new URL("/internal/session/open", server.baseUrl);
      const openSession = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const request = http.request(
            {
              host: url.hostname,
              port: url.port,
              path: url.pathname,
              method: "POST",
              localAddress: lanAddress,
              headers: {
                authorization: `Bearer ${createTestDaemonHostKey({ hostId })}`,
                "content-type": "application/json",
                ...headers,
              },
            },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
            },
          );
          request.once("error", reject);
          request.end(
            JSON.stringify({
              hostId,
              instanceId: "instance-lan-source",
              hostName: "LAN source",
              hasMachineCredential: true,
              platform: "linux",
              dataDir: `/tmp/${hostId}`,
              localApiPort: 38_888,
              protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
              activeThreads: [],
              loadedEnvironments: [],
            }),
          );
        });

      expect(await openSession({})).toBe(401);
      expect(
        await openSession({ [CALLER_TOKEN_HEADER]: server!.callerToken }),
      ).toBe(201);
    },
  );

  it("lets an unsandboxed local process prove itself through the SDK", async () => {
    server = await startTestServer();
    const sdk = createNodeRoomSdk({ baseUrl: server.baseUrl });
    await expect(sdk.hosts.list()).resolves.toEqual(expect.any(Array));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "gives no token to a process that cannot write the proof folder",
    async () => {
      server = await startTestServer();
      const directory = server.deps.callerProofs.directory;
      await chmod(directory, 0o500);
      try {
        const sdk = createNodeRoomSdk({ baseUrl: server.baseUrl });
        await expect(sdk.hosts.list()).rejects.toMatchObject({ status: 401 });
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );

  // Linux and macOS tell which user owns each loopback connection. Here the server
  // takes another uid as its own, so this test's process is the other user.
  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "refuses open reads from another OS user on this computer",
    async () => {
      server = await startTestServer();
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      try {
        const refused = await send("/api/v1/threads");
        expect(refused.status).toBe(401);
        expect(refused.headers.get(CALLER_PROOF_STATUS_HEADER)).toBe(
          "required",
        );
        // Starting a proof stays open: another user can't write the folder.
        expect((await send("/api/v1/caller-proofs", { body: {} })).status).toBe(
          200,
        );
        const proven = await send("/api/v1/threads", {
          headers: { [CALLER_TOKEN_HEADER]: server.callerToken },
        });
        expect(proven.status).toBe(200);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("survives clients that reset while their WebSocket upgrade is checked", async () => {
    server = await startTestServer();
    const url = new URL(server.baseUrl);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const client = net.connect(Number(url.port), url.hostname);
      client.on("error", () => client.destroy());
      await once(client, "connect");
      client.write(
        `GET /api/v1/threads HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      client.resetAndDestroy();
    }
    // An unhandled socket error would have crashed the server before this.
    expect((await send("/api/v1/system/version")).status).toBe(200);
  });

  it("tells a stale token apart from a missing or ignored one", async () => {
    server = await startTestServer();
    const marker = async (headers: Record<string, string>) =>
      (await send("/api/v1/hosts", { headers })).headers.get(
        CALLER_PROOF_STATUS_HEADER,
      );

    expect(await marker({})).toBe("required");
    expect(await marker({ [CALLER_TOKEN_HEADER]: "stale" })).toBe("invalid");
    expect(
      await marker({
        [CALLER_TOKEN_HEADER]: server.callerToken,
        "sec-fetch-site": "cross-site",
      }),
    ).toBe("required");
  });

  it("ignores a caller token on a cross-site browser request except preview reads", async () => {
    server = await startTestServer();
    const token = { [CALLER_TOKEN_HEADER]: server.callerToken };

    expect(
      (
        await send("/api/v1/hosts", {
          headers: { ...token, "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await send("/api/v1/threads/missing/worktree/files/index.html", {
          headers: { ...token, "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).not.toBe(401);
    expect(
      (await send("/api/v1/threads/missing/worktree/files/index.html")).status,
    ).toBe(401);
    expect(
      (
        await send("/api/v1/hosts", {
          headers: { ...token, "sec-fetch-site": "same-origin" },
        })
      ).status,
    ).toBe(200);
  });
});
