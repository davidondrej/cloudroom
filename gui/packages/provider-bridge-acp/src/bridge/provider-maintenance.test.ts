import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURSOR_ACP_MAINTENANCE,
  __testing,
  getAcpProviderHealth,
  getAcpProviderInstallationStatus,
} from "./provider-maintenance.js";

function cursorMissingInstallationStatus() {
  return {
    executableName: "cursor-agent",
    executablePath: null,
    installed: false,
    installSource: "notInstalled" as const,
    currentVersion: null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install" as const,
      label: "Install" as const,
      command: "install Cursor",
    },
    needsUpdate: false,
    versionUnsupported: false,
  };
}

describe("ACP provider maintenance", () => {
  it("normalizes Cursor plan and spend limits without reading daemon state", () => {
    expect(
      __testing.normalizeUsage(
        {
          billingCycleEnd: "1767225600000",
          planUsage: { totalPercentUsed: 72.2 },
          spendLimitUsage: {
            overallUsed: "1250",
            overallLimit: "5000",
          },
        },
        { planInfo: { planName: "Pro" } },
        "cursor@example.com",
      ),
    ).toEqual({
      status: "ok",
      accountEmail: "cursor@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Plan usage",
          usedPercent: 72,
          resetsAt: "2026-01-01T00:00:00.000Z",
        },
        {
          label: "On-demand spend",
          usedPercent: 25,
          resetsAt: "2026-01-01T00:00:00.000Z",
          cost: { usedUsdCents: 1250, limitUsdCents: 5000 },
        },
      ],
    });
  });

  it("offers the installer only through a fresh matching action", () => {
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          installer: CURSOR_ACP_MAINTENANCE.installer,
          command: "cursor-agent",
          action: "install",
        },
      ),
    ).toMatchObject({
      available: true,
      command: { command: "sh" },
      verification: { kind: "installed" },
    });
    expect(
      __testing.buildProviderInstallationRun(
        { ...cursorMissingInstallationStatus(), installAction: null },
        { installer: undefined, command: "opencode", action: "install" },
      ),
    ).toEqual({
      available: false,
      message:
        "opencode install is not available on this host: opencode is not installed. Cloudroom has no install or update to run.",
    });
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          installer: undefined,
          command: "opencode",
          action: "install",
        },
      ),
    ).toEqual({
      available: false,
      message:
        "opencode install is not available on this host: opencode is not installed. Cloudroom has no install or update to run.",
    });
  });

  // #1156: legacy Kilo 0.x has no `kilo acp` and exits with a piped-input error.
  it.skipIf(process.platform === "win32").each([
    { version: "0.26.1", unsupported: true, health: "unsupported_version" },
    { version: "7.8.27", unsupported: false, health: "ready" },
    { version: "unparseable", unsupported: false, health: "ready" },
  ])(
    "gates a CLI below its minimum version ($version)",
    async ({ version, unsupported, health }) => {
      const dir = await mkdtemp(path.join(tmpdir(), "bb-acp-kilo-"));
      try {
        const command = path.join(dir, "kilo");
        await writeFile(command, `#!/bin/sh\necho "${version}"\n`);
        await chmod(command, 0o755);
        const target = {
          maintenance: undefined,
          installer: () => ({
            command: "sh",
            args: [],
            displayCommand: "install kilo",
          }),
          command,
          minimumVersion: "1.0.0",
        };
        expect(await getAcpProviderHealth(target)).toMatchObject({
          health: { status: health, minimumSupportedVersion: "1.0.0" },
        });
        const status = await getAcpProviderInstallationStatus(target);
        expect(status).toMatchObject({
          versionUnsupported: unsupported,
          installAction: unsupported ? { kind: "update" } : null,
        });
        expect(
          __testing.buildProviderInstallationRun(status, {
            ...target,
            action: "update",
          }),
        ).toMatchObject(
          unsupported
            ? {
                available: true,
                verification: { kind: "version_at_least", version: "1.0.0" },
              }
            : { available: false },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "checks Hermes without running its update-checking --version",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "bb-acp-hermes-"));
      try {
        const command = path.join(dir, "hermes");
        await writeFile(
          command,
          `#!/bin/sh\ntouch "${dir}/ran"\necho "Hermes Agent v1.0.0"\n`,
        );
        await chmod(command, 0o755);
        const target = {
          maintenance: undefined,
          installer: undefined,
          command,
        };
        expect(await getAcpProviderHealth(target)).toMatchObject({
          health: { status: "ready", installedVersion: null },
        });
        expect(await getAcpProviderInstallationStatus(target)).toMatchObject({
          installed: true,
          currentVersion: null,
        });
        expect(existsSync(path.join(dir, "ran"))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
