// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPromptDraftAccessor,
  useFailedPromptMessages,
  usePromptDraftInputThreadIds,
  type FailedSend,
  usePromptDraftStorage,
} from "./usePromptDraftStorage";
import { FailedMessageNotice } from "@/components/promptbox/banner/FailedMessageNotice";

const NEW_THREAD_DRAFT_KEY = "bb.promptbox.contents-draft-3";
const LEGACY_PROJECT_DRAFT_KEY = "bb.promptbox.contents-proj_prompt-draft-3";

function storedDraft(text: string): string {
  return JSON.stringify({ text, attachments: [] });
}

let scopeCounter = 0;
function uniqueScope() {
  scopeCounter += 1;
  return {
    kind: "thread" as const,
    projectId: `proj-quote-test-${scopeCounter}`,
    threadId: "thr-1",
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePromptDraftStorage", () => {
  it("keeps deferred text writes readable and serializes at the persist boundary", () => {
    vi.useFakeTimers();
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() => {
      result.current.setTextAndMentions("large pending draft", []);
    });

    // Readable at once; React hears about typing only after the next paint.
    expect(result.current.getCurrent().text).toBe("large pending draft");
    expect(result.current.text).toBe("");
    act(() => vi.advanceTimersByTime(17));
    expect(result.current.text).toBe("large pending draft");
    expect(window.localStorage.getItem(result.current.storageKey)).toBeNull();
    act(() => vi.advanceTimersByTime(232));
    expect(window.localStorage.getItem(result.current.storageKey)).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(window.localStorage.getItem(result.current.storageKey)).toBe(
      storedDraft("large pending draft"),
    );
  });

  it("re-renders when a write lands before pending typing reaches React", () => {
    vi.useFakeTimers();
    const scope = uniqueScope();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePromptDraftStorage(scope);
    });
    act(() => result.current.clear()); // an already-cleared composer
    const rendersBefore = renders;

    act(() => {
      result.current.setTextAndMentions("sent text", []);
      result.current.clear();
    });

    // Empty again, but React must render so the editor drops the typed text.
    expect(renders).toBeGreaterThan(rendersBefore);
    expect(result.current.text).toBe("");
  });

  it("lets an immediate write replace a pending deferred write", () => {
    vi.useFakeTimers();
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() => {
      result.current.setTextAndMentions("stale pending draft", []);
      result.current.setDraft({
        text: "immediate replacement",
        mentions: [],
        attachments: [],
      });
    });

    expect(window.localStorage.getItem(result.current.storageKey)).toBe(
      storedDraft("immediate replacement"),
    );
    act(() => vi.advanceTimersByTime(250));
    expect(window.localStorage.getItem(result.current.storageKey)).toBe(
      storedDraft("immediate replacement"),
    );
  });

  it("keeps the in-memory draft when localStorage rejects the write", () => {
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));
    act(() => {
      result.current.setDraft({ text: "small", mentions: [], attachments: [] });
    });
    expect(window.localStorage.getItem(result.current.storageKey)).toBe(
      storedDraft("small"),
    );

    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      act(() => {
        result.current.setDraft({
          text: "too large for storage",
          mentions: [],
          attachments: [],
        });
      });
    } finally {
      setItem.mockRestore();
    }

    expect(window.localStorage.getItem(result.current.storageKey)).toBe(
      storedDraft("small"),
    );
    expect(result.current.text).toBe("too large for storage");
    expect(result.current.getCurrent().text).toBe("too large for storage");
    expect(getPromptDraftAccessor(scope).getCurrent().text).toBe(
      "too large for storage",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("flushes a deferred write when the page is hidden", () => {
    vi.useFakeTimers();
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() => {
      result.current.setTextAndMentions("flush before leaving", []);
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(window.localStorage.getItem(result.current.storageKey)).toBe(
      storedDraft("flush before leaving"),
    );
  });

  it("subscribes to draft presence for a batch of threads", () => {
    const projectId = "proj-batch-drafts";
    const threadRefs = [
      { id: "thr-batch-a", projectId },
      { id: "thr-batch-b", projectId },
    ];
    const { result } = renderHook(() => ({
      draft: usePromptDraftStorage({
        kind: "thread",
        projectId,
        threadId: "thr-batch-b",
      }),
      inputThreadIds: usePromptDraftInputThreadIds(threadRefs),
    }));

    expect([...result.current.inputThreadIds]).toEqual([]);

    act(() => {
      result.current.draft.setDraft({
        text: "Unsubmitted",
        mentions: [],
        attachments: [],
      });
    });

    expect([...result.current.inputThreadIds]).toEqual(["thr-batch-b"]);

    act(() => result.current.draft.clear());
    expect([...result.current.inputThreadIds]).toEqual([]);
  });

  it("does not re-read storage or re-render the batch when a draft edit keeps presence", () => {
    const projectId = "proj-batch-keystrokes";
    const threadRefs = Array.from({ length: 30 }, (_, index) => ({
      id: `thr-batch-${index}`,
      projectId,
    }));
    const composer = getPromptDraftAccessor({
      kind: "thread",
      projectId,
      threadId: "thr-batch-3",
    });
    let batchRenders = 0;
    const { result, rerender } = renderHook(() => {
      batchRenders += 1;
      return usePromptDraftInputThreadIds(threadRefs);
    });
    act(() => {
      composer.setDraft({ text: "first", mentions: [], attachments: [] });
    });
    expect([...result.current]).toEqual(["thr-batch-3"]);

    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const presenceReads = () =>
      getItem.mock.calls.filter(([key]) => String(key).includes(projectId))
        .length;
    rerender();
    expect(presenceReads()).toBe(0);

    const rendersBefore = batchRenders;
    act(() => {
      composer.setDraft({
        text: "first keystroke",
        mentions: [],
        attachments: [],
      });
    });
    expect(presenceReads()).toBeLessThanOrEqual(1);
    expect(batchRenders).toBe(rendersBefore);

    act(() => {
      composer.setDraft({ text: "", mentions: [], attachments: [] });
    });
    expect([...result.current]).toEqual([]);
    expect(batchRenders).toBe(rendersBefore + 1);
    getItem.mockRestore();
  });

  it("uses project-agnostic storage for new-thread prompt contents", () => {
    window.localStorage.setItem(
      LEGACY_PROJECT_DRAFT_KEY,
      storedDraft("project draft"),
    );
    window.localStorage.setItem(
      NEW_THREAD_DRAFT_KEY,
      storedDraft("global draft"),
    );

    const { result } = renderHook(() =>
      usePromptDraftStorage({ kind: "new-thread" }),
    );

    expect(result.current.storageKey).toBe(NEW_THREAD_DRAFT_KEY);
    expect(result.current.text).toBe("global draft");

    act(() => {
      result.current.setDraft({
        text: "updated global draft",
        mentions: [],
        attachments: [],
      });
    });

    expect(window.localStorage.getItem(NEW_THREAD_DRAFT_KEY)).toBe(
      storedDraft("updated global draft"),
    );
    expect(window.localStorage.getItem(LEGACY_PROJECT_DRAFT_KEY)).toBe(
      storedDraft("project draft"),
    );
  });

  it("keeps thread follow-up drafts scoped to the thread", () => {
    const { result } = renderHook(() =>
      usePromptDraftStorage({
        kind: "thread",
        projectId: "proj_prompt",
        threadId: "thr_followup",
      }),
    );

    expect(result.current.storageKey).toBe(
      "bb.promptbox.contents-proj_prompt-thr_followup-3",
    );
  });

  it("keeps automation edit drafts scoped to the automation", () => {
    const { result } = renderHook(() =>
      usePromptDraftStorage({
        kind: "automation-edit",
        automationId: "auto_watchdog",
      }),
    );

    expect(result.current.storageKey).toBe(
      "bb.promptbox.contents-automation-edit-auto_watchdog-3",
    );
  });
});

