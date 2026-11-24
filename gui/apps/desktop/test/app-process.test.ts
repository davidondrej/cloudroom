import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeInheritedFdsOnLinux,
  createRoomAppProcessLaunch,
  createRoomAppProcessEnv,
  resolveRoomAppProcessRuntime,
  startRoomAppProcess,
  type RoomAppProcess,
} from "../src/app-process.js";

interface TempScript {
  path: string;
  root: string;
}

interface WaitForLogArgs {
  process: RoomAppProcess;
  text: string;
}

interface CreateTempScriptArgs {
  contents: string;
}

interface LinuxProcessStat {
  processGroupId: number;
  state: string;
}

interface FdCleanupRow {
  bashPath: string;
  extraEnv: Record<string, string>;
  leaked: boolean;
  platform: NodeJS.Platform;
}

// bash reads these at startup, so the launch must stay direct.
const BASH_STARTUP_ENVS: Record<string, string>[] = [
  { BASH_ENV: "/dev/null" },
  { BASHOPTS: "nullglob" },
  { ENV: "/dev/null" },
  { SHELLOPTS: "noexec" },
  { "BASH_FUNC_hook%%": "() { exit 37; }" },
];

const FD_CLEANUP_ROWS: FdCleanupRow[] = [
  { bashPath: "/bin/bash", extraEnv: {}, leaked: false, platform: "linux" },
  { bashPath: "/bin/bash", extraEnv: {}, leaked: true, platform: "darwin" },
  { bashPath: "/missing/bash", extraEnv: {}, leaked: true, platform: "linux" },
  { bashPath: "/dev/null", extraEnv: {}, leaked: true, platform: "linux" },
  ...BASH_STARTUP_ENVS.map((extraEnv) => ({
    bashPath: "/bin/bash",
    extraEnv,
    leaked: true,
    platform: "linux" as const,
  })),
];

const tempScripts: TempScript[] = [];
const processes: RoomAppProcess[] = [];
const execFileAsync = promisify(execFile);

async function readLinuxProcessStat(pid: number): Promise<LinuxProcessStat> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    processGroupId: Number(fields[2]),
    state: fields[0] ?? "",
  };
}

async function createTempScript(
  args: CreateTempScriptArgs,
): Promise<TempScript> {
  const root = await mkdtemp(join(tmpdir(), "bb-desktop-process-"));
  const path = join(root, "child.mjs");
  await writeFile(path, args.contents, "utf8");
  const script = { path, root };
  tempScripts.push(script);
  return script;
}

function waitForLog(args: WaitForLogArgs): Promise<void> {
  if (args.process.logs.text().includes(args.text)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      args.process.childProcess.stdout?.off("data", handleData);
      args.process.childProcess.stderr?.off("data", handleData);
      args.process.childProcess.off("exit", handleExit);
      if (error === undefined) {
        resolvePromise();
      } else {
        rejectPromise(error);
      }
    };
    const handleData = (): void => {
      if (args.process.logs.text().includes(args.text)) {
        finish();
      }
    };
    const handleExit = (): void => {
      finish(
        new Error(
          `Process exited before log line: ${args.text}\n${args.process.logs.text()}`,
        ),
      );
    };

    args.process.childProcess.stdout?.on("data", handleData);
    args.process.childProcess.stderr?.on("data", handleData);
    args.process.childProcess.once("exit", handleExit);
    handleData();
    if (
      args.process.childProcess.exitCode !== null ||
      args.process.childProcess.signalCode !== null
    ) {
      handleExit();
    }
  });
}

afterEach(async () => {
  for (const processEntry of processes.splice(0)) {
    if (
      processEntry.childProcess.exitCode === null &&
      processEntry.childProcess.signalCode === null
    ) {
      await processEntry.stop({
        killSignal: "SIGKILL",
        killTimeoutMs: 1_000,
        signal: "SIGTERM",
        timeoutMs: 5_000,
      });
    }
  }

  while (tempScripts.length > 0) {
    const script = tempScripts.pop();
    if (script !== undefined) {
      await rm(script.root, { force: true, recursive: true });
    }
  }
});

