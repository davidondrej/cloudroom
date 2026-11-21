import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEventHandler,
} from "react";
import {
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DndContextProps,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type MeasuringConfiguration,
  type Modifier,
  type Sensor,
  type TouchSensorOptions,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  useDragClickSuppression,
  type ConsumeDragClickSuppression,
} from "@/components/ui/use-drag-click-suppression";

export const reorderCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

const restrictDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const REORDER_MODIFIERS: Modifier[] = [restrictDragToVerticalAxis];
// dnd-kit's pointer sensors take a release on the document or the row before
// it reaches the window, then call onDragEnd or onDragCancel. They call neither
// when the release lands before React commits the drag start (a quick flick or
// a busy main thread), so a release that leaves the drag on was lost (#2329).
const POINTER_RELEASE_EVENTS = ["mouseup", "touchend", "touchcancel"] as const;

export interface UseReorderDndArgs {
  onDragEnd: (event: DragEndEvent) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragMove?: (event: DragMoveEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  onDragCancel?: () => void;
  collisionDetection?: CollisionDetection;
  touchSensor?: Sensor<TouchSensorOptions>;
  axis?: "vertical" | "free";
  measuring?: MeasuringConfiguration;
}

export type ReorderDndContextProps = Pick<
  DndContextProps,
  | "sensors"
  | "collisionDetection"
  | "onDragStart"
  | "onDragMove"
  | "onDragOver"
  | "onDragCancel"
  | "onDragEnd"
  | "modifiers"
  | "measuring"
>;

export interface UseReorderDndResult {
  dndContextProps: ReorderDndContextProps;
  consumeClickSuppression: ConsumeDragClickSuppression;
  onClickCapture: MouseEventHandler<HTMLElement>;
}

export function useReorderDnd({
  onDragEnd,
  onDragStart,
  onDragMove,
  onDragOver,
  onDragCancel,
  collisionDetection = reorderCollisionDetection,
  touchSensor = TouchSensor,
  axis = "vertical",
  measuring,
}: UseReorderDndArgs): UseReorderDndResult {
  const {
    beginDragClickSuppression,
    clearDragClickSuppressionSoon,
    consumeDragClickSuppression,
  } = useDragClickSuppression();
  const isDraggingRef = useRef(false);
  const dragActivatorRef = useRef<Event | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(touchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      isDraggingRef.current = true;
      dragActivatorRef.current = event.activatorEvent;
      beginDragClickSuppression();
      onDragStart?.(event);
    },
    [beginDragClickSuppression, onDragStart],
  );
  const handleDragCancel = useCallback(() => {
    if (!isDraggingRef.current) {
      return;
    }
    isDraggingRef.current = false;
    dragActivatorRef.current = null;
    clearDragClickSuppressionSoon();
    onDragCancel?.();
  }, [clearDragClickSuppressionSoon, onDragCancel]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      isDraggingRef.current = false;
      dragActivatorRef.current = null;
      clearDragClickSuppressionSoon();
      onDragEnd(event);
    },
    [clearDragClickSuppressionSoon, onDragEnd],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code === "Escape") {
        handleDragCancel();
      }
    };
    const handlePointerRelease = (event: Event): void => {
      const activator = dragActivatorRef.current;
      if (event.type === "mouseup") {
        if (activator?.type !== "mousedown") return;
      } else {
        if (activator?.type !== "touchstart") return;
        const activeTouch = (activator as TouchEvent).touches[0];
        // Another finger's release must not cancel the live sensor's drag.
        if (
          !activeTouch ||
          Array.from((event as TouchEvent).touches).some(
            (touch) => touch.identifier === activeTouch.identifier,
          )
        )
          return;
      }
      handleDragCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    for (const type of POINTER_RELEASE_EVENTS) {
      window.addEventListener(type, handlePointerRelease);
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      for (const type of POINTER_RELEASE_EVENTS) {
        window.removeEventListener(type, handlePointerRelease);
      }
      isDraggingRef.current = false;
      dragActivatorRef.current = null;
    };
  }, [handleDragCancel]);
  const onClickCapture = useCallback<MouseEventHandler<HTMLElement>>(
    (event) => {
      if (!consumeDragClickSuppression()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeDragClickSuppression],
  );
  const dndContextProps = useMemo<ReorderDndContextProps>(
    () => ({
      sensors,
      collisionDetection,
      measuring,
      modifiers: axis === "vertical" ? REORDER_MODIFIERS : [],
      onDragStart: handleDragStart,
      onDragMove,
      onDragOver,
      onDragCancel: handleDragCancel,
      onDragEnd: handleDragEnd,
    }),
    [
      axis,
      collisionDetection,
      handleDragCancel,
      handleDragEnd,
      handleDragStart,
      measuring,
      onDragMove,
      onDragOver,
      sensors,
    ],
  );

  return {
    dndContextProps,
    consumeClickSuppression: consumeDragClickSuppression,
    onClickCapture,
  };
}
