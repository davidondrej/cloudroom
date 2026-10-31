import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type { CloudroomClient } from "../../src/services/cloudroom/client.js";
import { copyProject, localFiles } from "../../src/services/cloudroom/project-copy.js";
import { createTestAppHarness } from "../helpers/test-app.js";

it("Teleport to Cloud copies staged, unstaged, and untracked work plus ignored .env files", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
  const write = (text: string) => (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "node_modules\n.env\n");
    ["staged.txt", "unstaged.txt", "clean.txt"].forEach(write("old"));
    git("add", ".");
    git("commit", "-qm", "init");
    ["staged.txt", "added.txt", "unstaged.txt", "untracked.txt", ".env", "node_modules/pkg/index.js"].forEach(write("new"));
    git("add", "staged.txt", "added.txt");

    expect((await localFiles(root, "changed")).sort()).toEqual([".env", "added.txt", "staged.txt", "unstaged.txt", "untracked.txt"]);
    expect(await localFiles(root, "env")).toEqual([".env"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("sends a Cloud loop run's child no .env files when the run didn't pick them (ADR 0342)", async () => {
  const harness = await createTestAppHarness();
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  try {
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".env.local"), "SECRET=2\n");
    writeFileSync(join(root, "app.js"), "ok\n");
    // The fake Core keeps every uploaded piece; the last command unpacks them.
    const pieces: Buffer[] = [];
    const client = {
      workspace: async () => ({ path: "/code/project" }),
      runOnVm: async (_input: unknown, _signal?: AbortSignal, bytes?: Uint8Array) => { if (bytes?.length) pieces.push(Buffer.from(bytes)); return { code: 0, stdout: "", stderr: "" }; },
    } as unknown as CloudroomClient;
    const copied = (noEnv: boolean) => new Promise<string[]>((resolve, reject) => {
      pieces.length = 0;
      copyProject(harness.deps, client, { threadId: "thr_child", workspace: "w", key: `copy-${noEnv}`, localPath: root, repository: null, clone: false, copyAll: true, teleport: false, ...(noEnv ? { noEnv } : {}) }, (error) => {
        if (error) return reject(new Error(error));
        const archive = join(root, "..", `${noEnv}.tgz`);
        writeFileSync(archive, Buffer.concat(pieces));
        resolve(execFileSync("tar", ["-tzf", archive]).toString().split("\n").filter(Boolean).map(path => path.replace(/^\.\//, "")).sort());
        rmSync(archive, { force: true });
      });
    });
    expect(await copied(true)).toEqual(["app.js"]);
    expect(await copied(false)).toEqual([".env", ".env.local", "app.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await harness.cleanup();
  }
});
