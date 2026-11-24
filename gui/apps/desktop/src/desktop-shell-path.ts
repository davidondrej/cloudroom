import { spawn } from "node:child_process";

const MACOS_LOGIN_SHELL = "/bin/zsh";
const SHELL_PATH_COMMAND = 'printf "%s" "$PATH"';
const SHELL_PATH_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const EXIT_DRAIN_MS = 250;

export interface DesktopShellPathLogger {
  warn(message: string): void;
}

export interface SpawnLoginShellPathArgs {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface ShellPathSpawnResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type SpawnLoginShellPath = (
  args: SpawnLoginShellPathArgs,
) => ShellPathSpawnResult | Promise<ShellPathSpawnResult>;

type EnsurePackagedUserShellPathResult =
  | ShellPathSkippedResult
  | ShellPathUpdatedResult
  | ShellPathUnchangedResult;

interface EnsurePackagedUserShellPathArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  logger: DesktopShellPathLogger;
  platform: NodeJS.Platform;
  spawnLoginShellPath?: SpawnLoginShellPath;
  timeoutMs?: number;
}

interface ShellPathSkippedResult {
  kind: "skipped";
  reason: "not-packaged" | "unsupported-platform";
}

interface ShellPathUnchangedResult {
  kind: "unchanged";
  reason: "empty-output" | "non-zero-status" | "shell-error" | "signal";
}

interface ShellPathUpdatedResult {
  kind: "updated";
  path: string;
}

function defaultSpawnLoginShellPath(
  args: SpawnLoginShellPathArgs,
): Promise<ShellPathSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(args.command, args.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let done = false;
    let drain: ReturnType<typeof setTimeout> | undefined;

    // A background job the shell started can inherit the pipes and keep them open, so this never waits for them to
    // close: it ends at exit (after a short drain), at the timeout, or past the output cap.
    const finish = (
      result: Pick<ShellPathSpawnResult, "error" | "signal" | "status">,
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        ...result,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    };
    const fail = (code: string) => {
      finish({
        error: Object.assign(new Error(`spawn ${args.command} ${code}`), {
          code,
        }),
        signal: null,
        status: null,
      });
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      // Cut-off output would become a broken PATH, so too much output fails the lookup, as spawnSync's maxBuffer did.
      if (bytes > MAX_OUTPUT_BYTES) fail("ENOBUFS");
      else into.push(chunk);
    };

    const timer = setTimeout(() => fail("ETIMEDOUT"), args.timeoutMs);
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish({ error, signal: null, status: null }));
    child.on("exit", (status, signal) => {
      drain = setTimeout(() => finish({ signal, status }), EXIT_DRAIN_MS);
    });
    child.on("close", (status, signal) => finish({ signal, status }));
  });
}

function warnShellPathFallback(
  args: EnsurePackagedUserShellPathArgs,
  message: string,
): void {
  args.logger.warn(
    `Could not load the user shell PATH for the packaged desktop app: ${message}. Continuing with the inherited PATH.`,
  );
}

export async function ensurePackagedUserShellPath(
  args: EnsurePackagedUserShellPathArgs,
): Promise<EnsurePackagedUserShellPathResult> {
  if (args.platform !== "darwin" && args.platform !== "linux") {
    return { kind: "skipped", reason: "unsupported-platform" };
  }
  if (!args.isPackaged) {
    return { kind: "skipped", reason: "not-packaged" };
  }

  const spawnLoginShellPath =
    args.spawnLoginShellPath ?? defaultSpawnLoginShellPath;
  const result = await spawnLoginShellPath({
    args: ["-ilc", SHELL_PATH_COMMAND],
    command:
      args.platform === "darwin"
        ? MACOS_LOGIN_SHELL
        : (args.env.SHELL ?? "/bin/bash"),
    timeoutMs: args.timeoutMs ?? SHELL_PATH_TIMEOUT_MS,
  });

  if (result.error !== undefined) {
    warnShellPathFallback(args, result.error.message);
    return { kind: "unchanged", reason: "shell-error" };
  }

  if (result.signal !== null) {
    warnShellPathFallback(args, `shell exited from signal ${result.signal}`);
    return { kind: "unchanged", reason: "signal" };
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    warnShellPathFallback(
      args,
      stderr.length > 0
        ? `shell exited with status ${result.status}: ${stderr}`
        : `shell exited with status ${result.status}`,
    );
    return { kind: "unchanged", reason: "non-zero-status" };
  }

  const shellPath = result.stdout.trim();
  if (shellPath.length === 0) {
    warnShellPathFallback(args, "shell returned an empty PATH");
    return { kind: "unchanged", reason: "empty-output" };
  }

  args.env.PATH = shellPath;
  args.env.CLOUDROOM_SHELL_PATH = shellPath;
  return { kind: "updated", path: shellPath };
}
