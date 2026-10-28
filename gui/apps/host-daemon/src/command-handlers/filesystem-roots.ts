import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const WINDOWS_DRIVE_PROBE_TIMEOUT_MS = 1_000;
const WINDOWS_DRIVE_TYPES_TIMEOUT_MS = 5_000;
const WINDOWS_CHILD_PROBE_TIMEOUT_MS = 3_000;
const LOCAL_DRIVE_TYPES = new Set(["Fixed", "Removable", "CDRom", "Ram"]);
const CHILD_DRIVE_PROBE_SCRIPT =
  "for (const root of process.argv.slice(1)) require('node:fs').stat(root, (error, stat) => { if (!error && stat.isDirectory()) process.stdout.write(root + '\\n'); });";

export type WindowsDriveTypes = Map<string, string>;

interface ListFilesystemRootsOptions {
  platform: NodeJS.Platform;
  isDirectory: (path: string) => Promise<boolean>;
  probeTimeoutMs: number;
  pendingProbes: Map<string, Promise<boolean>>;
  readDriveTypes: () => Promise<WindowsDriveTypes | null>;
  probeInChildProcess: (roots: string[]) => Promise<Set<string>>;
}

export async function readWindowsDriveTypes(): Promise<WindowsDriveTypes | null> {
  const powershell = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const { stdout } = await promisify(execFile)(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name + '|' + $_.DriveType }",
      ],
      { timeout: WINDOWS_DRIVE_TYPES_TIMEOUT_MS, windowsHide: true },
    );
    const types: WindowsDriveTypes = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^([A-Za-z]):\\?\|(\w+)$/.exec(line.trim());
      if (match) types.set(`${match[1]!.toUpperCase()}:\\`, match[2]!);
    }
    return types.size > 0 ? types : null;
  } catch {
    return null;
  }
}

const pendingDriveProbes = new Map<string, Promise<boolean>>();

export function probeDrivesInChildProcess(
  roots: string[],
  timeoutMs = WINDOWS_CHILD_PROBE_TIMEOUT_MS,
): Promise<Set<string>> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(
      process.execPath,
      ["-e", CHILD_DRIVE_PROBE_SCRIPT, ...roots],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          UV_THREADPOOL_SIZE: String(roots.length),
        },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const settle = () => {
      clearTimeout(timer);
      child.kill();
      resolve(
        new Set(stdout.split(/\r?\n/).filter((root) => roots.includes(root))),
      );
    };
    const timer = setTimeout(settle, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", settle).once("close", settle);
  });
}

function needsChildProbe(
  types: WindowsDriveTypes | null,
  root: string,
): boolean {
  if (types === null) return true;
  const type = types.get(root);
  return (
    type !== undefined &&
    type !== "NoRootDirectory" &&
    !LOCAL_DRIVE_TYPES.has(type)
  );
}

async function isAccessibleDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function probeWithTimeout(
  probe: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([probe.catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function probeDrive(
  root: string,
  isDirectory: (path: string) => Promise<boolean>,
  pendingProbes: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const pending = pendingProbes.get(root);
  if (pending !== undefined) {
    return pending;
  }
  const probe = isDirectory(root)
    .catch(() => false)
    .finally(() => pendingProbes.delete(root));
  pendingProbes.set(root, probe);
  return probe;
}

export async function listFilesystemRoots({
  platform = process.platform,
  isDirectory = isAccessibleDirectory,
  probeTimeoutMs = WINDOWS_DRIVE_PROBE_TIMEOUT_MS,
  pendingProbes = pendingDriveProbes,
  readDriveTypes = readWindowsDriveTypes,
  probeInChildProcess = probeDrivesInChildProcess,
}: Partial<ListFilesystemRootsOptions> = {}): Promise<string[]> {
  if (platform !== "win32") {
    return ["/"];
  }

  const types = await readDriveTypes();
  const driveRoots = [...WINDOWS_DRIVE_LETTERS]
    .map((letter) => `${letter}:\\`)
    .filter(
      (root) =>
        types === null ||
        (types.has(root) && types.get(root) !== "NoRootDirectory"),
    );
  const childProbed = driveRoots.filter(
    (root) => types?.get(root) !== "Network" && needsChildProbe(types, root),
  );
  const reachable =
    childProbed.length > 0
      ? probeInChildProcess(childProbed)
      : Promise.resolve(new Set<string>());
  const available = await Promise.all(
    driveRoots.map(async (root) =>
      types?.get(root) === "Network"
        ? true
        : childProbed.includes(root)
          ? (await reachable).has(root)
          : probeWithTimeout(
              probeDrive(root, isDirectory, pendingProbes),
              probeTimeoutMs,
            ),
    ),
  );
  return driveRoots.filter((_, index) => available[index]);
}

export async function isNetworkDriveReachable(
  path: string,
  readDriveTypes = readWindowsDriveTypes,
  probeInChildProcess = probeDrivesInChildProcess,
): Promise<boolean> {
  const drive = /^([A-Za-z]):/u.exec(path);
  if (drive === null) return true;
  const root = `${drive[1]!.toUpperCase()}:\\`;
  if (!needsChildProbe(await readDriveTypes(), root)) return true;
  return (await probeInChildProcess([root])).has(root);
}
