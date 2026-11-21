import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isatty } from "node:tty";
import { styleText } from "node:util";
import { loadLoggerConfig } from "@cloudroom/config/logger";

interface CreateLoggerOptions {
  component: string;
  base?: Record<string, unknown>;
  dataDir?: string;
}

/** Fields, a message, or both: `logger.info({ threadId }, "turn started")`. */
type LogFn = (fields: unknown, message?: string) => void;

export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** The same logger, adding these fields to every line. */
  child(bindings: Record<string, unknown>): Logger;
}

interface Sink {
  write(line: string): void;
}

// The JSON lines below match what pino 9 wrote for our options, byte for
// byte, except where pino wrote invalid JSON:
// {"level":30,"time":<ms>,"component":…,…fields,"msg":…}.
const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};
const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

// pino's string escaping: only quotes and backslashes, unless there is a
// control character or the string is long.
function asString(text: string): string {
  if (text.length > 100) return JSON.stringify(text);
  let result = "";
  let last = 0;
  let point = 255;
  for (let i = 0; i < text.length && point >= 32; i++) {
    point = text.charCodeAt(i);
    if (point === 34 || point === 92) {
      result += `${text.slice(last, i)}\\`;
      last = i;
    }
  }
  return point < 32 ? JSON.stringify(text) : `"${result}${text.slice(last)}"`;
}

const itemCount = (count: number) =>
  count === 1 ? "1 item" : `${count} items`;

// When JSON.stringify throws (a cycle or a BigInt), pino fell back to
// safe-stable-stringify: sorted keys, "[Circular]", 5 levels, 100 entries.
function safeJson(
  value: unknown,
  stack: object[],
  key = "",
): string | undefined {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (typeof value !== "object") return undefined;
  if (value === null) return "null";
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON(key: string): unknown }).toJSON(key);
    if (typeof value !== "object" || value === null)
      return safeJson(value, stack, key);
  }
  const object = value as object;
  if (stack.includes(object)) return '"[Circular]"';
  if (Array.isArray(object)) {
    if (object.length === 0) return "[]";
    if (stack.length >= 5) return '"[Array]"';
    stack.push(object);
    const items: string[] = [];
    for (let i = 0; i < Math.min(object.length, 100); i++) {
      items.push(safeJson(object[i], stack, String(i)) ?? "null");
    }
    if (object.length - 1 > 100) {
      items.push(`"... ${itemCount(object.length - 101)} not stringified"`);
    }
    stack.pop();
    return `[${items.join(",")}]`;
  }
  let keys = Object.keys(object);
  const keyCount = keys.length;
  if (keyCount === 0) return "{}";
  if (stack.length >= 5) return '"[Object]"';
  let out = "";
  let shown = Math.min(keyCount, 100);
  // Typed arrays keep their entries in index order, ahead of other keys.
  const typed = ArrayBuffer.isView(object) && !(object instanceof DataView);
  const length = typed ? (object as unknown as ArrayLike<unknown>).length : 0;
  if (length > 0) {
    const entries = object as unknown as ArrayLike<number | bigint>;
    const parts: string[] = [];
    for (let i = 0; i < Math.min(length, 100); i++)
      parts.push(`"${i}":${safeJson(entries[i], stack) ?? "null"}`);
    out = parts.join(",");
    keys = keys.slice(length);
    shown -= length;
  }
  stack.push(object);
  for (const name of keys.sort().slice(0, Math.max(shown, 0))) {
    const text = safeJson(
      (object as Record<string, unknown>)[name],
      stack,
      name,
    );
    if (text !== undefined)
      out += `${out ? "," : ""}${JSON.stringify(name)}:${text}`;
  }
  if (keyCount > 100) {
    out += `${out ? "," : ""}"...":"${itemCount(keyCount - 100)} not stringified"`;
  }
  stack.pop();
  return `{${out}}`;
}

function stringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return safeJson(value, []);
    } catch {
      return '"[unable to serialize, circular reference is too complex to analyze]"';
    }
  }
}

// A field value or message as pino wrote it; undefined leaves it out.
function fieldJson(value: unknown): string | undefined {
  if (typeof value === "string") return asString(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "function" || value === undefined) return undefined;
  return stringify(value);
}

