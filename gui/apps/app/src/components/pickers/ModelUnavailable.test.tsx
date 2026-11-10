// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderCliStatus } from "@cloudroom/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetProviderCliInstallStoreForTests } from "@/components/provider-cli/provider-cli-install-store";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ModelUnavailable } from "./ModelUnavailable";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    system: { config: vi.fn() },
    hosts: { providerCliStatus: vi.fn(), installProviderCli: vi.fn() },
    providers: { restartModelDiscovery: vi.fn() },
  },
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({ dispatch: () => false }),
}));

function codexStatus(patch: Partial<ProviderCliStatus>): ProviderCliStatus {
  return {
    displayName: "Codex",
    executableName: "codex",
    executablePath: "/Users/me/.local/bin/codex",
    installed: false,
    installSource: "notInstalled",
    currentVersion: null,
    latestVersion: "0.167.0",
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install",
      label: "Install",
      command: "npm install -g @openai/codex@latest",
    },
    needsUpdate: false,
    versionUnsupported: false,
    ...patch,
  };
}

function renderMissingCodex() {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  render(
    <Wrapper>
      <ModelUnavailable
        providerId="codex"
        providerLabel="Codex"
        routing={{ hostId: "host_mac" }}
        error={{ providerId: "codex", code: "missing_executable" }}
        failed
        installUrl="https://developers.openai.com/codex/cli"
      />
    </Wrapper>,
  );
}

describe("ModelUnavailable", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    resetProviderCliInstallStoreForTests();
  });

  it("reinstalls a broken CLI on the routed machine from the picker", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue({
      primaryHostId: "host_mac",
    } as Awaited<ReturnType<typeof sdk.system.config>>);
    vi.mocked(sdk.hosts.providerCliStatus).mockResolvedValue({
      codex: codexStatus({}),
    });
    vi.mocked(sdk.hosts.installProviderCli).mockResolvedValue([]);
    renderMissingCodex();

    expect(await screen.findByText("Codex install is broken")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reinstall Codex" }));

    expect(sdk.hosts.installProviderCli).toHaveBeenCalledWith({
      hostId: "host_mac",
      provider: "codex",
      actionKind: "install",
    });
  });

  it("offers a plain install when the CLI is not on disk", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue({
      primaryHostId: "host_mac",
    } as Awaited<ReturnType<typeof sdk.system.config>>);
    vi.mocked(sdk.hosts.providerCliStatus).mockResolvedValue({
      codex: codexStatus({ executablePath: null }),
    });
    renderMissingCodex();

    expect(
      await screen.findByRole("button", { name: "Install Codex" }),
    ).toBeTruthy();
    expect(screen.getByText("Not installed")).toBeTruthy();
  });
});
