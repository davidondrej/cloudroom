import { capitalize } from "@cloudroom/thread-view";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@cloudroom/shared-ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@cloudroom/shared-ui/dialog";
import { Input } from "@cloudroom/shared-ui/input";
import { useNameValidation } from "./useNameValidation.js";
import { useRenameDialogAutoFocus } from "./useRenameDialogAutoFocus.js";

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shellClassName?: string;
  children: (inputRef: RefObject<HTMLInputElement | null>) => ReactNode;
}

export function RenameDialog({
  open,
  onOpenChange,
  shellClassName,
  children,
}: RenameDialogProps) {
  const { inputRef, handleOpenAutoFocus: focusInputOnOpen } =
    useRenameDialogAutoFocus();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const capturedOpenFocusRef = useRef(false);
  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      if (!capturedOpenFocusRef.current) {
        const activeElement = document.activeElement;
        returnFocusRef.current =
          activeElement instanceof HTMLElement &&
          activeElement !== document.body
            ? activeElement
            : null;
        capturedOpenFocusRef.current = true;
      }
      focusInputOnOpen(event);
    },
    [focusInputOnOpen],
  );
  const handleAfterCloseAutoFocus = useCallback(() => {
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    capturedOpenFocusRef.current = false;
    if (
      returnFocus?.isConnected &&
      returnFocus.closest('[aria-hidden="true"], [inert]') === null
    ) {
      returnFocus.focus({ preventScroll: true });
    }
  }, []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={shellClassName}
        hideCloseButton
        onOpenAutoFocus={handleOpenAutoFocus}
        onAfterCloseAutoFocus={handleAfterCloseAutoFocus}
      >
        {children(inputRef)}
      </DialogContent>
    </Dialog>
  );
}

interface RenameDialogContentProps {
  entityLabel: string;
  initialName: string;
  pending: boolean;
  errorMessage?: string | null;
  placeholder?: string;
  inputDetails?: ReactNode;
  maxLength?: { limit: number; message: string };
  autoCapitalize: "words" | "sentences";
  compact?: boolean;
  clearAction?: { label: string; onClear: () => void };
  onRename: (name: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function RenameDialogContent({
  entityLabel,
  initialName,
  pending,
  errorMessage,
  placeholder,
  inputDetails,
  maxLength,
  autoCapitalize,
  compact = false,
  clearAction,
  onRename,
  inputRef,
}: RenameDialogContentProps) {
  const inputId = useId();
  const [nextName, setNextName] = useState(initialName);
  const { validationMessage, validate, clearMessage } = useNameValidation({
    emptyMessage: `${capitalize(entityLabel)} name cannot be empty.`,
    maxLength,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    const trimmedName = validate(nextName);
    if (trimmedName === null) return;

    onRename(trimmedName);
  };
  const displayedErrorMessage = validationMessage ?? errorMessage;

  return (
    <>
      <DialogTitle className="text-[13px] font-medium text-muted-foreground">
        Rename {entityLabel}
      </DialogTitle>
      <DialogDescription className="sr-only">
        Enter a new {entityLabel} name.
      </DialogDescription>
      <form
        className={compact ? "space-y-3" : "space-y-4"}
        onSubmit={handleSubmit}
      >
        <div className={compact ? "space-y-1.5" : "space-y-2"}>
          <Input
            ref={inputRef}
            id={inputId}
            aria-label={`${capitalize(entityLabel)} name`}
            className="h-auto rounded-none border-0 border-b-2 px-0 pb-2 text-lg font-medium tracking-tight [border-image:linear-gradient(90deg,var(--primary)_60%,transparent)_1] focus-visible:ring-0"
            value={nextName}
            placeholder={placeholder}
            maxLength={maxLength?.limit}
            autoCapitalize={autoCapitalize}
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setNextName(event.target.value);
              clearMessage();
            }}
          />
          {inputDetails}
          {displayedErrorMessage ? (
            <p className="text-sm text-destructive">{displayedErrorMessage}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <kbd className="rounded border border-border px-1.5 py-0.5 font-sans">
              ↵
            </kbd>
            to save
          </span>
          {clearAction ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full px-4 text-[13px]"
              disabled={pending}
              onClick={clearAction.onClear}
            >
              {clearAction.label}
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full px-4 text-[13px]"
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            size="sm"
            className="rounded-full border-0 px-4 text-[13px] font-semibold"
            disabled={pending}
          >
            Save
          </Button>
        </div>
      </form>
    </>
  );
}