type ErrorLike = Record<string, unknown> & { message: string };
const isErrorLike = (value: unknown): value is ErrorLike =>
  Boolean(value) &&
  typeof (value as { message?: unknown }).message === "string";

// pino's errWithCause serializer: type, message, stack, aggregate errors, the
// cause chain, then the error's other enumerable fields.
function serializeError(error: unknown, open = new Set<object>()): unknown {
  if (!isErrorLike(error)) return error;
  open.add(error);
  const constructor = error.constructor as { name?: unknown } | undefined;
  const out: Record<string, unknown> = {
    type:
      Object.prototype.toString.call(constructor) === "[object Function]"
        ? constructor?.name
        : error.name,
    message: error.message,
    stack: error.stack,
  };
  if (Array.isArray(error.errors)) {
    out.aggregateErrors = error.errors.map((item: unknown) =>
      open.has(item as object) ? undefined : serializeError(item, open),
    );
  }
  if (isErrorLike(error.cause) && !open.has(error.cause)) {
    out.cause = serializeError(error.cause, open);
  }
  for (const key in error) {
    // pino's error object had a "raw" accessor, so it never copied that key.
    if (key === "raw" || out[key] !== undefined) continue;
    const value = error[key];
    if (!isErrorLike(value)) out[key] = value;
    else if (!open.has(value)) out[key] = serializeError(value, open);
  }
  open.delete(error);
  return out;
}

// Base and child fields, written right after the time on every line.
function bindingsJson(bindings: Record<string, unknown>): string {
  let out = "";
  for (const key in bindings) {
    let value = bindings[key];
    if (!hasOwn(bindings, key) || value === undefined) continue;
    if (["level", "serializers", "formatters", "customLevels"].includes(key))
      continue;
    if (key === "err" || key === "error") value = serializeError(value);
    const text = stringify(value);
    if (text !== undefined) out += `,${asString(key)}:${text}`;
  }
  return out;
}

function formatRecord(
  level: number,
  bindings: string,
  args: unknown[],
): string {
  const [first, ...rest] = args;
  let fields: unknown = null;
  let message: unknown;
  if (typeof first === "object") {
    fields = first;
    message = first === null && rest.length === 0 ? null : rest[0];
  } else {
    message = first === undefined ? rest[0] : first;
  }
  if (fields instanceof Error) {
    if (message === undefined) message = fields.message;
    fields = { err: fields };
  } else if (fields !== null) {
    const record = fields as { msg?: unknown; err?: { message?: unknown } };
    if (message === undefined && record.msg === undefined && record.err) {
      message = record.err.message;
    }
  }
  let line = `{"level":${level},"time":${Date.now()}${bindings}`;
  for (const key in fields as object) {
    let value: unknown = (fields as Record<string, unknown>)[key];
    if (!hasOwn(fields as object, key) || value === undefined) continue;
    if (key === "err" || key === "error") value = serializeError(value);
    const text = fieldJson(value);
    if (text !== undefined) line += `,${asString(key)}:${text}`;
  }
  const msg = fieldJson(message);
  if (msg !== undefined) line += `,"msg":${msg}`;
  return `${line}}\n`;
}

function createInstance(
  minLevel: number,
  bindings: string,
  sinks: Sink[],
): Logger {
  const method = (level: number): LogFn =>
    level < minLevel
      ? () => {}
      : (...args: unknown[]) => {
          const line = formatRecord(level, bindings, args);
          for (const sink of sinks) sink.write(line);
        };
  return {
    trace: method(10),
    debug: method(20),
    info: method(30),
    warn: method(40),
    error: method(50),
    fatal: method(60),
    child: (more) =>
      createInstance(minLevel, bindings + bindingsJson(more), sinks),
  };
}

type Style = Parameters<typeof styleText>[0];

// pino's levels 10 to 60.
const LEVELS: [label: string, style: Style][] = [
  ["TRACE", "gray"],
  ["DEBUG", "blue"],
  ["INFO", "green"],
  ["WARN", "yellow"],
  ["ERROR", "red"],
  ["FATAL", "bgRed"],
];
// Keys left out of the JSON at the end of a line.
const HIDDEN_KEYS = new Set([
  "pid",
  "hostname",
  "component",
  "name",
  "level",
  "time",
  "timestamp",
  "caller",
]);

