import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { codexGuardConfig } from "../../../../../core/src/runtime/command-guard.mjs";
import { commandGuardBlockReason, prepareCodexGuard } from "./command-guard.js";

const fixture = { directory: "" };

beforeAll(() => {
  // Exercise quoting for spaces, apostrophes and shell metacharacters in the path.
  fixture.directory = mkdtempSync(join(tmpdir(), "cloudroom guard ' & $ "));
});

afterAll(() => {
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe("Codex Command Guard", () => {
  it("trusts the hook at Codex's platform-specific session config path", () => {
    const config = prepareCodexGuard(fixture.directory);
    const group = config["hooks.PreToolUse"][0]!;
    expect(group.matcher).toBe("Bash");
    const identity = {
      event_name: "pre_tool_use",
      hooks: group.hooks,
      matcher: group.matcher,
    };
    const hash =
      "sha256:" +
      createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const path =
      process.platform === "win32"
        ? String.raw`C:\<session-flags>\config.toml`
        : "/<session-flags>/config.toml";
    expect(config["hooks.state"]).toEqual({
      [`${path}:pre_tool_use:0:0`]: { enabled: true, trusted_hash: hash },
    });
  });

  const shells =
    process.platform === "win32"
      ? [
          "powershell.exe",
          ...(spawnSync("pwsh.exe", ["--version"]).status === 0
            ? ["pwsh.exe"]
            : []),
        ]
      : ["/bin/sh"];

  it.skipIf(process.platform !== "win32")(
    "keeps Codex's fixed trust root when the app-server cwd is on another drive",
    () => {
      const cwd = vi
        .spyOn(process, "cwd")
        .mockReturnValue(String.raw`X:\workspace`);
      try {
        expect(Object.keys(codexGuardConfig("guard")["hooks.state"])).toEqual([
          String.raw`C:\<session-flags>\config.toml:pre_tool_use:0:0`,
        ]);
      } finally {
        cwd.mockRestore();
      }
    },
  );

  it.each(shells)(
    "runs the hook and denies a guarded command through %s",
    (shell) => {
      const command = prepareCodexGuard(fixture.directory)[
        "hooks.PreToolUse"
      ][0]!.hooks[0]!.command;
      const args =
        process.platform === "win32"
          ? [
              "-NoProfile",
              "-Command",
              command + "; if ($env:ELECTRON_RUN_AS_NODE -ne '1') { exit 99 }",
            ]
          : ["-c", command];
      const result = spawnSync(shell, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "0" },
        encoding: "utf8",
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "gh repo delete guard-test" },
        }),
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(
            "Blocked by Cloudroom Command Guard: deleting a hosted repository.",
          ),
        },
      });
    },
  );

  it.each(shells)("allows a safe command through %s", (shell) => {
    const command = prepareCodexGuard(fixture.directory)["hooks.PreToolUse"][0]!
      .hooks[0]!.command;
    const args =
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-Command",
            command + "; if ($env:ELECTRON_RUN_AS_NODE -ne '1') { exit 99 }",
          ]
        : ["-c", command];
    const result = spawnSync(shell, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "0" },
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("writes the guard again after the OS removed its folder", () => {
    const config = prepareCodexGuard(fixture.directory);
    rmSync(fixture.directory, { recursive: true, force: true });
    expect(prepareCodexGuard(fixture.directory)).toBe(config);
    expect(
      readFileSync(
        join(fixture.directory, "cloudroom-command-guard.mjs"),
        "utf8",
      ),
    ).toContain("inspectCloudroomCommand");
  });

  it.skipIf(process.platform !== "win32").each(shells)(
    "leaves guard crashes visible through %s without emitting a deny",
    (shell) => {
      const command = prepareCodexGuard(fixture.directory)[
        "hooks.PreToolUse"
      ][0]!.hooks[0]!.command;
      const path = join(fixture.directory, "cloudroom-command-guard.mjs");
      const source = readFileSync(path, "utf8");
      try {
        for (const crash of [
          'throw new Error("simulated guard crash");\n',
          "process.exit(2);\n",
        ]) {
          writeFileSync(path, crash);
          const result = spawnSync(shell, ["-NoProfile", "-Command", command], {
            encoding: "utf8",
            input: JSON.stringify({
              tool_name: "Bash",
              tool_input: { command: "git status" },
            }),
            timeout: 10_000,
          });
          expect(result.error).toBeUndefined();
          // PowerShell maps native failures to 1; Codex reports them without blocking.
          expect(result.status).toBe(1);
          if (crash.startsWith("throw")) {
            expect(result.stderr).toContain("simulated guard crash");
          }
          expect(result.stdout).toBe("");
        }
      } finally {
        writeFileSync(path, source);
      }
    },
  );

  it("does not turn a failed hook into a command block", () => {
    expect(
      commandGuardBlockReason({
        run: {
          status: "failed",
          entries: [
            {
              text: "Blocked by Cloudroom Command Guard: simulated guard crash",
            },
          ],
        },
      }),
    ).toBeNull();
  });
});
