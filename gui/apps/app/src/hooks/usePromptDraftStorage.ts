import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PromptTextMention } from "@cloudroom/domain";
import type { PromptDraftAttachment, PromptDraftState } from "@cloudroom/client-core";
import type {
  ThreadTimelineAddToChatHandler,
  ThreadTimelineAddToChatSource,
} from "@/components/thread/timeline/types";
import {
  appendMessageContextToDraft,
  appendQuoteAndAttachmentsToDraft,
  arePromptDraftStatesEqual,
  emptyPromptDraftState,
  isPromptDraftEmpty,
  numberMessageContextInDraft,
  parsePromptDraftStorage,
  prependPromptDraft,
  serializePromptDraftStorage,
} from "@cloudroom/client-core";

const PROMPT_DRAFT_STORAGE_PREFIX = "bb.promptbox.contents";
const PROMPT_DRAFT_STORAGE_VERSION = "3";
const PROMPT_DRAFT_PERSIST_DEBOUNCE_MS = 250;

export type PromptDraftScope =
  | { kind: "automation-edit"; automationId: string }
  | { kind: "new-thread" }
  | { kind: "plugin-new-thread"; key: string }
  | { kind: "thread"; projectId: string; threadId: string };

interface PromptDraftCacheEntry {
  rawValue: string | null;
  draft: PromptDraftState;
}

type PromptDraftListener = () => void;

interface PromptDraftWriteOptions {
  persist: "immediate" | "deferred";
  notify?: "immediate" | "after-paint";
}

// Typing tells React after the next paint, so the letter shows before the
// composer re-renders. The timeout covers hidden windows, which pause frames.
const PROMPT_DRAFT_NOTIFY_FALLBACK_MS = 100;
const pendingPromptDraftNotifies = new Map<string, () => void>();

const EMPTY_PROMPT_DRAFT = emptyPromptDraftState();
const promptDraftCache = new Map<string, PromptDraftCacheEntry>();
const promptDraftSubscribers = new Map<string, Set<PromptDraftListener>>();
const pendingPromptDraftStorageKeys = new Set<string>();
const promptDraftPersistTimers = new Map<string, number>();
let promptDraftStorageObserverInitialized = false;

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function readPromptDraft(storageKey: string | null): PromptDraftState {
  if (!storageKey || typeof window === "undefined") {
    return EMPTY_PROMPT_DRAFT;
  }

  if (pendingPromptDraftStorageKeys.has(storageKey)) {
    return promptDraftCache.get(storageKey)?.draft ?? EMPTY_PROMPT_DRAFT;
  }

  const rawValue = window.localStorage.getItem(storageKey);
  const cachedEntry = promptDraftCache.get(storageKey);
  if (cachedEntry && cachedEntry.rawValue === rawValue) {
    return cachedEntry.draft;
  }

  const draft = parsePromptDraftStorage(rawValue);
  promptDraftCache.set(storageKey, {
    rawValue,
    draft,
  });
  return draft;
}

function emitPromptDraftChange(storageKey: string): void {
  pendingPromptDraftNotifies.get(storageKey)?.();
  const listeners = promptDraftSubscribers.get(storageKey);
  if (!listeners || listeners.size === 0) return;

  for (const listener of listeners) {
    listener();
  }
}

function notifyPromptDraftAfterPaint(storageKey: string): void {
  if (pendingPromptDraftNotifies.has(storageKey)) return;
  const notify = () => emitPromptDraftChange(storageKey);
  let paintTimer: number | undefined;
  const frame = window.requestAnimationFrame(() => {
    paintTimer = window.setTimeout(notify, 0);
  });
  const fallbackTimer = window.setTimeout(
    notify,
    PROMPT_DRAFT_NOTIFY_FALLBACK_MS,
  );
  pendingPromptDraftNotifies.set(storageKey, () => {
    pendingPromptDraftNotifies.delete(storageKey);
    window.cancelAnimationFrame(frame);
    window.clearTimeout(paintTimer);
    window.clearTimeout(fallbackTimer);
  });
}

/** Tells React about typing now instead of after paint. Returns false when nothing was waiting. */
export function flushPromptDraftNotifies(): boolean {
  if (pendingPromptDraftNotifies.size === 0) return false;
  for (const storageKey of Array.from(pendingPromptDraftNotifies.keys())) {
    emitPromptDraftChange(storageKey);
  }
  return true;
}

