import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CloudroomClient } from "../../src/services/cloudroom/client.js";
import { landForkCode, sourceCode } from "../../src/services/cloudroom/fork.js";

const linux = it.skipIf(process.platform !== "linux");
let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cloudroom-fork-code-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function sandbox(home: string, workspace: string): CloudroomClient {
  mkdirSync(home, { recursive: true });
  return {
    sessionWorkspace: async () => ({ path: workspace, branch: null, head: null }),
    runOnVm: async (input: { command: string; stdin?: string }, _signal?: AbortSignal, bytes?: Uint8Array) => {
      const result = spawnSync("bash", ["-c", input.command], { cwd: home, env: { ...process.env, HOME: home }, input: bytes ?? Buffer.from(input.stdin ?? "", "hex") });
      return { code: result.status ?? 1, stdout: result.stdout.toString("hex"), stderr: result.stderr.toString("hex"), truncated: false };
    },
  } as unknown as CloudroomClient;
}

function folder(name: string, files: Record<string, string>): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), text);
  }
  return path;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString();

function clone(files: Record<string, string>): string {
  const path = folder("child", files);
  git(path, "init", "-q");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "init");
  return path;
}

async function copy(parent: string, child: string, id: string): Promise<string | null> {
  const code = await sourceCode(sandbox(join(root, "parent-home"), parent), parent, id);
  return landForkCode(sandbox(join(root, "child-home"), child), { sessionId: "s", transfer: id, code: Promise.resolve(code) });
}

linux("leaves a child's GitHub clone whole when the parent's folder is empty", async () => {
  const child = clone({ "README.md": "b", "src/a.ts": "a" });
  expect(await copy(folder("parent", {}), child, "t1")).toBeNull();
  expect(git(child, "status", "--porcelain")).toBe("");
});

linux("lays a parent's plain files over a child's GitHub clone and deletes nothing", async () => {
  const child = clone({ "README.md": "b", "src/a.ts": "a" });
  expect(await copy(folder("parent", { "src/a.ts": "edited", "new.ts": "n" }), child, "t2")).toBeNull();
  expect(git(child, "status", "--porcelain")).toBe(" M src/a.ts\n?? new.ts\n");
  expect(readFileSync(join(child, "src/a.ts"), "utf8")).toBe("edited");
});

linux("mirrors the parent's files into a child with no Git repository, and an empty parent removes nothing", async () => {
  const child = folder("child", { ".env": "KEY=1", "stale.ts": "s", "node_modules/x.js": "x" });
  expect(await copy(folder("empty", {}), child, "t3")).toBeNull();
  expect(existsSync(join(child, ".env")) && existsSync(join(child, "stale.ts"))).toBe(true);

  expect(await copy(folder("parent", { ".env": "KEY=2", "a.ts": "a" }), child, "t4")).toBeNull();
  expect(existsSync(join(child, "stale.ts"))).toBe(false);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("KEY=2");
  expect(existsSync(join(child, "a.ts")) && existsSync(join(child, "node_modules/x.js"))).toBe(true);
});

linux("never writes through a clone's symlink into .git", async () => {
  const child = folder("child", { "README.md": "b" });
  symlinkSync(".git", join(child, "alias"));
  git(child, "init", "-q");
  git(child, "add", "-A");
  git(child, "commit", "-qm", "init");
  const config = readFileSync(join(child, ".git/config"), "utf8");
  expect(await copy(folder("parent", { "alias/config": "x" }), child, "t5")).toBeNull();
  expect(readFileSync(join(child, ".git/config"), "utf8")).toBe(config);
  expect(lstatSync(join(child, "alias")).isDirectory()).toBe(true);
  expect(readFileSync(join(child, "alias/config"), "utf8")).toBe("x");
});
