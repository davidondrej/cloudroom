import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { usePersistentOverlayFocus } from "@cloudroom/shared-ui/responsive-overlay";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { hasTextSelectionWithin } from "@/components/ui/gesture-dom";
import {
  setCompactSecondaryPanelPresentation,
  type CompactSecondaryPanelPresentation,
} from "@/components/ui/secondary-panel-shelf-visibility";
import { useHorizontalDismissDrag } from "@/components/ui/use-horizontal-dismiss-drag";

const DRAWER_TRANSITION =
  "[transition:translate_220ms_cubic-bezier(0.32,0.72,0,1),width_220ms_cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none!";
const DRAWER_SETTLE_MS = 220;
const DRAG_SETTLE_CSS = "translate 220ms cubic-bezier(0.32, 0.72, 0, 1)";

export function CompactSecondaryPanelShelf({
  children,
  onClose,
  onContentAnimationEnd,
  open,
  presentation,
  srLabel,
}: {
  children: ReactNode;
  onClose: () => void;
  onContentAnimationEnd?: (open: boolean) => void;
  open: boolean;
  presentation: Exclude<CompactSecondaryPanelPresentation, "closed">;
  srLabel: string;
}) {
  const titleId = useId();
  const dialogEl = useRef<HTMLDivElement | null>(null);
  const backdropEl = useRef<HTMLDivElement | null>(null);
  const shiftedInsetEl = useRef<HTMLElement | null>(null);
  const latestOnClose = useRef(onClose);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);

  const mode: CompactSecondaryPanelPresentation = open
    ? presentation
    : "closed";

  useLayoutEffect(() => {
    latestOnClose.current = onClose;
  }, [onClose]);

  const dismiss = useCallback(() => latestOnClose.current(), []);

  const clearInlineShift = useCallback(() => {
    for (const node of [shiftedInsetEl.current, backdropEl.current]) {
      if (!node) continue;
      node.style.translate = "";
      node.style.transition = "";
    }
    shiftedInsetEl.current = null;
  }, []);

  const updateDragShift = useCallback(
    ({
      progress,
      width,
      settling,
    }: {
      progress: number;
      width: number;
      settling: boolean;
    }) => {
      const dialog = dialogEl.current;
      const backdrop = backdropEl.current;
      if (!dialog || !backdrop) return;
      const offset = `${-width * progress}px`;
      const transition = settling ? DRAG_SETTLE_CSS : "none";
      const inset = dialog.ownerDocument.querySelector(
        '[data-sidebar="inset"]',
      );
      if (inset instanceof HTMLElement) {
        shiftedInsetEl.current = inset;
        inset.style.translate = offset;
        inset.style.transition = transition;
      }
      backdrop.style.translate = offset;
      backdrop.style.transition = transition;
    },
    [],
  );

  const gesture = useHorizontalDismissDrag({
    direction: "right",
    dismissTiming: "immediate",
    enabled: open,
    getWidth: () => dialogEl.current?.clientWidth ?? 0,
    onClear: clearInlineShift,
    onDismiss: dismiss,
    onProgress: updateDragShift,
    resetKey: presentation,
    suppressClick: false,
  });

  useEffect(() => {
    setMountNode(document.body);
  }, []);

  usePersistentOverlayFocus({
    open: open && mountNode !== null,
    panelRef: dialogEl,
    requestClose: dismiss,
  });

  useLayoutEffect(() => {
    if (!open && dialogEl.current && hasTextSelectionWithin(dialogEl.current)) {
      dialogEl.current.ownerDocument.getSelection()?.removeAllRanges();
    }
  }, [open]);

  useEffect(() => {
    setCompactSecondaryPanelPresentation(mode);
    return () => setCompactSecondaryPanelPresentation("closed");
  }, [mode]);

  useEffect(() => {
    if (!onContentAnimationEnd) return;
    const handle = window.setTimeout(
      () => onContentAnimationEnd(open),
      DRAWER_SETTLE_MS,
    );
    return () => window.clearTimeout(handle);
  }, [onContentAnimationEnd, open]);

  if (!mountNode) return null;

  return createPortal(
    <>
      <div
        ref={backdropEl}
        data-testid="secondary-panel-shelf-dismiss"
        data-state={mode}
        aria-hidden="true"
        style={{ zIndex: APP_OVERLAY_LAYER.secondaryPanelDismiss }}
        className={cn(
          "fixed inset-0 bg-transparent data-[state=closed]:pointer-events-none data-[state=full]:pointer-events-none",
          "data-[state=shelf]:-translate-x-(--secondary-panel-width-mobile) data-[state=full]:-translate-x-full",
          DRAWER_TRANSITION,
        )}
        onClick={dismiss}
        onPointerDown={gesture.beginPointerDrag}
        onTouchStart={gesture.beginTouchDrag}
      />
      <div
        ref={dialogEl}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-room-portaled-overlay=""
        tabIndex={-1}
        inert={!open}
        data-testid="secondary-panel-shelf"
        data-state={mode}
        style={{
          zIndex:
            mode === "full"
              ? APP_OVERLAY_LAYER.secondaryPanelFullPage
              : APP_OVERLAY_LAYER.secondaryPanel,
        }}
        className={cn(
          "fixed inset-y-0 right-0 flex h-(--room-shell-height) touch-pan-y flex-col overflow-hidden border-l border-border-seam bg-background outline-none",
          "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[var(--room-safe-area-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)]",
          "w-(--secondary-panel-width-mobile) data-[state=full]:w-full data-[state=full]:border-l-0",
          "data-[state=closed]:invisible data-[state=closed]:[transition:visibility_0s_linear_220ms]",
          DRAWER_TRANSITION,
        )}
        onPointerDown={gesture.beginPointerDrag}
        onTouchStart={gesture.beginTouchDrag}
      >
        <span id={titleId} className="sr-only">
          {srLabel}
        </span>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>
    </>,
    mountNode,
  );
}
