// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import * as nativeShell from "@/lib/native-shell";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_SECTIONS,
} from "./settings-sections";
import { SettingsSidebarContent } from "./SettingsSidebar";

const pluginEntries = [
  "bb-guide",
  "connect",
  "custom-instructions",
  "keep-awake",
  "linear",
  "provider-acp",
  "provider-claude-code",
  "provider-codex",
  "provider-retry",
  "provider-usage",
  "push-notifications",
].map((id) => ({ id, label: id, icon: null }));

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderSidebar(
  navigation: Partial<
    ComponentProps<typeof SettingsSidebarContent>["navigation"]
  > = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SidebarProvider>
          <SettingsSidebarContent
            appRoutePath="/"
            isResizing={false}
            mobileHosted
            navigation={{
              activePluginId: null,
              activeSection: "general",
              pluginEntries,
              sections: SETTINGS_NAV_SECTIONS,
              ...navigation,
            }}
            onResizeMouseDown={() => {}}
          />
          <LocationProbe />
        </SidebarProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowLabels = () =>
  screen
    .getAllByRole("link")
    .map((link) => link.textContent)
    .filter((label) => label !== "Back to app");

const resultLabels = () =>
  screen.queryAllByRole("option").map((option) => option.textContent);

const currentRow = () =>
  screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsSidebarContent navigation", () => {
  it("shows one flat row per group", () => {
    renderSidebar();
    expect(rowLabels()).toEqual([
      "Account",
      "General",
      "Agents",
      "Instructions",
      "Cloud",
      "Machines",
      "Projects",
      "Appearance",
      "Keyboard",
      "Plugins",
      "Updates",
    ]);
    expect(
      screen.getByRole("link", { name: "Instructions" }).getAttribute("href"),
    ).toBe("/settings/plugins/custom-instructions");
  });

  it("puts every built-in settings page in exactly one group", () => {
    for (const section of SETTINGS_NAV_SECTIONS) {
      const owners = SETTINGS_NAV_GROUPS.filter((group) =>
        group.members.some(
          (member) => member.kind === "section" && member.id === section.id,
        ),
      );
      expect(owners, section.id).toHaveLength(1);
    }
  });

  it("highlights the row that owns the open page", () => {
    renderSidebar({ activeSection: "browser" });
    expect(currentRow()).toEqual(["General"]);
    cleanup();
    renderSidebar({ activeSection: null, activePluginId: "provider-codex" });
    expect(currentRow()).toEqual(["Agents"]);
    cleanup();
    renderSidebar({ activeSection: "command-guard" });
    expect(currentRow()).toEqual(["Agents"]);
    cleanup();
    renderSidebar({ activeSection: "experiments" });
    expect(currentRow()).toEqual(["Updates"]);
  });

  it("files plugins without a group under Plugins", () => {
    renderSidebar({ activeSection: null, activePluginId: "linear" });
    expect(currentRow()).toEqual(["Plugins"]);
  });

  it("links a row to its first available page", () => {
    renderSidebar({
      pluginEntries: pluginEntries.filter(
        ({ id }) => id !== "custom-instructions",
      ),
      sections: SETTINGS_NAV_SECTIONS.filter(({ id }) => id !== "files"),
    });
    expect(
      screen.getByRole("link", { name: "Instructions" }).getAttribute("href"),
    ).toBe("/settings/system-prompt");
  });

  it("finds individual settings with typos and synonyms, and Enter opens the top one", () => {
    renderSidebar();
    const search = screen.getByRole("combobox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "thme" } });
    expect(resultLabels()[0]).toBe("ThemeAppearance");
    fireEvent.change(search, { target: { value: "how to disable telemetry" } });
    expect(resultLabels()).toEqual([
      "Share usage data and setup errorsGeneral › Privacy & diagnostics",
    ]);
    fireEvent.change(search, { target: { value: "archived" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe(
      "/settings/archived",
    );
    expect((search as HTMLInputElement).value).toBe("");
    fireEvent.change(search, { target: { value: "font size" } });
    expect(resultLabels()).toEqual([]);
    expect(screen.getByText("No settings match.")).toBeTruthy();
  });

  it("moves the selected result with the arrow keys", () => {
    renderSidebar();
    const search = screen.getByRole("combobox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "theme" } });
    const [first, second] = screen.getAllByRole("option");
    expect(search.getAttribute("aria-activedescendant")).toBe(first!.id);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(second!.id);
    expect(second!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(search.getAttribute("aria-activedescendant")).toBe(second!.id);
  });

  it("keeps native device settings reachable", () => {
    vi.spyOn(nativeShell, "canOpenNativeScreen").mockReturnValue(true);
    const openNative = vi
      .spyOn(nativeShell, "shellOpenNative")
      .mockReturnValue(true);
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "This device" }));
    expect(openNative).toHaveBeenCalledWith("device-settings");
  });
});
