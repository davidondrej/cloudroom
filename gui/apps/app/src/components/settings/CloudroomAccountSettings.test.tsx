// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { SidebarProvider } from "@/components/ui/sidebar";
import { CloudroomAccountSettings } from "./CloudroomAccountSettings";
import { SettingsAccountMenu } from "./SettingsAccountMenu";

vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { status: vi.fn(), signIn: vi.fn(), cancel: vi.fn(), logout: vi.fn() }, projects: { list: vi.fn() } } }));
vi.mock("@/lib/url-open-routing", () => ({ openUrlInExternalBrowser: vi.fn() }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.resetAllMocks(); });
const signedOut = { ready: false, account: null, projectId: null, repository: null, model: null, error: "Sign in to Cloudroom", signingIn: false, signInError: null };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><MemoryRouter><CloudroomAccountSettings /></MemoryRouter></QueryClientProvider>);
}
it("opens system-browser sign-in without a project and exposes cancellation", async () => {
  vi.mocked(sdk.projects.list).mockResolvedValue([{ id: "project", name: "Prepared repository" }] as never);
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.signIn).mockImplementation(async input => {
    expect(input).toBeUndefined();
    vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, signingIn: true });
    return { url: "https://www.cloudroom.dev/desktop?challenge=public" };
  });
  mount();
  await waitFor(() => expect((screen.getByRole("button", { name: "Sign in to Cloudroom" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Sign in to Cloudroom" }));
  await waitFor(() => expect(openUrlInExternalBrowser).toHaveBeenCalledWith("https://www.cloudroom.dev/desktop?challenge=public"));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(sdk.cloudroom.cancel).toHaveBeenCalledOnce());
});
it("shows identity/offline status and signs out locally without a machine creation action", async () => {
  vi.mocked(sdk.projects.list).mockResolvedValue([]);
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, account: { id: "account", email: "member@example.invalid" }, error: "VM is offline" });
  vi.mocked(sdk.cloudroom.logout).mockImplementation(async () => { vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut); });
  mount();
  // The membership card, and the partner cheque made out to the member.
  expect(await screen.findAllByText("member@example.invalid")).toHaveLength(2);
  expect(screen.getByText("VM is offline")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Add a machine" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Sign out of this app?" })).getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(sdk.cloudroom.logout).toHaveBeenCalledOnce());
  await screen.findByText("Not signed in to Cloudroom");
});
it("opens the settings account menu and confirms before signing out", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, ready: true, error: null, plan: "pro", planUsage: { plan: "pro", credits: 12_300, creditsLimit: 50_000 }, account: { id: "account", email: "member@example.invalid" } });
  vi.mocked(sdk.cloudroom.logout).mockImplementation(async () => { vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const router = createMemoryRouter([{ path: "*", element: <SidebarProvider><SettingsAccountMenu /></SidebarProvider> }]);
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  fireEvent.pointerDown(await screen.findByRole("button", { name: /member@example\.invalid/u }), { button: 0 });
  expect(await screen.findByText("Pro plan · Cloud connected")).toBeDefined();
  const usage = screen.getByRole("menuitem", { name: /Usage/u });
  expect(usage.textContent).toContain("37,700 credits left");
  fireEvent.click(usage);
  await waitFor(() => expect(router.state.location).toMatchObject({ pathname: "/settings/analytics", search: "?tab=credits" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: /member@example\.invalid/u }), { button: 0 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Sign out of this app?" })).getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(sdk.cloudroom.logout).toHaveBeenCalledOnce());
  await screen.findByText("Sign in to Cloudroom");
});
it("hides the email in the settings account menu and on the Account page while Privacy mode is on", async () => {
  window.localStorage.setItem("cloudroom.privacy-mode", "1");
  try {
    vi.mocked(sdk.projects.list).mockResolvedValue([]);
    vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, ready: true, error: null, account: { id: "account", email: "member@example.invalid" } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    const router = createMemoryRouter([{ path: "*", element: <SidebarProvider><SettingsAccountMenu /><CloudroomAccountSettings /></SidebarProvider> }]);
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    await screen.findByTestId("settings-account-card");
    await screen.findByTestId("account-partner-cheque");
    expect(document.body.textContent).not.toContain("member@example.invalid");
  } finally {
    window.localStorage.removeItem("cloudroom.privacy-mode");
  }
});
