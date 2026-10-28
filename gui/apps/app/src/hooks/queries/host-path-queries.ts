import { useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { PATHS_EXIST_MAX_PATHS } from "@cloudroom/host-daemon-contract/local";
import type { HostPathsExistResponse } from "@cloudroom/server-contract";
import { request } from "@/lib/api";
import { apiClient } from "@/lib/api-server";
import { sdk } from "@/lib/sdk";
import {
  hostPathExistenceQueryKey,
  threadFileExistenceQueryKey,
} from "./query-keys";

type HostPathExistence = Record<string, boolean>;

export function useHostPathExistence(
  hostId: string | null,
  paths: readonly string[],
): HostPathExistence {
  const sortedPaths = useMemo(() => {
    if (paths.length === 0) return [];
    return [...new Set(paths)].sort();
  }, [paths]);
  const enabledHostId =
    hostId !== null && sortedPaths.length > 0 ? hostId : null;

  const query = useQuery({
    queryKey: hostPathExistenceQueryKey(hostId, sortedPaths),
    queryFn: enabledHostId
      ? async ({ signal }) =>
          (
            await sdk.hosts.pathsExist({
              hostId: enabledHostId,
              paths: sortedPaths,
              signal,
            })
          ).existence
      : skipToken,
    staleTime: 10_000,
  });

  return query.data ?? {};
}

export function isHostPathMissing(
  existence: HostPathExistence,
  path: string | null | undefined,
): boolean {
  if (path == null) return false;
  return existence[path] === false;
}

type ThreadFileCheck = (exists: boolean | null) => void;

const pendingThreadFileChecks = new Map<
  string,
  Map<string, ThreadFileCheck[]>
>();

async function checkPendingThreadFiles(threadId: string): Promise<void> {
  const pending = pendingThreadFileChecks.get(threadId) ?? new Map();
  pendingThreadFileChecks.delete(threadId);
  const paths = [...pending.keys()];
  for (let start = 0; start < paths.length; start += PATHS_EXIST_MAX_PATHS) {
    const batch = paths.slice(start, start + PATHS_EXIST_MAX_PATHS);
    const existence = await request<HostPathsExistResponse>(
      apiClient.threads[":id"]["host-files"].exist.$post({
        param: { id: threadId },
        json: { paths: batch },
      }),
    ).then(
      (result) => result.existence,
      () => ({}) as HostPathsExistResponse["existence"],
    );
    for (const path of batch) {
      for (const resolve of pending.get(path) ?? []) {
        resolve(existence[path] ?? null);
      }
    }
  }
}

function checkThreadFile(threadId: string, path: string) {
  return new Promise<boolean | null>((resolve) => {
    let pending = pendingThreadFileChecks.get(threadId);
    if (pending === undefined) {
      pending = new Map();
      pendingThreadFileChecks.set(threadId, pending);
      setTimeout(() => void checkPendingThreadFiles(threadId), 50);
    }
    pending.set(path, [...(pending.get(path) ?? []), resolve]);
  });
}

export function useThreadFileExists(
  threadId: string | undefined,
  path: string | null,
): boolean | null {
  const query = useQuery({
    queryKey: threadFileExistenceQueryKey(threadId ?? null, path),
    queryFn:
      threadId !== undefined && path !== null
        ? async () => {
            const exists = await checkThreadFile(threadId, path);
            if (exists === null) throw new Error("File check unavailable");
            return exists;
          }
        : skipToken,
    retry: false,
    staleTime: 60_000,
  });
  return query.data ?? null;
}
