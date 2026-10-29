import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type {
  TerminalPtyDisposable,
  TerminalPtyExit,
  TerminalPtyProcess,
} from "./terminal-manager.js";

const OUTPUT = 0;
const EXIT = 1;
const HELLO = 2;
const PING = 3;
const INPUT = 0;
const RESIZE = 1;
const PING_INTERVAL_MS = 25_000;
const SILENCE_LIMIT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_FIRST_MS = 500;
const RETRY_MAX_MS = 10_000;
const GIVE_UP_MS = 60 * 60_000;
const LOST_NOTICE =
  "\r\n\u001b[2mConnection to the cloud sandbox lost. Reconnecting…\u001b[0m\r\n";
const BACK_NOTICE = "\u001b[2mReconnected.\u001b[0m\r\n";

export interface CloudTerminalTarget {
  gateToken?: string;
  session: string | null;
  token: string;
  url: string;
}

export interface OpenCloudPtyArgs {
  cols: number;
  command: string | null;
  rows: number;
  target: CloudTerminalTarget;
  terminalId: string;
}

export interface CloudPty {
  cwd: string;
  pty: TerminalPtyProcess;
  shell: string;
}

interface Hello {
  cwd: string;
  offset: number;
  shell: string;
}

export class CloudTerminalError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

function headers(target: CloudTerminalTarget): Record<string, string> {
  return {
    Authorization: `Bearer ${target.token}`,
    "X-Cloudroom-Token": target.token,
    ...(target.gateToken ? { Cookie: `_port_auth=${target.gateToken}` } : {}),
  };
}

function terminalUrl(
  args: OpenCloudPtyArgs,
  query: Record<string, string>,
): URL {
  const url = new URL(
    `/v1/terminals/${encodeURIComponent(args.terminalId)}`,
    args.target.url,
  );
  url.search = new URLSearchParams(query).toString();
  return url;
}

function refusal(status: number, body: string): CloudTerminalError {
  let error: unknown = null;
  try {
    error = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    error = null;
  }
  if (status === 404 && typeof error !== "string") {
    return new CloudTerminalError(
      "This cloud sandbox runs a Cloudroom version without terminals. It updates on its own; try again after the next update.",
      status,
    );
  }
  return new CloudTerminalError(
    `The cloud sandbox refused the terminal (HTTP ${status}): ${typeof error === "string" ? error : body.slice(0, 500) || "no details"}`,
    status,
  );
}

function connect(
  args: OpenCloudPtyArgs,
  query: Record<string, string>,
): Promise<{ head: Buffer; socket: Socket }> {
  const url = terminalUrl(args, query);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(url, {
      headers: {
        ...headers(args.target),
        Connection: "Upgrade",
        Upgrade: "websocket",
      },
      method: "GET",
      timeout: CONNECT_TIMEOUT_MS,
    });
    request.on("upgrade", (_response, socket, head) => {
      socket.setNoDelay(true);
      socket.setTimeout(0);
      resolve({ head, socket });
    });
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => reject(refusal(response.statusCode ?? 0, body)));
      response.on("error", reject);
    });
    request.on("timeout", () =>
      request.destroy(
        new CloudTerminalError(
          `The cloud sandbox did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds`,
          null,
        ),
      ),
    );
    request.on("error", (error) =>
      reject(
        error instanceof CloudTerminalError
          ? error
          : new CloudTerminalError(
              `The cloud sandbox is unreachable: ${error.message}`,
              null,
            ),
      ),
    );
    request.end();
  });
}

function shellGone(error: unknown): boolean {
  return (
    error instanceof CloudTerminalError &&
    error.status !== null &&
    error.status < 500 &&
    error.status !== 429
  );
}

function closeRemote(args: OpenCloudPtyArgs): void {
  const url = terminalUrl(args, {});
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const request = send(url, {
    headers: headers(args.target),
    method: "DELETE",
    timeout: CONNECT_TIMEOUT_MS,
  });
  request.on("response", (response) => response.resume());
  request.on("timeout", () => request.destroy());
  request.on("error", () => undefined);
  request.end();
}

function frame(kind: number, data: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(data.byteLength, 1);
  return Buffer.concat([header, data]);
}

function resizeFrame(cols: number, rows: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(cols, 0);
  data.writeUInt16BE(rows, 2);
  return frame(RESIZE, data);
}

class Connection {
  private buffer = Buffer.alloc(0);
  private lastHeard = Date.now();
  private readonly ping: ReturnType<typeof setInterval>;

