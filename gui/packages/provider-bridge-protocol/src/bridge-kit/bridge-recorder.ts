import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { MAX_JSON_RPC_LINE_BYTES } from "./bounded-line-reader.js";

export const PROVIDER_BRIDGE_RECORD_DIR_ENV = "BB_PROVIDER_BRIDGE_RECORD_DIR";

export const BRIDGE_RECORDING_DIRECTIONS = [
  "runtime→bridge",
  "bridge→runtime",
  "provider→bridge",
  "bridge→provider",
] as const;

export type BridgeRecordingDirection =
  (typeof BRIDGE_RECORDING_DIRECTIONS)[number];

export type BridgeRecordingRuntimeDirection = Extract<
  BridgeRecordingDirection,
  "runtime→bridge" | "bridge→runtime"
>;

export const BRIDGE_RECORDING_PROCESS_SCOPE = "_process";

export interface BridgeRecordingEntry {
  ts: number;
  run: number;
  seq: number;
  dir: BridgeRecordingDirection;
  line: string;
}

export function bridgeRecordingFileName(
  direction: BridgeRecordingDirection,
): string {
  return `${direction}.ndjson`;
}

export interface RecordBridgeLineArgs {
  direction: BridgeRecordingDirection;
  line: string;
  threadId: string | null;
}

export interface BridgeRecorderChildStreams {
  stdin?: Writable | null;
  stdout?: Readable | null;
}

export interface BridgeRecorder {
  record(args: RecordBridgeLineArgs): void;
  recordRuntimeLine(
    direction: BridgeRecordingRuntimeDirection,
    line: string,
  ): void;
  recordChildIo(
    child: BridgeRecorderChildStreams,
    scope: { threadId: string | null },
  ): void;
  close(): void;
}

export function createRecordingLineSplitter(
  onLine: (line: string) => void,
  maxLineBytes: number = MAX_JSON_RPC_LINE_BYTES,
): { push: (chunk: string | Uint8Array) => void } {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  return {
    push(chunk) {
      const text =
        typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      let start = 0;
      for (;;) {
        const newlineIndex = text.indexOf("\n", start);
        if (newlineIndex === -1) {
          break;
        }
        if (!discarding) {
          const line = pending + text.slice(start, newlineIndex);
          onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
        discarding = false;
        pending = "";
        start = newlineIndex + 1;
      }
      if (discarding) {
        return;
      }
      pending += text.slice(start);
      if (Buffer.byteLength(pending) > maxLineBytes) {
        discarding = true;
        pending = "";
      }
    },
  };
}

function safeScopeSegment(threadId: string | null): string {
  if (threadId === null || threadId === "") {
    return BRIDGE_RECORDING_PROCESS_SCOPE;
  }
  const sanitized = threadId.replace(/[^A-Za-z0-9_.-]+/g, "-");
  return sanitized === "" || sanitized.startsWith("_")
    ? `t-${sanitized}`
    : sanitized;
}

interface ParsedRuntimeLine {
  id: string | number | undefined;
  method: string | undefined;
  threadId: string | undefined;
}

function parseRuntimeLine(line: string): ParsedRuntimeLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const id =
    typeof record.id === "string" || typeof record.id === "number"
      ? record.id
      : undefined;
  const method = typeof record.method === "string" ? record.method : undefined;
  const params = record.params;
  const threadId =
    typeof params === "object" &&
    params !== null &&
    typeof (params as Record<string, unknown>).threadId === "string"
      ? ((params as Record<string, unknown>).threadId as string)
      : undefined;
  return { id, method, threadId };
}

// Credentials must never reach a recording file. Keys ending in a credential
// word are masked anywhere; `env`/`envVars`/`environment` maps use the broader
// rule from scripts/provider-recordings/redact.mjs. Lines with nothing to mask
// are written byte-for-byte so replay stays exact.
const CREDENTIAL_KEY =
  /(token|secret|password|passwd|apikey|cookie|authorization|credentials?)$/;
const SECRET_ENV_KEY =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;
const ENV_MAP_KEYS = new Set(["env", "envVars", "environment"]);
// Forward match (no lookbehind) keeps this linear on long whitespace runs.
const BEARER_VALUE = /(bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi;
const REDACTED = "REDACTED";
const UNREDACTABLE_LINE = '{"redacted":"unparseable"}';

function redactCredentials(value: unknown, inEnvMap: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentials(entry, false));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    const secret = inEnvMap
      ? SECRET_ENV_KEY.test(key)
      : CREDENTIAL_KEY.test(key.toLowerCase().replace(/[-_]/g, ""));
    out[key] =
      secret && typeof child === "string" && child !== ""
        ? REDACTED
        : redactCredentials(child, ENV_MAP_KEYS.has(key));
  }
  return out;
}

function redactRecordingLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line.replace(BEARER_VALUE, `$1${REDACTED}`);
  }
  let out = line;
  try {
    const redacted = JSON.stringify(redactCredentials(parsed, false));
    if (redacted !== JSON.stringify(parsed)) {
      out = redacted;
    }
  } catch {
    // Never fall back to the raw line: it may hold the credential.
    return UNREDACTABLE_LINE;
  }
  return out.replace(BEARER_VALUE, `$1${REDACTED}`);
}

function pendingKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

export function createBridgeRecorder(args: { dir: string }): BridgeRecorder {
  const dir = resolve(args.dir);
  const fds = new Map<string, number>();
  const runtimeRequestThreads = new Map<string, string | null>();
  const bridgeRequestThreads = new Map<string, string | null>();
  const run = Date.now();
  let seq = 0;
  let closed = false;

  function fdFor(scope: string, direction: BridgeRecordingDirection): number {
    const key = `${scope}\u0000${direction}`;
    const existing = fds.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const scopeDir = join(dir, scope);
    // Owner-only: recordings hold full provider traffic. Existing scope
    // folders and files from older runs are tightened too. Windows ignores
    // POSIX modes, so skip the chmods there; a failed chmod keeps recording.
    mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
    const fd = openSync(
      join(scopeDir, bridgeRecordingFileName(direction)),
      "a",
      0o600,
    );
    fds.set(key, fd);
    if (process.platform !== "win32") {
      try {
        chmodSync(scopeDir, 0o700);
      } catch {}
      try {
        fchmodSync(fd, 0o600);
      } catch {}
    }
    return fd;
  }

  function record(recordArgs: RecordBridgeLineArgs): void {
    if (closed) {
      return;
    }
    seq += 1;
    const entry: BridgeRecordingEntry = {
      ts: Date.now(),
      run,
      seq,
      dir: recordArgs.direction,
      line: redactRecordingLine(recordArgs.line),
    };
    try {
      writeSync(
        fdFor(safeScopeSegment(recordArgs.threadId), recordArgs.direction),
        `${JSON.stringify(entry)}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `provider bridge recorder: failed to append to ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  function recordRuntimeLine(
    direction: BridgeRecordingRuntimeDirection,
    line: string,
  ): void {
    const parsed = parseRuntimeLine(line);
    let threadId: string | null = parsed?.threadId ?? null;
    if (parsed !== null && parsed.id !== undefined) {
      const key = pendingKey(parsed.id);
      if (parsed.method !== undefined) {
        (direction === "runtime→bridge"
          ? runtimeRequestThreads
          : bridgeRequestThreads
        ).set(key, threadId);
      } else {
        const pending =
          direction === "runtime→bridge"
            ? bridgeRequestThreads
            : runtimeRequestThreads;
        const owner = pending.get(key);
        if (owner !== undefined) {
          pending.delete(key);
          threadId = owner;
        }
      }
    }
    record({ direction, line, threadId });
  }

  function recordChildIo(
    child: BridgeRecorderChildStreams,
    scope: { threadId: string | null },
  ): void {
    const { stdin, stdout } = child;
    if (stdout) {
      const splitter = createRecordingLineSplitter((line) =>
        record({
          direction: "provider→bridge",
          line,
          threadId: scope.threadId,
        }),
      );
      stdout.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    }
    if (stdin) {
      const splitter = createRecordingLineSplitter((line) =>
        record({
          direction: "bridge→provider",
          line,
          threadId: scope.threadId,
        }),
      );
      const originalWrite = stdin.write.bind(stdin);
      stdin.write = ((
        chunk: string | Uint8Array,
        ...rest: unknown[]
      ): boolean => {
        splitter.push(chunk);
        return (originalWrite as (...args: unknown[]) => boolean)(
          chunk,
          ...rest,
        );
      }) as typeof stdin.write;
    }
  }

  return {
    record,
    recordRuntimeLine,
    recordChildIo,
    close() {
      closed = true;
      for (const fd of fds.values()) {
        try {
          closeSync(fd);
        } catch {}
      }
      fds.clear();
    },
  };
}

const RECORDER_GLOBAL_KEY = Symbol.for("bb.providerBridgeRecorder");

interface RecorderGlobalSlot {
  recorder: BridgeRecorder | null;
  resolved: boolean;
}

function globalSlot(): RecorderGlobalSlot {
  const holder = globalThis as unknown as Record<symbol, RecorderGlobalSlot>;
  const existing = holder[RECORDER_GLOBAL_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const slot: RecorderGlobalSlot = { recorder: null, resolved: false };
  holder[RECORDER_GLOBAL_KEY] = slot;
  return slot;
}

export function getBridgeRecorder(): BridgeRecorder | null {
  const slot = globalSlot();
  if (!slot.resolved) {
    slot.resolved = true;
    const dir = process.env[PROVIDER_BRIDGE_RECORD_DIR_ENV];
    if (dir !== undefined && dir.trim() !== "") {
      slot.recorder = createBridgeRecorder({ dir: dir.trim() });
    }
  }
  return slot.recorder;
}

export function experimental_isProviderBridgeRecording(): boolean {
  return getBridgeRecorder() !== null;
}

export function experimental_recordProviderChildIo(
  child: BridgeRecorderChildStreams,
  scope: { threadId: string | null },
): void {
  getBridgeRecorder()?.recordChildIo(child, scope);
}
