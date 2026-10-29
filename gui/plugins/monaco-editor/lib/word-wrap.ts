const STORAGE_KEY = "bb-plugin-monaco-editor:word-wrap";

export function readStoredWordWrap(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function storeWordWrap(wrapped: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, wrapped ? "on" : "off");
  } catch {}
}
