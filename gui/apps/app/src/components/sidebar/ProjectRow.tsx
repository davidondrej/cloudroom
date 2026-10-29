import {
  SidebarHeaderControls,
  SidebarSectionMenuItems,
} from "./SidebarHeaderControls";
import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { createPortal } from "react-dom";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@cloudroom/domain";
import type { ProjectResponse } from "@cloudroom/server-contract";
import { NavLink } from "react-router-dom";
import {
  usePromptDraftHasInput,
  usePromptDraftInputThreadIds,
} from "@/hooks/usePromptDraftStorage";
import { EmptyState } from "@cloudroom/shared-ui/empty-state";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import {
  SidebarMenuSkeleton,
  SidebarStickyGroup,
} from "@/components/ui/sidebar.js";
import {
  ProjectActionsContextMenu,
  ProjectActionsMenuItems,
} from "@/components/project/ProjectActionsMenu";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  getCollapsedChildActivity,
  isBusyThread,
  isUnreadDoneThread,
  NO_COLLAPSED_CHILD_ACTIVITY,
  type CollapsedChildActivity,
} from "@cloudroom/client-core";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { getSettingsProjectRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { ThreadRow, type ThreadRowOptions } from "./ThreadRow";
import {
  buildSidebarEntitySectionId,
  buildSectionThreadList,
  buildProjectThreadGroups,
  CHRONOLOGICAL_CONTAINER_ID,
  collectProjectThreadItemNavigationEntries,
  countProjectThreadItemRows,
  getProjectThreadItemDescendants,
  getSidebarDndItemId,
  isSidebarProjectThread,
  projectThreadItemContainsThread,
  type ProjectThreadItem,
  type ProjectThreadItemRowCountContext,
  type ProjectThreadNode,
  type SidebarSectionDefinition,
  type SidebarSectionGroup,
  type ThreadComparator,
} from "@cloudroom/client-core";
import { SidebarWindowedItems } from "./SidebarWindowedItems";
import { SidebarSectionRow } from "./SidebarSectionRow";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection";
import {
  sidebarCollapsedThreadSectionsAtom,
  type CollapsibleSidebarSectionId,
  type SidebarSectionId,
} from "./sidebarCollapsedAtoms";
import {
  SIDEBAR_PROJECT_GROUP_LINE_CLASS,
  getSidebarThreadGroupLineLeft,
  getSidebarThreadRowPaddingLeft,
} from "./sidebarRowClasses";
import {
  SIDEBAR_DRAG_OVERLAY_DROP_ANIMATION,
  useSidebarSortable,
  type SidebarSortableDragBindings,
} from "./sortableMotion";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import type { NeighborReorderRequest } from "@cloudroom/client-core";
import type { SidebarSectionComparator } from "./sidebarSectionSort";
import { SidebarSectionOrderList } from "./SidebarSectionOrderList";
import {
  PINNED_THREAD_PARENT_KEY,
  useSectionThreadDnd,
  type SectionThreadDndState,
} from "./useSectionThreadDnd";
import {
  getSidebarThreadRowDroppableId,
  type ThreadRowNestDrop,
} from "./sidebarThreadRowDroppable";
import { getSidebarItemKey } from "./sidebarDropPreviewPlacement";
import { useRenderedSectionThreadDnd } from "./useRenderedSectionThreadDnd";
import { useChronologicalSectionThreadDnd } from "./SectionThreadDndContext";
import {
  renderBuiltInSidebarSection,
  type BuiltInSidebarSectionOptions,
  type BuiltInSidebarSectionOptionsById,
} from "./BuiltInSidebarSection";
import { SectionThreadDndProvider } from "./SectionThreadDndContext";
import {
  useSidebarThreadDragOverlayModifiers,
  SIDEBAR_THREAD_DRAG_CHIP_CLASS,
  SIDEBAR_THREAD_DRAG_CHIP_STYLE,
} from "./sidebarThreadDragChip";

const SIDEBAR_STICKY_PARENT_DEPTH_CAP = 4;

export type ProjectThreadListState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      threads: ThreadListEntry[];
      pinnedCount?: number;
    }
  | {
      status: "unavailable";
    };

export interface ProjectRowProps {
  project: ProjectResponse;
  threadListState: ProjectThreadListState;
  rootItems?: readonly ProjectThreadItem[];
  progressiveDisclosureEnabled: boolean;
  selectedThreadId?: string;
  isActive: boolean;
  isCollapsed: boolean;
  compareThreads: ThreadComparator;
  collapsedThreadIds: Set<string>;
  isLocalPathInvalid: boolean;
  onProjectSelect?: () => void;
  onCreateProjectThread?: (projectId: string) => void;
  onToggleProjectCollapsed: (projectId: string) => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  consumeProjectClickSuppression?: ConsumeDragClickSuppression;
  projectDragBindings?: SidebarSortableDragBindings;
  projectRowRef?: (element: HTMLDivElement | null) => void;
  projectRowStyle?: CSSProperties;
}

interface ProjectThreadTreeProps {
  projectId?: string;
  dndParentKey?: string;
  rootItems?: readonly ProjectThreadItem[];
  threadListState: ProjectThreadListState;
  progressiveDisclosureEnabled: boolean;
  compareThreads: ThreadComparator;
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  variant: ProjectThreadTreeVariant;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: (threadId: string) => void;
}

interface SectionThreadTreeProps {
  threadListState: ProjectThreadListState;
  compareThreadsForSection: SidebarSectionComparator;
  sections?: readonly SidebarSectionDefinition[];
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  onProjectSelect?: () => void;
  onCreateThreadInSection?: (sectionId: string) => void;
  onRenameSection?: (section: SidebarSectionDefinition) => void;
  onRemoveSection?: (section: SidebarSectionDefinition) => void;
  onToggleThreadCollapsed: (threadId: string) => void;
}

interface ChronologicalBuiltInSidebarSections {
  collapsedSectionIds: ReadonlySet<CollapsibleSidebarSectionId>;
  onToggleCollapsed: (id: CollapsibleSidebarSectionId) => void;
  pinned: BuiltInSidebarSectionOptions;
  threads: Omit<BuiltInSidebarSectionOptions, "content">;
}

interface ChronologicalSectionThreadSectionsProps extends SectionThreadTreeProps {
  builtInSections: ChronologicalBuiltInSidebarSections;
  topLevelSectionOrder: readonly SidebarSectionId[];
  onTopLevelSectionOrderChange: (order: SidebarSectionId[]) => void;
  pinnedReorderPending: boolean;
  pinnedRootNodes?: readonly ProjectThreadNode[];
  pinnedThreads: readonly ThreadListEntry[];
  onReorderPinnedThread: (
    request: NeighborReorderRequest,
    callbacks: { onSettled: () => void },
  ) => void;
}

type ProjectThreadTreeVariant = "project" | "section";

type ProjectThreadListClickCaptureHandler = MouseEventHandler<HTMLDivElement>;
type ProjectThreadListPointerDownCaptureHandler =
  PointerEventHandler<HTMLDivElement>;

const EMPTY_PROJECT_THREADS: ThreadListEntry[] = [];
const EMPTY_PINNED_ROOT_NODES: readonly ProjectThreadNode[] = [];
const EMPTY_THREAD_SECTIONS: readonly SidebarSectionDefinition[] = [];

