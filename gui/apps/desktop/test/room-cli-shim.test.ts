import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appImageRoomCliShim,
  ensureRoomCliShim,
  resolveBundledRoomCliPath,
} from "../src/room-cli-shim.js";

let root: string;
let homeDir: string;
let shimPath: string;

async function installApp(
  appDir: string,
  resources = "Contents/Resources",
): Promise<string> {
  const cliPath = resolveBundledRoomCliPath(
    join(root, appDir, resources, "app.asar"),
  );
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(
    cliPath,
    "console.log(JSON.stringify(process.argv.slice(1)));\n",
  );
  await chmod(cliPath, 0o755);
  return cliPath;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "room-cli-shim-"));
  homeDir = join(root, "home");
  shimPath = join(homeDir, ".local/bin/room-cli");
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("room-cli shim", () => {
  it("resolves the CLI bundled beside the app asar", () => {
    expect(
      resolveBundledRoomCliPath(
        "/Applications/Cloudroom.app/Contents/Resources/app.asar",
      ),
    ).toBe(
      "/Applications/Cloudroom.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room-cli",
    );
  });

  it("creates the shim, then leaves it alone on the next startup", async () => {
    const cliPath = await installApp("Cloudroom.app");

    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ kind: "created" });
    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ kind: "unchanged" });
    expect(await readlink(shimPath)).toBe(cliPath);
  });

  it("repoints a link left by a moved app or an old CLI name", async () => {
    const cliPath = await installApp("Moved/Cloudroom.app");
    await mkdir(dirname(shimPath), { recursive: true });
    await symlink(
      "/Applications/Cloudroom.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room",
      shimPath,
    );

    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ kind: "repaired" });
    expect(await readlink(shimPath)).toBe(cliPath);
  });

  it("never replaces a file or link the user owns", async () => {
    const cliPath = await installApp("Cloudroom.app");
    await mkdir(dirname(shimPath), { recursive: true });
    await writeFile(shimPath, "#!/bin/sh\necho mine\n");

    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({
      kind: "skipped",
      reason: "user-owned",
    });
    expect(await readFile(shimPath, "utf8")).toBe("#!/bin/sh\necho mine\n");

    const appImagePath = "/opt/Cloudroom.AppImage";
    const ours = appImageRoomCliShim(appImagePath);
    const mine = ours
      .replace(/\n# Managed by Cloudroom.*/u, "")
      .replace("exec ", "exec env ROOM_SERVER_URL=http://127.0.0.1:9 ");
    await writeFile(shimPath, mine);
    await expect(
      ensureRoomCliShim({ appImagePath, cliPath, homeDir }),
    ).resolves.toMatchObject({ reason: "user-owned" });
    expect(await readFile(shimPath, "utf8")).toBe(mine);

    await writeFile(shimPath, ours.replace("exec ", "exec env OLD=1 "));
    await expect(
      ensureRoomCliShim({ appImagePath, cliPath, homeDir }),
    ).resolves.toMatchObject({ kind: "repaired" });
    expect(await readFile(shimPath, "utf8")).toBe(ours);

    await rm(shimPath);
    await symlink("/Users/me/code/room-cli-dev", shimPath);
    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ reason: "user-owned" });
    expect(await readlink(shimPath)).toBe("/Users/me/code/room-cli-dev");
  });

  it("runs the AppImage itself, so a new mount after a restart still works", async () => {
    const appImagePath = join(root, "Apps/Cloud'room.AppImage");
    const oldCli = await installApp(".mount_old", "resources");
    const newCli = await installApp(".mount_new", "resources");
    await mkdir(dirname(appImagePath), { recursive: true });
    await writeFile(
      appImagePath,
      `#!/bin/sh\ns=--no-sandbox\nfor a in "$@"; do [ "$a" = --no-sandbox ] && s=; done\nAPPDIR='${join(root, ".mount_new")}' exec '${process.execPath}' \${s:+"$s"} "$@"\n`,
    );
    await chmod(appImagePath, 0o755);

    await expect(
      ensureRoomCliShim({ appImagePath, cliPath: oldCli, homeDir }),
    ).resolves.toMatchObject({ kind: "created" });
    await expect(
      ensureRoomCliShim({ appImagePath, cliPath: newCli, homeDir }),
    ).resolves.toMatchObject({ kind: "unchanged" });
    expect(
      JSON.parse(
        execFileSync(shimPath, ["thread", "show", "Ada's thread"], {
          encoding: "utf8",
        }),
      ),
    ).toEqual([newCli, "thread", "show", "Ada's thread"]);

    await chmod(shimPath, 0o644);
    await expect(
      ensureRoomCliShim({ appImagePath, cliPath: newCli, homeDir }),
    ).resolves.toMatchObject({ kind: "repaired" });
    expect((await lstat(shimPath)).mode & 0o100).not.toBe(0);
    await expect(
      ensureRoomCliShim({ cliPath: newCli, homeDir }),
    ).resolves.toMatchObject({ kind: "repaired" });
    expect(await readlink(shimPath)).toBe(newCli);
  });

  it("does not link to a missing or translocated app", async () => {
    await expect(
      ensureRoomCliShim({ cliPath: join(root, "missing/room-cli"), homeDir }),
    ).resolves.toMatchObject({ reason: "missing-cli" });
    const translocated = await installApp(
      "AppTranslocation/ABC/d/Cloudroom.app",
    );
    await expect(
      ensureRoomCliShim({ cliPath: translocated, homeDir }),
    ).resolves.toMatchObject({
      reason: "translocated",
    });
    await expect(lstat(shimPath)).rejects.toThrow();
  });
});
