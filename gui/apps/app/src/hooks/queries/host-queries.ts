import { useMemo } from "react";
import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import type { Host } from "@cloudroom/domain";
import type { HostDirectoryListing } from "@cloudroom/server-contract";
import { sdk } from "@/lib/sdk";
import { useHostListRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  hostCloneDefaultPathQueryKey,
  hostDirectoryQueryKey,
  hostsQueryKey,
} from "./query-keys";
import type { QueryOptions } from "./query-helpers";

export function useHosts(
  options?: QueryOptions & { includeCreating?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const includeCreating = options?.includeCreating ?? false;
  useHostListRealtimeSubscription({ enabled });

  return useQuery<Host[]>({
    queryKey: hostsQueryKey(includeCreating),
    queryFn: ({ signal }) => sdk.hosts.list({ signal, includeCreating }),
    enabled,
    staleTime: 60_000,
  });
}

export type HostScope = "persistent" | "all";

export function selectHosts(
  hosts: readonly Host[] | undefined,
  scope: HostScope,
): Host[] {
  const everyHost = hosts ? [...hosts] : [];
  return scope === "all"
    ? everyHost
    : everyHost.filter((host) => host.type !== "ephemeral");
}

export function selectPrimaryHost(
  hosts: readonly Host[] | undefined,
  primaryHostId: string | null,
): Host | null {
  const availableHosts = selectHosts(hosts, "persistent");
  if (availableHosts.length === 0) return null;
  if (primaryHostId !== null) {
    return availableHosts.find((host) => host.id === primaryHostId) ?? null;
  }
  return (
    availableHosts.find((host) => host.status === "connected") ??
    availableHosts[0] ??
    null
  );
}

export function usePrimaryHost(options?: QueryOptions): Host | null {
  const { data: hosts } = useHosts(options);
  const primaryHostId = useSystemConfig(options).data?.primaryHostId ?? null;
  return useMemo(
    () => selectPrimaryHost(hosts, primaryHostId),
    [hosts, primaryHostId],
  );
}

export function useHostCloneDefaultPath(
  hostId: string | null,
  projectId: string | null,
  options?: QueryOptions,
) {
  const enabled = options?.enabled ?? true;
  return useQuery<string>({
    queryKey: hostCloneDefaultPathQueryKey(hostId, projectId),
    queryFn:
      enabled && hostId !== null && projectId !== null
        ? async ({ signal }) =>
            (await sdk.hosts.cloneDefaultPath({ hostId, projectId, signal }))
              .path
        : skipToken,
    staleTime: 60_000,
  });
}

/** Folders anywhere under the host's home whose names match `search`. An empty search warms the host's index. */
export function useHostFolderSearch(hostId: string | null, search: string) {
  return useQuery<HostDirectoryListing>({
    queryKey: ["host-folder-search", hostId, search],
    queryFn: ({ signal }) =>
      sdk.hosts.directory({ hostId: hostId as string, search, signal }),
    enabled: hostId != null,
    placeholderData: keepPreviousData,
    staleTime: search ? 30_000 : 5 * 60_000,
    retry: false,
  });
}

export function useHostDirectory(
  hostId: string | null,
  path: string | null,
  options?: { retry?: false },
) {
  return useQuery<HostDirectoryListing>({
    ...options,
    queryKey: hostDirectoryQueryKey(hostId, path),
    queryFn: ({ signal }) =>
      sdk.hosts.directory({
        hostId: hostId as string,
        ...(path ? { path } : {}),
        signal,
      }),
    enabled: hostId != null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
