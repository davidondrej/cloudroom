// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useComposerTypeahead } from "./useComposerTypeahead";

function threadStorageSearchedFor(environmentId: string | null) {
  const { result } = renderHook(() =>
    useComposerTypeahead({
      projectId: "proj_1",
      providerId: "codex",
      environmentId,
      currentThreadId: "thr_1",
      selectedProviderComposerActions: [],
      resolveMentionLink: vi.fn(),
    }),
  );
  return result.current.typeaheadConfig.threadStorageThreadId;
}

describe("useComposerTypeahead", () => {
  it("searches thread files only for threads with an environment", () => {
    // Cloud threads have no environment; their storage request always fails.
    expect(threadStorageSearchedFor(null)).toBeUndefined();
    expect(threadStorageSearchedFor("env_1")).toBe("thr_1");
  });
});
