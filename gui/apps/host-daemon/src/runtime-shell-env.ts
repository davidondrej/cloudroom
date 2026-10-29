import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { basename, delimiter, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeOptions } from "@cloudroom/agent-runtime";
import { assignIfDefined } from "@cloudroom/config/objects";
import { resolvePortableCommand } from "@cloudroom/process-utils";

interface ResolveLocalBbExecutablePathOptions {
  cliExecutablePath?: string;
  cliRuntimePath?: string;
}

interface PrepareRuntimeShellEnvOptions {
  bbExecutableDirectory: string;
  bbExecutablePath?: string;
  dataDir?: string;
  hostDaemonPort?: number;
  serverUrl: string;
  inheritedPath?: string;
  /** Cloudroom's own agent tools, such as the browser-harness shim. */
  toolsDirectory?: string;
  powershellExecutionPolicy?: string | null;
}

interface ResolveUserShellEnvOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnUserShellEnv?: SpawnUserShellEnv;
  timeoutMs?: number;
}

interface ResolvePowerShellExecutionPolicyOptions extends ResolveUserShellEnvOptions {
  /** The PowerShells to ask; found on this machine when omitted. */
  powershells?: string[];
}

export interface SpawnUserShellEnvArgs {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface UserShellEnvSpawnResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type SpawnUserShellEnv = (
  args: SpawnUserShellEnvArgs,
) => Promise<UserShellEnvSpawnResult>;

const SHELL_ENV_START_MARKER = "__BB_SHELL_ENV_START__";
const SHELL_ENV_END_MARKER = "__BB_SHELL_ENV_END__";
const SHELL_ENV_COMMAND = [
  `printf '%s\\n' ${SHELL_ENV_START_MARKER}`,
  "env",
  `printf '%s\\n' ${SHELL_ENV_END_MARKER}`,
].join("; ");
const USER_SHELL_ENV_TIMEOUT_MS = 3_000;
const POWERSHELL_EXECUTION_POLICY_VARIABLE = "PSExecutionPolicyPreference";
const WINDOWS_MACHINE_ENVIRONMENT_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const WINDOWS_USER_ENVIRONMENT_KEY = "HKCU\\Environment";
const WINDOWS_REGISTRY_VALUE_PATTERN = /^ {4}(.+?) {4}REG_[A-Z_]+ {4}(.*)$/gmu;
const POWERSHELL_POLICY_QUERY =
  'Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }';
// Every scope PowerShell reads besides Process. Our variable is the Process
// scope, which outranks CurrentUser and LocalMachine, so we only set it when
// all of these are Undefined.
const POWERSHELL_CONFIGURED_SCOPES = [
  "MachinePolicy",
  "UserPolicy",
  "CurrentUser",
  "LocalMachine",
];
const POWERSHELL_POLICY_TIMEOUT_MS = 15_000;
const DEFAULT_POWERSHELL_EXECUTION_POLICY = "RemoteSigned";
const WINDOWS_ENVIRONMENT_REFERENCE_PATTERN = /%([^%;\\/]+)%/gu;
const USER_SHELL_ENV_FORCE_KILL_AFTER_MS = 1_000;

function getDefaultCliExecutablePath(): string {
  return fileURLToPath(new URL("../../cli/bin/room-cli", import.meta.url));
}

function getDefaultCliRuntimePath(): string {
  return fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
}

function getErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function resolveCliEntryPath(cliExecutablePath: string): Promise<string> {
  const cliEntryPath = resolve(cliExecutablePath);

  try {
    const stats = await fs.stat(cliEntryPath);
    if (!stats.isFile()) {
      throw new Error(`Resolved bb CLI entry is not a file: ${cliEntryPath}`);
    }
    if (process.platform !== "win32") {
      try {
        await fs.access(cliEntryPath, fsConstants.X_OK);
      } catch (error) {
        if (getErrorCode(error) === "EACCES") {
          throw new Error(
            `Resolved bb CLI entry is not executable: ${cliEntryPath}. Build @cloudroom/cli before starting the host daemon.`,
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `Missing built bb CLI entry at ${cliEntryPath}. Build @cloudroom/cli before starting the host daemon.`,
      );
    }
    throw error;
  }

  return cliEntryPath;
}

async function requireCliRuntimePath(cliRuntimePath: string): Promise<void> {
  const resolvedCliRuntimePath = resolve(cliRuntimePath);

  try {
    const stats = await fs.stat(resolvedCliRuntimePath);
    if (!stats.isFile()) {
      throw new Error(
        `Resolved bb CLI runtime is not a file: ${resolvedCliRuntimePath}`,
      );
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `Missing built bb CLI runtime at ${resolvedCliRuntimePath}. Build @cloudroom/cli before starting the host daemon.`,
      );
    }
    throw error;
  }
}

function prependPath(
  executableDirectoryPath: string,
  inheritedPath?: string,
): string {
  return inheritedPath
    ? `${executableDirectoryPath}${delimiter}${inheritedPath}`
    : executableDirectoryPath;
}

function defaultSpawnUserShellEnv(
  args: SpawnUserShellEnvArgs,
): Promise<UserShellEnvSpawnResult> {
  return new Promise<UserShellEnvSpawnResult>((resolveSpawn) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;

    function clearTimeouts(args?: { keepForceKillTimeout?: boolean }): void {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (!args?.keepForceKillTimeout && forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
    }

    function settle(
      result: UserShellEnvSpawnResult,
      args?: { keepForceKillTimeout?: boolean },
    ): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeouts(args);
      resolveSpawn(result);
    }

    function forceKillChildAfterDelay(): void {
      if (forceKillTimeout) {
        return;
      }
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, USER_SHELL_ENV_FORCE_KILL_AFTER_MS);
      forceKillTimeout.unref();
    }

    function terminateChild(): void {
      child.kill("SIGTERM");
      forceKillChildAfterDelay();
    }

    try {
      child = spawn(args.command, args.args, {
        env: args.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle({
        error: error instanceof Error ? error : new Error(String(error)),
        signal: null,
        status: null,
        stderr,
        stdout,
      });
      return;
    }

    timeout = setTimeout(() => {
      terminateChild();
      settle(
        {
          error: new Error(
            `Shell env probe timed out after ${args.timeoutMs}ms`,
          ),
          signal: "SIGTERM",
          status: null,
          stderr,
          stdout,
        },
        { keepForceKillTimeout: true },
      );
    }, args.timeoutMs);
    timeout.unref();

    if (!child.stdout || !child.stderr) {
      terminateChild();
      settle(
        {
          error: new Error("Shell env probe did not attach stdout and stderr"),
          signal: null,
          status: null,
          stderr,
          stdout,
        },
        { keepForceKillTimeout: true },
      );
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        clearTimeouts();
        return;
      }
      settle({
        error,
        signal: null,
        status: null,
        stderr,
        stdout,
      });
    });
    child.on("close", (status, signal) => {
      if (settled) {
        clearTimeouts();
        return;
      }
      settle({
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
}

function resolveUserShellCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (platform === "win32") {
    return null;
  }
  const configuredShell = env.SHELL?.trim();
  if (configuredShell && configuredShell.length > 0) {
    return configuredShell;
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

function userShellEnvArgSets(shell: string): string[][] {
  const shellName = basename(shell);
  if (shellName === "sh" || shellName === "dash") {
    return [["-lc", SHELL_ENV_COMMAND]];
  }
  return [
    ["-ilc", SHELL_ENV_COMMAND],
    ["-lc", SHELL_ENV_COMMAND],
  ];
}

const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;

function parseUserShellEnv(stdout: string): Record<string, string> | null {
  const lines = stdout.split(/\r?\n/u);
  const startIndex = lines.findIndex(
    (line) => line.trim() === SHELL_ENV_START_MARKER,
  );
  if (startIndex === -1) {
    return null;
  }
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === SHELL_ENV_END_MARKER,
  );
  if (endIndex === -1) {
    return null;
  }

  const env: Record<string, string> = {};
  let lastKey: string | undefined;
  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const match = ENV_LINE_PATTERN.exec(line);
    if (match) {
      lastKey = match[1];
      env[lastKey] = match[2];
    } else if (lastKey !== undefined) {
      // `env` prints multi-line values as raw continuation lines.
      env[lastKey] += `\n${line}`;
    }
  }
  const path = env.PATH?.trim();
  if (!path) {
    return null;
  }
  env.PATH = path;
  return env;
}

// Vars owned by Cloudroom, the probe shell, or Node (NODE_OPTIONS would also
// load into Cloudroom's own bridge processes). Everything else in the user's
// login shell (API keys, tool config) reaches provider processes, the same as
// when the user runs those CLIs in their terminal.
const NON_PROVIDER_SHELL_ENV_KEYS = new Set([
  "NODE_ENV",
  "NODE_OPTIONS",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHLVL",
  "_",
]);

export function providerEnvFromUserShell(
  shellEnv: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(shellEnv).filter(
      ([key]) =>
        !NON_PROVIDER_SHELL_ENV_KEYS.has(key) &&
        !key.startsWith("BB_") &&
        !key.startsWith("ROOM_") &&
        !key.startsWith("ELECTRON_"),
    ),
  );
}

function windowsEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : env[key];
}

function expandWindowsEnvironmentReferences(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(
    WINDOWS_ENVIRONMENT_REFERENCE_PATTERN,
    (reference, name: string) =>
      windowsEnvironmentValue(env, name) ?? reference,
  );
}

function splitWindowsPath(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  return (value ?? "")
    .split(";")
    .map((entry) => expandWindowsEnvironmentReferences(entry.trim(), env))
    .filter((entry) => entry.length > 0);
}

function windowsRegistryCommand(env: NodeJS.ProcessEnv): string {
  return win32.join(
    windowsEnvironmentValue(env, "SystemRoot") ?? "C:\\Windows",
    "System32",
    "reg.exe",
  );
}

async function readWindowsRegistryEnvironment(
  options: ResolveUserShellEnvOptions,
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<Map<string, string> | null> {
  const spawnUserShellEnv =
    options.spawnUserShellEnv ?? defaultSpawnUserShellEnv;
  const result = await spawnUserShellEnv({
    command: windowsRegistryCommand(env),
    args: ["query", key],
    env,
    timeoutMs: options.timeoutMs ?? USER_SHELL_ENV_TIMEOUT_MS,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0
  ) {
    return null;
  }
  const values = new Map<string, string>();
  for (const match of result.stdout.matchAll(WINDOWS_REGISTRY_VALUE_PATTERN)) {
    const name = match[1]?.trim();
    if (name !== undefined && name.length > 0) {
      values.set(name, (match[2] ?? "").trim());
    }
  }
  return values;
}

function takeWindowsRegistryPath(values: Map<string, string>): string {
  for (const [name, value] of values) {
    if (name.toUpperCase() === "PATH") {
      values.delete(name);
      return value;
    }
  }
  return "";
}

async function resolveWindowsRegistryPath(
  options: ResolveUserShellEnvOptions,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const machineValues = await readWindowsRegistryEnvironment(
    options,
    env,
    WINDOWS_MACHINE_ENVIRONMENT_KEY,
  );
  if (machineValues === null) {
    return null;
  }
  // An unreadable user environment fails the whole refresh, so the caller
  // keeps the last good PATH rather than dropping the user's entries.
  const userValues = await readWindowsRegistryEnvironment(
    options,
    env,
    WINDOWS_USER_ENVIRONMENT_KEY,
  );
  if (userValues === null) {
    return null;
  }
  const machinePath = takeWindowsRegistryPath(machineValues);
  const userPath = takeWindowsRegistryPath(userValues);
  const refreshedEnv: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of [...machineValues, ...userValues]) {
    const existingName = Object.keys(refreshedEnv).find(
      (candidate) => candidate.toUpperCase() === name.toUpperCase(),
    );
    refreshedEnv[existingName ?? name] = expandWindowsEnvironmentReferences(
      value,
      refreshedEnv,
    );
  }
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [
    ...splitWindowsPath(machinePath, refreshedEnv),
    ...splitWindowsPath(userPath, refreshedEnv),
    ...splitWindowsPath(windowsEnvironmentValue(env, "PATH"), env),
  ]) {
    const key = entry.replace(/[\\/]+$/u, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  return entries.length === 0 ? null : entries.join(";");
}

async function installedPowerShells(env: NodeJS.ProcessEnv): Promise<string[]> {
  const pwsh = resolvePortableCommand("pwsh.exe", { env });
  const windowsPowerShell = win32.join(
    windowsEnvironmentValue(env, "SystemRoot") ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const hasWindowsPowerShell = await fs.access(windowsPowerShell).then(
    () => true,
    () => false,
  );
  return [
    ...(pwsh ? [pwsh] : []),
    ...(hasWindowsPowerShell ? [windowsPowerShell] : []),
  ];
}

/**
 * RemoteSigned for agent and terminal shells, so npm's `.ps1` shims run, but
 * only when nobody chose a policy. Asks each installed PowerShell itself
 * (`Get-ExecutionPolicy -List`), which covers Group Policy, the registry and
 * PowerShell 7's config files wherever they live. Any doubt means null.
 */
export async function resolvePowerShellExecutionPolicyDefault(
  options: ResolvePowerShellExecutionPolicyOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") {
    return null;
  }
  if (
    windowsEnvironmentValue(env, POWERSHELL_EXECUTION_POLICY_VARIABLE) !==
    undefined
  ) {
    return null;
  }
  const powershells = options.powershells ?? (await installedPowerShells(env));
  if (powershells.length === 0) return null;
  const spawnUserShellEnv =
    options.spawnUserShellEnv ?? defaultSpawnUserShellEnv;
  const unset = await Promise.all(
    powershells.map(async (powershell) => {
      const result = await spawnUserShellEnv({
        command: powershell,
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          POWERSHELL_POLICY_QUERY,
        ],
        env,
        timeoutMs: options.timeoutMs ?? POWERSHELL_POLICY_TIMEOUT_MS,
      });
      if (
        result.error !== undefined ||
        result.signal !== null ||
        result.status !== 0
      ) {
        return false;
      }
      const policies = new Map(
        result.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim().split("="))
          .filter((parts) => parts.length === 2)
          .map(([scope = "", policy = ""]) => [scope, policy]),
      );
      return POWERSHELL_CONFIGURED_SCOPES.every(
        (scope) => policies.get(scope) === "Undefined",
      );
    }),
  );
  return unset.every(Boolean) ? DEFAULT_POWERSHELL_EXECUTION_POLICY : null;
}

async function resolveUserShellEnvWithPrevious(
  options: ResolveUserShellEnvOptions,
  previousEnv: Record<string, string> | null,
): Promise<Record<string, string> | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // Windows has no login shell to ask: re-read PATH from the registry.
    const path = await resolveWindowsRegistryPath(options, env);
    return path === null ? previousEnv : { PATH: path };
  }
  const shell = resolveUserShellCommand(env, platform);
  if (!shell) {
    return null;
  }

  const spawnUserShellEnv =
    options.spawnUserShellEnv ?? defaultSpawnUserShellEnv;
  const shellArgSets = userShellEnvArgSets(shell);
  for (const [index, shellArgs] of shellArgSets.entries()) {
    const result = await spawnUserShellEnv({
      command: shell,
      args: shellArgs,
      env,
      timeoutMs: options.timeoutMs ?? USER_SHELL_ENV_TIMEOUT_MS,
    });
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0
    ) {
      if (index === 0 && previousEnv !== null) {
        return previousEnv;
      }
      continue;
    }
    const shellEnv = parseUserShellEnv(result.stdout);
    if (shellEnv !== null) {
      return shellEnv;
    }
    if (index === 0 && previousEnv !== null) {
      return previousEnv;
    }
  }

