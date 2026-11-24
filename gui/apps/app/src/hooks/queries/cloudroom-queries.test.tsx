// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { BbHttpError } from "@cloudroom/sdk/browser";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import { cloudReasoningLevels, cloudroomStatusSchema, useCloudroomThreadWorkspace, useTeleportLocal } from "./cloudroom-queries";

vi.mock("@/lib/sdk", async () => ({ BbHttpError: (await import("@cloudroom/sdk/browser")).BbHttpError, sdk: { cloudroom: { threadWorkspace: vi.fn(), teleportLocal: vi.fn() } } }));
vi.mock("@/components/ui/app-toast", () => ({ appToast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.resetAllMocks(); });
function mount(enabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ enabled }) => useCloudroomThreadWorkspace("thread", enabled), { wrapper, initialProps: { enabled } });
}

it("uses the cloud model's reasoning levels rather than the local model catalog", () => {
  const status = cloudroomStatusSchema.parse({ ready: true, projectId: null, repository: "/code/test", model: "sol", error: null, harnesses: [
    { id: "codex", reasoning_levels: ["high"], models: [{ model: "sol", reasoning_levels: ["high", "xhigh", "max"] }, { model: "basic", reasoning_levels: ["high"] }] },
    { id: "pi", provider: "openrouter", reasoning_levels: ["none", "high"] },
  ] });
  expect(cloudReasoningLevels(status, "codex", "sol")).toEqual(["high", "xhigh", "max"]);
  expect(cloudReasoningLevels(status, "codex", "basic")).toEqual(["high"]);
  expect(cloudReasoningLevels(status, "codex", "unknown")).toEqual([]);
  expect(cloudReasoningLevels(status, "pi", "openrouter/model")).toEqual(["none", "high"]);
  expect(cloudReasoningLevels(undefined, "codex", "sol")).toEqual([]);
});

it("reads an empty cloud folder and later Git metadata without preparing or copying it", async () => {
  const empty = { path: "/code/project", branch: null, head: null };
  vi.mocked(sdk.cloudroom.threadWorkspace).mockResolvedValue(empty);
  const hook = mount();
  expect(sdk.cloudroom.threadWorkspace).not.toHaveBeenCalled();
  hook.rerender({ enabled: true });
  await waitFor(() => expect(hook.result.current.data).toEqual(empty));
  expect(sdk.cloudroom.threadWorkspace).toHaveBeenCalledWith("thread", expect.any(AbortSignal));
  const cloned = { ...empty, branch: "main", head: "a".repeat(40) };
  vi.mocked(sdk.cloudroom.threadWorkspace).mockResolvedValue(cloned);
  await act(() => hook.result.current.refetch());
  await waitFor(() => expect(hook.result.current.data).toEqual(cloned));
});

it("keeps an unavailable core distinct from an empty folder", async () => {
  vi.mocked(sdk.cloudroom.threadWorkspace).mockRejectedValue(new Error("Core offline"));
  const hook = mount(true);
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data).toBeUndefined();
  vi.mocked(sdk.cloudroom.threadWorkspace).mockResolvedValue({ path: "/code/project", branch: null, head: null });
  await act(() => hook.result.current.refetch());
  await waitFor(() => expect(hook.result.current.isError).toBe(false));
});

it("offers to move without cloud changes when the sandbox can't start, and moves only when asked", async () => {
  const message = "You used your Super plan's 150,000 Cloud Credits for the last 30 days.";
  vi.mocked(sdk.cloudroom.teleportLocal).mockRejectedValueOnce(new BbHttpError({ status: 409, code: "teleport_cloud_unavailable", message, body: { code: "teleport_cloud_unavailable", message } }));
  vi.mocked(sdk.cloudroom.teleportLocal).mockResolvedValueOnce({ conflicts: 0 });
  const client = new QueryClient(); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useTeleportLocal("thread"), { wrapper });
  act(() => hook.result.current.mutate());
  await waitFor(() => expect(appToast.error).toHaveBeenCalled());
  const [title, options] = vi.mocked(appToast.error).mock.calls[0]!;
  expect([title, options?.description]).toEqual(["Could not teleport to Local", message]);
  expect(sdk.cloudroom.teleportLocal).toHaveBeenCalledTimes(1);
  const action = options?.action as { label: string; onClick: () => void };
  expect(action.label).toBe("Move without cloud changes");
  act(() => action.onClick());
  await waitFor(() => expect(appToast.success).toHaveBeenCalledWith("Moved to this computer."));
  expect(vi.mocked(sdk.cloudroom.teleportLocal).mock.calls).toEqual([["thread", undefined], ["thread", { withoutCloud: true }]]);
});
