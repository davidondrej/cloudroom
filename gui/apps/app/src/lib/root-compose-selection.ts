import { atom, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { createTabScopedStorage } from "./browser-storage";

const ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY = "bb.root-compose.project-id";

function parseStoredProjectId(
  storedValue: string | null,
  initialValue: string,
): string {
  return storedValue && storedValue.length > 0 ? storedValue : initialValue;
}

const rootComposeProjectIdStorage = createTabScopedStorage<string>(
  {
    parse: parseStoredProjectId,
    serialize: (value) => value,
  },
  { persistInitialValue: true },
);

const rootComposeProjectIdAtom = atomWithStorage<string>(
  ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY,
  PERSONAL_PROJECT_ID,
  rootComposeProjectIdStorage,
  { getOnInit: true },
);

const rootComposeReuseEnvironmentAtom = atom<string | null>(null);

export function useRootComposeProjectId() {
  return useAtom(rootComposeProjectIdAtom);
}

export function useSetRootComposeProjectId() {
  return useSetAtom(rootComposeProjectIdAtom);
}

export function useRootComposeReuseEnvironment() {
  return useAtom(rootComposeReuseEnvironmentAtom);
}

const warnedPluginComposeOptions = new Set<string>();

/** Route state RootComposeView reads for a plugin's section and environment; warns once for options it can't apply yet. */
export function pluginComposeRouteState(
  pluginId: string | null,
  method: string,
  options: {
    sectionId?: string | null;
    pinned?: boolean;
    environmentId?: string;
    hostId?: string;
  },
): { sectionId?: string | null; reuseEnvironmentId?: string } {
  const ignored = [
    ...(options.pinned ? ["pinned"] : []),
    ...(options.hostId && !options.environmentId ? ["hostId"] : []),
  ];
  for (const option of ignored) {
    const key = `${pluginId}:${method}:${option}`;
    if (warnedPluginComposeOptions.has(key)) continue;
    warnedPluginComposeOptions.add(key);
    console.warn(
      `plugin ${pluginId}: ${method} option "${option}" ignored — not supported in Cloudroom yet`,
    );
  }
  return {
    ...(options.sectionId !== undefined
      ? { sectionId: options.sectionId }
      : {}),
    ...(options.environmentId
      ? { reuseEnvironmentId: options.environmentId }
      : {}),
  };
}
