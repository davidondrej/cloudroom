import { type ChildProcess, execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import semverCompare from "semver/functions/compare.js";
import semverValid from "semver/functions/valid.js";
import { z } from "zod";
import {
  execPortableFile,
  killProcessGroup,
  windowsExecutableExtensions,
} from "@cloudroom/process-utils";
import type {
  ProviderInstallationCommand,
  ProviderInstallationSource,
  ProviderInstallationStatus,
  ProviderInstallationVerification,
} from "../provider-maintenance.js";

export { findCliExecutable } from "@cloudroom/process-utils";

const execFileAsync = promisify(execFile);

const CLI_PROBE_TIMEOUT_MS = 5_000;
const INSTALLATION_CHECK_TIMEOUT_MS = 15_000;
const PROBE_KILL_GRACE_MS = 1_000;
const PROBE_MAX_OUTPUT = 1024 * 1024;

export function selectResolvedExecutable(args: {
  candidates: readonly string[];
  platform: NodeJS.Platform;
  pathExt: string | undefined;
}): string | null {
  const candidates = args.candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
  if (args.platform !== "win32") {
    return candidates[0] ?? null;
  }
  const extensions = windowsExecutableExtensions({ PATHEXT: args.pathExt });
  return (
    candidates.find((candidate) =>
      extensions.includes(path.win32.extname(candidate).toLowerCase()),
    ) ?? null
  );
}

export async function resolveExecutablePath(
  command: string,
): Promise<string | null> {
  if (path.isAbsolute(command)) {
    try {
      await access(command, fsConstants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(lookup, [command], {
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    return selectResolvedExecutable({
      candidates: stdout.split(/\r?\n/u),
      platform: process.platform,
      pathExt: process.env.PATHEXT,
    });
  } catch {
    return null;
  }
}

// Unix probes run in their own process group, which the runtime's stop of the
// bridge's group misses: end them when this process ends.
const liveProbes = new Set<ChildProcess>();
let probesEndWithProcess = false;

function endProbesWithProcess(): void {
  if (probesEndWithProcess) return;
  probesEndWithProcess = true;
  const endProbes = () => {
    for (const child of liveProbes) {
      killProcessGroup({ child, signal: "SIGKILL" });
    }
  };
  process.once("exit", endProbes);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const onSignal = () => {
      endProbes();
      // With no other handler, keep the signal's default: end this process.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.prependListener(signal, onSignal);
  }
}

/**
 * Runs a short CLI check and returns its stdout and stderr. A timeout ends
 * everything the CLI started, and only that: on Unix the check gets its own
 * process group (execFile's timeout ends only the CLI, orphaning e.g. an
 * update's `git fetch`); Windows' execPortableFile already ends the tree.
 */
function runCliProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  if (process.platform === "win32") {
    // execFile can't run npm `.cmd` shims on Windows.
    return execPortableFile(command, args, { timeoutMs }).then(
      ({ stdout, stderr }) => `${stdout}\n${stderr}`,
    );
  }
  endProbesWithProcess();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveProbes.add(child);
    const output = { stdout: "", stderr: "" };
    let outputBytes = 0;
    let timedOut = false;
    const stop = (signal: NodeJS.Signals) =>
      killProcessGroup({ child, signal });
    // Answer now: a descendant in its own session may hold the pipes open.
    const abandon = (message: string) => {
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`${command} ${message}`));
    };
    // Once started, cleanup runs to SIGKILL even if the CLI itself exits:
    // its descendants may have ignored SIGTERM.
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => {
        stop("SIGKILL");
        liveProbes.delete(child);
      }, PROBE_KILL_GRACE_MS);
      abandon(`timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    for (const name of ["stdout", "stderr"] as const) {
      child[name].setEncoding("utf8").on("data", (chunk: string) => {
        output[name] += chunk;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > PROBE_MAX_OUTPUT) {
          clearTimeout(timer);
          stop("SIGKILL");
          abandon("printed too much output");
        }
      });
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      // Keep timed-out groups tracked until escalation, even with closed pipes.
      if (!timedOut) liveProbes.delete(child);
      clearTimeout(timer);
      if (code === 0) resolve(`${output.stdout}\n${output.stderr}`);
      else
        reject(
          Object.assign(
            new Error(`${command} exited with code ${String(code)}`),
            { output: `${output.stdout}\n${output.stderr}` },
          ),
        );
    });
  });
}

export async function commandOutput(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return (
      await runCliProbe(command, args, INSTALLATION_CHECK_TIMEOUT_MS)
    ).trim();
  } catch {
    return null;
  }
}

export function versionFrom(value: string | null): string | null {
  const candidate = value?.match(/\bv?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u)?.[1];
  return candidate !== undefined && semverValid(candidate) !== null
    ? candidate
    : null;
}

/** readCliVersion, plus the output of a `--version` that exited non-zero (null on a timeout). */
export async function probeCliVersion(
  command: string,
): Promise<{ version: string | null; failedOutput: string | null }> {
  try {
    const output = await runCliProbe(
      command,
      ["--version"],
      CLI_PROBE_TIMEOUT_MS,
    );
    return { version: versionFrom(output), failedOutput: null };
  } catch (error) {
    const failure = error as {
      output?: unknown;
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    } | null;
    // Windows execPortableFile returns the two streams on non-zero exits.
    const output =
      failure?.output ??
      (typeof failure?.code === "number" &&
      typeof failure.stdout === "string" &&
      typeof failure.stderr === "string"
        ? `${failure.stdout}\n${failure.stderr}`
        : null);
    return {
      version: null,
      failedOutput: typeof output === "string" ? output : null,
    };
  }
}

export async function readCliVersion(command: string): Promise<string | null> {
  return (await probeCliVersion(command)).version;
}

export function compareVersions(left: string, right: string): number {
  return semverCompare(left, right);
}

export function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function formatCommand(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args]
    .map((part) =>
      /^[A-Za-z0-9_./:@+-]+$/u.test(part)
        ? part
        : `'${part.replace(/'/gu, "'\\''")}'`,
    )
    .join(" ");
}

