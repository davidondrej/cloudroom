// @vitest-environment jsdom
import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { AccountView } from "./src/contract.js";

// jsdom has none; the account list uses one to place its highlight.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const app = await loadPluginApp(() => import("./app"));
const RPC = "/api/v1/plugins/provider-acp/rpc/antigravityAccount";
const LINK = "https://accounts.google.com/o/oauth2/auth?client_id=fake";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The ACP plugin's sign-in RPC, as the Accounts page reaches it over HTTP. `state` is agy's login. */
function stubAgy(start: "connected" | "missing" | "unavailable") {
  const agy = { state: start as string, actions: [] as string[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== RPC) return new Response("{}", { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
        requestId?: string;
        code?: string;
      };
      if (body.action && body.action !== "status") agy.actions.push(body.action);
      let loginId: string | null = null;
      if (body.action === "logout") agy.state = "missing";
      if (body.action === "login") {
        agy.state = "waiting";
        loginId = body.requestId ?? null;
      }
      if (body.action === "complete" && body.code === "good-code") agy.state = "connected";
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            state: agy.state,
            message: null,
            login_id: loginId,
            verification_url: agy.state === "waiting" ? LINK : null,
            host_id: "host_mac",
          },
        }),
        { status: 200 },
      );
    }),
  );
  return agy;
}

const googleRow: AccountView = {
  id: "local",
  name: null,
  email: "me@example.com",
  plan: "Google AI Pro",
  inUse: true,
  limitedUntil: null,
  error: null,
  credits: null,
  windows: [],
  needsSignIn: false,
  limitedLogin: false,
  signedOut: false,
};

/** The Accounts page. Its Antigravity list follows agy's login, as the server's usage reader does. */
function page(agy: { state: string }, added: AccountView[] = []) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "accounts.list": (input: unknown) =>
          (input as { provider: string }).provider === "acp-antigravity"
            ? [...(agy.state === "connected" ? [googleRow] : []), ...added]
            : [],
      },
    },
  );
}

async function antigravitySection(slot: ReturnType<typeof page>) {
  const heading = await slot.findByRole("heading", { name: "Antigravity" });
  return within(heading.closest("section")!);
}

describe("Accounts page: Antigravity's Google login", () => {
  it("signs out from the row's menu, then offers Sign in with Google", async () => {
    const agy = stubAgy("connected");
    const section = await antigravitySection(page(agy));
    await section.findByText("me@example.com · Google AI Pro");
    fireEvent.pointerDown(section.getByRole("button", { name: "Account actions" }), {
      button: 0,
    });
    fireEvent.click(await within(document.body).findByRole("menuitem", { name: "Sign out" }));
    await section.findByRole("button", { name: "Sign in with Google" });
    expect(section.queryByText("In use")).toBeNull();
    expect(agy.actions).toEqual(["logout"]);
  });

  it("signs in with Google's code when signed out", async () => {
    const agy = stubAgy("missing");
    const section = await antigravitySection(page(agy));
    section.getByText("Signed out on this computer.");
    fireEvent.click(section.getByRole("button", { name: "Sign in with Google" }));
    const code = await section.findByLabelText("Google sign-in code");
    fireEvent.change(code, { target: { value: " good-code " } });
    fireEvent.click(section.getByRole("button", { name: "Connect" }));
    await section.findByText("me@example.com · Google AI Pro");
    expect(agy.actions).toEqual(["login", "complete"]);
  });

  it("keeps added accounts when this computer signs out", async () => {
    const agy = stubAgy("connected");
    const added = { ...googleRow, id: "work", email: "work@example.com", inUse: false };
    const section = await antigravitySection(page(agy, [added]));
    await section.findByText("me@example.com · Google AI Pro");
    expect(section.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    fireEvent.pointerDown(section.getAllByRole("button", { name: "Account actions" })[0]!, {
      button: 0,
    });
    fireEvent.click(await within(document.body).findByRole("menuitem", { name: "Sign out" }));
    await section.findByRole("button", { name: "Sign in with Google" });
    section.getByRole("radio", { name: "Use work@example.com" });
    expect(section.queryByText("me@example.com · Google AI Pro")).toBeNull();
  });

  it("stays hidden when agy is not installed", async () => {
    const slot = page(stubAgy("unavailable"));
    await slot.findByRole("heading", { name: "Cursor" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByRole("heading", { name: "Antigravity" })).toBeNull();
    // Grok's note moves to Cursor while Antigravity is hidden.
    slot.getByText(/Grok signs in with your X subscription/);
  });
});
