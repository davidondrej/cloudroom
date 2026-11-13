import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { posix as posixPath } from "node:path";
import {
  hasProcessExited,
  waitForProcessExit,
  waitForProcessExitWithTimeout,
  type ChildProcessExitResult,
} from "@cloudroom/config/child-process-exit";

interface RuntimeLogBuffer {
  append(chunk: Buffer | string): void;
  text(): string;
}

interface CreateRuntimeLogBufferArgs {
  maxLines: number;
}

interface StartRoomAppProcessArgs {
  bridgePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logLineLimit: number;
  runtime: RoomAppProcessRuntime;
}

export interface RoomAppProcess {
  childProcess: ChildProcess;
  exit: Promise<RoomAppProcessExit>;
  logs: RuntimeLogBuffer;
  pid: number;
  stop(args: StopRoomAppProcessArgs): Promise<void>;
}

export type RoomAppProcessExit = ChildProcessExitResult;

interface StopRoomAppProcessArgs {
  killSignal: NodeJS.Signals;
  killTimeoutMs: number;
  signal: NodeJS.Signals;
  timeoutMs: number;
}

type RoomAppProcessRuntimeMode = "electron-node" | "node";

interface DirectRoomAppProcessRuntime {
  executablePath: string;
  kind: "direct";
  mode: RoomAppProcessRuntimeMode;
}

interface AppImageRoomAppProcessRuntime {
  appDirPath: string;
  executablePath: string;
  kind: "appimage";
  mode: "electron-node";
}

type RoomAppProcessRuntime =
  | AppImageRoomAppProcessRuntime
  | DirectRoomAppProcessRuntime;

interface CreateRoomAppProcessLaunchArgs {
  bridgePath: string;
  env: NodeJS.ProcessEnv;
  runtime: RoomAppProcessRuntime;
}

interface RoomAppProcessLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  executablePath: string;
}

interface CreateRoomAppProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  runtimeMode: RoomAppProcessRuntimeMode;
}

interface ResolveRoomAppProcessRuntimeArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  processExecPath: string;
}

const APPIMAGE_BRIDGE_RELATIVE_PATH_ENV =
  "BB_DESKTOP_APPIMAGE_BRIDGE_RELATIVE_PATH";

async function runAppImageBridgeSupervisor(
  bridgeRelativePathEnv: string,
): Promise<void> {
  const { spawn: spawnChild } = process.getBuiltinModule("node:child_process");
  const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { resolve: resolvePath } = process.getBuiltinModule("node:path");
  const appDirPath = process.env.APPDIR;
  const bridgeRelativePath = process.env[bridgeRelativePathEnv];
  if (!appDirPath || !bridgeRelativePath) {
    throw new Error("AppImage bridge bootstrap environment is incomplete");
  }

  const bridgePath = resolvePath(appDirPath, bridgeRelativePath);
  const bridgeProcess = spawnChild(process.execPath, [bridgePath], {
    env: process.env,
    stdio: "inherit",
  });
  if (bridgeProcess.pid === undefined) {
    throw new Error("AppImage bridge process did not expose a PID");
  }

  const supervisorPid = process.pid;
  let terminationSignal: NodeJS.Signals | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const signalBridgeGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-supervisorPid, signal);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return false;
      }
      throw error;
    }
  };
  const bridgeGroupHasLiveDescendants = (): boolean => {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
        continue;
      }
      const pid = Number(entry.name);
      if (pid === supervisorPid) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const state = fields[0];
        const processGroupId = Number(fields[2]);
        if (state !== "Z" && processGroupId === supervisorPid) {
          return true;
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        ) {
          continue;
        }
        throw error;
      }
    }
    return false;
  };
  const beginTermination = (signal: NodeJS.Signals): void => {
    if (terminationSignal !== null) {
      return;
    }
    terminationSignal = signal;
    signalBridgeGroup(signal);
    killTimer = setTimeout(() => signalBridgeGroup("SIGKILL"), 4_000);
  };
  process.on("SIGINT", () => beginTermination("SIGINT"));
  process.on("SIGTERM", () => beginTermination("SIGTERM"));

  const bridgeExitCode = await new Promise<number | null>(
    (resolveExit, rejectExit) => {
      bridgeProcess.once("error", rejectExit);
      bridgeProcess.once("exit", (code) => resolveExit(code));
    },
  );
  while (bridgeGroupHasLiveDescendants()) {
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }
  if (killTimer !== null) {
    clearTimeout(killTimer);
  }
  if (terminationSignal === null) {
    process.exitCode = bridgeExitCode ?? 1;
  }
}

