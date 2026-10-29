// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type {
  PluginCatalogSearchData,
  PluginCatalogSearchEntry,
} from "@/hooks/queries/plugin-catalog-queries";
import type { InstalledPlugin } from "@cloudroom/server-contract";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import type { AddPluginInitial } from "./AddPluginDialog";
import { BrowsePluginsTab } from "./BrowsePluginsTab";

const MEMORY_ENTRY: PluginCatalogSearchEntry = {
  entryId: "memory",
  pluginId: "memory",
  displayName: "Memory",
  description: "Durable memory for agents.",
  icon: "Brain",
  iconUrl: null,
  iconTinted: false,
  categoryId: "memory-and-context",
  category: "Memory & Context",
  screenshots: [],
  collections: [],
  publishedAt: "2026-08-20T00:00:00Z",
  source: "builtin:memory",
  repositoryUrl: null,
  marketplace: "bb-official",
  marketplaceDisplayName: "Cloudroom Official",
  publisherKey: "bb-official",
  publisherLabel: "Cloudroom Official",
  official: true,
  author: {
    name: "BB",
    github: "get-bb",
    url: "https://github.com/get-bb",
  },
  installed: false,
  installs: 4_210,
  compatible: true,
  incompatibleReason: null,
};

const SECURITY_ENTRY: PluginCatalogSearchEntry = {
  ...MEMORY_ENTRY,
  entryId: "security",
  pluginId: "security",
  displayName: "Security",
  description: "Protect agent work.",
  categoryId: "security",
  category: "Security",
  publishedAt: undefined,
  installs: 900,
};

const TASKS_ENTRY: PluginCatalogSearchEntry = {
  ...MEMORY_ENTRY,
  entryId: "tasks",
  pluginId: "tasks",
  displayName: "Tasks",
  description: "Track work.",
  categoryId: "tasks-and-workflows",
  category: "Tasks & Workflows",
  publishedAt: "2026-08-25T00:00:00Z",
  installs: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubApi(
  data: PluginCatalogSearchData,
  plugins: InstalledPlugin[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/plugin-catalog/search")) {
        return jsonResponse({
          results: data.entries,
          collections: data.collections,
        });
      }
      if (url === "/api/v1/plugins") {
        return jsonResponse({ enabled: true, plugins });
      }
      return jsonResponse({ error: "not found" }, 404);
    }),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderBrowse({
  data,
  plugins = [],
  initialEntry = "/plugins",
  selectedPluginId = null,
  onInstall = vi.fn(),
  onOpenPlugin = vi.fn(),
}: {
  data: PluginCatalogSearchData;
  plugins?: InstalledPlugin[];
  initialEntry?: string;
  selectedPluginId?: string | null;
  onInstall?: Mock<(initial: AddPluginInitial) => void>;
  onOpenPlugin?: Mock<(pluginId: string, trigger: HTMLButtonElement) => void>;
}) {
  stubApi(data, plugins);
  const { wrapper } = createQueryClientTestHarness();
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <BrowsePluginsTab
        actions={null}
        selectedPluginId={selectedPluginId}
        onInstall={onInstall}
        onOpenPlugin={onOpenPlugin}
      />
      <LocationProbe />
    </MemoryRouter>,
    { wrapper },
  );
  return { onInstall, onOpenPlugin };
}

function groupLabels(): string[] {
  return screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BrowsePluginsTab", () => {
  it("groups plugins by category with Install or an on/off switch", async () => {
    renderBrowse({
      data: {
        entries: [
          MEMORY_ENTRY,
          { ...SECURITY_ENTRY, installed: true },
          TASKS_ENTRY,
        ],
        collections: [],
      },
      plugins: [makeInstalledPlugin({ id: "security", name: "Security" })],
    });

    expect(
      await screen.findByRole("switch", { name: "Disable Security" }),
    ).toBeTruthy();
    expect(groupLabels()).toEqual([
      "Memory & Context",
      "Security",
      "Tasks & Workflows",
    ]);
    expect(screen.getByRole("button", { name: "Install Memory" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Install Security" }),
    ).toBeNull();
  });

  it("filters by search, Installed, and Updates through the URL", async () => {
    renderBrowse({
      data: {
        entries: [MEMORY_ENTRY, { ...SECURITY_ENTRY, installed: true }],
        collections: [],
      },
      plugins: [
        makeInstalledPlugin({
          id: "security",
          name: "Security",
          updateState: { availableVersion: "2.0.0" },
        }),
        makeInstalledPlugin({ id: "my-tool", name: "My tool" }),
      ],
    });

    await screen.findByRole("switch", { name: "Disable Security" });
    expect(screen.getByRole("radio", { name: "Updates 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Installed" }));
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?view=installed",
    );
    expect(screen.queryByText("Memory")).toBeNull();
    expect(screen.getByText("My tool")).toBeTruthy();
    expect(groupLabels()).toContain("Your plugins");

    fireEvent.click(screen.getByRole("radio", { name: "Updates 1" }));
    expect(screen.queryByText("My tool")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Update to 2.0.0" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "durable" },
    });
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?query=durable",
    );
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.queryByText("Security")).toBeNull();
  });

  it("uses the shared error state and retries the catalog", async () => {
    let searchAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/v1/plugin-catalog/search")) {
          searchAttempts += 1;
          return searchAttempts === 1
            ? jsonResponse({ error: "unavailable" }, 503)
            : jsonResponse({ results: [MEMORY_ENTRY], collections: [] });
        }
        if (url === "/api/v1/plugins") {
          return jsonResponse({ enabled: true, plugins: [] });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <BrowsePluginsTab
          actions={null}
          selectedPluginId={null}
          onInstall={() => undefined}
          onOpenPlugin={() => undefined}
        />
      </MemoryRouter>,
      { wrapper },
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The plugin catalog is not available.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Memory")).toBeTruthy();
    expect(searchAttempts).toBe(2);
  });

  it("installs from the row and opens details from anywhere on it", async () => {
    const { onInstall, onOpenPlugin } = renderBrowse({
      data: { entries: [MEMORY_ENTRY], collections: [] },
      selectedPluginId: "memory",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Install Memory" }),
    );
    expect(onInstall).toHaveBeenCalledWith({
      entryId: "memory",
      pluginId: "memory",
      marketplace: "bb-official",
      publisherLabel: "Cloudroom Official",
      displayName: "Memory",
      icon: "Brain",
      iconUrl: null,
      iconTinted: false,
      source: "builtin:memory",
    });
    expect(onOpenPlugin).not.toHaveBeenCalled();

    const open = screen.getByRole("button", { name: "Open Memory details" });
    expect(open.getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByText("Durable memory for agents."));
    expect(onOpenPlugin).toHaveBeenCalledWith("memory", open);
  });
});
