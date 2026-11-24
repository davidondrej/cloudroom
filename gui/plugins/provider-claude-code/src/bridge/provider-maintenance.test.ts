import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
      planLabel: "Max",
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

  it("leaves package-manager installs to their manager (#1898)", async () => {
    // Claude Code 2.1.329's doctor: `Running:` + its own `Package manager:` line.
    const managed = (manager: string) =>
      `Running: package-manager (2.1.329)\nPackage manager: ${manager}`;
    const brewRoot = (withBrew: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "claude-brew-"));
      const claude = join(root, "Caskroom", "claude-code", "2.1.329", "claude");
      mkdirSync(dirname(claude), { recursive: true });
      writeFileSync(claude, "");
      if (withBrew) {
        mkdirSync(join(root, "bin"));
        writeFileSync(join(root, "bin", "brew"), "");
      }
      return claude;
    };
    const links = String.raw`C:\Users\u\AppData\Local\Microsoft\WinGet\Links\claude.exe`;
    const winPackages =
      "C:/Users/u/AppData/Local/microsoft/winget/PACKAGES/Anthropic.ClaudeCode_x/claude.exe";
    const linksBackup = String.raw`C:\Users\u\AppData\Local\Microsoft\WinGet\LinksBackup\claude.cmd`;
    // [name, doctor, path, platform, update offered, too-old blocks (= main)]
    const rows: [
      string,
      string | null,
      string | null,
      NodeJS.Platform,
      string | null,
      boolean,
    ][] = [
      [
        "native",
        "Running: native (2.1.329)",
        "/u/.local/bin/claude",
        "darwin",
        "claude update",
        true,
      ],
      [
        "mise behind a WinGet link",
        managed("mise"),
        links,
        "win32",
        "claude update",
        true,
      ],
      ["winget by doctor", managed("winget"), null, "win32", null, true],
      ["winget by path", null, winPackages, "win32", null, true],
      [
        "not a WinGet folder",
        null,
        linksBackup,
        "win32",
        "claude update",
        true,
      ],
      ["deb", managed("deb"), "/usr/bin/claude", "linux", null, true],
      ["rpm", managed("rpm"), "/usr/bin/claude", "linux", null, true],
      [
        "homebrew",
        managed("homebrew"),
        brewRoot(true),
        "darwin",
        "brew upgrade --cask claude-code",
        true,
      ],
      [
        "homebrew without brew",
        managed("homebrew"),
        brewRoot(false),
        "darwin",
        null,
        true,
      ],
      [
        "`Running: homebrew` without brew",
        "Running: homebrew (2.1.200)",
        brewRoot(false),
        "darwin",
        null,
        false,
      ],
    ];
    for (const [
      name,
      doctor,
      executablePath,
      platform,
      update,
      blocks,
    ] of rows) {
      // Homebrew's real paths use `/`; Windows' realpath gives `\`.
      if (name === "homebrew" && process.platform === "win32") continue;
      const plan = await __testing.claudeUpdatePlan(
        "claude",
        doctor,
        executablePath,
        platform,
      );
      expect.soft(plan.update?.displayCommand ?? null, name).toBe(update);
      expect.soft(plan.blocksTooOld, name).toBe(blocks);
    }
  });

  it("blocks a too-old Claude Code at thread start exactly as main does (#1898)", async () => {
    const windows = process.platform === "win32";
    const rows: [string[], boolean][] = [
      [["Running: package-manager (2.1.200)", "Package manager: winget"], true],
      [["Running: homebrew (2.1.200)"], false],
    ];
    for (const [doctor, blocked] of rows) {
      const dir = mkdtempSync(join(tmpdir(), "claude-stub-"));
      // Windows runs a `.cmd` (its args arrive quoted, hence `%~1`); elsewhere a shell script.
      const stub = join(dir, windows ? "claude.cmd" : "claude");
      const answer = (arg: string, line: string) =>
        windows
          ? `if "%~1"=="${arg}" echo ${line}`
          : `if [ "$1" = ${arg} ]; then echo "${line}"; fi`;
      writeFileSync(
        stub,
        [
          windows ? "@echo off" : "#!/bin/sh",
          answer("--version", "2.1.200 (Claude Code)"),
          ...doctor.map((line) => answer("doctor", line)),
        ].join(windows ? "\r\n" : "\n"),
        { mode: 0o755 },
      );
      vi.stubEnv("BB_CLAUDE_CODE_EXECUTABLE", stub);
      // No npm and no network: no release tags. Windows still needs cmd.exe.
      vi.stubEnv(
        "PATH",
        [
          dir,
          ...(windows
            ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
            : []),
        ].join(delimiter),
      );
      vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
      try {
        expect
          .soft(await __testing.claudeInstallation(), doctor.join(" / "))
          .toMatchObject({
            update: null,
            status: { installAction: null, versionUnsupported: blocked },
          });
      } finally {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      }
    }
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
