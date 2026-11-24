// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectNudge } from "./ProjectNudge";

const projectSuggestion = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { projectSuggestion } } }));
vi.mock("@/lib/ui-preferences/synced-preference-atom", async () => {
  const { atom } = await import("jotai");
  return { createSyncedPreferenceAtom: () => atom(null) };
});

const PROMPT = "fix the billing page in the app";

function mount(text: string, projectId: string, store = createStore()) {
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const hook = renderHook(({ text, projectId }) => useProjectNudge(text, projectId), {
    initialProps: { text, projectId },
    wrapper,
  });
  return { ...hook, store };
}

const pause = () => act(() => vi.advanceTimersByTimeAsync(600));

beforeEach(() => {
  vi.useFakeTimers();
  projectSuggestion.mockResolvedValue({ projectId: "ideas" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useProjectNudge", () => {
  it("suggests another project once typing pauses", async () => {
    const { result } = mount(PROMPT, "video-files");
    expect(result.current.projectId).toBeNull();
    await pause();
    expect(result.current.projectId).toBe("ideas");
  });

  it("stays off after a project is picked by hand, until the prompt is empty again", async () => {
    const { result, rerender, unmount, store } = mount(PROMPT, "video-files");
    await pause();
    expect(result.current.projectId).toBe("ideas");

    // The picker dismisses, then switches the project. More typing must not check or hint again.
    act(() => result.current.dismiss());
    rerender({ text: PROMPT, projectId: "code" });
    rerender({ text: `${PROMPT} and the settings page too`, projectId: "code" });
    await pause();
    expect(result.current.projectId).toBeNull();
    expect(projectSuggestion).toHaveBeenCalledTimes(1);

    // Leaving the composer and coming back to the same draft keeps it off.
    unmount();
    const back = mount(`${PROMPT} and the settings page too`, "code", store);
    await pause();
    expect(back.result.current.projectId).toBeNull();
    expect(projectSuggestion).toHaveBeenCalledTimes(1);

    // Sending clears the prompt, so the next prompt gets hints again.
    back.rerender({ text: "", projectId: "code" });
    back.rerender({ text: PROMPT, projectId: "code" });
    await pause();
    expect(back.result.current.projectId).toBe("ideas");
  });

  it("stays off when the project is picked before any text is typed", async () => {
    const { result, rerender } = mount("", "cloudroom");
    act(() => result.current.dismiss());
    rerender({ text: PROMPT, projectId: "video-files" });
    await pause();
    expect(result.current.projectId).toBeNull();
    expect(projectSuggestion).not.toHaveBeenCalled();
  });
});
