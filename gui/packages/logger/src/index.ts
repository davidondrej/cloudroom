import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";
import { styleText } from "node:util";
import pino from "pino";
import type { Logger } from "pino";
import { loadLoggerConfig } from "@cloudroom/config/logger";

export type { Logger };

interface CreateLoggerOptions {
  component: string;
  base?: Record<string, unknown>;
  dataDir?: string;
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
function createConsoleStream(): pino.DestinationStream {
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

export function createLogger(options: CreateLoggerOptions): Logger {
  const component = sanitizeComponentName(options.component);
  const loggerConfig = loadLoggerConfig({ dataDir: options.dataDir });
  const dataDir = loggerConfig.BB_DATA_DIR;
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const level = loggerConfig.BB_LOG_LEVEL;
  const loggerOptions = {
    level,
    base: {
      component,
      ...(options.base ?? {}),
    },
    serializers: {
      err: pino.stdSerializers.errWithCause,
      error: pino.stdSerializers.errWithCause,
    },
  } satisfies pino.LoggerOptions;

  const transport = pino.transport({
    targets: [
      {
        target: "pino-roll",
        options: {
          file: join(logDir, `${component}.log`),
          frequency: "daily",
          limit: { count: 5 },
          size: "10m",
        },
        level,
      },
    ],
  });

  if (process.env.VITEST) {
    return pino(loggerOptions, transport);
  }

  return pino(
    loggerOptions,
    pino.multistream<string>([
      { level, stream: transport },
      { level, stream: createConsoleStream() },
    ]),
  );
}
