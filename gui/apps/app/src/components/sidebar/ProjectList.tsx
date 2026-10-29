import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type {
  ProjectResponse,
  ThreadSectionResponse,
} from "@cloudroom/server-contract";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type ThreadListEntry,
} from "@cloudroom/domain";
import { useRouteState } from "@/hooks/useRouteState";
import {
  useConnectionAwareQueryState,
  type ConnectionAwareQueryStatus,
} from "@/hooks/queries/connection-aware-query-state";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { stripProjectThreads } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  useSystemConfig,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import { useReorderPinnedThread } from "@/hooks/mutations/thread-state-mutations";
import {
  useDeleteThreadSection,
  useUpdateThreadSection,
} from "@/hooks/mutations/thread-section-mutations";
import {
  isHostPathMissing,
  useHostPathExistence,
} from "@/hooks/queries/host-path-queries";
import { useHosts, usePrimaryHost } from "@/hooks/queries/host-queries";
import { useDialogState } from "@/hooks/useDialogState";
import { usePromptDraftInputThreadIds } from "@/hooks/usePromptDraftStorage";
import {
  buildProjectThreadGroups,
  getCollapsedChildActivity,
  getProjectThreadItemDescendants,
  type ProjectThreadNode,
} from "@cloudroom/client-core";
import { useSectionThreadDnd } from "./useSectionThreadDnd";
import { useRenderedSectionThreadDnd } from "./useRenderedSectionThreadDnd";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { BbHttpError } from "@cloudroom/sdk/browser";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Button } from "@cloudroom/shared-ui/button";
import {
  AppCommandShortcutHint,
  AppCommandShortcutPill,
} from "@/components/commands/AppCommandShortcutHint";
import {
  ThreadSectionRenameDialog,
  type ThreadSectionRenameDialogTarget,
} from "@/components/dialogs/ThreadSectionCreateDialog";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/dialogs/ConfirmDeleteDialog";
import { Icon } from "@cloudroom/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@cloudroom/shared-ui/motion";
import { Skeleton } from "@cloudroom/shared-ui/skeleton";
import {
  SidebarGroupContent,
  SidebarStickyStack,
} from "@/components/ui/sidebar.js";
import { COARSE_POINTER_ROW_HEIGHT_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  ChronologicalSectionThreadSections,
  ProjectThreadTree,
} from "./ProjectRow";
import type { ProjectThreadListState } from "./ProjectRow";
import {
  buildHarnessThreadGroups,
  buildMachineThreadGroups,
  buildPinnedSidebarState,
  CHRONOLOGICAL_CONTAINER_ID,
  compareByCreatedAtDescending,
  compareStandardThreads,
  isThreadRunning,
  createSidebarProjectIdResolver,
  isSidebarProjectThread,
  NO_MACHINE_GROUP_KEY,
  resolveSidebarProjectId,
  sectionKeyForThreadSection,
  buildSidebarEntitySectionId,
  type ProjectThreadItem,
  type SidebarSectionDefinition,
  type ThreadComparator,
} from "@cloudroom/client-core";
import {
  SortableProjectRow,
  type ProjectListRowModel,
} from "./ProjectListProjects";
import {
  PinnedThreadTree,
  type PinnedThreadTreeProps,
} from "./PinnedThreadTree";
import { useThreadTitleMentionResources } from "@/components/thread/ThreadTitleMentions";
import {
  ThreadSectionMoveProvider,
  type ThreadSectionMoveDestination,
} from "@/components/thread/ThreadSectionMoveProvider";
import {
  collapsedProjectIdsAtom,
  collapsedSidebarSectionIdsAtom,
  sidebarChronologicalSortAtom,
  sidebarCollapsedThreadSectionsAtom,
  sidebarCollapsedMachinesAtom,
  sidebarCollapsedHarnessesAtom,
  sidebarOrganizationModeAtom,
  type SidebarChronologicalSort,
  type CollapsibleSidebarSectionId,
  type SidebarOrganizationMode,
  type SidebarSectionId,
} from "./sidebarCollapsedAtoms";
import { useThreadCollapse } from "./useThreadCollapse";
import {
  useSidebarSectionSort,
  type SidebarSectionComparator,
} from "./sidebarSectionSort";
import { useUiPreferencesReady } from "@/lib/ui-preferences/UiPreferencesSync";
import {
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
} from "./sidebarRowClasses";
import {
  SidebarHeaderActionsProvider,
  SidebarHeaderControls,
} from "./SidebarHeaderControls";
import {
  useAppCommandRunner,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { usePaneContentSplitIndicator } from "./paneContentSplitIndicator";
import { SplitPaneMiniMap } from "./SplitPaneMiniMap";
import {
  renderBuiltInSidebarSection,
  SortableSidebarSection,
  type BuiltInSidebarSectionOptions,
  type BuiltInSidebarSectionOptionsById,
} from "./BuiltInSidebarSection";
import { ReorderableSidebarSectionOrderList } from "./ReorderableSidebarSectionOrderList";
import { useSidebarModeSectionOrder } from "./useSidebarModeSectionOrder";
import { haveSameOrder } from "@/lib/stored-order";
import {
  resolveThreadTitleDisplayText,
  type ThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";

interface ProjectListProps {
  onNewProject?: () => void;
  onProjectSelect?: () => void;
  isCreatingProject?: boolean;
}

interface ProjectListNewThreadActionProps {
  splitEnabled?: boolean;
  newThreadSplit?: {
    onPointerDown?: PointerEventHandler<HTMLElement>;
    openInSplit(): void;
  };
  onNewChat?: () => void;
}

interface ProjectListSearchThreadsActionProps {
  onSearchThreads?: () => void;
}

interface ProjectListShellProps {
  children: ReactNode;
}

interface ProjectListNavigationLoadingRowProps {
  textWidthClassName: string;
}

interface LocalSourcePathTarget {
  path: string;
  projectId: string;
}

export const PROJECT_LIST_ACTION_BUTTON_CLASS = cn(
  SIDEBAR_ROW_BASE_CLASS,
  LIST_HOVER_TRANSITION,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
  "min-w-0 cursor-pointer justify-start overflow-hidden font-normal ring-sidebar-ring focus-visible:ring-2 disabled:cursor-default disabled:opacity-70 max-md:pointer-coarse:[&_[data-icon-root]]:size-5",
);

interface ProjectThreadListStateArgs {
  status: ConnectionAwareQueryStatus | undefined;
  threads: ThreadListEntry[] | undefined;
  pinnedCount?: number;
}

interface ToggleCollapsedIdListArgs {
  current: string[];
  id: string;
}

interface SelectedThreadSidebarExpansionArgs {
  organizationMode: SidebarOrganizationMode;
  isPinned: boolean;
  selectedThread: ThreadListEntry;
  sidebarProjectId: string;
}

interface SelectedThreadSidebarExpansion {
  sectionKey?: string;
  machineKey?: string;
  harnessKey?: string;
  projectId?: string;
  sidebarSectionId?: CollapsibleSidebarSectionId;
}

type ToggleCollapsedId = (id: string) => void;
type ToggleCollapsedSidebarSectionId = (
  id: CollapsibleSidebarSectionId,
) => void;
type OpenSidebarMenu = `displayOptions:${string}` | null;

function removeCollapsedIds<T extends string>(
  current: T[],
  idsToRemove: ReadonlySet<string>,
): T[] {
  if (idsToRemove.size === 0) {
    return current;
  }
  let removed = false;
  const next = current.filter((id) => {
    if (!idsToRemove.has(id)) {
      return true;
    }
    removed = true;
    return false;
  });
  return removed ? next : current;
}

export function getSelectedThreadSidebarExpansion({
  organizationMode,
  isPinned,
  selectedThread,
  sidebarProjectId,
}: SelectedThreadSidebarExpansionArgs): SelectedThreadSidebarExpansion {
  if (isPinned) {
    return { sidebarSectionId: "pinned" };
  }

  if (organizationMode === "machine") {
    return {
      machineKey: selectedThread.environmentHostId ?? NO_MACHINE_GROUP_KEY,
    };
  }

  if (organizationMode === "harness") {
    return { harnessKey: selectedThread.providerId };
  }

  if (organizationMode === "chronological") {
    const sectionKey = sectionKeyForThreadSection(
      CHRONOLOGICAL_CONTAINER_ID,
      selectedThread.sectionId,
    );
    return sectionKey ? { sectionKey } : { sidebarSectionId: "threads" };
  }

  if (sidebarProjectId === PERSONAL_PROJECT_ID) {
    return { sidebarSectionId: "threads" };
  }

  return { projectId: sidebarProjectId };
}

function isCollapsibleSidebarSectionId(
  value: string,
): value is CollapsibleSidebarSectionId {
  return value === "pinned" || value === "threads";
}

const EMPTY_PROJECT_THREAD_LIST_STATE: ProjectThreadListState = {
  status: "loading",
};

const EMPTY_PROJECTS: readonly ProjectResponse[] = [];
const EMPTY_THREAD_LIST: ThreadListEntry[] = [];
const EMPTY_SECTION_DEFINITIONS: readonly ThreadSectionResponse[] = [];

function getProjectThreadListState({
  status,
  threads,
  pinnedCount,
}: ProjectThreadListStateArgs): ProjectThreadListState {
  switch (status) {
    case "ready":
      return {
        status: "ready",
        threads: threads ?? [],
        ...(pinnedCount ? { pinnedCount } : {}),
      };
    case "unavailable":
      return { status: "unavailable" };
    case "loading":
    case undefined:
      return EMPTY_PROJECT_THREAD_LIST_STATE;
  }
}

function toggleCollapsedIdList({
  current,
  id,
}: ToggleCollapsedIdListArgs): string[] {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  return Array.from(next);
}

function normalizeCollapsedSidebarSectionIds(
  sectionIds: readonly CollapsibleSidebarSectionId[],
): CollapsibleSidebarSectionId[] {
  const seen = new Set<CollapsibleSidebarSectionId>();
  const normalized: CollapsibleSidebarSectionId[] = [];
  for (const sectionId of sectionIds) {
    if (!isCollapsibleSidebarSectionId(sectionId) || seen.has(sectionId)) {
      continue;
    }
    seen.add(sectionId);
    normalized.push(sectionId);
  }
  return normalized;
}

function compareByTitleAscending(
  left: ThreadListEntry,
  right: ThreadListEntry,
  resources?: ThreadTitleMentionResources,
): number {
  const leftTitle = getThreadDisplayTitle(left);
  const rightTitle = getThreadDisplayTitle(right);
  const titleDelta = (
    resources ? resolveThreadTitleDisplayText(leftTitle, resources) : leftTitle
  ).localeCompare(
    resources
      ? resolveThreadTitleDisplayText(rightTitle, resources)
      : rightTitle,
  );
  if (titleDelta !== 0) {
    return titleDelta;
  }

  return left.id.localeCompare(right.id);
}

function getProjectThreadItemAlphaLabel(
  item: ProjectThreadItem,
  resources?: ThreadTitleMentionResources,
): string {
  let label: string;
  switch (item.kind) {
    case "thread":
      label = getThreadDisplayTitle(item.node.thread);
      break;
    case "section":
      return item.group.name;
  }
  return resources ? resolveThreadTitleDisplayText(label, resources) : label;
}

function compareProjectThreadItemsByTitleAscending(
  left: ProjectThreadItem,
  right: ProjectThreadItem,
  resources?: ThreadTitleMentionResources,
): number {
  const labelDelta = getProjectThreadItemAlphaLabel(
    left,
    resources,
  ).localeCompare(getProjectThreadItemAlphaLabel(right, resources));
  if (labelDelta !== 0) {
    return labelDelta;
  }

  if (left.kind === "thread" && right.kind === "thread") {
    const threadIdDelta = left.node.thread.id.localeCompare(
      right.node.thread.id,
    );
    if (threadIdDelta !== 0) {
      return threadIdDelta;
    }
  }

  const kindDelta = left.kind.localeCompare(right.kind);
  if (kindDelta !== 0) {
    return kindDelta;
  }

  return left.kind === "section" && right.kind === "section"
    ? left.group.key.localeCompare(right.group.key)
    : 0;
}

export function getSidebarThreadComparator(
  sort: SidebarChronologicalSort,
  resources?: ThreadTitleMentionResources,
  direction: "default" | "ascending" | "descending" = "default",
): ThreadComparator {
  const normalizedSort = sort === "none" ? "updated" : sort;

  const multiplier =
    direction === "default" ||
    direction === (normalizedSort === "alpha" ? "ascending" : "descending")
      ? 1
      : -1;
  if (normalizedSort === "alpha") {
    const comparator: ThreadComparator = (left, right) =>
      multiplier * compareByTitleAscending(left, right, resources);
    comparator.compareItems = (left, right) =>
      multiplier *
      compareProjectThreadItemsByTitleAscending(left, right, resources);
    return comparator;
  }
  const base =
    normalizedSort === "created"
      ? compareByCreatedAtDescending
      : compareStandardThreads;
  return (left, right) => {
    const comparison = base(left, right);
    if (
      normalizedSort === "updated" &&
      isThreadRunning(left) !== isThreadRunning(right)
    ) {
      return comparison;
    }
    return multiplier * comparison;
  };
}

function getSectionMutationErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  if (error instanceof BbHttpError && error.code === "section_name_conflict") {
    return "Section name already exists.";
  }
  return getMutationErrorMessage({ error, fallbackMessage });
}

export function ProjectListNavigationLoadingState() {
  return (
    <div
      aria-label="Loading sidebar navigation"
      className="space-y-1.5 px-2 pt-1"
    >
      <ProjectListNavigationLoadingRow textWidthClassName="w-2/3" />
      <ProjectListNavigationLoadingRow textWidthClassName="w-1/2" />
    </div>
  );
}

function ProjectListNavigationLoadingRow({
  textWidthClassName,
}: ProjectListNavigationLoadingRowProps) {
  return (
    <div
      data-sidebar="navigation-loading-row"
      className="flex h-7 items-center gap-2 rounded-md"
    >
      <Skeleton className="size-4 shrink-0 rounded-md bg-sidebar-border/60" />
      <Skeleton
        className={cn(
          "h-3 rounded-sm bg-sidebar-border/50",
          textWidthClassName,
        )}
      />
    </div>
  );
}

export function ProjectListNewThreadAction({
  splitEnabled = false,
  newThreadSplit,
  onNewChat,
}: ProjectListNewThreadActionProps) {
  const isNewChatDisabled = !onNewChat;
  const newThreadShortcut = useAppCommandShortcut("thread.new");
  const newThreadSplitIndicator = usePaneContentSplitIndicator(
    { kind: "new-thread" },
    splitEnabled,
  );

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(PROJECT_LIST_ACTION_BUTTON_CLASS, "w-full")}
      onPointerDown={newThreadSplit?.onPointerDown}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) {
          newThreadSplit?.openInSplit();
          return;
        }
        onNewChat?.();
      }}
      disabled={isNewChatDisabled}
      aria-label={
        newThreadShortcut
          ? `New thread (${newThreadShortcut.label})`
          : "New thread"
      }
      aria-keyshortcuts={newThreadShortcut?.ariaKeyshortcuts}
    >
      <Icon name="MessageSquarePlus" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-left">New thread</span>
        {newThreadSplitIndicator.miniMap ? (
          <SplitPaneMiniMap
            slots={newThreadSplitIndicator.miniMap}
            label="New thread — open in split"
          />
        ) : null}
        <AppCommandShortcutHint shortcut={newThreadShortcut} />
      </span>
    </Button>
  );
}