  constructor(
    readonly socket: Socket,
    private readonly onFrame: (kind: number, data: Buffer) => void,
    onClose: () => void,
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => {
      clearInterval(this.ping);
      onClose();
    });
    socket.on("error", () => socket.destroy());
    this.ping = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) {
        socket.destroy();
        return;
      }
      this.send(frame(PING, Buffer.alloc(0)));
    }, PING_INTERVAL_MS);
  }

  send(data: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(data);
  }

  close(): void {
    clearInterval(this.ping);
    this.socket.destroy();
  }

  receive(chunk: Buffer): void {
    this.lastHeard = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.byteLength >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.byteLength < 5 + length) return;
      const kind = this.buffer.readUInt8(0);
      const data = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      this.onFrame(kind, data);
    }
  }
}

export async function openCloudPty(args: OpenCloudPtyArgs): Promise<CloudPty> {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: TerminalPtyExit) => void>();
  const queuedData: string[] = [];
  let queuedExit: TerminalPtyExit | null = null;
  const decoder = new StringDecoder("utf8");
  const pendingInput: Buffer[] = [];
  let received = 0;
  let size = { cols: args.cols, rows: args.rows };
  let connection: Connection | null = null;
  let reconnecting = false;
  let ended = false;
  let exitConfirmed = false;
  let closing = false;

  const emit = (text: string) => {
    if (text.length === 0) return;
    if (dataListeners.size === 0) queuedData.push(text);
    else for (const listener of dataListeners) listener(text);
  };

  const end = (exitCode: number | null) => {
    if (ended) return;
    ended = true;
    emit(decoder.end());
    connection?.close();
    connection = null;
    const event = { exitCode };
    if (exitListeners.size === 0) queuedExit = event;
    else for (const listener of exitListeners) listener(event);
  };

  const attach = async (since: number, opening: boolean): Promise<Hello> => {
    const { head, socket } = await connect(args, {
      cols: String(size.cols),
      rows: String(size.rows),
      since: String(since),
      ...(args.target.session ? { session: args.target.session } : {}),
      ...(opening && args.command !== null ? { command: args.command } : {}),
    });
    return new Promise<Hello>((resolve, reject) => {
      let hello: Hello | null = null;
      const current: Connection = new Connection(
        socket,
        (kind, data) => {
          if (kind === HELLO) {
            hello = JSON.parse(data.toString("utf8")) as Hello;
            received = hello.offset;
            if (ended) {
              socket.destroy();
            } else {
              connection = current;
              current.send(resizeFrame(size.cols, size.rows));
              for (const input of pendingInput.splice(0)) {
                current.send(frame(INPUT, input));
              }
            }
            resolve(hello);
          } else if (hello !== null && kind === OUTPUT) {
            received += data.byteLength;
            emit(decoder.write(data));
          } else if (hello !== null && kind === EXIT) {
            exitConfirmed = true;
            end(
              (JSON.parse(data.toString("utf8")) as { code: number | null })
                .code,
            );
          }
        },
        () => {
          if (hello === null) {
            reject(
              new CloudTerminalError(
                "The cloud terminal closed before it started",
                null,
              ),
            );
          } else if (connection === current) {
            connection = null;
            void reconnect();
          }
        },
      );
      current.receive(head);
    });
  };

  const reconnect = async () => {
    if (reconnecting || ended || closing) return;
    reconnecting = true;
    emit(LOST_NOTICE);
    const giveUpAt = Date.now() + GIVE_UP_MS;
    let delay = RETRY_FIRST_MS;
    while (!ended && !closing) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (ended || closing) break;
      try {
        await attach(received, false);
        if (!ended) emit(BACK_NOTICE);
        break;
      } catch (error) {
        if (shellGone(error) || Date.now() > giveUpAt) {
          end(null);
          break;
        }
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
    reconnecting = false;
  };

  const hello = await attach(0, true);
  const pty: TerminalPtyProcess = {
    dispose: () => {
      ended = true;
      connection?.close();
      connection = null;
      if (exitConfirmed) closeRemote(args);
    },
    kill: () => {
      closing = true;
      closeRemote(args);
      if (connection === null) end(null);
    },
    onData: (listener): TerminalPtyDisposable => {
      dataListeners.add(listener);
      for (const text of queuedData.splice(0)) listener(text);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener): TerminalPtyDisposable => {
      exitListeners.add(listener);
      const event = queuedExit;
      queuedExit = null;
      if (event !== null) listener(event);
      return { dispose: () => exitListeners.delete(listener) };
    },
    resize: (cols, rows) => {
      size = { cols, rows };
      connection?.send(resizeFrame(cols, rows));
    },
    write: (data) => {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      if (connection === null) pendingInput.push(bytes);
      else connection.send(frame(INPUT, bytes));
    },
  };
  return { cwd: hello.cwd, pty, shell: hello.shell };
}
