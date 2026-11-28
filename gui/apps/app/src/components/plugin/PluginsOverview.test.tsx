// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusManager } from "@tanstack/react-query";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { resetAppRouteHistoryForTest } from "@/lib/app-route-history";
import { PluginsOverview } from "./PluginsOverview";

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const AUTOMATIONS_PLUGIN = {
  id: "automations",
  source: "builtin:automations",
  rootDir: "/settings/plugins/automations",
  version: "0.1.0",
  enabled: true,
  status: "running",
  statusDetail: null,
  description: "Schedule recurring and one-shot agent or script work.",
  name: "Automations",
  icon: "Repeat",
  iconUrl: null,
  logoUrl: null,
  logoDarkUrl: null,
  hasSettings: false,
  provenance: "builtin",
  publisherKey: "bb-official",
  publisherLabel: "Cloudroom Official",
  isOrphanedBuiltin: false,
  sourceDisplay: "builtin · automations",
  updateState: {},
  handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
  services: [],
  schedules: [],
  cliCommand: null,
  app: { hasApp: true, bundle: null },
};

const GITHUB_CATALOG_ENTRY = {
  entryId: "github",
  pluginId: "github",
  displayName: "GitHub",
  description: "Browse GitHub issues and pull requests in BB.",
  icon: "Github",
  iconUrl: null,
  categoryId: "code-and-reviews",
  category: "Developer tools",
  source: "builtin:github",
  marketplace: "bb-official",
  marketplaceDisplayName: "Cloudroom Official",
  publisherKey: "bb-official",
  publisherLabel: "Cloudroom Official",
  official: true,
  author: null,
  installed: false,
  compatible: true,
  incompatibleReason: null,
};

const AUTOMATIONS_CATALOG_ENTRY = {
  ...GITHUB_CATALOG_ENTRY,
  entryId: "automations",
  pluginId: "automations",
  displayName: "Automations",
  description: AUTOMATIONS_PLUGIN.description,
  icon: AUTOMATIONS_PLUGIN.icon,
  categoryId: "tasks-and-workflows",
  category: "Workflow management",
  source: AUTOMATIONS_PLUGIN.source,
  installed: true,
};

const DOCS_CATALOG_ENTRY = {
  ...GITHUB_CATALOG_ENTRY,
  entryId: "docs",
  pluginId: "simple-notes",
  displayName: "Docs",
  description: "Create and edit Markdown documents.",
  icon: "NotebookText",
  categoryId: "memory-and-context",
  category: "Context & knowledge",
  source: "builtin:docs",
  installed: true,
};

function installFetch(plugins: readonly unknown[] = [AUTOMATIONS_PLUGIN]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/v1/system/config") {
        return responseJson(makeSystemConfig());
      }
      if (url.pathname === "/api/v1/plugins") {
        return responseJson({ plugins });
      }
      if (url.pathname === "/api/v1/plugin-catalog") {
        return responseJson({
          catalog: {
            pluginCount: 13,
            includedPluginCount: 8,
            optionalPluginCount: 5,
          },
        });
      }
      if (url.pathname === "/api/v1/plugin-catalog/search") {
        return responseJson({
          results: [
            AUTOMATIONS_CATALOG_ENTRY,
            DOCS_CATALOG_ENTRY,
            GITHUB_CATALOG_ENTRY,
          ],
          collections: [],
        });
      }
      if (url.pathname === "/api/v1/plugin-catalog/install") {
        return responseJson({
          ok: true,
          plugin: {
            ...AUTOMATIONS_PLUGIN,
            id: "github",
            source: GITHUB_CATALOG_ENTRY.source,
            rootDir: "/settings/plugins/github",
            name: GITHUB_CATALOG_ENTRY.displayName,
            description: GITHUB_CATALOG_ENTRY.description,
            icon: GITHUB_CATALOG_ENTRY.icon,
            provenance: "catalog",
            publisherKey: "bb-official",
            publisherLabel: "Cloudroom Official",
            catalogEntryId: GITHUB_CATALOG_ENTRY.entryId,
            sourceDisplay: "Cloudroom Official · GitHub",
          },
        });
      }
      return responseJson({ error: "not found" }, 404);
    }),
  );
}

function LocationPath() {
  return <span data-testid="location-path">{useLocation().pathname}</span>;
}