export function ProjectListSearchThreadsAction({
  onSearchThreads,
}: ProjectListSearchThreadsActionProps) {
  const commandRunner = useAppCommandRunner();
  const threadSearchShortcut = useAppCommandShortcut("thread.search");

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "group/search-threads w-full pr-1",
      )}
      onClick={(event) => {
        onSearchThreads?.();
        commandRunner.dispatch("thread.search", event.currentTarget);
      }}
      aria-label={
        threadSearchShortcut
          ? `Search threads (${threadSearchShortcut.label})`
          : "Search threads"
      }
      aria-keyshortcuts={threadSearchShortcut?.ariaKeyshortcuts}
    >
      <Icon name="Search" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-left">
          Search threads
        </span>
        {threadSearchShortcut ? (
          <span className="inline-flex shrink-0 opacity-0 transition-opacity group-hover/search-threads:opacity-100 group-focus-visible/search-threads:opacity-100 max-md:pointer-coarse:hidden">
            <AppCommandShortcutPill shortcut={threadSearchShortcut} />
          </span>
        ) : null}
      </span>
    </Button>
  );
}

export function ProjectListShell({ children }: ProjectListShellProps) {
  return (
    <SidebarStickyStack data-sidebar-sticky-density="compact-actions">
      <SidebarGroupContent>{children}</SidebarGroupContent>
    </SidebarStickyStack>
  );
}

