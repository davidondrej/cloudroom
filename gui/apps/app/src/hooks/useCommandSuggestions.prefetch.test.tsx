// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POINTER_COARSE_QUERY } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import {
  clearCachedCommandCatalogs,
  commandCatalogCacheKey,
  writeCachedCommandCatalog,
} from "@/lib/command-catalog-cache";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useCommandSuggestions } from "./useCommandSuggestions";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    projects: {
      commands: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useProjectDetailRealtimeSubscription: vi.fn(),
}));

function mockPointer(coarse: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: coarse && query === POINTER_COARSE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const BASE_ARGS = {
  projectId: "project-1",
  providerId: "codex",
  commandScope: "thread" as const,
  skillsTrigger: "/" as const,
  environmentId: "env-1",
  query: null,
};

beforeEach(() => {
  vi.mocked(sdk.projects.commands).mockResolvedValue({ commands: [] });
});

afterEach(() => {
  cleanup();
  clearCachedCommandCatalogs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("useCommandSuggestions catalog prefetch", () => {
  it("warms the command catalog when a coarse-pointer composer gains focus", async () => {
    mockPointer(true);
    const { wrapper } = createQueryClientTestHarness();

    const { result, rerender } = renderHook(
      (props: { composerFocused: boolean }) =>
        useCommandSuggestions({ ...BASE_ARGS, ...props }),
      { wrapper, initialProps: { composerFocused: false } },
    );
    expect(sdk.projects.commands).not.toHaveBeenCalled();

    rerender({ composerFocused: true });
    await waitFor(() => {
      expect(sdk.projects.commands).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(sdk.projects.commands).mock.calls[0]?.[0]).toEqual({
      projectId: "project-1",
      provider: "codex",
      environmentId: "env-1",
      signal: expect.any(AbortSignal),
    });
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("shows the saved list instantly before the fresh one loads", () => {
    mockPointer(false);
    writeCachedCommandCatalog(commandCatalogCacheKey("project-1", "codex"), {
      commands: [
        {
          name: "review",
          description: "Review code",
          argumentHint: null,
          source: "command",
          origin: "user",
        },
      ],
    });
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useCommandSuggestions({
          ...BASE_ARGS,
          composerFocused: true,
          query: "rev",
        }),
      { wrapper },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.suggestions.map((s) => s.name)).toContain("review");
  });

  it("warms an empty list when a fine-pointer composer gains focus", async () => {
    mockPointer(false);
    const { wrapper } = createQueryClientTestHarness();

    renderHook(
      () => useCommandSuggestions({ ...BASE_ARGS, composerFocused: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.projects.commands).toHaveBeenCalledTimes(1);
    });
  });

  it("still fetches on the first trigger without any focus signal", async () => {
    mockPointer(true);
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useCommandSuggestions({ ...BASE_ARGS, query: "" }), {
      wrapper,
    });

    await waitFor(() => {
      expect(sdk.projects.commands).toHaveBeenCalledTimes(1);
    });
  });
});
