import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type { CloudroomClient } from "../../src/services/cloudroom/client.js";
import { copyProject, envRefusal, localFiles } from "../../src/services/cloudroom/project-copy.js";
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
    ["staged.txt", "added.txt", "unstaged.txt", "untracked.txt", ".env", "apps/web/.env", "node_modules/pkg/index.js"].forEach(write("new"));
    git("add", "staged.txt", "added.txt");

    expect((await localFiles(root, "changed")).sort()).toEqual([".env", "added.txt", "apps/web/.env", "staged.txt", "unstaged.txt", "untracked.txt"]);
    // Decision (#140): a project at a repo root keeps its ignored `.env` files at any depth, since monorepo apps need theirs.
    expect((await localFiles(root, "env")).sort()).toEqual([".env", "apps/web/.env"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("copies a non-repo-root project's .env files only from its root and the roots of nested repos (#140)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  try {
    for (const path of [".env", "app.js", "secrets/.env.prod", "tools/config/.env.local", "api/.git/HEAD", "api/.env.production", "api/src/.env", "web/.git", "web/.env"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "x");
    }
    expect((await localFiles(root, "env")).sort()).toEqual([".env", "api/.env.production", "web/.env"]);
    expect((await localFiles(root, "all")).sort()).toEqual([".env", "api/.env.production", "app.js", "web/.env"]);
    // But a home folder, or a GitHub project's folder that is no checkout of it, sends none (#1120).
    expect([envRefusal(homedir(), null), envRefusal(root, "https://github.com/a/b"), envRefusal(root, null), envRefusal(join(root, "api"), "https://github.com/a/b")].map(Boolean)).toEqual([true, true, false, false]);

    // A project folder inside another Git checkout is listed by Git, but gets the same rule.
    const inner = join(root, "checkout/workspace");
    for (const path of [".env", "secrets/.env.production", "config/.env.local"]) {
      mkdirSync(dirname(join(inner, path)), { recursive: true });
      writeFileSync(join(inner, path), "x");
    }
    execFileSync("git", ["init", "-q", join(root, "checkout")]);
    writeFileSync(join(root, "checkout/.gitignore"), ".env*\n");
    expect((await localFiles(inner, "env")).sort()).toEqual([".env"]);
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
