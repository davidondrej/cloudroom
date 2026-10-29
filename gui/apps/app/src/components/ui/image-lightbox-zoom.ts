import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const PINCH_SPEED = 0.01;
const LINE_HEIGHT_PX = 16;
const DRAG_THRESHOLD_PX = 3;

export interface ImageZoom {
  scale: number;
  x: number;
  y: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

const NO_ZOOM: ImageZoom = { scale: 1, x: 0, y: 0 };

export function clampImagePan(zoom: ImageZoom, rect: Rect): ImageZoom {
  if (zoom.scale <= MIN_SCALE) return NO_ZOOM;
  const maxX = ((rect.width / zoom.scale) * (zoom.scale - 1)) / 2;
  const maxY = ((rect.height / zoom.scale) * (zoom.scale - 1)) / 2;
  return {
    scale: zoom.scale,
    x: Math.min(maxX, Math.max(-maxX, zoom.x)),
    y: Math.min(maxY, Math.max(-maxY, zoom.y)),
  };
}

export function zoomImageAt(
  zoom: ImageZoom,
  nextScale: number,
  point: { x: number; y: number },
  rect: Rect,
): ImageZoom {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  const ratio = scale / zoom.scale;
  const dx = point.x - (rect.left + rect.width / 2);
  const dy = point.y - (rect.top + rect.height / 2);
  return clampImagePan(
    { scale, x: zoom.x + dx * (1 - ratio), y: zoom.y + dy * (1 - ratio) },
    { ...rect, width: rect.width * ratio, height: rect.height * ratio },
  );
}

export function useImageLightboxZoom(
  containerRef: RefObject<HTMLElement | null>,
  resetKey: string | null,
) {
  const imageRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef(NO_ZOOM);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const ignoreClickRef = useRef(false);
  const [zoom, setZoomState] = useState(NO_ZOOM);
  const [isDragging, setIsDragging] = useState(false);

  const setZoom = useCallback((next: ImageZoom) => {
    zoomRef.current = next;
    setZoomState(next);
  }, []);

  useLayoutEffect(() => {
    dragRef.current = null;
    setIsDragging(false);
    setZoom(NO_ZOOM);
  }, [resetKey, setZoom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || resetKey === null) return;

    const zoomAround = (scale: number, x: number, y: number) => {
      const image = imageRef.current;
      if (!image) return;
      setZoom(zoomImageAt(zoomRef.current, scale, { x, y }, image.getBoundingClientRect()));
    };

    const handleWheel = (event: WheelEvent) => {
      const image = imageRef.current;
      if (!image) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_HEIGHT_PX : 1;
      if (event.ctrlKey) {
        event.preventDefault();
        zoomAround(
          zoomRef.current.scale * Math.exp(-event.deltaY * unit * PINCH_SPEED),
          event.clientX,
          event.clientY,
        );
        return;
      }
      const current = zoomRef.current;
      if (current.scale <= MIN_SCALE) return;
      event.preventDefault();
      setZoom(
        clampImagePan(
          { ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit },
          image.getBoundingClientRect(),
        ),
      );
    };

    let gestureStartScale = MIN_SCALE;
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartScale = zoomRef.current.scale;
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as WebKitGestureEvent;
      zoomAround(gestureStartScale * gesture.scale, gesture.clientX, gesture.clientY);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("gesturestart", handleGestureStart);
    container.addEventListener("gesturechange", handleGestureChange);
    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("gesturestart", handleGestureStart);
      container.removeEventListener("gesturechange", handleGestureChange);
    };
  }, [containerRef, resetKey, setZoom]);

  const isZoomed = zoom.scale > MIN_SCALE;

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    ignoreClickRef.current = false;
    if (!isZoomed || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) setIsDragging(true);
    drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const current = zoomRef.current;
    setZoom(
      clampImagePan(
        { ...current, x: current.x + dx, y: current.y + dy },
        event.currentTarget.getBoundingClientRect(),
      ),
    );
  };

  const onPointerEnd = () => {
    ignoreClickRef.current = dragRef.current?.moved ?? false;
    dragRef.current = null;
    setIsDragging(false);
  };

  const consumeDragClick = () => {
    const ignore = ignoreClickRef.current;
    ignoreClickRef.current = false;
    return ignore;
  };

  const imageStyle: CSSProperties = isZoomed
    ? {
        transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
        cursor: isDragging ? "grabbing" : "grab",
        touchAction: "none",
      }
    : {};

  return {
    imageRef,
    imageStyle,
    isZoomed,
    consumeDragClick,
    imageHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  };
}
