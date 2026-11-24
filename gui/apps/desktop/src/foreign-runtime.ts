import {
  roomAppRuntimeVerifyTokens,
  clearOwnRoomAppRuntimeFile,
  readRoomAppRuntimeFile,
  type RoomAppRuntimeFile,
} from "@cloudroom/config/app-runtime-file";
import { stopVerifiedProcess } from "@cloudroom/config/verified-process-stop";
import type { VerifiedProcessOps } from "@cloudroom/config/verified-process-stop";

export interface ForeignRuntimeDetails {
  dataDir: string;
  entryPath: string;
  pid: number;
  startedAt: string;
  surface: string;
  version: string;
}

interface ReadForeignRuntimeDetailsArgs {
  dataDir: string | null;
  serverUrl: string;
}

interface StopForeignRuntimeArgs {
  details: ForeignRuntimeDetails;
  killTimeoutMs: number;
  processOps?: VerifiedProcessOps;
  timeoutMs: number;
}

type StopForeignRuntimeResult =
  | { kind: "not-running" }
  | { kind: "replaced" }
  | { kind: "still-running"; pid: number }
  | { kind: "stopped" }
  | { kind: "unverified"; pid: number };

function matchesProbedServer(
  runtimeFile: RoomAppRuntimeFile,
  serverUrl: string,
): boolean {
  try {
    return new URL(runtimeFile.serverUrl).host === new URL(serverUrl).host;
  } catch {
    return false;
  }
}

export async function readForeignRuntimeDetails(
  args: ReadForeignRuntimeDetailsArgs,
): Promise<ForeignRuntimeDetails | null> {
  if (args.dataDir === null) {
    return null;
  }

  const runtimeFile = await readRoomAppRuntimeFile(args.dataDir);
  if (runtimeFile === null) {
    return null;
  }
  if (!matchesProbedServer(runtimeFile, args.serverUrl)) {
    return null;
  }

  return {
    dataDir: args.dataDir,
    entryPath: runtimeFile.entryPath,
    pid: runtimeFile.pid,
    startedAt: runtimeFile.startedAt,
    surface: runtimeFile.surface,
    version: runtimeFile.version,
  };
}

export async function stopForeignRuntime(
  args: StopForeignRuntimeArgs,
): Promise<StopForeignRuntimeResult> {
  const current = await readRoomAppRuntimeFile(args.details.dataDir);
  if (
    current !== null &&
    (current.pid !== args.details.pid ||
      current.startedAt !== args.details.startedAt)
  ) {
    return { kind: "replaced" };
  }

  const stopResult = await stopVerifiedProcess({
    killTimeoutMs: args.killTimeoutMs,
    pid: args.details.pid,
    processOps: args.processOps,
    signal: "SIGTERM",
    startedAt: args.details.startedAt,
    timeoutMs: args.timeoutMs,
    verifyTokens: roomAppRuntimeVerifyTokens(args.details.entryPath),
  });

  if (stopResult.kind === "unverified") {
    return { kind: "unverified", pid: args.details.pid };
  }
  if (stopResult.kind === "still-running") {
    return { kind: "still-running", pid: args.details.pid };
  }
  if (stopResult.kind === "not-running") {
    return { kind: "not-running" };
  }
  await clearOwnRoomAppRuntimeFile({
    dataDir: args.details.dataDir,
    pid: args.details.pid,
  });
  return { kind: "stopped" };
}
