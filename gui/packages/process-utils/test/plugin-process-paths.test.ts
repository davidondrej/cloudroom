import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginProcessTempDir } from "../src/plugin-process-paths.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(parent: string): Promise<string> {
  const root = await mkdtemp(join(parent, "plugin-temp-"));
  roots.push(root);
  return root;
}

function create(dataDir: string): Promise<string> {
  return createPluginProcessTempDir({
    pluginId: "provider-pi",
    prefix: "bb-provider-bridge",
    dataDir,
  });
}

it.skipIf(process.platform === "win32")(
  "moves the temp folder out of a temp folder other accounts can write to",
  async () => {
    const root = await makeRoot(tmpdir());
    // Like Linux's /tmp: every account can create entries here.
    const shared = join(root, "shared");
    await mkdir(shared);
    await chmod(shared, 0o1777);
    vi.stubEnv("TMPDIR", shared);
    const dataDir = join(root, "bridge-data");

    const tempDir = await create(dataDir);

    const base = join(await realpath(root), "bridge-data", ".cloudroom-tmp");
    expect(dirname(tempDir)).toBe(base);
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(shared)).toEqual([]);

    // A `.cloudroom-tmp` that leads elsewhere is refused, not followed.
    await rm(base, { recursive: true });
    await symlink(shared, base);
    await expect(create(dataDir)).rejects.toThrow(
      "must be a folder owned by this account",
    );
    await rm(base);

    // A data folder, or a folder above it, that other accounts can write to
    // is refused.
    await chmod(dataDir, 0o777);
    await expect(create(dataDir)).rejects.toThrow("Another account can change");
    await chmod(dataDir, 0o755);
    await chmod(root, 0o777);
    await expect(create(dataDir)).rejects.toThrow("Another account can change");
    await chmod(root, 0o700);
    expect(await readdir(shared)).toEqual([]);
  },
);

// With user private groups (Fedora, RHEL, Ubuntu), new folders are 0775.
const ownGroup = spawnSync("getent", ["group", String(process.getgid?.())], {
  encoding: "utf8",
}).stdout?.trim();
const ownGroupIsPrivate =
  ownGroup === `${userInfo().username}:x:${process.getgid?.()}:`;

it.skipIf(process.platform === "win32" || !ownGroupIsPrivate)(
  "accepts a data folder only this account's private group can write to",
  async () => {
    const root = await makeRoot(tmpdir());
    const shared = join(root, "shared");
    await mkdir(shared);
    await chmod(shared, 0o1777);
    vi.stubEnv("TMPDIR", shared);
    const dataDir = join(root, "bridge-data");
    await mkdir(dataDir, { mode: 0o775 });
    await chmod(dataDir, 0o775);

    const tempDir = await create(dataDir);

    expect(dirname(tempDir)).toBe(
      join(await realpath(dataDir), ".cloudroom-tmp"),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "keeps using a temp folder only this account can write to, at its real path",
  async () => {
    // Like macOS's per-account temp folder (the home folder's chain is private).
    const own = await makeRoot(homedir());
    await chmod(own, 0o700);
    const link = join(own, "link");
    await symlink(own, link);
    vi.stubEnv("TMPDIR", link);
    const dataDir = join(own, "bridge-data");

    const tempDir = await create(dataDir);

    expect(dirname(tempDir)).toBe(await realpath(own));
    await expect(stat(join(dataDir, ".cloudroom-tmp"))).rejects.toThrow();
  },
);