interface ProjectThreadTreeGroupProps {
  children: ReactNode;
  variant: ProjectThreadTreeVariant;
  onClickCapture?: ProjectThreadListClickCaptureHandler;
  onPointerDownCapture?: ProjectThreadListPointerDownCaptureHandler;
}

interface ThreadTreeNodeRowProps {
  projectId: string;
  node: ProjectThreadNode;
  depthOffset: number;
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  variant: ProjectThreadTreeVariant;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  sectionDnd?: SectionThreadDndState | null;
  sortableRef?: (element: HTMLDivElement | null) => void;
  sortableStyle?: CSSProperties;
}

interface ThreadTreeItemRowProps {
  projectId: string;
  item: ProjectThreadItem;
  depthOffset: number;
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  variant: ProjectThreadTreeVariant;
  onProjectSelect?: () => void;
  onCreateThreadInSection?: (sectionId: string) => void;
  onRenameSection?: (section: SidebarSectionDefinition) => void;
  onRemoveSection?: (section: SidebarSectionDefinition) => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  isDropTargetActive?: boolean;
  sectionDnd?: SectionThreadDndState;
  sortableRef?: (element: HTMLDivElement | null) => void;
  sortableStyle?: CSSProperties;
}

interface SectionTreeItemRowProps {
  section: SidebarSectionGroup;
  depthOffset: number;
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  variant: ProjectThreadTreeVariant;
  onProjectSelect?: () => void;
  onCreateThreadInSection?: (sectionId: string) => void;
  onRenameSection?: (section: SidebarSectionDefinition) => void;
  onRemoveSection?: (section: SidebarSectionDefinition) => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  isDropTargetActive?: boolean;
  sectionDnd?: SectionThreadDndState;
  sortableRef?: (element: HTMLDivElement | null) => void;
  sortableStyle?: CSSProperties;
}

function getItemProjectId(item: ProjectThreadItem): string {
  switch (item.kind) {
    case "thread":
      return item.node.thread.projectId;
    case "section":
      if (item.group.items.length === 0) {
        return PERSONAL_PROJECT_ID;
      }
      return getItemProjectId(item.group.items[0]);
  }
}

interface ThreadTreeGroupLineProps {
  parentRowDepth: number;
}

interface GetThreadNodeStickyLevelArgs {
  depthOffset: number;
  node: ProjectThreadNode;
}

function getProjectThreadTreeEmptyStateIcon(
  variant: ProjectThreadTreeVariant,
): IconName | undefined {
  if (variant === "section") {
    return "MessageSquare";
  }

  return undefined;
}

function getProjectThreadTreeEmptyStateClassName(
  variant: ProjectThreadTreeVariant,
): string {
  return cn("py-0.5", variant === "section" ? "px-2" : "pl-8 pr-2");
}

function getProjectThreadTreeEmptyStateMessageClassName(): string {
  return "text-xs leading-4 text-subtle-foreground/60";
}

function getProjectThreadTreeGroupLineClassName(
  variant: ProjectThreadTreeVariant,
): string | undefined {
  if (variant === "project") {
    return SIDEBAR_PROJECT_GROUP_LINE_CLASS;
  }

  return undefined;
}

function getProjectThreadTreeRootDepthOffset(
  variant: ProjectThreadTreeVariant,
): number {
  return variant === "section" ? 0 : 1;
}

function getThreadRowDepth({
  depthOffset,
  nodeDepth,
  variant,
}: GetThreadRowDepthArgs): number {
  return getProjectThreadTreeRootDepthOffset(variant) + nodeDepth + depthOffset;
}

function getThreadRowOptions({
  childActivity,
  childCount,
  consumeClickSuppression,
  dragBindings,
  depthOffset,
  isCollapsed,
  isParent,
  nestDrop,
  nodeDepth,
  onToggleThreadCollapsed,
  stickyLevel,
  variant,
}: GetThreadRowOptionsArgs): ThreadRowOptions {
  const depth = getThreadRowDepth({ depthOffset, nodeDepth, variant });
  const baseOptions = {
    depth,
    isCompact: nodeDepth > 0,
    ...(consumeClickSuppression ? { consumeClickSuppression } : {}),
    ...(dragBindings ? { dragBindings } : {}),
    ...(nestDrop ? { nestDrop } : {}),
  };

  if (!isParent) {
    return {
      ...baseOptions,
      kind: "default",
    };
  }

  return {
    ...baseOptions,
    kind: "parent",
    isCollapsed,
    childCount,
    childActivity,
    ...(stickyLevel !== undefined ? { stickyLevel } : {}),
    onToggleCollapsed: onToggleThreadCollapsed,
  };
}

interface GetThreadRowOptionsArgs {
  childActivity: CollapsedChildActivity;
  childCount: number;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  isCollapsed: boolean;
  isParent: boolean;
  depthOffset: number;
  nestDrop?: ThreadRowNestDrop;
  nodeDepth: number;
  onToggleThreadCollapsed: (threadId: string) => void;
  stickyLevel?: number;
  variant: ProjectThreadTreeVariant;
}

interface GetThreadRowDepthArgs {
  depthOffset: number;
  nodeDepth: number;
  variant: ProjectThreadTreeVariant;
}

function getThreadNodeStickyLevel({
  depthOffset,
  node,
}: GetThreadNodeStickyLevelArgs): number | undefined {
  const level = node.depth + depthOffset;
  return level < SIDEBAR_STICKY_PARENT_DEPTH_CAP ? level : undefined;
}

function ThreadTreeGroupLine({ parentRowDepth }: ThreadTreeGroupLineProps) {
  return (
    <span
      className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-border-hairline opacity-70"
      style={{ left: getSidebarThreadGroupLineLeft(parentRowDepth) }}
      aria-hidden="true"
    />
  );
}

function ProjectThreadTreeGroup({
  children,
  variant,
  onClickCapture,
  onPointerDownCapture,
}: ProjectThreadTreeGroupProps) {
  return (
    <div
      data-sidebar-sticky-section={variant === "section" ? "" : undefined}
      className={cn(
        "relative space-y-0.5",
        getProjectThreadTreeGroupLineClassName(variant),
      )}
      onClickCapture={onClickCapture}
      onPointerDownCapture={onPointerDownCapture}
    >
      {children}
    </div>
  );
}

function SectionDndSortableList({
  children,
  sectionDnd,
  parentKey,
}: {
  children: ReactNode;
  sectionDnd?: SectionThreadDndState | null;
  parentKey: string;
}) {
  if (!sectionDnd) {
    return <>{children}</>;
  }

  return (
    <SortableContext
      items={[...(sectionDnd.itemIdsByParentKey.get(parentKey) ?? [])]}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  );
}

function SectionDndDroppableParent({
  children,
  sectionDnd,
  parentKey,
}: {
  children: ReactNode;
  sectionDnd?: SectionThreadDndState | null;
  parentKey: string;
}) {
  const { setNodeRef } = useDroppable({
    id: parentKey,
    disabled: !sectionDnd,
  });

  return <div ref={setNodeRef}>{children}</div>;
}

