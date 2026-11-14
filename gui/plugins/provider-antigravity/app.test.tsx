// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  AntigravityLoginInput,
  AntigravityLoginStatus,
} from "./src/login-contract.js";

const app = await loadPluginApp(() => import("./app"));
const LINK =
  "https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=s";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const status = (
  state: AntigravityLoginStatus["state"],
  extra: Partial<AntigravityLoginStatus> = {},
) => ({
  state,
  message: null,
  login_id: null,
  verification_url: null,
  host_id: "host_mac",
  ...extra,
});

describe("Antigravity settings page", () => {
  it("is the plugin's page, under the tab's own name", () => {
    expect(app.settingsSections).toHaveLength(1);
    expect(app.settingsSections[0]?.title).toBeUndefined();
  });

  it("signs in with Google's page and the code it shows", async () => {
    const calls: AntigravityLoginInput[] = [];
    let current = status("missing");
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          antigravityAccount: (raw: unknown) => {
            const input = raw as AntigravityLoginInput;
            if (input.action !== "status") calls.push(input);
            if (input.action === "login")
              current = status("waiting", {
                login_id: input.requestId ?? null,
                verification_url: LINK,
              });
            if (input.action === "complete") current = status("connected");
            return current;
          },
        },
      },
    );
    await slot.findByText("Signed out on this computer.");
    fireEvent.click(slot.getByRole("button", { name: "Sign in with Google" }));
    await slot.findByText(/paste the code it shows/);
    // Cloudroom opens Google's page; the CLI only printed the link.
    expect(slot.navigateCalls).toEqual([{ method: "openUrl", url: LINK }]);
    fireEvent.change(slot.getByLabelText("Google sign-in code"), {
      target: { value: " 4/one-time-code " },
    });
    fireEvent.click(slot.getByRole("button", { name: "Connect" }));
    await slot.findByText(/Signed in on this computer/);
    expect(calls.map(({ action, code }) => ({ action, code }))).toEqual([
      { action: "login", code: undefined },
      { action: "complete", code: "4/one-time-code" },
    ]);
    expect(calls[1]?.requestId).toBe(calls[0]?.requestId);
  });

  it("signs out", async () => {
    let current = status("connected");
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          antigravityAccount: (raw: unknown) => {
            const input = raw as AntigravityLoginInput;
            if (input.action === "logout") current = status("missing");
            return current;
          },
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Sign out" }));
    await slot.findByRole("button", { name: "Sign in with Google" });
  });

  it("shows why a sign-in failed and offers it again", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          antigravityAccount: (raw: unknown) =>
            (raw as AntigravityLoginInput).action === "login"
              ? status("error", {
                  message: "Antigravity sign-in ended. Try again.",
                })
              : status("missing"),
        },
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in with Google" }),
    );
    expect((await slot.findByRole("alert")).textContent).toBe(
      "Antigravity sign-in ended. Try again.",
    );
    slot.getByRole("button", { name: "Sign in with Google" });
  });

  it("says so when the CLI is not installed", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          antigravityAccount: () =>
            status("unavailable", {
              message: "Antigravity is not installed on this machine.",
            }),
        },
      },
    );
    await slot.findByText("Antigravity is not installed on this machine.");
    await waitFor(() => slot.getByRole("button", { name: "Check again" }));
  });
});
