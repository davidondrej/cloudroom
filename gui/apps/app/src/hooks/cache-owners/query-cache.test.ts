import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ARCHIVED_THREADS_LIST_KIND,
  THREADS_QUERY_KEY,
  archivedThreadsListQueryKey,
  threadListQueryKey,
} from "../queries/query-keys";
import {
  getCachedGlobalThreadListInvalidationQueryKeys,
  getCachedProjectThreadListInvalidationQueryKeys,
} from "./query-cache";

describe("query cache thread list invalidation keys", () => {
  it("includes global archived lists in global invalidation", () => {
    const { queryClient } = createQueryClientTestHarness();
    const projectArchivedKey = archivedThreadsListQueryKey({
      projectId: "proj_1",
    });
    const globalArchivedKey = archivedThreadsListQueryKey({});
    const globalChildArchivedKey = archivedThreadsListQueryKey({
      kind: "child",
    });

    queryClient.setQueryData(projectArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(globalArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(globalChildArchivedKey, {
      pages: [],
      pageParams: [],
    });

    const queryKeys = getCachedGlobalThreadListInvalidationQueryKeys({
      queryClient,
    });

    expect(queryKeys).toContainEqual(globalArchivedKey);
    expect(queryKeys).toContainEqual(globalChildArchivedKey);
    expect(queryKeys).not.toContainEqual(projectArchivedKey);
  });

  it("excludes archived list keys with unsupported scope filters", () => {
    const { queryClient } = createQueryClientTestHarness();
    const sectionArchivedKey: QueryKey = [
      THREADS_QUERY_KEY,
      ARCHIVED_THREADS_LIST_KIND,
      { sectionId: "sec_work" },
    ];
    const unsectionedArchivedKey: QueryKey = [
      THREADS_QUERY_KEY,
      ARCHIVED_THREADS_LIST_KIND,
      { unsectioned: true },
    ];

    queryClient.setQueryData(sectionArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(unsectionedArchivedKey, {
      pages: [],
      pageParams: [],
    });

    const queryKeys = getCachedGlobalThreadListInvalidationQueryKeys({
      queryClient,
    });

    expect(queryKeys).not.toContainEqual(sectionArchivedKey);
    expect(queryKeys).not.toContainEqual(unsectionedArchivedKey);
  });

  it("includes archived project lists in project invalidation", () => {
    const { queryClient } = createQueryClientTestHarness();
    const projectArchivedKey = archivedThreadsListQueryKey({
      projectId: "proj_1",
    });
    const projectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "proj_1",
    });
    const otherProjectArchivedKey = archivedThreadsListQueryKey({
      projectId: "proj_2",
    });

    queryClient.setQueryData(projectArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(projectThreadListKey, []);
    queryClient.setQueryData(otherProjectArchivedKey, {
      pages: [],
      pageParams: [],
    });

    const queryKeys = getCachedProjectThreadListInvalidationQueryKeys({
      projectId: "proj_1",
      queryClient,
    });

    expect(queryKeys).toContainEqual(projectArchivedKey);
    expect(queryKeys).toContainEqual(projectThreadListKey);
    expect(queryKeys).not.toContainEqual(otherProjectArchivedKey);
  });
});

it("unions running rows once and removes settled rows from that inventory on a realtime patch", async () => {
  const { makeThreadListEntry } =
    await import("@cloudroom/test-helpers/domain-fixtures");
  const { sidebarNavigationQueryKey } = await import("../queries/query-keys");
  const {
    listSidebarNavigationThreads,
    updateCachedThreadListStatusState,
    applyToCachedSidebarNavigationThreads,
  } = await import("./query-cache");
  const { queryClient } = createQueryClientTestHarness();
  const running = makeThreadListEntry({
    id: "running",
    status: "active",
    visibility: "hidden",
    execution: {
      status: "active",
      source: "core",
      freshness: "last-known",
      observedAt: 100,
      receivedAt: 100,
      model: null,
      effort: null,
    },
  });
  const { makeProjectWithThreadsResponse } =
    await import("@/test/fixtures/projects");
  const project = makeProjectWithThreadsResponse({ threads: [running] });
  const navigation = {
    sections: [],
    projects: [project],
    personalProject: { ...project, id: "personal", threads: [] },
    runningThreads: [running],
  };
  queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
  expect(listSidebarNavigationThreads(navigation).map((t) => t.id)).toEqual([
    "running",
  ]);
  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper: (threads) => threads,
  });
  expect(
    queryClient.getQueryData<typeof navigation>(sidebarNavigationQueryKey())
      ?.runningThreads,
  ).toHaveLength(1);
  updateCachedThreadListStatusState(queryClient, "running", {
    status: "idle",
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    activity: running.activity,
    updatedAt: 200,
    latestAttentionAt: 200,
  });
  expect(
    queryClient.getQueryData<typeof navigation>(sidebarNavigationQueryKey())
      ?.runningThreads,
  ).toEqual([]);
});