const APPIMAGE_BRIDGE_BOOTSTRAP = `await (${runAppImageBridgeSupervisor.toString()})(${JSON.stringify(APPIMAGE_BRIDGE_RELATIVE_PATH_ENV)});`;

function createRuntimeLogBuffer(
  args: CreateRuntimeLogBufferArgs,
): RuntimeLogBuffer {
  const lines: string[] = [];

  return {
    append(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const line of text.split(/\r?\n/u)) {
        if (line.length === 0) {
          continue;
        }
        lines.push(line);
      }
      while (lines.length > args.maxLines) {
        lines.shift();
      }
    },
    text() {
      return lines.join("\n");
    },
  };
}

export function createRoomAppProcessEnv(
  args: CreateRoomAppProcessEnvArgs,
): NodeJS.ProcessEnv {
  if (args.runtimeMode === "electron-node") {
    return { ...args.env, ELECTRON_RUN_AS_NODE: "1" };
  }

  const env = { ...args.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function resolveRoomAppProcessRuntime(
  args: ResolveRoomAppProcessRuntimeArgs,
): RoomAppProcessRuntime {
  if (args.isPackaged) {
    const appImagePath = args.env.APPIMAGE?.trim();
    const appDirPath = args.env.APPDIR?.trim();
    if (
      args.platform === "linux" &&
      appImagePath !== undefined &&
      appImagePath.length > 0 &&
      appDirPath !== undefined &&
      appDirPath.length > 0
    ) {
      return {
        appDirPath,
        executablePath: appImagePath,
        kind: "appimage",
        mode: "electron-node",
      };
    }

    return {
      executablePath: args.processExecPath,
      kind: "direct",
      mode: "electron-node",
    };
  }

  const rawNodeExecPath = args.env.BB_DESKTOP_NODE_EXEC_PATH?.trim();
  if (rawNodeExecPath === undefined || rawNodeExecPath.length === 0) {
    throw new Error(
      "BB_DESKTOP_NODE_EXEC_PATH is required in desktop dev mode. Launch through apps/desktop/scripts/run-electron-dev.mjs.",
    );
  }

  return {
    executablePath: rawNodeExecPath,
    kind: "direct",
    mode: "node",
  };
}

export function createRoomAppProcessLaunch(
  args: CreateRoomAppProcessLaunchArgs,
): RoomAppProcessLaunch {
  const env = createRoomAppProcessEnv({
    env: args.env,
    runtimeMode: args.runtime.mode,
  });
  if (args.runtime.kind === "direct") {
    return {
      args: [args.bridgePath],
      env,
      executablePath: args.runtime.executablePath,
    };
  }

  const bridgeRelativePath = posixPath.relative(
    args.runtime.appDirPath,
    args.bridgePath,
  );
  if (
    bridgeRelativePath.length === 0 ||
    posixPath.isAbsolute(bridgeRelativePath) ||
    bridgeRelativePath === ".." ||
    bridgeRelativePath.startsWith("../")
  ) {
    throw new Error("bb-app bridge path must be inside the AppImage mount");
  }

  return {
    args: [
      "--input-type=module",
      "--eval",
      APPIMAGE_BRIDGE_BOOTSTRAP,
      "--",
      args.bridgePath,
      "--no-sandbox",
    ],
    env: {
      ...env,
      [APPIMAGE_BRIDGE_RELATIVE_PATH_ENV]: bridgeRelativePath,
    },
    executablePath: args.runtime.executablePath,
  };
}

interface CloseInheritedFdsArgs {
  bashPath?: string;
  launch: RoomAppProcessLaunch;
  platform: NodeJS.Platform;
}

const LINUX_BASH_PATH = "/bin/bash";
// bash reads these before the script runs: they could stop startup or skip
// the fd cleanup, so with any of them set bb-app spawns directly.
const BASH_STARTUP_ENV_KEYS = ["BASH_ENV", "BASHOPTS", "ENV", "SHELLOPTS"];
// Vars bash adds when the parent did not set them. Its exec still adds
// SHLVL=0, which a login shell treats the same as an unset SHLVL.
const BASH_ADDED_ENV_KEYS = ["OLDPWD", "PWD"];

// Electron's main process holds many descriptors without close-on-exec
// (Chromium shared memory, .pak files, sockets), and Node's spawn keeps them
// open in the child. bb-app, the host daemon, terminals and agent tools all
// inherited them (#1089). On Linux, close every fd above stdio in a bash that
// then execs the real command, keeping the same PID. dash cannot close fds
// above 9, so without bash this spawns directly, as before.
function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function closeInheritedFdsOnLinux(
  args: CloseInheritedFdsArgs,
): RoomAppProcessLaunch {
  const bashPath = args.bashPath ?? LINUX_BASH_PATH;
  const env = args.launch.env;
  if (
    args.platform !== "linux" ||
    BASH_STARTUP_ENV_KEYS.some((key) => env[key] !== undefined) ||
    Object.keys(env).some((key) => key.startsWith("BASH_FUNC_")) ||
    !isExecutable(bashPath)
  ) {
    return args.launch;
  }
  const addedKeys = BASH_ADDED_ENV_KEYS.filter((key) => env[key] === undefined);
  const unset = addedKeys.length > 0 ? `unset ${addedKeys.join(" ")}; ` : "";
  const script =
    'for f in /proc/self/fd/*; do n="${f##*/}"; ' +
    '[ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-"; done; ' +
    `${unset}exec "$0" "$@"`;
  return {
    args: [
      "--noprofile",
      "--norc",
      "-c",
      script,
      args.launch.executablePath,
      ...args.launch.args,
    ],
    env,
    executablePath: bashPath,
  };
}

export function startRoomAppProcess(args: StartRoomAppProcessArgs): RoomAppProcess {
  const logs = createRuntimeLogBuffer({ maxLines: args.logLineLimit });
  const directLaunch = createRoomAppProcessLaunch({
    bridgePath: args.bridgePath,
    env: args.env,
    runtime: args.runtime,
  });
  const launch = closeInheritedFdsOnLinux({
    launch: directLaunch,
    platform: process.platform,
  });
  const spawnLaunch = (target: RoomAppProcessLaunch): ChildProcess =>
    spawn(target.executablePath, target.args, {
      cwd: args.cwd,
      detached: args.runtime.kind === "appimage",
      env: target.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let childProcess = spawnLaunch(launch);
  if (launch !== directLaunch && childProcess.pid === undefined) {
    // The bash wrapper could not start: launch directly, as before.
    childProcess.once("error", () => undefined);
    childProcess = spawnLaunch(directLaunch);
  }
  const pid = childProcess.pid;
  if (pid === undefined) {
    throw new Error("bb-app child process did not expose a PID");
  }

  if (childProcess.stdout !== null) {
    childProcess.stdout.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  if (childProcess.stderr !== null) {
    childProcess.stderr.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  const exit = waitForProcessExit(childProcess);

  return {
    childProcess,
    exit,
    logs,
    pid,
    async stop(stopArgs) {
      if (hasProcessExited(childProcess)) {
        return;
      }
      childProcess.kill(stopArgs.signal);
      const gracefulResult = await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.timeoutMs,
      });
      if (gracefulResult === "exited") {
        return;
      }

      if (!hasProcessExited(childProcess)) {
        childProcess.kill(stopArgs.killSignal);
      }
      await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.killTimeoutMs,
      });
    },
  };
}
