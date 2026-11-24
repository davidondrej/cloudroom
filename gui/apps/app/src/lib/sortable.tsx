/**
 * @license
 * The sortable lists below are ported from @dnd-kit/sortable 10.0.0
 * (https://github.com/clauderic/dnd-kit).
 *
 * MIT License
 *
 * Copyright (c) 2021, Claudéric Demers
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// The hooks read refs during render, as the package does, so the React
// Compiler must not memoize this file.
"use no memo";

import {
  closestCorners,
  getClientRect,
  getFirstCollision,
  getScrollableAncestors,
  KeyboardCode,
  useDndContext,
  useDraggable,
  useDroppable,
  type ClientRect,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type Modifier,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// The parts of @dnd-kit/sortable the app's reorderable lists use: arrayMove,
// SortableContext, useSortable with its default layout animation, the vertical
// and horizontal list strategies, and keyboard moves between items. Options no
// caller passes are left out.

type Transform = ReturnType<Modifier>;

type SortingStrategy = (args: {
  activeNodeRect: ClientRect | null;
  activeIndex: number;
  index: number;
  rects: ClientRect[];
  overIndex: number;
}) => Transform | null;

// A copy of the array with one item moved to a new position.
export function arrayMove<T>(array: T[], from: number, to: number): T[] {
  const moved = array.slice();
  moved.splice(
    to < 0 ? moved.length + to : to,
    0,
    moved.splice(from, 1)[0] as T,
  );
  return moved;
}

// Shifts every item between the dragged one and its target by the dragged
// item's size plus the gap to its neighbor, along one axis.
function listSortingStrategy(axis: "x" | "y"): SortingStrategy {
  const start = axis === "x" ? "left" : "top";
  const size = axis === "x" ? "width" : "height";
  const gapAfter = (a: ClientRect, b: ClientRect) =>
    b[start] - (a[start] + a[size]);
  return ({ activeNodeRect, activeIndex, index, rects, overIndex }) => {
    const activeRect = rects[activeIndex] ?? activeNodeRect;
    if (!activeRect) return null;
    const current = rects[index];
    const previous = rects[index - 1];
    const next = rects[index + 1];
    const before = current && previous && gapAfter(previous, current);
    const after = current && next && gapAfter(current, next);
    const gap =
      (activeIndex < index ? (before ?? after) : (after ?? before)) ?? 0;
    let offset = 0;
    if (index === activeIndex) {
      const overRect = rects[overIndex];
      if (!overRect) return null;
      offset =
        activeIndex < overIndex
          ? overRect[start] +
            overRect[size] -
            (activeRect[start] + activeRect[size])
          : overRect[start] - activeRect[start];
    } else if (index > activeIndex && index <= overIndex) {
      offset = -activeRect[size] - gap;
    } else if (index < activeIndex && index >= overIndex) {
      offset = activeRect[size] + gap;
    }
    return axis === "x"
      ? { x: offset, y: 0, scaleX: 1, scaleY: 1 }
      : { x: 0, y: offset, scaleX: 1, scaleY: 1 };
  };
}

export const horizontalListSortingStrategy = listSortingStrategy("x");
export const verticalListSortingStrategy = listSortingStrategy("y");

interface SortableContextValue {
  activeIndex: number;
  containerId: string;
  disableTransforms: boolean;
  items: UniqueIdentifier[];
  overIndex: number;
  useDragOverlay: boolean;
  sortedRects: ClientRect[];
  strategy: SortingStrategy;
}

const SortableItems = createContext<SortableContextValue>({
  activeIndex: -1,
  containerId: "Sortable",
  disableTransforms: false,
  items: [],
  overIndex: -1,
  useDragOverlay: false,
  sortedRects: [],
  strategy: verticalListSortingStrategy,
});

export function SortableContext({
  children,
  items: userItems,
  strategy,
}: {
  children: ReactNode;
  items: (UniqueIdentifier | { id: UniqueIdentifier })[];
  strategy: SortingStrategy;
}) {
  const {
    active,
    dragOverlay,
    droppableRects,
    over,
    measureDroppableContainers,
  } = useDndContext();
  const containerId = useId();
  const useDragOverlay = dragOverlay.rect !== null;
  const items = useMemo(
    () =>
      userItems.map((item) =>
        typeof item === "object" && "id" in item ? item.id : item,
      ),
    [userItems],
  );
  const isDragging = active != null;
  const activeIndex = active ? items.indexOf(active.id) : -1;
  const overIndex = over ? items.indexOf(over.id) : -1;
  const previousItemsRef = useRef(items);
  const previousItems = previousItemsRef.current;
  const itemsHaveChanged =
    items !== previousItems &&
    (items.length !== previousItems.length ||
      items.some((item, index) => item !== previousItems[index]));
  const disableTransforms =
    (overIndex !== -1 && activeIndex === -1) || itemsHaveChanged;
  useLayoutEffect(() => {
    if (itemsHaveChanged && isDragging) measureDroppableContainers(items);
  }, [itemsHaveChanged, items, isDragging, measureDroppableContainers]);
  useEffect(() => {
    previousItemsRef.current = items;
  }, [items]);
  const value = useMemo(() => {
    const sortedRects: ClientRect[] = Array(items.length);
    items.forEach((id, index) => {
      const rect = droppableRects.get(id);
      if (rect) sortedRects[index] = rect;
    });
    return {
      activeIndex,
      containerId,
      disableTransforms,
      items,
      overIndex,
      useDragOverlay,
      sortedRects,
      strategy,
    };
  }, [
    activeIndex,
    containerId,
    disableTransforms,
    items,
    overIndex,
    droppableRects,
    useDragOverlay,
    strategy,
  ]);
  return <SortableItems value={value}>{children}</SortableItems>;
}

const DEFAULT_TRANSITION = { duration: 200, easing: "ease" };
const NO_TRANSITION = "transform 0ms linear";
const SORTABLE_ATTRIBUTES = { roleDescription: "sortable" };
const isValidIndex = (index: number) => index >= 0;

// A dragged item registers as both draggable and droppable. Items between the
// dragged one and its target shift by the context's strategy, and an item
// whose index changed after a drop animates from where it was.
export function useSortable({
  id,
  disabled = false,
  transition = DEFAULT_TRANSITION,
}: {
  id: UniqueIdentifier;
  disabled?: boolean;
  transition?: { duration: number; easing: string } | null;
}) {
  const {
    items,
    containerId,
    activeIndex,
    disableTransforms,
    sortedRects,
    overIndex,
    useDragOverlay,
    strategy,
  } = useContext(SortableItems);
  const index = items.indexOf(id);
  const data = useMemo(
    () => ({ sortable: { containerId, index, items } }),
    [containerId, index, items],
  );
  const itemsAfterThis = useMemo(
    () => items.slice(items.indexOf(id)),
    [items, id],
  );
  const {
    rect,
    node,
    isOver,
    setNodeRef: setDroppableNodeRef,
  } = useDroppable({
    id,
    data,
    resizeObserverConfig: { updateMeasurementsFor: itemsAfterThis },
  });
  const {
    active,
    activatorEvent,
    activeNodeRect,
    attributes,
    setNodeRef: setDraggableNodeRef,
    listeners,
    isDragging,
    setActivatorNodeRef,
    transform,
  } = useDraggable({ id, data, attributes: SORTABLE_ATTRIBUTES, disabled });
  const setNodeRef = useCallback(
    (element: HTMLElement | null) => {
      setDroppableNodeRef(element);
      setDraggableNodeRef(element);
    },
    [setDroppableNodeRef, setDraggableNodeRef],
  );
  const isSorting = Boolean(active);
  const displaceItem =
    isSorting &&
    !disableTransforms &&
    isValidIndex(activeIndex) &&
    isValidIndex(overIndex);
  const shouldDisplaceDragSource = !useDragOverlay && isDragging;
  const dragSourceDisplacement =
    shouldDisplaceDragSource && displaceItem ? transform : null;
  const finalTransform = displaceItem
    ? (dragSourceDisplacement ??
      strategy({
        rects: sortedRects,
        activeNodeRect,
        activeIndex,
        overIndex,
        index,
      }))
    : null;
  const newIndex =
    isValidIndex(activeIndex) && isValidIndex(overIndex)
      ? arrayMove(items, activeIndex, overIndex).indexOf(id)
      : index;
  const activeId = active?.id;
  const previous = useRef({ activeId, items, newIndex, containerId });
  const { current: last } = previous;
  const itemsHaveChanged = items !== last.items;
  const shouldAnimateLayoutChanges =
    !!transition &&
    last.activeId != null &&
    !(itemsHaveChanged && index === last.newIndex) &&
    (isSorting ||
      (last.newIndex !== index && containerId === last.containerId));
  const derivedTransform = useDerivedTransform({
    disabled: !shouldAnimateLayoutChanges,
    index,
    node,
    rect,
  });
  useEffect(() => {
    if (isSorting) previous.current.newIndex = newIndex;
    previous.current.containerId = containerId;
    previous.current.items = items;
  }, [isSorting, newIndex, containerId, items]);
  useEffect(() => {
    if (activeId === previous.current.activeId) return;
    if (activeId != null && previous.current.activeId == null) {
      previous.current.activeId = activeId;
      return;
    }
    const timeout = setTimeout(() => {
      previous.current.activeId = activeId;
    }, 50);
    return () => clearTimeout(timeout);
  }, [activeId]);

  let sortableTransition: string | undefined;
  if (derivedTransform || (itemsHaveChanged && last.newIndex === index)) {
    // One frame without a transition sets up the derived transform, or keeps
    // items from sliding back to their old place when the list changes.
    sortableTransition = NO_TRANSITION;
  } else if (
    transition &&
    !(shouldDisplaceDragSource && !isKeyboardEvent(activatorEvent)) &&
    (isSorting || shouldAnimateLayoutChanges)
  ) {
    sortableTransition = `transform ${transition.duration}ms ${transition.easing}`;
  }
  return {
    attributes,
    isDragging,
    isOver,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform: derivedTransform ?? finalTransform,
    transition: sortableTransition,
  };
}

// When an item's index changes after a drop, starts it from where it was
// drawn, for one frame, so its transition animates the move.
function useDerivedTransform({
  disabled,
  index,
  node,
  rect,
}: {
  disabled: boolean;
  index: number;
  node: { current: HTMLElement | null };
  rect: { current: ClientRect | null };
}) {
  const [derivedTransform, setDerivedTransform] = useState<Transform | null>(
    null,
  );
  const previousIndex = useRef(index);
  useLayoutEffect(() => {
    if (!disabled && index !== previousIndex.current && node.current) {
      const initial = rect.current;
      if (initial) {
        const current = getClientRect(node.current, { ignoreTransform: true });
        const delta = {
          x: initial.left - current.left,
          y: initial.top - current.top,
          scaleX: initial.width / current.width,
          scaleY: initial.height / current.height,
        };
        if (delta.x || delta.y) setDerivedTransform(delta);
      }
    }
    previousIndex.current = index;
  }, [disabled, index, node, rect]);
  useEffect(() => {
    if (derivedTransform) setDerivedTransform(null);
  }, [derivedTransform]);
  return derivedTransform;
}

// The key press that started a drag, checked against the target's own window.
function isKeyboardEvent(event: Event | null): boolean {
  if (!event) return false;
  const view =
    (event.target as Node | null)?.ownerDocument?.defaultView ?? window;
  return event instanceof view.KeyboardEvent;
}

const KEYBOARD_DIRECTIONS: string[] = [
  KeyboardCode.Down,
  KeyboardCode.Right,
  KeyboardCode.Up,
  KeyboardCode.Left,
];

function sortableOf(entry: DroppableContainer) {
  const sortable: unknown = entry.data.current?.sortable;
  return sortable &&
    typeof sortable === "object" &&
    "containerId" in sortable &&
    "items" in sortable &&
    "index" in sortable
    ? (sortable as { containerId: unknown; index: number })
    : null;
}

// Arrow keys move the dragged item onto the nearest sortable item in that
// direction, lined up with its far edge when moving past it in one list.
export const sortableKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  {
    context: {
      active,
      collisionRect,
      droppableRects,
      droppableContainers,
      over,
      scrollableAncestors,
    },
  },
) => {
  if (!KEYBOARD_DIRECTIONS.includes(event.code)) return undefined;
  event.preventDefault();
  if (!active || !collisionRect) return undefined;
  const candidates: DroppableContainer[] = [];
  droppableContainers.getEnabled().forEach((entry) => {
    if (!entry || entry.disabled) return;
    const rect = droppableRects.get(entry.id);
    if (!rect) return;
    if (
      (event.code === KeyboardCode.Down && collisionRect.top < rect.top) ||
      (event.code === KeyboardCode.Up && collisionRect.top > rect.top) ||
      (event.code === KeyboardCode.Left && collisionRect.left > rect.left) ||
      (event.code === KeyboardCode.Right && collisionRect.left < rect.left)
    ) {
      candidates.push(entry);
    }
  });
  const collisions = closestCorners({
    active,
    collisionRect,
    droppableRects,
    droppableContainers: candidates,
    pointerCoordinates: null,
  });
  let closestId = getFirstCollision(collisions, "id");
  const second = collisions[1];
  if (closestId === over?.id && second) closestId = second.id;
  if (closestId == null) return undefined;
  const activeDroppable = droppableContainers.get(active.id);
  const newDroppable = droppableContainers.get(closestId);
  const newRect = newDroppable ? droppableRects.get(newDroppable.id) : null;
  const newNode = newDroppable?.node.current;
  if (!newNode || !newRect || !activeDroppable || !newDroppable)
    return undefined;
  const hasDifferentScrollAncestors = getScrollableAncestors(newNode).some(
    (element, index) => scrollableAncestors[index] !== element,
  );
  const activeSortable = sortableOf(activeDroppable);
  const newSortable = sortableOf(newDroppable);
  const hasSameContainer =
    !!activeSortable &&
    !!newSortable &&
    activeSortable.containerId === newSortable.containerId;
  const isAfterActive =
    hasSameContainer && activeSortable.index < newSortable.index;
  const offset =
    hasDifferentScrollAncestors || !hasSameContainer
      ? { x: 0, y: 0 }
      : {
          x: isAfterActive ? collisionRect.width - newRect.width : 0,
          y: isAfterActive ? collisionRect.height - newRect.height : 0,
        };
  return offset.x && offset.y
    ? { x: newRect.left, y: newRect.top }
    : { x: newRect.left - offset.x, y: newRect.top - offset.y };
};

// A sortable item's drag offset as a CSS transform, in whole pixels: the same
// string as dnd-kit's CSS.Translate.toString.
export function sortableTranslate(
  transform: { x: number; y: number } | null,
): string | undefined {
  if (!transform) return undefined;
  const { x, y } = transform;
  return `translate3d(${x ? Math.round(x) : 0}px, ${y ? Math.round(y) : 0}px, 0)`;
}
