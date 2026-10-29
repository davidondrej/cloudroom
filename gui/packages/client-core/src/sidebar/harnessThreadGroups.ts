import type { ProviderInfo, ThreadListEntry } from "@cloudroom/domain";

interface HarnessThreadGroup {
  key: string;
  label: string;
  threads: ThreadListEntry[];
}

export function buildHarnessThreadGroups(
  threads: readonly ThreadListEntry[],
  providers: readonly ProviderInfo[],
): HarnessThreadGroup[] {
  const names = new Map(
    providers.map((provider) => [provider.id, provider.displayName]),
  );
  const threadsByKey = new Map<string, ThreadListEntry[]>();
  for (const thread of threads) {
    const existing = threadsByKey.get(thread.providerId);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByKey.set(thread.providerId, [thread]);
    }
  }
  return Array.from(threadsByKey, ([key, groupThreads]) => ({
    key,
    label: names.get(key) ?? key,
    threads: groupThreads,
  })).sort((left, right) => left.label.localeCompare(right.label));
}
