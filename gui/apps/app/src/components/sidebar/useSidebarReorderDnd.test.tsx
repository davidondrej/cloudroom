// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { DndContext, useDraggable } from "@dnd-kit/core";
import type {
  DragCancelEvent,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACT_VIEWPORT_QUERY } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { setCompactSidebarDrawerShowing } from "@/components/ui/sidebar-mobile-drawer-visibility";
import {
  SidebarTouchSensor,
  useSidebarReorderDnd,
} from "./useSidebarReorderDnd";

const DRAG_START_EVENT: DragStartEvent = {
  active: {
    id: "thread-1",
    data: { current: undefined },
    rect: { current: { initial: null, translated: null } },
  },
  activatorEvent: new MouseEvent("mousedown"),
};
const DRAG_END_EVENT = {
  active: { id: "thread-1" },
  over: { id: "thread-2" },
} as DragEndEvent;
const DRAG_CANCEL_EVENT = { active: { id: "thread-1" } } as DragCancelEvent;

afterEach(() => {
  cleanup();
  delete document.body.dataset.sidebarDragging;
});

describe("useSidebarReorderDnd", () => {
  it.each(["mouse", "touch"])(
    "ignores unrelated releases during a real %s drag",
    (input) => {
      vi.useFakeTimers();
      const onDragStart = vi.fn();
      const onDragCancel = vi.fn();
      const onDragEnd = vi.fn();
      function Row() {
        const { setNodeRef, listeners } = useDraggable({ id: "thread-1" });
        return (
          <button ref={setNodeRef} {...listeners}>
            Drag row
          </button>
        );
      }
      function Harness() {
        const { dndContextProps } = useSidebarReorderDnd({
          onDragStart,
          onDragCancel,
          onDragEnd,
        });
        return (
          <DndContext {...dndContextProps}>
            <Row />
          </DndContext>
        );
      }
      const { getByRole, unmount } = render(<Harness />);
      const row = getByRole("button");
      const touch: Touch = {
        identifier: 1,
        clientX: 0,
        clientY: 0,
        target: row,
        pageX: 0,
        pageY: 0,
        screenX: 0,
        screenY: 0,
        radiusX: 1,
        radiusY: 1,
        rotationAngle: 0,
        force: 1,
      };
      try {
        if (input === "mouse") {
          fireEvent.mouseDown(row, { button: 0, clientX: 0, clientY: 0 });
          fireEvent.mouseMove(document, { clientX: 0, clientY: 10 });
        } else {
          fireEvent.touchStart(row, {
            touches: [touch],
            changedTouches: [touch],
          });
          act(() => vi.advanceTimersByTime(200));
          fireEvent.mouseUp(document);
        }
        expect(onDragStart).toHaveBeenCalledTimes(1);
        for (const type of ["touchend", "touchcancel"]) {
          fireEvent(
            document.body,
            new TouchEvent(type, {
              bubbles: true,
              touches: input === "touch" ? [touch] : [],
              changedTouches: [
                { ...touch, identifier: 2, target: document.body },
              ],
            }),
          );
        }
        expect(onDragCancel).not.toHaveBeenCalled();
        expect(document.body.dataset.sidebarDragging).toBe("true");
        if (input === "mouse") {
          fireEvent.mouseUp(document);
        } else {
          fireEvent.touchEnd(row, { touches: [], changedTouches: [touch] });
        }
        expect(onDragEnd).toHaveBeenCalledTimes(1);
        expect(onDragCancel).not.toHaveBeenCalled();
        expect(document.body.dataset.sidebarDragging).toBeUndefined();
      } finally {
        unmount();
        vi.useRealTimers();
      }
    },
  );

  it("allows callers to opt into unrestricted pointer movement", () => {
    const { result } = renderHook(() =>
      useSidebarReorderDnd({ axis: "free", onDragEnd: vi.fn() }),
    );

    expect(result.current.dndContextProps.modifiers).toEqual([]);
  });

  it("marks the document as dragging until end, cancel, or unmount", () => {
    const onDragEnd = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSidebarReorderDnd({ onDragEnd }),
    );

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    expect(document.body.dataset.sidebarDragging).toBe("true");

    act(() => result.current.dndContextProps.onDragCancel?.(DRAG_CANCEL_EVENT));
    expect(document.body.dataset.sidebarDragging).toBeUndefined();

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    act(() => result.current.dndContextProps.onDragEnd?.(DRAG_END_EVENT));
    expect(document.body.dataset.sidebarDragging).toBeUndefined();

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    unmount();
    expect(document.body.dataset.sidebarDragging).toBeUndefined();
  });

  it("clears app-owned drag state when Escape preempts dnd-kit cancellation", () => {
    const onDragCancel = vi.fn();
    const { result } = renderHook(() =>
      useSidebarReorderDnd({ onDragEnd: vi.fn(), onDragCancel }),
    );

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    expect(document.body.dataset.sidebarDragging).toBe("true");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      );
    });

    expect(document.body.dataset.sidebarDragging).toBeUndefined();
    expect(onDragCancel).toHaveBeenCalledTimes(1);

    act(() => result.current.dndContextProps.onDragCancel?.(DRAG_CANCEL_EVENT));
    expect(onDragCancel).toHaveBeenCalledTimes(1);
  });

  it.each(["mouseup", "touchend", "touchcancel"])(
    "clears a missed %s release (#2329)",
    (type) => {
      const onDragCancel = vi.fn();
      const { result } = renderHook(() =>
        useSidebarReorderDnd({ onDragEnd: vi.fn(), onDragCancel }),
      );
      const release = () =>
        act(
          () =>
            void window.dispatchEvent(
              type === "mouseup" ? new MouseEvent(type) : new TouchEvent(type),
            ),
        );
      const pointerStart = {
        ...DRAG_START_EVENT,
        activatorEvent:
          type === "mouseup"
            ? new MouseEvent("mousedown")
            : new TouchEvent("touchstart", {
                touches: [{ identifier: 1 } as Touch],
              }),
      } as DragStartEvent;

      act(() => result.current.dndContextProps.onDragStart?.(pointerStart));
      release();
      expect(document.body.dataset.sidebarDragging).toBeUndefined();
      expect(onDragCancel).toHaveBeenCalledTimes(1);

      const keyboardStart = {
        ...DRAG_START_EVENT,
        activatorEvent: new KeyboardEvent("keydown", { code: "Space" }),
      } as DragStartEvent;
      act(() => result.current.dndContextProps.onDragStart?.(keyboardStart));
      release();
      expect(document.body.dataset.sidebarDragging).toBe("true");
    },
  );
});

