import { describe, expect, it } from "vitest";
import { shouldSuppressPinnedThreadDropPreview } from "./useRenderedSectionThreadDnd";
import { PINNED_THREAD_PARENT_KEY } from "./useSectionThreadDnd";

describe("shouldSuppressPinnedThreadDropPreview", () => {
  it("keeps the preview until the optimistic pinned row exists", () => {
    expect(
      shouldSuppressPinnedThreadDropPreview({
        activeThreadId: "thread-1",
        dragOverParentKey: PINNED_THREAD_PARENT_KEY,
        pinnedThreads: [],
      }),
    ).toBe(false);
  });

  it("suppresses the preview once the optimistic pinned row exists", () => {
    expect(
      shouldSuppressPinnedThreadDropPreview({
        activeThreadId: "thread-1",
        dragOverParentKey: PINNED_THREAD_PARENT_KEY,
        pinnedThreads: [{ id: "thread-1" }],
      }),
    ).toBe(true);
  });
});
