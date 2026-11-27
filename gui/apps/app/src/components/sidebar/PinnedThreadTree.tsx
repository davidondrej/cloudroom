import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useAtomValue } from "jotai";
import { DndContext, useDroppable, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@/lib/sortable";
import {
  collectProjectThreadItemNavigationEntries,
  countProjectThreadItemRows,
  projectThreadItemContainsThread,
  type NeighborReorderRequest,
  type ProjectThreadItem,
  type ProjectThreadItemRowCountContext,
  type ProjectThreadNode,
} from "@cloudroom/client-core";
import {
  DropPreviewRow,
  getDragGhostStyle,
  ThreadTreeNodeRow,
} from "./ProjectRow";
import {
  useSidebarSortable,
  type SidebarSortableDragBindings,
} from "./sortableMotion";
import { useSidebarReorderDnd } from "./useSidebarReorderDnd";
import {
  useNeighborReorderSortable,
  type UseNeighborReorderSortableArgs,
} from "./useNeighborReorderSortable";
import { useChronologicalSectionThreadDnd } from "./SectionThreadDndContext";
import {
  PINNED_THREAD_PARENT_KEY,
  type SectionThreadDndState,
} from "./useSectionThreadDnd";
import { SidebarWindowedItems } from "./SidebarWindowedItems";
import { sidebarCollapsedThreadSectionsAtom } from "./sidebarCollapsedAtoms";

const PINNED_ALWAYS_MOUNTED_HEAD_COUNT = 9;

interface PinnedThreadRootReorderCallbacks {
  onSettled: () => void;
}

export interface PinnedThreadTreeProps {
  rootNodes: readonly ProjectThreadNode[];
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  isPinnedReorderPending?: boolean;
  onReorderPinnedRoot?: (
    request: NeighborReorderRequest,
    callbacks: PinnedThreadRootReorderCallbacks,
  ) => void;
}

interface SortablePinnedRootItemProps {
  collapsedThreadIds: Set<string>;
  disabled: boolean;
  displace?: boolean;
  node: ProjectThreadNode;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  sectionDnd?: SectionThreadDndState | null;
  selectedThreadId?: string;
}

interface PinnedRootItemProps extends Omit<
  SortablePinnedRootItemProps,
  "disabled" | "displace"
> {
  consumeClickSuppression?: () => boolean;
  dragBindings?: SidebarSortableDragBindings;
  sortableRef?: (element: HTMLDivElement | null) => void;
  sortableStyle?: CSSProperties;
}

function getPinnedRootNodeId(node: ProjectThreadNode): string {
  return node.thread.id;
}

function resolveSelectedThreadIdForNode(
  node: ProjectThreadNode,
  selectedThreadId: string | undefined,
): string | undefined {
  if (!selectedThreadId) return undefined;
  return projectThreadItemContainsThread({ kind: "thread", node }, selectedThreadId)
    ? selectedThreadId
    : undefined;
}

const PinnedRootItem = memo(function PinnedRootItem({
  collapsedThreadIds,
  consumeClickSuppression,
  dragBindings,
  node,
  onProjectSelect,
  onToggleThreadCollapsed,
  sectionDnd,
  selectedThreadId,
  sortableRef,
  sortableStyle,
}: PinnedRootItemProps) {
  return (
    <ThreadTreeNodeRow
      projectId={node.thread.projectId}
      node={node}
      depthOffset={0}
      sectionDnd={sectionDnd}
      selectedThreadId={selectedThreadId}
      collapsedThreadIds={collapsedThreadIds}
      variant="section"
      onProjectSelect={onProjectSelect}
      onToggleThreadCollapsed={onToggleThreadCollapsed}
      consumeClickSuppression={consumeClickSuppression}
      dragBindings={dragBindings}
      sortableRef={sortableRef}
      sortableStyle={sortableStyle}
    />
  );
});

const SortablePinnedRootItem = memo(function SortablePinnedRootItem({
  disabled,
  displace = true,
  node,
  ...props
}: SortablePinnedRootItemProps) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: getPinnedRootNodeId(node),
    disabled,
    displace,
  });
  const sortableStyle =
    props.sectionDnd?.activeThread?.id === getPinnedRootNodeId(node)
      ? getDragGhostStyle(style)
      : style;

  return (
    <PinnedRootItem
      {...props}
      node={node}
      dragBindings={dragBindings}
      sortableRef={setNodeRef}
      sortableStyle={sortableStyle}
    />
  );
});

