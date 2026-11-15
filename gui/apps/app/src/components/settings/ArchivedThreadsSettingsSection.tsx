import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import type { ThreadListEntry } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { EmptyStatePanel } from "@cloudroom/shared-ui/empty-state";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Pill } from "@cloudroom/shared-ui/pill";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import { appToast } from "@/components/ui/app-toast";
import { useUnarchiveThread } from "@/hooks/mutations/thread-state-mutations";
import {
  hasThreadSearchableQuery,
  useArchivedThreadCounts,
  useArchivedThreads,
  useThreadSearch,
  type UseArchivedThreadsFilters,
} from "@/hooks/queries/thread-queries";
import { useHiddenProjects } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  threadSearchQueryKeyPrefix,
  type ArchivedThreadsKindFilter,
} from "@/hooks/queries/query-keys";
import { getThreadRoutePath } from "@/lib/route-paths";
import { formatRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";

const ALL_PROJECTS = "all";
const ARCHIVED_THREAD_SEARCH_LIMIT = 50;
/** As long as the Archived toast's Undo, so there is time to click Open. */
const RESTORED_TOAST_DURATION_MS = 8_000;

const KIND_OPTIONS: ReadonlyArray<{
  label: string;
  value: ArchivedThreadsKindFilter;
}> = [
  { label: "All threads", value: "all" },
  { label: "Root threads", value: "root" },
  { label: "Child threads", value: "child" },
];

interface ArchiveFilterMenuProps<T extends string> {
  icon: IconName;
  label: string;
  options: ReadonlyArray<{ label: string; value: T }>;
  onChange: (value: T) => void;
  value: T;
}

function ArchiveFilterMenu<T extends string>({
  icon,
  label,
  onChange,
  options,
  value,
}: ArchiveFilterMenuProps<T>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 min-w-36 justify-between gap-2 px-3 text-xs font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon name={icon} className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.value === value ? (
              <Icon name="Check" className="size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function threadCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "thread" : "threads"}`;
}

export function ArchivedThreadsSettingsSection() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ArchivedThreadsKindFilter>("all");
  const [projectId, setProjectId] = useState(ALL_PROJECTS);
  const sidebarNavigation = useSidebarNavigation();
  const hiddenProjects = useHiddenProjects().data;
  const searchIsActive = hasThreadSearchableQuery(search);
  const filters = {
    ...(projectId === ALL_PROJECTS ? {} : { projectId }),
    kind,
  } satisfies UseArchivedThreadsFilters;
  const archivedThreadsQuery = useArchivedThreads(filters, {
    enabled: !searchIsActive,
  });
  // Real totals: the list is paged, so its row count is only what has loaded. A search shows its own matches.
  const totalsQuery = useArchivedThreadCounts(filters, {
    enabled: !searchIsActive,
  });
  const totals = searchIsActive ? undefined : totalsQuery.data;
  // The server searches every archived thread and filters before its cap. Too short to search, the list stays whole:
  // filtering only the rows loaded so far looked like a search and missed most threads.
  const threadSearch = useThreadSearch({
    active: searchIsActive,
    limitPerGroup: ARCHIVED_THREAD_SEARCH_LIMIT,
    query: search,
    ...(projectId === ALL_PROJECTS ? {} : { projectId }),
    ...(kind === "all" ? {} : { hasParent: kind === "child" }),
  });
  const { mutateAsync: unarchive } = useUnarchiveThread();
  // When each row was restored here. It hides at once, in the list and in search results alike, and every click keeps
  // its own state. Archived again later (a newer archivedAt), the row shows again.
  const [restoredAt, setRestoredAt] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const restoreThread = (thread: ThreadListEntry) => {
    const at = Date.now();
    setRestoredAt((current) => new Map(current).set(thread.id, at));
    // The threads archived with it come back with it, still under it, as the Archived toast's Undo does.
    unarchive({ id: thread.id, withChildren: true }).then(
      (result) => {
        // An older server (this app viewing another computer's) names none.
        const unarchivedThreadIds = result.unarchivedThreadIds ?? [thread.id];
        const others = unarchivedThreadIds.length - 1;
        if (others > 0)
          setRestoredAt((current) => {
            const next = new Map(current);
            for (const id of unarchivedThreadIds) next.set(id, at);
            return next;
          });
        appToast.success("Restored", {
          compact: true,
          duration: RESTORED_TOAST_DURATION_MS,
          id: `thread-restored-${thread.id}`,
          description:
            getThreadDisplayTitle(thread) + (others > 0 ? ` +${others}` : ""),
          action: {
            label: "Open",
            onClick: () =>
              navigate(
                getThreadRoutePath({
                  projectId: thread.projectId,
                  threadId: thread.id,
                }),
              ),
          },
        });
      },
      // The mutation shows the error; the row comes back.
      () =>
        setRestoredAt((current) => {
          const next = new Map(current);
          next.delete(thread.id);
          return next;
        }),
    );
  };

  const projects = useMemo(() => {
    if (!sidebarNavigation.data) return [];
    return [
      sidebarNavigation.data.personalProject,
      ...sidebarNavigation.data.projects,
      ...(hiddenProjects ?? []),
    ];
  }, [hiddenProjects, sidebarNavigation.data]);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const projectOptions = useMemo(
    () => [
      { label: "All projects", value: ALL_PROJECTS },
      ...projects.map((project) => ({
        label: project.name,
        value: project.id,
      })),
    ],
    [projects],
  );

  const archivedThreads = useMemo(() => {
    const threads = searchIsActive
      ? (threadSearch.data?.archived.results.map((result) => result.thread) ??
        [])
      : (archivedThreadsQuery.data?.pages ?? []).flat();
    return threads.filter(
      (thread) =>
        thread.archivedAt !== null &&
        thread.archivedAt > (restoredAt.get(thread.id) ?? 0) &&
        (projectId === ALL_PROJECTS || thread.projectId === projectId) &&
        (kind === "all" ||
          (thread.parentThreadId !== null) === (kind === "child")),
    );
  }, [
    archivedThreadsQuery.data,
    kind,
    projectId,
    restoredAt,
    searchIsActive,
    threadSearch.data,
  ]);
  const totalByProject = useMemo(
    () => new Map(totals?.groups?.map((group) => [group.key, group.count])),
    [totals],
  );
  // More matches than the search returns, or more threads than have loaded.
  const searchTotal = threadSearch.data?.archived.total ?? 0;
  const shownOfTotal = searchIsActive
    ? searchTotal > ARCHIVED_THREAD_SEARCH_LIMIT
      ? `Showing the top ${ARCHIVED_THREAD_SEARCH_LIMIT} of ${searchTotal.toLocaleString()} matches. Narrow your search to see the rest.`
      : null
    : totals && totals.total > archivedThreads.length
      ? `Showing ${archivedThreads.length.toLocaleString()} of ${threadCountLabel(totals.total)}`
      : null;

  const groupedThreads = useMemo(() => {
    const groups = new Map<string, ThreadListEntry[]>();
    for (const thread of archivedThreads) {
      const group = groups.get(thread.projectId);
      if (group) group.push(thread);
      else groups.set(thread.projectId, [thread]);
    }
    return [...groups.entries()];
  }, [archivedThreads]);

  const selectedKindLabel =
    KIND_OPTIONS.find((option) => option.value === kind)?.label ??
    "All threads";
  const selectedProjectLabel =
    projectOptions.find((option) => option.value === projectId)?.label ??
    "All projects";
  const isInitialLoading = searchIsActive
    ? threadSearch.isDebouncing ||
      (threadSearch.isLoading && threadSearch.data === undefined)
    : archivedThreadsQuery.isPending;
  // A failed load must not look like an empty archive. Rows already on screen stay.
  const activeQuery = searchIsActive ? threadSearch : archivedThreadsQuery;
  const loadFailed = activeQuery.isError && activeQuery.data === undefined;
  const retryLoad = () =>
    searchIsActive
      ? void queryClient.refetchQueries({
          queryKey: threadSearchQueryKeyPrefix(),
          type: "active",
        })
      : void archivedThreadsQuery.refetch();

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          Archived threads
        </h2>
        <p className="mt-1 text-xs text-subtle-foreground">
          Find and restore archived threads from across your projects.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground"
          />
          <Input
            aria-label="Search archived threads"
            className="h-8 pl-8 text-xs"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search archived threads…"
            value={search}
          />
        </div>
        <ArchiveFilterMenu
          icon="SlidersHorizontal"
          label={selectedKindLabel}
          onChange={setKind}
          options={KIND_OPTIONS}
          value={kind}
        />
        <ArchiveFilterMenu
          icon="Folder"
          label={selectedProjectLabel}
          onChange={setProjectId}
          options={projectOptions}
          value={projectId}
        />
      </div>

      {isInitialLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Loading archived threads…
        </p>
      ) : loadFailed ? (
        <EmptyStatePanel className="space-y-3 py-8">
          <p>Couldn't load archived threads.</p>
          <Button
            type="button"
            variant="secondary"
            className="h-7 px-2.5 text-xs font-normal"
            disabled={activeQuery.isFetching}
            onClick={retryLoad}
          >
            {activeQuery.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </EmptyStatePanel>
      ) : archivedThreads.length === 0 ? (
        <EmptyStatePanel className="py-8">
          {searchIsActive
            ? "No archived threads match your search."
            : "No archived threads match these filters."}
        </EmptyStatePanel>
      ) : (
        <div className="space-y-6">
          {groupedThreads.map(([groupProjectId, threads]) => (
            <section key={groupProjectId} className="space-y-2">
              <div className="flex items-center gap-2 px-0.5 text-xs font-medium text-muted-foreground">
                <Icon name="Folder" className="size-3.5" />
                <h3 className="min-w-0 flex-1 truncate">
                  {projectNames.get(groupProjectId) ?? "Unknown project"}
                </h3>
                <span>
                  {threadCountLabel(
                    Math.max(
                      totalByProject.get(groupProjectId) ?? 0,
                      threads.length,
                    ),
                  )}
                </span>
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-lg bg-surface-recessed">
                {threads.map((thread) => (
                  <div
                    key={thread.id}
                    className="flex min-h-14 items-center gap-3 px-4 py-2.5"
                  >
                    <Link
                      className="min-w-0 flex-1"
                      to={getThreadRoutePath({
                        projectId: thread.projectId,
                        threadId: thread.id,
                      })}
                    >
                      <span className="flex min-w-0 items-center gap-2 text-sm">
                        <span className="truncate">
                          {getThreadDisplayTitle(thread)}
                        </span>
                        {thread.parentThreadId !== null ? (
                          <Pill variant="outline" className="shrink-0">
                            child
                          </Pill>
                        ) : null}
                      </span>
                      {thread.archivedAt !== null ? (
                        <span className="mt-0.5 block text-xs text-subtle-foreground">
                          Archived{" "}
                          {formatRelativeTime({
                            timestamp: thread.archivedAt,
                            now: Date.now(),
                          })}
                        </span>
                      ) : null}
                    </Link>
                    <ThreadUnarchiveButton
                      variant="secondary"
                      onUnarchive={() => restoreThread(thread)}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {shownOfTotal !== null && !loadFailed && !isInitialLoading ? (
        <p className="text-center text-xs text-subtle-foreground">
          {shownOfTotal}
        </p>
      ) : null}

      {!searchIsActive && archivedThreadsQuery.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          className="h-9 w-full text-sm font-normal text-muted-foreground"
          disabled={archivedThreadsQuery.isFetchingNextPage}
          onClick={() => archivedThreadsQuery.fetchNextPage()}
        >
          {archivedThreadsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}