const SectionDndItemRow = memo(function SectionDndItemRow({
  sectionDnd,
  ...props
}: ThreadTreeItemRowProps) {
  if (!sectionDnd) {
    return <ThreadTreeItemRow sectionDnd={sectionDnd} {...props} />;
  }

  if (props.item.kind === "section") {
    return <DroppableSectionItemRow {...props} sectionDnd={sectionDnd} />;
  }

  return <DraggableSectionThreadItemRow {...props} sectionDnd={sectionDnd} />;
});

const DraggableSectionThreadItemRow = memo(
  function DraggableSectionThreadItemRow({
    sectionDnd,
    ...props
  }: ThreadTreeItemRowProps & { sectionDnd: SectionThreadDndState }) {
    const itemId = getSidebarDndItemId(props.item);
    const { dragBindings, setNodeRef, style } = useSidebarSortable({
      id: itemId,
      disabled: false,
      displace: false,
    });
    const isActive = sectionDnd.activeThread?.id === itemId;

    return (
      <ThreadTreeItemRow
        {...props}
        consumeClickSuppression={sectionDnd.consumeClickSuppression}
        dragBindings={dragBindings}
        sectionDnd={sectionDnd}
        sortableRef={setNodeRef}
        sortableStyle={isActive ? getDragGhostStyle(style) : style}
      />
    );
  },
);

const DroppableSectionItemRow = memo(function DroppableSectionItemRow({
  sectionDnd,
  ...props
}: ThreadTreeItemRowProps & { sectionDnd: SectionThreadDndState }) {
  const itemId = getSidebarDndItemId(props.item);
  const isTopLevelSection =
    props.variant === "section" && props.depthOffset === 0;
  const topLevelSectionId =
    props.item.kind === "section"
      ? buildSidebarEntitySectionId("section", props.item.group.id)
      : itemId;
  const sortable = useSidebarSortable({
    id: topLevelSectionId,
    disabled: !isTopLevelSection,
  });
  const droppable = useDroppable({ id: itemId, disabled: isTopLevelSection });

  return (
    <ThreadTreeItemRow
      {...props}
      consumeClickSuppression={sectionDnd.consumeClickSuppression}
      dragBindings={isTopLevelSection ? sortable.dragBindings : undefined}
      isDropTargetActive={
        isTopLevelSection ? sortable.isOver : droppable.isOver
      }
      sectionDnd={sectionDnd}
      sortableRef={
        isTopLevelSection ? sortable.setNodeRef : droppable.setNodeRef
      }
      sortableStyle={isTopLevelSection ? sortable.style : undefined}
    />
  );
});

const ThreadTreeItemRow = memo(function ThreadTreeItemRow({
  projectId,
  item,
  depthOffset,
  selectedThreadId,
  collapsedThreadIds,
  variant,
  onProjectSelect,
  onCreateThreadInSection,
  onRenameSection,
  onRemoveSection,
  onToggleThreadCollapsed,
  consumeClickSuppression,
  dragBindings,
  isDropTargetActive,
  sectionDnd,
  sortableRef,
  sortableStyle,
}: ThreadTreeItemRowProps) {
  if (item.kind === "section") {
    return (
      <SectionTreeItemRow
        section={item.group}
        depthOffset={depthOffset}
        selectedThreadId={selectedThreadId}
        collapsedThreadIds={collapsedThreadIds}
        variant={variant}
        onProjectSelect={onProjectSelect}
        onCreateThreadInSection={onCreateThreadInSection}
        onRenameSection={onRenameSection}
        onRemoveSection={onRemoveSection}
        onToggleThreadCollapsed={onToggleThreadCollapsed}
        consumeClickSuppression={consumeClickSuppression}
        dragBindings={dragBindings}
        isDropTargetActive={isDropTargetActive}
        sectionDnd={sectionDnd}
        sortableRef={sortableRef}
        sortableStyle={sortableStyle}
      />
    );
  }

  return (
    <ThreadTreeNodeRow
      projectId={projectId}
      node={item.node}
      depthOffset={depthOffset}
      selectedThreadId={selectedThreadId}
      collapsedThreadIds={collapsedThreadIds}
      variant={variant}
      onProjectSelect={onProjectSelect}
      onToggleThreadCollapsed={onToggleThreadCollapsed}
      consumeClickSuppression={consumeClickSuppression}
      dragBindings={dragBindings}
      sectionDnd={sectionDnd}
      sortableRef={sortableRef}
      sortableStyle={sortableStyle}
    />
  );
});

export function getDragGhostStyle(style: CSSProperties): CSSProperties {
  return {
    ...style,
    opacity: 0.35,
    pointerEvents: "none",
    outline: "1px dashed var(--sidebar-foreground)",
    outlineOffset: -1,
    borderRadius: "var(--radius-md)",
  };
}

export function DropPreviewRow({
  depth,
  visible = true,
}: {
  depth: number;
  visible?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      data-sidebar-section-drop-preview="true"
      data-visible={visible ? "true" : "false"}
      className="pointer-events-none relative my-0 h-0"
    >
      {visible ? (
        <div
          className="absolute right-1 -top-px h-0.5 rounded-full bg-sidebar-ring"
          style={{ left: getSidebarThreadRowPaddingLeft(depth) }}
        />
      ) : null}
    </div>
  );
}

export function SectionThreadDragOverlayPortal({
  activeThread,
}: {
  activeThread: ThreadListEntry | null;
}) {
  const modifiers = useSidebarThreadDragOverlayModifiers();
  return createPortal(
    <DragOverlay
      className="cursor-grabbing"
      dropAnimation={activeThread ? SIDEBAR_DRAG_OVERLAY_DROP_ANIMATION : null}
      modifiers={modifiers}
    >
      {activeThread ? <SectionThreadDragOverlay thread={activeThread} /> : null}
    </DragOverlay>,
    document.body,
  );
}

export function SectionThreadDragOverlay({
  thread,
}: {
  thread: ThreadListEntry;
}) {
  return (
    <div
      aria-hidden="true"
      data-sidebar-section-drag-overlay="true"
      style={SIDEBAR_THREAD_DRAG_CHIP_STYLE}
      className={SIDEBAR_THREAD_DRAG_CHIP_CLASS}
    >
      <span className="min-w-0 flex-1 truncate">
        {getThreadDisplayTitle(thread)}
      </span>
    </div>
  );
}

