import { useCallback, useSyncExternalStore } from "react";
import { createKeyedListeners } from "./keyed-listeners";
import { callPluginRpc } from "./plugin-sdk-hooks";
import { wsManager } from "./ws";

const PLUGIN_ID = "computer-use";
const ACTIVE_CHANNEL = "active-changed";

export interface ComputerUseActivity {
  appName: string | null;
}

interface ActiveThreadEntry {
  threadId: string;
  appName: string | null;
}

const activeByThreadId = new Map<string, ComputerUseActivity>();
const threadListeners = createKeyedListeners<string>();

let subscriberCount = 0;
let version = 0;
let detachTransport: (() => void) | null = null;

function parseActiveList(payload: unknown): ActiveThreadEntry[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const active = Reflect.get(payload, "active");
  if (!Array.isArray(active)) return null;
  const entries: ActiveThreadEntry[] = [];
  for (const item of active) {
    if (typeof item !== "object" || item === null) return null;
    const threadId = Reflect.get(item, "threadId");
    const appName = Reflect.get(item, "appName");
    if (typeof threadId !== "string" || threadId.length === 0) return null;
    if (appName !== null && (typeof appName !== "string" || appName.length === 0)) {
      return null;
    }
    entries.push({ threadId, appName });
  }
  return entries;
}

function applyActiveList(entries: readonly ActiveThreadEntry[]): void {
  const next = new Map<string, ComputerUseActivity>();
  for (const entry of entries) {
    const prev = activeByThreadId.get(entry.threadId);
    next.set(
      entry.threadId,
      prev && prev.appName === entry.appName
        ? prev
        : { appName: entry.appName },
    );
  }

  const changedIds = new Set<string>();
  for (const [threadId, prev] of activeByThreadId) {
    const incoming = next.get(threadId);
    if (!incoming || incoming.appName !== prev.appName) {
      changedIds.add(threadId);
    }
  }
  for (const [threadId, incoming] of next) {
    const prev = activeByThreadId.get(threadId);
    if (!prev || prev.appName !== incoming.appName) {
      changedIds.add(threadId);
    }
  }

  if (changedIds.size === 0) return;
  activeByThreadId.clear();
  for (const [threadId, entry] of next) {
    activeByThreadId.set(threadId, entry);
  }
  for (const threadId of changedIds) {
    threadListeners.notify(threadId);
  }
}

async function refreshActive(clearOnFailure: boolean): Promise<void> {
  if (typeof fetch !== "function") return;
  const requestVersion = ++version;
  try {
    const result = await callPluginRpc(fetch, PLUGIN_ID, "getActive", null);
    if (requestVersion !== version || subscriberCount === 0) return;
    const entries = parseActiveList(result);
    if (entries !== null) applyActiveList(entries);
  } catch {
    if (clearOnFailure && requestVersion === version && subscriberCount > 0) {
      applyActiveList([]);
    }
  }
}

function ensureTransport(): void {
  if (detachTransport !== null) return;
  const offSignal = wsManager.onPluginSignal((signal) => {
    if (signal.pluginId !== PLUGIN_ID || signal.channel !== ACTIVE_CHANNEL) {
      return;
    }
    const entries = parseActiveList(signal.payload);
    if (entries === null) return;
    version += 1;
    applyActiveList(entries);
  });
  const offConnected = wsManager.onConnected(() => {
    void refreshActive(true);
  });
  const offChanged = wsManager.onChanged((message) => {
    if (
      message.entity === "system" &&
      message.changes.includes("plugins-changed")
    ) {
      void refreshActive(true);
    }
  });
  detachTransport = () => {
    offSignal();
    offConnected();
    offChanged();
  };
  void refreshActive(false);
}

function releaseTransport(): void {
  if (subscriberCount > 0 || detachTransport === null) return;
  detachTransport();
  detachTransport = null;
}

export function getComputerUseActivity(
  threadId: string,
): ComputerUseActivity | null {
  return activeByThreadId.get(threadId) ?? null;
}

export function subscribeComputerUseActivity(
  threadId: string,
  listener: () => void,
): () => void {
  subscriberCount += 1;
  ensureTransport();
  const unsubscribe = threadListeners.subscribe(threadId, listener);
  return () => {
    unsubscribe();
    subscriberCount = Math.max(0, subscriberCount - 1);
    releaseTransport();
  };
}

export function useComputerUseActivity(
  threadId: string,
): ComputerUseActivity | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeComputerUseActivity(threadId, listener),
    [threadId],
  );
  const getSnapshot = useCallback(
    () => getComputerUseActivity(threadId),
    [threadId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setComputerUseActiveForTest(
  entries: readonly ActiveThreadEntry[],
): void {
  version += 1;
  applyActiveList(entries);
}

export function resetComputerUseActiveForTest(): void {
  version += 1;
  applyActiveList([]);
}
