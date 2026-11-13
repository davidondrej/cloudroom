export const CONTROL_HOVER_TRANSITION =
  "transition-colors duration-150 hover:duration-0";

export const LIST_HOVER_TRANSITION = "transition-none";

/** Touch press feedback for buttons: shrink on touch-down, spring back on release.
 *  Styled in the app's theme.css; a no-op where that stylesheet is not loaded. */
export const CONTROL_PRESS_FEEDBACK = "press-feedback";

/** Touch press feedback for list rows: a tint instead of a shrink. */
export const LIST_PRESS_FEEDBACK = "press-highlight";
