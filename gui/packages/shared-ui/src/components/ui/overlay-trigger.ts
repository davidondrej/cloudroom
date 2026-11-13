import { createContext, useContext, type MouseEvent } from "react";
import { cn } from "../../lib/utils";

const OVERLAY_TRIGGER_CLASS_NAME = "select-none";

type OverlayTriggerClassNameResolver = (className?: string) => string;

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export const getOverlayTriggerClassName: OverlayTriggerClassNameResolver = (
  className,
) => cn(OVERLAY_TRIGGER_CLASS_NAME, className);

function isKeyboardInputElement(element: Element): element is HTMLElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return (
      !element.disabled &&
      !element.readOnly &&
      !NON_TEXT_INPUT_TYPES.has(element.type)
    );
  }
  if (!(element instanceof HTMLElement)) return false;

  return (
    element.isContentEditable ||
    element.closest("[contenteditable='true']") !== null
  );
}

export function blurActiveKeyboardInputWithin(container: Element | null): void {
  if (typeof document === "undefined") return;

  const activeElement = document.activeElement;
  if (!activeElement || !isKeyboardInputElement(activeElement)) return;
  if (container !== null && !container.contains(activeElement)) return;

  activeElement.blur();
}

export function blurActiveKeyboardInputBeforeOverlayOpen(): void {
  blurActiveKeyboardInputWithin(null);
}

export function blurActiveKeyboardInputBeforeOverlayClose(): void {
  blurActiveKeyboardInputWithin(null);
}

export function preventOverlayTriggerSelection(event: MouseEvent): void {
  event.preventDefault();
}

let lastInputModality: "pointer" | "keyboard" = "pointer";

if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    () => {
      lastInputModality = "keyboard";
    },
    { capture: true },
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInputModality = "pointer";
    },
    { capture: true },
  );
}

export function isLastInputKeyboard(): boolean {
  return lastInputModality === "keyboard";
}

/**
 * Where focus goes when a popover or menu in this subtree closes, instead of
 * its trigger. The composer sets it so picking a model or project returns the
 * caret to the editor.
 */
export const OverlayCloseFocusContext = createContext<(() => void) | null>(
  null,
);

export function useOverlayCloseFocus(): (event: Event) => void {
  const returnFocus = useContext(OverlayCloseFocusContext);
  return (event) => {
    if (returnFocus === null || event.defaultPrevented) return;
    // Focus already moved somewhere real (a dialog, a clicked input): keep it.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    event.preventDefault();
    returnFocus();
  };
}