describe("usePromptDraftStorage restoreFailedSend", () => {
  const image = { type: "localImage" as const, path: "/a.png", name: "a.png", sizeBytes: 1 };
  const sent = { text: "Look at this", mentions: [], attachments: [image] };
  function failWhileTyping(typed: string, failure: FailedSend) {
    const scope = uniqueScope();
    const { result } = renderHook(() => {
      const draft = usePromptDraftStorage(scope);
      return { draft, failed: useFailedPromptMessages(draft.storageKey) };
    });
    act(() => result.current.draft.setDraft(sent));
    act(() => void result.current.draft.clearIfCurrentMatches(sent));
    act(() => result.current.draft.setTextAndMentions(typed, []));
    act(() => result.current.draft.restoreFailedSend(sent, failure));
    return result;
  }
  const original = Storage.prototype.setItem;
  const failedKeys = () =>
    Object.keys(window.localStorage).filter((key) => key.startsWith("bb.failed-messages:"));

  it("keeps a failed send aside while the user typed; restore merges, dismiss drops", () => {
    const result = failWhileTyping("Look at this too", { cleared: true, refused: true });
    expect(result.current.draft.getCurrent().text).toBe("Look at this too");
    expect(result.current.failed.message?.draft).toEqual(sent);
    act(() => void result.current.failed.restore());
    expect(result.current.draft.getCurrent().text).toBe("Look at this\n\nLook at this too");
    expect(result.current.draft.getCurrent().attachments).toHaveLength(1);
    expect(result.current.failed.message).toBeNull();
    const again = failWhileTyping("next", { cleared: true, refused: false });
    act(() => again.current.failed.dismiss());
    expect(again.current.failed.message).toBeNull();
    expect(again.current.draft.getCurrent().text).toBe("next");
  });

  it("restores a surely refused send straight into an empty composer", () => {
    const result = failWhileTyping("", { cleared: true, refused: true });
    expect(result.current.draft.getCurrent()).toEqual(sent);
    expect(result.current.failed.message).toBeNull();
  });

  it("gives an uncertain send back its own request ID on an unchanged restore", () => {
    const request = { key: "cloudroom-request:thr-1", value: "fp-a:id-a" };
    const result = failWhileTyping("", { cleared: true, refused: false, request });
    expect(result.current.failed.message?.uncertain).toBe(true);
    window.localStorage.setItem(request.key, "fp-b:id-b"); // A later send B took the slot.
    act(() => void result.current.failed.restore());
    expect(result.current.draft.getCurrent()).toEqual(sent);
    expect(window.localStorage.getItem(request.key)).toBe("fp-a:id-a");
  });

  it("keeps another tab's failed message", () => {
    const result = failWhileTyping("x", { cleared: true, refused: false });
    const key = `bb.failed-messages:${result.current.draft.storageKey}:zz`;
    window.localStorage.setItem(key, JSON.stringify({ text: "other tab", attachments: [], uncertain: true }));
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key })));
    expect(result.current.failed.count).toBe(2);
    expect(failedKeys()).toHaveLength(2);
    act(() => void result.current.failed.dismiss());
    expect(result.current.failed.message?.draft.text).toBe("other tab");
  });

  it("keeps the notice and the request ID when storage is full during restore; sending it clears the notice", () => {
    const request = { key: "cloudroom-request:thr-2", value: "fp-a:id-a" };
    const result = failWhileTyping("", { cleared: true, refused: false, request });
    window.localStorage.setItem(request.key, "fp-b:id-b");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("bb.promptbox")) throw new DOMException("full", "QuotaExceededError");
      return void Reflect.apply(original, this, [key, value]);
    });
    act(() => void result.current.failed.restore());
    setItem.mockRestore();
    expect(failedKeys()).toHaveLength(1);
    expect(window.localStorage.getItem(request.key)).toBe("fp-a:id-a");
    act(() => void result.current.draft.clearIfCurrentMatches(sent));
    expect(result.current.failed.message).toBeNull();
    expect(failedKeys()).toHaveLength(0);
  });

  it("falls back to main's composer restore when the failed record can't be stored", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("bb.failed-messages:")) throw new DOMException("full", "QuotaExceededError");
      return void Reflect.apply(original, this, [key, value]);
    });
    const result = failWhileTyping("", { cleared: true, refused: false });
    setItem.mockRestore();
    expect(result.current.failed.message).toBeNull();
    expect(window.localStorage.getItem(result.current.draft.storageKey)).toContain("Look at this");
  });

  it("warns that delivery is unknown when any waiting message is uncertain", () => {
    const result = failWhileTyping("typed", { cleared: true, refused: true });
    act(() => result.current.draft.restoreFailedSend({ ...sent, text: "second" }, { cleared: true, refused: false }));
    render(<FailedMessageNotice storageKey={result.current.draft.storageKey} />);
    expect(document.body.textContent).toContain("2 messages may not have been sent");
  });
});

