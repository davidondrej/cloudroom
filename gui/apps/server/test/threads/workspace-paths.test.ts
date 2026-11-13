import { describe, expect, it } from "vitest";
import { isRoomManagedWorkspacePath } from "../../src/services/threads/workspace-paths.js";

const dataDir = "/home/user/.bb";

describe("isBbManagedWorkspacePath", () => {
  it("recognises the managed workspace roots", () => {
    expect(
      isRoomManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees/env_abc/repo`,
      }),
    ).toBe(true);
    expect(
      isRoomManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/personal-workspaces/env_abc`,
      }),
    ).toBe(true);
  });

  it("leaves paths outside the managed roots alone", () => {
    expect(
      isRoomManagedWorkspacePath({ dataDir, path: "/home/user/code/repo" }),
    ).toBe(false);
    expect(
      isRoomManagedWorkspacePath({
        dataDir,
        path: "/home/user/.bb-other/worktrees/env_abc",
      }),
    ).toBe(false);
    expect(
      isRoomManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees-backup/env_abc`,
      }),
    ).toBe(false);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(
      isRoomManagedWorkspacePath({
        dataDir,
        path: "/home/user/.BB/worktrees/env_abc",
      }),
    ).toBe(false);
  });

  it("recognises managed roots on a Windows host in any spelling", () => {
    const windowsDataDir = "C:\\Users\\me\\.bb";
    expect(
      isRoomManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "c:/users/me/.bb/worktrees/env_abc/repo",
      }),
    ).toBe(true);
    expect(
      isRoomManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\.bb\\personal-workspaces\\env_abc",
      }),
    ).toBe(true);
    expect(
      isRoomManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\code\\repo",
      }),
    ).toBe(false);
  });
});
