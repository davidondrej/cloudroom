import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@cloudroom/domain";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { CHROME_SECTION_LABEL_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";

/** Flat and always expanded: project, section and parent collapse never hide running work. */
export function RunningThreads({
  threads,
  onSelect,
}: {
  threads: readonly ThreadListEntry[];
  onSelect?: () => void;
}) {
  if (threads.length === 0) return null;
  return (
    <section aria-label="Running threads" className="mb-2 min-w-0">
      <div
        className={`${CHROME_SECTION_LABEL_CLASS} px-2 py-1`}
        title="Last-known execution and background activity"
      >
        Running <span className="tabular-nums">{threads.length}</span>
      </div>
      <ul className="space-y-0.5">
        {threads.map((thread) => {
          const status = thread.execution?.status ?? thread.status;
          const label =
            status === "starting"
              ? "Starting"
              : status === "stopping"
                ? "Stopping"
                : status === "active"
                  ? "Working"
                  : "Background work";
          const parent = thread.parentThreadId;
          return (
            <li
              key={thread.id}
              className="min-w-0 rounded-md px-2 py-1 hover:bg-sidebar-accent"
            >
              <RouteAnchor
                aria-label={`${getThreadDisplayTitle(thread)} ${label}`}
                href={getThreadRoutePath({
                  projectId: thread.projectId,
                  threadId: thread.id,
                })}
                onClick={onSelect}
                className="flex min-w-0 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                <span
                  className="size-1.5 shrink-0 rounded-full bg-current"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {getThreadDisplayTitle(thread)}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {label}
                </span>
              </RouteAnchor>
              {parent && (
                <RouteAnchor
                  href={getThreadRoutePath({
                    projectId: PERSONAL_PROJECT_ID,
                    threadId: parent,
                  })}
                  onClick={onSelect}
                  className="ml-3.5 block truncate rounded text-[11px] text-muted-foreground hover:underline focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  aria-label={`Parent of ${getThreadDisplayTitle(thread)}`}
                >
                  Parent thread
                </RouteAnchor>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
