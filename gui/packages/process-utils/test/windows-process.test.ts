// Windows-only checks, adapted from get-bb/bb#4610 and #4661 (MIT).
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, win32 } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  cursorAuthFile,
  gitShell,
  msysPathToWindows,
  execPortableFile,
  findCliExecutable,
  findGitShellPath,
  isClosedPipeError,
  killPortableProcess,
  normalizeWindowsEnv,
  resolvePortableCommand,
  spawnPortableProcess,
  stopProcessGroupLeaderFirst,
} from "../src/index.js";

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tempDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cr-win-proc-")));
  onTestFinished(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

// A `.cmd` shim whose node child records its pid and runs until killed, like
// an npm-installed provider CLI.
function writeSleeperShim(directory: string): string {
  writeFileSync(
    join(directory, "sleeper.cjs"),
    'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);',
  );
  const shim = join(directory, "sleeper.cmd");
  writeFileSync(
    shim,
    `@echo off\r\n"${process.execPath}" "%~dp0sleeper.cjs" %*\r\n`,
  );
  return shim;
}

async function startSleeper(directory: string) {
  const pidFile = join(directory, "pid.txt");
  const child = spawnPortableProcess({
    command: writeSleeperShim(directory),
    args: [pidFile],
    stdio: "ignore",
  });
  const sleeperPid = await vi.waitFor(
    () => Number.parseInt(readFileSync(pidFile, "utf8"), 10),
    { timeout: 10_000 },
  );
  onTestFinished(() => {
    if (isProcessRunning(sleeperPid)) process.kill(sleeperPid);
  });
  expect(sleeperPid).not.toBe(child.pid);
  return { child, sleeperPid };
}

describe("Windows env and pipes", () => {
  it("leaves one PATH key on Windows, preferring Cloudroom's PATH", () => {
    const env = { Path: "C:\\old", PATH: "C:\\new", HOME: "h" };
    expect(normalizeWindowsEnv(env, "win32")).toEqual({
      PATH: "C:\\new",
      HOME: "h",
    });
    expect(normalizeWindowsEnv({ Path: "C:\\old" }, "win32")).toEqual({
      PATH: "C:\\old",
    });
    expect(normalizeWindowsEnv(env, "darwin")).toBe(env);
  });

  it("treats Windows' EOF as a closed pipe", () => {
    const closed = (code: string) =>
      isClosedPipeError(Object.assign(new Error(code), { code }));
    expect(["EPIPE", "ERR_STREAM_DESTROYED"].every(closed)).toBe(true);
    expect(closed("EOF")).toBe(process.platform === "win32");
    expect(closed("ENOENT")).toBe(false);
  });
});

describe("Portable output limits and paths", () => {
  it("keeps execFile's maxBuffer limit when asked", async () => {
    const print = (bytes: number) => [
      "-e",
      `process.stdout.write("x".repeat(${bytes}))`,
    ];
    await expect(
      execPortableFile(process.execPath, print(2 * 1024 * 1024), {
        maxBuffer: 1024 * 1024,
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    const { stdout } = await execPortableFile(process.execPath, print(1024), {
      maxBuffer: 1024 * 1024,
      timeoutMs: 10_000,
    });
    expect(stdout).toHaveLength(1024);
  });

  it("reads Git shell paths as Windows paths", () => {
    expect(msysPathToWindows("/c/Users/a/.cache/x.bundle")).toBe(
      "c:/Users/a/.cache/x.bundle",
    );
    expect(msysPathToWindows("C:/Users/a")).toBe("C:/Users/a");
  });

  it("finds the Cursor CLI's login file on Linux and Windows only", () => {
    expect(cursorAuthFile("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a")).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\Cursor\\auth.json",
    );
    expect(cursorAuthFile("linux", {}, "/home/a")).toBe(
      "/home/a/.config/cursor/auth.json",
    );
    expect(cursorAuthFile("darwin", {}, "/Users/a")).toBeNull();
  });
});

describe.runIf(process.platform === "win32")("Windows processes", () => {
  it("Git's shell finds its own tools", async () => {
    const shell = await gitShell();
    const { stdout } = await execPortableFile(
      shell.command,
      ["-c", "mkdir -p ~/.cache/cloudroom && cd ~/.cache/cloudroom && pwd"],
      { env: shell.env, timeoutMs: 20_000 },
    );
    expect(msysPathToWindows(stdout.trim())).toMatch(/^[a-z]:\/.+\/\.cache\/cloudroom$/i);
  });

  it("a spawn timeout ends the process behind a .cmd shim", async () => {
    const directory = tempDirectory();
    const pidFile = join(directory, "pid.txt");
    spawnPortableProcess({
      command: writeSleeperShim(directory),
      args: [pidFile],
      stdio: "ignore",
      timeout: 1_500,
    });
    const sleeperPid = await vi.waitFor(
      () => Number.parseInt(readFileSync(pidFile, "utf8"), 10),
      { timeout: 10_000 },
    );
    onTestFinished(() => {
      if (isProcessRunning(sleeperPid)) process.kill(sleeperPid);
    });
    await vi.waitFor(() => expect(isProcessRunning(sleeperPid)).toBe(false), {
      timeout: 15_000,
    });
  });

  it("finds Git's sh.exe when GIT_SHELL_PATH is missing or POSIX (Git before 2.46)", async () => {
    expect(await findGitShellPath()).toMatch(/\\(sh|bash)\.exe$/iu);
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const sh = win32.join(win32.normalize(execPath), "..", "..", "..", "usr", "bin", "sh.exe");
    for (const gitVar of ["echo /bin/sh& exit /b 0", "exit /b 1"]) {
      const dir = mkdtempSync(join(tmpdir(), "fake-git-"));
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(
        join(dir, "git.cmd"),
        `@echo off\r\nif "%~1"=="var" (${gitVar})\r\nif "%~1"=="--exec-path" (echo ${execPath}& exit /b 0)\r\nexit /b 1\r\n`,
      );
      const env = normalizeWindowsEnv({ ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` });
      await expect(findGitShellPath(env)).resolves.toBe(sh);
    }
    const empty = mkdtempSync(join(tmpdir(), "no-git-"));
    onTestFinished(() => rmSync(empty, { recursive: true, force: true }));
    await expect(findGitShellPath({ ...normalizeWindowsEnv(process.env), PATH: empty })).resolves.toBeNull();
  }, 30_000);

  it("killPortableProcess ends the process behind a .cmd shim", async () => {
    const { child, sleeperPid } = await startSleeper(tempDirectory());

    killPortableProcess(child, "SIGTERM");

    await vi.waitFor(() => expect(isProcessRunning(sleeperPid)).toBe(false), {
      timeout: 10_000,
    });
  });

  it("stopProcessGroupLeaderFirst ends the whole tree", async () => {
    const { child, sleeperPid } = await startSleeper(tempDirectory());

    const result = await stopProcessGroupLeaderFirst({
      child,
      timeoutMs: 5_000,
      killGraceMs: 1_000,
    });

    expect(result).toEqual({ treeTermination: "confirmed" });
    expect(isProcessRunning(sleeperPid)).toBe(false);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("finds and runs a .cmd shim, never npm's extensionless shim", async () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, "probe-cli"), "#!/bin/sh\necho posix\n");
    writeFileSync(
      join(directory, "probe-cli.cmd"),
      "@echo off\r\necho probe-cli 1.2.3 %~1\r\n",
    );
    const env = {
      ComSpec: process.env.ComSpec,
      PATH: directory,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: process.env.SystemRoot,
    };

    expect(resolvePortableCommand("probe-cli", { env })).toBe(
      join(directory, "probe-cli.cmd"),
    );
    expect(findCliExecutable("probe-cli", env)).toBe(
      join(directory, "probe-cli.cmd"),
    );
    const { stdout } = await execPortableFile("probe-cli", ["--version"], {
      env,
      timeoutMs: 10_000,
    });
    expect(stdout.trim()).toBe("probe-cli 1.2.3 --version");
  });
});
