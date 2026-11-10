import {
  CALLER_PROOF_REQUIRED_CODE,
  CALLER_PROOF_REQUIRED_MESSAGE,
  CALLER_PROOF_STATUS_HEADER,
  CALLER_TOKEN_HEADER,
  type CallerProofIssuer,
  createCallerProofIssuer,
  isOpenWithoutCallerProof,
  SERVER_CALLER_PROOF_PATH,
} from "@cloudroom/config/caller-proof";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_ORIGIN = `http://${LOOPBACK_HOST}`;
const MAX_PROOF_BODY_BYTES = 1024;
const FINISH_PROOF_PATH = /^\/api\/v1\/caller-proofs\/([^/]+)$/u;

interface StartMachineAuthProxyOptions {
  // The remote daemon's data folder. Agents prove they can write it, like
  // the Mac's own server asks them to (docs/scopes/security.md).
  dataDir: string;
  serverHeaders: Record<string, string>;
  serverUrl: string;
  port?: number;
}

export interface MachineAuthProxy {
  serverUrl: string;
  close(): Promise<void>;
}

const BROWSER_REQUEST_HEADERS = ["origin", "sec-fetch-site"] as const;

const REJECTED_SOCKET_MESSAGES = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  405: "Method Not Allowed",
} as const;

type RejectedSocketStatus = keyof typeof REJECTED_SOCKET_MESSAGES;

type ProxyDecision =
  | { action: "reject"; status: 400 | 403 }
  | { action: "start-proof" }
  | { action: "finish-proof"; id: string }
  | { action: "require-proof"; proofStatus: "required" | "invalid" }
  | { action: "forward"; path: string };

function isBrowserRequest(headers: IncomingHttpHeaders): boolean {
  return BROWSER_REQUEST_HEADERS.some((name) => headers[name] !== undefined);
}

const LOOPBACK_AUTHORITY_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

function parseHostAuthority(
  host: string,
): { hostname: string; port: string } | null {
  try {
    const url = new URL(`http://${host}`);
    return url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0
      ? { hostname: url.hostname, port: url.port }
      : null;
  } catch {
    return null;
  }
}

function isProxyLoopbackAuthority(
  host: string | undefined,
  boundPort: number,
): boolean {
  if (host === undefined) {
    return false;
  }
  const parsed = parseHostAuthority(host);
  if (parsed === null) {
    return false;
  }
  const hostPort = parsed.port.length > 0 ? Number(parsed.port) : 80;
  return (
    hostPort === boundPort && LOOPBACK_AUTHORITY_HOSTNAMES.has(parsed.hostname)
  );
}

function isOriginFormTarget(target: string | undefined): target is string {
  return (
    target !== undefined && target.startsWith("/") && !target.startsWith("//")
  );
}