const SectionTreeItemRow = memo(function SectionTreeItemRow({
  section,
  depthOffset,
  selectedThreadId,
  collapsedThreadIds,
  variant,
  onProjectSelect,
  onCreateThreadInSection,
  onRenameSection,
  onRemoveSection,
  onToggleThreadCollapsed,
  consumeClickSuppression,
  dragBindings,
  isDropTargetActive = false,
  sectionDnd,
  sortableRef,
  sortableStyle,
}: SectionTreeItemRowProps) {
  const [isTopLevelActionsOpen, setIsTopLevelActionsOpen] = useState(false);
  const collapsedSections = useAtomValue(sidebarCollapsedThreadSectionsAtom);
  const setCollapsedSections = useSetAtom(sidebarCollapsedThreadSectionsAtom);
  const sectionKey = section.key;
  const isCollapsed = collapsedSections.includes(sectionKey);
  const handleToggleCollapsed = useCallback(() => {
    setCollapsedSections((current) =>
      current.includes(sectionKey)
        ? current.filter((key) => key !== sectionKey)
        : [...current, sectionKey],
    );
  }, [sectionKey, setCollapsedSections]);

  const headerDepth = getThreadRowDepth({ depthOffset, nodeDepth: 0, variant });
  const stickyLevel =
    depthOffset < SIDEBAR_STICKY_PARENT_DEPTH_CAP ? depthOffset : undefined;
  const inlinePreviewBeforeKey =
    sectionDnd?.dropPreview?.parentKey === sectionKey
      ? sectionDnd.dropPreview.beforeItemKey
      : null;
  const showDropPreview =
    sectionDnd?.dragOverParentKey === sectionKey &&
    (isCollapsed || inlinePreviewBeforeKey === null);
  const sourceItemIds = sectionDnd?.itemIdsByParentKey.get(sectionKey);
  const isProjectedSourceEmpty =
    sectionDnd?.activeThread != null &&
    sectionDnd.dragOverParentKey !== null &&
    sectionDnd.dragOverParentKey !== sectionKey &&
    sourceItemIds?.length === 1 &&
    sourceItemIds[0] === sectionDnd.activeThread.id;
  const previewDepth = getThreadRowDepth({
    depthOffset:
      variant === "section" && depthOffset === 0 ? 0 : depthOffset + 1,
    nodeDepth: 0,
    variant,
  });
  const showChildren = !isCollapsed && section.items.length > 0;
  const showChildrenArea = showChildren || (!isCollapsed && showDropPreview);
  const sectionThreads = useMemo(
    () => getProjectThreadItemDescendants(section.items),
    [section.items],
  );
  const { itemKeys, estimateRows, getNavigationEntries, alwaysMountedKeys } =
    useWindowedThreadItems({
      items: section.items,
      collapsedThreadIds,
      selectedThreadId,
    });

  const childrenArea = showChildrenArea ? (
    <div
      className={cn(
        "relative",
        isProjectedSourceEmpty ? "space-y-0" : "space-y-px",
      )}
    >
      {variant === "project" || depthOffset > 0 ? (
        <ThreadTreeGroupLine parentRowDepth={headerDepth} />
      ) : null}
      {showChildren ? (
        <SectionDndSortableList sectionDnd={sectionDnd} parentKey={section.key}>
          <SidebarWindowedItems
            itemKeys={itemKeys}
            estimateRows={estimateRows}
            getNavigationEntries={getNavigationEntries}
            alwaysMountedKeys={alwaysMountedKeys}
            renderItem={(index) => {
              const item = section.items[index];
              if (!item) {
                return null;
              }
              const itemKey = getSidebarItemKey(item);
              return (
                <Fragment key={itemKey}>
                  {inlinePreviewBeforeKey === itemKey ? (
                    <DropPreviewRow depth={previewDepth} />
                  ) : null}
                  <SectionDndItemRow
                    projectId={getItemProjectId(item)}
                    item={item}
                    depthOffset={
                      variant === "section" && depthOffset === 0
                        ? 0
                        : depthOffset + 1
                    }
                    selectedThreadId={selectedThreadId}
                    collapsedThreadIds={collapsedThreadIds}
                    variant={variant}
                    onProjectSelect={onProjectSelect}
                    onCreateThreadInSection={onCreateThreadInSection}
                    onRenameSection={onRenameSection}
                    onRemoveSection={onRemoveSection}
                    onToggleThreadCollapsed={onToggleThreadCollapsed}
                    sectionDnd={sectionDnd}
                  />
                </Fragment>
              );
            }}
          />
        </SectionDndSortableList>
      ) : null}
      {sectionDnd ? (
        <DropPreviewRow visible={showDropPreview} depth={previewDepth} />
      ) : null}
    </div>
  ) : null;

  if (variant === "section" && depthOffset === 0) {
    const topLevelActions = (
      <SidebarHeaderControls
        label={`${section.name} section`}
        sectionId={buildSidebarEntitySectionId("section", section.id)}
        onNewThread={
          onCreateThreadInSection
            ? () => onCreateThreadInSection(section.id)
            : undefined
        }
        onOpenChange={setIsTopLevelActionsOpen}
      >
        <SidebarSectionMenuItems
          onRename={
            onRenameSection ? () => onRenameSection(section) : undefined
          }
          onRemove={
            onRemoveSection ? () => onRemoveSection(section) : undefined
          }
        />
      </SidebarHeaderControls>
    );
    return (
      <TopLevelSidebarSection
        label={section.name}
        sectionId={section.id}
        actions={topLevelActions}
        actionsOpen={isTopLevelActionsOpen}
        actionsMobileAlways
        collapseControl={{
          isCollapsed,
          onToggleCollapsed: handleToggleCollapsed,
        }}
        collapsedActivity={section.activity}
        collapsedThreads={sectionThreads}
        consumeClickSuppression={consumeClickSuppression}
        dragBindings={dragBindings}
        isDropTargetActive={isDropTargetActive}
        sectionRef={sortableRef}
        sectionStyle={sortableStyle}
        childrenInset={!isProjectedSourceEmpty}
        showChildrenWhenCollapsed={showDropPreview}
      >
        {childrenArea}
      </TopLevelSidebarSection>
    );
  }

  return (
    <SidebarStickyGroup
      ref={sortableRef}
      style={sortableStyle}
      data-sidebar-section-id={section.id}
      className={cn(
        "rounded-md transition-colors",
        isProjectedSourceEmpty ? "space-y-0" : "space-y-0.5",
        isDropTargetActive &&
          "[&_.bb-sidebar-hover-actions-row]:!bg-sidebar-accent [&_.bb-sidebar-hover-actions-row]:!text-sidebar-accent-foreground",
      )}
    >
      <SidebarSectionRow
        sectionId={buildSidebarEntitySectionId("section", section.id)}
        name={section.name}
        label={section.name}
        depth={headerDepth}
        activity={section.activity}
        collapsedThreads={sectionThreads}
        consumeClickSuppression={consumeClickSuppression}
        dragBindings={dragBindings}
        isDropTargetActive={isDropTargetActive}
        isCollapsed={isCollapsed}
        onCreateThread={
          onCreateThreadInSection
            ? () => onCreateThreadInSection(section.id)
            : undefined
        }
        onRename={onRenameSection ? () => onRenameSection(section) : undefined}
        onRemove={onRemoveSection ? () => onRemoveSection(section) : undefined}
        onToggleCollapsed={handleToggleCollapsed}
        stickyLevel={stickyLevel}
      />
      {childrenArea}
    </SidebarStickyGroup>
  );
});

