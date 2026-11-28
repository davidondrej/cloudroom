import { useLayoutEffect, useReducer, useRef } from "react";
import { matchPath, useLocation, useNavigationType } from "react-router";
import {
  getRootComposeRoutePath,
  SETTINGS_ROUTE_PATH,
  LEGACY_PROJECT_SETTINGS_ROUTE_PATH,
} from "@/lib/route-paths";

interface AppSettingsRouteMemory {
  appRoutePath: string;
  settingsRoutePath: string;
}

function getLocationRoutePath(location: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function isSettingsRoutePath(pathname: string): boolean {
  return (
    matchPath(`${SETTINGS_ROUTE_PATH}/*`, pathname) !== null ||
    matchPath(LEGACY_PROJECT_SETTINGS_ROUTE_PATH, pathname) !== null
  );
}

interface RouteMemory {
  app: string;
  settings: string;
  /** Each side's page before its current one, restored when a redirect throws the current one away. */
  appBefore: string;
  settingsBefore: string;
  onSettings: boolean;
}

export function useAppSettingsRouteMemory(): AppSettingsRouteMemory {
  const location = useLocation();
  const navigationType = useNavigationType();
  const currentRoutePath = getLocationRoutePath(location);
  const isSettingsRoute = isSettingsRoutePath(location.pathname);
  const memoryRef = useRef<RouteMemory>({
    app: isSettingsRoute ? getRootComposeRoutePath() : currentRoutePath,
    settings: isSettingsRoute ? currentRoutePath : SETTINGS_ROUTE_PATH,
    appBefore: getRootComposeRoutePath(),
    settingsBefore: SETTINGS_ROUTE_PATH,
    onSettings: isSettingsRoute,
  });
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  useLayoutEffect(() => {
    const memory = memoryRef.current;
    const redirected = navigationType === "REPLACE";
    const crossed = memory.onSettings !== isSettingsRoute;
    memory.onSettings = isSettingsRoute;
    // A redirect between the app and Settings replaced a page nobody stayed on: forget it.
    // Covers old /extensions links, installing from a listing, and stale Settings links.
    if (redirected && crossed) {
      if (isSettingsRoute) memory.app = memory.appBefore;
      else memory.settings = memory.settingsBefore;
      // oxlint-disable-next-line react/set-state-in-effect
      rerender();
    }
    // A redirect within one side swaps its page in place, so the page before stays the same.
    const movedOn = !redirected || crossed;
    if (isSettingsRoute) {
      if (movedOn) memory.settingsBefore = memory.settings;
      memory.settings = currentRoutePath;
    } else {
      if (movedOn) memory.appBefore = memory.app;
      memory.app = currentRoutePath;
    }
  }, [currentRoutePath, isSettingsRoute, navigationType]);

  return {
    appRoutePath: isSettingsRoute ? memoryRef.current.app : currentRoutePath,
    settingsRoutePath: isSettingsRoute
      ? currentRoutePath
      : memoryRef.current.settings,
  };
}
