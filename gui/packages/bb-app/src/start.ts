// Runs the whole app: the server, then the host daemon, restarting either one if it crashes.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { APP_SURFACE_ENV_NAME, APP_SURFACE_WEB, parseAppSurface } from "@cloudroom/config/app-surface";
import {
  claimRoomAppRuntimeFile,
  clearOwnRoomAppRuntimeFile,
  formatRoomAppRuntimeFilePath,
} from "@cloudroom/config/app-runtime-file";
import { parseServerBindHost } from "@cloudroom/config/server";
import { ROOM_LOOPBACK_HOST } from "@cloudroom/config/runtime";
import {
  assertArtifacts,
  createDaemonEnv,
  createServerEnv,
  createSharedEnv,
  parseLauncherArgs,
  resolveRuntime,
  serverListenerUrl,
  type AppContext,
  type WorktreeRuntimePolicy,
} from "./context.js";
import { runHostDaemon } from "./host.js";
import { beginStep, bold, cyan, dim, endStep, green, log, red, yellow } from "./launcher-output.js";
import {
  delay,
  describeExit,
  expectedHostId,
  forwardTerminationSignals,
  isHealthyServerAnswering,
  logStartupFailure,
  processLabel,
  spawnManaged,
  stopProcess,
  waitForHostDaemonStatus,
  waitForServerHealth,
  withAutoJoin,
  type ManagedProcessName,
  type ManagedProcessRun,
} from "./processes.js";

const RESTART_DELAY_MS = 1_000;

export interface RunAppOptions {
  dryRun?: boolean;
  beforeServerStart?: () => Promise<void> | void;
  worktreePolicy?: WorktreeRuntimePolicy | null;
}

export interface Processes {
  server: ManagedProcessRun | null;
  daemon: ManagedProcessRun | null;
}

type Start = () => Promise<ManagedProcessRun>;

const HELP = `Cloudroom launcher

Usage:
  bb-app [--data-dir <path>] [--server-bind-host <host>] [--server-port <port>] [--host-daemon-port <port>]
  bb-app host-daemon [--server-url <url>] [--host-daemon-port <port>] [--host-id <id>] [--enroll-key <key>] [--auto-update]
  bb-app host-daemon join --server-url <url> [--host-daemon-port <port>] [--join-code <code> --host-id <id>] [--auto-update]
`;