export const ThreadTreeNodeRow = memo(function ThreadTreeNodeRow({
  projectId,
  node,
  depthOffset,
  selectedThreadId,
  collapsedThreadIds,
  variant,
  onProjectSelect,
  onToggleThreadCollapsed,
  consumeClickSuppression,
  dragBindings,
  sectionDnd,
  sortableRef,
  sortableStyle,
}: ThreadTreeNodeRowProps) {
  const isCollapsed = collapsedThreadIds.has(node.thread.id);
  const hasChildren = node.children.length > 0;
  const isParent = hasChildren;
  const nestDropEnabled = Boolean(sectionDnd);
  const { setNodeRef: setNestDropNodeRef } = useDroppable({
    id: getSidebarThreadRowDroppableId(node.thread.id),
    disabled: !nestDropEnabled,
    resizeObserverConfig: { disabled: !nestDropEnabled },
  });
  const rowNodeRef = useComposedRefs<HTMLDivElement>(
    setNestDropNodeRef,
    sortableRef,
  );
  const nestTargetState =
    sectionDnd?.nestTarget?.threadId === node.thread.id
      ? sectionDnd.nestTarget.state
      : null;
  const reorderPlacement =
    sectionDnd?.reorderTarget?.threadId === node.thread.id
      ? sectionDnd.reorderTarget.placement
      : null;
  const nestDrop = useMemo<ThreadRowNestDrop | undefined>(
    () =>
      nestDropEnabled
        ? {
            setNodeRef: rowNodeRef,
            state: nestTargetState,
            reorderPlacement,
          }
        : undefined,
    [nestDropEnabled, nestTargetState, reorderPlacement, rowNodeRef],
  );
  const parentRowDepth = getThreadRowDepth({
    depthOffset,
    nodeDepth: node.depth,
    variant,
  });
  const options = useMemo<ThreadRowOptions>(
    () =>
      getThreadRowOptions({
        childActivity: node.stats.childActivity,
        childCount: node.stats.childCount,
        consumeClickSuppression,
        dragBindings,
        depthOffset,
        isCollapsed,
        isParent,
        nestDrop,
        nodeDepth: node.depth,
        onToggleThreadCollapsed,
        stickyLevel: hasChildren
          ? getThreadNodeStickyLevel({ depthOffset, node })
          : undefined,
        variant,
      }),
    [
      consumeClickSuppression,
      depthOffset,
      dragBindings,
      isCollapsed,
      isParent,
      hasChildren,
      nestDrop,
      node,
      onToggleThreadCollapsed,
      variant,
    ],
  );
  const showChildren = !isCollapsed && hasChildren;
  const rowProjectId = node.thread.projectId;
  const crossProjectId = rowProjectId !== projectId ? rowProjectId : null;
  const hasComposerDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: rowProjectId,
    threadId: node.thread.id,
  });
  const { itemKeys, estimateRows, getNavigationEntries, alwaysMountedKeys } =
    useWindowedThreadItems({
      items: node.children,
      collapsedThreadIds,
      selectedThreadId,
    });
  const row = (
    <ThreadRow
      projectId={rowProjectId}
      thread={node.thread}
      crossProjectId={crossProjectId}
      isActive={selectedThreadId === node.thread.id}
      hasComposerDraft={hasComposerDraft}
      onProjectSelect={onProjectSelect}
      options={options}
    />
  );

  if (!hasChildren && !sortableRef) {
    return row;
  }

  return (
    <SidebarStickyGroup style={sortableStyle} className="space-y-0.5">
      {row}
      {showChildren ? (
        <div className="relative space-y-px">
          <ThreadTreeGroupLine parentRowDepth={parentRowDepth} />
          <SidebarWindowedItems
            itemKeys={itemKeys}
            estimateRows={estimateRows}
            getNavigationEntries={getNavigationEntries}
            alwaysMountedKeys={alwaysMountedKeys}
            renderItem={(index) => {
              const item = node.children[index];
              if (!item) {
                return null;
              }
              const itemKey = getSidebarItemKey(item);
              return (
                <SectionDndItemRow
                  key={itemKey}
                  projectId={rowProjectId}
                  item={item}
                  depthOffset={depthOffset}
                  selectedThreadId={selectedThreadId}
                  collapsedThreadIds={collapsedThreadIds}
                  variant={variant}
                  onProjectSelect={onProjectSelect}
                  onToggleThreadCollapsed={onToggleThreadCollapsed}
                  sectionDnd={sectionDnd ?? undefined}
                />
              );
            }}
          />
        </div>
      ) : null}
    </SidebarStickyGroup>
  );
});

function ThreadTreeLoadingSkeleton() {
  return (
    <div>
      <SidebarMenuSkeleton />
    </div>
  );
}

interface SectionThreadTreeItemsProps {
  items: readonly ProjectThreadItem[];
  sectionDnd: SectionThreadDndState | null;
  previewBeforeKey?: string | null;
  focusItemKey?: string;
  variant: ProjectThreadTreeVariant;
  projectId?: string;
  depthOffset?: number;
  sortableParentKey?: string;
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  onCreateThreadInSection?: (sectionId: string) => void;
  onRenameSection?: (section: SidebarSectionDefinition) => void;
  onRemoveSection?: (section: SidebarSectionDefinition) => void;
}

function useWindowedThreadItems({
  items,
  collapsedThreadIds,
  selectedThreadId,
}: {
  items: readonly ProjectThreadItem[];
  collapsedThreadIds: Set<string>;
  selectedThreadId?: string;
}) {
  const collapsedSectionKeyList = useAtomValue(
    sidebarCollapsedThreadSectionsAtom,
  );
  const itemKeys = useMemo(() => items.map(getSidebarItemKey), [items]);
  const rowCountContext = useMemo<ProjectThreadItemRowCountContext>(
    () => ({
      collapsedThreadIds,
      collapsedSectionKeys: new Set(collapsedSectionKeyList),
    }),
    [collapsedThreadIds, collapsedSectionKeyList],
  );
  const estimateRows = useCallback(
    (index: number) => {
      const item = items[index];
      return item ? countProjectThreadItemRows(item, rowCountContext) : 1;
    },
    [items, rowCountContext],
  );
  const getNavigationEntries = useCallback(
    (index: number) => {
      const item = items[index];
      return item
        ? collectProjectThreadItemNavigationEntries(item, rowCountContext)
        : [];
    },
    [items, rowCountContext],
  );
  const alwaysMountedKeys = useMemo(() => {
    if (!selectedThreadId) {
      return undefined;
    }
    const activeItem = items.find((item) =>
      projectThreadItemContainsThread(item, selectedThreadId),
    );
    return activeItem ? new Set([getSidebarItemKey(activeItem)]) : undefined;
  }, [items, selectedThreadId]);
  return { itemKeys, estimateRows, getNavigationEntries, alwaysMountedKeys };
}

function SectionThreadTreeItems({
  items,
  focusItemKey,
  sectionDnd,
  previewBeforeKey = null,
  variant,
  projectId,
  depthOffset = 0,
  sortableParentKey,
  selectedThreadId,
  collapsedThreadIds,
  onProjectSelect,
  onToggleThreadCollapsed,
  onCreateThreadInSection,
  onRenameSection,
  onRemoveSection,
}: SectionThreadTreeItemsProps) {
  const { itemKeys, estimateRows, getNavigationEntries, alwaysMountedKeys } =
    useWindowedThreadItems({
      items,
      collapsedThreadIds,
      selectedThreadId,
    });
  const rows = (
    <SidebarWindowedItems
      itemKeys={itemKeys}
      focusItemKey={focusItemKey}
      estimateRows={estimateRows}
      getNavigationEntries={getNavigationEntries}
      alwaysMountedKeys={alwaysMountedKeys}
      renderItem={(index) => {
        const item = items[index];
        if (!item) {
          return null;
        }
        const itemKey = getSidebarItemKey(item);
        return (
          <Fragment key={itemKey}>
            {previewBeforeKey === itemKey ? (
              <DropPreviewRow
                depth={getThreadRowDepth({
                  depthOffset,
                  nodeDepth: 0,
                  variant,
                })}
              />
            ) : null}
            <SectionDndItemRow
              projectId={projectId ?? getItemProjectId(item)}
              item={item}
              depthOffset={depthOffset}
              selectedThreadId={selectedThreadId}
              collapsedThreadIds={collapsedThreadIds}
              variant={variant}
              onProjectSelect={onProjectSelect}
              onToggleThreadCollapsed={onToggleThreadCollapsed}
              onCreateThreadInSection={onCreateThreadInSection}
              onRenameSection={onRenameSection}
              onRemoveSection={onRemoveSection}
              sectionDnd={sectionDnd ?? undefined}
            />
          </Fragment>
        );
      }}
    />
  );

  return (
    <ProjectThreadTreeGroup
      variant={variant}
      onClickCapture={sectionDnd?.onClickCapture}
      onPointerDownCapture={sectionDnd?.onPointerDownCapture}
    >
      {sortableParentKey !== undefined ? (
        <SectionDndSortableList
          sectionDnd={sectionDnd}
          parentKey={sortableParentKey}
        >
          {rows}
        </SectionDndSortableList>
      ) : (
        rows
      )}
    </ProjectThreadTreeGroup>
  );
}