function clearPromptDraftPersistTimer(storageKey: string): void {
  const timerId = promptDraftPersistTimers.get(storageKey);
  if (timerId === undefined || typeof window === "undefined") return;

  window.clearTimeout(timerId);
  promptDraftPersistTimers.delete(storageKey);
}

function persistPromptDraftCache(storageKey: string): void {
  if (typeof window === "undefined") return;

  clearPromptDraftPersistTimer(storageKey);
  pendingPromptDraftStorageKeys.delete(storageKey);

  const cachedEntry = promptDraftCache.get(storageKey);
  if (!cachedEntry) {
    window.localStorage.removeItem(storageKey);
    return;
  }

  const serialized = serializePromptDraftStorage(cachedEntry.draft);
  cachedEntry.rawValue = serialized;
  if (serialized === null) {
    window.localStorage.removeItem(storageKey);
    return;
  }

  try {
    window.localStorage.setItem(storageKey, serialized);
  } catch (error) {
    cachedEntry.rawValue = readStoredPromptDraftValue(storageKey);
    console.warn(
      `[prompt-draft] could not persist draft for ${storageKey}; keeping it in memory only`,
      error,
    );
  }
}

function readStoredPromptDraftValue(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function schedulePromptDraftPersist(storageKey: string): void {
  if (typeof window === "undefined") return;

  clearPromptDraftPersistTimer(storageKey);
  pendingPromptDraftStorageKeys.add(storageKey);
  const timerId = window.setTimeout(() => {
    persistPromptDraftCache(storageKey);
  }, PROMPT_DRAFT_PERSIST_DEBOUNCE_MS);
  promptDraftPersistTimers.set(storageKey, timerId);
}

function flushPendingPromptDraftPersists(): void {
  for (const storageKey of Array.from(pendingPromptDraftStorageKeys)) {
    persistPromptDraftCache(storageKey);
  }
}

function ensurePromptDraftStorageObserver(): void {
  if (promptDraftStorageObserverInitialized || typeof window === "undefined") {
    return;
  }

  promptDraftStorageObserverInitialized = true;
  window.addEventListener("storage", (event) => {
    if (!event.key) return;
    if (event.key.startsWith(FAILED_MESSAGES_PREFIX)) {
      const storageKey = event.key.slice(FAILED_MESSAGES_PREFIX.length, event.key.lastIndexOf(":"));
      failedMessagesCache.delete(storageKey);
      emitPromptDraftChange(storageKey);
      return;
    }
    if (pendingPromptDraftStorageKeys.has(event.key)) return;
    promptDraftCache.delete(event.key);
    emitPromptDraftChange(event.key);
  });
  window.addEventListener("pagehide", flushPendingPromptDraftPersists);
  // A press always comes before its click, so buttons that read the draft
  // (Send, queue, toolbar actions) render with every typed letter.
  window.addEventListener("pointerdown", flushPromptDraftNotifies, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPendingPromptDraftPersists();
    }
  });
}

function subscribePromptDraft(
  storageKey: string | null,
  listener: PromptDraftListener,
): () => void {
  if (!storageKey) {
    return () => {};
  }

  ensurePromptDraftStorageObserver();

  let listeners = promptDraftSubscribers.get(storageKey);
  if (!listeners) {
    listeners = new Set();
    promptDraftSubscribers.set(storageKey, listeners);
  }

  listeners.add(listener);
  return () => {
    const existingListeners = promptDraftSubscribers.get(storageKey);
    if (!existingListeners) return;

    existingListeners.delete(listener);
    if (existingListeners.size === 0) {
      promptDraftSubscribers.delete(storageKey);
    }
  };
}

function writePromptDraft(
  storageKey: string | null,
  value: PromptDraftState,
  options: PromptDraftWriteOptions = { persist: "immediate" },
): void {
  if (!storageKey || typeof window === "undefined") return;

  const draft = isPromptDraftEmpty(value) ? EMPTY_PROMPT_DRAFT : value;
  // React may not have seen pending typing yet. A fresh object forces a render,
  // so the editor drops that text even if this write matches React's last view.
  const skipsPendingTyping =
    options.notify !== "after-paint" &&
    pendingPromptDraftNotifies.has(storageKey);
  promptDraftCache.set(storageKey, {
    rawValue: null,
    draft: skipsPendingTyping
      ? { ...draft, mentions: [...draft.mentions] }
      : draft,
  });
  if (options.persist === "deferred") {
    schedulePromptDraftPersist(storageKey);
  } else {
    persistPromptDraftCache(storageKey);
  }
  if (options.notify === "after-paint") {
    notifyPromptDraftAfterPaint(storageKey);
  } else {
    emitPromptDraftChange(storageKey);
  }
}

