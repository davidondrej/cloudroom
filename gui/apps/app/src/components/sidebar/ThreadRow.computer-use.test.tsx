// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ThreadListEntry } from "@cloudroom/domain";
import { TooltipProvider } from "@cloudroom/shared-ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import {
  harnessIconModeAtom,
  type HarnessIconMode,
} from "@/components/settings/HarnessIconsSetting";
import {
  resetComputerUseActiveForTest,
  setComputerUseActiveForTest,
} from "@/lib/computer-use-active";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { SPLIT_LAYOUT_STORAGE_KEY } from "@/lib/split-layout/persistence";
import {
  SIDEBAR_ROW_COMPUTER_USE_STATE_CLASS,
  SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
} from "./sidebarRowClasses";
import { ThreadRow } from "./ThreadRow";

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    renameThread: vi.fn(),
    requestRename: vi.fn(),
    requestDelete: vi.fn(),
    archiveThreadAndChildren: vi.fn(),
    unarchiveThread: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  resetComputerUseActiveForTest();
  window.localStorage.removeItem(SPLIT_LAYOUT_STORAGE_KEY);
  window.sessionStorage.removeItem(SPLIT_LAYOUT_STORAGE_KEY);
  window.localStorage.removeItem("bb.sidebar.harnessIcons");
});

function makeThread(
  overrides: Parameters<typeof makeThreadListEntry>[0] = {},
): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_cu",
    title: "Book flights",
    titleFallback: "Book flights",
    status: "active",
    runtime: { displayStatus: "active" },
    ...overrides,
  });
}

function renderRow(options: {
  thread?: ThreadListEntry;
  isActive?: boolean;
  harnessIconMode?: HarnessIconMode;
  store?: ReturnType<typeof createStore>;
} = {}) {
  const store = options.store ?? createStore();
  if (options.harnessIconMode) {
    store.set(harnessIconModeAtom, options.harnessIconMode);
  }
  const thread = options.thread ?? makeThread();
  const result = render(
    <Provider store={store}>
      <TooltipProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ThreadRow
              thread={thread}
              projectId="proj_1"
              crossProjectId={null}
              isActive={options.isActive ?? false}
              hasComposerDraft={false}
              options={{ kind: "default", depth: 0, isCompact: false }}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </TooltipProvider>
    </Provider>,
  );
  const link = screen.getByRole("link");
  const row = link.parentElement as HTMLElement;
  return { ...result, link, row };
}

describe("ThreadRow computer-use indicator", () => {
  it("renders design 1C row glow, lit laptop with app label, and sky-tinted spinner", () => {
    setComputerUseActiveForTest([{ threadId: "thr_cu", appName: "Brave" }]);

    const { link, row } = renderRow();

    expect(row.className).toContain(SIDEBAR_ROW_COMPUTER_USE_STATE_CLASS);
    expect(link.getAttribute("aria-label")).toBe(
      "Open Book flights (Using Brave)",
    );

    const iconWrapper = screen.getByRole("img", { name: "Using Brave" });
    expect(
      iconWrapper.querySelector(".bb-sidebar-computer-use-laptop"),
    ).not.toBeNull();
    expect(row.querySelector(".bb-sidebar-computer-use-spinner")).not.toBeNull();
  });

  it("falls back to generic copy when appName is null", () => {
    setComputerUseActiveForTest([{ threadId: "thr_cu", appName: null }]);

    const { link } = renderRow();

    expect(link.getAttribute("aria-label")).toBe(
      "Open Book flights (Using your computer)",
    );
    expect(
      screen.getByRole("img", { name: "Using your computer" }),
    ).not.toBeNull();
  });

  it("keeps selected row background while preserving glowing laptop and spinner", () => {
    setComputerUseActiveForTest([{ threadId: "thr_cu", appName: "Brave" }]);

    const { row } = renderRow({ isActive: true });

    expect(row.className).not.toContain(SIDEBAR_ROW_COMPUTER_USE_STATE_CLASS);
    expect(row.querySelector(".bb-sidebar-computer-use-laptop")).not.toBeNull();
    expect(row.querySelector(".bb-sidebar-computer-use-spinner")).not.toBeNull();
  });

  it("yields row tint to Needs you state", () => {
    setComputerUseActiveForTest([{ threadId: "thr_cu", appName: "Brave" }]);

    const { row } = renderRow({
      thread: makeThread({ hasPendingInteraction: true }),
    });

    expect(row.className).not.toContain(SIDEBAR_ROW_COMPUTER_USE_STATE_CLASS);
  });

  it("takes priority over open-in-split row tint and harnessIconMode=instead", () => {
    setComputerUseActiveForTest([{ threadId: "thr_cu", appName: "Brave" }]);
    const store = createStore();
    store.set(splitLayoutAtom, {
      focusedPaneId: "pane-other",
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "pane",
            paneId: "pane-cu",
            content: {
              kind: "thread",
              projectId: "proj_1",
              threadId: "thr_cu",
            },
          },
          {
            type: "pane",
            paneId: "pane-other",
            content: {
              kind: "thread",
              projectId: "proj_1",
              threadId: "thr_other",
            },
          },
        ],
      },
    });

    const { row } = renderRow({ harnessIconMode: "instead", store });

    expect(row.className).toContain(SIDEBAR_ROW_COMPUTER_USE_STATE_CLASS);
    expect(row.className).not.toContain(SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS);
    expect(row.querySelector(".bb-sidebar-computer-use-laptop")).not.toBeNull();
  });
});