describe("SidebarTouchSensor", () => {
  function installMatchMedia(matches: boolean) {
    const listeners = new Set<() => void>();
    const mql = {
      matches,
      media: COMPACT_VIEWPORT_QUERY,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mql),
    );
    return mql;
  }

  function touchMoveListenerCalls(spy: {
    mock: { calls: readonly (readonly unknown[])[] };
  }) {
    return spy.mock.calls.filter(([type]) => type === "touchmove");
  }

  afterEach(() => {
    setCompactSidebarDrawerShowing(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the non-passive window touchmove listener off on compact viewports until the drawer shows", () => {
    installMatchMedia(true);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const teardown = SidebarTouchSensor.setup();
    expect(touchMoveListenerCalls(addSpy)).toHaveLength(0);

    act(() => setCompactSidebarDrawerShowing(true));
    const installs = touchMoveListenerCalls(addSpy);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.[2]).toEqual({ capture: false, passive: false });

    act(() => setCompactSidebarDrawerShowing(false));
    expect(touchMoveListenerCalls(removeSpy)).toHaveLength(1);

    teardown();
    expect(touchMoveListenerCalls(addSpy)).toHaveLength(1);
  });

  it("installs the listener immediately on wide viewports and removes it on teardown", () => {
    installMatchMedia(false);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const teardown = SidebarTouchSensor.setup();
    expect(touchMoveListenerCalls(addSpy)).toHaveLength(1);

    teardown();
    expect(touchMoveListenerCalls(removeSpy)).toHaveLength(1);
  });
});