const THREAD_ITEMS_INITIAL_LIMIT = 5;
const THREAD_ITEMS_EXPAND_SIZE = 10;
const THREAD_DISCLOSURE_CONTROL_CLASS = cn(
  "cursor-pointer rounded-sm pr-2 text-left text-sm font-normal text-subtle-foreground/70 outline-none transition-colors hover:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  COARSE_POINTER_ROW_HEIGHT_CLASS,
);

function isAttentionProjectThreadItem(
  item: ProjectThreadItem,
  selectedThreadId: string | undefined,
): boolean {
  return getProjectThreadItemDescendants([item]).some(
    (thread) =>
      thread.hasPendingInteraction ||
      isBusyThread(thread) ||
      isUnreadDoneThread(thread) ||
      thread.id === selectedThreadId,
  );
}

export const ProjectThreadTree = memo(function ProjectThreadTree({
  projectId,
  dndParentKey,
  rootItems: providedRootItems,
  threadListState,
  progressiveDisclosureEnabled,
  compareThreads,
  selectedThreadId,
  collapsedThreadIds,
  variant,
  onProjectSelect,
  onToggleThreadCollapsed,
}: ProjectThreadTreeProps) {
  const projectThreads =
    threadListState.status === "ready"
      ? threadListState.threads
      : EMPTY_PROJECT_THREADS;
  const sectionDnd = useChronologicalSectionThreadDnd();
  const treePreviewBeforeKey =
    dndParentKey !== undefined &&
    sectionDnd?.dropPreview?.parentKey === dndParentKey
      ? sectionDnd.dropPreview.beforeItemKey
      : null;
  const showTreeEndPreview =
    dndParentKey !== undefined &&
    sectionDnd?.dragOverParentKey === dndParentKey &&
    treePreviewBeforeKey === null;
  const draftThreadIds = usePromptDraftInputThreadIds(projectThreads);
  const [revealedItemKeys, setRevealedItemKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [focusItemKey, setFocusItemKey] = useState<string>();
  const allRootItems = useMemo(
    () =>
      providedRootItems ??
      buildProjectThreadGroups(projectThreads, compareThreads, draftThreadIds),
    [compareThreads, draftThreadIds, projectThreads, providedRootItems],
  );
  const rootItems = useMemo(() => {
    if (!progressiveDisclosureEnabled) {
      return allRootItems;
    }
    return allRootItems.filter(
      (item, index) =>
        index < THREAD_ITEMS_INITIAL_LIMIT ||
        revealedItemKeys.has(getSidebarItemKey(item)) ||
        isAttentionProjectThreadItem(item, selectedThreadId),
    );
  }, [
    allRootItems,
    selectedThreadId,
    revealedItemKeys,
    progressiveDisclosureEnabled,
  ]);
  const visibleItemKeys = new Set(rootItems.map(getSidebarItemKey));
  const hiddenItems = allRootItems.filter(
    (item) => !visibleItemKeys.has(getSidebarItemKey(item)),
  );
  const hasMoreItems = hiddenItems.length > 0;
  const handleShowMore: MouseEventHandler<HTMLButtonElement> = (event) => {
    const nextItems = hiddenItems.slice(0, THREAD_ITEMS_EXPAND_SIZE);
    setRevealedItemKeys(
      new Set([
        ...revealedItemKeys,
        ...visibleItemKeys,
        ...nextItems.map(getSidebarItemKey),
      ]),
    );
    setFocusItemKey(
      event.detail === 0 && nextItems[0]
        ? getSidebarItemKey(nextItems[0])
        : undefined,
    );
  };

  if (threadListState.status === "loading") {
    return <ThreadTreeLoadingSkeleton />;
  }

  if (rootItems.length === 0) {
    const emptyState = (
      <EmptyState
        message={
          threadListState.status === "unavailable"
            ? "Threads unavailable"
            : threadListState.status === "ready" &&
                (threadListState.pinnedCount ?? 0) > 0
              ? "All threads pinned"
              : "No threads"
        }
        icon={getProjectThreadTreeEmptyStateIcon(variant)}
        className={getProjectThreadTreeEmptyStateClassName(variant)}
        iconClassName="size-3.5 text-subtle-foreground/50"
        messageClassName={getProjectThreadTreeEmptyStateMessageClassName()}
      />
    );

    if (variant === "section") {
      return emptyState;
    }

    return (
      <ProjectThreadTreeGroup variant={variant}>
        {emptyState}
      </ProjectThreadTreeGroup>
    );
  }

  return (
    <>
      <SectionThreadTreeItems
        items={rootItems}
        focusItemKey={focusItemKey}
        sectionDnd={dndParentKey !== undefined ? sectionDnd : null}
        previewBeforeKey={treePreviewBeforeKey}
        variant={variant}
        projectId={projectId}
        sortableParentKey={projectId}
        selectedThreadId={selectedThreadId}
        collapsedThreadIds={collapsedThreadIds}
        onProjectSelect={onProjectSelect}
        onToggleThreadCollapsed={onToggleThreadCollapsed}
      />
      {dndParentKey !== undefined && sectionDnd ? (
        <DropPreviewRow
          visible={showTreeEndPreview}
          depth={getThreadRowDepth({
            depthOffset: getProjectThreadTreeRootDepthOffset(variant),
            nodeDepth: 0,
            variant,
          })}
        />
      ) : null}
      {hasMoreItems ? (
        <button
          type="button"
          onClick={handleShowMore}
          className={THREAD_DISCLOSURE_CONTROL_CLASS}
          style={{
            marginLeft: getSidebarThreadRowPaddingLeft(
              getProjectThreadTreeRootDepthOffset(variant),
            ),
          }}
        >
          Show more
        </button>
      ) : null}
    </>
  );
});

export const ChronologicalSectionThreadSections = memo(
  function ChronologicalSectionThreadSections({
    threadListState,
    compareThreadsForSection,
    sections = EMPTY_THREAD_SECTIONS,
    selectedThreadId,
    collapsedThreadIds,
    onProjectSelect,
    onCreateThreadInSection,
    onRenameSection,
    onRemoveSection,
    onToggleThreadCollapsed,
    builtInSections,
    topLevelSectionOrder,
    onTopLevelSectionOrderChange,
    pinnedReorderPending,
    pinnedRootNodes = EMPTY_PINNED_ROOT_NODES,
    pinnedThreads,
    onReorderPinnedThread,
  }: ChronologicalSectionThreadSectionsProps) {
    const threads =
      threadListState.status === "ready"
        ? threadListState.threads
        : EMPTY_PROJECT_THREADS;
    const expandThread = useCallback(
      (threadId: string) => {
        if (collapsedThreadIds.has(threadId)) {
          onToggleThreadCollapsed(threadId);
        }
      },
      [collapsedThreadIds, onToggleThreadCollapsed],
    );
    const draftThreadIds = usePromptDraftInputThreadIds(threads);
    const rootItems = useMemo(
      () =>
        buildSectionThreadList(
          threads,
          compareThreadsForSection("threads"),
          sections,
          draftThreadIds,
          (sectionId) =>
            compareThreadsForSection(
              buildSidebarEntitySectionId("section", sectionId),
            ),
        ),
      [threads, compareThreadsForSection, sections, draftThreadIds],
    );
    const persistedSectionItems = rootItems.filter(
      (item) => item.kind === "section",
    );
    const sectionDnd = useSectionThreadDnd({
      containerId: CHRONOLOGICAL_CONTAINER_ID,
      enabled:
        topLevelSectionOrder.length > 1 || persistedSectionItems.length > 0,
      rootItems,
      topLevelSectionOrder,
      onTopLevelSectionOrderChange,
      onExpandThread: expandThread,
      pinnedReorderPending,
      pinnedThreads,
      pinnedRootNodes,
      onReorderPinnedThread,
    });
    const renderedSectionDnd = useRenderedSectionThreadDnd({
      compareThreadsForSection,
      draftThreadIds,
      pinnedRootNodes,
      pinnedThreads,
      rootItems,
      sectionDnd,
      sections,
      threads,
    });
    const sectionItems = rootItems.filter((item) => item.kind === "section");
    const looseItems = rootItems.filter((item) => item.kind !== "section");
    const loosePreviewBeforeKey =
      renderedSectionDnd?.dropPreview?.parentKey === CHRONOLOGICAL_CONTAINER_ID
        ? renderedSectionDnd.dropPreview.beforeItemKey
        : null;
    const looseThreads = getProjectThreadItemDescendants(looseItems);

    const renderItems = (items: readonly ProjectThreadItem[]) => (
      <SectionThreadTreeItems
        items={items}
        sectionDnd={renderedSectionDnd}
        previewBeforeKey={loosePreviewBeforeKey}
        variant="section"
        selectedThreadId={selectedThreadId}
        collapsedThreadIds={collapsedThreadIds}
        onProjectSelect={onProjectSelect}
        onToggleThreadCollapsed={onToggleThreadCollapsed}
        onCreateThreadInSection={onCreateThreadInSection}
        onRenameSection={onRenameSection}
        onRemoveSection={onRemoveSection}
      />
    );

    const showLoosePreview =
      renderedSectionDnd?.dragOverParentKey === CHRONOLOGICAL_CONTAINER_ID &&
      loosePreviewBeforeKey === null;
    const looseEmptyState = (
      <EmptyState
        message={
          threadListState.status === "unavailable"
            ? "Threads unavailable"
            : "No threads"
        }
        icon={getProjectThreadTreeEmptyStateIcon("section")}
        className={getProjectThreadTreeEmptyStateClassName("section")}
        iconClassName="size-3.5 text-subtle-foreground/50"
        messageClassName={getProjectThreadTreeEmptyStateMessageClassName()}
      />
    );
    const threadsListContent =
      threadListState.status === "loading" ? (
        <ThreadTreeLoadingSkeleton />
      ) : looseItems.length > 0 ? (
        <SortableContext
          items={looseItems.map(getSidebarDndItemId)}
          strategy={verticalListSortingStrategy}
        >
          {renderItems(looseItems)}
        </SortableContext>
      ) : renderedSectionDnd ? (
        <div className="grid">
          <div
            className={cn(
              "col-start-1 row-start-1 transition-opacity duration-150 ease-out",
              showLoosePreview ? "opacity-0" : "opacity-100",
            )}
          >
            {looseEmptyState}
          </div>
          <div className="col-start-1 row-start-1">
            <DropPreviewRow depth={0} visible={showLoosePreview} />
          </div>
        </div>
      ) : (
        looseEmptyState
      );
    const threadsContent = renderedSectionDnd ? (
      <SectionDndDroppableParent
        sectionDnd={renderedSectionDnd}
        parentKey={CHRONOLOGICAL_CONTAINER_ID}
      >
        {threadsListContent}
        {looseItems.length > 0 ? (
          <DropPreviewRow
            visible={showLoosePreview}
            depth={getThreadRowDepth({
              depthOffset: 0,
              nodeDepth: 0,
              variant: "section",
            })}
          />
        ) : null}
      </SectionDndDroppableParent>
    ) : (
      threadsListContent
    );

    const sectionItemsBySectionId = new Map(
      sectionItems.map((item) => [
        buildSidebarEntitySectionId("section", item.group.id),
        item,
      ]),
    );
    const consumeClickSuppression = renderedSectionDnd?.consumeClickSuppression;
    const configuredBuiltInSections: BuiltInSidebarSectionOptionsById = {
      pinned: {
        ...builtInSections.pinned,
        isDropTargetActive:
          renderedSectionDnd?.dragOverParentKey === PINNED_THREAD_PARENT_KEY,
      },
      threads: {
        ...builtInSections.threads,
        activity: getCollapsedChildActivity(looseThreads, draftThreadIds),
        collapsedThreads: looseThreads,
        content: threadsContent,
      },
    };
    const orderedSections = (
      <SidebarSectionOrderList order={topLevelSectionOrder}>
        {(sectionId) => {
          const builtInSection = renderBuiltInSidebarSection({
            sectionId,
            sections: configuredBuiltInSections,
            disabled: topLevelSectionOrder.length < 2,
            collapsedSectionIds: builtInSections.collapsedSectionIds,
            onToggleCollapsed: builtInSections.onToggleCollapsed,
            consumeClickSuppression,
            showPinnedSection: topLevelSectionOrder.includes("pinned"),
          });
          if (builtInSection !== undefined) {
            return <div key={sectionId}>{builtInSection}</div>;
          }
          const sectionItem = sectionItemsBySectionId.get(sectionId);
          return sectionItem ? (
            <div key={sectionId}>{renderItems([sectionItem])}</div>
          ) : null;
        }}
      </SidebarSectionOrderList>
    );

    return sectionDnd ? (
      <DndContext {...sectionDnd.dndContextProps}>
        <SectionThreadDndProvider value={renderedSectionDnd}>
          {orderedSections}
          <SectionThreadDragOverlayPortal
            activeThread={sectionDnd.activeThread}
          />
        </SectionThreadDndProvider>
      </DndContext>
    ) : (
      orderedSections
    );
  },
);

function ProjectRowComponent({
  project,
  threadListState,
  rootItems,
  progressiveDisclosureEnabled,
  selectedThreadId,
  isCollapsed,
  compareThreads,
  collapsedThreadIds,
  isLocalPathInvalid,
  onProjectSelect,
  onCreateProjectThread,
  onToggleProjectCollapsed,
  onToggleThreadCollapsed,
  consumeProjectClickSuppression,
  projectDragBindings,
  projectRowRef,
  projectRowStyle,
}: ProjectRowProps) {
  const [isDropdownActionsOpen, setIsDropdownActionsOpen] = useState(false);
  const [isContextActionsOpen, setIsContextActionsOpen] = useState(false);
  const isActionsOpen = isDropdownActionsOpen || isContextActionsOpen;
  const projectSectionId = buildSidebarEntitySectionId("project", project.id);
  const isDropTarget =
    useChronologicalSectionThreadDnd()?.dragOverParentKey === projectSectionId;
  const projectThreads = useMemo(
    () =>
      isCollapsed && threadListState.status === "ready"
        ? threadListState.threads.filter(isSidebarProjectThread)
        : EMPTY_PROJECT_THREADS,
    [isCollapsed, threadListState],
  );
  const draftThreadIds = usePromptDraftInputThreadIds(projectThreads);
  const handleProjectRowToggle = useCallback(() => {
    onToggleProjectCollapsed(project.id);
  }, [onToggleProjectCollapsed, project.id]);
  const handleCreateThread = useCallback(() => {
    onCreateProjectThread?.(project.id);
  }, [onCreateProjectThread, project.id]);
  const projectActivity = useMemo<CollapsedChildActivity>(() => {
    if (!isCollapsed || threadListState.status !== "ready") {
      return NO_COLLAPSED_CHILD_ACTIVITY;
    }
    return getCollapsedChildActivity(projectThreads, draftThreadIds);
  }, [draftThreadIds, isCollapsed, projectThreads, threadListState.status]);
  const projectStatus = isLocalPathInvalid ? (
    <NavLink
      to={getSettingsProjectRoutePath(project.id)}
      onClick={(event) => {
        event.stopPropagation();
        onProjectSelect?.();
      }}
      aria-label="Project folder not found"
      className={cn(
        "relative z-10 inline-flex shrink-0 items-center justify-center rounded-md text-destructive outline-none ring-sidebar-ring transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2",
        COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
      )}
    >
      <Icon name="AlertTriangle" className={COARSE_POINTER_ICON_SIZE_CLASS} />
    </NavLink>
  ) : null;
  const projectActions = (
    <SidebarHeaderControls
      label={project.name}
      sectionId={projectSectionId}
      showNewThread={!isLocalPathInvalid}
      onNewThread={onCreateProjectThread ? handleCreateThread : undefined}
      onOpenChange={setIsDropdownActionsOpen}
    >
      <ProjectActionsMenuItems project={project} surface="dropdown" />
    </SidebarHeaderControls>
  );

  return (
    <ProjectActionsContextMenu
      project={project}
      onOpenChange={setIsContextActionsOpen}
    >
      <div
        data-sidebar-sticky-project-item=""
        data-sidebar-project-id={project.id}
      >
        <TopLevelSidebarSection
          label={project.name}
          status={projectStatus}
          actions={
            isLocalPathInvalid && isCollapsed ? undefined : projectActions
          }
          actionsAlwaysVisible={isLocalPathInvalid}
          actionsMobileAlways
          actionsOpen={isActionsOpen}
          collapseControl={{
            isCollapsed,
            onToggleCollapsed: handleProjectRowToggle,
          }}
          collapsedActivity={projectActivity}
          collapsedThreads={projectThreads}
          consumeClickSuppression={consumeProjectClickSuppression}
          dragBindings={projectDragBindings}
          isDropTargetActive={isDropTarget}
          sectionRef={projectRowRef}
          sectionStyle={projectRowStyle}
        >
          <ProjectThreadTree
            projectId={project.id}
            dndParentKey={projectSectionId}
            rootItems={rootItems}
            threadListState={threadListState}
            progressiveDisclosureEnabled={progressiveDisclosureEnabled}
            selectedThreadId={selectedThreadId}
            collapsedThreadIds={collapsedThreadIds}
            compareThreads={compareThreads}
            variant="section"
            onProjectSelect={onProjectSelect}
            onToggleThreadCollapsed={onToggleThreadCollapsed}
          />
        </TopLevelSidebarSection>
      </div>
    </ProjectActionsContextMenu>
  );
}

interface ProjectRowPropsComparisonArgs {
  prev: ProjectRowProps;
  next: ProjectRowProps;
}

function getThreadIdsWithChildren(
  threads: readonly ThreadListEntry[],
): Set<string> {
  const threadIds = new Set(threads.map((thread) => thread.id));
  const threadIdsWithChildren = new Set<string>();

  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    if (!threadIds.has(thread.parentThreadId)) continue;

    threadIdsWithChildren.add(thread.parentThreadId);
  }

  return threadIdsWithChildren;
}

