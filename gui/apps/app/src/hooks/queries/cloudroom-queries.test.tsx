// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { isCloudGithubLoginError } from "@cloudroom/domain";
import { sdk } from "@/lib/sdk";
import { isCloudGithubLoginMissing } from "@/components/thread/timeline/CloudLoginRow";
import { cloudReasoningLevels, cloudroomStatusSchema, useCloudroomThreadWorkspace } from "./cloudroom-queries";

vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { threadWorkspace: vi.fn() } } }));
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

it("detects missing or rejected Cloud GitHub logins without matching GitLab or non-login errors", () => {
  expect(isCloudGithubLoginError("The GitHub clone failed. Cloud sandboxes have no working GitHub login.")).toBe(true);
  expect(isCloudGithubLoginError("GitHub rejected the cloud's GitHub login, which may have expired.")).toBe(true);
  expect(isCloudGithubLoginError("Cloud sandboxes use GitHub account @alice, which can't see this repository.")).toBe(false);
  expect(isCloudGithubLoginMissing({ phase: "error", completed: 0, total: 0, error: "Cloud sandboxes have no working GitHub login." })).toBe(true);
  expect(isCloudGithubLoginMissing({ phase: "error", gitHost: "gitlab", completed: 0, total: 0, error: "Cloud sandboxes have no working GitHub login." })).toBe(false);
  expect(isCloudGithubLoginMissing({ phase: "complete", completed: 0, total: 0, error: "Cloud sandboxes have no working GitHub login." })).toBe(false);
});