function restorePromptDraftIfEmpty(
  storageKey: string | null,
  value: PromptDraftState,
): boolean {
  if (
    !storageKey ||
    typeof window === "undefined" ||
    isPromptDraftEmpty(value)
  ) {
    return false;
  }

  if (!isPromptDraftEmpty(readPromptDraft(storageKey))) {
    return false;
  }

  writePromptDraft(storageKey, value);
  return true;
}

// Failed sends wait here, one key per message so tabs never overwrite each other, until the
// user restores or dismisses them. Never resent. `request` pins a Cloud request ID for an unchanged restore.
export interface FailedPromptMessage {
  id: string;
  draft: PromptDraftState;
  uncertain: boolean;
  request?: { key: string; value: string };
}
const FAILED_MESSAGES_PREFIX = "bb.failed-messages:";
const NO_FAILED_MESSAGES: FailedPromptMessage[] = [];
const failedMessagesCache = new Map<string, FailedPromptMessage[]>();
const unsavedFailedMessages = new Map<string, FailedPromptMessage>(); // Storage full: kept for this session.
const failedMessageKey = (storageKey: string, id: string) => `${FAILED_MESSAGES_PREFIX}${storageKey}:${id}`;

function readFailedMessages(storageKey: string | null): FailedPromptMessage[] {
  if (!storageKey || typeof window === "undefined") return NO_FAILED_MESSAGES;
  const cached = failedMessagesCache.get(storageKey);
  if (cached) return cached;
  const prefix = failedMessageKey(storageKey, "");
  const byKey = new Map([...unsavedFailedMessages].filter(([key]) => key.startsWith(prefix)));
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const { uncertain, request, ...draft } = JSON.parse(readStoredPromptDraftValue(key) ?? "") as Omit<FailedPromptMessage, "id">;
      const id = key.slice(prefix.length);
      const parsed = parsePromptDraftStorage(JSON.stringify(draft));
      if (isPromptDraftEmpty(parsed)) continue; // Corrupt or empty record: never show a blank notice.
      byKey.set(key, { id, uncertain, ...(request ? { request } : {}), draft: parsed });
    } catch {}
  }
  const messages = [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  const result = messages.length > 0 ? messages : NO_FAILED_MESSAGES;
  failedMessagesCache.set(storageKey, result);
  return result;
}

/** Saves (or with no message, removes) one failed message. False: storage full, kept in memory only. */
function changeFailedMessage(storageKey: string, id: string, message?: FailedPromptMessage): boolean {
  const key = failedMessageKey(storageKey, id);
  unsavedFailedMessages.delete(key);
  let saved = true;
  try {
    if (!message) window.localStorage.removeItem(key);
    else {
      // Same shape as a saved draft, plus the two small fields: no bigger than main's draft write.
      const draft = JSON.parse(serializePromptDraftStorage(message.draft) ?? "{}") as object;
      window.localStorage.setItem(key, JSON.stringify({ ...draft, uncertain: message.uncertain, request: message.request }));
    }
  } catch {
    saved = false;
    if (message) unsavedFailedMessages.set(key, message);
  }
  failedMessagesCache.delete(storageKey);
  emitPromptDraftChange(storageKey);
  return saved;
}

/** A send of this exact draft is starting: its waiting copy goes; a new failure adds it back. */
function takeFailedMessage(storageKey: string, draft: PromptDraftState): void {
  const match = readFailedMessages(storageKey).find((message) => arePromptDraftStatesEqual(message.draft, draft));
  if (match) changeFailedMessage(storageKey, match.id);
}

export interface FailedSend {
  cleared: boolean;
  refused: boolean;
  request?: FailedPromptMessage["request"];
}

