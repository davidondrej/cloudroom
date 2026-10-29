import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { localFiles } from "../../src/services/cloudroom/project-copy.js";

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
