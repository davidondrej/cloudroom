// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import { makeSidebarBootstrapResponse } from "@/test/fixtures/projects";
import type { SidebarBootstrapResponse } from "@cloudroom/server-contract";

const fixture = vi.hoisted(() => ({
  data: undefined as SidebarBootstrapResponse | undefined,
}));
vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: fixture.data, isError: false }),
}));
vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));
const { useSidebarThreads } = await import("./plugin-sidebar-hooks");
afterEach(cleanup);

it("delivers hidden running children once, with grouping and execution evidence, independently of project rows", () => {
  const child = makeThreadListEntry({
    id: "child",
    parentThreadId: "absent",
    status: "active",
    visibility: "hidden",
    execution: {
      status: "active",
      source: "core",
      freshness: "last-known",
      observedAt: 50,
      receivedAt: 60,
      model: "observed",
      effort: null,
    },
  });
  fixture.data = { ...makeSidebarBootstrapResponse(), runningThreads: [child] };
  const { result, rerender } = renderHook(useSidebarThreads);
  expect(result.current.runningThreads?.map((thread) => thread.id)).toEqual([
    "child",
  ]);
  expect(
    result.current.threads.filter((thread) => thread.id === "child"),
  ).toHaveLength(1);
  expect(result.current.childrenByParentId?.absent?.[0]).toMatchObject({
    id: "child",
    execution: child.execution,
  });
  fixture.data = { ...fixture.data, runningThreads: [] };
  rerender();
  expect(result.current.runningThreads).toEqual([]);
  expect(result.current.childrenByParentId?.absent).toBeUndefined();
});