function sanitizeComponentName(component: string): string {
  const trimmed = component.trim();
  if (!trimmed) {
    throw new Error("Logger component is required");
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

// colorette's rules (pino-pretty colored with colorette).
function colorEnabled(): boolean {
  const { env, argv } = process;
  if ("NO_COLOR" in env || argv.includes("--no-color")) return false;
  return (
    "FORCE_COLOR" in env ||
    argv.includes("--color") ||
    (process.platform === "win32" && env.TERM !== "dumb") ||
    (isatty(1) && Boolean(env.TERM) && env.TERM !== "dumb") ||
    ("CI" in env &&
      ("GITHUB_ACTIONS" in env || "GITLAB_CI" in env || "CIRCLECI" in env))
  );
}

// Integer-like levels match by number, other strings by name.
function levelOf(level: unknown): [label: string, style: Style] {
  const index = Number.isInteger(Number(level))
    ? ["10", "20", "30", "40", "50", "60"].indexOf(String(level))
    : LEVELS.findIndex(
        ([label]) =>
          typeof level === "string" &&
          label.toLowerCase() === level.toLowerCase(),
      );
  return LEVELS[index] ?? ["USERLVL", "white"];
}

function paint(color: boolean, style: Style, value: string): string {
  return color ? styleText(style, value, { validateStream: false }) : value;
}

function text(value: unknown): string {
  return value === undefined ? "" : String(value);
}

function dropProto(key: string, value: unknown): unknown {
  return key === "__proto__" ? undefined : value;
}

function formatTime(time: unknown): string {
  let date = new Date(time as string);
  if (Number.isNaN(date.getTime())) date = new Date(Number(time));
  if (Number.isNaN(date.getTime())) return String(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// An err or error field as indented JSON, with its stack expanded.
function formatError(key: string, value: unknown): string {
  const json = JSON.stringify(value, null, 2) as string | undefined;
  if (json === undefined) return "";
  return `    ${key}: ${json.split(/\r?\n/).join("\n    ")}\n`
    .split("\n")
    .map((line) => {
      const match = /^(\s*)("stack":)\s*(".*"),?$/.exec(line);
      if (!match) return line;
      const indent = `${match[1]}    `;
      return `${match[1]}${match[2]}\n${indent}${String(JSON.parse(match[3])).replace(/\n/g, `\n${indent}`)}`;
    })
    .join("\n");
}

// One pino line as pino-pretty printed it for our old options: singleLine,
// translateTime "SYS:HH:MM:ss", messageFormat "[{component}] {msg}", and
// ignore "pid,hostname,component".
function formatLine(data: string, color: boolean): string {
  const line = data.endsWith("\n") ? data.slice(0, -1) : data;
  let parsed: unknown;
  try {
    // Drop __proto__ keys, as pino-pretty's secure-json-parse did. Such a key
    // can only be spelled out or \u-escaped, so most lines skip the slow path.
    const slow = line.includes("__proto__") || line.includes("\\u");
    parsed = JSON.parse(line, slow ? dropProto : undefined);
  } catch {
    return `${line}\n`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${line}\n`;
  }

  const log = parsed as Record<string, unknown>;
  const message = paint(
    color,
    "cyan",
    `[${text(log.component)}] ${text(log.msg)}`,
  );
  const time =
    "time" in log ? log.time : "timestamp" in log ? log.timestamp : null;
  const [label, style] = levelOf(log.level);
  let meta = log.name ? `(${String(log.name)})` : "";
  if (log.caller) meta += `${meta ? " " : ""}<${String(log.caller)}>`;
  const head = [
    time === null ? "" : `[${formatTime(time)}]`,
    "level" in log ? paint(color, style, label) : "",
    meta,
  ]
    .filter(Boolean)
    .join(" ");
  const first = head ? `${head}: ${message}` : message;

  if (log.type === "Error" && typeof log.stack === "string") {
    return `${first}\n    ${log.stack.split(/\r?\n/).join("\n    ")}\n`;
  }
  // A plain msg is already in the message; any other msg stays in the JSON.
  const msgShown = ["string", "number", "boolean"].includes(typeof log.msg);
  const plain: Record<string, unknown> = {};
  let errors = "";
  for (const [key, value] of Object.entries(log)) {
    if (HIDDEN_KEYS.has(key) || (key === "msg" && msgShown)) continue;
    if (key === "err" || key === "error") errors += formatError(key, value);
    else plain[key] = value;
  }
  const json =
    Object.keys(plain).length > 0
      ? paint(color, "gray", JSON.stringify(plain))
      : "";
  const rest = `${json}\n`.replace(/\\\\/g, "\\") + errors;
  return `${first}${rest === "\n" ? "" : " "}${rest}`;
}

let stdoutBroken = false;
let watchingStdout = false;

// Writes like console.log: sync to files and terminals, async to pipes, so
// exit never waits on a flush. Console output is best-effort: a full disk or
// closed pipe only stops it, and the log file still gets every line.
function createConsoleStream(): Sink {
  if (!watchingStdout) {
    watchingStdout = true;
    process.stdout.on("error", () => {
      stdoutBroken = true;
    });
  }
  const color = colorEnabled();
  return {
    write(data: string) {
      if (stdoutBroken) return;
      try {
        process.stdout.write(formatLine(data, color));
      } catch {
        // Best-effort, as above.
      }
    },
  };
}

interface RollStream {
  fd: number;
  write(line: string): boolean;
  destroy(): void;
  on(event: "error", listener: (error: unknown) => void): void;
  once(event: "ready", listener: () => void): void;
}

// The file pino-roll opens: <component>.<n>.log, where n is the highest number
// of any log here created today (at least 1).
function todaysLogFile(logDir: string, component: string): string {
  const today = new Date().setHours(0, 0, 0, 0);
  let number = 1;
  try {
    for (const name of readdirSync(logDir)) {
      const match = /(\d+)\.log$/u.exec(name);
      if (match && statSync(join(logDir, name)).birthtimeMs >= today) {
        number = Math.max(number, Number(match[1]));
      }
    }
  } catch {
    number = 1;
  }
  return join(logDir, `${component}.${number}.log`);
}

// pino-roll rolls the file daily and at 10 MB, keeping 5 old files. Writes are
// synchronous, like pino.destination's default, so exit keeps every line in
// order. Lines wait in memory until pino-roll opens the file, and exit writes
// them if the process ends first. After a failed write (a full disk) the file
// stays closed, so lines can't pile up in memory or stall exit.
function createFileSink(logDir: string, component: string): Sink {
  let queue: string[] | null = [];
  let stream: RollStream | null = null;
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    queue = null;
    const broken = stream;
    stream = null;
    // After the failing write returns; this also stops pino-roll's timer.
    if (broken) {
      setImmediate(() => {
        try {
          broken.destroy();
        } catch {
          // Closing is best-effort too.
        }
      });
    }
    console.error(`Could not write the ${component} log file:`, error);
  };
  const roll = createRequire(import.meta.url)("pino-roll") as (
    options: object,
  ) => Promise<RollStream>;
  roll({
    file: join(logDir, `${component}.log`),
    frequency: "daily",
    limit: { count: 5 },
    size: "10m",
    sync: true,
  }).then((opened) => {
    opened.on("error", fail);
    const start = () => {
      if (!queue) return;
      stream = opened;
      for (const line of queue) stream?.write(line);
      queue = null;
    };
    if (opened.fd >= 0) start();
    else opened.once("ready", start);
  }, fail);
  process.once("exit", () => {
    if (!queue?.length) return;
    try {
      appendFileSync(todaysLogFile(logDir, component), queue.join(""));
    } catch {
      // The process is exiting; nothing more to do.
    }
  });
  return {
    write(line) {
      if (stream) stream.write(line);
      else queue?.push(line);
    },
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const component = sanitizeComponentName(options.component);
  const loggerConfig = loadLoggerConfig({ dataDir: options.dataDir });
  const logDir = join(loggerConfig.BB_DATA_DIR, "logs");
  mkdirSync(logDir, { recursive: true });
  const minLevel = LEVEL_VALUES[loggerConfig.BB_LOG_LEVEL];
  if (minLevel === undefined) {
    throw new Error(`Unknown log level ${loggerConfig.BB_LOG_LEVEL}`);
  }
  const sinks = [createFileSink(logDir, component)];
  if (!process.env.VITEST) sinks.push(createConsoleStream());
  return createInstance(
    minLevel,
    bindingsJson({ component, ...(options.base ?? {}) }),
    sinks,
  );
}
