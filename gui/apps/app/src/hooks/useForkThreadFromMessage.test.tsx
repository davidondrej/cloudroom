// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Thread } from "@cloudroom/domain";
import { makeThread as makeThreadFixture } from "@cloudroom/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY,
  type ForkThreadCreateSeed,
} from "@cloudroom/client-core";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { appToast } from "@/components/ui/app-toast";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { useForkThreadFromMessage } from "./useForkThreadFromMessage";

const mocks = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
  forkPoint: vi.fn(async ({ sequence }: { sequence: number }): Promise<{ exact: boolean; sequence: number | null; textOnly?: boolean }> => ({ exact: true, sequence })),
  navigate: vi.fn(),
  setRootComposeProjectId: vi.fn(),
  queryClient: {
    fetchQuery: (...args: unknown[]) => mocks.fetchQuery(...args),
    getQueriesData: () => [
      [
        ["systemExecutionOptions"],
        {
          providers: [
            {
              id: "codex",
              capabilities: { supportsFork: true },
            },
          ],
        },
      ],
    ],
  },
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { messageForkPoint: mocks.forkPoint } },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => mocks.queryClient,
  };
});

vi.mock("@/lib/root-compose-selection", () => ({
  useSetRootComposeProjectId: () => mocks.setRootComposeProjectId,
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    createdAt: 1,
    environmentId: "env_source",
    id: "thr_source",
    lastReadAt: null,
    latestAttentionAt: 1,
    projectId: "proj_source",
    title: null,
    titleFallback: "Fallback fork title",
    updatedAt: 1,
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function Wrapper({ children }: { children: ReactNode }) {
  return <RouteNavigationProvider>{children}</RouteNavigationProvider>;
}

describe("useForkThreadFromMessage", () => {
  it("opens the root composer with the fork seed and the selected text quoted", async () => {
    mocks.fetchQuery.mockResolvedValue({
      model: "gpt-5",
      permissionMode: "accept-edits",
      reasoningLevel: "high",
      serviceTier: "fast",
    });

    const { result } = renderHook(
      () =>
        useForkThreadFromMessage({
          sourceThread: makeThread(),
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await result.current({
        sourceSeqEnd: 12,
        context: { text: "fork from here", messageNumber: 4 },
      });
    });

    expect(getPromptDraftAccessor({ kind: "new-thread" }).getCurrent()).toMatchObject({
      text: "<context> [message #4 - 3 words] </context> ",
      contexts: [{ label: "[message #4 - 3 words]", text: "fork from here" }],
    });
    expect(mocks.setRootComposeProjectId).toHaveBeenCalledWith("proj_source");
    expect(mocks.navigate).toHaveBeenCalledWith(getRootComposeRoutePath(), {
      state: expect.objectContaining({
        focusPrompt: true,
      }),
    });

    const navigateState = mocks.navigate.mock.calls[0]?.[1]?.state as
      | Record<string, unknown>
      | undefined;
    const seed = navigateState?.[FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY] as
      | ForkThreadCreateSeed
      | undefined;
    expect(seed).toMatchObject({
      environmentId: "env_source",
      model: "gpt-5",
      permissionMode: "accept-edits",
      projectId: "proj_source",
      providerId: "codex",
      reasoningLevel: "high",
      serviceTier: "fast",
      sourceSeqEnd: 12,
      sourceThreadId: "thr_source",
      sourceThreadTitle: "Fallback fork title",
    });
  });
  it("keeps one handler identity across thread refetches and reads the latest thread", async () => {
    mocks.fetchQuery.mockResolvedValue({
      model: "gpt-5",
      permissionMode: "accept-edits",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
    const { result, rerender } = renderHook(
      ({ sourceThread }: { sourceThread: Thread | null }) =>
        useForkThreadFromMessage({ sourceThread }),
      { initialProps: { sourceThread: makeThread() }, wrapper: Wrapper },
    );
    const first = result.current;

    rerender({ sourceThread: makeThread({ title: "Renamed source" }) });
    expect(result.current).toBe(first);

    await act(async () => {
      await first({ sourceSeqEnd: 3 });
    });
    const navigateState = mocks.navigate.mock.calls[0]?.[1]?.state as
      | Record<string, unknown>
      | undefined;
    const seed = navigateState?.[FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY] as
      | ForkThreadCreateSeed
      | undefined;
    expect(seed?.sourceThreadTitle).toBe("Renamed source");

    mocks.forkPoint.mockResolvedValueOnce({ exact: true, sequence: 4, textOnly: true });
    await act(() => first({ sourceSeqEnd: 4 }));
    expect(mocks.navigate.mock.lastCall?.[1]?.state).toMatchObject({
      [FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY]: { textOnly: true, sourceSeqEnd: 4 },
    });
    mocks.navigate.mockClear();
    const notice = vi.spyOn(appToast, "message").mockReturnValue("fork");
    mocks.forkPoint.mockResolvedValueOnce({ exact: false, sequence: null });
    await act(() => first({ sourceSeqEnd: 4 }));
    expect(notice).toHaveBeenCalledWith("No saved reply is available to fork here yet.");
    expect(mocks.navigate).not.toHaveBeenCalled();

    mocks.forkPoint.mockResolvedValueOnce({ exact: false, sequence: 3 });
    await act(() => first({ sourceSeqEnd: 4 }));
    expect(mocks.navigate).not.toHaveBeenCalled();
    const action = notice.mock.lastCall?.[1]?.action;
    expect(action?.label).toBe("Use previous finished turn");
    const button = render(<button onClick={action?.onClick}>{action?.label}</button>);
    fireEvent.click(button.getByRole("button", { name: "Use previous finished turn" }));
    expect(mocks.navigate.mock.lastCall?.[1]?.state[FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY].sourceSeqEnd).toBe(3);
  });
});
