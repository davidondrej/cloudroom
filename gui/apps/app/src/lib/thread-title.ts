import type { Thread } from "@cloudroom/domain";

export function getThreadDisplayTitle(
  thread: Pick<Thread, "id" | "title" | "titleFallback">,
): string {
  const title = thread.title?.trim()
    ? thread.title
    : thread.titleFallback?.trim()
      ? thread.titleFallback
      : `Thread ${thread.id.slice(0, 8)}`;
  return title.replace(/[\r\n\u2028\u2029]+/gu, " ");
}
