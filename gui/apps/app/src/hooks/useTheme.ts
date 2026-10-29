import * as React from "react";
import { getDefaultStore } from "jotai";
import {
  DARK_COLOR_SCHEME_QUERY,
  getMediaQuerySnapshot,
  subscribeMediaQuery,
} from "@cloudroom/shared-ui/hooks/use-media-query";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export const THEME_STORAGE_KEY = "bb.theme";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

type ThemeListener = () => void;

const themePreferenceAtom = createSyncedPreferenceAtom(
  "appearance.theme",
  THEME_STORAGE_KEY,
);

function getThemePreference(): ThemePreference {
  return getDefaultStore().get(themePreferenceAtom);
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  syncThemeColorMeta();
}

function syncThemeColorMeta(): void {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (!meta || !document.body) return;
  const background = window.getComputedStyle(document.body).backgroundColor;
  if (!background || background === "rgba(0, 0, 0, 0)") return;
  meta.content = background;
}

export function refreshThemeColorMeta(): void {
  syncThemeColorMeta();
}

function getSystemTheme(): Theme {
  return getMediaQuerySnapshot(DARK_COLOR_SCHEME_QUERY) ? "dark" : "light";
}

function getPreferredTheme(): Theme {
  const themePreference = getThemePreference();
  return themePreference === "system" ? getSystemTheme() : themePreference;
}

export function setPreferredTheme(themePreference: ThemePreference): void {
  getDefaultStore().set(themePreferenceAtom, themePreference);
  applyThemeClass(getPreferredTheme());
  emitTheme();
}

let currentTheme: Theme = "light";
let currentThemePreference: ThemePreference = "system";
const themeSubscribers = new Set<ThemeListener>();
const themePreferenceSubscribers = new Set<ThemeListener>();
let initialized = false;

function emitTheme() {
  const nextThemePreference = getThemePreference();
  const nextTheme = getPreferredTheme();
  applyThemeClass(nextTheme);

  const themePreferenceChanged = nextThemePreference !== currentThemePreference;
  const themeChanged = nextTheme !== currentTheme;

  currentThemePreference = nextThemePreference;
  currentTheme = nextTheme;

  if (themePreferenceChanged) {
    themePreferenceSubscribers.forEach((listener) => listener());
  }
  if (themeChanged) {
    themeSubscribers.forEach((listener) => listener());
  }
}

function ensureThemeObserver() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  currentThemePreference = getThemePreference();
  currentTheme = getPreferredTheme();
  applyThemeClass(currentTheme);
  getDefaultStore().sub(themePreferenceAtom, emitTheme);

  subscribeMediaQuery(DARK_COLOR_SCHEME_QUERY, emitTheme);
}

export function initializePreferredTheme(): void {
  ensureThemeObserver();
}

function subscribePreferredTheme(listener: ThemeListener): () => void {
  ensureThemeObserver();
  themeSubscribers.add(listener);
  return () => {
    themeSubscribers.delete(listener);
  };
}

export function usePreferredTheme(): Theme {
  return React.useSyncExternalStore(
    subscribePreferredTheme,
    () => {
      if (typeof window === "undefined") return "light";
      currentTheme = getPreferredTheme();
      return currentTheme;
    },
    () => "light",
  );
}

function subscribeThemePreference(listener: ThemeListener): () => void {
  ensureThemeObserver();
  themePreferenceSubscribers.add(listener);
  return () => {
    themePreferenceSubscribers.delete(listener);
  };
}

export function useThemePreference(): ThemePreference {
  return React.useSyncExternalStore(
    subscribeThemePreference,
    getThemePreference,
    () => "system",
  );
}