interface BuiltInSectionRenderState {
  collapsedSectionIds: ReadonlySet<CollapsibleSidebarSectionId>;
  onToggleCollapsed: (id: CollapsibleSidebarSectionId) => void;
  showPinnedSection: boolean;
}

interface ActiveSidebarModeSectionsProps {
  mode: SidebarOrganizationMode;
  renderChronological: () => ReactNode;
  renderGrouped: (mode: GroupedSidebarMode) => ReactNode;
  renderProject: () => ReactNode;
}

export function ActiveSidebarModeSections({
  mode,
  renderChronological,
  renderGrouped,
  renderProject,
}: ActiveSidebarModeSectionsProps) {
  if (mode === "machine" || mode === "harness") return renderGrouped(mode);
  if (mode === "chronological") return renderChronological();
  return renderProject();
}

function useSidebarProgressiveDisclosureEnabled(): boolean {
  return (
    useSystemConfig().data?.experiments.sidebarProgressiveDisclosure ?? false
  );
}

interface GroupedModePinnedProps {
  pinnedReorderPending: boolean;
  pinnedRootNodes: readonly ProjectThreadNode[];
  pinnedThreads: readonly ThreadListEntry[];
  onReorderPinnedThread: NonNullable<
    PinnedThreadTreeProps["onReorderPinnedRoot"]
  >;
}

function buildGroupSectionItem(
  id: string,
  key: SidebarSectionId,
  name: string,
  threads: readonly ThreadListEntry[],
  compareThreads: ThreadComparator,
  draftThreadIds: ReadonlySet<string>,
): Extract<ProjectThreadItem, { kind: "section" }> {
  const items = buildProjectThreadGroups(
    threads,
    compareThreads,
    draftThreadIds,
  );
  return {
    kind: "section",
    group: {
      id,
      key,
      name,
      items,
      threadCount: getProjectThreadItemDescendants(items).length,
      activity: getCollapsedChildActivity(threads, draftThreadIds),
    },
  };
}

function useGroupedModeThreadDnd({
  collapsedThreadIds,
  compareThreadsForSection,
  draftThreadIds,
  onToggleThreadCollapsed,
  order,
  onOrderChange,
  pinned,
  projectMoves = false,
  rootItems,
  threads,
}: {
  collapsedThreadIds: Set<string>;
  compareThreadsForSection: SidebarSectionComparator;
  draftThreadIds: ReadonlySet<string>;
  onToggleThreadCollapsed: ToggleCollapsedId;
  order: readonly SidebarSectionId[];
  onOrderChange: (order: SidebarSectionId[]) => void;
  pinned: GroupedModePinnedProps;
  projectMoves?: boolean;
  rootItems: readonly ProjectThreadItem[];
  threads: readonly ThreadListEntry[];
}) {
  const expandThread = useCallback(
    (threadId: string) => {
      if (collapsedThreadIds.has(threadId)) {
        onToggleThreadCollapsed(threadId);
      }
    },
    [collapsedThreadIds, onToggleThreadCollapsed],
  );
  const threadDnd = useSectionThreadDnd({
    containerId: CHRONOLOGICAL_CONTAINER_ID,
    enabled: true,
    rootItems,
    topLevelSectionOrder: order,
    onTopLevelSectionOrderChange: onOrderChange,
    onExpandThread: expandThread,
    groups: true,
    projectMoves,
    pinnedReorderPending: pinned.pinnedReorderPending,
    pinnedThreads: pinned.pinnedThreads,
    pinnedRootNodes: pinned.pinnedRootNodes,
    onReorderPinnedThread: pinned.onReorderPinnedThread,
  });
  return useRenderedSectionThreadDnd({
    compareThreadsForSection,
    draftThreadIds,
    groups: true,
    pinnedRootNodes: pinned.pinnedRootNodes,
    pinnedThreads: pinned.pinnedThreads,
    rootItems,
    sectionDnd: threadDnd,
    sections: EMPTY_SECTION_DEFINITIONS,
    threads,
  });
}

interface ProjectModeSectionsProps
  extends BuiltInSectionRenderState, GroupedModePinnedProps {
  collapsedThreadIds: Set<string>;
  compareThreadsForSection: SidebarSectionComparator;
  draftThreadIds: ReadonlySet<string>;
  effectivePinnedThreadIds: ReadonlySet<string>;
  onCreateProjectThread: (projectId: string) => void;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: ToggleCollapsedId;
  pinnedSection: BuiltInSidebarSectionOptions;
  projects: readonly ProjectResponse[];
  selectedThreadId?: string;
  status: ConnectionAwareQueryStatus;
  threads: ThreadListEntry[];
  threadsSection: Omit<BuiltInSidebarSectionOptions, "content">;
}

