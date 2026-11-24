import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import {
  getLocalStorage,
  withLocalStorage,
  type SyncStorage,
} from "@/lib/browser-storage";
import { hasThreadId } from "@/lib/thread-id";

function readWithFallback(key: string, legacyKey?: string): string | null {
  return withLocalStorage((storage) => {
    const current = storage.getItem(key);
    if (current !== null) return current;
    return legacyKey ? storage.getItem(legacyKey) : null;
  }, null);
}

export function makeMigratingStorage<T>(
  parse: (raw: string | null, initial: T) => T,
  serialize: (val: T) => string,
  legacyKeyFor: (key: string) => string | undefined,
  options?: { syncAcrossWindows?: boolean },
): SyncStorage<T> {
  const storage: SyncStorage<T> = {
    getItem: (key, initial) =>
      parse(readWithFallback(key, legacyKeyFor(key)), initial),
    setItem: (key, value) => {
      withLocalStorage((s) => {
        s.setItem(key, serialize(value));
        const legacy = legacyKeyFor(key);
        if (legacy && legacy !== key) s.removeItem(legacy);
      }, undefined);
    },
    removeItem: (key) => {
      withLocalStorage((s) => {
        s.removeItem(key);
        const legacy = legacyKeyFor(key);
        if (legacy) s.removeItem(legacy);
      }, undefined);
    },
  };

  if (options?.syncAcrossWindows) {
    storage.subscribe = (key, callback, initialValue) => {
      const localStorage = getLocalStorage();
      if (
        !localStorage ||
        typeof window === "undefined" ||
        typeof window.addEventListener !== "function"
      ) {
        return () => {};
      }

      const handleStorage = (event: StorageEvent) => {
        if (event.storageArea === localStorage && event.key === key) {
          callback(parse(event.newValue, initialValue));
        }
      };

      window.addEventListener("storage", handleStorage);
      return () => {
        window.removeEventListener("storage", handleStorage);
      };
    };
  }

  return storage;
}

// --- Panel Layout Preferences ---

export const threadSecondaryPanelResizingAtom = atom(false);

const DEFAULT_WIDTH_PERCENT = 50;
export const secondaryPanelWidthPercentAtom = atomWithStorage<number>(
  "room.thread.rightPanel.widthPercent",
  DEFAULT_WIDTH_PERCENT,
  makeMigratingStorage<number>(
    (raw, initial) => {
      if (raw === null) return initial;
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 100 ? n : initial;
    },
    String,
    () => "bb.thread.secondaryPanel.widthPercent",
    { syncAcrossWindows: true },
  ),
  { getOnInit: true },
);

const disabledCollapsedAtom = atom(false);
const conversationCollapsedFamily = atomFamily((threadId: string) => {
  const encoded = encodeURIComponent(threadId);
  return atomWithStorage<boolean>(
    `room.thread.conversation.collapsed-${encoded}`,
    false,
    makeMigratingStorage<boolean>(
      (raw, initial) =>
        raw === "true" ? true : raw === "false" ? false : initial,
      String,
      () => `bb.thread.conversation.collapsed-${encoded}`,
      { syncAcrossWindows: true },
    ),
    { getOnInit: true },
  );
});

export function getThreadConversationCollapsedAtom(
  threadId: string | null | undefined,
) {
  return hasThreadId(threadId)
    ? conversationCollapsedFamily(threadId)
    : disabledCollapsedAtom;
}

// --- New-Tab Action Order Atom ---

export const newTabActionOrderAtom = atomWithStorage<string[]>(
  "room.newTab.actionOrder",
  [],
  makeMigratingStorage<string[]>(
    (raw, initial) => {
      if (raw === null) return initial;
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) &&
          parsed.every((x) => typeof x === "string")
          ? parsed
          : initial;
      } catch {
        return initial;
      }
    },
    JSON.stringify,
    () => "bb.newTab.actionOrder",
    { syncAcrossWindows: true },
  ),
  { getOnInit: true },
);
