// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  collapseChildThreadsAtom,
  collapsedThreadIdsAtom,
  expandedThreadIdsAtom,
} from "./sidebarCollapsedAtoms";
import { useThreadCollapse } from "./useThreadCollapse";

const threads = [
  { parentThreadId: null },
  { parentThreadId: "main" },
  { parentThreadId: "main" },
  { parentThreadId: null },
  { parentThreadId: "other" },
];

function renderCollapse(collapseChildThreads: boolean) {
  const store = createStore();
  store.set(collapseChildThreadsAtom, collapseChildThreads);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  const view = renderHook(() => useThreadCollapse(threads), { wrapper });
  return { store, view };
}

describe("useThreadCollapse", () => {
  it("keeps today's expanded default when the setting is off", () => {
    const { store, view } = renderCollapse(false);
    expect([...view.result.current.collapsedThreadIds]).toEqual([]);

    act(() => view.result.current.toggleThreadCollapsed("main"));
    expect([...view.result.current.collapsedThreadIds]).toEqual(["main"]);

    act(() => view.result.current.expandThreads(["main"]));
    expect(store.get(collapsedThreadIdsAtom)).toEqual([]);
    expect(store.get(expandedThreadIdsAtom)).toEqual([]);
  });

  it("collapses every thread with subagents until expanded when on", () => {
    const { store, view } = renderCollapse(true);
    expect([...view.result.current.collapsedThreadIds]).toEqual([
      "main",
      "other",
    ]);

    act(() => view.result.current.toggleThreadCollapsed("main"));
    expect([...view.result.current.collapsedThreadIds]).toEqual(["other"]);

    act(() => view.result.current.expandThreads(["main", "other"]));
    expect(store.get(expandedThreadIdsAtom)).toEqual(["main", "other"]);

    act(() => view.result.current.toggleThreadCollapsed("main"));
    expect([...view.result.current.collapsedThreadIds]).toEqual(["main"]);
    expect(store.get(collapsedThreadIdsAtom)).toEqual([]);
  });
});