function ProjectModeSections({
  collapsedSectionIds,
  collapsedThreadIds,
  compareThreadsForSection,
  draftThreadIds,
  effectivePinnedThreadIds,
  onCreateProjectThread,
  onProjectSelect,
  onToggleCollapsed,
  onToggleThreadCollapsed,
  pinnedReorderPending,
  pinnedRootNodes,
  pinnedSection,
  pinnedThreads,
  onReorderPinnedThread,
  projects,
  selectedThreadId,
  showPinnedSection,
  status,
  threads,
  threadsSection,
}: ProjectModeSectionsProps) {
  const progressiveDisclosureEnabled = useSidebarProgressiveDisclosureEnabled();
  const [collapsedProjectIdList, setCollapsedProjectIdList] = useAtom(
    collapsedProjectIdsAtom,
  );
  const collapsedProjectIds = useMemo(
    () => new Set(collapsedProjectIdList),
    [collapsedProjectIdList],
  );
  const toggleProjectCollapsed = useCallback<ToggleCollapsedId>(
    (projectId) => {
      setCollapsedProjectIdList((current) =>
        toggleCollapsedIdList({ current, id: projectId }),
      );
    },
    [setCollapsedProjectIdList],
  );
  const primaryHost = usePrimaryHost();
  const workHostId =
    primaryHost?.status === "connected" ? primaryHost.id : null;
  const localSourceTargets = useMemo(() => {
    if (!workHostId) return [];
    const targets: LocalSourcePathTarget[] = [];
    for (const project of projects) {
      const source = findLocalPathProjectSourceForHost(
        project.sources,
        workHostId,
      );
      if (source) {
        targets.push({ path: source.path, projectId: project.id });
      }
    }
    return targets;
  }, [projects, workHostId]);
  const localSourcePathsByProjectId = useMemo(
    () =>
      new Map(
        localSourceTargets.map((target) => [target.projectId, target.path]),
      ),
    [localSourceTargets],
  );
  const localPaths = useMemo(
    () => localSourceTargets.map((target) => target.path),
    [localSourceTargets],
  );
  const pathExistence = useHostPathExistence(workHostId, localPaths);
  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, ThreadListEntry[]>();
    const resolveSidebarProjectId = createSidebarProjectIdResolver(
      new Map(threads.map((thread) => [thread.id, thread])),
    );
    const pinnedCounts = new Map<string, number>();
    for (const thread of threads) {
      const sidebarProjectId = resolveSidebarProjectId(thread);
      if (effectivePinnedThreadIds.has(thread.id)) {
        pinnedCounts.set(
          sidebarProjectId,
          (pinnedCounts.get(sidebarProjectId) ?? 0) + 1,
        );
        continue;
      }
      const existing = grouped.get(sidebarProjectId);
      if (existing) {
        existing.push(thread);
      } else {
        grouped.set(sidebarProjectId, [thread]);
      }
    }
    return { grouped, pinnedCounts };
  }, [effectivePinnedThreadIds, threads]);
  const projectRows = useMemo<ProjectListRowModel[]>(
    () =>
      projects.map((project) => ({
        project,
        threadListState: getProjectThreadListState({
          status,
          threads: threadsByProject.grouped.get(project.id),
          pinnedCount: threadsByProject.pinnedCounts.get(project.id),
        }),
        isActive: false,
        isLocalPathInvalid: isHostPathMissing(
          pathExistence,
          localSourcePathsByProjectId.get(project.id),
        ),
      })),
    [
      localSourcePathsByProjectId,
      pathExistence,
      projects,
      status,
      threadsByProject,
    ],
  );
  const projectSectionIds = useMemo(
    () =>
      projectRows.map((row) =>
        buildSidebarEntitySectionId("project", row.project.id),
      ),
    [projectRows],
  );
  const projectRowsBySectionId = useMemo(() => {
    const rows = new Map<SidebarSectionId, ProjectListRowModel>();
    for (const row of projectRows) {
      rows.set(buildSidebarEntitySectionId("project", row.project.id), row);
    }
    return rows;
  }, [projectRows]);
  const personalThreads = useMemo(
    () =>
      threadsByProject.grouped
        .get(PERSONAL_PROJECT_ID)
        ?.filter(isSidebarProjectThread) ?? EMPTY_THREAD_LIST,
    [threadsByProject],
  );
  const { onOrderChange, order, persistedOrder } = useSidebarModeSectionOrder({
    mode: "project",
    entitySectionIds: projectSectionIds,
    hasThreadsSection: personalThreads.length > 0 || projectRows.length === 0,
    showPinnedSection,
  });
  const reorderDisabled = order.length < 2;
  const compareThreads = compareThreadsForSection("threads");
  const personalItems = useMemo(
    () =>
      buildProjectThreadGroups(personalThreads, compareThreads, draftThreadIds),
    [compareThreads, draftThreadIds, personalThreads],
  );
  const projectGroups = useMemo(
    () =>
      projectRows.map((row) => {
        const sectionId = buildSidebarEntitySectionId(
          "project",
          row.project.id,
        );
        return buildGroupSectionItem(
          row.project.id,
          sectionId,
          row.project.name,
          row.threadListState.status === "ready"
            ? row.threadListState.threads
            : EMPTY_THREAD_LIST,
          compareThreadsForSection(sectionId),
          draftThreadIds,
        );
      }),
    [compareThreadsForSection, draftThreadIds, projectRows],
  );
  const projectItemsByProjectId = useMemo(
    () =>
      new Map(
        projectGroups.map((group) => [group.group.id, group.group.items]),
      ),
    [projectGroups],
  );
  const groupRootItems = useMemo<ProjectThreadItem[]>(
    () => [...personalItems, ...projectGroups],
    [personalItems, projectGroups],
  );
  const nonPinnedThreads = useMemo(
    () => threads.filter((thread) => !effectivePinnedThreadIds.has(thread.id)),
    [effectivePinnedThreadIds, threads],
  );
  const threadDnd = useGroupedModeThreadDnd({
    collapsedThreadIds,
    compareThreadsForSection,
    draftThreadIds,
    onToggleThreadCollapsed,
    order: persistedOrder,
    onOrderChange,
    pinned: {
      pinnedReorderPending,
      pinnedRootNodes,
      pinnedThreads,
      onReorderPinnedThread,
    },
    projectMoves: true,
    rootItems: groupRootItems,
    threads: nonPinnedThreads,
  });
  const builtInSections: BuiltInSidebarSectionOptionsById = {
    pinned: pinnedSection,
    threads: {
      ...threadsSection,
      activity: getCollapsedChildActivity(personalThreads, draftThreadIds),
      collapsedThreads: personalThreads,
      content: (
        <ProjectThreadTree
          projectId={PERSONAL_PROJECT_ID}
          dndParentKey={CHRONOLOGICAL_CONTAINER_ID}
          rootItems={personalItems}
          threadListState={getProjectThreadListState({
            status,
            threads: personalThreads,
          })}
          progressiveDisclosureEnabled={progressiveDisclosureEnabled}
          selectedThreadId={selectedThreadId}
          collapsedThreadIds={collapsedThreadIds}
          compareThreads={compareThreads}
          variant="section"
          onProjectSelect={onProjectSelect}
          onToggleThreadCollapsed={onToggleThreadCollapsed}
        />
      ),
    },
  };

  return (
    <ReorderableSidebarSectionOrderList order={order} threadDnd={threadDnd}>
      {(sectionId, consumeClickSuppression) => {
        const builtInSection = renderBuiltInSidebarSection({
          sectionId,
          sections: builtInSections,
          disabled: reorderDisabled,
          collapsedSectionIds,
          onToggleCollapsed,
          consumeClickSuppression,
          showPinnedSection,
        });
        if (builtInSection !== undefined) return builtInSection;
        const row = projectRowsBySectionId.get(sectionId);
        if (!row) return null;
        return (
          <SortableProjectRow
            key={sectionId}
            sortableId={sectionId}
            project={row.project}
            rootItems={projectItemsByProjectId.get(row.project.id)}
            threadListState={row.threadListState}
            progressiveDisclosureEnabled={progressiveDisclosureEnabled}
            selectedThreadId={selectedThreadId}
            isActive={row.isActive}
            isCollapsed={collapsedProjectIds.has(row.project.id)}
            collapsedThreadIds={collapsedThreadIds}
            compareThreads={compareThreadsForSection(sectionId)}
            isLocalPathInvalid={row.isLocalPathInvalid}
            onProjectSelect={onProjectSelect}
            onCreateProjectThread={onCreateProjectThread}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            onToggleThreadCollapsed={onToggleThreadCollapsed}
            reorderDisabled={reorderDisabled}
            consumeProjectClickSuppression={consumeClickSuppression}
          />
        );
      }}
    </ReorderableSidebarSectionOrderList>
  );
}

interface SectionModeSectionsProps extends BuiltInSectionRenderState {
  collapsedThreadIds: Set<string>;
  compareThreadsForSection: SidebarSectionComparator;
  sections: readonly SidebarSectionDefinition[];
  onCreateThreadInSection: (sectionId: string) => void;
  onProjectSelect?: () => void;
  onRemoveSection: (section: SidebarSectionDefinition) => void;
  onRenameSection: (section: SidebarSectionDefinition) => void;
  onToggleThreadCollapsed: ToggleCollapsedId;
  pinnedSection: BuiltInSidebarSectionOptions;
  pinnedReorderPending: boolean;
  pinnedRootNodes: readonly ProjectThreadNode[];
  pinnedThreads: readonly ThreadListEntry[];
  onReorderPinnedThread: NonNullable<
    PinnedThreadTreeProps["onReorderPinnedRoot"]
  >;
  selectedThreadId?: string;
  status: ConnectionAwareQueryStatus;
  threads: ThreadListEntry[];
  threadsSection: Omit<BuiltInSidebarSectionOptions, "content">;
  effectivePinnedThreadIds: ReadonlySet<string>;
}

