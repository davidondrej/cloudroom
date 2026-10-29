import fs from "node:fs/promises";
import { dirname, join } from "node:path";

const BUNDLED_CLI_TARGET = /\/node_modules\/bb-app\/host-daemon\/dist\/[^/]+$/;
const SHIM_MARKER = "#!/bin/sh\n# Managed by Cloudroom";
const SHIM_HEAD = `${SHIM_MARKER}, which rewrites it on launch. Delete this line to keep your own edits.\nELECTRON_RUN_AS_NODE=1 exec `;
const SHIM_TAIL = ` --input-type=module --eval 'if (process.argv.at(-1) === "--no-sandbox") process.argv.pop(); process.argv[1] = process.env.APPDIR + "/resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room-cli"; await import(process.getBuiltinModule("node:url").pathToFileURL(process.argv[1]).href);' -- room-cli "$@" --no-sandbox\n`;

export type RoomCliShimResult =
  | { kind: "created" | "repaired" | "unchanged"; shimPath: string }
  | {
      kind: "skipped";
      reason: "missing-cli" | "translocated" | "user-owned";
      shimPath: string;
    };

interface EnsureRoomCliShimArgs {
  appImagePath?: string;
  cliPath: string;
  homeDir: string;
}

export function resolveBundledRoomCliPath(appPath: string): string {
  return join(
    `${appPath}.unpacked`,
    "node_modules",
    "bb-app",
    "host-daemon",
    "dist",
    "room-cli",
  );
}

export function appImageRoomCliShim(appImagePath: string): string {
  return `${SHIM_HEAD}'${appImagePath.replaceAll("'", "'\\''")}'${SHIM_TAIL}`;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

async function readShimTarget(
  shimPath: string,
): Promise<string | null | "not-a-link"> {
  try {
    return await fs.readlink(shimPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === "EINVAL") return "not-a-link";
    throw error;
  }
}

export async function ensureRoomCliShim(
  args: EnsureRoomCliShimArgs,
): Promise<RoomCliShimResult> {
  const shimPath = join(args.homeDir, ".local", "bin", "room-cli");
  if (args.cliPath.includes("/AppTranslocation/")) {
    return { kind: "skipped", reason: "translocated", shimPath };
  }
  try {
    await fs.access(args.cliPath, fs.constants.X_OK);
  } catch {
    return { kind: "skipped", reason: "missing-cli", shimPath };
  }

  const script = args.appImagePath
    ? appImageRoomCliShim(args.appImagePath)
    : null;
  const current = await readShimTarget(shimPath);
  if (current === "not-a-link") {
    const stat = await fs.lstat(shimPath);
    const text =
      stat.isFile() && stat.size < 4096
        ? await fs.readFile(shimPath, "utf8")
        : "";
    if (!text.startsWith(SHIM_MARKER)) {
      return { kind: "skipped", reason: "user-owned", shimPath };
    }
    if (text === script && (stat.mode & 0o100) !== 0) {
      return { kind: "unchanged", shimPath };
    }
  } else if (!script && current === args.cliPath) {
    return { kind: "unchanged", shimPath };
  } else if (current !== null && !BUNDLED_CLI_TARGET.test(current)) {
    return { kind: "skipped", reason: "user-owned", shimPath };
  }

  await fs.mkdir(dirname(shimPath), { recursive: true });
  const tempPath = `${shimPath}.${process.pid}.tmp`;
  try {
    if (current === null && !script) {
      await fs.symlink(args.cliPath, shimPath);
      return { kind: "created", shimPath };
    }
    await fs.rm(tempPath, { force: true });
    if (script) {
      const file = await fs.open(tempPath, "wx", 0o755);
      await file
        .writeFile(script)
        .then(() => file.sync())
        .finally(() => file.close());
    } else {
      await fs.symlink(args.cliPath, tempPath);
    }
    if (current === null) await fs.link(tempPath, shimPath);
    else await fs.rename(tempPath, shimPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if (errorCode(error) === "EEXIST") return ensureRoomCliShim(args);
    throw error;
  }
  await fs.rm(tempPath, { force: true });
  return { kind: current === null ? "created" : "repaired", shimPath };
}
