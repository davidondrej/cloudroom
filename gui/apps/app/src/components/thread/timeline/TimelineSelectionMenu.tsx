import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { preventOverlayTriggerSelection } from "@cloudroom/shared-ui/overlay-trigger";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { MessageProseSelection } from "./SelectableMessageProse.js";
import type { ThreadTimelinePluginMessageAction } from "./types.js";

const SELECTION_ACTION_BUTTON_CLASS =
  "inline-flex cursor-pointer items-center px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring select-none max-md:pointer-coarse:min-h-8 max-md:pointer-coarse:px-3";
const SELECTION_MENU_CONTENT_CLASS =
  "z-50 flex w-auto items-stretch overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

interface SelectionAction {
  key?: string;
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
      {action.label}
    </button>
  );
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

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const dismiss = () => onDismiss();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, onDismiss]);

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
  const virtualAnchor = useMemo(
    () => ({
      getBoundingClientRect: () => new DOMRect(anchorLeft, anchorTop, 0, 0),
    }),
    [anchorLeft, anchorTop],
  );
  const virtualAnchorRef = useRef(virtualAnchor);
  virtualAnchorRef.current = virtualAnchor;

  if (!selection) return null;

  const actions: SelectionAction[] = [
    ...(onAddToChat
      ? [
          {
            label: "Reply",
            onSelect: (currentSelection: MessageProseSelection) =>
              onAddToChat(currentSelection.text),
          },
        ]
      : []),
    ...(onFork ? [{ label: "Fork", onSelect: onFork }] : []),
    ...pluginActions.map((action) => ({
      key: action.key,
      label: action.label,
      onSelect: () => action.onSelect(),
    })),
  ];
  if (actions.length === 0) return null;
  // Copy joins the other actions; it never opens the menu on its own.
  actions.push({
    label: "Copy",
    onSelect: (currentSelection) =>
      void copyToClipboardWithToast(
        currentSelection.copyText ?? currentSelection.text,
      ),
  });

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
          className={SELECTION_MENU_CONTENT_CLASS}
          onEscapeKeyDown={() => onDismiss()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {actions.map((action, index) => (
            <Fragment key={action.key ?? action.label}>
              {index > 0 ? (
                <span aria-hidden="true" className="w-px shrink-0 bg-border" />
              ) : null}
              <ActionButton
                action={action}
                onDismiss={onDismiss}
                selection={selection}
              />
            </Fragment>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