function SectionModeSections({
  collapsedSectionIds,
  collapsedThreadIds,
  compareThreadsForSection,
  effectivePinnedThreadIds,
  sections,
  onCreateThreadInSection,
  onProjectSelect,
  onRemoveSection,
  onRenameSection,
  onToggleCollapsed,
  onToggleThreadCollapsed,
  pinnedSection,
  pinnedReorderPending,
  pinnedRootNodes,
  pinnedThreads,
  onReorderPinnedThread,
  selectedThreadId,
  showPinnedSection,
  status,
  threads,
  threadsSection,
}: SectionModeSectionsProps) {
  const nonPinnedThreads = useMemo(
    () => threads.filter((thread) => !effectivePinnedThreadIds.has(thread.id)),
    [effectivePinnedThreadIds, threads],
  );
  const threadListState = getProjectThreadListState({
    status,
    threads: nonPinnedThreads,
  });
  const threadSectionIds = useMemo(
    () =>
      sections.map((section) =>
        buildSidebarEntitySectionId("section", section.id),
      ),
    [sections],
  );
  const { onOrderChange, order } = useSidebarModeSectionOrder({
    mode: "chronological",
    entitySectionIds: threadSectionIds,
    showPinnedSection,
  });
  const moveDestinations = useMemo<ThreadSectionMoveDestination[]>(() => {
    const destinationsBySidebarId = new Map(
      sections.map((section) => [
        buildSidebarEntitySectionId("section", section.id),
        { label: section.name, sectionId: section.id },
      ]),
    );
    return order.flatMap<ThreadSectionMoveDestination>((sectionId) => {
      if (sectionId === "threads") {
        return [{ label: threadsSection.label, sectionId: null }];
      }
      const destination = destinationsBySidebarId.get(sectionId);
      return destination ? [destination] : [];
    });
  }, [order, sections, threadsSection.label]);

  return (
    <ThreadSectionMoveProvider destinations={moveDestinations}>
      <ChronologicalSectionThreadSections
        threadListState={threadListState}
        compareThreadsForSection={compareThreadsForSection}
        sections={sections}
        selectedThreadId={selectedThreadId}
        collapsedThreadIds={collapsedThreadIds}
        onProjectSelect={onProjectSelect}
        onCreateThreadInSection={onCreateThreadInSection}
        onRenameSection={onRenameSection}
        onRemoveSection={onRemoveSection}
        onToggleThreadCollapsed={onToggleThreadCollapsed}
        topLevelSectionOrder={order}
        onTopLevelSectionOrderChange={onOrderChange}
        pinnedReorderPending={pinnedReorderPending}
        pinnedRootNodes={pinnedRootNodes}
        pinnedThreads={pinnedThreads}
        onReorderPinnedThread={onReorderPinnedThread}
        builtInSections={{
          pinned: pinnedSection,
          threads: threadsSection,
          collapsedSectionIds,
          onToggleCollapsed,
        }}
      />
    </ThreadSectionMoveProvider>
  );
}

type GroupedSidebarMode = "machine" | "harness";

const GROUPED_MODE_COLLAPSED_ATOMS = {
  machine: sidebarCollapsedMachinesAtom,
  harness: sidebarCollapsedHarnessesAtom,
} satisfies Record<GroupedSidebarMode, typeof sidebarCollapsedMachinesAtom>;

interface GroupedModeSectionsProps
  extends BuiltInSectionRenderState, GroupedModePinnedProps {
  collapsedThreadIds: Set<string>;
  compareThreadsForSection: SidebarSectionComparator;
  draftThreadIds: ReadonlySet<string>;
  effectivePinnedThreadIds: ReadonlySet<string>;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: ToggleCollapsedId;
  pinnedSection: BuiltInSidebarSectionOptions;
  renderSectionDisplayOptions: (
    sectionId: SidebarSectionId,
    label: string,
  ) => ReactNode;
  isSectionDisplayOptionsOpen: (sectionId: SidebarSectionId) => boolean;
  mode: GroupedSidebarMode;
  selectedThreadId?: string;
  status: ConnectionAwareQueryStatus;
  threads: ThreadListEntry[];
  threadsSection: Omit<BuiltInSidebarSectionOptions, "content">;
}

