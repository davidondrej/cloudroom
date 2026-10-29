// The Cloudroom VPS service (ADR 0319): runs each Cloud thread's sandbox as a Docker container on the user's VPS.
// The website drives it through this HTTP API, reached through the relay (tunnel.ts). Every call needs the VPS token
// the install command got when the user paired this VPS.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import * as docker from "./docker.js";
import { startTunnel } from "./tunnel.js";

export type Config = {
  /** The VPS token from pairing. The website sends it on every call. */
  token: string;
  name: string;
  relay: string;
  handle?: string | undefined;
  credential?: string | undefined;
  baseDomain?: string | undefined;
};

const DATA = process.env.DATA_DIR ?? "/data";
const CONFIG = `${DATA}/config.json`;
/** The API's loopback port. The website reaches it at https://<handle>--9850.cloudroom.run. */
export const API_PORT = 9850;
const MAX_BODY = 64 * 1024 * 1024;

const config = JSON.parse(await readFile(CONFIG, "utf8")) as Config;
if (!/^[a-f0-9]{64}$/.test(config.token ?? "")) throw new Error(`${CONFIG} has no valid token. Run the install command again.`);
const tokenHash = createHash("sha256").update(config.token).digest();

async function save(patch: Partial<Config>): Promise<void> {
  Object.assign(config, patch);
  await writeFile(`${CONFIG}.tmp`, JSON.stringify(config), { mode: 0o600 });
  await rename(`${CONFIG}.tmp`, CONFIG);
}

function authorized(request: IncomingMessage): boolean {
  const presented = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
  return timingSafeEqual(createHash("sha256").update(presented).digest(), tokenHash);
}

async function body<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  return (chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}) as T;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

// Ports the relay may reach, refreshed often: the tunnel must answer synchronously.
let ports = new Set<number>();
const refreshPorts = async () => { ports = await docker.sandboxPorts(); };
await refreshPorts().catch(() => {});
setInterval(() => void refreshPorts().catch(() => {}), 5_000).unref();

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://vps");
  const method = request.method ?? "GET";
  if (url.pathname === "/health" && method === "GET") return send(response, 200, await docker.health());
  if (url.pathname === "/pull" && method === "POST") {
    const { image } = await body<{ image: string }>(request);
    void docker.pull(image).catch((error: unknown) => console.error(JSON.stringify({ pull_failed: String(error) })));
    return send(response, 202, {});
  }
  if (url.pathname === "/sandboxes" && method === "GET") return send(response, 200, await docker.list(url.searchParams.get("prefix") ?? "room-"));
  const match = /^\/sandboxes\/([a-z0-9-]+)(?:\/(start|stop|exec|files|file))?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, "Not found");
  const [, name = "", action] = match;
  if (!action && method === "PUT") {
    const { image } = await body<{ image: string }>(request);
    const result = await docker.create(name, image);
    await refreshPorts();
    return send(response, 200, result);
  }
  if (!action && method === "GET") return send(response, 200, { status: await docker.status(name) });
  if (!action && method === "DELETE") {
    await docker.remove(name);
    await refreshPorts();
    return send(response, 200, {});
  }
  if (action === "start" && method === "POST") return send(response, 200, { port: await docker.start(name) });
  if (action === "stop" && method === "POST") { await docker.stop(name); return send(response, 200, {}); }
  if (action === "exec" && method === "POST") {
    const input = await body<{ command: string; sudo?: boolean; detached?: boolean; timeoutMs?: number }>(request);
    // Long commands answer late; headers go first so no proxy on the way gives up.
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    return send(response, 200, await docker.exec(name, input.command, input));
  }
  if (action === "files" && method === "POST") {
    const { files } = await body<{ files: { path: string; content: string }[] }>(request);
    await docker.writeFiles(name, files.map((file) => ({ path: file.path, content: Buffer.from(file.content, "base64") })));
    return send(response, 200, {});
  }
  if (action === "file" && method === "GET") {
    const content = await docker.readSandboxFile(name, url.searchParams.get("path") ?? "");
    if (content === null) throw new HttpError(404, "No such file");
    response.writeHead(200, { "content-type": "application/octet-stream" });
    return void response.end(content);
  }
  throw new HttpError(405, "Method not allowed");
}

createServer((request, response) => {
  if (!authorized(request)) return send(response, 401, { error: "Unauthorized" });
  route(request, response).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(JSON.stringify({ api_error: String(error) }));
    send(response, status, { error: error instanceof Error ? error.message : String(error) });
  });
}).listen(API_PORT, "127.0.0.1", () => console.log(JSON.stringify({ api: `listening on 127.0.0.1:${API_PORT}` })));

if (process.env.NO_TUNNEL !== "1") startTunnel(config, save, (port) => port === API_PORT || ports.has(port));
