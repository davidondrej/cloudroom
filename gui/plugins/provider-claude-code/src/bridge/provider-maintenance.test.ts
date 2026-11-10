import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { __testing, getClaudeProviderHealth } from "./provider-maintenance.js";
import { resolveClaudeCodeExecutable } from "./session-options.js";

function missingInstallationStatus() {
  return {
    executableName: "claude",
    executablePath: null,
    installed: false,
    installSource: "notInstalled" as const,
    currentVersion: null,
    latestVersion: "2.1.0",
    minimumSupportedVersion: null,
    npmPackageName: "@anthropic-ai/claude-code",
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install" as const,
      label: "Install" as const,
      command: "install Claude Code",
    },
    needsUpdate: false,
    versionUnsupported: false,
  };
}

describe("Claude Code provider maintenance", () => {
  it("normalizes aggregate and unique model-scoped usage windows", () => {
    const credentials = {
      accessToken: "token",
      expiresAt: null,
      subscriptionType: "pro",
      rateLimitTier: "max_5x",
    };
    expect(
      __testing.normalizeUsage(
        {
          five_hour: { utilization: 12.4, resets_at: "2026-01-02T03:04:05Z" },
          seven_day: { utilization: 55, resets_at: null },
          limits: [
            {
              kind: "weekly_scoped",
              scope: { model: { display_name: "Sonnet" } },
              percent: 30,
              resets_at: "2026-01-03T00:00:00Z",
            },
            {
              kind: "weekly_scoped",
              scope: { model: { display_name: "sonnet" } },
              percent: 80,
              resets_at: null,
            },
          ],
        },
        credentials,
        "claude@example.com",
      ),
    ).toMatchObject({
      status: "ok",
      accountEmail: "claude@example.com",
      planLabel: "Max (5x)",
      windows: [
        { label: "Current session", usedPercent: 12 },
        { label: "Weekly limit", usedPercent: 55 },
        { label: "Sonnet", usedPercent: 30 },
      ],
    });
  });

  it("keeps the native installer plan private behind the run method", () => {
    const run = __testing.buildProviderInstallationRun(
      missingInstallationStatus(),
      "install",
    );
    expect(run).toMatchObject({
      available: true,
      command: { command: "sh" },
      verification: { kind: "installed" },
    });
    expect(run.available && run.command.args).toHaveLength(2);
    expect(run.available && run.command.args[1]).toContain(
      "https://claude.ai/install.sh",
    );
  });

  it("reports npm's unfinished placeholder as not installed (#1148)", async () => {
    const stub = join(mkdtempSync(join(tmpdir(), "claude-stub-")), "claude");
    writeFileSync(
      stub,
      'echo "Error: claude native binary not installed." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    vi.stubEnv("BB_CLAUDE_CODE_EXECUTABLE", stub);
    try {
      expect(await getClaudeProviderHealth()).toMatchObject({
        health: { status: "not_installed" },
      });
      // An explicit override can't fall back, so the start names the variable.
      expect(() => resolveClaudeCodeExecutable({ env: process.env })).toThrow(
        "BB_CLAUDE_CODE_EXECUTABLE points to npm's unfinished Claude Code placeholder",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
