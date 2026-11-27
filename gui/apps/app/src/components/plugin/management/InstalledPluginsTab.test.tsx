// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import { InstalledPluginRow } from "./InstalledPluginsTab";
import { makePluginListItem } from "@/test/fixtures/plugins";

function plugin(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return makePluginListItem({
    id: "notify",
    source: "path:/tmp/bb-plugin-notify",
    rootDir: "/tmp/bb-plugin-notify",
    version: "0.2.1",
    description: "Desktop notifications when a thread needs you.",
    name: "Notify",
    sourceDisplay: "path · /tmp/bb-plugin-notify",
    ...overrides,
  });
}

function renderRow(item: PluginListItem) {
  return render(
    <InstalledPluginRow plugin={item} selected={false} onOpen={vi.fn()} />,
  );
}

afterEach(() => {
  cleanup();
});

describe("InstalledPluginRow", () => {
  it("shows the status word when a plugin is not running", () => {
    renderRow(plugin({ status: "incompatible" }));

    expect(screen.getByTestId("plugin-runtime-status-notify").textContent).toBe(
      "Incompatible",
    );
  });

  it("marks a disabled plugin Off instead of showing a status", () => {
    renderRow(plugin({ enabled: false, status: "disabled" }));

    expect(screen.getByTestId("plugin-row-notify").textContent).toBe(
      "NotifyOff",
    );
  });
});
