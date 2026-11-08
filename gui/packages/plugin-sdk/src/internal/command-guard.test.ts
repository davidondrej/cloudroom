import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareCodexGuard } from "./command-guard.js";

const fixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: () => fixture.directory,
}));

beforeAll(async () => {
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  // Exercise quoting for spaces, apostrophes and shell metacharacters in TEMP.
  fixture.directory = mkdtempSync(join(tmpdir(), "cloudroom guard ' & $ "));
});

afterAll(() => {
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe("Codex Command Guard", () => {
  it("trusts the hook at Codex's platform-specific session config path", () => {
    const config = prepareCodexGuard();
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

  it.each(shells)(
    "runs the hook and denies a guarded command through %s",
    (shell) => {
      const command =
        prepareCodexGuard()["hooks.PreToolUse"][0]!.hooks[0]!.command;
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
    const command =
      prepareCodexGuard()["hooks.PreToolUse"][0]!.hooks[0]!.command;
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
});