export function GroupedModeSections({
  collapsedSectionIds,
  collapsedThreadIds,
  compareThreadsForSection,
  draftThreadIds,
  effectivePinnedThreadIds,
  isSectionDisplayOptionsOpen,
  mode,
  onProjectSelect,
  onToggleCollapsed,
  onToggleThreadCollapsed,
  pinnedReorderPending,
  pinnedRootNodes,
  pinnedSection,
  pinnedThreads,
  onReorderPinnedThread,
  renderSectionDisplayOptions,
  selectedThreadId,
  showPinnedSection,
  status,
  threads,
  threadsSection,
}: GroupedModeSectionsProps) {
  const progressiveDisclosureEnabled = useSidebarProgressiveDisclosureEnabled();
  const { data: hosts } = useHosts({ enabled: mode === "machine" });
  const { data: providers } = useSystemProviders({
    enabled: mode === "harness",
  });
  const [collapsedGroupKeyList, setCollapsedGroupKeyList] = useAtom(
    GROUPED_MODE_COLLAPSED_ATOMS[mode],
  );
  const collapsedGroupKeys = useMemo(
    () => new Set(collapsedGroupKeyList),
    [collapsedGroupKeyList],
  );
  const toggleGroupCollapsed = useCallback<ToggleCollapsedId>(
    (groupKey) => {
      setCollapsedGroupKeyList((current) =>
        toggleCollapsedIdList({ current, id: groupKey }),
      );
    },
    [setCollapsedGroupKeyList],
  );
  const nonPinnedThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          !effectivePinnedThreadIds.has(thread.id) &&
          isSidebarProjectThread(thread),
      ),
    [effectivePinnedThreadIds, threads],
  );
  const allThreadsListState = getProjectThreadListState({
    status,
    threads: nonPinnedThreads,
  });
  const groupSections = useMemo(
    () =>
      (mode === "machine"
        ? buildMachineThreadGroups(nonPinnedThreads, hosts ?? [])
        : buildHarnessThreadGroups(nonPinnedThreads, providers ?? [])
      ).map((group) => ({
        activity: getCollapsedChildActivity(group.threads, draftThreadIds),
        key: group.key,
        label: group.label,
        threadListState: {
          status: "ready",
          threads: group.threads,
        } satisfies ProjectThreadListState,
      })),
    [draftThreadIds, hosts, mode, nonPinnedThreads, providers],
  );
  const groupSectionIds = useMemo(
    () =>
      groupSections.map((section) =>
        buildSidebarEntitySectionId(mode, section.key),
      ),
    [groupSections, mode],
  );
  const groupSectionsById = useMemo(
    () =>
      new Map(
        groupSections.map((section) => [
          buildSidebarEntitySectionId(mode, section.key),
          section,
        ]),
      ),
    [groupSections, mode],
  );
  const { onOrderChange, order, persistedOrder } = useSidebarModeSectionOrder({
    mode,
    entitySectionIds: groupSectionIds,
    hasThreadsSection: groupSections.length === 0,
    showPinnedSection,
  });
  const reorderDisabled = order.length < 2;
  const compareThreads = compareThreadsForSection("threads");
  const allThreadItems = useMemo(
    () =>
      groupSections.length === 0
        ? buildProjectThreadGroups(
            nonPinnedThreads,
            compareThreads,
            draftThreadIds,
          )
        : [],
    [compareThreads, draftThreadIds, groupSections.length, nonPinnedThreads],
  );
  const groupItems = useMemo(
    () =>
      groupSections.map((section) => {
        const sectionId = buildSidebarEntitySectionId(mode, section.key);
        return buildGroupSectionItem(
          section.key,
          sectionId,
          section.label,
          section.threadListState.threads,
          compareThreadsForSection(sectionId),
          draftThreadIds,
        );
      }),
    [compareThreadsForSection, draftThreadIds, groupSections, mode],
  );
  const groupItemsBySectionId = useMemo(
    () =>
      new Map(groupItems.map((group) => [group.group.key, group.group.items])),
    [groupItems],
  );
  const groupRootItems = useMemo<ProjectThreadItem[]>(
    () => [...allThreadItems, ...groupItems],
    [allThreadItems, groupItems],
  );
  const threadDnd = useGroupedModeThreadDnd({
    collapsedThreadIds,
    compareThreadsForSection,
    draftThreadIds,
    onToggleThreadCollapsed,
    order: persistedOrder,
    onOrderChange,
    pinned: {
      pinnedReorderPending,
      pinnedRootNodes,
      pinnedThreads,
      onReorderPinnedThread,
    },
    rootItems: groupRootItems,
    threads: nonPinnedThreads,
  });
  const builtInSections: BuiltInSidebarSectionOptionsById = {
    pinned: pinnedSection,
    threads: {
      ...threadsSection,
      activity: getCollapsedChildActivity(nonPinnedThreads, draftThreadIds),
      collapsedThreads: nonPinnedThreads,
      content: (
        <ProjectThreadTree
          dndParentKey={CHRONOLOGICAL_CONTAINER_ID}
          rootItems={allThreadItems}
          threadListState={allThreadsListState}
          progressiveDisclosureEnabled={progressiveDisclosureEnabled}
          compareThreads={compareThreads}
          variant="section"
          selectedThreadId={selectedThreadId}
          collapsedThreadIds={collapsedThreadIds}
          onProjectSelect={onProjectSelect}
          onToggleThreadCollapsed={onToggleThreadCollapsed}
        />
      ),
    },
  };

  return (
    <ReorderableSidebarSectionOrderList order={order} threadDnd={threadDnd}>
      {(sectionId, consumeClickSuppression) => {
        const builtInSection = renderBuiltInSidebarSection({
          sectionId,
          sections: builtInSections,
          disabled: reorderDisabled,
          collapsedSectionIds,
          onToggleCollapsed,
          consumeClickSuppression,
          showPinnedSection,
        });
        if (builtInSection !== undefined) return builtInSection;
        const section = groupSectionsById.get(sectionId);
        if (!section) return null;
        return (
          <SortableSidebarSection
            key={sectionId}
            id={sectionId}
            label={section.label}
            disabled={reorderDisabled}
            actions={renderSectionDisplayOptions(sectionId, section.label)}
            actionsOpen={isSectionDisplayOptionsOpen(sectionId)}
            actionsMobileAlways
            collapsedActivity={section.activity}
            collapsedThreads={section.threadListState.threads}
            collapseControl={{
              isCollapsed: collapsedGroupKeys.has(section.key),
              onToggleCollapsed: () => toggleGroupCollapsed(section.key),
            }}
            consumeClickSuppression={consumeClickSuppression}
          >
            <ProjectThreadTree
              dndParentKey={sectionId}
              rootItems={groupItemsBySectionId.get(sectionId)}
              threadListState={section.threadListState}
              progressiveDisclosureEnabled={progressiveDisclosureEnabled}
              compareThreads={compareThreadsForSection(sectionId)}
              variant="section"
              selectedThreadId={selectedThreadId}
              collapsedThreadIds={collapsedThreadIds}
              onProjectSelect={onProjectSelect}
              onToggleThreadCollapsed={onToggleThreadCollapsed}
            />
          </SortableSidebarSection>
        );
      }}
    </ReorderableSidebarSectionOrderList>
  );
}

