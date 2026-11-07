import { useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useEffect } from "react";
import { createJsonLocalStorage } from "./browser-storage";

// Inter has no Arabic, Hebrew or other non-Latin glyphs, so the browser falls
// back per glyph to the next family in --font-sans. --font-script is that
// family: Latin text keeps Inter, other scripts use the chosen font.
export const SYSTEM_SCRIPT_FONT = "";
export const BUNDLED_SCRIPT_FONT = "Vazirmatn Variable";
/** Family name an uploaded font file is registered under. */
export const UPLOADED_SCRIPT_FONT = "Cloudroom Uploaded Font";
export const DEFAULT_SCRIPT_FONT = SYSTEM_SCRIPT_FONT;

export const CHAT_FONT_SIZES = [14, 15, 16, 17, 18] as const;
export const CHAT_LINE_HEIGHTS = [1.625, 1.8, 2] as const;
export const DEFAULT_CHAT_FONT_SIZE = 14;
export const DEFAULT_CHAT_LINE_HEIGHT = 1.625;

export const FONT_FILE_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"] as const;
export const MAX_FONT_FILE_BYTES = 20 * 1024 * 1024;

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const scriptFontAtom = atomWithStorage<string>(
  "cloudroom.reading.scriptFont",
  DEFAULT_SCRIPT_FONT,
  createJsonLocalStorage<string>(isString),
  { getOnInit: true },
);

/** File name of the uploaded font, shown in Settings; the bytes live in IndexedDB. */
export const uploadedFontNameAtom = atomWithStorage<string>(
  "cloudroom.reading.uploadedFontName",
  "",
  createJsonLocalStorage<string>(isString),
  { getOnInit: true },
);

export const chatFontSizeAtom = atomWithStorage<number>(
  "cloudroom.reading.chatFontSize",
  DEFAULT_CHAT_FONT_SIZE,
  createJsonLocalStorage<number>(isNumber),
  { getOnInit: true },
);

export const chatLineHeightAtom = atomWithStorage<number>(
  "cloudroom.reading.chatLineHeight",
  DEFAULT_CHAT_LINE_HEIGHT,
  createJsonLocalStorage<number>(isNumber),
  { getOnInit: true },
);

/** Quote a user-typed family name so it is safe inside a CSS font stack. */
export function scriptFontStackEntry(font: string): string {
  const name = font.trim().replace(/["\\;{}]/gu, "");
  return name === "" ? "sans-serif" : `"${name}"`;
}

/** Returns an error message, or null when the file can be tried as a font. */
export function fontFileProblem(file: { name: string; size: number }): string | null {
  const name = file.name.toLowerCase();
  if (!FONT_FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return "Choose a .ttf, .otf, .woff or .woff2 file.";
  }
  if (file.size > MAX_FONT_FILE_BYTES) return "Font files must be 20 MB or smaller.";
  return null;
}

const FONT_DB = "cloudroom-reading";
const FONT_STORE = "fonts";
const FONT_KEY = "uploaded";

function openFontDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FONT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FONT_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withFontStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openFontDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(FONT_STORE, mode).objectStore(FONT_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

let registeredFace: FontFace | null = null;

async function registerFontData(data: ArrayBuffer): Promise<void> {
  const face = new FontFace(UPLOADED_SCRIPT_FONT, data);
  await face.load();
  if (registeredFace !== null) document.fonts.delete(registeredFace);
  document.fonts.add(face);
  registeredFace = face;
}

/** Validates the file as a real font, registers it, then stores it for next launch. */
export async function installUploadedFont(file: File): Promise<void> {
  const problem = fontFileProblem(file);
  if (problem !== null) throw new Error(problem);
  const data = await file.arrayBuffer();
  try {
    await registerFontData(data.slice(0));
  } catch {
    throw new Error("This file could not be read as a font.");
  }
  await withFontStore("readwrite", (store) => store.put(data, FONT_KEY));
}

async function restoreUploadedFont(): Promise<void> {
  if (registeredFace !== null) return;
  const data = await withFontStore<unknown>("readonly", (store) =>
    store.get(FONT_KEY),
  );
  if (data instanceof ArrayBuffer) await registerFontData(data);
}

export function useApplyReadingPreferences(): void {
  const scriptFont = useAtomValue(scriptFontAtom);
  const fontSize = useAtomValue(chatFontSizeAtom);
  const lineHeight = useAtomValue(chatLineHeightAtom);

  useEffect(() => {
    if (scriptFont !== UPLOADED_SCRIPT_FONT) return;
    // A missing or unreadable stored font falls back to the next family.
    restoreUploadedFont().catch(() => undefined);
  }, [scriptFont]);

  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--font-script", scriptFontStackEntry(scriptFont));
    style.setProperty("--chat-font-size", `${fontSize}px`);
    style.setProperty("--chat-line-height", String(lineHeight));
  }, [scriptFont, fontSize, lineHeight]);
}