  return null;
}

export function createUserShellEnvResolver(
  options: ResolveUserShellEnvOptions = {},
): () => Promise<Record<string, string> | null> {
  let previousEnv: Record<string, string> | null = null;
  return async () => {
    const shellEnv = await resolveUserShellEnvWithPrevious(
      options,
      previousEnv,
    );
    if (shellEnv !== null) previousEnv = shellEnv;
    return shellEnv;
  };
}

export async function resolveLocalBbExecutablePath(
  options: ResolveLocalBbExecutablePathOptions = {},
): Promise<string> {
  const resolvedCliExecutablePath =
    options.cliExecutablePath ?? getDefaultCliExecutablePath();
  const cliEntryPath = await resolveCliEntryPath(resolvedCliExecutablePath);
  const cliRuntimePath =
    options.cliRuntimePath ??
    (options.cliExecutablePath === undefined
      ? getDefaultCliRuntimePath()
      : undefined);
  if (cliRuntimePath !== undefined) {
    await requireCliRuntimePath(cliRuntimePath);
  }
  return cliEntryPath;
}

export function resolveBbExecutablePathInDirectory(
  bbExecutableDirectory: string,
): string {
  return resolve(bbExecutableDirectory, "room-cli");
}

export function prepareRuntimeShellEnv(
  options: PrepareRuntimeShellEnvOptions,
): NonNullable<AgentRuntimeOptions["shellEnv"]> {
  const bbExecutablePath =
    options.bbExecutablePath ??
    resolveBbExecutablePathInDirectory(options.bbExecutableDirectory);
  const inheritedPath = options.inheritedPath ?? process.env.PATH;
  const shellEnv: NonNullable<AgentRuntimeOptions["shellEnv"]> = {
    PATH: prependPath(
      options.bbExecutableDirectory,
      options.toolsDirectory === undefined
        ? inheritedPath
        : prependPath(options.toolsDirectory, inheritedPath),
    ),
    ROOM_CLI: bbExecutablePath,
    ROOM_SERVER_URL: options.serverUrl,
    ...(options.dataDir === undefined
      ? {}
      : { ROOM_DATA_DIR: options.dataDir }),
  };
  assignIfDefined({
    key: "ROOM_HOST_DAEMON_PORT",
    target: shellEnv,
    value:
      options.hostDaemonPort === undefined
        ? undefined
        : String(options.hostDaemonPort),
  });
  if (
    options.powershellExecutionPolicy !== undefined &&
    options.powershellExecutionPolicy !== null
  ) {
    shellEnv[POWERSHELL_EXECUTION_POLICY_VARIABLE] =
      options.powershellExecutionPolicy;
  }
  return shellEnv;
}
