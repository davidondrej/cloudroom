// Child processes: start with captured logs, wait until healthy, stop cleanly, and enroll the host daemon.
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCallerProofFetch } from "@cloudroom/config/caller-proof";
import {
  hasProcessExited,
  waitForProcessExit,
  waitForProcessExitWithTimeout,
  type ChildProcessExitResult,
} from "@cloudroom/config/child-process-exit";
import { ROOM_LOOPBACK_HOST } from "@cloudroom/config/runtime";
import { toOptionalString } from "@cloudroom/config/strings";
import { z } from "zod";
import type { AppContext } from "./context.js";
import { log, dim, yellow } from "./launcher-output.js";
import { readProcessLogTail, spawnLoggedProcess } from "./logged-process.js";

export type ProcessExitResult = ChildProcessExitResult;
export type ManagedProcessName = "daemon" | "server";

export interface NamedProcessExitResult {
  processName: ManagedProcessName;
  result: ProcessExitResult;
}

export interface ManagedProcessRun {
  exit: Promise<NamedProcessExitResult>;
  terminate(signal: NodeJS.Signals): Promise<void>;
}

export interface ChildProcessRun extends ManagedProcessRun {
  childProcess: ChildProcess;
}

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 100;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 1_000;
// Node's clocks keep running while a Mac sleeps. A gap far longer than one poll means the Mac
// slept mid-startup, so that gap does not count toward the startup timeout.
const MAX_AWAKE_POLL_GAP_MS = 10_000;
export const HOST_AUTH_FILE = "auth.json";
const HOST_ID_FILE = "host-id";

const serverFetch = createCallerProofFetch((input, init) => fetch(input, init));

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const processLabel = (name: ManagedProcessName): string => (name === "server" ? "server" : "host daemon");
const logName = (name: ManagedProcessName): "server" | "host-daemon" => (name === "server" ? "server" : "host-daemon");

export function describeExit(result: ProcessExitResult): string {
  if (result.code !== null) return `code ${result.code}`;
  return result.signal !== null ? `signal ${result.signal}` : "no exit code or signal";
}

export function toExitCode(result: ProcessExitResult): number {
  if (result.code !== null) return result.code;
  return result.signal === null ? 1 : 128;
}

/** SIGTERM (or the given signal), then SIGKILL if the process is still alive after 5 s. */
export async function stopProcess(childProcess: ChildProcess, name: string, signal: NodeJS.Signals): Promise<void> {
  if (hasProcessExited(childProcess)) return;
  childProcess.kill(signal);
  if ((await waitForProcessExitWithTimeout({ childProcess, timeoutMs: STOP_TIMEOUT_MS })) === "exited") return;
  log(yellow("!"), `${name} did not stop after ${STOP_TIMEOUT_MS}ms - sending SIGKILL`);
  if (!hasProcessExited(childProcess)) childProcess.kill("SIGKILL");
  await waitForProcessExitWithTimeout({ childProcess, timeoutMs: KILL_TIMEOUT_MS });
}

export function spawnManaged(args: {
  processName: ManagedProcessName;
  entry: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
}): ChildProcessRun {
  const childProcess = spawnLoggedProcess({
    command: process.execPath,
    args: [args.entry],
    env: args.env,
    logDir: args.logDir,
    logName: logName(args.processName),
  });
  return {
    childProcess,
    exit: waitForProcessExit(childProcess).then((result) => ({ processName: args.processName, result })),
    terminate: (signal) => stopProcess(childProcess, args.processName, signal),
  };
}

/** After a failed start: where the logs are, and their last lines. */
export function logStartupFailure(context: AppContext, processName: ManagedProcessName): void {
  const logPath = join(context.logDir, `${logName(processName)}-stdio.log`);
  log(" ", dim(`logs: ${logPath}`));
  const tail = readProcessLogTail(logPath);
  if (tail) {
    log(" ", "Recent service output:");
    process.stdout.write(`${tail}\n`);
  }
}

function awakeTimeout(timeoutMs: number): () => boolean {
  let awakeMs = 0;
  let last = performance.now();
  return () => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (gap <= MAX_AWAKE_POLL_GAP_MS) awakeMs += gap;
    return awakeMs > timeoutMs;
  };
}

const healthSchema = z.object({ ok: z.boolean(), launchId: z.string().min(1).optional() }).passthrough();

/** null when nothing healthy answers; {} when something answers without JSON. */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.json().catch(() => ({}));
}

