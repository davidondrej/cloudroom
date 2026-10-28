import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROOM_CLI_REEXEC_ENV,
  maybeReexecViaRoomCli,
  resolveRoomCliLaunch,
} from "../room-cli-reexec.js";

describe("maybeReexecViaRoomCli", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "room-cli-reexec-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeExecutable(name: string): Promise<string> {
    const path = join(tempRoot, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  }

  it("no-ops when ROOM_CLI is unset", () => {
    const reexec = vi.fn();
    maybeReexecViaRoomCli({
      env: {},
      currentExecutablePath: "/tmp/current-bb",
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when ROOM_CLI equals the current executable", async () => {
    const path = await writeExecutable("room");
    const reexec = vi.fn();
    maybeReexecViaRoomCli({
      env: { ROOM_CLI: path },
      currentExecutablePath: path,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when already in a re-exec hop", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaRoomCli({
      env: { ROOM_CLI: target, [ROOM_CLI_REEXEC_ENV]: "1" },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("re-execs to ROOM_CLI when it differs from the current entry", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaRoomCli({
      env: { ROOM_CLI: target, ROOM_SERVER_URL: "http://127.0.0.1:1" },
      currentExecutablePath: current,
      argv: ["status", "--json"],
      reexec,
    });
    expect(reexec).toHaveBeenCalledOnce();
    expect(reexec.mock.calls[0]?.[0]).toEqual({
      target: realpathSync(target),
      argv: ["status", "--json"],
      env: expect.objectContaining({
        ROOM_CLI: target,
        ROOM_SERVER_URL: "http://127.0.0.1:1",
        [ROOM_CLI_REEXEC_ENV]: "1",
      }),
    });
  });

  it("no-ops when ROOM_CLI path is missing", async () => {
    const current = await writeExecutable("current");
    const reexec = vi.fn();
    maybeReexecViaRoomCli({
      env: { ROOM_CLI: join(tempRoot, "does-not-exist") },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });
});

describe("resolveRoomCliLaunch", () => {
  it("runs an extensionless ROOM_CLI script through Node on Windows", () => {
    expect(
      resolveRoomCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\cloudroom\\host-daemon\\dist\\room-cli",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\cloudroom\\host-daemon\\dist\\room-cli", "status"],
    });
  });

  it("executes ROOM_CLI directly when the platform can run it", () => {
    expect(
      resolveRoomCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\tools\\room-cli.exe",
      }),
    ).toEqual({ command: "C:\\tools\\room-cli.exe", args: ["status"] });
    expect(
      resolveRoomCliLaunch({
        argv: ["status"],
        nodePath: "/usr/bin/node",
        platform: "darwin",
        target: "/opt/cloudroom/host-daemon/dist/room-cli",
      }),
    ).toEqual({ command: "/opt/cloudroom/host-daemon/dist/room-cli", args: ["status"] });
  });
});
