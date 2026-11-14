// @vitest-environment jsdom
import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
const RPC = "/api/v1/plugins/provider-antigravity/rpc/";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The Antigravity provider plugin's RPCs, as the Accounts page reaches them over HTTP. */
function stubAntigravity(initial: "connected" | "missing") {
  let state: string = initial;
  const actions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(RPC)) return new Response("{}", { status: 404 });
      const method = url.slice(RPC.length);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
      };
      const ok = (result: unknown) =>
        new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      if (method === "antigravityAccount") {
        if (body.action && body.action !== "status") actions.push(body.action);
        if (body.action === "logout") state = "missing";
        return ok({
          state,
          message: null,
          login_id: null,
          verification_url: null,
          host_id: "host_mac",
        });
      }
      if (method === "provider-usage.v1.listResources")
        return ok({
          resources: [
            { id: "other", scope: { kind: "host", hostId: "host_other" } },
            { id: "mac", scope: { kind: "host", hostId: "host_mac" } },
          ],
        });
      if (method === "provider-usage.v1.getResource")
        return ok({
          usage: {
            status: "ok",
            windows: [
              {
                kind: "five-hour",
                model: "gemini",
                label: "Gemini · Five-hour limit",
                usedPercent: 7,
                resetsAt: null,
              },
              {
                kind: "weekly",
                model: "claude/gpt",
                label: "Claude and GPT · Weekly limit",
                usedPercent: 12,
                resetsAt: null,
              },
            ],
            requested: body,
          },
        });
      return new Response("{}", { status: 404 });
    }),
  );
  return actions;
}

function page() {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    { rpc: { "accounts.list": () => [] } },
  );
}

describe("Accounts page: Antigravity", () => {
  it("shows the Google login in use and its plan limits, after Codex", async () => {
    stubAntigravity("connected");
    const slot = page();
    const heading = await slot.findByRole("heading", { name: "Antigravity" });
    expect(
      slot
        .getAllByRole("heading", { level: 2 })
        .map((node) => node.textContent),
    ).toEqual(["Claude Code", "Codex", "Antigravity", "Cursor"]);
    const section = within(heading.closest("section")!);
    await section.findByText("In use");
    section.getByText("Google account");
    // The limits are the ones of the machine the login is on.
    // One line per model group, each with its own bars, so the row stays as tall as the others.
    await section.findByText("gemini");
    section.getByText("claude/gpt");
    expect(section.getAllByText(/^(5h|7d)$/).map((node) => node.textContent)).toEqual(["5h", "7d"]);
    section.getByText("12%");
    section.getByText(/nothing to add here/);
  });

  it("signs out, then offers Google sign-in", async () => {
    const actions = stubAntigravity("connected");
    const slot = page();
    // Sign out sits in the row's menu, like the other agents' account actions.
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Antigravity account actions" }),
      { button: 0 },
    );
    fireEvent.click(await slot.findByRole("menuitem", { name: "Sign out" }));
    await slot.findByRole("button", { name: "Sign in with Google" });
    slot.getByText("Signed out");
    expect(actions).toEqual(["logout"]);
    expect(slot.queryByText("In use")).toBeNull();
  });

  it("leaves the section out when the Antigravity plugin is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const slot = page();
    await slot.findByRole("heading", { name: "Cursor" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByRole("heading", { name: "Antigravity" })).toBeNull();
  });
});
