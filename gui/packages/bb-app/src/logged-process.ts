import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  logName: "server" | "host-daemon";
}

export function readProcessLogTail(logPath: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 16_384));
    const bytesRead = readSync(
      fd,
      buffer,
      0,
      buffer.length,
      size - buffer.length,
    );
    return buffer
      .subarray(0, bytesRead)
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

export function spawnLoggedProcess(args: SpawnLoggedProcessArgs): ChildProcess {
  mkdirSync(args.logDir, { recursive: true });
  const fd = openSync(
    join(args.logDir, `${args.logName}-stdio.log`),
    "a",
    0o600,
  );
  try {
    return spawn(args.command, args.args, {
      cwd: process.cwd(),
      env: args.env,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}
