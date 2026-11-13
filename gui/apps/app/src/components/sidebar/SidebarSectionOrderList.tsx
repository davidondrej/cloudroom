import { useMemo, type ReactNode } from "react";
import { reuseSameItems, useStableValue } from "@/hooks/useStableValue";
import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { SidebarSectionId } from "./sidebarCollapsedAtoms";
import type { ReorderDndContextProps } from "@/components/ui/useReorderDnd";

interface SidebarSectionOrderListProps {
  children: (sectionId: SidebarSectionId) => ReactNode;
  dndContextProps?: ReorderDndContextProps;
  order: readonly SidebarSectionId[];
  trailing?: ReactNode;
}

export function SidebarSectionOrderList({
  children,
  dndContextProps,
  order,
  trailing,
}: SidebarSectionOrderListProps) {
  // `order` is rebuilt on every sidebar update; a new `items` array would
  // change dnd-kit's context and redraw every sortable section.
  const stableOrder = useStableValue(order, reuseSameItems);
  const items = useMemo(() => [...stableOrder], [stableOrder]);
  const content = (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      <div className="space-y-4">{order.map(children)}</div>
    </SortableContext>
  );

  return dndContextProps ? (
    <DndContext {...dndContextProps}>
      {content}
      {trailing}
    </DndContext>
  ) : (
    content
  );
}
