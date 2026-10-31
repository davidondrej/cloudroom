import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placePull } from "../commands/cloudroom.js";

let root: string;
let folder: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "vm-pull-")));
  folder = join(root, "here");
  await mkdir(folder);
});

afterEach(async () => {
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
