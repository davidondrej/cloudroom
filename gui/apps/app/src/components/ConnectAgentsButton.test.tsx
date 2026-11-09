// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { ConnectAgentsButton } from "./ConnectAgentsButton";

let localStates: { providerId: string; displayName: string; status: string; loginCommand: string | null }[] = [];
vi.mock("@/lib/sdk", () => ({ sdk: {
  plugins: { callRpc: vi.fn() },
  cloudroom: { claudeAuth: vi.fn(), codexAuth: vi.fn(), cursorAuth: vi.fn() },
  terminals: { create: vi.fn(), close: vi.fn() },
  providers: { restartModelDiscovery: vi.fn() },
} }));
vi.mock("@/hooks/queries/cloudroom-queries", () => ({ useCloudroomAccount: () => ({ data: { ready: true, account: { id: "m" } } }), cloudCanRunHarness: () => true }));
vi.mock("@/hooks/queries/environment-queries", () => ({ useEnvironment: (id: string | null) => ({ data: id ? { hostId: "host_env" } : undefined }) }));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: [] }),
  useSystemProviderStates: (options: { enabled: boolean }) => ({ data: options.enabled ? { providers: localStates } : undefined, refetch: vi.fn() }),
}));
vi.mock("@/lib/provider-icon", () => ({ getProviderIconInfo: (_: string, id: string) => ({ icon: () => <i data-logo={id} /> }), getProviderIconTintStyle: () => undefined }));
vi.mock("@/components/thread/terminal/ThreadTerminalView", () => ({ ThreadTerminalView: () => null }));
vi.mock(import("@cloudroom/shared-ui/responsive-overlay"), async (original) => ({ ...(await original()), PersistentResponsiveDrawerShell: (({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null) as never }));

const claude = (state: string) => ({ state, message: null, login_id: null, verification_url: null });
const cursorMissing = { providerId: "acp-cursor", displayName: "Cursor", status: "unauthenticated", loginCommand: "cursor-agent login" };
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); localStates = []; });

function mount(props: { target: "local" | "cloud"; selected: string; environmentId?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={client}>
      <ConnectAgentsButton target={props.target} environmentId={props.environmentId} primaryHostId="host_primary" providerIds={["claude-code", "codex", "acp-cursor", "pi"]} selectedProviderId={props.selected} />
    </QueryClientProvider>
  );
  const view = render(ui());
  return () => view.rerender(ui());
}
const button = () => screen.findByRole("button", { name: /Connect agents/ });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

it("shows only while the picked agent isn't connected, with Claude in the middle", async () => {
  localStates = [{ providerId: "codex", displayName: "Codex", status: "ready", loginCommand: null }, cursorMissing];
  vi.mocked(sdk.plugins.callRpc).mockResolvedValue(claude("missing"));
  mount({ target: "local", selected: "claude-code" });
  const logos = [...(await button()).querySelectorAll("[data-logo]")].map((logo) => logo.getAttribute("data-logo"));
  expect(logos).toEqual(["codex", "claude-code", "acp-cursor"]);
  cleanup();
  mount({ target: "local", selected: "codex" });
  await settle();
  expect(screen.queryByRole("button", { name: /Connect agents/ })).toBeNull();
});

it("Hide persists and stops every check", async () => {
  vi.mocked(sdk.cloudroom.claudeAuth).mockResolvedValue(claude("missing") as never);
  vi.mocked(sdk.cloudroom.codexAuth).mockResolvedValue({ state: "connected" } as never);
  vi.mocked(sdk.cloudroom.cursorAuth).mockResolvedValue({ state: "missing" } as never);
  mount({ target: "cloud", selected: "claude-code" });
  fireEvent.click(await button());
  fireEvent.click(await screen.findByRole("button", { name: "Hide" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /Connect agents/ })).toBeNull());
  expect(localStorage.getItem("cloudroom.connectAgents.hidden")).toBe("1");
  cleanup();
  vi.clearAllMocks();
  mount({ target: "cloud", selected: "claude-code" });
  await settle();
  expect(screen.queryByRole("button", { name: /Connect agents/ })).toBeNull();
  expect(sdk.cloudroom.claudeAuth).not.toHaveBeenCalled();
  expect(sdk.cloudroom.codexAuth).not.toHaveBeenCalled();
});

it("Cloud: the Codex row opens its drawer, and a failed check still shows the button", async () => {
  vi.mocked(sdk.cloudroom.claudeAuth).mockResolvedValue(claude("connected") as never);
  vi.mocked(sdk.cloudroom.codexAuth).mockResolvedValue({ state: "missing" } as never);
  vi.mocked(sdk.cloudroom.cursorAuth).mockRejectedValue(new Error("offline"));
  const opened: string[] = [];
  const onCodex = () => opened.push("codex");
  window.addEventListener("cloudroom:connect-codex", onCodex);
  mount({ target: "cloud", selected: "acp-cursor" });
  fireEvent.click(await button());
  expect(screen.getByRole("button", { name: /Cursor/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
  expect(opened).toEqual(["codex"]);
  window.removeEventListener("cloudroom:connect-codex", onCodex);
});

it("Local: signs in on the reused environment's machine, then reloads that agent's models", async () => {
  localStates = [cursorMissing];
  vi.mocked(sdk.plugins.callRpc).mockResolvedValue(claude("connected"));
  vi.mocked(sdk.terminals.create).mockResolvedValue({ id: "term", status: "running" } as never);
  vi.mocked(sdk.terminals.close).mockResolvedValue(undefined as never);
  vi.mocked(sdk.providers.restartModelDiscovery).mockResolvedValue({ models: [], modelLoadError: null } as never);
  const rerender = mount({ target: "local", selected: "acp-cursor", environmentId: "env_1" });
  fireEvent.click(await button());
  fireEvent.click(screen.getByRole("button", { name: /Cursor/ }));
  await waitFor(() => expect(sdk.terminals.create).toHaveBeenCalledOnce());
  expect(vi.mocked(sdk.terminals.create).mock.calls[0]![0]).toMatchObject({ scope: { kind: "host_path", hostId: "host_env" }, start: { command: "cursor-agent login" } });
  localStates = [{ ...cursorMissing, status: "ready" }];
  rerender();
  await waitFor(() => expect(sdk.providers.restartModelDiscovery).toHaveBeenCalledWith({ providerId: "acp-cursor", environmentId: "env_1" }));
  expect(screen.queryByRole("button", { name: /Connect agents/ })).toBeNull();
});

it("closing the Claude panel reopens on the agent menu", async () => {
  localStates = [cursorMissing];
  vi.mocked(sdk.plugins.callRpc).mockResolvedValue(claude("missing"));
  mount({ target: "local", selected: "claude-code" });
  fireEvent.click(await button());
  fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Sign in with Claude" })).toBeNull());
  fireEvent.click(await button());
  expect(await screen.findByRole("button", { name: "Hide" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in with Claude" })).toBeNull();
});