/** True when any healthy server answers at this URL, ours or not. */
export async function isHealthyServerAnswering(url: string): Promise<boolean> {
  try {
    return healthSchema.safeParse(await getJson(url)).data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Waits for our own server: its /health must echo this launch's ID. Another app already on the
 * port answers too, and is reported instead of being mistaken for ours.
 */
export async function waitForServerHealth(args: {
  url: string;
  expectedLaunchId: string;
  childProcess?: ChildProcess | null;
  timeoutMs?: number;
}): Promise<void> {
  const timedOut = awakeTimeout(args.timeoutMs ?? HEALTH_TIMEOUT_MS);
  let foreign = false;
  const fail = (reason: string): Error =>
    new Error(foreign ? `${reason}: another server is already answering at ${args.url}` : reason);
  while (!timedOut()) {
    if (args.childProcess && hasProcessExited(args.childProcess)) throw fail("Process exited before becoming healthy");
    try {
      const body = await getJson(args.url);
      if (body !== null) {
        if (healthSchema.safeParse(body).data?.launchId === args.expectedLaunchId) return;
        foreign = true;
      }
    } catch {}
    await delay(HEALTH_POLL_MS);
  }
  throw fail(`Timed out waiting for health at ${args.url}`);
}

const sameServer = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.hostname === "localhost") parsed.hostname = ROOM_LOOPBACK_HOST;
  return parsed.href.replace(/\/$/u, "");
};

const daemonStatusSchema = z.object({ connected: z.boolean(), hostId: z.string().min(1), serverUrl: z.string().min(1) }).passthrough();

/** Waits until the host daemon is connected, as the expected host, to the expected server. */
export async function waitForHostDaemonStatus(args: {
  port: number;
  expectedHostId: string;
  expectedServerUrl: string;
  childProcess?: ChildProcess | null;
  timeoutMs?: number;
}): Promise<void> {
  const timedOut = awakeTimeout(args.timeoutMs ?? HEALTH_TIMEOUT_MS);
  const expectedServer = sameServer(args.expectedServerUrl);
  const statusUrl = `http://${ROOM_LOOPBACK_HOST}:${args.port}/status`;
  while (!timedOut()) {
    if (args.childProcess && hasProcessExited(args.childProcess)) throw new Error("Host daemon exited before becoming ready");
    try {
      const status = daemonStatusSchema.safeParse(await getJson(statusUrl)).data;
      if (status?.connected && status.hostId === args.expectedHostId && sameServer(status.serverUrl) === expectedServer) return;
    } catch {}
    await delay(HEALTH_POLL_MS);
  }
  throw new Error(`Timed out waiting for host daemon ${args.expectedHostId} to connect to ${expectedServer} at ${statusUrl}`);
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The host ID this data folder already has, from host-id or auth.json. */
export async function readSavedHostId(dataDir: string, includeAuth = false): Promise<string | null> {
  const hostId = await readTrimmed(join(dataDir, HOST_ID_FILE));
  if (hostId !== null || !includeAuth) return hostId;
  try {
    return z.object({ hostId: z.string().min(1) }).parse(JSON.parse((await readTrimmed(join(dataDir, HOST_AUTH_FILE))) ?? "")).hostId;
  } catch {
    return null;
  }
}

export async function expectedHostId(dataDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const hostId = toOptionalString(env.BB_HOST_ID) ?? (await readSavedHostId(dataDir, true));
  if (hostId === null) throw new Error("Could not resolve the expected host daemon ID");
  return hostId;
}

/** Asks the server for a one-time enroll key, keeping the host ID this machine already has. */
export async function requestEnrollKey(serverUrl: string, hostId: string | null): Promise<{ enrollKey: string; hostId: string }> {
  const response = await serverFetch(`${serverUrl}/internal/hosts/enroll-key`, {
    body: JSON.stringify(hostId === null ? {} : { hostId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (response.status !== 201) {
    const detail = await response.text();
    throw new Error(`Failed to request host enroll key: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`);
  }
  const key = z.object({ enrollKey: z.string().min(1), hostId: z.string().min(1) }).passthrough().parse(await response.json());
  if (hostId !== null && key.hostId !== hostId) {
    throw new Error(`Enroll key response host ID ${key.hostId} does not match persisted host ID ${hostId}`);
  }
  return key;
}

/** A fresh data folder enrolls its own host daemon with the local server on first start. */
export async function withAutoJoin(dataDir: string, serverUrl: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (toOptionalString(env.BB_HOST_ENROLL_KEY) !== undefined || existsSync(join(dataDir, HOST_AUTH_FILE))) return env;
  const key = await requestEnrollKey(serverUrl, toOptionalString(env.BB_HOST_ID) ?? (await readSavedHostId(dataDir)));
  return { ...env, BB_HOST_ENROLL_KEY: key.enrollKey, BB_HOST_ID: key.hostId };
}

export function forwardTerminationSignals(callback: (signal: NodeJS.Signals) => void): () => void {
  const onInt = (): void => callback("SIGINT");
  const onTerm = (): void => callback("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}
