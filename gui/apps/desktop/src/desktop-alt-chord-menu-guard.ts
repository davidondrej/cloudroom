import type { WebContents } from "electron";

interface AltChordInput {
  alt: boolean;
  control: boolean;
  isAutoRepeat: boolean;
  key: string;
  meta: boolean;
  shift: boolean;
  type: string;
}

// Windows auto-hides the menu bar, and Electron shows and focuses it when Alt
// is released. Electron misses an Alt pressed while Shift is held, so the
// Shift+Alt input-language switch took focus from the chat (#2149). Swallow
// that Alt release when another key was part of the press; a bare Alt tap
// still opens the menu.
export function createAltChordMenuGuard() {
  let altHeld = false;
  let chorded = false;
  const reset = () => {
    altHeld = false;
    chorded = false;
  };
  const shouldSwallow = (input: AltChordInput): boolean => {
    const isAlt = input.key === "Alt" || input.key === "AltGraph";
    if (!isAlt) {
      if (input.alt) chorded = true;
      else reset();
      return false;
    }
    const otherModifier =
      input.key === "AltGraph" || input.shift || input.control || input.meta;
    if (input.type === "keyDown") {
      // Held Alt repeats. After Shift↑, Chromium may not flag the first repeat.
      chorded = ((altHeld || input.isAutoRepeat) && chorded) || otherModifier;
      altHeld = true;
      return false;
    }
    const swallow = input.type === "keyUp" && (chorded || otherModifier);
    reset();
    return swallow;
  };
  return { reset, shouldSwallow };
}

export function registerAltChordMenuGuard(webContents: WebContents): void {
  const guard = createAltChordMenuGuard();
  webContents.on("before-input-event", (event, input) => {
    if (guard.shouldSwallow(input)) event.preventDefault();
  });
  webContents.on("blur", guard.reset);
}
