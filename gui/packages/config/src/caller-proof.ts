import { execFile } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { endianness } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { isLoopbackHostname } from "./loopback.js";

export const CALLER_TOKEN_HEADER = "x-cloudroom-caller";
export const CALLER_PROOF_STATUS_HEADER = "x-cloudroom-caller-proof";
export const CALLER_PROOF_REQUIRED_CODE = "caller_proof_required";
export const CALLER_PROOF_REQUIRED_MESSAGE =
  "Cloudroom refused this request because the caller could not prove it runs outside a sandbox. If a sandboxed agent sent it, run the command outside the sandbox (the user must approve it), or switch the thread to Full access.";
export const CALLER_PROOF_TIMED_OUT_MESSAGE =
  "Cloudroom's caller proof timed out while Cloudroom was busy or reconnecting, so this request was not run. Wait a moment and run it again; if it keeps happening in a sandboxed thread, the sandbox may be the cause.";
export const CALLER_PROOF_DIRECTORY_NAME = "caller-proofs";
export const SERVER_CALLER_PROOF_PATH = "/api/v1/caller-proofs";
export const DAEMON_CALLER_PROOF_PATH = "/caller-proofs";

const PROOF_MAX_AGE_MS = 30_000;
const STALE_PROOF_FILE_MS = 2 * PROOF_MAX_AGE_MS;
const MAX_CLAIM_LENGTH = 64;
const TOKEN_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_TOKENS = 10_000;
const MAX_TOKEN_LENGTH = 128;
const MAX_PROOF_FILE_BYTES = 256;
const PROOF_ID_PATTERN = /^[0-9a-f]{12}-[0-9a-f]{32}$/u;

const OPEN_POSTS = [
  /^\/api\/v1\/caller-proofs$/u,
  /^\/api\/v1\/caller-proofs\/[^/]+$/u,
];

const OPEN_READS = [
  /^\/api\/v1\/system\/(?:config|version)$/u,
  /^\/api\/v1\/plugins(?:\/contributions)?$/u,
  /^\/api\/v1\/projects\/[^/]+$/u,
  /^\/api\/v1\/threads$/u,
  /^\/api\/v1\/threads\/[^/]+$/u,
  /^\/api\/v1\/threads\/[^/]+\/(?:timeline|output|events|events\/wait)$/u,
  /^\/api\/v1\/environments\/[^/]+$/u,
  /^\/api\/v1\/cloudroom\/account\/mcp\/callback$/u,
  /^\/api\/v1\/file-previews\/[^/]+\/.+$/u,
];

// The TCP connection a request arrived on (a `net.Socket`).
export interface CallerPeer {
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
}

type TcpTables = readonly [tcp: string | null, tcp6: string | null];

const PROC_NET_TCP = ["/proc/net/tcp", "/proc/net/tcp6"] as const;
const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

