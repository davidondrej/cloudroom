import type { ReactNode } from "react";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@cloudroom/shared-ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@cloudroom/shared-ui/dropdown-menu";
import { cn } from "@cloudroom/shared-ui/lib/utils";

type ActionMenuSurface = "context" | "dropdown";

interface ActionMenuItemProps {
  children: ReactNode;
  variant?: "default" | "destructive";
  icon: IconName;
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  surface: ActionMenuSurface;
}

interface ActionMenuSeparatorProps {
  surface: ActionMenuSurface;
}

export function ActionMenuItem({
  children,
  variant,
  icon,
  disabled,
  onSelect,
  surface,
}: ActionMenuItemProps) {
  const content = (
    <>
      <Icon name={icon} aria-hidden="true" />
      {children}
    </>
  );

  if (surface === "context") {
    return (
      <ContextMenuItem
        className={cn(
          variant === "destructive" &&
            "text-destructive focus:bg-destructive/15 focus:text-destructive data-[last-hovered]:bg-destructive/15 data-[last-hovered]:text-destructive",
        )}
        disabled={disabled}
        onSelect={onSelect}
      >
        {content}
      </ContextMenuItem>
    );
  }

  return (
    <DropdownMenuItem variant={variant} disabled={disabled} onSelect={onSelect}>
      {content}
    </DropdownMenuItem>
  );
}

export function ActionMenuSeparator({ surface }: ActionMenuSeparatorProps) {
  return surface === "context" ? (
    <ContextMenuSeparator />
  ) : (
    <DropdownMenuSeparator />
  );
}
