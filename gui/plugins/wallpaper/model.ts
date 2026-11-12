// Shared by the server and the app. One wallpaper per slot; one slot is active, or none.

export const SLOTS = [1, 2, 3, 4, 5, 6] as const;
export const MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const MAX_BYTES = 8 * 1024 * 1024;
/** Realtime channel: the server publishes the new `WallpaperState` on every change. */
export const CHANGED = "changed";

export interface Look {
  /** 0 to 1. */
  opacity: number;
  fit: "cover" | "contain";
  /** New thread only: fade the wallpaper out halfway down. */
  half: boolean;
  /** Redraw a still image as chunky pixels. */
  dither: boolean;
}

export const DEFAULT_LOOK: Look = { opacity: 0.7, fit: "cover", half: true, dither: false };

export interface Wallpaper {
  slot: number;
  /** Changes with every upload, so the image can be cached forever. */
  version: string;
  animated: boolean;
  look: Look;
}

export interface WallpaperState {
  active: number | null;
  slots: Wallpaper[];
}

export const imageUrl = (version: string) => `/api/v1/plugins/wallpaper/http/image?v=${version}`;
