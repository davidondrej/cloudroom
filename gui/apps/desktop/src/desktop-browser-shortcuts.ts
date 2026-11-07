import {
  appCommandIdSchema,
  matchesAppShortcut,
  normalizeAppShortcutInputKey,
  type AppCommandContextKey,
  type AppCommandId,
  type AppKeybindings,
  type AppShortcutInput,
} from "@cloudroom/domain";

interface FindDesktopBrowserShortcutCandidatesArgs {
  input: AppShortcutInput;
  isMac: boolean;
  keybindings: AppKeybindings;
}

// A resolved command (understood by every app version), or the key press for
// the renderer to resolve when the command depends on context only it knows.
export type DesktopBrowserShortcut =
  | { command: AppCommandId }
  | { input: AppShortcutInput };

// Edit keys the focused page must always receive with Mod (and Mod+Shift).
const PAGE_EDIT_KEYS = new Set(["a", "c", "v", "x", "z"]);

// Decides what a shortcut pressed in a focused native browser page does. Main
// rules bindings out only by state it knows; other context (split panes,
// composer, plugins) is left to the renderer.
export function findDesktopBrowserShortcutCandidates({
  input,
  isMac,
  keybindings,
}: FindDesktopBrowserShortcutCandidatesArgs): DesktopBrowserShortcut | null {
  // Only chords with Cmd or Ctrl; plain typing, Shift and Option/Alt stay in the page.
  if (!input.metaKey && !input.ctrlKey) return null;
  const modKey = isMac ? input.metaKey : input.ctrlKey;
  if (
    modKey &&
    !input.altKey &&
    PAGE_EDIT_KEYS.has(normalizeAppShortcutInputKey(input).toLowerCase())
  ) {
    return null;
  }
  const known: Partial<Record<AppCommandContextKey, boolean>> = {
    browserFocus: true,
    editableFocus: false,
    macPlatform: isMac,
    mainSurface: true,
    modalOpen: false,
    terminalFocus: false,
    webSurface: false,
  };
  const candidates = keybindings.filter(
    (binding) =>
      matchesAppShortcut(input, binding.shortcut, isMac) &&
      binding.when.all.every((key) => known[key] !== false) &&
      binding.when.none.every((key) => known[key] !== true),
  );
  const first = candidates[0];
  if (first === undefined) return null;
  const command = appCommandIdSchema.safeParse(first.command);
  const unambiguous = candidates.every(
    (binding) =>
      binding.command === first.command &&
      [...binding.when.all, ...binding.when.none].every(
        (key) => known[key] !== undefined,
      ),
  );
  return command.success && unambiguous ? { command: command.data } : { input };
}
