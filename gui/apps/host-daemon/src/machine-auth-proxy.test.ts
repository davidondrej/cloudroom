import {
  CALLER_PROOF_STATUS_HEADER,
  CALLER_TOKEN_HEADER,
  proveLocalCaller,
  SERVER_CALLER_PROOF_PATH,
} from "@cloudroom/config/caller-proof";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  startMachineAuthProxy,
  type MachineAuthProxy,
} from "./machine-auth-proxy.js";

const proxies: MachineAuthProxy[] = [];
const servers: Array<http.Server | net.Server> = [];

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server | net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startProxy(
  upstreamPort: number,
  machineCredential = "bbcm_machine",
): Promise<{ proxy: MachineAuthProxy; token: string }> {
  const proxy = await startMachineAuthProxy({
    dataDir: await mkdtemp(join(tmpdir(), "machine-auth-proxy-")),
    serverHeaders: { "x-bb-connect-machine": machineCredential },
    serverUrl: `http://127.0.0.1:${upstreamPort}`,
  });
  proxies.push(proxy);
  const token = await proveLocalCaller({
    baseUrl: proxy.serverUrl,
    proofPath: SERVER_CALLER_PROOF_PATH,
  });
  if (token === null) throw new Error("Caller proof against the proxy failed");
  return { proxy, token };
}

