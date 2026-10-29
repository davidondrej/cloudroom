import { describe, expect, it } from "vitest";
import { isBbManagedWorkspacePath } from "../../src/services/threads/workspace-paths.js";

const dataDir = "/home/user/.bb";

describe("isBbManagedWorkspacePath", () => {
  it("recognises the managed workspace roots", () => {
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees/env_abc/repo`,
      }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/personal-workspaces/env_abc`,
      }),
    ).toBe(true);
  });

  it("leaves paths outside the managed roots alone", () => {
    expect(
      isBbManagedWorkspacePath({ dataDir, path: "/home/user/code/repo" }),
    ).toBe(false);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "/home/user/.bb-other/worktrees/env_abc",
      }),
    ).toBe(false);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees-backup/env_abc`,
      }),
    ).toBe(false);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "/home/user/.BB/worktrees/env_abc",
      }),
    ).toBe(false);
  });

  it("recognises managed roots on a Windows host in any spelling", () => {
    const windowsDataDir = "C:\\Users\\me\\.bb";
    expect(
      isBbManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "c:/users/me/.bb/worktrees/env_abc/repo",
      }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\.bb\\personal-workspaces\\env_abc",
      }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\code\\repo",
      }),
    ).toBe(false);
  });
});
