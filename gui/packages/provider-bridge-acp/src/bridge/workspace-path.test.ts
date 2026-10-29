import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPathInsideRoots } from "./workspace-path.js";

let baseDir: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "bb-acp-workspace-path-"));
  workspace = join(baseDir, "workspace");
  outside = join(baseDir, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret\n");
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("isPathInsideRoots", () => {
  it("allows existing and new files inside the workspace", async () => {
    writeFileSync(join(workspace, "existing.txt"), "x");
    expect(
      await isPathInsideRoots(join(workspace, "existing.txt"), [workspace]),
    ).toBe(true);
    expect(
      await isPathInsideRoots(join(workspace, "new/dir/file.txt"), [workspace]),
    ).toBe(true);
  });

  it("denies plain paths outside the workspace", async () => {
    expect(
      await isPathInsideRoots(join(outside, "secret.txt"), [workspace]),
    ).toBe(false);
    expect(
      await isPathInsideRoots(join(workspace, "../outside/new.txt"), [
        workspace,
      ]),
    ).toBe(false);
  });

  it("denies a file symlink that points outside", async () => {
    symlinkSync(join(outside, "secret.txt"), join(workspace, "notes.md"));
    expect(
      await isPathInsideRoots(join(workspace, "notes.md"), [workspace]),
    ).toBe(false);
  });

  it("denies new files under a directory symlink that points outside", async () => {
    symlinkSync(outside, join(workspace, "linked"), "dir");
    expect(
      await isPathInsideRoots(join(workspace, "linked/new.txt"), [workspace]),
    ).toBe(false);
  });

  it("denies dangling symlinks that point outside", async () => {
    symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling.md"));
    symlinkSync(
      join(outside, "missing-dir"),
      join(workspace, "dangling-dir"),
      "dir",
    );
    expect(
      await isPathInsideRoots(join(workspace, "dangling.md"), [workspace]),
    ).toBe(false);
    expect(
      await isPathInsideRoots(join(workspace, "dangling-dir/new.txt"), [
        workspace,
      ]),
    ).toBe(false);
  });

  it("allows symlinks that stay inside the workspace", async () => {
    writeFileSync(join(workspace, "real.txt"), "x");
    symlinkSync(join(workspace, "real.txt"), join(workspace, "alias.txt"));
    expect(
      await isPathInsideRoots(join(workspace, "alias.txt"), [workspace]),
    ).toBe(true);
  });

  it("allows writes when the workspace is opened through a symlink", async () => {
    const linkedWorkspace = join(baseDir, "linked-workspace");
    symlinkSync(workspace, linkedWorkspace, "dir");
    expect(
      await isPathInsideRoots(join(linkedWorkspace, "file.txt"), [
        linkedWorkspace,
      ]),
    ).toBe(true);
    expect(
      await isPathInsideRoots(join(workspace, "file.txt"), [linkedWorkspace]),
    ).toBe(true);
  });

  it("denies symlink loops", async () => {
    symlinkSync(join(workspace, "loop-b"), join(workspace, "loop-a"));
    symlinkSync(join(workspace, "loop-a"), join(workspace, "loop-b"));
    expect(
      await isPathInsideRoots(join(workspace, "loop-a"), [workspace]),
    ).toBe(false);
  });
});
