/// <reference path="./cross-spawn.d.ts" />
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, posix, resolve, win32 } from "node:path";
import parseCrossSpawnCommand from "cross-spawn/lib/parse.js";

// Windows process helpers, hand-ported from get-bb/bb#4610, #5429 and #5997
// (MIT). Every helper is a no-op or plain lookup off Windows.

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The file extensions Windows runs a bare command name with (PATHEXT). */
export function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATHEXT");
  return (env[key ?? "PATHEXT"] ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.length > 0);
}

/** The Cursor CLI's login file on Linux and Windows; macOS keeps it in the Keychain. */
export function cursorAuthFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  if (platform === "win32") {
    return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  }
  if (platform === "linux") {
    return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "cursor", "auth.json");
  }
  return null;
}

/** A Windows app's environment as `NAME=value` entries: the user's variables come from the system there, not a login shell. */
export function userEnvironmentEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).map(([name, value]) => `${name}=${value ?? ""}`);
}

/**
 * Leaves one `PATH` key. Windows inherits `Path`, Cloudroom writes `PATH`, and
 * a child sees only one of them, so ours wins and the inherited copy goes.
 */
export function normalizeWindowsEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const pathKeys = Object.keys(env).filter(
    (key) => key.toUpperCase() === "PATH",
  );
  if (pathKeys.length === 0 || (pathKeys.length === 1 && "PATH" in env)) {
    return env;
  }
  const value = env.PATH ?? env[pathKeys.sort()[0] ?? "PATH"];
  const normalized = { ...env };
  for (const key of pathKeys) delete normalized[key];
  if (value !== undefined) normalized.PATH = value;
  return normalized;
}

function isRunnableFile(candidate: string): boolean {
  try {
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the file a command name runs, like the shell would. On Windows it
 * applies PATHEXT, so `codex` finds `codex.cmd` and skips npm's extensionless
 * POSIX shim, which Windows can't run.
 */
export function resolvePortableCommand(
  command: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): string | undefined {
  const env = normalizeWindowsEnv(options.env);
  const windows = process.platform === "win32";
  const extensions = !windows
    ? [""]
    : extname(command)
      ? ["", ...windowsExecutableExtensions(env)]
      : windowsExecutableExtensions(env);
  const hasDirectory =
    command.includes("/") || (windows && command.includes("\\"));
  const directories = hasDirectory
    ? [""]
    : (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(
        options.cwd ?? process.cwd(),
        directory,
        `${command}${extension}`,
      );
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The command line node-pty should start. On Windows a `.cmd` or `.bat` runs
 * through `cmd.exe`, quoted the way cross-spawn quotes it (including `%`),
 * because node-pty passes arguments through unescaped. Ported from
 * get-bb/bb#5997 (MIT).
 */
export function preparePortablePtyCommand(request: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): { command: string; args: string[] | string } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/iu.test(request.command)) {
    return { command: request.command, args: request.args };
  }
  const parsed = parseCrossSpawnCommand(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
  });
  return {
    command: parsed.command,
    args: parsed.options.windowsVerbatimArguments
      ? parsed.args.join(" ")
      : parsed.args,
  };
}
