import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// A log over this size moves to `<log>.1` (its last 10 MiB), so each service keeps about 20 MiB.
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const LOG_CHECK_MS = 60_000;

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  logName: "server" | "host-daemon";
}

function readRange(fd: number, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(end - start);
  return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start));
}

export function readProcessLogTail(logPath: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    return readRange(fd, Math.max(0, size - 16_384), size)
      .toString("utf8")
      .trimEnd()
      .split(/\r?\n/u)
      .slice(-40)
      .join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Safe while the child runs: its fd appends, so after the truncate it writes from the start.
 * Reads up to the current end, then truncates at once, so only output from those few microseconds is lost.
 */
function capProcessLog(logPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r+");
    let size = fstatSync(fd).size;
    if (size <= MAX_LOG_BYTES) return;
    const chunks = [readRange(fd, size - MAX_LOG_BYTES, size)];
    // Catch up with what the child wrote during the read, a few passes at most.
    for (let pass = 0; pass < 5; pass++) {
      const grown = fstatSync(fd).size;
      if (grown <= size) break;
      chunks.push(readRange(fd, size, grown));
      size = grown;
    }
    ftruncateSync(fd, 0);
    writeFileSync(
      `${logPath}.1`,
      Buffer.concat(chunks).subarray(-MAX_LOG_BYTES),
      { mode: 0o600 },
    );
  } catch {
    // A missing or unreadable log stays as it is; capping must never block a start.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function spawnLoggedProcess(args: SpawnLoggedProcessArgs): ChildProcess {
  mkdirSync(args.logDir, { recursive: true });
  const logPath = join(args.logDir, `${args.logName}-stdio.log`);
  capProcessLog(logPath);
  const fd = openSync(logPath, "a", 0o600);
  try {
    const child = spawn(args.command, args.args, {
      cwd: process.cwd(),
      env: args.env,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    // The child holds the log for its whole life, so keep capping it while it runs.
    const timer = setInterval(
      () => capProcessLog(logPath),
      LOG_CHECK_MS,
    ).unref();
    child.once("close", () => clearInterval(timer));
    return child;
  } finally {
    closeSync(fd);
  }
}