function addressBytes(text: string): number[] | null {
  const address = text.split("%")[0] ?? "";
  if (isIPv4(address)) return address.split(".").map(Number);
  if (!isIPv6(address)) return null;
  const words = (part: string | undefined) =>
    part
      ? part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [Number.parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  const [head, tail] = address.split("::");
  const front = words(head);
  const back = words(tail);
  const zeros = new Array<number>(
    Math.max(0, 8 - front.length - back.length),
  ).fill(0);
  return [...front, ...zeros, ...back].flatMap((word) => [
    word >> 8,
    word & 0xff,
  ]);
}

// /proc writes an address as 32-bit words, each one in host byte order.
function procEndpoint(bytes: number[], port: number): string {
  let hex = "";
  for (let at = 0; at < bytes.length; at += 4) {
    const word = bytes.slice(at, at + 4);
    if (endianness() === "LE") word.reverse();
    hex += word.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${hex}:${port.toString(16).padStart(4, "0")}`.toUpperCase();
}

const tableIndexes = new WeakMap<
  TcpTables,
  Map<number, Map<string, number[]>>
>();

// Each read is parsed once per port we listen on, however many lookups share
// it, and only rows that mention that port. Rows with inode 0 (TIME_WAIT)
// have no socket behind them, so they are left out.
function indexTcpTables(
  tables: TcpTables,
  port: number,
): Map<string, number[]> {
  let byPort = tableIndexes.get(tables);
  if (byPort === undefined) {
    byPort = new Map();
    tableIndexes.set(tables, byPort);
  }
  let index = byPort.get(port);
  if (index === undefined) {
    index = new Map();
    const portText = `${procEndpoint([], port)} `;
    for (const [table, rows] of tables.entries()) {
      for (const row of rows?.split("\n") ?? []) {
        if (!row.includes(portText)) continue;
        // sl, local, remote, state, queues, timer, retransmits, uid, timeout, inode
        const fields = row.trim().split(/\s+/u);
        if (fields.length < 10 || fields[9] === "0") continue;
        const key = `${table} ${fields[1]} ${fields[2]}`;
        const owners = index.get(key) ?? [];
        owners.push(Number(fields[7]));
        index.set(key, owners);
      }
    }
    byPort.set(port, index);
  }
  return index;
}

// The uid that owns the caller's end of this connection: the one live row in
// the kernel's TCP tables whose local end is the caller and whose remote end
// is us. An IPv4 socket is listed in `tcp`, an IPv6 one (also with an
// IPv4-mapped address) in `tcp6`. Null when no row, or more than one, matches.
export function tcpConnectionOwner(
  peer: CallerPeer,
  tables: TcpTables,
): number | null {
  const { localAddress, localPort, remoteAddress, remotePort } = peer;
  if (
    localAddress === undefined ||
    localPort === undefined ||
    remoteAddress === undefined ||
    remotePort === undefined
  ) {
    return null;
  }
  const caller = addressBytes(remoteAddress);
  const ours = addressBytes(localAddress);
  if (caller === null || ours === null) return null;
  const asV6 = (bytes: number[]) =>
    bytes.length === 4 ? [...IPV4_MAPPED_PREFIX, ...bytes] : bytes;
  const asV4 = (bytes: number[]) =>
    bytes.length === 4
      ? bytes
      : IPV4_MAPPED_PREFIX.every((byte, at) => bytes[at] === byte)
        ? bytes.slice(12)
        : null;
  const callerV4 = asV4(caller);
  const oursV4 = asV4(ours);
  const index = indexTcpTables(tables, localPort);
  const owners = [
    ...(callerV4 === null || oursV4 === null
      ? []
      : (index.get(
          `0 ${procEndpoint(callerV4, remotePort)} ${procEndpoint(oursV4, localPort)}`,
        ) ?? [])),
    ...(index.get(
      `1 ${procEndpoint(asV6(caller), remotePort)} ${procEndpoint(asV6(ours), localPort)}`,
    ) ?? []),
  ];
  return owners.length === 1 ? (owners[0] ?? null) : null;
}

function readTcpTables(): TcpTables {
  const read = (path: string) => {
    try {
      return readFileSync(path, "latin1");
    } catch {
      return null;
    }
  };
  return [read(PROC_NET_TCP[0]), read(PROC_NET_TCP[1])];
}

let tableWaiters: Array<(tables: TcpTables) => void> = [];

// One read of the tables per turn of the event loop, shared by every lookup
// waiting for it, so new connections can't make us read them more often. A
// read that started before a connection opened can't vouch for it, so each
// lookup waits for the next one. Sync, like the proof file: an async read
// waits behind Node's busy thread pool (#939).
function nextTcpTables(): Promise<TcpTables> {
  return new Promise((resolve) => {
    if (tableWaiters.push(resolve) > 1) return;
    setImmediate(() => {
      const waiters = tableWaiters;
      tableWaiters = [];
      const tables = readTcpTables();
      for (const waiter of waiters) waiter(tables);
    });
  });
}

const LSOF = "/usr/sbin/lsof";
const LSOF_TIMEOUT_MS = 5_000;
const LSOF_MAX_BYTES = 8 * 1024 * 1024;

// One form for an address however it is written: `[::1]`, `::ffff:127.0.0.1`.
function comparableAddress(text: string): string | null {
  const bytes = addressBytes(text.replace(/^\[|\]$/gu, ""));
  if (bytes === null) return null;
  const mapped =
    bytes.length === 16 &&
    IPV4_MAPPED_PREFIX.every((byte, at) => bytes[at] === byte);
  return (mapped ? bytes.slice(12) : bytes).join(".");
}

// macOS has no table of socket owners. `lsof -u <uid> -Fn` lists that user's
// sockets, one `n<from>:<port>-><to>:<port>` line each. The caller runs as
// that user only when its end of this connection is listed: from the caller,
// to us. Anything else, an empty listing included, is no.
export function lsofListsCaller(peer: CallerPeer, listing: string): boolean {
  const { localAddress, localPort, remoteAddress, remotePort } = peer;
  if (
    localAddress === undefined ||
    localPort === undefined ||
    remoteAddress === undefined ||
    remotePort === undefined
  ) {
    return false;
  }
  const caller = comparableAddress(remoteAddress);
  const ours = comparableAddress(localAddress);
  if (caller === null || ours === null) return false;
  return listing.split("\n").some((line) => {
    const socket = /^n(.+):(\d+)->(.+):(\d+)$/u.exec(line);
    return (
      socket !== null &&
      Number(socket[2]) === remotePort &&
      Number(socket[4]) === localPort &&
      comparableAddress(socket[1] ?? "") === caller &&
      comparableAddress(socket[3] ?? "") === ours
    );
  });
}

interface LsofQueue {
  running: boolean;
  waiting: Array<(listing: string) => void>;
}

const lsofQueues = new Map<number, LsofQueue>();

function runLsof(port: number, uid: number, queue: LsofQueue): void {
  const waiters = queue.waiting;
  queue.waiting = [];
  execFile(
    LSOF,
    ["-nP", "-a", "-u", String(uid), `-iTCP:${port}`, "-Fn"],
    { maxBuffer: LSOF_MAX_BYTES, timeout: LSOF_TIMEOUT_MS },
    // lsof exits 1 when it lists nothing. Its output is the answer either way:
    // a failed or cut-short run lists no caller, so the caller is refused.
    (_error, stdout) => {
      for (const waiter of waiters) waiter(stdout);
      if (queue.waiting.length > 0) runLsof(port, uid, queue);
      else queue.running = false;
    },
  );
}

// One lsof at a time per port (about 70 ms on a busy Mac), shared by every
// lookup that was waiting when it started. A run that started before a
// connection opened can't vouch for it, so later lookups wait for the next.
function nextLsofListing(port: number, uid: number): Promise<string> {
  const queue = lsofQueues.get(port) ?? { running: false, waiting: [] };
  lsofQueues.set(port, queue);
  return new Promise((resolve) => {
    queue.waiting.push(resolve);
    if (queue.running) return;
    queue.running = true;
    setImmediate(() => runLsof(port, uid, queue));
  });
}

const peerUserChecks = new WeakMap<CallerPeer, Promise<boolean>>();

// Every OS account on a computer can reach its loopback, so the open reads
// need a caller that runs as this OS user. Linux names each socket's owner,
// and on macOS lsof lists this user's sockets. Windows can't tell cheaply,
// so there every local caller still gets them (docs/scopes/security.md).
// One lookup per connection.
function runsAsThisOsUser(peer: CallerPeer): Promise<boolean> {
  const uid = process.getuid?.();
  const { platform } = process;
  if ((platform !== "linux" && platform !== "darwin") || uid === undefined) {
    return Promise.resolve(true);
  }
  let check = peerUserChecks.get(peer);
  if (check === undefined) {
    check =
      platform === "linux"
        ? nextTcpTables().then(
            (tables) => tcpConnectionOwner(peer, tables) === uid,
          )
        : peer.localPort === undefined
          ? Promise.resolve(false)
          : nextLsofListing(peer.localPort, uid).then((listing) =>
              lsofListsCaller(peer, listing),
            );
    peerUserChecks.set(peer, check);
  }
  return check;
}

// The requests a caller without a token may make. The Mac's server and a
// remote machine's agent proxy both use this list. `peer` is the loopback
// connection the request came on; null skips the OS user check (no socket,
// or a request from another computer).
export async function isOpenWithoutCallerProof(
  method: string,
  path: string,
  peer: CallerPeer | null,
): Promise<boolean> {
  const verb = method.toUpperCase();
  if (verb === "POST") {
    return OPEN_POSTS.some((pattern) => pattern.test(path));
  }
  return (
    (verb === "GET" || verb === "HEAD") &&
    OPEN_READS.some((pattern) => pattern.test(path)) &&
    (peer === null || (await runsAsThisOsUser(peer)))
  );
}

export interface StartedCallerProof {
  claim: string;
  directory: string;
  id: string;
}

export interface CallerProofIssuer {
  readonly directory: string;
  start(): StartedCallerProof;
  finish(id: string, claim: string): Promise<string | null>;
  verify(token: string | undefined): boolean;
  issueInternal(): string;
}

interface CreateCallerProofIssuerArgs {
  dataDir: string;
  now?: () => number;
}

function ownedByThisUser(stats: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stats.uid === uid;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function prepareProofDirectory(dataDir: string): Promise<string> {
  const directory = join(dataDir, CALLER_PROOF_DIRECTORY_NAME);
  const existing = await lstat(directory).catch(() => null);
  if (existing !== null && !existing.isDirectory()) {
    await rm(directory, { force: true });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const prepared = await lstat(directory);
  if (!prepared.isDirectory() || !ownedByThisUser(prepared)) {
    throw new Error(`${directory} must be a directory owned by this user`);
  }
  await chmod(directory, 0o700);
  const staleBefore = Date.now() - STALE_PROOF_FILE_MS;
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const stats = await lstat(path).catch(() => null);
    if (stats !== null && stats.mtimeMs < staleBefore) {
      await rm(path, { force: true, recursive: true });
    }
  }
  return directory;
}

// Sync on purpose: microseconds on a tiny local file. Async calls wait in
// Node's shared thread pool behind compression, file reads, and DNS; on a busy
// Mac that held a proof for 40+ s while plain reads stayed fast (#939).
// O_NONBLOCK keeps a FIFO planted at the path from blocking the event loop.
function readProofFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size > MAX_PROOF_FILE_BYTES ||
      !ownedByThisUser(stats)
    ) {
      return null;
    }
    const buffer = Buffer.alloc(MAX_PROOF_FILE_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

export async function createCallerProofIssuer(
  args: CreateCallerProofIssuerArgs,
): Promise<CallerProofIssuer> {
  const now = args.now ?? Date.now;
  const directory = await prepareProofDirectory(args.dataDir);
  const secret = randomBytes(32);
  const finished = new Map<string, number>();
  const tokens = new Map<string, number>();
  const internalTokens = new Set<string>();

  const sign = (id: string) =>
    createHmac("sha256", secret).update(id).digest("base64url");

  const issue = (): string => {
    const token = randomBytes(32).toString("base64url");
    tokens.set(sha256(token), now());
    while (tokens.size > MAX_TOKENS) {
      const oldest = tokens.keys().next().value;
      if (oldest === undefined) break;
      tokens.delete(oldest);
    }
    return token;
  };

  return {
    directory,
    start() {
      const id = `${now().toString(16).padStart(12, "0")}-${randomBytes(16).toString("hex")}`;
      return { claim: sign(id), directory, id };
    },
    async finish(id, claim) {
      if (
        !PROOF_ID_PATTERN.test(id) ||
        claim.length > MAX_CLAIM_LENGTH ||
        !sameText(claim, sign(id))
      ) {
        return null;
      }
      const age = now() - Number.parseInt(id.slice(0, 12), 16);
      for (const [usedId, usedAt] of finished) {
        if (now() - usedAt > PROOF_MAX_AGE_MS) finished.delete(usedId);
      }
      if (age < 0 || age > PROOF_MAX_AGE_MS || finished.has(id)) return null;
      finished.set(id, now());
      const path = join(directory, id);
      if (readProofFile(path) !== id) {
        finished.delete(id);
        return null;
      }
      try {
        unlinkSync(path);
      } catch {
        // The caller removes it too; a stale file is swept at startup.
      }
      return issue();
    },
    verify(token) {
      if (token === undefined || token.length > MAX_TOKEN_LENGTH) return false;
      const key = sha256(token);
      if (internalTokens.has(key)) return true;
      const lastUsedAt = tokens.get(key);
      if (lastUsedAt === undefined) return false;
      tokens.delete(key);
      if (now() - lastUsedAt > TOKEN_IDLE_MS) return false;
      tokens.set(key, now());
      return true;
    },
    issueInternal() {
      const token = randomBytes(32).toString("base64url");
      internalTokens.add(sha256(token));
      return token;
    },
  };
}

function parseStartedProof(value: unknown): StartedCallerProof | null {
  if (typeof value !== "object" || value === null) return null;
  const { claim, directory, id } = value as Record<string, unknown>;
  if (
    typeof claim !== "string" ||
    claim.length === 0 ||
    claim.length > MAX_CLAIM_LENGTH ||
    typeof directory !== "string" ||
    typeof id !== "string" ||
    !PROOF_ID_PATTERN.test(id) ||
    !isAbsolute(directory) ||
    basename(directory) !== CALLER_PROOF_DIRECTORY_NAME
  ) {
    return null;
  }
  return { claim, directory, id };
}

async function isOwnedDirectory(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => null);
  return stats !== null && stats.isDirectory() && ownedByThisUser(stats);
}

export interface ProveLocalCallerArgs {
  baseUrl: string;
  fetch?: typeof fetch;
  proofPath: string;
  signal?: AbortSignal;
}

// A machine daemon's agent proxy listens on a new port each start. It writes
// that URL here so room-cli in a plain shell, cron or launchd job finds it
// without thread env (#1564).
export const MACHINE_PROXY_URL_FILE_NAME = "machine-proxy-url";

export function readMachineProxyUrl(dataDir: string): string | null {
  const raw = readProofFile(join(dataDir, MACHINE_PROXY_URL_FILE_NAME))?.trim();
  return raw !== undefined && isLocalCallerProofTarget(raw)
    ? new URL(raw).origin
    : null;
}

export function isLocalCallerProofTarget(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

type ProofAttempt = { token: string } | { retry: string } | null;

async function attemptProof(args: ProveLocalCallerArgs): Promise<ProofAttempt> {
  if (!isLocalCallerProofTarget(args.baseUrl)) return null;
  const fetchImpl = args.fetch ?? fetch;
  const post = (path: string, body: unknown) =>
    fetchImpl(new URL(path, args.baseUrl), {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      ...(args.signal ? { signal: args.signal } : {}),
    });
  try {
    const startResponse = await post(args.proofPath, {});
    if (!startResponse.ok) return null;
    const started = parseStartedProof(await startResponse.json());
    if (started === null || !(await isOwnedDirectory(started.directory))) {
      return null;
    }
    const filePath = join(started.directory, started.id);
    try {
      await writeFile(filePath, started.id, { flag: "wx", mode: 0o600 });
    } catch {
      return null;
    }
    try {
      const finishResponse = await post(`${args.proofPath}/${started.id}`, {
        claim: started.claim,
      });
      if (!finishResponse.ok) {
        return { retry: `was refused (${finishResponse.status})` };
      }
      const body: unknown = await finishResponse.json();
      const token =
        typeof body === "object" && body !== null
          ? (body as { token?: unknown }).token
          : undefined;
      return typeof token === "string" ? { token } : null;
    } finally {
      await unlink(filePath).catch(() => {});
    }
  } catch (error) {
    const timedOut =
      args.signal?.aborted === true ||
      (error instanceof Error && error.name.endsWith("TimeoutError"));
    return timedOut ? { retry: "timed out" } : null;
  }
}

export async function proveLocalCaller(
  args: ProveLocalCallerArgs,
): Promise<string | null> {
  const attempt = await attemptProof(args);
  return attempt !== null && "token" in attempt ? attempt.token : null;
}

export const CALLER_PROOF_WAIT_MS = 50_000;
const FIRST_PROOF_RETRY_DELAY_MS = 1_000;
const FAILED_PROOF_RETRY_MS = 2_000;

interface ProofResult {
  timedOut?: boolean;
  token: string | null;
}

async function proveWithRetries(
  baseUrl: string,
  fetchImpl: typeof fetch,
  proofPath: string,
): Promise<ProofResult> {
  const deadline = Date.now() + CALLER_PROOF_WAIT_MS;
  let warned = false;
  for (let delay = FIRST_PROOF_RETRY_DELAY_MS; ; delay *= 2) {
    const startedAt = Date.now();
    // No 30 s cap per attempt: time queued on a busy server before it issues
    // the challenge counted against that cap, so every attempt was aborted
    // even when the server would have accepted it (#939). A proof that really
    // got too old is refused, and that retries.
    const attempt = await attemptProof({
      baseUrl,
      fetch: fetchImpl,
      proofPath,
      signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
    });
    if (attempt === null) return { token: null };
    if ("token" in attempt) {
      if (warned) console.warn("Cloudroom caller proof succeeded on retry");
      return { token: attempt.token };
    }
    warned = true;
    const retrying = Date.now() + delay < deadline;
    console.warn(
      `Cloudroom caller proof ${attempt.retry}; ${retrying ? `retrying in ${delay / 1_000} s` : "giving up"}`,
    );
    if (!retrying) {
      // A refusal counts as a timeout when a busy server used up the budget,
      // such as a proof that aged past 30 s on its way through (#1285).
      const timedOut =
        attempt.retry === "timed out" ||
        deadline - Date.now() < Date.now() - startedAt;
      return { timedOut, token: null };
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

interface CachedCallerToken {
  proof: Promise<ProofResult>;
  settledAt?: number;
  value?: string | null;
}

interface ProvenTokenOptions {
  force?: boolean;
  proofPath?: string;
  rejected?: string | null;
}

const callerTokens = new Map<string, CachedCallerToken>();

function keepsCachedToken(
  cached: CachedCallerToken,
  options: ProvenTokenOptions,
): boolean {
  if (cached.value === undefined) return true;
  if (cached.value === null) {
    return (
      options.force !== true &&
      Date.now() - (cached.settledAt ?? 0) < FAILED_PROOF_RETRY_MS
    );
  }
  if (options.force === true) return false;
  return !("rejected" in options) || cached.value !== options.rejected;
}

function provenProof(
  origin: string,
  fetchImpl: typeof fetch,
  options: ProvenTokenOptions = {},
): Promise<ProofResult> {
  const cached = callerTokens.get(origin);
  if (cached !== undefined && keepsCachedToken(cached, options)) {
    return cached.proof;
  }
  const entry: CachedCallerToken = {
    proof: proveWithRetries(
      origin,
      fetchImpl,
      options.proofPath ?? SERVER_CALLER_PROOF_PATH,
    ).then((result) => {
      entry.value = result.token;
      entry.settledAt = Date.now();
      return result;
    }),
  };
  callerTokens.set(origin, entry);
  return entry.proof;
}

async function provenToken(
  origin: string,
  fetchImpl: typeof fetch,
  options: ProvenTokenOptions = {},
): Promise<string | null> {
  return (await provenProof(origin, fetchImpl, options)).token;
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
}

function canReplay(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): boolean {
  if (input instanceof Request) return false;
  const body = init?.body;
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData
  );
}

function withCallerToken(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  token: string | null | undefined,
): RequestInit | undefined {
  if (token === null || token === undefined) return init;
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  headers.set(CALLER_TOKEN_HEADER, token);
  return { ...init, headers };
}

export function isCallerProofRequired(response: Response): boolean {
  const status = response.headers.get(CALLER_PROOF_STATUS_HEADER);
  return (
    response.status === 401 && (status === "required" || status === "invalid")
  );
}

function callerProofTimedOutResponse(): Response {
  return new Response(
    JSON.stringify({
      code: CALLER_PROOF_REQUIRED_CODE,
      message: CALLER_PROOF_TIMED_OUT_MESSAGE,
    }),
    {
      headers: {
        "content-type": "application/json",
        [CALLER_PROOF_STATUS_HEADER]: "required",
      },
      status: 401,
    },
  );
}

// A refusal after this request's own proof timed out says Cloudroom was busy
// or reconnecting, instead of the sandbox advice (#1285).
async function explainTimedOutProof(
  proof: ProofResult | undefined,
  response: Response,
): Promise<Response> {
  if (proof?.timedOut !== true || !isCallerProofRequired(response)) {
    return response;
  }
  await response.body?.cancel().catch(() => {});
  return callerProofTimedOutResponse();
}

export function createCallerProofFetch(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (
      url === null ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.pathname.startsWith(SERVER_CALLER_PROOF_PATH) ||
      new Headers(init?.headers).has(CALLER_TOKEN_HEADER) ||
      (input instanceof Request && input.headers.has(CALLER_TOKEN_HEADER))
    ) {
      return fetchImpl(input, init);
    }
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const unsafe = method !== "GET" && method !== "HEAD";
    const proof =
      unsafe || callerTokens.has(url.origin)
        ? await provenProof(url.origin, fetchImpl)
        : undefined;
    const token = proof?.token;
    // Sent without a token, it would only be refused, and a server too busy
    // to prove may never answer it, leaving the caller hanging (#1285).
    if (unsafe && proof?.timedOut === true) {
      return callerProofTimedOutResponse();
    }
    const response = await fetchImpl(
      input,
      withCallerToken(input, init, token),
    );
    // `null` means this request's proof just failed; proving again would only
    // wait another 50 s for the same answer (#939).
    if (
      token === null ||
      !isCallerProofRequired(response) ||
      !canReplay(input, init)
    ) {
      return explainTimedOutProof(proof, response);
    }
    const fresh = await provenProof(url.origin, fetchImpl, {
      rejected: token ?? null,
    });
    if (fresh.token === null || fresh.token === token) {
      return explainTimedOutProof(fresh, response);
    }
    await response.body?.cancel().catch(() => {});
    return fetchImpl(input, withCallerToken(input, init, fresh.token));
  };
  return wrapped as typeof fetch;
}

export function callerTokenFor(
  baseUrl: string,
  options: { force?: boolean; proofPath?: string } = {},
): Promise<string | null> {
  return provenToken(new URL(baseUrl).origin, fetch, options);
}

export function renewCallerToken(
  baseUrl: string,
  rejected: string | null,
  proofPath: string = SERVER_CALLER_PROOF_PATH,
): Promise<string | null> {
  return provenToken(new URL(baseUrl).origin, fetch, { proofPath, rejected });
}
