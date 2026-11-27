import { useSyncExternalStore } from "react";

/** Loop names for the purpose cards (sidebar strip, title chip), per thread a loop started or wakes (#1136). Each Loops sidebar label sends
 *  its whole set, as `{ owner, threads }`, with each read (about once a minute, and right after a loop changes here),
 *  and `threads: null` when it unmounts (Loops turned off or hidden). Rows show what the mounted labels sent. */
const LOOP_THREADS_EVENT = "cloudroom:loop-threads";

const sets = new Map<string, Map<string, string>>();
let labels = new Map<string, string>();
const listeners = new Set<() => void>();

function receive(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== "object") return;
  const { owner, threads } = detail as { owner?: unknown; threads?: unknown };
  if (typeof owner !== "string") return;
  if (threads !== null && typeof threads === "object") {
    sets.set(
      owner,
      new Map(
        Object.entries(threads).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
  } else {
    sets.delete(owner);
  }
  const next = new Map([...sets.values()].flatMap((set) => [...set]));
  // Rows re-render only when the set really changed, not on every read.
  if (
    next.size === labels.size &&
    [...next].every(([threadId, label]) => labels.get(threadId) === label)
  ) {
    return;
  }
  labels = next;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener(LOOP_THREADS_EVENT, receive);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLoopThreadLabel(threadId: string): string | null {
  return useSyncExternalStore(subscribe, () => labels.get(threadId) ?? null);
}
