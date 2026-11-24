import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runGit } from "@cloudroom/host-workspace";
import { afterEach, describe, expect, it } from "vitest";
import { isExpectedCommandDispatchError } from "../command-dispatch-support.js";
import { cloneProject, resolveProjectCloneDefaultPath } from "./project.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-project-clone-"));
  tempDirs.push(dir);
  return dir;
}

async function createRemoteRepo(root: string): Promise<string> {
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(source, { recursive: true });
  await runGit(["init"], { cwd: source });
  await fs.writeFile(path.join(source, "README.md"), "hello\n");
  await runGit(["add", "README.md"], { cwd: source });
  await runGit(
    [
      "-c",
      "user.name=BB Test",
      "-c",
      "user.email=bb@example.test",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: source },
  );
  await runGit(["clone", "--bare", source, remote], { cwd: root });
  return remote;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("project.clone", () => {
  it("clones a real repository and reports the resolved path and origin", async () => {
    const root = await tempDir();
    const remoteUrl = await createRemoteRepo(root);
    const cloneUrl = pathToFileURL(remoteUrl).href;
    const progress: string[] = [];
    const result = await cloneProject({
      dataDir: path.join(root, "data"),
      projectSlug: "My Project",
      remoteUrl: cloneUrl,
      onProgress: (line) => progress.push(line),
    });

    expect(result).toEqual({
      path: path.join(root, "data", "checkouts", "my-project"),
      gitRemoteUrl: cloneUrl,
    });
    await expect(
      fs.readFile(path.join(result.path, "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
    expect(progress.join("\n")).toContain("Cloning into");
    expect(progress.join("\n")).toContain("Receiving objects:");
  });

  it("refuses a non-empty target with a structured error", async () => {
    const root = await tempDir();
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    await fs.writeFile(path.join(targetPath, "keep.txt"), "keep");

    const error = await cloneProject({
      dataDir: path.join(root, "data"),
      projectSlug: "project",
      remoteUrl: path.join(root, "remote.git"),
      targetPath,
    }).catch((caught) => caught);
    expect(isExpectedCommandDispatchError(error)).toBe(true);
    expect(error).toMatchObject({ code: "target_not_empty" });
  });

  it("preserves git stderr in a structured clone failure", async () => {
    const root = await tempDir();
    const missingRemote = path.join(root, "missing.git");
    const error = await cloneProject({
      dataDir: path.join(root, "data"),
      projectSlug: "project",
      remoteUrl: missingRemote,
    }).catch((caught) => caught);

    expect(isExpectedCommandDispatchError(error)).toBe(true);
    expect(error).toMatchObject({ code: "git_command_failed" });
    expect(error.message).toContain(
      `fatal: repository '${missingRemote}' does not exist`,
    );
  });

  it.each([
    { userinfo: "FAKE_TOKEN", file: "repo.git", secret: "FAKE_TOKEN" },
    {
      userinfo: "user:FAKE_TOKEN_WITH SPACE",
      file: "repo$&.git",
      secret: "FAKE_TOKEN_WITH SPACE",
    },
  ])(
    "keeps a remote's token out of clone progress and errors (#2190): $userinfo",
    async ({ userinfo, file, secret }) => {
      const root = await tempDir();
      // Token-only auth reaches the 401; a spaced password covers Git's raw argv error.
      const server = http.createServer((_, response) => {
        response.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
        response.end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const { port } = server.address() as AddressInfo;
      const progress: string[] = [];
      try {
        const error = await cloneProject({
          dataDir: path.join(root, "data"),
          projectSlug: "project",
          remoteUrl: `http://${userinfo}@127.0.0.1:${port}/${file}`,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          onProgress: (line) => progress.push(line),
        }).catch((caught) => caught);
        const output = `${progress.join("\n")}\n${error.message}`;
        expect(output).toContain(`http://127.0.0.1:${port}`);
        expect(output).not.toContain(secret);
      } finally {
        server.close();
      }
    },
  );

  it("derives the checkout convention without touching the filesystem", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    expect(resolveProjectCloneDefaultPath(dataDir, " Project / Name ")).toBe(
      path.join(dataDir, "checkouts", "project-name"),
    );
    await expect(fs.stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
