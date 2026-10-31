import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { gitShell } from "@cloudroom/process-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROOM_CLI_CMD,
  ROOM_CLI_HASHBANG,
  ROOM_CLI_PS1,
  // @ts-expect-error -- plain ESM build script
} from "../scripts/bundle-manifest.mjs";

// Git Bash runs the extensionless shim on Windows, and `sh` is on PATH there only with Git's bin
// folder, so ask Git for its shell (`git var GIT_SHELL_PATH`). Without Git, the shim tests skip.
const shell =
  process.platform === "win32"
    ? await gitShell().catch(() => null)
    : { command: "sh", env: process.env };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function fakeProgram(path: string, name: string) {
  writeFileSync(
    path,
    `#!/bin/sh\necho "${name} RUN_AS_NODE=$ELECTRON_RUN_AS_NODE $*"\n`,
  );
  chmodSync(path, 0o755);
}

// The Windows app's layout, as Git Bash sees it: <app>/resources/app.asar.unpacked/.../dist/room-cli.
function runShim(withApp: boolean) {
  const root = mkdtempSync(join(tmpdir(), "room-cli-shim-"));
  roots.push(root);
  const dist = join(
    root,
    "app",
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "bb-app",
    "host-daemon",
    "dist",
  );
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "room-cli"), `${ROOM_CLI_HASHBANG}\n`);
  chmodSync(join(dist, "room-cli"), 0o755);
  if (withApp) fakeProgram(join(root, "app", "Cloudroom.exe"), "app");
  const bin = join(root, "bin");
  mkdirSync(bin);
  fakeProgram(join(bin, "node"), "node");
  if (!shell) throw new Error("no sh");
  return execFileSync(
    shell.command,
    [join(dist, "room-cli"), "thread", "list", "--title", "fix(parser)"],
    {
      encoding: "utf8",
      env: {
        ...shell.env,
        ELECTRON_RUN_AS_NODE: "",
        PATH: `${bin}${delimiter}${shell.env.PATH}`,
      },
    },
  );
}

describe("room-cli launchers", () => {
  it.skipIf(!shell)(
    "runs on the installed Windows app's Cloudroom.exe, not node",
    () => {
      const out = runShim(true);
      expect(out).toMatch(
        /^app RUN_AS_NODE=1 .*room-cli thread list --title fix\(parser\)/,
      );
    },
  );

  it.skipIf(!shell)("falls back to node outside an installed app", () => {
    expect(runShim(false)).toMatch(/^node RUN_AS_NODE= .*room-cli thread list/);
  });

  it("keeps %* out of cmd.exe blocks, so a ')' in an argument can't end one", () => {
    const lines = ROOM_CLI_CMD.split("\r\n");
    expect(lines.filter((line: string) => line.includes("%*"))).toEqual([
      'node "%~dp0room-cli" %*',
      '"%ROOM_CLI_APP%" "%~dp0room-cli" %*',
    ]);
    expect(
      lines.every((line: string) => !line.includes("%*") || !/[()]/.test(line)),
    ).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "passes PowerShell arguments to the CLI verbatim, without cmd.exe",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "room-cli-ps1-"));
      roots.push(dir);
      writeFileSync(join(dir, "room-cli.ps1"), ROOM_CLI_PS1);
      writeFileSync(
        join(dir, "room-cli"),
        'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => console.log(JSON.stringify([JSON.parse(process.env.ROOM_CLI_ARGV), s])))',
      );
      const args = [
        'x "y & echo INJECTED"',
        "",
        "C:\\my dir\\",
        '"quoted words"',
        "50% <x> a|b",
      ];
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `'piped' | & '${join(dir, "room-cli.ps1")}' ${args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}`,
        ],
        { encoding: "utf8" },
      );
      const [argv, stdin] = JSON.parse(out);
      expect(argv).toEqual(args);
      expect(stdin.trimEnd()).toBe("piped");
    },
  );
});
