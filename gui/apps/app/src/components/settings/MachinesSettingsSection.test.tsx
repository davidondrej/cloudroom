// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { COMPUTER, type Host } from "@cloudroom/domain";
import { makeHost } from "@cloudroom/test-helpers/domain-fixtures";
import { RETRY_ACTION_ICON } from "@cloudroom/domain/update-state";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";
import type {
  SystemConfigResponse,
  SystemMachineProvider,
} from "@cloudroom/server-contract";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { MachinesSettingsSection } from "./MachinesSettingsSection";
import { focusWithKeyboard } from "@/test/keyboard-focus";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      delete: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      experimental_create: vi.fn(),
      experimental_listProviders: vi.fn(),
      experimental_resume: vi.fn(),
      experimental_retryCleanup: vi.fn(),
      retryUpdate: vi.fn(),
      experimental_suspend: vi.fn(),
      update: vi.fn(),
    },
    system: { config: vi.fn() },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const hostDaemon = vi.hoisted(() => ({
  localDaemonHostId: "host_primary" as string | null,
  platform: "darwin" as "darwin" | "linux" | "wsl" | "unknown" | null,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: hostDaemon.localDaemonHostId,
    platform: hostDaemon.platform,
  }),
}));

const NOW = Date.now();

function host(overrides: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return makeHost({
    lastSeenAt: NOW,
    ...overrides,
  });
}

const primaryHost = host({ id: "host_primary", name: "MacBook Pro" });
const offlineHost = host({
  id: "host_remote",
  name: "dev-vm",
  status: "disconnected",
  lastSeenAt: NOW - 2 * 60 * 60 * 1000,
});
const sandboxHost = host({
  id: "host_sandbox",
  name: "Modal sandbox 3f9a",
  type: "ephemeral",
  machineProviderId: "modal-sandbox",
});
const modalMachineProvider: SystemMachineProvider = {
  id: "modal-sandbox",
  displayName: "Modal Sandbox",
  description: "Create a sandbox in your Modal account.",
  icon: "Box",
  logoUrl: null,
  pluginId: "environment-modal-sandbox",
  inputs: null,
  acceptsEmptyInputs: true,
  supportsSuspend: true,
};

function systemConfig(): SystemConfigResponse {
  return makeSystemConfig({
    primaryHostId: "host_primary",
    primaryHostPlatform: "darwin",
  });
}

function stubSidebarBootstrapFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          projects: [
            {
              id: "proj_1",
              sources: [
                { id: "src_1", hostId: "host_primary" },
                { id: "src_2", hostId: "host_remote" },
              ],
              threads: [],
            },
            {
              id: "proj_2",
              sources: [{ id: "src_3", hostId: "host_primary" }],
              threads: [],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSection() {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter>
      <MachinesSettingsSection />
      <LocationProbe />
    </MemoryRouter>,
    { wrapper },
  );
}

async function openHostMenu(hostName: string): Promise<void> {
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: `${hostName} actions` }),
    { button: 0 },
  );
}

