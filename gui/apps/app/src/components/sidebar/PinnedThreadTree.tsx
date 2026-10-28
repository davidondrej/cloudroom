import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  type CSSProperties,
} from "react";
import { DndContext, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { NeighborReorderRequest } from "@cloudroom/client-core";
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
import type { ProjectThreadNode } from "@cloudroom/client-core";
import {
  useNeighborReorderSortable,
  type UseNeighborReorderSortableArgs,
} from "./useNeighborReorderSortable";
import { useChronologicalSectionThreadDnd } from "./SectionThreadDndContext";
import {
  PINNED_THREAD_PARENT_KEY,
  type SectionThreadDndState,
} from "./useSectionThreadDnd";

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
  const { dndContextProps, consumeClickSuppression, onClickCapture } =
    useSidebarReorderDnd({ onDragEnd: handleSortableDragEnd });
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
          items={[...chronologicalDnd.pinnedItemIds]}
          strategy={verticalListSortingStrategy}
        >
          {chronologicalRootNodes.map((node) => (
            <Fragment key={getPinnedRootNodeId(node)}>
              {previewBeforeKey === `thread:${getPinnedRootNodeId(node)}` ? (
                <DropPreviewRow depth={0} />
              ) : null}
              <SortablePinnedRootItem
                node={node}
                disabled={false}
                displace={false}
                sectionDnd={chronologicalDnd}
                selectedThreadId={selectedThreadId}
                collapsedThreadIds={collapsedThreadIds}
                onProjectSelect={onProjectSelect}
                onToggleThreadCollapsed={onToggleThreadCollapsed}
              />
            </Fragment>
          ))}
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
            {renderedRootNodes.map((node) => (
              <SortablePinnedRootItem
                key={getPinnedRootNodeId(node)}
                node={node}
                disabled={standaloneReorderDisabled}
                selectedThreadId={selectedThreadId}
                collapsedThreadIds={collapsedThreadIds}
                onProjectSelect={onProjectSelect}
                onToggleThreadCollapsed={onToggleThreadCollapsed}
              />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        renderedRootNodes.map((node) => (
          <PinnedRootItem
            key={getPinnedRootNodeId(node)}
            node={node}
            selectedThreadId={selectedThreadId}
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