describe("usePromptDraftStorage addQuote", () => {
  it("keeps an imperative draft-action consumer unsubscribed from composer writes", () => {
    const scope = uniqueScope();
    let consumerRenders = 0;
    let draftActions: ReturnType<typeof getPromptDraftAccessor> | undefined;

    function DraftActionConsumer() {
      consumerRenders += 1;
      draftActions = getPromptDraftAccessor(scope);
      return null;
    }

    render(<DraftActionConsumer />);
    const rendersBeforeTyping = consumerRenders;
    const composer = renderHook(() => usePromptDraftStorage(scope));

    act(() => {
      composer.result.current.setTextAndMentions("typed reply", []);
    });

    expect(consumerRenders).toBe(rendersBeforeTyping);
    expect(draftActions?.storageKey).toBe(composer.result.current.storageKey);

    act(() => {
      draftActions?.addQuote("selected text");
    });

    expect(composer.result.current.text).toBe("typed reply\n> selected text\n");
    expect(consumerRenders).toBe(rendersBeforeTyping);
  });

  it("appends a trimmed quote as a '> ' block to the draft text and persists", () => {
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() => result.current.addQuote("  ship it  "));

    expect(result.current.text).toBe("> ship it\n");
    expect(window.localStorage.length).toBe(1);
    expect(
      window.localStorage.getItem(result.current.storageKey ?? ""),
    ).toContain("> ship it");
  });

  it("stacks a second quote below the first, separated by a blank line", () => {
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() => result.current.addQuote("first"));
    act(() => result.current.addQuote("second"));

    expect(result.current.text).toBe("> first\n\n> second\n");
  });

  it("prefixes every line of a multi-line selection", () => {
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() => result.current.addQuote("line a\nline b"));

    expect(result.current.text).toBe("> line a\n> line b\n");
  });

  it("adds quote attachments to the draft and persists them", () => {
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() =>
      result.current.addQuote("review this", [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ]),
    );

    expect(result.current.text).toBe("> review this\n");
    expect(result.current.attachments).toEqual([
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
        sizeBytes: 0,
      },
    ]);
    expect(
      window.localStorage.getItem(result.current.storageKey ?? ""),
    ).toContain("uploads/spec.md");
  });

  it("ignores whitespace-only text without writing", () => {
    const scope = uniqueScope();
    const { result } = renderHook(() => usePromptDraftStorage(scope));

    act(() => result.current.addQuote("   \n  "));

    expect(result.current.text).toBe("");
    expect(window.localStorage.length).toBe(0);
  });

  it("syncs an added quote live across two instances of the same scope", () => {
    const scope = uniqueScope();
    const first = renderHook(() => usePromptDraftStorage(scope));
    const second = renderHook(() => usePromptDraftStorage(scope));

    act(() => first.result.current.addQuote("shared selection"));

    expect(second.result.current.text).toBe("> shared selection\n");
  });
});