function writeRejectedSocket(
  socket: Duplex,
  status: RejectedSocketStatus,
  headers: Record<string, string> = {},
): void {
  const headerLines = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  // Node hands upgrade and CONNECT sockets over without an error listener;
  // a client reset while this is written would crash the daemon.
  socket.on("error", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${REJECTED_SOCKET_MESSAGES[status]}\r\n${headerLines}Connection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function rejectedProxyStatus(
  request: IncomingMessage,
  boundPort: number | null,
): Extract<RejectedSocketStatus, 400 | 403> | null {
  if (
    boundPort === null ||
    isBrowserRequest(request.headers) ||
    !isProxyLoopbackAuthority(request.headers.host, boundPort)
  ) {
    return 403;
  }
  if (!isOriginFormTarget(request.url)) {
    return 400;
  }
  return null;
}

// A target like `/\host` changes the origin, and `/\[` makes `new URL` throw.
function parseTarget(target: string): URL | null {
  try {
    const url = new URL(target, LOOPBACK_ORIGIN);
    return url.origin === LOOPBACK_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

// The Mac trusts every request that arrives with the machine key, so this is
// the only place that can tell a sandboxed agent from the user, or from
// another OS account on this machine. It applies the Mac server's own rule:
// a caller token, or one of the open requests from this OS user.
// The rule runs on the normalized path, and only that path is forwarded, so
// `..` or `%2e%2e` can't make a checked path reach a different route.
async function decide(
  request: IncomingMessage,
  boundPort: number | null,
  callerProofs: CallerProofIssuer,
): Promise<ProxyDecision> {
  const rejectedStatus = rejectedProxyStatus(request, boundPort);
  if (rejectedStatus !== null) {
    return { action: "reject", status: rejectedStatus };
  }
  const url = parseTarget(request.url ?? "/");
  if (url === null) {
    return { action: "reject", status: 400 };
  }
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "POST" && url.pathname === SERVER_CALLER_PROOF_PATH) {
    return { action: "start-proof" };
  }
  const finishId =
    method === "POST" ? FINISH_PROOF_PATH.exec(url.pathname)?.[1] : undefined;
  if (finishId !== undefined) {
    return { action: "finish-proof", id: finishId };
  }
  const header = request.headers[CALLER_TOKEN_HEADER];
  const token = Array.isArray(header) ? header.join(", ") : header;
  if (
    !callerProofs.verify(token) &&
    !(await isOpenWithoutCallerProof(method, url.pathname, request.socket))
  ) {
    return {
      action: "require-proof",
      proofStatus: token === undefined ? "required" : "invalid",
    };
  }
  return { action: "forward", path: `${url.pathname}${url.search}` };
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response
    .writeHead(status, { ...headers, "content-type": "application/json" })
    .end(JSON.stringify(body));
}

function readProofClaim(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROOF_BODY_BYTES) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => resolve(null));
    request.on("end", () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        const claim =
          typeof body === "object" && body !== null
            ? (body as { claim?: unknown }).claim
            : undefined;
        resolve(typeof claim === "string" ? claim : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function finishProof(
  request: IncomingMessage,
  response: ServerResponse,
  callerProofs: CallerProofIssuer,
  id: string,
): Promise<void> {
  const claim = await readProofClaim(request);
  const token = claim === null ? null : await callerProofs.finish(id, claim);
  if (token === null) {
    writeJson(
      response,
      403,
      { code: "caller_proof_failed", message: "Caller proof failed" },
      { connection: "close" },
    );
    return;
  }
  writeJson(response, 200, { token });
}

function openUpstreamRequest(
  request: IncomingMessage,
  target: URL,
  path: string,
  serverHeaders: Record<string, string>,
): http.ClientRequest {
  const requestFn = target.protocol === "https:" ? https.request : http.request;
  // The caller token is only valid here; it never leaves this machine.
  const headers: IncomingHttpHeaders = { ...request.headers };
  delete headers[CALLER_TOKEN_HEADER];
  return requestFn({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path,
    headers: {
      ...headers,
      host: target.host,
      ...serverHeaders,
    },
  });
}

async function proxyRequest(args: {
  boundPort: number | null;
  callerProofs: CallerProofIssuer;
  serverHeaders: Record<string, string>;
  request: IncomingMessage;
  response: ServerResponse;
  target: URL;
}): Promise<void> {
  const decision = await decide(
    args.request,
    args.boundPort,
    args.callerProofs,
  );
  switch (decision.action) {
    case "reject":
      args.response.writeHead(decision.status).end();
      return;
    case "start-proof":
      writeJson(args.response, 200, args.callerProofs.start());
      return;
    case "finish-proof":
      void finishProof(
        args.request,
        args.response,
        args.callerProofs,
        decision.id,
      ).catch(() => {
        if (!args.response.headersSent) args.response.writeHead(500);
        args.response.end();
      });
      return;
    case "require-proof":
      writeJson(
        args.response,
        401,
        {
          code: CALLER_PROOF_REQUIRED_CODE,
          message: CALLER_PROOF_REQUIRED_MESSAGE,
        },
        { [CALLER_PROOF_STATUS_HEADER]: decision.proofStatus },
      );
      return;
    case "forward":
      break;
  }
  // The caller may have left while its OS user was checked.
  if (args.request.socket.destroyed) return;

  const upstream = openUpstreamRequest(
    args.request,
    args.target,
    decision.path,
    args.serverHeaders,
  );
  upstream.once("response", (upstreamResponse) => {
    args.response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(args.response);
  });
  upstream.on("error", () => {
    if (!args.response.headersSent) {
      args.response.writeHead(502);
    }
    args.response.end();
  });
  args.request.pipe(upstream);
}

async function proxyUpgrade(args: {
  boundPort: number | null;
  callerProofs: CallerProofIssuer;
  clientSocket: Duplex;
  head: Buffer;
  serverHeaders: Record<string, string>;
  request: IncomingMessage;
  target: URL;
}): Promise<void> {
  // Node hands the socket over without an error listener; a client reset
  // while the caller is checked would crash the daemon.
  args.clientSocket.on("error", () => args.clientSocket.destroy());
  const decision = await decide(
    args.request,
    args.boundPort,
    args.callerProofs,
  );
  if (decision.action === "reject") {
    writeRejectedSocket(args.clientSocket, decision.status);
    return;
  }
  if (decision.action === "require-proof") {
    writeRejectedSocket(args.clientSocket, 401, {
      [CALLER_PROOF_STATUS_HEADER]: decision.proofStatus,
    });
    return;
  }
  if (decision.action !== "forward") {
    writeRejectedSocket(args.clientSocket, 400);
    return;
  }
  if (args.clientSocket.destroyed) return;

  const upstreamRequest = openUpstreamRequest(
    args.request,
    args.target,
    decision.path,
    args.serverHeaders,
  );
  upstreamRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    upstreamSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => args.clientSocket.destroy());
    args.clientSocket.on("close", () => upstreamSocket.destroy());
    if (args.clientSocket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    const statusLine = `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`;
    const headerLines = response.rawHeaders
      .reduce<string[]>((lines, value, index) => {
        if (index % 2 === 0)
          lines.push(`${value}: ${response.rawHeaders[index + 1] ?? ""}\r\n`);
        return lines;
      }, [])
      .join("");
    args.clientSocket.write(`${statusLine}${headerLines}\r\n`);
    if (upstreamHead.length > 0) args.clientSocket.write(upstreamHead);
    if (args.head.length > 0) upstreamSocket.write(args.head);
    upstreamSocket.pipe(args.clientSocket).pipe(upstreamSocket);
  });
  upstreamRequest.on("response", () =>
    writeRejectedSocket(args.clientSocket, 400),
  );
  upstreamRequest.on("error", () => args.clientSocket.destroy());
  args.clientSocket.on("close", () => upstreamRequest.destroy());
  upstreamRequest.end();
}

export async function startMachineAuthProxy(
  options: StartMachineAuthProxyOptions,
): Promise<MachineAuthProxy> {
  const target = new URL(options.serverUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(
      `Unsupported machine proxy server protocol: ${target.protocol}`,
    );
  }
  const callerProofs = await createCallerProofIssuer({
    dataDir: options.dataDir,
  });
  const sockets = new Set<Socket>();
  let boundPort: number | null = null;
  const server = http.createServer((request, response) => {
    void proxyRequest({
      boundPort,
      callerProofs,
      serverHeaders: options.serverHeaders,
      request,
      response,
      target,
    }).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("connect", (_request, socket) => writeRejectedSocket(socket, 405));
  server.on("upgrade", (request, socket, head) => {
    void proxyUpgrade({
      boundPort,
      callerProofs,
      clientSocket: socket,
      head,
      serverHeaders: options.serverHeaders,
      request,
      target,
    }).catch(() => socket.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, LOOPBACK_HOST);
  });

  const address = server.address() as AddressInfo;
  boundPort = address.port;
  return {
    serverUrl: `http://${LOOPBACK_HOST}:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