async function rawStatus(
  proxyUrl: URL,
  path: string,
): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      { host: proxyUrl.hostname, port: proxyUrl.port, path },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("startMachineAuthProxy", () => {
  it.each(["upstream", "client"])(
    "contains a %s connection reset after a WebSocket upgrade",
    async (resetSide) => {
      const upstream = net.createServer((socket) => {
        socket.once("data", () => {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
          socket.once("data", () => socket.resetAndDestroy());
        });
      });
      const upstreamConnected = once(upstream, "connection");
      const upstreamPort = await listen(upstream);
      const { proxy, token } = await startProxy(upstreamPort);
      const proxyUrl = new URL(proxy.serverUrl);
      const client = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
      try {
        await once(client, "connect");
        client.write(
          `GET /ws HTTP/1.1\r\nHost: ${proxyUrl.host}\r\n${CALLER_TOKEN_HEADER}: ${token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
        await once(client, "data");
        const [upstreamSocket] = await upstreamConnected;
        const upstreamClosed = once(upstreamSocket, "close");
        const closed = once(client, "close");
        if (resetSide === "upstream") {
          client.write("trigger reset");
        } else {
          client.resetAndDestroy();
        }
        await Promise.all([closed, upstreamClosed]);
        expect(client.destroyed).toBe(true);
      } finally {
        client.destroy();
      }
    },
  );

  it("forwards HTTP requests to the configured origin with authentication and caller headers", async () => {
    const upstream = http.createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/threads?state=open");
      expect(request.headers["x-bb-connect-machine"]).toBe("bbcm_machine");
      expect(request.headers["x-request-id"]).toBe("request-1");
      expect(request.headers[CALLER_TOKEN_HEADER]).toBeUndefined();
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        expect(body).toBe("payload");
        response.writeHead(201, { "x-upstream": "yes" }).end("created");
      });
    });
    const upstreamPort = await listen(upstream);
    const { proxy, token } = await startProxy(upstreamPort);

    const response = await fetch(
      `${proxy.serverUrl}/api/v1/threads?state=open`,
      {
        method: "POST",
        headers: {
          "x-bb-connect-machine": "caller-must-not-override",
          "x-request-id": "request-1",
          [CALLER_TOKEN_HEADER]: token,
        },
        body: "payload",
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-upstream")).toBe("yes");
    await expect(response.text()).resolves.toBe("created");
  });

  it("streams multipart attachment bytes while adding the machine credential", async () => {
    const binary = new Uint8Array([0, 255, 1, 128, 42]);
    let resolveReceived: (() => void) | undefined;
    let rejectReceived: ((error: unknown) => void) | undefined;
    const received = new Promise<void>((resolve, reject) => {
      resolveReceived = resolve;
      rejectReceived = reject;
    });
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void (async () => {
          expect(request.headers["x-bb-connect-machine"]).toBe(
            "bbcm_attachment_machine",
          );
          const contentType = request.headers["content-type"];
          expect(contentType).toMatch(/^multipart\/form-data; boundary=/u);
          const form = await new Response(Buffer.concat(chunks), {
            headers: { "content-type": contentType ?? "" },
          }).formData();
          const file = form.get("file");
          expect(file).toBeInstanceOf(File);
          if (!(file instanceof File)) {
            throw new Error("Expected proxied multipart file");
          }
          expect(file.name).toBe("payload.bin");
          expect(file.type).toBe("application/x-bb-test");
          expect(new Uint8Array(await file.arrayBuffer())).toEqual(binary);
          response.writeHead(201).end();
          resolveReceived?.();
        })().catch((error: unknown) => {
          response.writeHead(500).end();
          rejectReceived?.(error);
        });
      });
    });
    const upstreamPort = await listen(upstream);
    const { proxy, token } = await startProxy(
      upstreamPort,
      "bbcm_attachment_machine",
    );
    const form = new FormData();
    form.set(
      "file",
      new Blob([binary], { type: "application/x-bb-test" }),
      "payload.bin",
    );

    const response = await fetch(
      `${proxy.serverUrl}/api/v1/projects/proj_remote/attachments`,
      { body: form, headers: { [CALLER_TOKEN_HEADER]: token }, method: "POST" },
    );

    await received;
    expect(response.status).toBe(201);
  });

  it("passes WebSocket upgrades through with machine authentication", async () => {
    const upstream = http.createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (request, socket, head) => {
      expect(request.headers["x-bb-connect-machine"]).toBe("bbcm_machine");
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => {
      socket.on("message", (message: RawData) =>
        socket.send(message, () => socket.terminate()),
      );
    });
    const upstreamPort = await listen(upstream);
    const { proxy, token } = await startProxy(upstreamPort);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(
        `${proxy.serverUrl.replace("http:", "ws:")}/ws/threads/thread-1/terminals/terminal-1`,
        { headers: { [CALLER_TOKEN_HEADER]: token } },
      );
      socket.once("open", () => socket.send("ping"));
      socket.once("message", (message: RawData) => {
        resolve(String(message));
        socket.terminate();
      });
      socket.once("error", reject);
    });

    expect(response).toBe("ping");
    websocketServer.close();
  });

  it("rejects absolute request targets and CONNECT without reaching upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const { proxy } = await startProxy(upstreamPort);
    const proxyUrl = new URL(proxy.serverUrl);

    const absoluteStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = http.request(
          {
            host: proxyUrl.hostname,
            port: proxyUrl.port,
            path: "http://attacker.test/api/v1",
          },
          (response) => resolve(response.statusCode),
        );
        request.once("error", reject);
        request.end();
      },
    );
    const connectResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(
        Number(proxyUrl.port),
        proxyUrl.hostname,
        () => {
          socket.write(
            "CONNECT attacker.test:443 HTTP/1.1\r\nHost: attacker.test:443\r\n\r\n",
          );
        },
      );
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("error", reject);
    });

    expect(absoluteStatus).toBe(400);
    expect(connectResponse).toContain("405 Method Not Allowed");
    expect(upstreamRequests).toBe(0);
  });

  it("rejects browser-originated requests without reaching upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const { proxy, token } = await startProxy(upstreamPort);

    const browserHeaders: Array<Record<string, string>> = [
      { origin: "http://127.0.0.1:3009", "content-type": "text/plain" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of browserHeaders) {
      const response = await fetch(`${proxy.serverUrl}/api/v1/threads`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(response.status).toBe(403);
    }
    expect(upstreamRequests).toBe(0);

    const allowed = await fetch(`${proxy.serverUrl}/api/v1/threads`, {
      method: "POST",
      headers: { [CALLER_TOKEN_HEADER]: token },
      body: "{}",
    });
    expect(allowed.status).toBe(200);
    expect(upstreamRequests).toBe(1);
  });

  it("rejects a browser WebSocket handshake without reaching upstream", async () => {
    let upstreamUpgrades = 0;
    const upstream = http.createServer((_request, response) => response.end());
    upstream.on("upgrade", (_request, socket) => {
      upstreamUpgrades += 1;
      socket.destroy();
    });
    const upstreamPort = await listen(upstream);
    const { proxy } = await startProxy(upstreamPort);
    const proxyUrl = new URL(proxy.serverUrl);

    const handshake = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(
        Number(proxyUrl.port),
        proxyUrl.hostname,
        () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:3009\r\n\r\n`,
          );
        },
      );
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("error", reject);
    });

    expect(handshake).toContain("403 Forbidden");
    expect(upstreamUpgrades).toBe(0);
  });

  it("rejects a rebound public Host without reaching upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const { proxy, token } = await startProxy(upstreamPort);
    const proxyUrl = new URL(proxy.serverUrl);

    async function statusForHost(host: string): Promise<number | undefined> {
      return await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request(
          {
            host: proxyUrl.hostname,
            port: proxyUrl.port,
            path: "/api/v1/threads",
            headers: { host, [CALLER_TOKEN_HEADER]: token },
          },
          (response) => resolve(response.statusCode),
        );
        request.once("error", reject);
        request.end();
      });
    }

    expect(await statusForHost(`rebind.example:${proxyUrl.port}`)).toBe(403);
    expect(await statusForHost("127.0.0.1:1")).toBe(403);
    expect(upstreamRequests).toBe(0);

    for (const host of [
      `127.0.0.1:${proxyUrl.port}`,
      `localhost:${proxyUrl.port}`,
      `[::1]:${proxyUrl.port}`,
    ]) {
      expect(await statusForHost(host)).toBe(200);
    }
    expect(upstreamRequests).toBe(3);
  });

  it("refuses a caller without a proof before anything reaches the Mac", async () => {
    const received: http.IncomingMessage[] = [];
    let upstreamUpgrades = 0;
    const upstream = http.createServer((request, response) => {
      received.push(request);
      response.end();
    });
    upstream.on("upgrade", (_request, socket) => {
      upstreamUpgrades += 1;
      socket.destroy();
    });
    const upstreamPort = await listen(upstream);
    const { proxy, token } = await startProxy(upstreamPort);
    const proxyUrl = new URL(proxy.serverUrl);
    const openTerminal = (headers: Record<string, string> = {}) =>
      fetch(`${proxy.serverUrl}/api/v1/terminals`, {
        method: "POST",
        headers,
        body: JSON.stringify({ start: { mode: "command", command: "id" } }),
      });

    const missing = await openTerminal();
    expect(missing.status).toBe(401);
    expect(missing.headers.get(CALLER_PROOF_STATUS_HEADER)).toBe("required");
    await expect(missing.json()).resolves.toMatchObject({
      code: "caller_proof_required",
    });
    const wrong = await openTerminal({ [CALLER_TOKEN_HEADER]: "not-a-token" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get(CALLER_PROOF_STATUS_HEADER)).toBe("invalid");
    // Sent raw: it starts like an open read, but the Mac routes it to terminals.
    expect(
      await rawStatus(
        proxyUrl,
        "/api/v1/file-previews/x/../../../../api/v1/terminals",
      ),
    ).toBe(401);
    // Plugin routes default to "local" auth, which trusts every relayed call.
    const pluginRoute = await fetch(
      `${proxy.serverUrl}/api/v1/plugins/tasks/http/attachments/a1`,
      { method: "DELETE" },
    );
    expect(pluginRoute.status).toBe(401);
    const handshake = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(
        Number(proxyUrl.port),
        proxyUrl.hostname,
        () => {
          socket.write(
            `GET /internal/ws HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          );
        },
      );
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("error", reject);
    });
    expect(handshake).toContain("401 Unauthorized");
    expect(handshake).toContain(`${CALLER_PROOF_STATUS_HEADER}: required`);
    expect(received).toHaveLength(0);
    expect(upstreamUpgrades).toBe(0);

    // The reads a sandboxed agent may make on the Mac still go through.
    expect((await fetch(`${proxy.serverUrl}/api/v1/threads`)).status).toBe(200);
    expect((await openTerminal({ [CALLER_TOKEN_HEADER]: token })).status).toBe(
      200,
    );
    expect(received.map((request) => request.url)).toEqual([
      "/api/v1/threads",
      "/api/v1/terminals",
    ]);
    for (const request of received) {
      expect(request.headers["x-bb-connect-machine"]).toBe("bbcm_machine");
      expect(request.headers[CALLER_TOKEN_HEADER]).toBeUndefined();
    }
  });

  // Linux reports which uid owns each loopback connection. Here the proxy
  // takes another uid as its own, so this test's process is the other user.
  it.runIf(process.platform === "linux")(
    "refuses open reads from another OS user on this machine",
    async () => {
      const received: string[] = [];
      const upstream = http.createServer((request, response) => {
        received.push(request.url ?? "");
        response.end("{}");
      });
      const { proxy, token } = await startProxy(await listen(upstream));
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      try {
        const refused = await fetch(`${proxy.serverUrl}/api/v1/threads`);
        expect(refused.status).toBe(401);
        expect(refused.headers.get(CALLER_PROOF_STATUS_HEADER)).toBe(
          "required",
        );
        expect(await refused.json()).toMatchObject({
          code: "caller_proof_required",
        });
        const proven = await fetch(`${proxy.serverUrl}/api/v1/threads`, {
          headers: { [CALLER_TOKEN_HEADER]: token },
        });
        expect(proven.status).toBe(200);
      } finally {
        vi.restoreAllMocks();
      }
      expect(received).toEqual(["/api/v1/threads"]);
    },
  );

  it("gives a token only to a caller that writes the proof file", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const { proxy } = await startProxy(await listen(upstream));
    const proxyUrl = new URL(proxy.serverUrl);
    const finish = (id: string, body: string) =>
      fetch(`${proxy.serverUrl}${SERVER_CALLER_PROOF_PATH}/${id}`, {
        method: "POST",
        body,
      });

    const started = (await (
      await fetch(`${proxy.serverUrl}${SERVER_CALLER_PROOF_PATH}`, {
        method: "POST",
        body: "{}",
      })
    ).json()) as { claim: string; id: string };
    // A sandbox can't create the file, so the claim alone gets nothing.
    expect((await finish(started.id, JSON.stringify(started))).status).toBe(
      403,
    );
    expect((await finish(started.id, "not json")).status).toBe(403);
    expect((await finish(started.id, "x".repeat(4096))).status).toBe(403);
    // `new URL` throws on this target; the proxy must answer, not crash.
    expect(await rawStatus(proxyUrl, "/\\[")).toBe(400);
    expect(await rawStatus(proxyUrl, "/\\evil.test/api/v1/threads")).toBe(400);
    expect(await rawStatus(proxyUrl, "/api/v1/threads")).toBe(200);
    expect(upstreamRequests).toBe(1);
  });

  it("survives clients that reset as soon as an upgrade or CONNECT is refused", async () => {
    const upstream = http.createServer((_request, response) => response.end());
    const { proxy } = await startProxy(await listen(upstream));
    const proxyUrl = new URL(proxy.serverUrl);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const client = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
      client.on("error", () => client.destroy());
      await once(client, "connect");
      client.write(
        attempt % 2 === 0
          ? `GET /ws HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
          : "CONNECT attacker.test:443 HTTP/1.1\r\nHost: attacker.test:443\r\n\r\n",
      );
      client.resetAndDestroy();
    }
    // An unhandled socket error would have crashed the daemon before this.
    expect(await rawStatus(proxyUrl, "/api/v1/threads")).toBe(200);
  });

  it("rejects loudly when its loopback port cannot be bound", async () => {
    const occupied = net.createServer();
    const port = await listen(occupied);

    await expect(
      startMachineAuthProxy({
        dataDir: await mkdtemp(join(tmpdir(), "machine-auth-proxy-")),
        serverHeaders: { "x-bb-connect-machine": "bbcm_machine" },
        port,
        serverUrl: "http://server.test",
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
