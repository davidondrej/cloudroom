// What UI text calls the user's own computer: "Mac" on macOS, "computer" on Linux (ADR 0180).
// Node also reports "MacIntel" on macOS, so the server and the desktop app use it too.
// iPhones and iPads say "Mac": nearly every phone user pairs with one.
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);

export const COMPUTER = isMac ? "Mac" : "computer";
export const COMPUTER_TITLE = isMac ? "Mac" : "Computer";
