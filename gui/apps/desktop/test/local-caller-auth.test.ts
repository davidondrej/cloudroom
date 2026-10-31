import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALLER_PROOF_STATUS_HEADER,
  createCallerProofIssuer,
} from "@cloudroom/config/caller-proof";
import {
  callerTokenTarget,
  createLocalCallerAuth,
  type LocalCallerOrigins,
} from "../src/local-caller-auth.js";

const origins: LocalCallerOrigins = {
  app: "http://localhost:17225",
  daemons: new Set(["http://127.0.0.1:39887"]),
  server: "http://127.0.0.1:39886",
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startProofServer(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "desktop-caller-proof-"));
  const issuer = await createCallerProofIssuer({ dataDir });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://x").pathname;
        const json = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (path === "/api/v1/caller-proofs") return json(200, issuer.start());
        if (path.startsWith("/api/v1/caller-proofs/")) {
          const { claim } = JSON.parse(body) as { claim: string };
          const token = await issuer.finish(path.split("/").pop()!, claim);
          return token === null ? json(403, {}) : json(200, { token });
        }
        if (path === "/api/v1/system/config") {
          return json(200, { localHelperPorts: [] });
        }
        return json(404, {});
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { force: true, recursive: true });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function refusal(url: string, status: string, topFrame = true) {
  return {
    frame: { parent: topFrame ? null : {} },
    responseHeaders: { [CALLER_PROOF_STATUS_HEADER]: [status] },
    statusCode: 401,
    url,
    webContentsId: 1,
  };
}

describe("callerTokenTarget", () => {
  it("sends the server token only to the server and app origins", () => {
    expect(
      callerTokenTarget("http://127.0.0.1:39886/api/v1/terminals", origins),
    ).toEqual({ origin: "http://127.0.0.1:39886" });
    expect(callerTokenTarget("ws://127.0.0.1:39886/ws", origins)).toEqual({
      origin: "http://127.0.0.1:39886",
    });
    expect(
      callerTokenTarget("http://localhost:17225/api/v1/threads", origins),
    ).toEqual({ origin: "http://127.0.0.1:39886" });
  });

  it("proves to a local helper daemon even while another Mac is on screen", () => {
    const target = {
      origin: "http://127.0.0.1:39887",
      proofPath: "/caller-proofs",
    };
    expect(
      callerTokenTarget("http://127.0.0.1:39887/open-in-target", origins),
    ).toEqual(target);
    expect(
      callerTokenTarget("http://127.0.0.1:39887/open-in-target", {
        ...origins,
        app: null,
        server: null,
      }),
    ).toEqual(target);
  });

  it("never sends a token to other local ports or remote sites", () => {
    expect(callerTokenTarget("http://127.0.0.1:3000/", origins)).toBeNull();
    expect(
      callerTokenTarget("http://localhost:39886/api/v1/hosts", origins),
    ).toBeNull();
    expect(callerTokenTarget("https://example.com/", origins)).toBeNull();
  });
});

describe("createLocalCallerAuth", () => {
  it("reloads the app only when the server says its token is invalid", async () => {
    const serverUrl = await startProofServer();
    const reloadAppWindows = vi.fn();
    const auth = createLocalCallerAuth({
      isAppWebContents: (id) => id === 1,
      localServerUrl: () => serverUrl,
      reloadAppWindows,
    });
    await auth.prepare(serverUrl, serverUrl);

    auth.completed(refusal(`${serverUrl}/api/v1/hosts`, "required"));
    auth.completed(refusal(`${serverUrl}/api/v1/hosts`, "invalid", false));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reloadAppWindows).not.toHaveBeenCalled();

    auth.completed(refusal(`${serverUrl}/api/v1/hosts`, "invalid"));
    await vi.waitFor(() => expect(reloadAppWindows).toHaveBeenCalledTimes(1));
  });
});
