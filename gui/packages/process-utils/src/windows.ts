/// <reference path="./cross-spawn.d.ts" />
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, posix, resolve, sep, win32 } from "node:path";
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
    : (env.PATH ?? "")
        .split(delimiter)
        .map((directory) => directory.replace(/^"(.*)"$/u, "$1"))
        .filter(Boolean);
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

const NPM_SHIM_HEAD =
  "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
const NPM_NODE_SHIM_PROG =
  '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ';

/** The file a portable spawn of `command` starts on Windows, found the way cross-spawn finds it. */
export function resolveWindowsCommandFile(request: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (process.platform !== "win32") return undefined;
  return parseCrossSpawnCommand(request.command, [], {
    cwd: request.cwd,
    env: request.env && normalizeWindowsEnv(request.env),
  }).file;
}

export function resolveWindowsShim(request: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { command: string; args: string[] } {
  const unchanged = { command: request.command, args: request.args };
  if (process.platform !== "win32") return unchanged;
  const shim = resolveWindowsCommandFile(request);
  if (shim === undefined || !/\.cmd$/iu.test(shim)) return unchanged;
  let source = "";
  try {
    source = readFileSync(shim, "utf8");
  } catch {}
  const target = /"%dp0%\\([^"\r\n]+\.(?:exe|[cm]?js))"(?: {3}| )%\*\r\n$/u.exec(
    source,
  )?.[1];
  if (target === undefined) return unchanged;
  const file = join(dirname(shim), ...target.split("\\"));
  if (/\.exe$/iu.test(target)) {
    return source === `${NPM_SHIM_HEAD}"%dp0%\\${target}"   %*\r\n`
      ? { command: file, args: request.args }
      : unchanged;
  }
  if (source !== `${NPM_SHIM_HEAD}${NPM_NODE_SHIM_PROG}"%dp0%\\${target}" %*\r\n`) {
    return unchanged;
  }
  // Never a bare `node`: Windows looks in the working folder (often a project) before PATH. With no node.exe
  // beside the shim or on PATH, the missing sibling path fails with ENOENT, as a bare `node` would.
  const localNode = join(dirname(shim), "node.exe");
  return {
    command: existsSync(localNode) ? localNode : (nodeOnPath(request.env ?? process.env) ?? localNode),
    args: [file, ...request.args],
  };
}

/**
 * `node.exe` from PATH's fully qualified folders only (`C:\…` or `\\server\share`), never the working folder,
 * a drive-relative `C:dir` or a rooted `\dir` (both resolve against the working folder's drive). An env without
 * PATH uses the parent's, as Windows does.
 */
function nodeOnPath(env: NodeJS.ProcessEnv): string | undefined {
  return (normalizeWindowsEnv(env).PATH ?? process.env.PATH ?? "")
    .split(";")
    .map((directory) => directory.replace(/^"(.*)"$/u, "$1"))
    // A POSIX host only fakes win32 in tests; there an absolute path is fully qualified.
    .filter((directory) => (sep === "/" ? isAbsolute(directory) : /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u.test(directory)))
    .map((directory) => join(directory, "node.exe"))
    .find(isRunnableFile);
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