beforeEach(() => {
  hostDaemon.localDaemonHostId = "host_primary";
  hostDaemon.platform = "darwin";
  vi.mocked(sdk.hosts.experimental_listProviders).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("MachinesSettingsSection", () => {
  it("reveals sandboxes in the machine list behind Show all machines", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, sandboxHost]);
    vi.mocked(sdk.hosts.experimental_listProviders).mockResolvedValue([
      modalMachineProvider,
    ]);
    stubSidebarBootstrapFetch();

    renderSection();

    const persistentName = await screen.findByText(primaryHost.name);
    expect(
      persistentName
        .closest("[data-machine-row]")
        ?.querySelector('[data-os="macos"]'),
    ).not.toBeNull();
    expect(screen.queryByText(sandboxHost.name)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all machines" }));

    const sandboxName = screen.getByText(sandboxHost.name);
    const sandboxCard = sandboxName.closest("[data-machine-row]");
    expect(sandboxCard?.querySelector("a svg")).not.toBeNull();
    expect(sandboxCard?.querySelector('[data-icon="Laptop"]')).toBeNull();
    expect(screen.queryByText(modalMachineProvider.displayName)).toBeNull();
    await openHostMenu(sandboxHost.name);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Suspend" }));
    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.experimental_suspend)).toHaveBeenCalledWith({
        hostId: sandboxHost.id,
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Show fewer machines" }),
    );
    expect(screen.queryByText(sandboxHost.name)).toBeNull();
  });

  it("offers no reveal when every machine is already listed", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText(primaryHost.name);
    expect(
      screen.queryByRole("button", { name: "Show all machines" }),
    ).toBeNull();
  });

  it("renders machine status, OS, and projects as visible text", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    expect(await screen.findByText("MacBook Pro")).toBeDefined();
    expect(screen.getByText("dev-vm")).toBeDefined();
    expect(screen.getByText(`This ${COMPUTER}`)).toBeDefined();
    expect(screen.queryByText("primary")).toBeNull();
    expect(screen.getByText("Online")).toBeDefined();
    expect(screen.getByText(/^Offline · last seen/u)).toBeDefined();
    expect(await screen.findByText("2 projects")).toBeDefined();
    expect(screen.getByText("1 project")).toBeDefined();
    expect(screen.queryByText("Full Access")).toBeNull();
    expect(screen.getByText("macOS")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Open MacBook Pro" })
        .querySelector('[data-os="macos"]'),
    ).not.toBeNull();
  });

  it("distinguishes the client-local daemon from the primary machine", async () => {
    hostDaemon.localDaemonHostId = "host_remote";
    hostDaemon.platform = "linux";
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    const primaryName = await screen.findByText("MacBook Pro");
    const localName = screen.getByText("dev-vm");
    expect(primaryName.parentElement?.parentElement?.textContent).toContain(
      "primary",
    );
    expect(primaryName.parentElement?.parentElement?.textContent).not.toContain(
      `This ${COMPUTER}`,
    );
    expect(localName.parentElement?.parentElement?.textContent).toContain(
      `This ${COMPUTER}`,
    );
    expect(localName.parentElement?.parentElement?.textContent).not.toContain(
      "primary",
    );
    expect(screen.getByText("Linux")).toBeDefined();
  });

  it("does not infer client-local identity when no daemon is reachable", async () => {
    hostDaemon.localDaemonHostId = null;
    hostDaemon.platform = null;
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("MacBook Pro");
    expect(screen.queryByText(`This ${COMPUTER}`)).toBeNull();
    expect(screen.getByText("primary")).toBeDefined();
  });

  it("does not promote a fallback host to primary policy", async () => {
    hostDaemon.localDaemonHostId = null;
    vi.mocked(sdk.system.config).mockResolvedValue({
      ...systemConfig(),
      primaryHostId: null,
      primaryHostPlatform: null,
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("MacBook Pro");
    expect(screen.queryByText("primary")).toBeNull();
    await openHostMenu("MacBook Pro");
    expect(
      screen
        .getByRole("menuitem", { name: "Remove machine" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("shows protocol versions when a machine needs an update", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      primaryHost,
      {
        ...offlineHost,
        lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      },
    ]);
    stubSidebarBootstrapFetch();

    renderSection();

    const updateStatus = await screen.findByText(
      `Needs update · daemon protocol ${HOST_DAEMON_PROTOCOL_VERSION - 1} · server protocol ${HOST_DAEMON_PROTOCOL_VERSION}`,
    );
    expect(updateStatus.className).toContain("min-w-0");
    expect(updateStatus.className).not.toContain("shrink-0");
    await openHostMenu("dev-vm");
    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    const retryItem = await screen.findByRole("menuitem", {
      name: "Retry update",
    });
    const removeItem = await screen.findByRole("menuitem", {
      name: "Remove machine",
    });
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("w-max");
    expect(menu.className).toContain("min-w-0");
    for (const item of [renameItem, retryItem, removeItem]) {
      expect(item.className).toContain("min-h-9");
      expect(item.className).toContain("px-2.5");
      expect(item.className).toContain("py-2");
    }
    expect(renameItem.querySelector('[data-icon="Edit"]')).not.toBeNull();
    expect(
      retryItem.querySelector(`[data-icon="${RETRY_ACTION_ICON}"]`),
    ).not.toBeNull();
    expect(removeItem.querySelector('[data-icon="Trash2"]')).not.toBeNull();
  });

  it("opens the row menu from the keyboard and focuses its first action", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    const trigger = await screen.findByRole("button", {
      name: "dev-vm actions",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    await waitFor(() => {
      expect(document.activeElement).toBe(renameItem);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(renameItem, { key: "Escape" });
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("uses a labeled Add a machine action", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    const addMachine = await screen.findByRole("button", {
      name: "Add a machine",
    });
    expect(addMachine.textContent).toBe("Add a machine");
    expect(addMachine.querySelector('[data-icon="Plus"]')).not.toBeNull();
    const grid = addMachine.parentElement;
    expect(grid?.querySelectorAll("[data-machine-row]")).toHaveLength(2);
    expect(grid?.lastElementChild).toBe(addMachine);
    fireEvent.click(addMachine);
    expect(
      await screen.findByRole("heading", { name: "Set up machine access" }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "A new machine has to reach this server over the network. Choose the address it should use.",
      ),
    ).toBeDefined();
  });

  it("requests an immediate daemon update retry", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      primaryHost,
      {
        ...offlineHost,
        lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      },
    ]);
    vi.mocked(sdk.hosts.retryUpdate).mockResolvedValue({ ok: true });
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("dev-vm");
    await openHostMenu("dev-vm");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Retry update" }),
    );

    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.retryUpdate)).toHaveBeenCalledWith({
        hostId: "host_remote",
      });
    });
  });

  it("shows each machine as a hoverable card with an actions menu", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      primaryHost,
      { ...offlineHost, maxPermissionMode: "accept-edits" },
    ]);
    stubSidebarBootstrapFetch();

    renderSection();

    expect(await screen.findByText("dev-vm")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Permission limit for/ }),
    ).toBeNull();
    const machineLink = screen.getByRole("link", { name: "Open dev-vm" });
    expect(machineLink.getAttribute("href")).toBe(
      "/settings/machines/host_remote",
    );
    const row = machineLink.closest("[data-machine-row]");
    expect(row?.className).toContain("hover:bg-state-hover");
    expect(row?.className).toContain("focus-within:bg-state-hover");
    expect(row?.className).toContain("cursor-pointer");
    const overflow = row?.querySelector('[data-icon="MoreHorizontal"]');
    expect(overflow).not.toBeNull();
    expect(machineLink.contains(overflow ?? null)).toBe(false);
  });

  it("navigates to the machine detail route when the card is clicked", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    const machineLink = await screen.findByRole("link", {
      name: "Open dev-vm",
    });
    const card = machineLink.closest("[data-machine-row]");
    expect(card).not.toBeNull();
    if (card === null) return;

    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/settings/machines/host_remote",
      );
    });
  });

  it("keeps the row menu open without navigating when its trigger is clicked", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("dev-vm");
    await openHostMenu("dev-vm");

    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeDefined();
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("renames a machine through the row menu", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    vi.mocked(sdk.hosts.update).mockResolvedValue({
      ...offlineHost,
      name: "build box",
    });
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("dev-vm");
    await openHostMenu("dev-vm");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByLabelText("Machine name");
    fireEvent.change(input, { target: { value: "build box" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename machine" }));

    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.update)).toHaveBeenCalledWith({
        hostId: "host_remote",
        name: "build box",
      });
    });
  });

  it("removes a machine after confirmation", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    vi.mocked(sdk.hosts.delete).mockResolvedValue({ ok: true });
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("dev-vm");
    await openHostMenu("dev-vm");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove machine/ }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove machine" }),
    );

    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.delete)).toHaveBeenCalledWith({
        hostId: "host_remote",
      });
    });
  });

  it("disables removal of the primary machine", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("MacBook Pro");
    await openHostMenu("MacBook Pro");

    const removeItem = await screen.findByRole("menuitem", {
      name: "Remove machine",
    });
    expect(removeItem.getAttribute("aria-disabled")).toBe("true");
    expect(removeItem.textContent).toBe("Remove machine");
    focusWithKeyboard(removeItem);
    expect(
      await screen.findByRole("tooltip", {
        name: "Cloudroom's primary machine can't be removed.",
      }),
    ).toBeDefined();
    fireEvent.click(removeItem);
    expect(
      screen.queryByRole("heading", { name: "Remove MacBook Pro?" }),
    ).toBeNull();
    expect(vi.mocked(sdk.hosts.delete)).not.toHaveBeenCalled();
  });
  it("lists your other Macs and sets one up to run threads", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost]);
    const air = { handle: "airhandle", name: "MacBook Air", online: true, self: false, hostId: null, settingUp: false };
    const self = { handle: "prohandle", name: "MacBook Pro", online: true, self: true, hostId: null, settingUp: false };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) =>
        url.endsWith("/plugins/connect/rpc/macs")
          ? Response.json({ ok: true, result: { macs: [self, air] } })
          : Response.json({ projects: [] }),
      ),
    );
    const created = host({ id: "host_air", name: "MacBook Air", machineProviderId: "mac" });
    vi.mocked(sdk.hosts.experimental_create).mockResolvedValue(created);

    renderSection();

    expect(await screen.findByText("MacBook Air")).toBeDefined();
    expect(screen.getByText("Not running threads yet")).toBeDefined();
    expect(screen.getByText("Where your agents run")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Run threads here" }));
    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.experimental_create)).toHaveBeenCalledWith(
        expect.objectContaining({ machineProviderId: "mac", inputs: { handle: "airhandle" }, wait: false }),
      );
    });
  });
});
