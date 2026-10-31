import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isLoopbackHostname } from "./loopback.js";

export const CALLER_TOKEN_HEADER = "x-cloudroom-caller";
export const CALLER_PROOF_STATUS_HEADER = "x-cloudroom-caller-proof";
export const CALLER_PROOF_REQUIRED_CODE = "caller_proof_required";
export const CALLER_PROOF_REQUIRED_MESSAGE =
  "Cloudroom refused this request because the caller could not prove it runs outside a sandbox. If a sandboxed agent sent it, run the command outside the sandbox (the user must approve it), or switch the thread to Full access.";
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

async function readProofFile(path: string): Promise<string | null> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (handle === null) return null;
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size > MAX_PROOF_FILE_BYTES ||
      !ownedByThisUser(stats)
    ) {
      return null;
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
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
      if ((await readProofFile(path)) !== id) {
        finished.delete(id);
        return null;
      }
      await unlink(path).catch(() => {});
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

export function isLocalCallerProofTarget(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export async function proveLocalCaller(
  args: ProveLocalCallerArgs,
): Promise<string | null> {
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
      if (!finishResponse.ok) return null;
      const body: unknown = await finishResponse.json();
      const token =
        typeof body === "object" && body !== null
          ? (body as { token?: unknown }).token
          : undefined;
      return typeof token === "string" ? token : null;
    } finally {
      await unlink(filePath).catch(() => {});
    }
  } catch {
    return null;
  }
}

const FAILED_PROOF_RETRY_MS = 2_000;
const PROOF_REQUEST_TIMEOUT_MS = 5_000;

interface CachedCallerToken {
  startedAt: number;
  token: Promise<string | null>;
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
      Date.now() - cached.startedAt < FAILED_PROOF_RETRY_MS
    );
  }
  if (options.force === true) return false;
  return !("rejected" in options) || cached.value !== options.rejected;
}

function provenToken(
  origin: string,
  fetchImpl: typeof fetch,
  options: ProvenTokenOptions = {},
): Promise<string | null> {
  const cached = callerTokens.get(origin);
  if (cached !== undefined && keepsCachedToken(cached, options)) {
    return cached.token;
  }
  const entry: CachedCallerToken = {
    startedAt: Date.now(),
    token: proveLocalCaller({
      baseUrl: origin,
      fetch: fetchImpl,
      proofPath: options.proofPath ?? SERVER_CALLER_PROOF_PATH,
      signal: AbortSignal.timeout(PROOF_REQUEST_TIMEOUT_MS),
    }),
  };
  void entry.token.then((value) => {
    entry.value = value;
  });
  callerTokens.set(origin, entry);
  return entry.token;
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
    const token =
      unsafe || callerTokens.has(url.origin)
        ? await provenToken(url.origin, fetchImpl)
        : undefined;
    const response = await fetchImpl(
      input,
      withCallerToken(input, init, token),
    );
    if (!isCallerProofRequired(response) || !canReplay(input, init)) {
      return response;
    }
    const fresh = await provenToken(url.origin, fetchImpl, {
      rejected: token ?? null,
    });
    if (fresh === null || fresh === token) return response;
    await response.body?.cancel().catch(() => {});
    return fetchImpl(input, withCallerToken(input, init, fresh));
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
