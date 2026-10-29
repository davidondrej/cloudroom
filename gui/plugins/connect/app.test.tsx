// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CONNECT_REALTIME_CHANNEL, type ConnectStatus } from "@/src/types";

const app = await loadPluginApp(() => import("./app"));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

function status(overrides: Partial<ConnectStatus> = {}): ConnectStatus {
  return {
    state: "disconnected",
    paired: false,
    handle: null,
    url: null,
    lastError: null,
    nextRetryAt: null,
    since: 1_700_000_000_000,
    remoteClients: 0,
    lastRemoteActivityAt: null,
    shares: [],
    signedIn: true,
    ...overrides,
  };
}

const connected = (overrides: Partial<ConnectStatus> = {}) =>
  status({
    state: "connected",
    paired: true,
    handle: "workstation",
    url: "https://workstation.cloudroom.run",
    since: 1_700_000_060_000,
    ...overrides,
  });

describe("connect settings section", () => {
  it("uses the plugin page header instead of declaring a second title", () => {
    expect(app.settingsSections[0]?.title).toBeUndefined();
  });

  it("asks a signed-out user to sign in and shows no setup QR", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      { rpc: { status: () => status({ signedIn: false }) } },
    );
    await slot.findByText(/Sign in to Cloudroom to use it on your phone/);
    expect(slot.queryByAltText("QR code to set up Cloudroom on your phone")).toBeNull();
  });

  it("shows setup progress and the reason while the Mac registers", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => status({ lastError: "Cloudroom Connect could not be reached" }),
        },
      },
    );
    await slot.findByText("Setting up…");
    await slot.findByText(/could not be reached/);
  });

  it("shows the phone setup link, its QR, and the private address once connected", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      { rpc: { status: () => connected({ remoteClients: 2 }) } },
    );
    await slot.findByText("Ready");
    await slot.findByText(/2 viewing remotely/);
    await slot.findByText("cloudroom.dev/m");
    await slot.findByAltText("QR code to set up Cloudroom on your phone");
    slot.getByText("https://workstation.cloudroom.run");
  });

  it("reconnecting shows the amber state and no Open button", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              state: "reconnecting",
              lastError: "can't reach cloudroom.run — connection refused",
            }),
        },
      },
    );
    await slot.findByText("Reconnecting…");
    await slot.findByText(/connection refused/);
    expect(slot.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("signs out every phone only after a second click", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => connected(),
          remoteInstructions: () => ({ enabled: true }),
          signOutPhones: () => ({ revoked: 2 }),
        },
      },
    );
    fireEvent.click(await slot.findByRole("tab", { name: /Settings/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Sign out all phones" }));
    expect(slot.rpcCalls.some((call) => call.method === "signOutPhones")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Sign out all phones?" }));
    await slot.findByText("Signed out 2 sessions.");
  });

  it("revokes a shared port", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              shares: [
                {
                  hostId: "host-server",
                  hostName: "Workstation",
                  port: 3000,
                  createdAt: 1,
                  url: "https://workstation--3000.cloudroom.run",
                },
              ],
            }),
          unexpose: () => ({ removed: true, port: 3000 }),
        },
      },
    );

    fireEvent.click(await slot.findByRole("tab", { name: /Shared servers/ }));
    await slot.findByText(":3000");
    fireEvent.click(slot.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "unexpose",
        input: { hostId: "host-server", port: 3000 },
      }),
    );
  });

  it("renders an unavailable share reason and keeps it revocable", async () => {
    const reason = "This host is not connected right now.";
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              shares: [
                {
                  hostId: "host-air",
                  hostName: "Sawyer Air",
                  port: 3000,
                  createdAt: 1,
                  url: "",
                  unavailableReason: reason,
                },
              ],
            }),
          unexpose: () => ({ removed: true, port: 3000 }),
        },
      },
    );

    fireEvent.click(await slot.findByRole("tab", { name: /Shared servers/ }));
    await slot.findByText(`Unavailable — ${reason}`);
    expect(
      slot.queryByRole("button", { name: "Copy share URL for port 3000" }),
    ).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "unexpose",
        input: { hostId: "host-air", port: 3000 },
      }),
    );
  });

  it("groups shares by host and degrades an unreachable host's group", async () => {
    const reason = "sawyer-air is not connected right now.";
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              shares: [
                {
                  hostId: "host-air",
                  hostName: "Sawyer Air",
                  port: 5173,
                  createdAt: 1,
                  url: "",
                  unavailableReason: reason,
                },
                {
                  hostId: "host-server",
                  hostName: "Workstation",
                  port: 3000,
                  createdAt: 2,
                  url: "https://workstation--3000.cloudroom.run",
                },
                {
                  hostId: "host-server",
                  hostName: "Workstation",
                  port: 8080,
                  createdAt: 3,
                  url: "https://workstation--8080.cloudroom.run",
                },
              ],
            }),
          unexpose: () => ({ removed: true, port: 5173 }),
        },
      },
    );

    fireEvent.click(await slot.findByRole("tab", { name: /Shared servers/ }));
    await slot.findByText("Sawyer Air");
    expect(slot.getAllByText("Workstation")).toHaveLength(1);

    expect(
      slot
        .getByText("workstation--3000.cloudroom.run")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("https://workstation--3000.cloudroom.run");
    slot.getByText(`Unavailable — ${reason}`);
    expect(
      slot.queryByRole("button", { name: "Copy share URL for port 5173" }),
    ).toBeNull();

    const revokeButtons = slot.getAllByRole("button", { name: "Revoke" });
    expect(revokeButtons).toHaveLength(3);
    fireEvent.click(revokeButtons[0]!);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "unexpose",
        input: { hostId: "host-air", port: 5173 },
      }),
    );
  });

  it("exposes a port through the disclosure form and surfaces errors", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => connected({ shares: [] }),
          expose: () => {
            throw new Error("Cloudroom Connect is still setting up");
          },
        },
      },
    );

    fireEvent.click(await slot.findByRole("tab", { name: /Shared servers/ }));
    await slot.findByText("No shared servers yet.");
    expect(slot.queryByLabelText("Port to share")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Expose a port" }));

    fireEvent.change(slot.getByLabelText("Port to share"), {
      target: { value: "8080" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Expose" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "expose",
        input: { port: 8080 },
      }),
    );
    await slot.findByText(/Cloudroom Connect is still setting up/);
  });

});
