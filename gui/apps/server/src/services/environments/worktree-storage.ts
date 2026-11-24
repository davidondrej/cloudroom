import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { safePluginSegment } from "@cloudroom/process-utils";
import type { SystemWorktreeStorageResponse } from "@cloudroom/server-contract";
import type { AppDeps } from "../../types.js";
import { findHostDataDir } from "../lib/entity-lookup.js";
import { readPrimaryHostIdFromDataDir } from "../hosts/primary-host.js";
import { getEnvironmentProvider } from "../plugins/plugin-environment-provider-registry.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "./environment-provider-ids.js";

const LOW_DISK_BYTES = 10e9;
const USAGE_REFRESH_MS = 60 * 60_000;
let usage = { bytes: null as number | null, at: 0, running: false };

function refreshUsage(root: string): void {
  if (usage.running || Date.now() - usage.at < USAGE_REFRESH_MS) return;
  usage.running = true;
  void promisify(execFile)("du", ["-sk", root], { timeout: 10 * 60_000 })
    .then(
      ({ stdout }) => Number.parseInt(stdout, 10) * 1024,
      () => Number.NaN,
    )
    .then((bytes) => {
      usage = {
        bytes: Number.isFinite(bytes) ? bytes : null,
        at: Date.now(),
        running: false,
      };
    });
}

type LocalDiskDeps = Pick<AppDeps, "config" | "db" | "hub">;

function localHostDataDir(deps: LocalDiskDeps): string | null {
  const hostId = readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir });
  const dataDir = hostId === null ? null : findHostDataDir(deps, hostId);
  return dataDir && path.isAbsolute(dataDir) ? dataDir : null;
}

function freeBytesAt(dir: string): number | null {
  try {
    const disk = statfsSync(dir);
    return disk.bavail * disk.bsize;
  } catch {
    return null;
  }
}

export function localFreeBytes(deps: LocalDiskDeps): number | null {
  const dataDir = localHostDataDir(deps);
  return dataDir === null ? null : freeBytesAt(dataDir);
}

export function worktreeDiskStatus(
  deps: LocalDiskDeps,
): SystemWorktreeStorageResponse {
  const record = getEnvironmentProvider(
    DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
  );
  const dataDir = localHostDataDir(deps);
  if (record === undefined || dataDir === null)
    return { freeBytes: null, usedBytes: null, low: false };
  refreshUsage(
    path.join(
      dataDir,
      "plugins",
      safePluginSegment(record.pluginId),
      "host-data",
      "worktrees",
    ),
  );
  const free = freeBytesAt(dataDir);
  return {
    freeBytes: free,
    usedBytes: usage.bytes,
    low: free !== null && free < LOW_DISK_BYTES,
  };
}
