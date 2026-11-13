import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { isProcessRunning } from "./verified-process-stop.js";

const ROOM_APP_RUNTIME_FILE_NAME = "bb-app-runtime.json";

const roomAppRuntimeFileSchema = z.object({
  entryPath: z.string().min(1),
  pid: z.number().int().positive(),
  surface: z.string().min(1),
  serverUrl: z.string().min(1),
  startedAt: z.string().min(1),
  version: z.string().min(1),
});

export type RoomAppRuntimeFile = z.infer<typeof roomAppRuntimeFileSchema>;

interface WriteRoomAppRuntimeFileArgs {
  dataDir: string;
  entryPath: string;
  pid: number;
  serverUrl: string;
  startedAt: string;
  surface: string;
  version: string;
}

export function formatRoomAppRuntimeFilePath(dataDir: string): string {
  return join(dataDir, ROOM_APP_RUNTIME_FILE_NAME);
}

export async function writeRoomAppRuntimeFile(
  args: WriteRoomAppRuntimeFileArgs,
): Promise<void> {
  const runtimeFile: RoomAppRuntimeFile = {
    entryPath: args.entryPath,
    pid: args.pid,
    serverUrl: args.serverUrl,
    startedAt: args.startedAt,
    surface: args.surface,
    version: args.version,
  };
  await mkdir(args.dataDir, { recursive: true });
  await writeFile(
    formatRoomAppRuntimeFilePath(args.dataDir),
    `${JSON.stringify(runtimeFile, null, 2)}\n`,
    "utf8",
  );
}

export async function claimRoomAppRuntimeFile(
  args: WriteRoomAppRuntimeFileArgs & { isRunning?: (pid: number) => boolean },
): Promise<boolean> {
  const isRunning = args.isRunning ?? isProcessRunning;
  const existing = await readRoomAppRuntimeFile(args.dataDir);
  if (
    existing !== null &&
    existing.pid !== args.pid &&
    isRunning(existing.pid)
  ) {
    return false;
  }
  await writeRoomAppRuntimeFile(args);
  return true;
}

async function clearRoomAppRuntimeFile(dataDir: string): Promise<void> {
  await rm(formatRoomAppRuntimeFilePath(dataDir), { force: true });
}

export async function clearOwnRoomAppRuntimeFile(args: {
  dataDir: string;
  pid: number;
}): Promise<boolean> {
  const runtimeFile = await readRoomAppRuntimeFile(args.dataDir);
  if (runtimeFile === null || runtimeFile.pid !== args.pid) {
    return false;
  }
  await clearRoomAppRuntimeFile(args.dataDir);
  return true;
}

export function roomAppRuntimeVerifyTokens(entryPath: string): string[] {
  return [entryPath, basename(entryPath)];
}

export async function readRoomAppRuntimeFile(
  dataDir: string,
): Promise<RoomAppRuntimeFile | null> {
  let rawContents: string;
  try {
    rawContents = await readFile(formatRoomAppRuntimeFilePath(dataDir), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = roomAppRuntimeFileSchema.safeParse(JSON.parse(rawContents));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