/** Starts the server and waits for /health to echo this launch's ID. */
export async function startServerProcess(args: {
  context: AppContext;
  env: NodeJS.ProcessEnv;
  processes: Processes;
  beforeStart?: () => Promise<void> | void;
}): Promise<ManagedProcessRun> {
  await args.beforeStart?.();
  const launchId = randomUUID();
  const run = spawnManaged({
    processName: "server",
    entry: args.context.serverEntry,
    env: { ...args.env, BB_SERVER_LAUNCH_ID: launchId },
    logDir: args.context.logDir,
  });
  args.processes.server = run;
  try {
    await waitForServerHealth({ childProcess: run.childProcess, expectedLaunchId: launchId, url: `${args.context.serverUrl}/health` });
    return run;
  } catch (error) {
    await stopProcess(run.childProcess, "server", "SIGTERM");
    if (args.processes.server === run) args.processes.server = null;
    throw new Error(`Server failed to become healthy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startDaemonProcess(context: AppContext, env: NodeJS.ProcessEnv, processes: Processes): Promise<ManagedProcessRun> {
  const run = spawnManaged({
    processName: "daemon",
    entry: context.daemonEntry,
    env: createDaemonEnv(context, env, context.serverUrl),
    logDir: context.logDir,
  });
  processes.daemon = run;
  try {
    await waitForHostDaemonStatus({
      childProcess: run.childProcess,
      expectedHostId: await expectedHostId(context.dataDir, env),
      expectedServerUrl: context.serverUrl,
      port: context.daemonPort,
    });
    return run;
  } catch (error) {
    await stopProcess(run.childProcess, "daemon", "SIGTERM");
    if (processes.daemon === run) processes.daemon = null;
    throw new Error(`Host daemon failed to become healthy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function stopAll(processes: Processes, signal: NodeJS.Signals): Promise<void> {
  await Promise.all([processes.server?.terminate(signal), processes.daemon?.terminate(signal)]);
}

/** Retries a crashed process every second until it is back or we are shutting down. */
async function restart(args: {
  context: AppContext;
  name: ManagedProcessName;
  start: Start;
  isShuttingDown: () => boolean;
  wait: (ms: number) => Promise<void>;
}): Promise<boolean> {
  while (!args.isShuttingDown()) {
    beginStep(`Restarting ${processLabel(args.name)}`);
    try {
      await args.start();
      endStep(green("✓"), `${args.name === "server" ? "Server" : "Host daemon"} restarted`);
      return true;
    } catch {
      if (args.isShuttingDown()) return false;
      endStep(red("✗"), `${args.name === "server" ? "Server" : "Host daemon"} failed to restart`);
      logStartupFailure(args.context, args.name);
      await args.wait(RESTART_DELAY_MS);
    }
  }
  return false;
}

/**
 * Keeps both processes up. If our server exits but a healthy server already answers on its port
 * (a newer copy of the app took over), this copy stops its daemon and steps aside.
 */
export async function supervise(args: {
  context: AppContext;
  processes: Processes;
  startServer: Start;
  startDaemon: Start;
  isShuttingDown: () => boolean;
  wait?: (ms: number) => Promise<void>;
  isServerAnswering?: (url: string) => Promise<boolean>;
}): Promise<"shutdown" | "stopped"> {
  const wait = args.wait ?? delay;
  while (!args.isShuttingDown()) {
    const { server, daemon } = args.processes;
    if (server === null || daemon === null) return "stopped";
    const exited = await Promise.race([server.exit, daemon.exit]);
    if (args.isShuttingDown()) return "shutdown";
    const name = exited.processName;
    if (name === "server") {
      if (args.processes.server === server) args.processes.server = null;
      if (await (args.isServerAnswering ?? isHealthyServerAnswering)(`${args.context.serverUrl}/health`)) {
        log(yellow("!"), `server exited with ${describeExit(exited.result)} - another server is healthy; stopping host daemon`);
        await stopAll(args.processes, "SIGTERM");
        return "stopped";
      }
    } else if (args.processes.daemon === daemon) {
      args.processes.daemon = null;
    }
    log(yellow("!"), `${processLabel(name)} exited with ${describeExit(exited.result)} - restarting ${processLabel(name)}`);
    await wait(RESTART_DELAY_MS);
    if (args.isShuttingDown()) return "shutdown";
    const restarted = await restart({
      context: args.context,
      name,
      start: name === "server" ? args.startServer : args.startDaemon,
      isShuttingDown: args.isShuttingDown,
      wait,
    });
    if (!restarted) return "shutdown";
  }
  return "shutdown";
}

function printReady(context: AppContext, listenerUrl: string): void {
  const row = (label: string, value: string): void => log(" ", `${dim(label.padEnd(6))} ${value}`);
  process.stdout.write("\n");
  log(green("●"), bold("Cloudroom is ready"));
  process.stdout.write("\n");
  row("app", cyan(listenerUrl));
  row("daemon", String(context.daemonPort));
  row("data", context.dataDir);
  row("db", context.dbPath);
  row("logs", `${context.logDir}/`);
  row("lock", context.daemonLockFile);
  process.stdout.write("\n");
  log(" ", dim("Press Ctrl+C to stop"));
}

/** `bb-app`: the desktop app and `pnpm start` run this. `bb-app host-daemon` runs a joined machine. */
export async function runApp(cliArgs: string[] = process.argv.slice(2), options: RunAppOptions = {}): Promise<void> {
  const { options: flags, positionals } = parseLauncherArgs(cliArgs);
  const [command = "start", ...rest] = positionals;
  if (flags.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "host-daemon") {
    if (options.dryRun || options.worktreePolicy) {
      throw new Error("--dryrun and --worktree work only when starting the whole app, not host-daemon.");
    }
    await runHostDaemon(rest, flags, import.meta.url);
    return;
  }
  if (command !== "start" || rest.length > 0) {
    process.stderr.write(`Unknown bb-app command: ${positionals.join(" ")}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const runtime = await resolveRuntime({
    entrypointUrl: import.meta.url,
    env: process.env,
    homeDir: homedir(),
    options: flags,
    mode: "local",
    worktreePolicy: options.worktreePolicy ?? null,
  });
  const { context } = runtime;
  const bindHost = runtime.serverEnv.BB_SERVER_BIND_HOST;
  if (bindHost !== undefined) parseServerBindHost(bindHost);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, ...context, serverBindHost: bindHost ?? ROOM_LOOPBACK_HOST }, null, 2)}\n`);
    return;
  }
  assertArtifacts(context, "app");

  const listenerUrl = serverListenerUrl(bindHost, context.serverPort);
  const serverEnv = createServerEnv(context, runtime.serverEnv);
  const sharedEnv = createSharedEnv(context, runtime.env);
  process.stdout.write(`\n  ${bold("Cloudroom")}\n\n`);
  if (existsSync(context.daemonLockDir)) {
    log(yellow("!"), "Daemon lock exists - waiting or reclaiming if stale");
    log(" ", dim(`lock: ${context.daemonLockDir}`));
  }
  const ownsRecord = await claimRoomAppRuntimeFile({
    dataDir: context.dataDir,
    entryPath: process.argv[1] ?? fileURLToPath(import.meta.url),
    pid: process.pid,
    serverUrl: context.serverUrl,
    startedAt: new Date().toISOString(),
    surface: parseAppSurface(runtime.env[APP_SURFACE_ENV_NAME]) ?? APP_SURFACE_WEB,
    version: context.appVersion,
  });
  if (!ownsRecord) {
    log(yellow("!"), "Another Cloudroom already runs on this data folder");
    log(" ", dim(`record: ${formatRoomAppRuntimeFilePath(context.dataDir)}`));
  }

  const processes: Processes = { server: null, daemon: null };
  let shutdownPromise: Promise<void> | null = null;
  const isShuttingDown = (): boolean => shutdownPromise !== null;
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    shutdownPromise ??= (async () => {
      process.stdout.write("\n");
      log(dim("●"), "Shutting down");
      await stopAll(processes, signal);
    })();
    return shutdownPromise;
  };
  const failStartup = async (name: ManagedProcessName, title: string, error: unknown): Promise<void> => {
    endStep(red("✗"), title);
    log(" ", dim(error instanceof Error ? error.message : String(error)));
    logStartupFailure(context, name);
    process.exitCode = 1;
    await shutdown("SIGTERM");
  };
  const startServer: Start = () =>
    startServerProcess({ context, env: serverEnv, processes, beforeStart: options.beforeServerStart });
  const stopForwarding = forwardTerminationSignals((signal) => void shutdown(signal));

  try {
    beginStep("Starting server");
    try {
      await startServer();
    } catch (error) {
      return await failStartup("server", "Server failed to start", error);
    }
    endStep(green("✓"), `Server listening on ${cyan(listenerUrl)}`);

    beginStep("Starting host daemon");
    const daemonEnv = await withAutoJoin(context.dataDir, context.serverUrl, sharedEnv);
    const startDaemon: Start = () => startDaemonProcess(context, daemonEnv, processes);
    try {
      await startDaemon();
    } catch (error) {
      return await failStartup("daemon", "Host daemon failed to start", error);
    }
    endStep(green("✓"), "Host daemon running");
    printReady(context, listenerUrl);

    const result = await supervise({ context, processes, startServer, startDaemon, isShuttingDown });
    if (shutdownPromise !== null) await shutdownPromise;
    if (result === "shutdown") process.exitCode = 0;
  } catch (error) {
    await shutdown("SIGTERM");
    throw error;
  } finally {
    stopForwarding();
    if (ownsRecord) await clearOwnRoomAppRuntimeFile({ dataDir: context.dataDir, pid: process.pid });
  }
}

export function runLauncherEntry(entry: () => Promise<void>): void {
  void entry().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
