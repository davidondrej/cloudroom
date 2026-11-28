import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import { useLocation } from "react-router";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import type { SidebarBootstrapResponse } from "@cloudroom/server-contract";
import { makeThreadListEntry } from "../../../.ladle/story-fixtures";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import {
  ThreadTitleMentionResourcesProvider,
  useSidebarThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  listSidebarNavigationThreads,
  updateCachedThreadListPendingInteractionState,
} from "@/hooks/cache-owners/query-cache";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { QuickCreateProjectProvider } from "@/hooks/useQuickCreateProject";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { AppSidebar } from "./AppSidebar";
import { collapsedThreadIdsAtom } from "./sidebarCollapsedAtoms";

export default {
  title: "Sidebar/Needs you",
};

function thread(
  id: string,
  projectId: string,
  title: string,
  at: number,
  extra: Parameters<typeof makeThreadListEntry>[0] = {},
) {
  return makeThreadListEntry({
    id,
    projectId,
    title,
    titleFallback: title,
    latestAttentionAt: at,
    createdAt: at,
    updatedAt: at,
    lastReadAt: at,
    ...extra,
  });
}

const ATLAS_TITLES = [
  "Tidy onboarding copy",
  "Add export to CSV",
  "Fix flaky upload test",
  "Rename settings keys",
  "Speed up search index",
  "Audit color tokens",
  "Draft release notes",
  "Trim bundle size",
  "Retry failed webhooks",
];
const HARBOR_TITLES = [
  "Map shipping zones",
  "Clean up stale branches",
  "Cache rate lookups",
  "Add dark mode toggle",
  "Write migration guide",
  "Profile cold start",
  "Fix date picker focus",
];

/** Sanitized fixtures: two projects plus Personal, enough rows that the thread list scrolls. */
const navigation: SidebarBootstrapResponse = makeSidebarBootstrapResponse({
  projects: [
    makeProjectWithThreadsResponse({
      id: "proj_atlas",
      name: "atlas",
      threads: [
        thread("thr_parent", "proj_atlas", "Plan the v2 launch", 500),
        thread("thr_child", "proj_atlas", "Check launch checklist", 499, {
          parentThreadId: "thr_parent",
        }),
        ...ATLAS_TITLES.map((title, index) =>
          thread(`thr_atlas_${index}`, "proj_atlas", title, 400 - index),
        ),
      ],
    }),
    makeProjectWithThreadsResponse({
      id: "proj_harbor",
      name: "harbor",
      threads: HARBOR_TITLES.map((title, index) =>
        thread(`thr_harbor_${index}`, "proj_harbor", title, 300 - index),
      ),
    }),
  ],
  personalProject: makeProjectWithThreadsResponse({
    id: PERSONAL_PROJECT_ID,
    kind: "personal",
    name: "Personal",
    threads: [
      thread("thr_personal_0", PERSONAL_PROJECT_ID, "Plan weekend trip", 200),
      thread("thr_personal_1", PERSONAL_PROJECT_ID, "Sort photo backups", 199),
    ],
  }),
});

declare global {
  interface Window {
    /** Story controls for driving the fixture from a headless browser. */
    __needsYouStory?: {
      setPending: (threadId: string, pending: boolean) => void;
    };
  }
}

function StoryControls() {
  const queryClient = useQueryClient();
  const location = useLocation();
  useEffect(() => {
    window.__needsYouStory = {
      // The same cache patch the thread list's interactions-changed message applies.
      setPending: (threadId, pending) =>
        updateCachedThreadListPendingInteractionState(
          queryClient,
          threadId,
          pending,
        ),
    };
    return () => {
      delete window.__needsYouStory;
    };
  }, [queryClient]);
  const threads = listSidebarNavigationThreads(
    useSidebarNavigation().data ?? navigation,
  );
  const markFirst = (count: number) =>
    threads.forEach((thread, index) =>
      updateCachedThreadListPendingInteractionState(
        queryClient,
        thread.id,
        index < count,
      ),
    );
  // The app shell sizes the sidebar from this variable (100dvh by default).
  const setShellHeight = (height: string | null) =>
    height === null
      ? document.body.style.removeProperty("--room-shell-height")
      : document.body.style.setProperty("--room-shell-height", height);
  const button =
    "rounded-md border border-border px-2 py-1 text-foreground hover:bg-state-hover";
  return (
    <main className="flex-1 space-y-4 overflow-auto p-6 text-sm text-muted-foreground">
      <p>
        Route: <output data-testid="story-location">{location.pathname}</output>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        Pending:
        {[0, 4, 8, threads.length].map((count) => (
          <button
            key={count}
            type="button"
            className={button}
            onClick={() => markFirst(count)}
          >
            {count === 0 ? "None" : count === threads.length ? "All" : count}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        Window height:
        {[null, "480px", "360px"].map((height) => (
          <button
            key={height ?? "full"}
            type="button"
            className={button}
            onClick={() => setShellHeight(height)}
          >
            {height ?? "Full"}
          </button>
        ))}
      </div>
      <fieldset className="space-y-1">
        <legend className="mb-2 font-medium text-foreground">
          Pending request (simulates the live interactions-changed update)
        </legend>
        {threads.map((thread) => (
          <label key={thread.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={thread.hasPendingInteraction}
              onChange={(event) =>
                updateCachedThreadListPendingInteractionState(
                  queryClient,
                  thread.id,
                  event.target.checked,
                )
              }
            />
            {thread.parentThreadId ? "↳ " : ""}
            {thread.title}
          </label>
        ))}
      </fieldset>
    </main>
  );
}

/** Project names for row labels, wired the way AppLayout wraps the sidebar. */
function TitleResources({ children }: { children: ReactNode }) {
  const resources = useSidebarThreadTitleMentionResources(navigation);
  return (
    <ThreadTitleMentionResourcesProvider {...resources}>
      {children}
    </ThreadTitleMentionResourcesProvider>
  );
}

export const InAppSidebar = () => {
  const queryClient = useQueryClient();
  const store = useStore();
  // Seed once, before the sidebar's first render.
  useState(() => {
    queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
    // The parent starts folded, so its pending child is hidden in the list.
    store.set(collapsedThreadIdsAtom, ["thr_parent"]);
    return null;
  });
  return (
    <AppCommandProvider>
      <ProjectActionsProvider>
        <TitleResources>
          <ThreadActionsProvider>
            <QuickCreateProjectProvider>
              <SidebarProvider className="h-(--room-shell-height) min-h-0">
                <AppSidebar
                  onResizeMouseDown={() => {}}
                  isResizing={false}
                  settingsRoutePath="/settings"
                />
                <StoryControls />
              </SidebarProvider>
            </QuickCreateProjectProvider>
          </ThreadActionsProvider>
        </TitleResources>
      </ProjectActionsProvider>
    </AppCommandProvider>
  );
};
