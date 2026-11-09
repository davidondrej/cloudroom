import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { windowsExecutableExtensions } from "./windows.js";

export type KnownCli = "codex" | "claude" | "opencode" | "fx";

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDanglingLink(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink() && !existsSync(candidate);
  } catch {
    return false;
  }
}

function pathCandidates(cli: string, env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => join(dir, cli));
}

// Windows runs `codex.cmd` or `claude.exe`, never npm's extensionless POSIX
// shim, so each candidate becomes one path per PATHEXT extension.
function withWindowsExtensions(
  candidates: string[],
  env: NodeJS.ProcessEnv,
): string[] {
  if (process.platform !== "win32") return candidates;
  const extensions = windowsExecutableExtensions(env);
  return candidates.flatMap((candidate) =>
    extensions.map((extension) => `${candidate}${extension}`),
  );
}

// Claude's native installer and npm's global bin, neither always on PATH.
function windowsFallbackCandidates(
  cli: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const home = env.USERPROFILE?.trim() || homedir();
  const appData = env.APPDATA?.trim();
  return [
    join(home, ".local", "bin", cli),
    ...(appData ? [join(appData, "npm", cli)] : []),
  ];
}

// Codex.app and ChatGPT.app ship a codex. Running a binary inside a bundle macOS
// flags makes it move the whole app to the Bin (#96), so Cloudroom never runs one,
// even through a PATH symlink. Those users install the standalone CLI instead.
function insideAppBundle(candidate: string): boolean {
  try {
    return realpathSync(candidate).includes(".app/");
  } catch {
    return false;
  }
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

/** Where OpenAI's official installer (chatgpt.com/codex/install.sh) puts Codex. */
export function officialCodexPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    env.CODEX_HOME?.trim() || join(homeDir(env), ".codex"),
    "packages",
    "standalone",
    "current",
    "codex",
  );
}

// Every official Codex, ahead of PATH. On Windows, install.ps1 also links its current
// Codex into LOCALAPPDATA and only adds that to the user's PATH, which an open
// Cloudroom doesn't see until it restarts.
function officialCodexPaths(env: NodeJS.ProcessEnv): string[] {
  const localAppData = env.LOCALAPPDATA?.trim();
  return [
    officialCodexPath(env),
    ...(process.platform === "win32" && localAppData
      ? [join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex")]
      : []),
  ];
}

function fallbackCandidates(cli: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") return windowsFallbackCandidates(cli, env);
  if (process.getuid?.() === 0) return [];
  const home = homeDir(env);
  const binDirs = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
  ];
  const providerPaths =
    cli === "opencode"
      ? [join(home, ".opencode", "bin", "opencode")]
      : cli === "claude"
        ? [join(home, ".claude", "local", "claude")]
        : cli === "grok"
          ? [join(home, ".grok", "bin", "grok")]
          : cli === "kilo"
            ? [join(home, ".kilo", "bin", "kilo")]
            : cli === "kimi"
              ? [join(home, ".kimi-code", "bin", "kimi")]
              : [];
  return [...binDirs.map((dir) => join(dir, cli)), ...providerPaths];
}

export function findCliExecutable(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // OpenAI's official Codex wins over PATH: it is the one copy we can always
  // update, however tangled the Mac's npm or Homebrew copies are.
  const official =
    cli === "codex" && process.getuid?.() !== 0 ? officialCodexPaths(env) : [];
  return (
    withWindowsExtensions(
      [
        ...official,
        ...pathCandidates(cli, env),
        ...fallbackCandidates(cli, env),
      ],
      env,
    ).find(
      (candidate) =>
        isExecutableFile(candidate) &&
        !(cli === "codex" && insideAppBundle(candidate)),
    ) ?? null
  );
}

export function findBrokenCliLink(
  cli: KnownCli,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return pathCandidates(cli, env).find(isDanglingLink) ?? null;
}
