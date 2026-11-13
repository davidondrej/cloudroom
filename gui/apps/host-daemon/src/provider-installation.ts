import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import {
  ensureDataTempDir,
  gitShell,
  normalizeWindowsEnv,
  preparePortablePtyCommand,
  resolvePortableCommand,
} from "@cloudroom/process-utils";
import type { ProviderInstallationCommand } from "@cloudroom/provider-bridge-protocol";
import {
  providerCliInstallEventSchema,
  type ProviderCliInstallEvent,
} from "@cloudroom/host-daemon-contract";
import { spawn as spawnPty } from "node-pty";
import type { HostDaemonLogger } from "./logger.js";
import { ensureNodePtySpawnHelperExecutable } from "./terminals/terminal-manager.js";

const nodePtyLogger: HostDaemonLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface ProviderInstallationProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  onError(listener: (error: Error) => void): void;
  onClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export interface ProviderInstallationProcessSpawner {
  spawn(args: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }): ProviderInstallationProcess;
}

let activeProviderId: string | null = null;

export class ProviderInstallationInProgressError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider installation already running for ${providerId}`);
    this.name = "ProviderInstallationInProgressError";
    this.providerId = providerId;
  }
}

function windowsPtyLaunch(
  command: string,
  args: string[],
  cwd: string,
  inheritedEnv: NodeJS.ProcessEnv,
): { command: string; args: string[] | string; env: NodeJS.ProcessEnv } {
  const env = normalizeWindowsEnv(inheritedEnv);
  const resolved = resolvePortableCommand(command, { cwd, env });
  if (resolved === undefined) {
    throw new Error(
      command === "sh"
        ? "This installer needs Git for Windows (Git Bash). Install it from https://git-scm.com/download/win, then try again."
        : `Command not found: ${command}`,
    );
  }
  return { ...preparePortablePtyCommand({ command: resolved, args, cwd, env }), env };
}

/**
 * Script installers run `sh -c`, but a default Git for Windows install puts
 * only `git\cmd` on PATH. Run them with Git's own shell instead (#1251).
 */
export async function withWindowsGitShell(args: {
  plan: ProviderInstallationCommand;
  env: NodeJS.ProcessEnv;
}): Promise<{ plan: ProviderInstallationCommand; env: NodeJS.ProcessEnv }> {
  if (
    process.platform !== "win32" ||
    args.plan.command !== "sh" ||
    resolvePortableCommand("sh", { env: args.env }) !== undefined
  ) {
    return args;
  }
  const shell = await gitShell(args.env).catch(() => null);
  return shell === null
    ? args
    : { plan: { ...args.plan, command: shell.command }, env: shell.env };
}

/**
 * Installers run outside any sandbox. On macOS and Linux each run gets a fresh TMPDIR in the data folder, so the
 * downloaded script (`${TMPDIR:-/tmp}/provider-installation.XXXXXX`) and whatever else the installer stages there stay
 * out of the OS temp folder, which Read-only Mac commands and sandboxed agents can change. Windows keeps its TEMP.
 */
export async function withPrivateInstallTemp<T>(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  if (process.platform === "win32") return run(env);
  const folder = await mkdtemp(
    join(ensureDataTempDir(dataDir), "provider-installation-"),
  );
  try {
    return await run({ ...env, TMPDIR: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function createPtyProviderInstallationProcessSpawner(): ProviderInstallationProcessSpawner {
  return {
    spawn(args) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const cwd = process.cwd();
      const env = args.env ?? process.env;
      const launch =
        process.platform === "win32"
          ? windowsPtyLaunch(args.command, args.args, cwd, env)
          : { command: args.command, args: args.args, env };
      ensureNodePtySpawnHelperExecutable(nodePtyLogger);
      const pty = spawnPty(launch.command, launch.args, {
        cols: 120,
        cwd,
        env: launch.env,
        name: "xterm-256color",
        rows: 30,
      });
      pty.onData((data) => stdout.write(data));
      pty.onExit(() => {
        stdout.end();
        stderr.end();
      });
      return {
        stdout,
        stderr,
        kill(signal) {
          pty.kill(signal);
          return true;
        },
        onError(listener) {
          void listener;
        },
        onClose(listener) {
          pty.onExit((event) => listener(event.exitCode, null));
        },
      };
    },
  };
}

export function streamProviderInstallation(args: {
  providerId: string;
  plan: ProviderInstallationCommand;
  env?: NodeJS.ProcessEnv;
  processSpawner?: ProviderInstallationProcessSpawner;
}): ReadableStream<Uint8Array> {
  if (activeProviderId !== null) {
    throw new ProviderInstallationInProgressError(activeProviderId);
  }
  activeProviderId = args.providerId;
  let closed = false;
  let child: ProviderInstallationProcess | null = null;
  const release = () => {
    if (activeProviderId === args.providerId) activeProviderId = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (event: ProviderCliInstallEvent) => {
        if (closed) return;
        const parsed = providerCliInstallEventSchema.parse(event);
        controller.enqueue(encoder.encode(`${JSON.stringify(parsed)}\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        release();
        controller.close();
      };
      write({
        type: "started",
        provider: args.providerId,
        command: args.plan.displayCommand,
      });
      try {
        child = (
          args.processSpawner ?? createPtyProviderInstallationProcessSpawner()
        ).spawn({
          command: args.plan.command,
          args: [...args.plan.args],
          ...(args.env === undefined ? {} : { env: args.env }),
        });
      } catch (error) {
        write({
          type: "error",
          provider: args.providerId,
          message: error instanceof Error ? error.message : String(error),
        });
        close();
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stdout",
          text,
        }),
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stderr",
          text,
        }),
      );
      child.onError((error) => {
        write({
          type: "error",
          provider: args.providerId,
          message: error.message,
        });
        close();
      });
      child.onClose((exitCode, signal) => {
        write({
          type: "completed",
          provider: args.providerId,
          exitCode,
          signal,
          success: exitCode === 0,
        });
        close();
      });
    },
    cancel() {
      closed = true;
      release();
      child?.kill("SIGTERM");
    },
  });
}
