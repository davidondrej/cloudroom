import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { tarCommand } from "@cloudroom/process-utils";
import type { CloudroomClient } from "../../src/services/cloudroom/client.js";
import { checksOutCrlf } from "../../src/services/cloudroom/project-copy.js";
import { applyChanges, cloudChanges, packChangesCommand } from "../../src/services/cloudroom/teleport-local.js";

it("Teleport to Local never overwrites Mac work and never writes into .git", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cloudroom-teleport-local-"));
  const root = join(temp, "mac");
  const cloud = join(temp, "cloud");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]).toString().trim();
  const write = (folder: string, text: string) => (path: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  };
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  try {
    mkdirSync(root);
    git("init", "-q");
    ["main.txt", "wip.txt", "clean.txt"].forEach(write(root, "base"));
    git("add", ".");
    git("commit", "-qm", "cloud base");
    const base = git("rev-parse", "HEAD");
    // The Mac moves on after the cloud started: one new commit, one uncommitted edit.
    write(root, "mac")("main.txt");
    git("commit", "-qam", "mac commit");
    write(root, "mac")("wip.txt");

    const files = ["main.txt", "wip.txt", "clean.txt", "new.txt", ".git/hooks/pre-commit"];
    files.forEach(write(cloud, "cloud"));
    const archive = join(temp, "changes.tgz");
    execFileSync("tar", ["-czf", archive, "-C", cloud, ...files]);

    expect(await applyChanges(root, readFileSync(archive), "run", base)).toBe(2);
    expect([read("main.txt"), read("wip.txt"), read("clean.txt"), read("new.txt")]).toEqual(["mac", "mac", "cloud", "cloud"]);
    expect([read(".cloudroom/teleport/run/main.txt"), read(".cloudroom/teleport/run/wip.txt")]).toEqual(["cloud", "cloud"]);
    expect(existsSync(join(root, ".git/hooks/pre-commit"))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Runs cloud commands in a local folder, the way the sandbox's `bash -lc` does. Cloud packing runs on Linux only.
function localCloud(home: string) {
  return {
    runOnVm: async ({ command }: { command: string }) => {
      const run = spawnSync("bash", ["-lc", command], { cwd: home, env: { HOME: home, PATH: process.env.PATH }, encoding: "buffer" });
      return { code: run.status ?? 1, stdout: run.stdout.toString("hex"), stderr: run.stderr.toString("hex"), truncated: false };
    },
  } as unknown as CloudroomClient;
}

it.skipIf(process.platform === "win32")("Teleport packs fail on an unreadable file and skip only dangling links on Windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "teleport-pack-"));
  try {
    await writeFile(join(root, "a.md"), "agents\n");
    await symlink("a.md", join(root, "link.md"));
    await symlink("missing.md", join(root, "dangling.md"));
    await writeFile(join(root, "secret.txt"), "x");
    await chmod(join(root, "secret.txt"), 0o000);
    const pack = (windows: boolean, names: string[]) => spawnSync("bash", ["-c", `printf '%s\\0' ${names.join(" ")} | ${packChangesCommand(join(root, "out.tgz"), windows)}`], { cwd: root, encoding: "utf8" });
    expect(packChangesCommand("~/x.tgz", false)).toBe("tar -czf ~/x.tgz --null -T -");
    expect(pack(true, ["a.md", "link.md", "dangling.md"]).status).toBe(0);
    const listed = spawnSync("tar", ["-tvzf", join(root, "out.tgz")], { encoding: "utf8" }).stdout;
    expect(listed).toMatch(/^-.* link\.md$/m);
    expect(listed).not.toContain("dangling.md");
    expect(pack(true, ["a.md", "secret.txt"]).status).not.toBe(0);
    expect(pack(false, ["a.md", "secret.txt"]).status).not.toBe(0);
  } finally {
    await chmod(join(root, "secret.txt"), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("Teleport to Local stops before switching when a changed cloud file can't be read", async () => {
  const home = await mkdtemp(join(tmpdir(), "teleport-cloud-"));
  try {
    const workspace = join(home, "project");
    await mkdir(workspace);
    spawnSync("git", ["init", "-q", workspace]);
    spawnSync("git", ["-C", workspace, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
    await writeFile(join(workspace, "new.txt"), "new\n");
    await writeFile(join(workspace, "secret.txt"), "x");
    await chmod(join(workspace, "secret.txt"), 0o000);
    await expect(cloudChanges(localCloud(home), workspace, null, Date.now())).rejects.toThrow(/secret\.txt/);
    await chmod(join(workspace, "secret.txt"), 0o600);
    const changes = await cloudChanges(localCloud(home), workspace, null, Date.now());
    expect(changes.archive.length).toBeGreaterThan(0);
  } finally {
    await chmod(join(home, "project", "secret.txt"), 0o600).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

it("CRLF checkouts are found in every spelling Git accepts", async () => {
  const repo = await mkdtemp(join(tmpdir(), "autocrlf-"));
  try {
    spawnSync("git", ["init", "-q", repo]);
    for (const [value, crlf] of [["true", true], ["yes", true], ["on", true], ["1", true], ["True", true], ["input", false], ["false", false]] as const) {
      spawnSync("git", ["-C", repo, "config", "core.autocrlf", value]);
      expect(await checksOutCrlf(repo), value).toBe(crlf);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("A folder link round-trips to Mac and Linux, and stops a Windows Teleport with its path", async () => {
  const home = await mkdtemp(join(tmpdir(), "teleport-folder-link-"));
  try {
    const workspace = join(home, "project");
    const mac = join(home, "mac");
    for (const folder of [workspace, mac]) {
      await mkdir(folder);
      spawnSync("git", ["init", "-q", folder]);
      spawnSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
    }
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "a.md"), "a\n");
    await symlink("docs", join(workspace, "docs-link"));

    const changes = await cloudChanges(localCloud(home), workspace, null, Date.now());
    expect(await applyChanges(mac, changes.archive, "run", null)).toBe(0);
    expect(readlinkSync(join(mac, "docs-link"))).toBe("docs");
    expect(readFileSync(join(mac, "docs-link", "a.md"), "utf8")).toBe("a\n");

    const windows = spawnSync("bash", ["-c", `printf '%s\\0' docs/a.md docs-link | ${packChangesCommand(join(home, "out.tgz"), true)}`], { cwd: workspace, encoding: "utf8" });
    expect(windows.status).not.toBe(0);
    expect(windows.stderr).toContain("docs-link is a folder link");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("A Windows Teleport refuses a link out of the project before switching", async () => {
  const home = await mkdtemp(join(tmpdir(), "teleport-outside-link-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    const workspace = join(home, "project");
    await mkdir(workspace);
    spawnSync("git", ["init", "-q", workspace]);
    spawnSync("git", ["-C", workspace, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
    await writeFile(join(home, "credentials.json"), "secret\n");
    await writeFile(join(workspace, "a.md"), "a\n");
    await symlink("a.md", join(workspace, "inside.md"));
    await symlink(join(home, "credentials.json"), join(workspace, "notes.txt"));

    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await expect(cloudChanges(localCloud(home), workspace, null, Date.now())).rejects.toThrow(
      "notes.txt points outside the project",
    );
    await rm(join(workspace, "notes.txt"));
    const changes = await cloudChanges(localCloud(home), workspace, null, Date.now());
    Object.defineProperty(process, "platform", platform);
    const mac = join(home, "mac");
    await mkdir(mac);
    expect(await applyChanges(mac, changes.archive, "run", null)).toBe(0);
    expect(readFileSync(join(mac, "inside.md"), "utf8")).toBe("a\n");
  } finally {
    Object.defineProperty(process, "platform", platform);
    await rm(home, { recursive: true, force: true });
  }
});

it("Teleport to Local never overwrites a dirty file it reaches by another spelling", async () => {
  const windows = process.platform === "win32";
  const temp = mkdtempSync(join(tmpdir(), "cloudroom-teleport-spelling-"));
  const root = join(temp, "mac");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]).toString().trim();
  const pack = (archive: string, files: Record<string, string>) => {
    const args = ["-czf", archive];
    for (const [index, [path, text]] of Object.entries(files).entries()) {
      const cloud = join(temp, `cloud${index}`);
      mkdirSync(dirname(join(cloud, path)), { recursive: true });
      writeFileSync(join(cloud, path), text);
      args.push("-C", cloud, path);
    }
    execFileSync(tarCommand(), args);
    return readFileSync(archive);
  };
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    git("init", "-q");
    writeFileSync(join(root, "src", "Foo.ts"), "base");
    if (!windows) symlinkSync("src", join(root, "alias"));
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "src", "Foo.ts"), "mac");

    const incoming = windows ? "src/foo.ts" : "alias/Foo.ts";
    expect(await applyChanges(root, pack(join(temp, "one.tgz"), { [incoming]: "cloud" }), "run", base)).toBe(1);
    expect(readFileSync(join(root, "src", "Foo.ts"), "utf8")).toBe("mac");
    expect(readFileSync(join(root, ".cloudroom", "teleport", "run", incoming), "utf8")).toBe("cloud");

    const twins: Record<string, string> = windows ? { "src/new.ts": "a", "src/NEW.ts": "b" } : { "alias/new.ts": "a", "src/new.ts": "b" };
    await expect(applyChanges(root, pack(join(temp, "two.tgz"), twins), "twins", base)).rejects.toThrow("are the same file");
    expect(existsSync(join(root, "src", "new.ts"))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
