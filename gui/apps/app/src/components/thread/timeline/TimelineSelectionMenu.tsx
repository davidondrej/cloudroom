import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { preventOverlayTriggerSelection } from "@cloudroom/shared-ui/overlay-trigger";
import { PluginActionIcon } from "@/components/plugin/PluginIcon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { MessageProseSelection } from "./SelectableMessageProse.js";
import type { ThreadTimelinePluginMessageAction } from "./types.js";

const SELECTION_ACTION_BUTTON_CLASS =
  "inline-flex h-7 min-w-0 max-w-full cursor-pointer items-center justify-center gap-1.5 rounded-[5px] px-[9px] text-xs leading-none font-medium tracking-[-0.01em] text-foreground select-none transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-muted-foreground max-sm:px-2 max-md:pointer-coarse:min-h-8";
const SELECTION_MENU_CONTENT_CLASS =
  "z-50 flex w-max max-w-[var(--radix-popover-content-available-width)] flex-wrap items-center gap-px rounded-[9px] border border-foreground/15 bg-surface-recessed-solid p-[3px] shadow-[0_4px_12px_#0005,0_1px_3px_#0007] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

interface SelectionAction {
  key?: string;
  icon: string | null;
  pluginId?: string | null;
  label: string;
  onSelect: (selection: MessageProseSelection) => void;
}

export interface TimelineSelectionMenuProps {
  selection: MessageProseSelection | null;
  onAddToChat?: (text: string) => void;
  onFork?: () => void;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
  onDismiss: () => void;
}

function ActionButton({
  action,
  onDismiss,
  selection,
}: {
  action: SelectionAction;
  onDismiss: () => void;
  selection: MessageProseSelection;
}) {
  const ignoreNextClickRef = useRef(false);
  const activate = () => {
    flushSync(() => {
      action.onSelect(selection);
      window.getSelection()?.removeAllRanges();
      onDismiss();
    });
  };
  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    ignoreNextClickRef.current = true;
  };
  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" || !ignoreNextClickRef.current) return;
    activate();
  };
  return (
    <button
      type="button"
      className={SELECTION_ACTION_BUTTON_CLASS}
      onMouseDown={(event: MouseEvent) => preventOverlayTriggerSelection(event)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        ignoreNextClickRef.current = false;
      }}
      onClick={() => {
        if (ignoreNextClickRef.current) {
          ignoreNextClickRef.current = false;
          return;
        }
        activate();
      }}
    >
      <PluginActionIcon
        pluginId={action.pluginId ?? null}
        icon={action.icon}
        className="size-[15px] shrink-0 text-subtle-foreground"
      />
      <span className="truncate">{action.label}</span>
    </button>
  );
}

const OVERFLOW_CLIP_PATTERN = /(auto|scroll|overlay|hidden|clip)/u;

function getScrollAncestors(element: Element): Element[] {
  const ancestors: Element[] = [];
  let current = element.parentElement;
  while (current !== null) {
    const style = window.getComputedStyle(current);
    if (
      OVERFLOW_CLIP_PATTERN.test(style.overflowX) ||
      OVERFLOW_CLIP_PATTERN.test(style.overflowY)
    ) {
      ancestors.push(current);
    }
    current = current.parentElement;
  }
  return ancestors;
}

function isAnchorClipped(rect: DOMRect, anchorElement: Element): boolean {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (
    window.innerWidth > 0 &&
    window.innerHeight > 0 &&
    (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight)
  ) {
    return true;
  }
  let current = anchorElement.parentElement;
  while (current !== null) {
    const style = window.getComputedStyle(current);
    const clipsX = OVERFLOW_CLIP_PATTERN.test(style.overflowX);
    const clipsY = OVERFLOW_CLIP_PATTERN.test(style.overflowY);
    if (clipsX || clipsY) {
      const bounds = current.getBoundingClientRect();
      if (bounds.width > 0 || bounds.height > 0) {
        if (clipsX && (x < bounds.left || x > bounds.right)) {
          return true;
        }
        if (clipsY) {
          let visibleBottom = bounds.bottom;
          const footer = current.querySelector<HTMLElement>(
            ":scope > * > [data-scroll-footer]",
          );
          if (footer !== null && !footer.contains(anchorElement)) {
            const footerBounds = footer.getBoundingClientRect();
            if (
              footerBounds.height > 0 &&
              footerBounds.top > bounds.top &&
              footerBounds.top < visibleBottom
            ) {
              visibleBottom = footerBounds.top;
            }
          }
          if (y < bounds.top || y > visibleBottom) {
            return true;
          }
        }
      }
    }
    current = current.parentElement;
  }
  return false;
}

