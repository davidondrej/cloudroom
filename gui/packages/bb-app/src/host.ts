// A joined machine runs only the host daemon, connected to a server elsewhere.
// install-machine.sh starts `bb-app host-daemon join …` once, then `bb-app host-daemon --auto-update …` as a service.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRoomAppConfigPath } from "@cloudroom/config/app-managed-config";
import { readMachineProxyUrl } from "@cloudroom/config/caller-proof";
import { waitForProcessExit } from "@cloudroom/config/child-process-exit";
import { mutateManagedJsonFile } from "@cloudroom/config/managed-json-file";
import { validateOptionalUrl } from "@cloudroom/config/public-url";
import { toOptionalString } from "@cloudroom/config/strings";
import {
  assertArtifacts,
  createDaemonEnv,
  resolveRuntime,
  type AppContext,
  type LauncherOptions,
} from "./context.js";
import { beginStep, bold, cyan, dim, endStep, green, log, red, yellow } from "./launcher-output.js";
import {
  HOST_AUTH_FILE,
  expectedHostId,
  forwardTerminationSignals,
  logStartupFailure,
  readSavedHostId,
  requestEnrollKey,
  spawnManaged,
  toExitCode,
  waitForHostDaemonStatus,
} from "./processes.js";

/** Saves which server this machine joined, keeping any other saved settings. */
async function saveJoin(dataDir: string, join: Record<string, string>): Promise<void> {
  validateOptionalUrl("BB_SERVER_URL", join.serverUrl);
  const path = formatRoomAppConfigPath(dataDir);
  await mutateManagedJsonFile<Record<string, unknown>>({
    path,
    read: async () => {
      try {
        const saved: unknown = JSON.parse(await readFile(path, "utf8"));
        return typeof saved === "object" && saved !== null && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
        throw new Error(`Invalid config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    mutate: (current) => ({ ...current, ...join }),
  });
}

/** `join`: use the given join code, or ask the server for an enroll key, then remember the server. */
export async function createJoinEnv(context: AppContext, env: NodeJS.ProcessEnv, serverUrl: string): Promise<NodeJS.ProcessEnv> {
  const hostId = toOptionalString(env.BB_HOST_ID) ?? (await readSavedHostId(context.dataDir));
  const joinCode = toOptionalString(env.BB_HOST_ENROLL_KEY);
  const machineCredential = toOptionalString(env.BB_CONNECT_MACHINE_CREDENTIAL);
  const connectMachineId = toOptionalString(env.BB_CONNECT_MACHINE_ID);
  let key: { enrollKey: string; hostId: string };
  if (joinCode !== undefined) {
    if (hostId === null) throw new Error("--host-id is required when --join-code is supplied");
    key = { enrollKey: joinCode, hostId };
  } else {
    key = await requestEnrollKey(serverUrl, hostId);
  }
  await saveJoin(context.dataDir, {
    serverUrl,
    ...(machineCredential !== undefined ? { machineCredential } : {}),
    ...(connectMachineId !== undefined ? { connectMachineId } : {}),
  });
  return { ...env, BB_HOST_ENROLL_KEY: key.enrollKey, BB_HOST_ID: key.hostId };
}

export async function runHostDaemon(args: string[], flags: LauncherOptions, entrypointUrl: string): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "join")) {
    throw new Error("bb-app host-daemon accepts no subcommand except join");
  }
  const runtime = await resolveRuntime({ entrypointUrl, env: process.env, homeDir: homedir(), options: flags, mode: "remote" });
  const { context } = runtime;
  assertArtifacts(context, "host");
  const serverUrl = toOptionalString(runtime.env.BB_SERVER_URL) ?? context.serverUrl;
  const env = createDaemonEnv(
    context,
    args[0] === "join" ? await createJoinEnv(context, runtime.env, serverUrl) : runtime.env,
    serverUrl,
  );
  const enrolled = existsSync(join(context.dataDir, HOST_AUTH_FILE));

  process.stdout.write(`\n  ${bold("Cloudroom host daemon")}\n\n`);
  if (existsSync(context.daemonLockDir)) log(yellow("!"), `Daemon lock exists - waiting or reclaiming if stale: ${context.daemonLockDir}`);
  if (!enrolled && toOptionalString(env.BB_HOST_ENROLL_KEY) === undefined) {
    endStep(red("✗"), `Not enrolled - set BB_HOST_ENROLL_KEY to join ${serverUrl}`);
    log(" ", dim(`Run: bb-app host-daemon join --server-url ${serverUrl}`));
    process.exitCode = 1;
    return;
  }

  const hostId = await expectedHostId(context.dataDir, env);
  beginStep(enrolled ? "Starting daemon" : "Enrolling and starting daemon");
  const daemon = spawnManaged({ processName: "daemon", entry: context.daemonEntry, env, logDir: context.logDir });
  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(dim("●"), "Shutting down");
    await daemon.terminate(signal);
  };
  const stopForwarding = forwardTerminationSignals((signal) => void stop(signal));
  try {
    try {
      await waitForHostDaemonStatus({ childProcess: daemon.childProcess, expectedHostId: hostId, expectedServerUrl: serverUrl, port: context.daemonPort });
    } catch (error) {
      endStep(red("✗"), "Host daemon failed to start");
      log(" ", error instanceof Error ? error.message : String(error));
      logStartupFailure(context, "daemon");
      process.exitCode = 1;
      await stop("SIGTERM");
      return;
    }
    endStep(green("✓"), "Host daemon running");
    log(green("●"), bold("Cloudroom host daemon is ready"));
    log(" ", `${dim("server")} ${cyan(serverUrl)}`);
    log(" ", `${dim("data  ")} ${context.dataDir}`);
    log(" ", `${dim("logs  ")} ${context.logDir}/`);
    process.exitCode = toExitCode((await daemon.exit).result);
  } finally {
    stopForwarding();
  }
}

/** On Windows, an extensionless script runs through node; elsewhere it runs directly. */
export function resolveBundledCliLaunch(args: { args: string[]; cliPath: string; nodePath: string; platform: NodeJS.Platform }): {
  command: string;
  args: string[];
} {
  return args.platform === "win32" && win32.extname(args.cliPath) === ""
    ? { command: args.nodePath, args: [args.cliPath, ...args.args] }
    : { command: args.cliPath, args: args.args };
}

/** install-machine.sh puts bb-app in <dataDir>/npm; that machine's daemon publishes its agent proxy there (#1564). */
function installedMachineProxyUrl(): string | null {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const npmPrefix = resolve(packageRoot, "../../..");
  const installed = basename(npmPrefix) === "npm" && packageRoot === join(npmPrefix, "lib", "node_modules", "bb-app");
  return installed ? readMachineProxyUrl(dirname(npmPrefix)) : null;
}

/** Only a server that refuses the connection is replaced, so a running desktop app keeps its CLI. */
async function refusesConnection(serverUrl: string): Promise<boolean> {
  const url = URL.parse(serverUrl);
  if (url === null) return true;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/gu, ""), port, timeout: 1_000 });
    const done = (refused: boolean) => {
      socket.destroy();
      resolve(refused);
    };
    socket.once("connect", () => done(false)).once("timeout", () => done(false)).once("error", () => done(true));
  });
}

/** The `room-cli` bin of an installed package: finds this machine's server, then runs the bundled CLI. */
export async function runRoomCli(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BB_")));
  const proxyUrl = env.ROOM_SERVER_URL === undefined && env.ROOM_DATA_DIR === undefined ? installedMachineProxyUrl() : null;
  if (env.ROOM_DATA_DIR !== undefined) env.BB_DATA_DIR = env.ROOM_DATA_DIR;
  if (env.ROOM_HOST_DAEMON_PORT !== undefined) env.BB_HOST_DAEMON_PORT = env.ROOM_HOST_DAEMON_PORT;
  if (env.ROOM_SERVER_URL !== undefined) env.BB_SERVER_URL = env.ROOM_SERVER_URL;
  const runtime = await resolveRuntime({ entrypointUrl: import.meta.url, env, homeDir: homedir(), options: {}, mode: "remote" });
  const { context } = runtime;
  assertArtifacts(context, "host");
  let serverUrl = runtime.env.ROOM_SERVER_URL ?? context.serverUrl;
  if (proxyUrl !== null && (await refusesConnection(serverUrl))) serverUrl = proxyUrl;
  const launch = resolveBundledCliLaunch({
    args: cliArgs,
    cliPath: toOptionalString(runtime.env.ROOM_CLI) ?? join(context.daemonBundleDir, "room-cli"),
    nodePath: process.execPath,
    platform: process.platform,
  });
  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...runtime.env,
      BB_APP_VERSION: context.appVersion,
      ROOM_HOST_DAEMON_PORT: runtime.env.ROOM_HOST_DAEMON_PORT ?? String(context.daemonPort),
      ROOM_DATA_DIR: runtime.env.ROOM_DATA_DIR ?? context.dataDir,
      ROOM_SERVER_URL: serverUrl,
      NODE_ENV: "production",
    },
  });
  process.exitCode = toExitCode(await waitForProcessExit(child));
}
