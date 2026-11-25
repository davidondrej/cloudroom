import { useMemo } from "react";
import { useSetAtom } from "jotai";
import { NavLink } from "react-router";
import type { ThreadListEntry } from "@cloudroom/domain";
import type { SidebarBootstrapResponse } from "@cloudroom/server-contract";
import { isSidebarProjectThread } from "@cloudroom/client-core";
import { Icon } from "@cloudroom/shared-ui/icon";
import { getThreadConversationCollapsedAtom } from "@/components/right-panel/store/panel-prefs";
import {
  useSidebarProjectName,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";

/**
 * Threads waiting on the user, one entry per thread, newest first. It reads the same
 * `hasPendingInteraction` flag the thread rows use, so a child under a collapsed parent
 * shows once, as itself, and hidden or archived threads stay out like they do in the list.
 */
export function getNeedsYouThreads(
  navigation: SidebarBootstrapResponse | undefined,
): ThreadListEntry[] {
  if (!navigation) return [];
  const byId = new Map<string, ThreadListEntry>();
  for (const thread of listSidebarNavigationThreads(navigation)) {
    if (
      thread.hasPendingInteraction &&
      thread.archivedAt === null &&
      isSidebarProjectThread(thread)
    ) {
      byId.set(thread.id, thread);
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      right.latestAttentionAt - left.latestAttentionAt ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Shortcuts to threads that need the user, pinned between the navigation and the
 * scrolling thread list. Each one only opens its thread: the card there is where the user
 * answers. With nothing pending it renders nothing, so the list starts where it always does.
 * It never scrolls or caps itself: every pending thread gets a row, and the thread list
 * below scrolls in whatever height is left.
 */
export function SidebarNeedsYou({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useSidebarNavigation();
  const threads = useMemo(() => getNeedsYouThreads(data), [data]);
  if (threads.length === 0) return null;
  const count = threads.length;
  return (
    <section
      aria-label={`Needs you, ${count} thread${count === 1 ? "" : "s"}`}
      data-testid="sidebar-needs-you"
      className="mx-2 mb-2 shrink-0 rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,var(--sidebar))] py-1 shadow-[inset_2px_0_0_var(--attention)]"
    >
      <div
        aria-hidden="true"
        className="flex items-center gap-1 px-2.5 text-xs leading-5 font-semibold text-attention"
      >
        <span>Needs you</span>
        <span>·</span>
        <span className="tabular-nums">{count}</span>
      </div>
      <ul data-testid="sidebar-needs-you-list">
        {threads.map((thread) => (
          <NeedsYouRow
            key={thread.id}
            thread={thread}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </section>
  );
}

function NeedsYouRow({
  thread,
  onNavigate,
}: {
  thread: ThreadListEntry;
  onNavigate?: () => void;
}) {
  const title = useThreadTitleDisplayText(getThreadDisplayTitle(thread));
  const projectName = useSidebarProjectName(thread.projectId);
  const setConversationCollapsed = useSetAtom(
    getThreadConversationCollapsedAtom(thread.id),
  );
  return (
    <li>
      <NavLink
        to={getThreadRoutePath({
          projectId: thread.projectId,
          threadId: thread.id,
        })}
        data-needs-you-thread-id={thread.id}
        aria-label={`Open ${title}${projectName ? ` in ${projectName}` : ""} (needs you)`}
        onClick={() => {
          setConversationCollapsed(false);
          onNavigate?.();
        }}
        className="flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] focus-visible:ring-2 aria-[current=page]:font-medium max-md:pointer-coarse:h-9 max-md:pointer-coarse:text-sm"
      >
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        <Icon
          name="ArrowUpRight"
          aria-hidden
          className="size-3 shrink-0 text-attention"
        />
      </NavLink>
    </li>
  );
}
