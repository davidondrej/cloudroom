import type { TimelineUserConversationRow } from "@cloudroom/server-contract";

export function computeMutedPrefixLength(
  initiator: TimelineUserConversationRow["initiator"],
  text: string,
): number {
  if (initiator === "user") return 0;
  // `[bb ...]` is the older spelling, still in saved messages.
  if (!/^\[(?:system\]|message from thread:|bb)/.test(text)) return 0;
  const closeIdx = text.indexOf("]");
  if (closeIdx === -1) return 0;
  let endIdx = closeIdx + 1;
  while (endIdx < text.length && /\s/.test(text.charAt(endIdx))) {
    endIdx += 1;
  }
  return endIdx;
}