function ProjectListComponent({
  onNewProject,
  onProjectSelect,
  isCreatingProject = false,
}: ProjectListProps) {
  const navigate = useNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const sidebarNavigationQuery = useSidebarNavigation();
  const sidebarNavigation = sidebarNavigationQuery.data;
  const sections = sidebarNavigation?.sections ?? EMPTY_SECTION_DEFINITIONS;
  const projects = useMemo(
    () => sidebarNavigation?.projects.map(stripProjectThreads),
    [sidebarNavigation],
  );
  const threads = useMemo(() => {
    if (!sidebarNavigation) {
      return [];
    }
    const sidebarThreads: ThreadListEntry[] = [];
    for (const project of sidebarNavigation.projects) {
      sidebarThreads.push(...project.threads);
    }
    sidebarThreads.push(...sidebarNavigation.personalProject.threads);
    return sidebarThreads;
  }, [sidebarNavigation]);
  const draftThreadIds = usePromptDraftInputThreadIds(threads);
  const titleMentionResources = useThreadTitleMentionResources();
  const threadById = useMemo(() => {
    const map = new Map<string, ThreadListEntry>();
    for (const thread of threads) {
      map.set(thread.id, thread);
    }
    return map;
  }, [threads]);
  const uiPreferencesReady = useUiPreferencesReady();
  const projectsState = useConnectionAwareQueryState({
    hasResolvedData: projects !== undefined,
    isFetching: sidebarNavigationQuery.isFetching,
    isLoadingError: sidebarNavigationQuery.isLoadingError,
    isRecoverableLoadingError: isTransientReadError(
      sidebarNavigationQuery.error,
    ),
  });
  const { threadId: selectedThreadId } = useRouteState();
  const {
    isPending: isPinnedReorderPending,
    mutate: reorderPinnedThreadMutate,
  } = useReorderPinnedThread();
  const {
    isPending: isUpdateThreadSectionPending,
    mutate: updateThreadSectionMutate,
  } = useUpdateThreadSection();
  const {
    isPending: isDeleteThreadSectionPending,
    mutate: deleteThreadSectionMutate,
  } = useDeleteThreadSection();
  const handleReorderPinnedRoot = useCallback<
    NonNullable<PinnedThreadTreeProps["onReorderPinnedRoot"]>
  >(
    (request, callbacks) => {
      reorderPinnedThreadMutate(
        {
          id: request.itemId,
          previousThreadId: request.previousItemId,
          nextThreadId: request.nextItemId,
        },
        {
          onSettled: callbacks.onSettled,
        },
      );
    },
    [reorderPinnedThreadMutate],
  );
  const openRootCompose = useCallback(
    (sectionId?: string) => {
      onProjectSelect?.();
      navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: true,
          ...(sectionId ? { sectionId } : {}),
        },
      });
    },
    [navigate, onProjectSelect],
  );
  const handleCreateProjectThread = useCallback(
    (projectId: string) => {
      setRootComposeProjectId(projectId);
      openRootCompose();
    },
    [openRootCompose, setRootComposeProjectId],
  );
  const handleCreateProjectlessThread = useCallback(
    (sectionId?: string) => {
      setRootComposeProjectId(PERSONAL_PROJECT_ID);
      openRootCompose(sectionId);
    },
    [openRootCompose, setRootComposeProjectId],
  );
  const [sectionRenameErrorMessage, setSectionRenameErrorMessage] = useState<
    string | null
  >(null);
  const sectionRenameDialog = useDialogState<ThreadSectionRenameDialogTarget>();
  const sectionDeleteDialog = useDialogState<SidebarSectionDefinition>();
  const handleOpenRenameThreadSection = useCallback(
    (section: SidebarSectionDefinition) => {
      setSectionRenameErrorMessage(null);
      sectionRenameDialog.onOpen({ id: section.id, name: section.name });
    },
    [sectionRenameDialog],
  );
  const handleRenameThreadSection = useCallback(
    (id: string, name: string) => {
      setSectionRenameErrorMessage(null);
      updateThreadSectionMutate(
        { id, name },
        {
          onSuccess: () => sectionRenameDialog.onClose(),
          onError: (error) =>
            setSectionRenameErrorMessage(
              getSectionMutationErrorMessage(
                error,
                "Failed to rename section.",
              ),
            ),
        },
      );
    },
    [sectionRenameDialog, updateThreadSectionMutate],
  );
  const handleRemoveThreadSection = useCallback(
    (section: SidebarSectionDefinition) => {
      sectionDeleteDialog.onOpen(section);
    },
    [sectionDeleteDialog],
  );
  const handleConfirmRemoveThreadSection = useCallback(() => {
    const section = sectionDeleteDialog.target;
    if (!section) {
      return;
    }
    deleteThreadSectionMutate(
      { id: section.id },
      { onSuccess: () => sectionDeleteDialog.onClose() },
    );
  }, [deleteThreadSectionMutate, sectionDeleteDialog]);
  const handleSectionDeleteDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return;
      }
      sectionDeleteDialog.onClose();
    },
    [sectionDeleteDialog],
  );
  const handleRenameThreadSectionOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setSectionRenameErrorMessage(null);
      }
      sectionRenameDialog.onOpenChange(open);
    },
    [sectionRenameDialog],
  );
  const setCollapsedProjectIdList = useSetAtom(collapsedProjectIdsAtom);
  const { collapsedThreadIds, expandThreads, toggleThreadCollapsed } =
    useThreadCollapse(threads);
  const setCollapsedMachineKeyList = useSetAtom(sidebarCollapsedMachinesAtom);
  const setCollapsedHarnessKeyList = useSetAtom(sidebarCollapsedHarnessesAtom);
  const [collapsedSidebarSectionIdList, setCollapsedSidebarSectionIdList] =
    useAtom(collapsedSidebarSectionIdsAtom);
  const [openSidebarMenu, setOpenSidebarMenu] = useState<OpenSidebarMenu>(null);
  const setSidebarMenuOpen = useCallback(
    (menu: Exclude<OpenSidebarMenu, null>, open: boolean) => {
      setOpenSidebarMenu((current) =>
        open ? menu : current === menu ? null : current,
      );
    },
    [],
  );
  const renderSectionDisplayOptions = (
    sectionId: SidebarSectionId,
    label: string,
  ) => {
    const menuId = `displayOptions:${sectionId}` as const;
    return (
      <SidebarHeaderControls
        label={label}
        sectionId={sectionId}
        onNewThread={
          sectionId === "pinned"
            ? openRootCompose
            : handleCreateProjectlessThread
        }
        open={openSidebarMenu === menuId}
        onOpenChange={(open) => setSidebarMenuOpen(menuId, open)}
      />
    );
  };
  const isSectionDisplayOptionsOpen = (sectionId: SidebarSectionId) =>
    openSidebarMenu === `displayOptions:${sectionId}`;
  const organizationMode = useAtomValue(sidebarOrganizationModeAtom);
  const [chronologicalSort, setChronologicalSort] = useAtom(
    sidebarChronologicalSortAtom,
  );
  const setCollapsedSectionList = useSetAtom(
    sidebarCollapsedThreadSectionsAtom,
  );
  const getSectionSort = useSidebarSectionSort();
  const comparatorCache = useMemo(
    () => new Map<string, ThreadComparator>(),
    [titleMentionResources],
  );
  const compareThreadsForSection = useCallback<SidebarSectionComparator>(
    (sectionId) => {
      const { sort, direction } = getSectionSort(sectionId);
      const field = sort === "manual" ? "updated" : sort;
      const cacheKey = `${field}:${direction}`;
      let comparator = comparatorCache.get(cacheKey);
      if (!comparator) {
        comparator = getSidebarThreadComparator(
          field,
          titleMentionResources,
          direction,
        );
        comparatorCache.set(cacheKey, comparator);
      }
      return comparator;
    },
    [comparatorCache, getSectionSort, titleMentionResources],
  );
  const isPinnedManualSort = getSectionSort("pinned").sort === "manual";
  const pinnedReorderLocked = isPinnedReorderPending || !isPinnedManualSort;
  const normalizedCollapsedSidebarSectionIds = useMemo(
    () => normalizeCollapsedSidebarSectionIds(collapsedSidebarSectionIdList),
    [collapsedSidebarSectionIdList],
  );
  const collapsedSidebarSectionIds = useMemo(
    () => new Set(normalizedCollapsedSidebarSectionIds),
    [normalizedCollapsedSidebarSectionIds],
  );
  useEffect(() => {
    if (
      haveSameOrder(
        collapsedSidebarSectionIdList,
        normalizedCollapsedSidebarSectionIds,
      )
    ) {
      return;
    }
    setCollapsedSidebarSectionIdList(normalizedCollapsedSidebarSectionIds);
  }, [
    collapsedSidebarSectionIdList,
    normalizedCollapsedSidebarSectionIds,
    setCollapsedSidebarSectionIdList,
  ]);
  useEffect(() => {
    if (chronologicalSort === "none") {
      setChronologicalSort("updated");
    }
  }, [chronologicalSort, setChronologicalSort]);
  const pinnedSidebarState = useMemo(() => {
    const state = buildPinnedSidebarState({ draftThreadIds, threads });
    if (isPinnedManualSort) return state;
    const compare = compareThreadsForSection("pinned");
    return {
      ...state,
      rootNodes: [...state.rootNodes].sort((left, right) =>
        compare(left.thread, right.thread),
      ),
    };
  }, [compareThreadsForSection, draftThreadIds, isPinnedManualSort, threads]);
  const pinnedRootThreads = useMemo(
    () => pinnedSidebarState.rootNodes.map((node) => node.thread),
    [pinnedSidebarState.rootNodes],
  );
  const hasPinnedSection = pinnedSidebarState.rootNodes.length > 0;
  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    const selectedThread = threadById.get(selectedThreadId);
    if (!selectedThread) {
      return;
    }
    if (selectedThread.visibility === "hidden") {
      return;
    }

    const threadIdsToExpand: string[] = [];
    let currentThread: ThreadListEntry | undefined = selectedThread;
    let remainingHops = threadById.size;
    while (currentThread && remainingHops > 0) {
      const parentThreadId = currentThread.parentThreadId;
      if (parentThreadId === null) {
        break;
      }
      const parentThread = threadById.get(parentThreadId);
      if (!parentThread) {
        break;
      }
      threadIdsToExpand.push(parentThread.id);
      currentThread = parentThread;
      remainingHops -= 1;
    }

    expandThreads(threadIdsToExpand);

    const isPinned =
      pinnedSidebarState.effectivePinnedThreadIds.has(selectedThreadId);
    const expansion = getSelectedThreadSidebarExpansion({
      organizationMode,
      isPinned,
      selectedThread,
      sidebarProjectId: resolveSidebarProjectId(selectedThread, threadById),
    });
    if (expansion.machineKey) {
      const machineKey = expansion.machineKey;
      setCollapsedMachineKeyList((current) =>
        removeCollapsedIds(current, new Set([machineKey])),
      );
    }
    if (expansion.harnessKey) {
      const harnessKey = expansion.harnessKey;
      setCollapsedHarnessKeyList((current) =>
        removeCollapsedIds(current, new Set([harnessKey])),
      );
    }
    if (expansion.sectionKey) {
      const sectionKey = expansion.sectionKey;
      setCollapsedSectionList((current) =>
        removeCollapsedIds(current, new Set([sectionKey])),
      );
    }
    if (expansion.projectId) {
      const projectId = expansion.projectId;
      setCollapsedProjectIdList((current) =>
        removeCollapsedIds(current, new Set([projectId])),
      );
    }
    if (expansion.sidebarSectionId) {
      const sidebarSectionId = expansion.sidebarSectionId;
      setCollapsedSidebarSectionIdList((current) =>
        removeCollapsedIds(current, new Set([sidebarSectionId])),
      );
    }
  }, [
    organizationMode,
    pinnedSidebarState.effectivePinnedThreadIds,
    selectedThreadId,
    setCollapsedSectionList,
    setCollapsedMachineKeyList,
    setCollapsedHarnessKeyList,
    setCollapsedProjectIdList,
    setCollapsedSidebarSectionIdList,
    expandThreads,
    threadById,
  ]);
  const toggleSidebarSectionCollapsed =
    useCallback<ToggleCollapsedSidebarSectionId>(
      (sectionId) => {
        setCollapsedSidebarSectionIdList((current) => {
          return toggleCollapsedIdList({ current, id: sectionId }).filter(
            isCollapsibleSidebarSectionId,
          );
        });
      },
      [setCollapsedSidebarSectionIdList],
    );

  const pinnedSectionContent = (
    <PinnedThreadTree
      rootNodes={pinnedSidebarState.rootNodes}
      selectedThreadId={selectedThreadId}
      collapsedThreadIds={collapsedThreadIds}
      onProjectSelect={onProjectSelect}
      onToggleThreadCollapsed={toggleThreadCollapsed}
      isPinnedReorderPending={pinnedReorderLocked}
      onReorderPinnedRoot={handleReorderPinnedRoot}
    />
  );
  const pinnedSectionThreads = threads.filter(
    (thread) =>
      pinnedSidebarState.effectivePinnedThreadIds.has(thread.id) &&
      isSidebarProjectThread(thread),
  );
  const pinnedSection: BuiltInSidebarSectionOptions = {
    activity: getCollapsedChildActivity(pinnedSectionThreads, draftThreadIds),
    collapsedThreads: pinnedSectionThreads,
    label: "Pinned",
    content: pinnedSectionContent,
    actions: renderSectionDisplayOptions("pinned", "Pinned"),
    actionsOpen: isSectionDisplayOptionsOpen("pinned"),
  };
  const threadsSection = {
    label: "Threads",
    actions: renderSectionDisplayOptions("threads", "Threads"),
    actionsOpen: isSectionDisplayOptionsOpen("threads"),
  } satisfies Omit<BuiltInSidebarSectionOptions, "content">;
  const sectionRenameDialogContent = (
    <ThreadSectionRenameDialog
      errorMessage={sectionRenameErrorMessage}
      target={sectionRenameDialog.target}
      pending={isUpdateThreadSectionPending}
      onOpenChange={handleRenameThreadSectionOpenChange}
      onRename={handleRenameThreadSection}
    />
  );
  const sectionDeleteDialogContent = (
    <ConfirmDeleteDialog
      open={sectionDeleteDialog.target !== null}
      onOpenChange={handleSectionDeleteDialogOpenChange}
    >
      {sectionDeleteDialog.target ? (
        <ConfirmDeleteDialogContent
          title="Remove section?"
          description="Threads in this section will move back to Threads."
          confirmLabel="Remove section"
          pending={isDeleteThreadSectionPending}
          onConfirm={handleConfirmRemoveThreadSection}
          onCancel={sectionDeleteDialog.onClose}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );

  if (projectsState.status === "loading" || !uiPreferencesReady) {
    return (
      <ProjectListShell>
        <ProjectListNavigationLoadingState />
      </ProjectListShell>
    );
  }

  return (
    <SidebarHeaderActionsProvider
      value={{
        onNewProject,
        isCreatingProject,
      }}
    >
      <ProjectListShell>
        <ActiveSidebarModeSections
          mode={organizationMode}
          renderGrouped={(groupedMode) => (
            <GroupedModeSections
              key={groupedMode}
              mode={groupedMode}
              threads={threads}
              draftThreadIds={draftThreadIds}
              effectivePinnedThreadIds={
                pinnedSidebarState.effectivePinnedThreadIds
              }
              status={projectsState.status}
              showPinnedSection={hasPinnedSection}
              pinnedSection={pinnedSection}
              pinnedReorderPending={pinnedReorderLocked}
              pinnedRootNodes={pinnedSidebarState.rootNodes}
              pinnedThreads={pinnedRootThreads}
              onReorderPinnedThread={handleReorderPinnedRoot}
              threadsSection={threadsSection}
              selectedThreadId={selectedThreadId}
              collapsedSectionIds={collapsedSidebarSectionIds}
              collapsedThreadIds={collapsedThreadIds}
              compareThreadsForSection={compareThreadsForSection}
              renderSectionDisplayOptions={renderSectionDisplayOptions}
              isSectionDisplayOptionsOpen={isSectionDisplayOptionsOpen}
              onProjectSelect={onProjectSelect}
              onToggleCollapsed={toggleSidebarSectionCollapsed}
              onToggleThreadCollapsed={toggleThreadCollapsed}
            />
          )}
          renderChronological={() => (
            <>
              <SectionModeSections
                threads={threads}
                effectivePinnedThreadIds={
                  pinnedSidebarState.effectivePinnedThreadIds
                }
                status={projectsState.status}
                showPinnedSection={hasPinnedSection}
                sections={sections}
                pinnedSection={pinnedSection}
                pinnedReorderPending={pinnedReorderLocked}
                pinnedRootNodes={pinnedSidebarState.rootNodes}
                pinnedThreads={pinnedRootThreads}
                onReorderPinnedThread={handleReorderPinnedRoot}
                threadsSection={threadsSection}
                selectedThreadId={selectedThreadId}
                collapsedSectionIds={collapsedSidebarSectionIds}
                collapsedThreadIds={collapsedThreadIds}
                compareThreadsForSection={compareThreadsForSection}
                onProjectSelect={onProjectSelect}
                onCreateThreadInSection={handleCreateProjectlessThread}
                onRenameSection={handleOpenRenameThreadSection}
                onRemoveSection={handleRemoveThreadSection}
                onToggleCollapsed={toggleSidebarSectionCollapsed}
                onToggleThreadCollapsed={toggleThreadCollapsed}
              />
            </>
          )}
          renderProject={() => (
            <>
              <ProjectModeSections
                projects={projects ?? EMPTY_PROJECTS}
                threads={threads}
                draftThreadIds={draftThreadIds}
                effectivePinnedThreadIds={
                  pinnedSidebarState.effectivePinnedThreadIds
                }
                status={projectsState.status}
                showPinnedSection={hasPinnedSection}
                pinnedSection={pinnedSection}
                pinnedReorderPending={pinnedReorderLocked}
                pinnedRootNodes={pinnedSidebarState.rootNodes}
                pinnedThreads={pinnedRootThreads}
                onReorderPinnedThread={handleReorderPinnedRoot}
                threadsSection={threadsSection}
                selectedThreadId={selectedThreadId}
                collapsedSectionIds={collapsedSidebarSectionIds}
                collapsedThreadIds={collapsedThreadIds}
                compareThreadsForSection={compareThreadsForSection}
                onProjectSelect={onProjectSelect}
                onCreateProjectThread={handleCreateProjectThread}
                onToggleCollapsed={toggleSidebarSectionCollapsed}
                onToggleThreadCollapsed={toggleThreadCollapsed}
              />
            </>
          )}
        />
      </ProjectListShell>
      {sectionRenameDialogContent}
      {sectionDeleteDialogContent}
    </SidebarHeaderActionsProvider>
  );
}

export const ProjectList = memo(ProjectListComponent);
