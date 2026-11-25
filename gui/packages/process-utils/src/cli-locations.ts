import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { resolveWindowsShim, windowsExecutableExtensions } from "./windows.js";

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

// Agents whose own installers use their own folder, not always on PATH.
const PROVIDER_INSTALL_DIRS = new Map([
  ["opencode", join(".opencode", "bin")],
  ["claude", join(".claude", "local")],
  ["grok", join(".grok", "bin")],
  ["kilo", join(".kilo", "bin")],
  ["kimi", join(".kimi-code", "bin")],
]);

function providerInstallPaths(cli: string, home: string): string[] {
  const dir = PROVIDER_INSTALL_DIRS.get(cli);
  return dir === undefined ? [] : [join(home, dir, cli)];
}

// Claude's native installer, npm's global bin and agents' own folders (Grok's
// %USERPROFILE%\.grok\bin, #1256; Cursor's %LOCALAPPDATA%\cursor-agent,
// #1709), none always on PATH.
function windowsFallbackCandidates(
  cli: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const home = env.USERPROFILE?.trim() || homedir();
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  return [
    join(home, ".local", "bin", cli),
    ...(appData ? [join(appData, "npm", cli)] : []),
    ...(localAppData && cli === "cursor-agent"
      ? [join(localAppData, "cursor-agent", cli)]
      : []),
    ...providerInstallPaths(cli, home),
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

// npm's @anthropic-ai/claude-code ships bin/claude.exe as a short shell stub
// that its postinstall swaps for the native binary. When that never ran, the
// stub only prints an error, and macOS can't even spawn it: ENOEXEC (#1148).
// On Windows, npm's claude.cmd shim runs that file, so check its target.
export function isClaudeNpmPlaceholder(candidate: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(
      resolveWindowsShim({ command: candidate, args: [] }).command,
      "r",
    );
    const head = Buffer.alloc(128);
    const length = readSync(fd, head, 0, head.length, 0);
    return head
      .toString("latin1", 0, length)
      .includes("claude native binary not installed");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
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

// Every official Codex, ahead of PATH. On Windows, install.ps1 puts it in `current\bin`
// (older versions used `current`), links that into LOCALAPPDATA and only adds the link
// to the user's PATH, which an open Cloudroom doesn't see until it restarts.
function officialCodexPaths(env: NodeJS.ProcessEnv): string[] {
  const official = officialCodexPath(env);
  if (process.platform !== "win32") return [official];
  const localAppData = env.LOCALAPPDATA?.trim();
  return [
    join(dirname(official), "bin", "codex"),
    official,
    ...(localAppData
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
  return [
    ...binDirs.map((dir) => join(dir, cli)),
    ...providerInstallPaths(cli, home),
  ];
}

// Claude Code's version from where its installer put it, without running it:
// native `versions/2.1.323`, Homebrew `Caskroom/claude-code/2.1.323/`, or npm's
// package.json. Null for anything else, such as a user's wrapper script.
function claudeVersionFromPath(candidate: string): number[] | null {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  // npm first: a Node version manager's own `versions/22.14.0` folder must
  // not read as Claude Code's version.
  const npm =
    /^(.*[/\\]node_modules[/\\]@anthropic-ai[/\\]claude-code)[/\\]/u.exec(
      real,
    )?.[1];
  if (npm === undefined) {
    const version =
      /[/\\](?:claude[/\\]versions|(?:Caskroom|Cellar)[/\\]claude-code[^/\\]*)[/\\](\d+\.\d+\.\d+)(?:[/\\]|(?:\.exe)?$)/iu.exec(
        real,
      )?.[1];
    return version === undefined ? null : version.split(".").map(Number);
  }
  try {
    const { version } = JSON.parse(
      readFileSync(join(npm, "package.json"), "utf8"),
    ) as { version?: unknown };
    const parts = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(version));
    return parts === null ? null : parts.slice(1).map(Number);
  } catch {
    return null;
  }
}

function isNewer(left: number[], right: number[]): boolean {
  const index = left.findIndex((part, i) => part !== right[i]);
  return index !== -1 && left[index]! > right[index]!;
}

// A Mac can keep an old claude ahead of a current one on PATH (an earlier
// native install next to Homebrew's), so use the newest. A first claude whose
// version we can't read stays first: it may be the user's own wrapper.
function newestClaude(candidates: string[]): string | null {
  let best = candidates[0] ?? null;
  let bestVersion = best === null ? null : claudeVersionFromPath(best);
  if (bestVersion === null) return best;
  for (const candidate of candidates.slice(1)) {
    const version = claudeVersionFromPath(candidate);
    if (version !== null && isNewer(version, bestVersion)) {
      best = candidate;
      bestVersion = version;
    }
  }
  return best;
}

function selectCliCandidate(cli: string, candidates: string[]): string | null {
  const usable = (candidate: string) =>
    isExecutableFile(candidate) &&
    !(cli === "codex" && insideAppBundle(candidate)) &&
    !(cli === "claude" && isClaudeNpmPlaceholder(candidate));
  if (cli === "claude") return newestClaude(candidates.filter(usable));
  // cmux.app's `grok` only forwards to a real Grok CLI and fails without one,
  // so any standalone grok, ~/.grok/bin's included, wins over it (#1823).
  const standalone =
    cli === "grok"
      ? candidates.find((c) => usable(c) && !insideAppBundle(c))
      : undefined;
  return standalone ?? candidates.find(usable) ?? null;
}

/** Checks only PATH entries (never home fallback folders or auth files). */
export function findCliOnPath(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return selectCliCandidate(
    cli,
    withWindowsExtensions(pathCandidates(cli, env), env),
  );
}

export function findCliExecutable(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // OpenAI's official Codex wins over PATH: it is the one copy we can always
  // update, however tangled the Mac's npm or Homebrew copies are.
  const official =
    cli === "codex" && process.getuid?.() !== 0 ? officialCodexPaths(env) : [];
  const candidates = withWindowsExtensions(
    [...official, ...pathCandidates(cli, env), ...fallbackCandidates(cli, env)],
    env,
  );
  return selectCliCandidate(cli, candidates);
}

export function findBrokenCliLink(
  cli: KnownCli,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return pathCandidates(cli, env).find(isDanglingLink) ?? null;
}
