// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerTypeahead } from "./useComposerTypeahead";

const mocks = vi.hoisted(() => ({ usePromptMentions: vi.fn() }));

vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentions: mocks.usePromptMentions,
}));

vi.mock("@/hooks/useCommandSuggestions", () => ({
  useCommandSuggestions: () => ({
    trigger: null,
    suggestions: [],
    isLoading: false,
    isError: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: () => {},
  }),
}));

beforeEach(() => {
  mocks.usePromptMentions.mockReturnValue({
    triggers: ["@"],
    results: { suggestions: [] },
    isLoading: false,
    isError: false,
    setQuery: () => {},
  });
});

function threadStorageSearchedFor(environmentId: string | null) {
  renderHook(() =>
    useComposerTypeahead({
      projectId: "proj_1",
      providerId: "codex",
      environmentId,
      currentThreadId: "thr_1",
      selectedProviderComposerActions: [],
      resolveMentionLink: vi.fn(),
    }),
  );
  return mocks.usePromptMentions.mock.lastCall?.[1].threadStorageThreadId;
}

describe("useComposerTypeahead", () => {
  it("searches thread files only for threads with an environment", () => {
    // Cloud threads have no environment; their storage request always fails.
    expect(threadStorageSearchedFor(null)).toBeUndefined();
    expect(threadStorageSearchedFor("env_1")).toBe("thr_1");
  });
});
