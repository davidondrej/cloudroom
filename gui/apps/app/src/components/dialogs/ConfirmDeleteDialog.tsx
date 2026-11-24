import type { ReactNode } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cloudroom/shared-ui/dialog";

interface ConfirmDeleteDialogContentProps {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmVariant?: "destructive" | "default";
  pending: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
  secondaryAction?: { label: string; onClick: () => void };
  /** Narrow pill layout with a big title. Pair with `compact` on ConfirmDeleteDialog. */
  compact?: boolean;
  /** Small note left of the buttons, like a keyboard hint. Compact only. */
  hint?: ReactNode;
}

// Neutral hairlines and rings: the theme's --border and --ring are lime-tinted.
// md: only, because below 768px DialogContent becomes a bottom drawer.
const COMPACT_SHELL_CLASS =
  "md:top-[33%] md:max-w-[440px] md:gap-5 md:rounded-2xl md:border-foreground/12 md:p-6 md:shadow-2xl";
const COMPACT_BUTTON_CLASS =
  "h-8 rounded-full px-4 text-[13px] focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function ConfirmDeleteDialogContent({
  title,
  description,
  confirmLabel,
  confirmVariant = "destructive",
  pending,
  onConfirm,
  onCancel,
  secondaryAction,
  compact = false,
  hint,
}: ConfirmDeleteDialogContentProps) {
  const cancelVariant = compact ? "secondary" : "outline";
  const buttonClass = compact ? COMPACT_BUTTON_CLASS : undefined;
  return (
    <>
      <DialogHeader className={compact ? "space-y-2" : undefined}>
        <DialogTitle
          className={
            compact
              ? "text-2xl font-semibold leading-tight tracking-[-0.025em]"
              : undefined
          }
        >
          {title}
        </DialogTitle>
        <DialogDescription
          className={compact ? "text-[13px] leading-relaxed" : undefined}
        >
          {description}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter
        className={compact ? "gap-2 sm:items-center sm:space-x-0" : undefined}
      >
        {compact && hint && !secondaryAction ? (
          <span className="mr-auto hidden items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground sm:flex">
            {hint}
          </span>
        ) : null}
        {secondaryAction && (
          <Button
            type="button"
            variant={cancelVariant}
            size={compact ? "sm" : undefined}
            className={buttonClass}
            disabled={pending}
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </Button>
        )}
        {onCancel ? (
          <Button
            type="button"
            variant={cancelVariant}
            size={compact ? "sm" : undefined}
            className={buttonClass}
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          variant={confirmVariant}
          size={compact ? "sm" : undefined}
          className={buttonClass}
          disabled={pending}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

interface ConfirmDeleteDialogProps {
  modal?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
  children: ReactNode;
}

export function ConfirmDeleteDialog({
  modal = true,
  open,
  onOpenChange,
  compact = false,
  children,
}: ConfirmDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogContent
        hideCloseButton={compact}
        className={compact ? COMPACT_SHELL_CLASS : undefined}
      >
        {open ? children : null}
      </DialogContent>
    </Dialog>
  );
}
