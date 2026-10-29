// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ThreadListEntry } from "@cloudroom/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@cloudroom/shared-ui/tooltip";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ChronologicalSectionThreadSections,
  DropPreviewRow,
  ProjectRow,
  SectionThreadDragOverlay,
  type ProjectThreadListState,
} from "./ProjectRow";
import { buildSidebarEntitySectionId } from "@cloudroom/client-core";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import { makeProjectResponse } from "@/test/fixtures/projects";

const mockDraftThreadIds = vi.hoisted(() => ({
  current: new Set<string>(),
}));

vi.mock("@/hooks/useLocalPathPicker", () => ({
  usePathPickerHost: () => ({ hostId: null, hostName: null }),
}));

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftHasInput: () => false,
  usePromptDraftInputThreadIds: () => mockDraftThreadIds.current,
}));

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  useProjectActions: () => ({
    requestRename: vi.fn(),
    requestDelete: vi.fn(),
    requestAddLocalPath: vi.fn(),
  }),
}));

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

function makeThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_test",
    title: "Test thread",
    titleFallback: "Test thread",
    ...overrides,
  });
}

function renderProjectRow(
  onToggleProjectCollapsed = vi.fn(),
  threadListState: ProjectThreadListState = { status: "ready", threads: [] },
  isActive = false,
  isCollapsed = false,
) {
  const result = render(
    <TooltipProvider>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ProjectRow
            project={makeProjectResponse()}
            threadListState={threadListState}
            isActive={isActive}
            isCollapsed={isCollapsed}
            compareThreads={() => 0}
            progressiveDisclosureEnabled
            collapsedThreadIds={new Set()}
            isLocalPathInvalid={false}
            onToggleProjectCollapsed={onToggleProjectCollapsed}
            onToggleThreadCollapsed={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </TooltipProvider>,
  );
  return { ...result, onToggleProjectCollapsed };
}

function expectCollapsedActivityAtSidebarEdge(label: string) {
  const edgeSlot = screen
    .getAllByLabelText(label)
    .map((indicator) =>
      indicator.closest("[data-sidebar-collapsed-activity-edge]"),
    )
    .find((slot) => slot !== null);

  expect(edgeSlot).toBeInstanceOf(HTMLElement);
}

describe("ProjectRow interactions", () => {
  it("renders the destination as a line that takes no space", () => {
    render(<DropPreviewRow depth={0} />);

    const preview = document.querySelector(
      '[data-sidebar-section-drop-preview="true"]',
    );
    expect(preview?.className).toContain("h-0");
    expect(preview?.firstElementChild?.className).toContain("bg-sidebar-ring");
  });

  it("renders the dragged copy as a compact opaque chip", () => {
    render(<SectionThreadDragOverlay thread={makeThread()} />);

    const overlay = document.querySelector(
      '[data-sidebar-section-drag-overlay="true"]',
    );
    expect(overlay?.className).toContain("w-fit");
    expect(overlay?.className).toContain("max-w-56");
    expect(overlay?.className).not.toContain("opacity-");
  });

  afterEach(() => {
    cleanup();
    mockDraftThreadIds.current = new Set();
    vi.clearAllMocks();
  });

  it("keeps project header controls touch-accessible when their menu opens and closes", async () => {
    renderProjectRow();
    const trigger = screen.getByRole("button", {
      name: "Test project actions",
    });
    const actions = trigger.closest(".bb-sidebar-hover-actions");
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe(
      "always",
    );
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await screen.findByRole("menu");
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe(
      "always",
    );
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBe(
      "true",
    );

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe(
      "always",
    );
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBeNull();
  });

  it("places the project disclosure after its label and keeps root threads flush", () => {
    const result = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [makeThread()],
    });

    const disclosure = screen.getByRole("button", {
      name: "Collapse Test project section",
    });
    const label = screen.getByTitle("Test project");
    const threadLink = result.container.querySelector(
      '[data-sidebar-thread-id="thr_test"]',
    );
    const projectGroup = result.container.querySelector(
      "[data-sidebar-sticky-project-item]",
    );

    expect(
      label.compareDocumentPosition(disclosure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      (threadLink?.parentElement as HTMLElement | null)?.style.paddingLeft,
    ).toBe("8px");
    expect(projectGroup?.getAttribute("data-sidebar-project-id")).toBe(
      "proj_test",
    );
    expect(projectGroup?.hasAttribute("data-sidebar-section-id")).toBe(false);
  });

  it("uses shared runtime precedence when a top-level section is collapsed", () => {
    const store = createStore();
    const queryClient = new QueryClient();
    const sectionId = "sec_active";
    const activeThread = makeThread({
      id: "thr_section_active",
      sectionId,
      status: "active",
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      activity: {
        activeWorkflowCount: 0,
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activePlanModeCount: 1,
        activeGoalCount: 1,
      },
    });

    render(
      <TooltipProvider>
        <Provider store={store}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <ChronologicalSectionThreadSections
                threadListState={{ status: "ready", threads: [activeThread] }}
                compareThreadsForSection={() => () => 0}
                sections={[{ id: sectionId, name: "Active work" }]}
                collapsedThreadIds={new Set()}
                onToggleThreadCollapsed={vi.fn()}
                topLevelSectionOrder={[
                  buildSidebarEntitySectionId("section", sectionId),
                ]}
                onTopLevelSectionOrderChange={vi.fn()}
                pinnedReorderPending={false}
                pinnedThreads={[]}
                onReorderPinnedThread={vi.fn()}
                builtInSections={{
                  collapsedSectionIds: new Set(),
                  onToggleCollapsed: vi.fn(),
                  pinned: { label: "Pinned", content: null },
                  threads: { label: "Threads" },
                }}
              />
            </MemoryRouter>
          </QueryClientProvider>
        </Provider>
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Active work section" }),
    );

    expect(
      screen
        .getByTitle("Active work")
        .closest("[data-sidebar-sticky-group]")
        ?.getAttribute("data-sidebar-section-id"),
    ).toBe(sectionId);

    expect(screen.queryByText("Test thread")).toBeNull();
    expect(screen.getAllByLabelText("Plan mode active")).not.toHaveLength(0);
    expectCollapsedActivityAtSidebarEdge("Plan mode active");
    expect(screen.queryByLabelText("Thread working")).toBeNull();
    expect(screen.queryByLabelText("Goal active")).toBeNull();
  });

  it("shows a working draft before Plan for a collapsed section", () => {
    const store = createStore();
    const queryClient = new QueryClient();
    const sectionId = "sec_draft";
    const activeThread = makeThread({
      id: "thr_section_draft",
      sectionId,
      activity: {
        activeWorkflowCount: 0,
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activePlanModeCount: 1,
        activeGoalCount: 1,
      },
    });
    mockDraftThreadIds.current = new Set([activeThread.id]);

    render(
      <TooltipProvider>
        <Provider store={store}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <ChronologicalSectionThreadSections
                threadListState={{ status: "ready", threads: [activeThread] }}
                compareThreadsForSection={() => () => 0}
                sections={[{ id: sectionId, name: "Draft work" }]}
                collapsedThreadIds={new Set()}
                onToggleThreadCollapsed={vi.fn()}
                topLevelSectionOrder={[
                  buildSidebarEntitySectionId("section", sectionId),
                ]}
                onTopLevelSectionOrderChange={vi.fn()}
                pinnedReorderPending={false}
                pinnedThreads={[]}
                onReorderPinnedThread={vi.fn()}
                builtInSections={{
                  collapsedSectionIds: new Set(),
                  onToggleCollapsed: vi.fn(),
                  pinned: { label: "Pinned", content: null },
                  threads: { label: "Threads" },
                }}
              />
            </MemoryRouter>
          </QueryClientProvider>
        </Provider>
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Draft work section" }),
    );

    expect(
      screen.getAllByLabelText("Thread working with unsubmitted draft"),
    ).not.toHaveLength(0);
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });

  it("surfaces named activity when the project is collapsed", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            activity: {
              activeWorkflowCount: 0,
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
              activePlanModeCount: 0,
              activeGoalCount: 1,
            },
          }),
        ],
      },
      false,
      true,
    );

    expect(screen.queryByText("Test thread")).toBeNull();
    expect(screen.getAllByLabelText("Goal active")).not.toHaveLength(0);
    expectCollapsedActivityAtSidebarEdge("Goal active");
  });

  it("shows unread success before an idle draft for a collapsed project", () => {
    mockDraftThreadIds.current = new Set(["thr_project_draft"]);
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_project_draft",
            lastReadAt: 100,
            latestAttentionAt: 200,
          }),
        ],
      },
      false,
      true,
    );

    expect(
      screen.getAllByLabelText("Unread thread succeeded"),
    ).not.toHaveLength(0);
    expect(screen.queryByLabelText("Thread has unsubmitted draft")).toBeNull();
  });

  it("excludes hidden side-chat activity from a collapsed project", () => {
    mockDraftThreadIds.current = new Set(["thr_side_chat"]);
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_side_chat",
            visibility: "hidden",
            activity: {
              activeWorkflowCount: 0,
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
              activePlanModeCount: 1,
              activeGoalCount: 0,
            },
          }),
        ],
      },
      false,
      true,
    );

    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
    expect(document.querySelector('[data-icon="Edit"]')).toBeNull();
  });
});
