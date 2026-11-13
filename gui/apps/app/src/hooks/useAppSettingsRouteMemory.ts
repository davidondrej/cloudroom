import { useEffect, useRef } from "react";
import { matchPath, useLocation } from "react-router-dom";
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

function isSettingsRoutePath(pathname: string): boolean {
  return (
    matchPath(`${SETTINGS_ROUTE_PATH}/*`, pathname) !== null ||
    matchPath(LEGACY_PROJECT_SETTINGS_ROUTE_PATH, pathname) !== null
  );
}

export function useAppSettingsRouteMemory(): AppSettingsRouteMemory {
  const location = useLocation();
  const currentRoutePath = getLocationRoutePath(location);
  const isSettingsRoute = isSettingsRoutePath(location.pathname);
  const lastAppRoutePathRef = useRef(
    isSettingsRoute ? getRootComposeRoutePath() : currentRoutePath,
  );
  const lastSettingsRoutePathRef = useRef(
    isSettingsRoute ? currentRoutePath : SETTINGS_ROUTE_PATH,
  );

  useEffect(() => {
    if (isSettingsRoute) {
      lastSettingsRoutePathRef.current = currentRoutePath;
      return;
    }
    lastAppRoutePathRef.current = currentRoutePath;
  }, [currentRoutePath, isSettingsRoute]);

  return {
    appRoutePath: isSettingsRoute
      ? lastAppRoutePathRef.current
      : currentRoutePath,
    settingsRoutePath: isSettingsRoute
      ? currentRoutePath
      : lastSettingsRoutePathRef.current,
  };
}