export function npmGlobalInstallCommand(
  npmPackage: string,
): ProviderInstallationCommand {
  const command = npmCommand();
  const args = ["install", "-g", `${npmPackage}@latest`];
  return { command, args, displayCommand: formatCommand(command, args) };
}

export async function npmLatestVersion(
  npmPackage: string,
): Promise<string | null> {
  return versionFrom(
    await commandOutput(npmCommand(), ["view", npmPackage, "version"]),
  );
}

export interface NpmGlobalPackageProbe {
  npmBin: string | null;
  npmGlobalPackageVersion: string | null;
}

export async function probeNpmGlobalPackage(
  npmPackage: string,
): Promise<NpmGlobalPackageProbe> {
  const npm = npmCommand();
  const [prefixOutput, listOutput] = await Promise.all([
    commandOutput(npm, ["prefix", "-g"]),
    commandOutput(npm, ["list", "-g", npmPackage, "--depth=0", "--json"]),
  ]);
  const npmPrefix = firstLine(prefixOutput);
  return {
    npmBin:
      npmPrefix === null
        ? null
        : process.platform === "win32"
          ? npmPrefix
          : path.join(npmPrefix, "bin"),
    npmGlobalPackageVersion: npmGlobalPackageVersion(listOutput, npmPackage),
  };
}

function firstLine(value: string | null): string | null {
  return (
    value
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function npmGlobalPackageVersion(
  value: string | null,
  npmPackage: string,
): string | null {
  if (value === null) return null;
  try {
    const parsed = z
      .object({
        dependencies: z
          .record(z.string(), z.object({ version: z.string().min(1) }))
          .default({}),
      })
      .safeParse(JSON.parse(value));
    return parsed.success
      ? (parsed.data.dependencies[npmPackage]?.version ?? null)
      : null;
  } catch {
    return null;
  }
}

function pathIsInside(child: string, parent: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

export function npmGlobalInstallSource(args: {
  installed: boolean;
  executablePath: string | null;
  npmBin: string | null;
}): ProviderInstallationSource {
  return !args.installed
    ? "notInstalled"
    : args.executablePath !== null &&
        args.npmBin !== null &&
        pathIsInside(args.executablePath, args.npmBin)
      ? "npmGlobal"
      : "external";
}

export function installationVerification(
  status: Pick<ProviderInstallationStatus, "currentVersion" | "latestVersion">,
  action: "install" | "update",
): ProviderInstallationVerification {
  return action === "install"
    ? { kind: "installed" }
    : status.latestVersion !== null
      ? { kind: "version_at_least", version: status.latestVersion }
      : {
          kind: "version_changed",
          previousVersion: status.currentVersion ?? "unknown",
        };
}

export function downloadedInstallerCommand(
  url: string,
  options: { platform?: NodeJS.Platform; powershellUrl?: string } = {},
): ProviderInstallationCommand {
  if (
    (options.platform ?? process.platform) === "win32" &&
    options.powershellUrl !== undefined
  ) {
    const powershellScript = `irm ${options.powershellUrl} | iex`;
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        powershellScript,
      ],
      displayCommand: powershellScript,
    };
  }
  const script = [
    'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX")',
    "trap 'rm -f \"$tmp\"' EXIT",
    `curl -fsSL ${url} -o "$tmp"`,
    'bash "$tmp"',
  ].join(" && ");
  return { command: "sh", args: ["-c", script], displayCommand: script };
}

export function clampPercent(value: number): number {
  return Math.min(
    100,
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0)),
  );
}