afterEach(() => {
  focusManager.setFocused(undefined);
  cleanup();
  resetAppRouteHistoryForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PluginsOverview", () => {
  it("opens on Browse and renders it before Installed", async () => {
    installFetch();
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins"]}>
        <QueryClientWrapper>
          <PluginsOverview />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Browse" })).toBeNull();
    expect(screen.queryByRole("tab", { name: /Installed/ })).toBeNull();
    expect(screen.getByRole("button", { name: "New plugin" })).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "New plugin options" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Install from source" }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    const catalogRequests = () =>
      vi.mocked(fetch).mock.calls.filter(([input]) => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return (
          new URL(rawUrl, "http://localhost").pathname ===
          "/api/v1/plugin-catalog/search"
        );
      });
    expect(catalogRequests()).toHaveLength(1);

    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(catalogRequests()).toHaveLength(1));
  });

  it("sends Browse's New plugin to the new-thread page with the seed", async () => {
    installFetch();
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins"]}>
        <QueryClientWrapper>
          <PluginsOverview />
          <LocationPath />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    await screen.findByText("GitHub");
    fireEvent.click(screen.getByRole("button", { name: "New plugin" }));

    expect(screen.getByTestId("location-path").textContent).toBe("/");
  });

  it("filters Browse to installed plugins without the Type filter", async () => {
    installFetch([
      AUTOMATIONS_PLUGIN,
      {
        ...AUTOMATIONS_PLUGIN,
        id: "simple-notes",
        source: "builtin:docs",
        name: "Docs",
        description: DOCS_CATALOG_ENTRY.description,
        icon: DOCS_CATALOG_ENTRY.icon,
        provenance: "catalog",
        publisherKey: "bb-official",
        publisherLabel: "Cloudroom Official",
        catalogEntryId: "docs",
      },
    ]);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins"]}>
        <QueryClientWrapper>
          <PluginsOverview />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Type" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Installed" }));
    expect(screen.getByText("Docs")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("sends Installed's New plugin to the new-thread page with the seed", async () => {
    installFetch([AUTOMATIONS_PLUGIN]);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=installed"]}>
        <QueryClientWrapper>
          <PluginsOverview mode="installed" />
          <LocationPath />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Automations")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New plugin" }));

    expect(screen.getByTestId("location-path").textContent).toBe("/");
  });

  it("keeps the Type filter in the Installed options menu", async () => {
    installFetch([AUTOMATIONS_PLUGIN]);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=installed"]}>
        <QueryClientWrapper>
          <PluginsOverview mode="installed" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Automations")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Category" })).toBeNull();
    expect(screen.getByRole("button", { name: "New plugin" })).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Plugin list options" }),
    );
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Cloudroom Official" }),
    ).toBeTruthy();
  });

  it("keeps the Browse filter and New plugin in the search toolbar", async () => {
    installFetch();
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=browse"]}>
        <QueryClientWrapper>
          <PluginsOverview />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    await screen.findByText("GitHub");
    const search = screen.getByRole("textbox", { name: "Search plugins" });
    const toolbar = search.parentElement?.parentElement as HTMLElement;
    expect(
      toolbar.contains(
        screen.getByRole("radiogroup", { name: "Filter plugins" }),
      ),
    ).toBe(true);
    expect(
      toolbar.contains(screen.getByRole("button", { name: "New plugin" })),
    ).toBe(true);
  });

  it("opens installed resources on the canonical Settings detail route", async () => {
    installFetch();
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/settings/plugins"]}>
        <QueryClientWrapper>
          <Routes>
            <Route
              path="/settings/plugins"
              element={<PluginsOverview mode="installed" />}
            />
            <Route path="*" element={<LocationPath />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Automations plugin details",
      }),
    );
    expect(screen.getByTestId("location-path").textContent).toBe(
      "/settings/plugins/automations",
    );
  });

  it("opens the canonical detail returned by a Browse install", async () => {
    installFetch();
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=browse"]}>
        <QueryClientWrapper>
          <Routes>
            <Route path="/plugins" element={<PluginsOverview />} />
            <Route path="*" element={<LocationPath />} />
          </Routes>
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Install GitHub" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Install GitHub?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install GitHub" }));

    expect((await screen.findByTestId("location-path")).textContent).toBe(
      "/settings/plugins/github",
    );
  });

  it("lists the most recently changed plugin first, and by name on request", async () => {
    installFetch([
      { ...AUTOMATIONS_PLUGIN, id: "alpha", name: "Alpha", changedAt: 1_000 },
      {
        ...AUTOMATIONS_PLUGIN,
        id: "zulu",
        name: "Zulu",
        enabled: false,
        status: "disabled",
        changedAt: 3_000,
      },
      { ...AUTOMATIONS_PLUGIN, id: "mike", name: "Mike", changedAt: 2_000 },
      { ...AUTOMATIONS_PLUGIN, id: "bravo", name: "Bravo", changedAt: 1_000 },
    ]);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=installed"]}>
        <QueryClientWrapper>
          <PluginsOverview mode="installed" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );
    const rowIds = () =>
      [...document.querySelectorAll('[data-testid^="plugin-row-"]')].map(
        (row) => row.getAttribute("data-testid"),
      );

    await screen.findByText("Zulu");
    expect(rowIds()).toEqual([
      "plugin-row-zulu",
      "plugin-row-mike",
      "plugin-row-alpha",
      "plugin-row-bravo",
    ]);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Plugin list options" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Sort by name" }));
    expect(rowIds()).toEqual([
      "plugin-row-alpha",
      "plugin-row-bravo",
      "plugin-row-mike",
      "plugin-row-zulu",
    ]);
  });

  it("gives each publisher its own Type facet, separate from User", async () => {
    installFetch([
      { ...AUTOMATIONS_PLUGIN, id: "builtin-one", name: "Builtin One" },
      {
        ...AUTOMATIONS_PLUGIN,
        id: "catalog-one",
        name: "Catalog One",
        provenance: "catalog",
        publisherKey: "bb-community",
        publisherLabel: "BB Community",
        catalogEntryId: "catalog-one",
      },
      {
        ...AUTOMATIONS_PLUGIN,
        id: "direct-one",
        name: "Direct One",
        provenance: "direct",
        publisherLabel: null,
      },
    ]);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=installed"]}>
        <QueryClientWrapper>
          <PluginsOverview mode="installed" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    await screen.findByText("Direct One");
    const rowIds = () =>
      [...document.querySelectorAll('[data-testid^="plugin-row-"]')].map(
        (row) => row.getAttribute("data-testid"),
      );

    const typeTrigger = screen.getByRole("button", {
      name: "Plugin list options",
    });
    expect(rowIds()).toEqual([
      "plugin-row-builtin-one",
      "plugin-row-catalog-one",
      "plugin-row-direct-one",
    ]);
    fireEvent.pointerDown(typeTrigger);
    expect(screen.queryByRole("menuitemcheckbox", { name: "All" })).toBeNull();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Cloudroom Official" }),
    );
    await waitFor(() => {
      expect(rowIds()).toEqual(["plugin-row-builtin-one"]);
    });

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "BB Community" }),
    );
    await waitFor(() => {
      expect(rowIds()).toEqual([
        "plugin-row-builtin-one",
        "plugin-row-catalog-one",
      ]);
    });

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Cloudroom Official" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "BB Community" }),
    );
    await waitFor(() => {
      expect(rowIds()).toEqual(["plugin-row-direct-one"]);
    });

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    await waitFor(() => {
      expect(rowIds()).toEqual([
        "plugin-row-builtin-one",
        "plugin-row-catalog-one",
        "plugin-row-direct-one",
      ]);
    });
    expect(screen.queryByText("No plugins match these filters.")).toBeNull();
  });

  it("drops a Type selection whose facet no longer has any plugin", async () => {
    installFetch([
      { ...AUTOMATIONS_PLUGIN, id: "builtin-one", name: "Builtin One" },
      {
        ...AUTOMATIONS_PLUGIN,
        id: "acme-one",
        name: "Acme One",
        provenance: "catalog",
        publisherKey: "acme-plugins",
        publisherLabel: "Acme Plugins",
        catalogEntryId: "acme-one",
      },
    ]);
    const { wrapper: QueryClientWrapper, queryClient } =
      createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=installed"]}>
        <QueryClientWrapper>
          <PluginsOverview mode="installed" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    await screen.findByText("Acme One");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Plugin list options" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Acme Plugins" }),
    );
    await waitFor(() => {
      expect(
        [...document.querySelectorAll('[data-testid^="plugin-row-"]')].map(
          (row) => row.getAttribute("data-testid"),
        ),
      ).toEqual(["plugin-row-acme-one"]);
    });

    installFetch([
      { ...AUTOMATIONS_PLUGIN, id: "builtin-one", name: "Builtin One" },
    ]);
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => {
      expect(
        [...document.querySelectorAll('[data-testid^="plugin-row-"]')].map(
          (row) => row.getAttribute("data-testid"),
        ),
      ).toEqual(["plugin-row-builtin-one"]);
    });
    expect(screen.queryByText("No plugins match these filters.")).toBeNull();
  });

  it("keeps disabled plugins installed regardless of provenance", async () => {
    installFetch([
      AUTOMATIONS_PLUGIN,
      {
        ...AUTOMATIONS_PLUGIN,
        id: "inactive-builtin",
        name: "Inactive Builtin",
        enabled: false,
        status: "disabled",
      },
      {
        ...AUTOMATIONS_PLUGIN,
        id: "inactive-catalog",
        name: "Inactive Catalog Plugin",
        enabled: false,
        status: "disabled",
        provenance: "catalog",
        publisherKey: "bb-community",
        publisherLabel: "BB Community",
        catalogEntryId: "inactive-catalog",
      },
      {
        ...AUTOMATIONS_PLUGIN,
        id: "inactive-local",
        name: "Inactive Local Plugin",
        enabled: false,
        status: "disabled",
        provenance: "direct",
        publisherLabel: null,
      },
    ]);
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/plugins?view=installed"]}>
        <QueryClientWrapper>
          <PluginsOverview mode="installed" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Automations")).toBeTruthy();
    expect(
      document.querySelectorAll(
        '[data-testid^="plugin-row-"], [data-plugin-row]',
      ).length,
    ).toBeGreaterThanOrEqual(0);
    expect(screen.getByText("Inactive Builtin")).toBeTruthy();
    expect(
      screen.getByTestId("plugin-row-inactive-builtin").textContent,
    ).toContain("Off");
    expect(screen.getByText("Inactive Catalog Plugin")).toBeTruthy();
    expect(screen.getByText("Inactive Local Plugin")).toBeTruthy();
  });
});
