import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  buildWindowsFileManagerOpenInvocation,
  buildWindowsTerminalOpenInvocation,
} from "../src/windows-open-targets.js";

it.each([
  {
    input: "C:/projects/review notes/draft.md",
    expected: "C:\\projects\\review notes\\draft.md",
  },
  {
    input: "//fileserver/shared/review notes/draft.md",
    expected: "\\\\fileserver\\shared\\review notes\\draft.md",
  },
  {
    input: "C:\\projects/review notes\\draft.md",
    expected: "C:\\projects\\review notes\\draft.md",
  },
  {
    input: "C:\\projects\\it's & notes.md",
    expected: "C:\\projects\\it's & notes.md",
  },
])(
  "passes a native Windows path to Explorer for $input",
  ({ input, expected }) => {
    const invocation = buildWindowsFileManagerOpenInvocation({
      env: undefined,
      existingPath: { path: input, type: "file" },
    });

    expect(invocation.env?.WORKSPACE_OPEN_TARGET_PATH).toBe(expected);
    expect(invocation.args.join(" ")).not.toContain(input);
  },
);

it.runIf(process.platform === "win32")(
  "starts a Windows terminal in a folder whose name has wildcard brackets",
  async () => {
    const root = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), "cr-open-")),
    );
    try {
      const target = path.join(root, "project[1]");
      await mkdir(target);
      await mkdir(path.join(root, "project1"));
      const probe = path.join(root, "cwd.js");
      await writeFile(
        probe,
        `require("fs").writeFileSync(${JSON.stringify(path.join(root, "cwd.txt"))}, process.cwd())`,
      );
      const invocation = buildWindowsTerminalOpenInvocation({
        env: process.env,
        existingPath: { path: target, type: "directory" },
        terminal: "powershell",
      });
      const script = invocation.args[3]?.replace(
        "-FilePath powershell.exe -ArgumentList '-NoExit','-NoLogo'",
        `-Wait -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '"${probe}"'`,
      );
      expect(script).toContain("-Wait");
      await promisify(execFile)(
        invocation.file,
        [...invocation.args.slice(0, 3), script ?? ""],
        { env: invocation.env, windowsHide: true },
      );
      expect(await readFile(path.join(root, "cwd.txt"), "utf8")).toBe(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
