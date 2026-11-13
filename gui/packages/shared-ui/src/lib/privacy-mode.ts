import { useSyncExternalStore } from "react";

// Privacy mode hides emails on screen, for recordings. It is saved in the app's own storage, so it survives a restart.
// Plugins are bundled apart, so every part of the app follows one window event instead of shared state.
const KEY = "cloudroom.privacy-mode";
const CHANGED = "cloudroom:privacy-mode";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}

function setPrivacyMode(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event(CHANGED));
}

export function usePrivacyMode(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, read, () => false), setPrivacyMode];
}

const BRAILLE = "⠁⠃⠇⠏⠟⠿⡿⣿⢿⣻⣽⣾⣷⣯⣟⡷⢾⠾⠷⠯⠽⠻";

/** Braille noise seeded by the whole text, so it stays put but reveals no letters. The website's Privacy mode uses the
 *  same (`scramble` in web/lib/model.ts). */
function scramble(text: string): string {
  let hash = 2166136261;
  for (const char of text)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Array.from(text, () => {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
    return hash % 7 ? BRAILLE[hash % BRAILLE.length] : " ";
  }).join("");
}

/** An email, hidden while Privacy mode is on. Any other text stays: users write account names themselves. */
export function hideEmail(text: string, privacy: boolean): string {
  return privacy && text.includes("@") ? scramble(text) : text;
}
