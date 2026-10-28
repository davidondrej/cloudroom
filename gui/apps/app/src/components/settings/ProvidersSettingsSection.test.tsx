// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderInfo } from "@cloudroom/domain";
import { defaultAppSettings } from "@cloudroom/domain";
import { makeProviderInfo } from "@cloudroom/test-helpers/domain-fixtures";
import {
  ProviderTurnDisplaySection,
  ProvidersSettingsSection,
  reorderProviderIds,
} from "./ProvidersSettingsSection";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderInfo[],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useHostProviderCliStatus: () => ({ data: undefined }),
  useInstallableProviders: () => ({ data: [] }),
  useSystemConfig: () => ({ data: undefined }),
  useSystemProviderStates: () => ({ data: undefined, refetch: vi.fn() }),
  useSystemProviders: () => ({ data: mocks.providers, isPending: false }),
}));

vi.mock("@/hooks/queries/cloudroom-queries", () => ({
  useCloudroomAccount: () => ({ data: undefined }),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ localDaemonHostId: null }),
}));

function provider(id: string, displayName: string): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsFork: false,
      supportsSessionRewind: false,
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
    },
  });
}

afterEach(cleanup);

function withQueryClient({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );
}

describe("ProvidersSettingsSection", () => {
  it("shows reorder handles and writes the default as a user setting", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      provider("beta", "Beta"),
      provider("gamma", "Gamma"),
    ];
    const onChange = vi.fn();
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={onChange}
      />,
      { wrapper: withQueryClient },
    );

    const providersSection = screen
      .getByRole("heading", { name: "Providers" })
      .closest("section");
    if (providersSection === null) throw new Error("Providers section missing");
    const rows = within(providersSection).getAllByText(/Alpha|Beta|Gamma/);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(screen.getAllByText("Default")).toHaveLength(1);

    const reorderHandles = screen.getAllByRole("button", {
      name: /Reorder (Alpha|Beta|Gamma)/,
    });
    expect(reorderHandles).toHaveLength(3);
    expect(reorderHandles[0]?.parentElement?.className).toContain(
      "group/provider-row",
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Make default" })[1]!,
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultAppSettings,
      defaultProviderId: "gamma",
    });
  });

  it("marks an unavailable provider and blocks it as the default", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      { ...provider("beta", "Beta"), available: false },
    ];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={{ ...defaultAppSettings, defaultProviderId: "alpha" }}
        onGeneralSettingsChange={vi.fn()}
      />,
      { wrapper: withQueryClient },
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Make default",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows each provider's finished turn display and stores only overrides", () => {
    mocks.providers = [
      {
        ...provider("claude-code", "Claude Code"),
        pluginId: "provider-test",
        completedTurnDisplay: "flat",
      },
      { ...provider("codex", "Codex"), pluginId: "provider-test" },
    ];
    const onChange = vi.fn();
    const generalSettings = {
      ...defaultAppSettings,
      providerCompletedTurnDisplay: { codex: "flat" as const },
    };
    const client = new QueryClient();
    client.setQueryData(["cloudroom-account"], { ready: false });
    client.setQueryData(["claude-connection", "local", "primary", null], {
      state: "connected",
      message: null,
      login_id: null,
      verification_url: null,
    });
    render(
      <ProviderTurnDisplaySection
        disabled={false}
        generalSettings={generalSettings}
        onGeneralSettingsChange={onChange}
        pluginId="provider-test"
      />,
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );

    const claudeSwitch = screen.getByRole("switch", {
      name: "Collapse finished Claude Code turns",
    });
    const codexSwitch = screen.getByRole("switch", {
      name: "Collapse finished Codex turns",
    });
    expect(claudeSwitch.getAttribute("aria-checked")).toBe("false");
    expect(codexSwitch.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(claudeSwitch);
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultAppSettings,
      providerCompletedTurnDisplay: {
        codex: "flat",
        "claude-code": "collapse",
      },
    });

    fireEvent.click(codexSwitch);
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultAppSettings,
      providerCompletedTurnDisplay: {},
    });
  });

  it("builds the complete picker order after a drag", () => {
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "alpha"),
    ).toEqual(["gamma", "alpha", "beta"]);
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "gamma"),
    ).toBeNull();
  });
});