describe("bb app process", () => {
  it("uses the dev Node executable without Electron node mode", () => {
    const env = createRoomAppProcessEnv({
      env: {
        ELECTRON_RUN_AS_NODE: "1",
      },
      runtimeMode: "node",
    });

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("uses Electron node mode for packaged runtimes", () => {
    const runtime = resolveRoomAppProcessRuntime({
      env: {},
      isPackaged: true,
      platform: "darwin",
      processExecPath: "/Applications/bb.app/Contents/MacOS/bb",
    });

    expect(runtime).toEqual({
      executablePath: "/Applications/bb.app/Contents/MacOS/bb",
      kind: "direct",
      mode: "electron-node",
    });
    expect(
      createRoomAppProcessEnv({
        env: {},
        runtimeMode: runtime.mode,
      }).ELECTRON_RUN_AS_NODE,
    ).toBe("1");
  });

  it("gives a packaged Linux bridge its own AppImage mount", () => {
    expect(
      resolveRoomAppProcessRuntime({
        env: {
          APPIMAGE: "/home/user/Apps/bb-x86_64.AppImage",
          APPDIR: "/tmp/.mount_bb",
        },
        isPackaged: true,
        platform: "linux",
        processExecPath: "/tmp/.mount_bb/bb",
      }),
    ).toEqual({
      appDirPath: "/tmp/.mount_bb",
      executablePath: "/home/user/Apps/bb-x86_64.AppImage",
      kind: "appimage",
      mode: "electron-node",
    });
  });

  it("imports the bridge from the child AppImage mount", async () => {
    const desktopMountScript = await createTempScript({
      contents: 'process.stdout.write("desktop mount\\n");\n',
    });
    const childMountScript = await createTempScript({
      contents: 'process.stdout.write("child mount\\n");\n',
    });
    const launch = createRoomAppProcessLaunch({
      bridgePath: desktopMountScript.path,
      env: process.env,
      runtime: {
        appDirPath: desktopMountScript.root,
        executablePath: process.execPath,
        kind: "appimage",
        mode: "electron-node",
      },
    });

    expect(launch.args.slice(-3)).toEqual([
      "--",
      desktopMountScript.path,
      "--no-sandbox",
    ]);
    if (process.platform !== "linux") {
      return;
    }
    const result = await execFileAsync(launch.executablePath, launch.args, {
      env: {
        ...launch.env,
        APPDIR: childMountScript.root,
      },
    });

    expect(result.stdout).toBe("child mount\n");
  });

  it.skipIf(process.platform !== "linux")(
    "anchors the process group while supervising descendants after the bridge exits",
    async () => {
      const script = await createTempScript({
        contents: `
import { spawn } from "node:child_process";
const grandchild = spawn(
  process.execPath,
  ["--eval", "setInterval(() => undefined, 1000)"],
  { stdio: "inherit" },
);
process.stdout.write(\`grandchild=\${grandchild.pid}\\n\`);
`,
      });
      const processEntry = startRoomAppProcess({
        bridgePath: script.path,
        cwd: script.root,
        env: {
          ...process.env,
          APPDIR: script.root,
        },
        logLineLimit: 20,
        runtime: {
          appDirPath: script.root,
          executablePath: process.execPath,
          kind: "appimage",
          mode: "electron-node",
        },
      });
      processes.push(processEntry);
      await waitForLog({
        process: processEntry,
        text: "grandchild=",
      });
      const grandchildPid = Number(
        processEntry.logs.text().match(/grandchild=(\d+)/u)?.[1],
      );
      expect(grandchildPid).toBeGreaterThan(0);
      const supervisorStat = await readLinuxProcessStat(processEntry.pid);
      const grandchildStat = await readLinuxProcessStat(grandchildPid);
      expect(supervisorStat.processGroupId).toBe(processEntry.pid);
      expect(supervisorStat.state).not.toBe("Z");
      expect(grandchildStat.processGroupId).toBe(processEntry.pid);
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 50);
      });
      expect(processEntry.childProcess.exitCode).toBeNull();

      await processEntry.stop({
        killSignal: "SIGKILL",
        killTimeoutMs: 1_000,
        signal: "SIGTERM",
        timeoutMs: 5_000,
      });

      expect(() => process.kill(grandchildPid, 0)).toThrow();
    },
  );

  it("uses the inner executable for an unpacked Linux build", () => {
    expect(
      resolveRoomAppProcessRuntime({
        env: {},
        isPackaged: true,
        platform: "linux",
        processExecPath: "/opt/bb/bb",
      }),
    ).toEqual({
      executablePath: "/opt/bb/bb",
      kind: "direct",
      mode: "electron-node",
    });
  });

  it("requires the host Node executable in desktop dev mode", () => {
    expect(() =>
      resolveRoomAppProcessRuntime({
        env: {},
        isPackaged: false,
        platform: "linux",
        processExecPath: "/path/to/electron",
      }),
    ).toThrow("BB_DESKTOP_NODE_EXEC_PATH is required");

    expect(
      resolveRoomAppProcessRuntime({
        env: {
          BB_DESKTOP_NODE_EXEC_PATH: "/usr/local/bin/node",
        },
        isPackaged: false,
        platform: "linux",
        processExecPath: "/path/to/electron",
      }),
    ).toEqual({
      executablePath: "/usr/local/bin/node",
      kind: "direct",
      mode: "node",
    });
  });

  it.runIf(process.platform === "linux").each(FD_CLEANUP_ROWS)(
    "closes a stray inherited fd 201: $platform via $bashPath with $extraEnv",
    async ({ bashPath, extraEnv, platform, leaked }) => {
      const launch = closeInheritedFdsOnLinux({
        bashPath,
        launch: {
          args: [
            "-e",
            'process.stdout.write(String(require("fs").existsSync("/proc/self/fd/201")) + " " + String(process.env.OLDPWD))',
          ],
          env: { PATH: process.env.PATH, ...extraEnv },
          executablePath: process.execPath,
        },
        platform,
      });
      // stdio slot 201 plants an inheritable fd 201 in the child, like the
      // Chromium descriptors Electron's main process leaks.
      const strayFd = openSync("/dev/null", "r");
      const stdio = Array.from({ length: 202 }, (_, fd) =>
        fd === 1 ? "pipe" : fd === 201 ? strayFd : "ignore",
      );
      const child = spawn(launch.executablePath, launch.args, {
        env: launch.env,
        stdio,
      });
      closeSync(strayFd);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      await new Promise((resolveExit) => child.once("exit", resolveExit));
      expect(output).toBe(`${String(leaked)} undefined`);
    },
  );

  it("escalates to SIGKILL when the bridge ignores SIGTERM", async () => {
    const script = await createTempScript({
      contents: `
process.on("SIGTERM", () => {
  process.stdout.write("ignored SIGTERM\\n");
});
process.stdout.write("ready\\n");
setInterval(() => undefined, 1000);
`,
    });
    const processEntry = startRoomAppProcess({
      bridgePath: script.path,
      cwd: script.root,
      env: process.env,
      logLineLimit: 20,
      runtime: {
        executablePath: process.execPath,
        kind: "direct",
        mode: "node",
      },
    });
    processes.push(processEntry);
    await waitForLog({
      process: processEntry,
      text: "ready",
    });
    processEntry.childProcess.kill("SIGTERM");
    await waitForLog({
      process: processEntry,
      text: "ignored SIGTERM",
    });
    const killSpy = vi.spyOn(processEntry.childProcess, "kill");

    await processEntry.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: 1_000,
      signal: "SIGTERM",
      timeoutMs: 50,
    });

    const exit = await processEntry.exit;
    expect(killSpy).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(exit.signal).toBe("SIGKILL");
  });
});
