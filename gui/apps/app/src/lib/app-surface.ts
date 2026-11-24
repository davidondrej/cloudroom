import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_HEADER_NAME,
  APP_SURFACE_MOBILE,
  APP_SURFACE_WEB,
  type RequestAppSurface,
} from "@cloudroom/config/app-surface";
import { COMPACT_VIEWPORT_QUERY } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";

export function getAppSurface(): RequestAppSurface {
  if (typeof window !== "undefined" && window.bbDesktop !== undefined) {
    return APP_SURFACE_DESKTOP;
  }
  // A phone is a touch screen that is narrow. Tablets and browsers on a computer stay "web".
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(POINTER_COARSE_QUERY).matches &&
    window.matchMedia(COMPACT_VIEWPORT_QUERY).matches
  ) {
    return APP_SURFACE_MOBILE;
  }
  return APP_SURFACE_WEB;
}

export function appSurfaceRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(APP_SURFACE_HEADER_NAME, getAppSurface());
  return {
    ...init,
    headers,
  };
}

export function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  return fetch(input, appSurfaceRequestInit(init));
}