// Straight back into an empty composer when cleared and refused; otherwise kept as a failed message.
function restoreFailedPromptDraft(
  storageKey: string | null,
  failed: PromptDraftState,
  { cleared, refused, request }: FailedSend,
): void {
  if (!storageKey || isPromptDraftEmpty(failed)) return;
  if (arePromptDraftStatesEqual(readPromptDraft(storageKey), failed)) return;
  if (cleared && refused && restorePromptDraftIfEmpty(storageKey, failed)) return;
  if (readFailedMessages(storageKey).some((message) => arePromptDraftStatesEqual(message.draft, failed))) return;
  const id = `${Date.now().toString(36).padStart(9, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  const message = { id, draft: failed, uncertain: !refused, ...(request ? { request } : {}) };
  // Storage full: do what main does (back into an empty composer), so a reload is never worse than main.
  if (!changeFailedMessage(storageKey, id, message) && restorePromptDraftIfEmpty(storageKey, failed)) {
    changeFailedMessage(storageKey, id);
  }
}

/** The oldest failed message, how many wait, and restore (false: can't merge safely) or dismiss it. */
export function useFailedPromptMessages(storageKey: string) {
  const messages = useSyncExternalStore(
    useCallback((listener) => subscribePromptDraft(storageKey, listener), [storageKey]),
    useCallback(() => readFailedMessages(storageKey), [storageKey]),
    () => NO_FAILED_MESSAGES,
  );
  const dismiss = useCallback(() => {
    const [failed] = readFailedMessages(storageKey);
    if (failed) changeFailedMessage(storageKey, failed.id);
  }, [storageKey]);
  const restore = useCallback((): boolean => {
    const [failed] = readFailedMessages(storageKey);
    if (!failed) return true;
    const current = readPromptDraft(storageKey);
    const unchanged = isPromptDraftEmpty(current);
    const next = unchanged ? failed.draft : prependPromptDraft(failed.draft, current);
    if (!next) return false;
    writePromptDraft(storageKey, next);
    try {
      // Unchanged text sends with its first request ID, so the server's delivery check can dedupe it.
      if (unchanged && failed.request) window.localStorage.setItem(failed.request.key, failed.request.value);
    } catch {}
    // Not saved (storage full): keep the notice so a reload can't lose both copies. Sending it removes the notice.
    if (readStoredPromptDraftValue(storageKey) !== serializePromptDraftStorage(next)) return true;
    changeFailedMessage(storageKey, failed.id);
    return true;
  }, [storageKey]);
  const uncertain = messages.some((message) => message.uncertain);
  return { message: messages[0] ?? null, count: messages.length, uncertain, restore, dismiss };
}

function addQuoteToPromptDraft(
  storageKey: string,
  text: string,
  attachments: readonly PromptDraftAttachment[] = [],
  source?: ThreadTimelineAddToChatSource,
): void {
  const currentDraft = readPromptDraft(storageKey);
  const nextDraft =
    source === undefined
      ? appendQuoteAndAttachmentsToDraft(currentDraft, text, attachments)
      : appendMessageContextToDraft(
          currentDraft,
          text,
          source.messageNumber,
          attachments,
        );
  if (nextDraft === currentDraft) {
    return;
  }

  writePromptDraft(storageKey, nextDraft);
  void source?.pendingMessageNumber?.then((messageNumber) => {
    if (messageNumber === null) return;
    const draft = readPromptDraft(storageKey);
    const numberedDraft = numberMessageContextInDraft(
      draft,
      text,
      messageNumber,
    );
    if (numberedDraft !== draft) writePromptDraft(storageKey, numberedDraft);
  });
}

function getPromptDraftStorageKey(scope: PromptDraftScope): string {
  if (scope.kind === "automation-edit") {
    const normalizedAutomationId = normalizeStorageSegment(scope.automationId);
    return `${PROMPT_DRAFT_STORAGE_PREFIX}-automation-edit-${normalizedAutomationId}-${PROMPT_DRAFT_STORAGE_VERSION}`;
  }
  if (scope.kind === "new-thread") {
    return `${PROMPT_DRAFT_STORAGE_PREFIX}-draft-${PROMPT_DRAFT_STORAGE_VERSION}`;
  }
  if (scope.kind === "plugin-new-thread") {
    const normalizedKey = normalizeStorageSegment(scope.key);
    return `${PROMPT_DRAFT_STORAGE_PREFIX}-plugin-draft-${normalizedKey}-${PROMPT_DRAFT_STORAGE_VERSION}`;
  }
  const normalizedProjectId = normalizeStorageSegment(scope.projectId);
  const normalizedThreadId = normalizeStorageSegment(scope.threadId);
  return `${PROMPT_DRAFT_STORAGE_PREFIX}-${normalizedProjectId}-${normalizedThreadId}-${PROMPT_DRAFT_STORAGE_VERSION}`;
}

export function getPromptDraftAccessor(scope: PromptDraftScope): {
  storageKey: string;
  getCurrent: () => PromptDraftState;
  subscribe: (listener: () => void) => () => void;
  setDraft: (draft: PromptDraftState) => void;
  addQuote: ThreadTimelineAddToChatHandler;
} {
  const storageKey = getPromptDraftStorageKey(scope);
  return {
    storageKey,
    getCurrent: () => readPromptDraft(storageKey),
    subscribe: (listener) => subscribePromptDraft(storageKey, listener),
    setDraft: (draft) => writePromptDraft(storageKey, draft),
    addQuote: (text, attachments, source) =>
      addQuoteToPromptDraft(storageKey, text, attachments, source),
  };
}

export function usePromptDraftStorage(scope: PromptDraftScope) {
  const storageKey = getPromptDraftStorageKey(scope);
  const draft = useSyncExternalStore(
    useCallback(
      (listener) => subscribePromptDraft(storageKey, listener),
      [storageKey],
    ),
    useCallback(() => readPromptDraft(storageKey), [storageKey]),
    () => EMPTY_PROMPT_DRAFT,
  );

  const setDraftAndPersist = useCallback(
    (nextDraft: PromptDraftState) => {
      writePromptDraft(storageKey, nextDraft);
    },
    [storageKey],
  );

  const getCurrent = useCallback((): PromptDraftState => {
    return readPromptDraft(storageKey);
  }, [storageKey]);

  const subscribe = useCallback(
    (listener: () => void) => subscribePromptDraft(storageKey, listener),
    [storageKey],
  );

  // For editors that own their text (TipTap): React hears after paint.
  // A controlled <input> would flicker; use setDraft there.
  const setTextAndMentions = useCallback(
    (nextText: string, nextMentions: PromptTextMention[]) => {
      writePromptDraft(
        storageKey,
        {
          ...readPromptDraft(storageKey),
          text: nextText,
          mentions: nextMentions,
        },
        { persist: "deferred", notify: "after-paint" },
      );
    },
    [storageKey],
  );

  const addAttachment = useCallback(
    (attachment: PromptDraftAttachment) => {
      const currentDraft = readPromptDraft(storageKey);
      const alreadyExists = currentDraft.attachments.some(
        (existingAttachment) => existingAttachment.path === attachment.path,
      );
      if (alreadyExists) return;

      writePromptDraft(storageKey, {
        ...currentDraft,
        attachments: [...currentDraft.attachments, attachment],
      });
    },
    [storageKey],
  );

  const removeAttachment = useCallback(
    (path: string) => {
      const currentDraft = readPromptDraft(storageKey);
      const nextAttachments = currentDraft.attachments.filter(
        (attachment) => attachment.path !== path,
      );
      if (nextAttachments.length === currentDraft.attachments.length) {
        return;
      }

      writePromptDraft(storageKey, {
        ...currentDraft,
        attachments: nextAttachments,
      });
    },
    [storageKey],
  );

  const addQuote = useCallback<ThreadTimelineAddToChatHandler>(
    (text, attachments, source) =>
      addQuoteToPromptDraft(storageKey, text, attachments, source),
    [storageKey],
  );

  const clear = useCallback(() => {
    setDraftAndPersist(EMPTY_PROMPT_DRAFT);
  }, [setDraftAndPersist]);

  const clearIfCurrentMatches = useCallback(
    (expectedDraft: PromptDraftState): boolean => {
      if (
        !arePromptDraftStatesEqual(readPromptDraft(storageKey), expectedDraft)
      ) {
        return false;
      }

      setDraftAndPersist(EMPTY_PROMPT_DRAFT);
      if (storageKey) takeFailedMessage(storageKey, expectedDraft);
      return true;
    },
    [setDraftAndPersist, storageKey],
  );

  const setAttachments = useCallback(
    (attachments: PromptDraftAttachment[]) => {
      writePromptDraft(storageKey, {
        ...readPromptDraft(storageKey),
        attachments,
      });
    },
    [storageKey],
  );

  const restoreIfEmpty = useCallback(
    (nextDraft: PromptDraftState) => {
      restorePromptDraftIfEmpty(storageKey, nextDraft);
    },
    [storageKey],
  );

  const restoreFailedSend = useCallback(
    (failedDraft: PromptDraftState, failure: FailedSend) => {
      restoreFailedPromptDraft(storageKey, failedDraft, failure);
    },
    [storageKey],
  );

  return useMemo(
    () => ({
      storageKey,
      getCurrent,
      subscribe,
      value: draft.text,
      text: draft.text,
      mentions: draft.mentions,
      attachments: draft.attachments,
      contexts: draft.contexts,
      setDraft: setDraftAndPersist,
      setTextAndMentions,
      setAttachments,
      addAttachment,
      removeAttachment,
      addQuote,
      clear,
      clearIfCurrentMatches,
      restoreIfEmpty,
      restoreFailedSend,
    }),
    [
      addAttachment,
      addQuote,
      clear,
      clearIfCurrentMatches,
      draft.attachments,
      draft.contexts,
      draft.mentions,
      draft.text,
      getCurrent,
      removeAttachment,
      restoreFailedSend,
      restoreIfEmpty,
      setAttachments,
      setDraftAndPersist,
      setTextAndMentions,
      storageKey,
      subscribe,
    ],
  );
}

export function usePromptDraftHasInput(scope: PromptDraftScope): boolean {
  const storageKey = getPromptDraftStorageKey(scope);

  return useSyncExternalStore(
    useCallback(
      (listener) => subscribePromptDraft(storageKey, listener),
      [storageKey],
    ),
    useCallback(
      () => !isPromptDraftEmpty(readPromptDraft(storageKey)),
      [storageKey],
    ),
    () => false,
  );
}

interface PromptDraftThreadRef {
  id: string;
  projectId: string;
}

interface PromptDraftThreadSubscription {
  storageKey: string;
  threadId: string;
}

function getEmptyPresenceSnapshot(): string {
  return "";
}

function readPromptDraftPresenceBit(storageKey: string): "0" | "1" {
  return isPromptDraftEmpty(readPromptDraft(storageKey)) ? "0" : "1";
}

function createPromptDraftPresenceStore(
  subscriptions: readonly PromptDraftThreadSubscription[],
): {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string;
} {
  let bits: ("0" | "1")[] | null = null;
  let snapshot: string | null = null;
  const refresh = (): string => {
    bits = subscriptions.map(({ storageKey }) =>
      readPromptDraftPresenceBit(storageKey),
    );
    snapshot = bits.join("");
    return snapshot;
  };
  return {
    getSnapshot: () => snapshot ?? refresh(),
    subscribe: (listener) => {
      snapshot = null;
      bits = null;
      const unsubscribe = subscriptions.map(({ storageKey }, index) =>
        subscribePromptDraft(storageKey, () => {
          const bit = readPromptDraftPresenceBit(storageKey);
          if (bits !== null && bits[index] === bit) return;
          if (bits === null) {
            refresh();
          } else {
            bits[index] = bit;
            snapshot = bits.join("");
          }
          listener();
        }),
      );
      return () => {
        for (const stopListening of unsubscribe) {
          stopListening();
        }
      };
    },
  };
}

export function usePromptDraftInputThreadIds(
  threads: readonly PromptDraftThreadRef[],
): ReadonlySet<string> {
  const subscriptions = useMemo<PromptDraftThreadSubscription[]>(() => {
    const seenStorageKeys = new Set<string>();
    const next: PromptDraftThreadSubscription[] = [];
    for (const thread of threads) {
      const storageKey = getPromptDraftStorageKey({
        kind: "thread",
        projectId: thread.projectId,
        threadId: thread.id,
      });
      if (!storageKey || seenStorageKeys.has(storageKey)) continue;

      seenStorageKeys.add(storageKey);
      next.push({ storageKey, threadId: thread.id });
    }
    return next;
  }, [threads]);

  const presenceStore = useMemo(
    () => createPromptDraftPresenceStore(subscriptions),
    [subscriptions],
  );
  const presenceSnapshot = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
    getEmptyPresenceSnapshot,
  );

  return useMemo(() => {
    const threadIds = new Set<string>();
    subscriptions.forEach(({ threadId }, index) => {
      if (presenceSnapshot[index] === "1") {
        threadIds.add(threadId);
      }
    });
    return threadIds;
  }, [presenceSnapshot, subscriptions]);
}