export const PinnedThreadTree = memo(function PinnedThreadTree({
  rootNodes,
  selectedThreadId,
  collapsedThreadIds,
  onProjectSelect,
  onToggleThreadCollapsed,
  isPinnedReorderPending = false,
  onReorderPinnedRoot,
}: PinnedThreadTreeProps) {
  const chronologicalDnd = useChronologicalSectionThreadDnd();
  const chronologicalPinnedIds = chronologicalDnd?.pinnedItemIds;
  const chronologicalPinnedItems = useMemo(
    () => [...(chronologicalPinnedIds ?? [])],
    [chronologicalPinnedIds],
  );
  const handleReorderPinnedRoot = useCallback<
    UseNeighborReorderSortableArgs<ProjectThreadNode>["onReorder"]
  >(
    (request, callbacks) => {
      onReorderPinnedRoot?.(request, callbacks);
    },
    [onReorderPinnedRoot],
  );
  const standaloneReorderDisabled =
    isPinnedReorderPending || !onReorderPinnedRoot || rootNodes.length < 2;
  const {
    handleDragEnd: handleSortableDragEnd,
    itemIds: renderedRootNodeIds,
    renderedItems: renderedRootNodes,
  } = useNeighborReorderSortable({
    disabled: chronologicalDnd !== null || standaloneReorderDisabled,
    getId: getPinnedRootNodeId,
    items: rootNodes,
    onReorder: handleReorderPinnedRoot,
  });
  const [standaloneDragId, setStandaloneDragId] = useState<string | null>(null);
  const handleStandaloneDragStart = useCallback((event: DragStartEvent) => {
    setStandaloneDragId(String(event.active.id));
  }, []);
  const handleStandaloneDragClear = useCallback(() => {
    setStandaloneDragId(null);
  }, []);
  const handleStandaloneDragEnd = useCallback(
    (event: Parameters<typeof handleSortableDragEnd>[0]) => {
      setStandaloneDragId(null);
      handleSortableDragEnd(event);
    },
    [handleSortableDragEnd],
  );
  const { dndContextProps, consumeClickSuppression, onClickCapture } =
    useSidebarReorderDnd({
      onDragStart: handleStandaloneDragStart,
      onDragCancel: handleStandaloneDragClear,
      onDragEnd: handleStandaloneDragEnd,
    });
  const chronologicalRootNodes = useMemo(() => {
    if (!chronologicalDnd) return rootNodes;
    const nodesById = new Map(
      rootNodes.map((node) => [getPinnedRootNodeId(node), node]),
    );
    const orderedNodes: ProjectThreadNode[] = [];
    for (const id of chronologicalDnd.pinnedItemIds) {
      const node = nodesById.get(id);
      if (!node) return rootNodes;
      orderedNodes.push(node);
    }
    return orderedNodes;
  }, [chronologicalDnd, rootNodes]);
  const displayedNodes = chronologicalDnd
    ? chronologicalRootNodes
    : renderedRootNodes;
  const displayedItems = useMemo<readonly ProjectThreadItem[]>(
    () => displayedNodes.map((node) => ({ kind: "thread", node })),
    [displayedNodes],
  );
  const displayedItemKeys = useMemo(
    () => displayedNodes.map(getPinnedRootNodeId),
    [displayedNodes],
  );
  const collapsedSectionKeyList = useAtomValue(
    sidebarCollapsedThreadSectionsAtom,
  );
  const rowCountContext = useMemo<ProjectThreadItemRowCountContext>(
    () => ({
      collapsedThreadIds,
      collapsedSectionKeys: new Set(collapsedSectionKeyList),
    }),
    [collapsedThreadIds, collapsedSectionKeyList],
  );
  const estimateRows = useCallback(
    (index: number) => {
      const item = displayedItems[index];
      return item ? countProjectThreadItemRows(item, rowCountContext) : 1;
    },
    [displayedItems, rowCountContext],
  );
  const getNavigationEntries = useCallback(
    (index: number) => {
      const item = displayedItems[index];
      return item
        ? collectProjectThreadItemNavigationEntries(item, rowCountContext)
        : [];
    },
    [displayedItems, rowCountContext],
  );
  const activeDragId = chronologicalDnd?.activeThread?.id ?? standaloneDragId;
  const alwaysMountedKeys = useMemo(() => {
    const keys = new Set<string>();
    const headCount = Math.min(
      PINNED_ALWAYS_MOUNTED_HEAD_COUNT,
      displayedItemKeys.length,
    );
    for (let index = 0; index < headCount; index += 1) {
      const key = displayedItemKeys[index];
      if (key) keys.add(key);
    }
    if (selectedThreadId) {
      const selectedItem = displayedItems.find((item) =>
        projectThreadItemContainsThread(item, selectedThreadId),
      );
      if (selectedItem && selectedItem.kind === "thread") {
        keys.add(selectedItem.node.thread.id);
      }
    }
    if (activeDragId) {
      keys.add(activeDragId);
    }
    return keys;
  }, [activeDragId, displayedItemKeys, displayedItems, selectedThreadId]);
  const { setNodeRef: setPinnedParentRef } = useDroppable({
    id: PINNED_THREAD_PARENT_KEY,
    disabled: chronologicalDnd === null,
  });

  if (renderedRootNodes.length === 0) {
    return null;
  }

  if (chronologicalDnd) {
    const previewBeforeKey =
      chronologicalDnd.dropPreview?.parentKey === PINNED_THREAD_PARENT_KEY
        ? chronologicalDnd.dropPreview.beforeItemKey
        : null;
    const showDropPreview =
      chronologicalDnd.dragOverParentKey === PINNED_THREAD_PARENT_KEY &&
      chronologicalDnd.reorderTarget === null &&
      previewBeforeKey === null;
    return (
      <div
        ref={setPinnedParentRef}
        data-sidebar-sticky-section=""
        className="relative space-y-0.5"
        onClickCapture={chronologicalDnd.onClickCapture}
      >
        <SortableContext
          items={chronologicalPinnedItems}
          strategy={verticalListSortingStrategy}
        >
          <SidebarWindowedItems
            itemKeys={displayedItemKeys}
            estimateRows={estimateRows}
            getNavigationEntries={getNavigationEntries}
            alwaysMountedKeys={alwaysMountedKeys}
            renderItem={(index) => {
              const node = chronologicalRootNodes[index];
              if (!node) return null;
              const nodeId = getPinnedRootNodeId(node);
              return (
                <Fragment key={nodeId}>
                  {previewBeforeKey === `thread:${nodeId}` ? (
                    <DropPreviewRow depth={0} />
                  ) : null}
                  <SortablePinnedRootItem
                    node={node}
                    disabled={false}
                    displace={false}
                    sectionDnd={chronologicalDnd}
                    selectedThreadId={resolveSelectedThreadIdForNode(
                      node,
                      selectedThreadId,
                    )}
                    collapsedThreadIds={collapsedThreadIds}
                    onProjectSelect={onProjectSelect}
                    onToggleThreadCollapsed={onToggleThreadCollapsed}
                  />
                </Fragment>
              );
            }}
          />
        </SortableContext>
        <DropPreviewRow depth={0} visible={showDropPreview} />
      </div>
    );
  }

  return (
    <div
      data-sidebar-sticky-section=""
      className="relative space-y-0.5"
      onClickCapture={onClickCapture}
    >
      {renderedRootNodes.length > 1 ? (
        <DndContext {...dndContextProps}>
          <SortableContext
            items={renderedRootNodeIds}
            strategy={verticalListSortingStrategy}
          >
            <SidebarWindowedItems
              itemKeys={displayedItemKeys}
              estimateRows={estimateRows}
              getNavigationEntries={getNavigationEntries}
              alwaysMountedKeys={alwaysMountedKeys}
              renderItem={(index) => {
                const node = renderedRootNodes[index];
                if (!node) return null;
                return (
                  <SortablePinnedRootItem
                    key={getPinnedRootNodeId(node)}
                    node={node}
                    disabled={standaloneReorderDisabled}
                    selectedThreadId={resolveSelectedThreadIdForNode(
                      node,
                      selectedThreadId,
                    )}
                    collapsedThreadIds={collapsedThreadIds}
                    onProjectSelect={onProjectSelect}
                    onToggleThreadCollapsed={onToggleThreadCollapsed}
                  />
                );
              }}
            />
          </SortableContext>
        </DndContext>
      ) : (
        renderedRootNodes.map((node) => (
          <PinnedRootItem
            key={getPinnedRootNodeId(node)}
            node={node}
            selectedThreadId={resolveSelectedThreadIdForNode(
              node,
              selectedThreadId,
            )}
            collapsedThreadIds={collapsedThreadIds}
            onProjectSelect={onProjectSelect}
            onToggleThreadCollapsed={onToggleThreadCollapsed}
            consumeClickSuppression={consumeClickSuppression}
          />
        ))
      )}
    </div>
  );
});