function hasCollapsedThreadStateChanged({
  prev,
  next,
}: ProjectRowPropsComparisonArgs): boolean {
  if (prev.collapsedThreadIds === next.collapsedThreadIds) {
    return false;
  }
  if (prev.threadListState.status !== "ready") {
    return false;
  }

  const threadIdsWithChildren = getThreadIdsWithChildren(
    prev.threadListState.threads,
  );
  for (const threadId of threadIdsWithChildren) {
    if (
      prev.collapsedThreadIds.has(threadId) !==
      next.collapsedThreadIds.has(threadId)
    ) {
      return true;
    }
  }

  return false;
}

function areProjectRowPropsEqual(
  prev: ProjectRowProps,
  next: ProjectRowProps,
): boolean {
  if (
    prev.project !== next.project ||
    prev.threadListState !== next.threadListState ||
    prev.rootItems !== next.rootItems ||
    prev.progressiveDisclosureEnabled !== next.progressiveDisclosureEnabled ||
    prev.isActive !== next.isActive ||
    prev.isCollapsed !== next.isCollapsed ||
    prev.compareThreads !== next.compareThreads ||
    prev.isLocalPathInvalid !== next.isLocalPathInvalid ||
    prev.onProjectSelect !== next.onProjectSelect ||
    prev.onCreateProjectThread !== next.onCreateProjectThread ||
    prev.onToggleProjectCollapsed !== next.onToggleProjectCollapsed ||
    prev.onToggleThreadCollapsed !== next.onToggleThreadCollapsed ||
    prev.consumeProjectClickSuppression !==
      next.consumeProjectClickSuppression ||
    prev.projectDragBindings !== next.projectDragBindings ||
    prev.projectRowRef !== next.projectRowRef ||
    prev.projectRowStyle !== next.projectRowStyle
  ) {
    return false;
  }
  if (prev.selectedThreadId !== next.selectedThreadId) {
    if (prev.threadListState.status !== "ready") {
      return false;
    }
    for (const thread of prev.threadListState.threads) {
      if (
        thread.id === prev.selectedThreadId ||
        thread.id === next.selectedThreadId
      ) {
        return false;
      }
    }
  }
  if (prev.threadListState.status !== "ready") {
    return true;
  }
  return !hasCollapsedThreadStateChanged({ prev, next });
}

export const ProjectRow = memo(ProjectRowComponent, areProjectRowPropsEqual);
