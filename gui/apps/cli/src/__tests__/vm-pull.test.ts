import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_PULL_ARCHIVE, placePull } from "../commands/cloudroom.js";

// Windows can't rename a folder onto an existing one, even an empty one (#1396); the "win32" test turns this on.
let windowsRename = false;
vi.mock("node:fs/promises", async (real: () => Promise<typeof import("node:fs/promises")>) => {
  const fs = await real();
  const rename: typeof fs.rename = async (from, to) => {
    if (windowsRename && (await fs.lstat(from)).isDirectory() && await fs.lstat(to).then(() => true, () => false)) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
    return fs.rename(from, to);
  };
  return { ...fs, rename, default: { ...fs, rename } };
});

let root: string;
let folder: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "vm-pull-")));
  folder = join(root, "here");
  await mkdir(folder);
});

afterEach(async () => {
  windowsRename = false;
  vi.unstubAllGlobals();
  execFileSync("chmod", ["-R", "u+rwx", root]); // a pulled read-only folder would otherwise block cleanup
  await rm(root, { recursive: true, force: true });
});

async function archive(files: Record<string, string>, readOnlyDirs: string[] = []): Promise<Buffer> {
  const from = await mkdtemp(join(root, "vm-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(from, path)), { recursive: true });
    await writeFile(join(from, path), text);
  }
  for (const dir of readOnlyDirs) await chmod(join(from, dir), 0o555);
  const top = [...new Set(Object.keys(files).map((path) => path.split("/")[0]!))];
  return execFileSync("tar", ["-czf", "-", "-C", from, "--", ...top]);
}

const HOOK = { ".git/hooks/pre-commit": "#!/bin/sh\necho pwned\n" };

describe.skipIf(process.platform === "win32")("vm pull into a folder", () => {
  it("copies nothing when the VM adds other files", async () => {
    const extra = await archive({ "report.md": "report", ...HOOK });
    await expect(placePull(extra, "~/report.md", folder, true)).rejects.toThrow("Could not unpack the copied files.");
    expect(await readdir(folder)).toEqual([]);
  });

  it("lands the one item only under the name asked for", async () => {
    expect(await placePull(await archive(HOOK), "~/report.md", folder, true)).toBe(join(folder, "report.md"));
    expect(await readdir(folder)).toEqual(["report.md"]);
  });

  it("merges a folder into the one already there, which keeps its own mode", async () => {
    await mkdir(join(folder, "dist"));
    await chmod(join(folder, "dist"), 0o755);
    await writeFile(join(folder, "dist", "keep.txt"), "kept");
    await writeFile(join(folder, "dist", "app.js"), "old");
    const dist = await archive({ "dist/app.js": "new", "dist/assets/logo.svg": "<svg/>" }, ["dist"]);
    expect(await placePull(dist, "~/project/dist/", folder, true)).toBe(join(folder, "dist"));
    expect(await readFile(join(folder, "dist", "keep.txt"), "utf8")).toBe("kept");
    expect(await readFile(join(folder, "dist", "app.js"), "utf8")).toBe("new");
    expect(await readFile(join(folder, "dist", "assets", "logo.svg"), "utf8")).toBe("<svg/>");
    expect((await stat(join(folder, "dist"))).mode & 0o777).toBe(0o755); // the VM's read-only (0555) folder doesn't lock it
    expect(await readdir(folder)).toEqual(["dist"]); // no .cloudroom- staging left behind
  });

  it("cleans up staging even when the VM's folder is read-only", async () => {
    await mkdir(join(folder, "bundle"));
    await writeFile(join(folder, "bundle", "old.txt"), "old");
    const bundle = await archive({ "bundle/locked/data.bin": "x" }, ["bundle/locked"]);
    expect(await placePull(bundle, "~/bundle/", folder, true)).toBe(join(folder, "bundle"));
    expect(await readFile(join(folder, "bundle", "locked", "data.bin"), "utf8")).toBe("x");
    expect(await readFile(join(folder, "bundle", "old.txt"), "utf8")).toBe("old");
    expect(await readdir(folder)).toEqual(["bundle"]); // no .cloudroom- staging left behind
  });

  it("lets the VM name a . copy only as a new folder that starts with a letter or digit", async () => {
    const work = await archive({ "work/notes.md": "notes" });
    expect(await placePull(work, ".", folder, true)).toBe(join(folder, "work"));
    await expect(placePull(work, ".", folder, true)).rejects.toThrow("already exists");
    await expect(placePull(await archive(HOOK), "~", folder, true)).rejects.toThrow('The VM named this copy ".git"');
    await expect(placePull(await archive({ "‌.git/config": "[core]" }), "..", folder, true)).rejects.toThrow("The VM named this copy");
    expect(await readdir(folder)).toEqual(["work"]);
  });
});

describe.skipIf(process.platform === "win32")("vm pull to a new name on Windows", () => {
  beforeEach(() => {
    windowsRename = true;
    vi.stubGlobal("process", { ...process, platform: "win32" });
  });

  it("places a folder, though Windows can't rename onto the folder that claims the name", async () => {
    const target = join(folder, "renamed");
    expect(await placePull(await archive({ "site/index.html": "hi", "site/css/app.css": "a{}" }), "~/site", target, false)).toBe(target);
    expect(await readFile(join(target, "index.html"), "utf8")).toBe("hi");
    expect(await readFile(join(target, "css", "app.css"), "utf8")).toBe("a{}");
    expect(await readdir(folder)).toEqual(["renamed"]); // no .cloudroom- staging left behind
  });

  it("refuses a name that is already taken", async () => {
    await writeFile(join(folder, "taken"), "mine");
    await expect(placePull(await archive({ "site/index.html": "hi" }), "~/site", join(folder, "taken"), false)).rejects.toThrow("already exists; nothing was copied.");
    expect((await lstat(join(folder, "taken"))).isFile()).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("vm pull to Windows: what the VM sends", () => {
  it.each([["the file", "build.tar.gz"], ["the folder", "site/index.html"]])("copies %s the link points to (#1454)", async (_, path) => {
    const vm = await mkdtemp(join(root, "vm-"));
    await mkdir(dirname(join(vm, path)), { recursive: true });
    await writeFile(join(vm, path), "data");
    await symlink(path.split("/")[0]!, join(vm, "latest"));
    const sent = execFileSync("sh", ["-c", `n=latest; ${WINDOWS_PULL_ARCHIVE}`], { cwd: vm });
    expect(await placePull(sent, "~/latest", folder, true)).toBe(join(folder, "latest"));
    expect(await readFile(join(folder, "latest", ...path.split("/").slice(1)), "utf8")).toBe("data");
  });

  it("fails on the VM for a missing path instead of sending an empty archive (#1454)", () => {
    expect(() => execFileSync("sh", ["-c", `n=missing; ${WINDOWS_PULL_ARCHIVE}`], { cwd: root, stdio: "pipe" })).toThrow("No such file or directory");
  });
});