export function TimelineSelectionMenu({
  selection,
  onAddToChat,
  onFork,
  pluginActions = [],
  onDismiss,
}: TimelineSelectionMenuProps) {
  const open = selection !== null;
  const portalScopeProps = usePortalScopeProps();
  const [hiddenForSelection, setHiddenForSelection] =
    useState<MessageProseSelection | null>(null);
  const hidden = selection !== null && hiddenForSelection === selection;

  const anchorSide = selection?.anchorSide ?? "top";
  const anchorLeft =
    selection?.anchorPoint?.x ??
    (selection === null ? 0 : selection.rect.left + selection.rect.width / 2);
  const anchorTop =
    selection?.anchorPoint?.y ??
    (selection === null
      ? 0
      : anchorSide === "bottom"
        ? selection.rect.bottom
        : selection.rect.top);
  const anchorElement = selection?.anchorElement ?? null;
  const virtualAnchor = useMemo(() => {
    let lastRect = new DOMRect(anchorLeft, anchorTop, 0, 0);
    const getBoundingClientRect = () => {
      const live = selection?.getAnchorRect?.();
      if (live !== null && live !== undefined) {
        lastRect = live;
        return live;
      }
      return lastRect;
    };
    return anchorElement !== null
      ? { getBoundingClientRect, contextElement: anchorElement }
      : { getBoundingClientRect };
  }, [anchorElement, anchorLeft, anchorTop, selection]);
  const virtualAnchorRef = useRef(virtualAnchor);
  virtualAnchorRef.current = virtualAnchor;

  useEffect(() => {
    if (!open || typeof window === "undefined" || anchorElement === null) {
      return;
    }
    const updateVisibility = () => {
      if (!anchorElement.isConnected) {
        onDismiss();
        return;
      }
      const clipped = isAnchorClipped(
        virtualAnchor.getBoundingClientRect(),
        anchorElement,
      );
      setHiddenForSelection((current) => {
        if (clipped) return selection;
        return current === selection ? null : current;
      });
    };
    const scrollAncestors = getScrollAncestors(anchorElement);
    for (const ancestor of scrollAncestors) {
      ancestor.addEventListener("scroll", updateVisibility, { passive: true });
    }
    window.addEventListener("scroll", updateVisibility, { passive: true });
    window.addEventListener("resize", updateVisibility);
    return () => {
      for (const ancestor of scrollAncestors) {
        ancestor.removeEventListener("scroll", updateVisibility);
      }
      window.removeEventListener("scroll", updateVisibility);
      window.removeEventListener("resize", updateVisibility);
    };
  }, [anchorElement, onDismiss, open, selection, virtualAnchor]);

  if (!selection) return null;

  const actions: SelectionAction[] = [
    ...(onAddToChat
      ? [
          {
            label: "Reply",
            icon: "ArrowTurnBackward",
            onSelect: (currentSelection: MessageProseSelection) =>
              onAddToChat(currentSelection.text),
          },
        ]
      : []),
    ...(onFork ? [{ label: "Fork", icon: "Fork", onSelect: onFork }] : []),
    ...pluginActions.map((action) => ({
      key: action.key,
      icon: action.icon,
      pluginId: action.pluginId,
      label: action.label,
      onSelect: () => action.onSelect(),
    })),
  ];
  if (actions.length === 0) return null;

  return (
    <PopoverPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <PopoverPrimitive.Anchor virtualRef={virtualAnchorRef} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...portalScopeProps}
          side={anchorSide}
          align="center"
          sideOffset={6}
          collisionPadding={8}
          aria-hidden={hidden || undefined}
          style={
            hidden ? { visibility: "hidden", pointerEvents: "none" } : undefined
          }
          className={SELECTION_MENU_CONTENT_CLASS}
          onMouseDown={(event) => preventOverlayTriggerSelection(event)}
          onEscapeKeyDown={() => onDismiss()}
          onFocusOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => {
            const target = event.target;
            if (
              target instanceof Element &&
              target.closest(".thread-scroll-thumb") !== null
            ) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {actions.map((action) => (
            <ActionButton
              key={action.key ?? action.label}
              action={action}
              onDismiss={onDismiss}
              selection={selection}
            />
          ))}
          <div className="flex items-center">
            <span
              aria-hidden="true"
              className="mx-0.5 h-3.5 w-px bg-foreground/15"
            />
            <ActionButton
              action={{
                label: "Copy",
                icon: "Copy",
                onSelect: (current) =>
                  void copyToClipboardWithToast(
                    current.copyText ?? current.text,
                    { chatMessage: true },
                  ),
              }}
              onDismiss={onDismiss}
              selection={selection}
            />
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
