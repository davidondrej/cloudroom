import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureEnvironmentHookScripts,
  readEnvironmentHookScripts,
  removeEnvironmentHookScripts,
} from "./environment-hook-scripts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

async function commitFiles(
  repo: string,
  files: Record<string, string>,
  message = "commit",
): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, ".."), { recursive: true });
    await writeFile(join(repo, name), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** A repo whose `main` commits both hooks, and a worktree on a new branch from it. */
async function worktreeFromMain(
  files: Record<string, string> = {
    ".bb-env-setup.sh": "echo committed-setup\n",
    ".bb-env-teardown.sh": "echo committed-teardown\n",
  },
) {
  const root = await tempDir("bb-hook-capture-");
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  const base = await commitFiles(repo, { "README.md": "hi\n", ...files });
  const worktree = join(root, "worktree");
  git(repo, "worktree", "add", "-q", "-b", "room/thread", worktree, "main");
  return { root, repo, worktree, base, dataDir: join(root, "data") };
}

async function capture(
  args: { worktree: string; dataDir: string },
  baseBranch: string | null = "main",
  environmentId = "env_test",
) {
  const notes: string[] = [];
  const scripts = await captureEnvironmentHookScripts({
    dataDir: args.dataDir,
    environmentId,
    workspacePath: args.worktree,
    baseBranch,
    onProgress: (entry) => notes.push(entry.text),
  });
  return { scripts, notes };
}

const text = (buffer: Buffer | null) => buffer?.toString("utf8") ?? null;

describe("environment hook capture", () => {
  it("reads both hooks as committed at the start commit and saves them", async () => {
    const repo = await worktreeFromMain();
    const { scripts, notes } = await capture(repo);
    expect(scripts.commit).toBe(repo.base);
    expect(scripts.base).toBe("main");
    expect(text(scripts.setup)).toBe("echo committed-setup\n");
    expect(text(scripts.teardown)).toBe("echo committed-teardown\n");
    expect(notes).toEqual([]);
    const saved = await readEnvironmentHookScripts(repo.dataDir, "env_test");
    expect(text(saved?.setup ?? null)).toBe("echo committed-setup\n");
    expect(text(saved?.teardown ?? null)).toBe("echo committed-teardown\n");
    if (process.platform !== "win32") {
      expect(
        (await stat(join(repo.dataDir, "environment-hooks"))).mode & 0o777,
      ).toBe(0o700);
    }
  });

  it("ignores hooks changed, added or copied into the folder", async () => {
    const repo = await worktreeFromMain({
      ".bb-env-setup.sh": "echo committed-setup\n",
    });
    await writeFile(join(repo.worktree, ".bb-env-setup.sh"), "echo planted\n");
    await writeFile(
      join(repo.worktree, ".bb-env-teardown.sh"),
      "echo planted\n",
    );
    const { scripts, notes } = await capture(repo);
    expect(text(scripts.setup)).toBe("echo committed-setup\n");
    expect(scripts.teardown).toBeNull();
    expect(notes).toEqual([
      expect.stringContaining(
        "Running .bb-env-setup.sh as committed at",
      ),
    ]);
  });

  it("says when the folder has a setup script the base commit lacks", async () => {
    const repo = await worktreeFromMain({});
    await writeFile(join(repo.worktree, ".bb-env-setup.sh"), "echo planted\n");
    const { scripts, notes } = await capture(repo);
    expect(scripts.setup).toBeNull();
    expect(notes).toEqual([
      expect.stringContaining("Skipped .bb-env-setup.sh: it isn't committed at"),
    ]);
  });

  it("leaves out commits made on top of the base, as a fork snapshot or an agent's own commits", async () => {
    const repo = await worktreeFromMain();
    await commitFiles(
      repo.worktree,
      {
        ".bb-env-setup.sh": "echo snapshot-setup\n",
        ".bb-env-teardown.sh": "echo snapshot-teardown\n",
      },
      "Cloudroom fork: uncommitted changes",
    );
    const { scripts } = await capture(repo);
    expect(scripts.commit).toBe(repo.base);
    expect(text(scripts.setup)).toBe("echo committed-setup\n");
    expect(text(scripts.teardown)).toBe("echo committed-teardown\n");
  });

  it("finds a base that exists only on origin, as a new worktree does", async () => {
    const origin = await worktreeFromMain();
    git(origin.repo, "checkout", "-q", "-b", "release");
    const release = await commitFiles(origin.repo, {
      ".bb-env-teardown.sh": "echo release-teardown\n",
    });
    git(origin.repo, "checkout", "-q", "main");
    const clone = join(origin.root, "clone");
    git(origin.root, "clone", "-q", origin.repo, clone);
    const worktree = join(origin.root, "release-worktree");
    git(clone, "worktree", "add", "-q", "-b", "room/r", worktree, "origin/release");
    const { scripts } = await capture(
      { worktree, dataDir: join(origin.root, "data2") },
      "release",
    );
    expect(scripts.commit).toBe(release);
    expect(text(scripts.teardown)).toBe("echo release-teardown\n");
  });

  it.each([
    ["a moved thread's start commit", "head"],
    ["a branch Cloudroom made from an agent's work", "cloudroom/fork-x"],
  ])("never reads hooks from %s; it falls back to the default branch", async (_name, kind) => {
    const repo = await worktreeFromMain();
    const agentCommit = await commitFiles(repo.worktree, {
      ".bb-env-teardown.sh": "echo agent-teardown\n",
    });
    git(repo.worktree, "branch", "cloudroom/fork-x");
    const { scripts } = await capture(
      repo,
      kind === "head" ? agentCommit : kind,
    );
    expect(scripts.base).toBe("main");
    expect(scripts.commit).toBe(repo.base);
    expect(text(scripts.teardown)).toBe("echo committed-teardown\n");
  });

  it("reads hooks once per environment, so a retried setup keeps the first copy", async () => {
    const repo = await worktreeFromMain();
    await capture(repo);
    await commitFiles(repo.repo, {
      ".bb-env-teardown.sh": "echo newer-teardown\n",
    });
    git(repo.worktree, "merge", "-q", "--ff-only", "main");
    const { scripts } = await capture(repo);
    expect(scripts.commit).toBe(repo.base);
    expect(text(scripts.teardown)).toBe("echo committed-teardown\n");
  });

  it.runIf(process.platform !== "win32")(
    "doesn't wait on a pipe left where the setup script was",
    async () => {
      const repo = await worktreeFromMain();
      await rm(join(repo.worktree, ".bb-env-setup.sh"));
      execFileSync("mkfifo", [join(repo.worktree, ".bb-env-setup.sh")]);
      const { scripts, notes } = await capture(repo);
      expect(text(scripts.setup)).toBe("echo committed-setup\n");
      expect(notes).toEqual([
        expect.stringContaining("Running .bb-env-setup.sh as committed at"),
      ]);
    },
  );

  it("reads the hooks at the folder's own path when it is a folder inside the repo", async () => {
    const repo = await worktreeFromMain({
      ".bb-env-setup.sh": "echo root-setup\n",
      "app/.bb-env-setup.sh": "echo app-setup\n",
    });
    const { scripts } = await capture({
      worktree: join(repo.worktree, "app"),
      dataDir: repo.dataDir,
    });
    expect(text(scripts.setup)).toBe("echo app-setup\n");
  });

  it("uses the default branch when no base is given", async () => {
    const repo = await worktreeFromMain();
    const { scripts } = await capture(repo, null);
    expect(scripts.base).toBe("main");
    expect(scripts.commit).toBe(repo.base);
  });

  it("never takes a tag or a Git-folder file with the base's name for the branch", async () => {
    const repo = await worktreeFromMain();
    await commitFiles(repo.worktree, {
      ".bb-env-teardown.sh": "echo tagged\n",
    });
    const tagged = git(repo.worktree, "rev-parse", "HEAD");
    git(repo.worktree, "tag", "main", tagged);
    const gitDir = git(repo.worktree, "rev-parse", "--absolute-git-dir");
    await writeFile(join(gitDir, "main"), `${tagged}\n`);
    const { scripts } = await capture(repo);
    expect(scripts.commit).toBe(repo.base);
    expect(text(scripts.teardown)).toBe("echo committed-teardown\n");
  });

  it("ignores replace refs", async () => {
    const repo = await worktreeFromMain();
    const committed = git(repo.repo, "rev-parse", "main:.bb-env-teardown.sh");
    const forged = execFileSync(
      "git",
      ["hash-object", "-w", "--stdin"],
      { cwd: repo.repo, input: "echo forged\n", encoding: "utf8" },
    ).trim();
    git(repo.repo, "replace", committed, forged);
    const { scripts } = await capture(repo);
    expect(text(scripts.teardown)).toBe("echo committed-teardown\n");
  });

  it.runIf(process.platform !== "win32")(
    "follows a committed link inside the repository, and skips one that leaves it",
    async () => {
      const root = await tempDir("bb-hook-capture-links-");
      const repo = join(root, "repo");
      await mkdir(join(repo, "scripts"), { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      await writeFile(join(repo, "scripts", "setup.sh"), "echo linked\n");
      await symlink("scripts/setup.sh", join(repo, ".bb-env-setup.sh"));
      await symlink("/etc/passwd", join(repo, ".bb-env-teardown.sh"));
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "links");
      const worktree = join(root, "worktree");
      git(repo, "worktree", "add", "-q", "-b", "room/x", worktree, "main");
      const { scripts, notes } = await capture({
        worktree,
        dataDir: join(root, "data"),
      });
      expect(text(scripts.setup)).toBe("echo linked\n");
      expect(scripts.teardown).toBeNull();
      expect(notes).toContain(
        "Skipped .bb-env-teardown.sh: it is a link to a path outside the repository.",
      );
    },
  );

  it("runs no hooks in a folder that is not a Git checkout", async () => {
    const folder = await tempDir("bb-hook-capture-plain-");
    await writeFile(join(folder, ".bb-env-teardown.sh"), "echo planted\n");
    const { scripts, notes } = await capture({
      worktree: folder,
      dataDir: await tempDir("bb-hook-capture-plain-data-"),
    });
    expect(scripts).toEqual({
      commit: null,
      base: null,
      setup: null,
      teardown: null,
    });
    expect(notes).toEqual([
      expect.stringContaining("this folder is not a Git checkout"),
    ]);
  });

  it("keeps scripts byte for byte and removes them on request", async () => {
    const repo = await worktreeFromMain({
      ".bb-env-teardown.sh": "printf '\\xff'\n",
    });
    await writeFile(
      join(repo.repo, ".bb-env-teardown.sh"),
      Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xff, 0x0a]),
    );
    git(repo.repo, "commit", "-q", "-am", "binary byte");
    git(repo.worktree, "merge", "-q", "--ff-only", "main");
    const { scripts } = await capture(repo);
    expect(scripts.teardown).toEqual(
      Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xff, 0x0a]),
    );
    await removeEnvironmentHookScripts(repo.dataDir, "env_test");
    await expect(
      readEnvironmentHookScripts(repo.dataDir, "env_test"),
    ).resolves.toBeNull();
  });

  it("refuses an environment ID that is not a plain name", async () => {
    const repo = await worktreeFromMain();
    await expect(capture(repo, "main", "../escape")).rejects.toThrow(
      "Invalid environment ID",
    );
    await expect(
      readFile(join(repo.root, "escape.json")),
    ).rejects.toThrow();
  });
});
