// @vitest-environment jsdom

import { createDeferredPromise } from "@cloudroom/test-helpers";
import { MemoryRouter } from "react-router";
import {
  useChildThreads,
  useThreadMentionCandidates,
} from "@/hooks/queries/thread-queries";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Thread } from "@cloudroom/domain";
import { makeThread as makeThreadFixture } from "@cloudroom/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import { getThreadRoutePath } from "@/lib/route-paths";
import {
  ThreadActionsProvider,
  useThreadActions,
} from "./ThreadActionsProvider";

const mocks = vi.hoisted(() => ({
  closePanesForThreads: vi.fn(),
  dialogOnClose: vi.fn(),
  dialogOnOpen: vi.fn(),
  dialogOnOpenChange: vi.fn(),
  mutation: vi.fn(),
  navigate: vi.fn(),
  viewedThreadId: null as string | null,
}));

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => mocks.navigate,
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useSetAtom: () => mocks.closePanesForThreads,
  };
});

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/mutations/thread-state-mutations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/mutations/thread-state-mutations")
    >();
  return {
    ...actual,
    useDeleteThread: () => ({ isPending: false, mutate: mocks.mutation }),
    useMarkThreadRead: () => ({ mutate: mocks.mutation }),
    useMarkThreadUnread: () => ({ mutate: mocks.mutation }),
    usePinThread: () => ({ mutate: mocks.mutation }),
    useUnpinThread: () => ({ mutate: mocks.mutation }),
    useUpdateThread: () => ({ isPending: false, mutate: mocks.mutation }),
  };
});

const appCommandHandlers = vi.hoisted(
  () => new Map<string, { handler: () => boolean; enabled: boolean }>(),
);
vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandHandler: (
    command: string,
    handler: () => boolean,
    _priority: number,
    enabled = true,
  ) => appCommandHandlers.set(command, { handler, enabled }),
  useAppCommandShortcut: () => null,
}));
vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      archiveAll: vi.fn(),
      childSummary: vi.fn(),
      unarchive: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useDialogState", () => ({
  useDialogState: () => ({
    onClose: mocks.dialogOnClose,
    onOpen: mocks.dialogOnOpen,
    onOpenChange: mocks.dialogOnOpenChange,
    target: null,
  }),
}));

vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ threadId: mocks.viewedThreadId }),
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    createdAt: 1,
    id: "thr_parent",
    lastReadAt: null,
    latestAttentionAt: 1,
    title: "Investigate archive behavior",
    titleFallback: null,
    updatedAt: 1,
    ...overrides,
  });
}

function ArchiveButton({ thread }: { thread: Thread }) {
  const { archiveThreadAndChildren } = useThreadActions();
  return (
    <button type="button" onClick={() => archiveThreadAndChildren(thread)}>
      Archive
    </button>
  );
}

function renderProvider(children: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ThreadActionsProvider>{children}</ThreadActionsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  vi.mocked(sdk.threads.archiveAll).mockResolvedValue({
    archivedThreadIds: ["thr_parent", "thr_child"],
    ok: true,
  });
  vi.mocked(sdk.threads.unarchive).mockResolvedValue({
    ok: true,
    unarchivedThreadIds: [],
  });
  vi.mocked(sdk.threads.childSummary).mockResolvedValue({
    nonDeletedChildCount: 1,
    runningThreadCount: 0,
  });
  mocks.closePanesForThreads.mockReturnValue({
    focusedRoute: null,
    removedAny: false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.viewedThreadId = null;
});

function SidebarRow({ id, child = false }: { id: string; child?: boolean }) {
  return (
    <a
      data-sidebar-thread-shortcut-target=""
      data-sidebar-thread-id={id}
      data-sidebar-project-id="p1"
      data-sidebar-thread-child={child ? "" : undefined}
    >
      {id}
    </a>
  );
}

describe("ThreadActionsProvider archive navigation", () => {
  async function archiveAndExpect(archivedId: string, expectedId: string) {
    mocks.viewedThreadId = archivedId;
    vi.mocked(sdk.threads.archiveAll).mockResolvedValue({
      archivedThreadIds: [archivedId],
      ok: true,
    });
    renderProvider(
      <>
        <div data-sidebar-sticky-section="">
          <SidebarRow id="thr_top_a" />
          <SidebarRow id="thr_child_a" child />
          <SidebarRow id="thr_child_b" child />
          <SidebarRow id="thr_top_b" />
          <SidebarRow id="thr_top_c" />
          <SidebarRow id="thr_child_c" child />
        </div>
        <ArchiveButton
          thread={makeThread({ id: archivedId, projectId: "p1" })}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(mocks.navigate).toHaveBeenCalledWith(
      getThreadRoutePath({ projectId: "p1", threadId: expectedId }),
    );
    await vi.waitFor(() => {
      expect(appToast.success).toHaveBeenCalledTimes(1);
    });
  }

  it("lands on the next top-level thread right below, not the last one", async () => {
    await archiveAndExpect("thr_top_a", "thr_top_b");
  });

  it("skips subagents when it looks below", async () => {
    await archiveAndExpect("thr_child_a", "thr_top_b");
  });

  it("goes up to the nearest top-level thread when it was the last one", async () => {
    await archiveAndExpect("thr_top_c", "thr_top_b");
  });
});

describe("ThreadActionsProvider archive feedback", () => {
  it("shows one archive toast whose Undo restores the parent and children", async () => {
    renderProvider(<ArchiveButton thread={makeThread()} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await vi.waitFor(() => {
      expect(appToast.success).toHaveBeenCalledTimes(1);
    });
    expect(appToast.message).not.toHaveBeenCalled();
    expect(appToast.loading).not.toHaveBeenCalled();
    expect(vi.mocked(appToast.success).mock.calls[0]?.[0]).toBe("Archived");
    const toastOptions = vi.mocked(appToast.success).mock.calls[0]?.[1];
    expect(toastOptions).toMatchObject({
      cancel: { label: "Undo" },
      duration: 8_000,
      id: "thread-archived-thr_parent",
    });
    expect(toastOptions?.description).toBeDefined();
    expect(toastOptions?.action).toBeUndefined();

    const undoAction = toastOptions?.cancel;
    if (undoAction === undefined) {
      throw new Error("Expected archive toast to provide Undo");
    }
    render(<button onClick={undoAction.onClick}>Run undo</button>);
    fireEvent.click(screen.getByRole("button", { name: "Run undo" }));

    await vi.waitFor(() => {
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(2);
    });
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(1, {
      keepParent: true,
      threadId: "thr_parent",
    });
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(2, {
      keepParent: true,
      threadId: "thr_child",
    });
  });
});

describe("Cloud archive", () => {
  const cloud = makeThread({ executionTarget: "cloud" });
  function clickArchive() {
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  }
  function undo() {
    const action = vi.mocked(appToast.loading).mock.calls.at(-1)?.[1]?.cancel;
    if (!action) throw new Error("Missing pending Undo");
    render(<button onClick={action.onClick}>Undo archive</button>);
    fireEvent.click(screen.getByRole("button", { name: "Undo archive" }));
  }

  it("aborts a pending check and ignores its late answer", async () => {
    const check = createDeferredPromise<Response>();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) => check.promise,
    );
    vi.stubGlobal("fetch", fetch);
    renderProvider(<ArchiveButton thread={cloud} />);
    clickArchive();
    undo();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => check.resolve(Response.json({ running: [] })));
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
    expect(appToast.error).not.toHaveBeenCalled();
  });

  it("offers Retry, Cancel and explicit archive when Cloud cannot answer", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ running: null }))
      .mockResolvedValueOnce(Response.json({ running: ["child"] }))
      .mockResolvedValueOnce(Response.json({ running: null }));
    vi.stubGlobal("fetch", fetch);
    renderProvider(<ArchiveButton thread={cloud} />);
    clickArchive();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Archive running thread?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
    clickArchive();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Archive",
      }),
    );
    await vi.waitFor(() =>
      expect(sdk.threads.archiveAll).toHaveBeenCalledTimes(1),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("confirms on a second archive shortcut, but not in the first 400ms", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ running: ["child"] })),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    renderProvider(<ArchiveButton thread={cloud} />);
    clickArchive();
    await screen.findByRole("dialog");
    const shortcut = appCommandHandlers.get("thread.archive")!;
    expect(shortcut.enabled).toBe(true);
    await act(async () => void expect(shortcut.handler()).toBe(true));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
    now.mockReturnValue(1_400);
    act(() => void shortcut.handler());
    await vi.waitFor(() =>
      expect(sdk.threads.archiveAll).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    now.mockRestore();
  });

  it("checks the latest sidebar status of an unopened Local parent with a Cloud child", async () => {
    const parent = makeThread();
    const child = makeThread({
      id: "child",
      parentThreadId: parent.id,
      executionTarget: "cloud",
    });
    const sidebar = (root: Thread) => ({
      projects: [{ threads: [root, child] }],
      personalProject: { threads: [] },
      sections: [],
    });
    queryClient.setQueryData(sidebarNavigationQueryKey(), sidebar(parent));
    const check = createDeferredPromise<Response>();
    vi.stubGlobal("fetch", () => check.promise);
    renderProvider(<ArchiveButton thread={parent} />);
    clickArchive();
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      sidebar({ ...parent, status: "active", updatedAt: 2 }),
    );
    await act(async () => check.resolve(Response.json({ running: [] })));
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Archive",
    });
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
  });

  it("keeps a child hidden in visible lists when its parent's overlapping archive is undone", async () => {
    const check = createDeferredPromise<Response>();
    vi.stubGlobal("fetch", () => check.promise);
    const child = makeThread({
      id: "child",
      parentThreadId: cloud.id,
      executionTarget: "cloud",
    });
    queryClient.setQueryData(sidebarNavigationQueryKey(), {
      projects: [{ threads: [cloud, child] }],
      personalProject: { threads: [] },
      sections: [],
    });
    function Lists() {
      const children =
        useChildThreads({ parentThreadId: cloud.id, enabled: true }).data ?? [];
      const mentions = useThreadMentionCandidates({ enabled: true }).data ?? [];
      return (
        <output>
          {children.length} children, {mentions.length} mentions
        </output>
      );
    }
    renderProvider(
      <>
        <ArchiveButton thread={child} />
        <ArchiveButton thread={cloud} />
        <Lists />
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: "Archive" });
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(screen.getByText("0 children, 0 mentions")).toBeTruthy();
    const pending = vi
      .mocked(appToast.loading)
      .mock.calls.map(([, options]) => options?.cancel?.onClick);
    render(
      <>
        <button onClick={pending[1]}>Undo parent</button>
        <button onClick={pending[0]}>Undo child</button>
      </>,
    );
    fireEvent.click(screen.getByText("Undo parent"));
    expect(screen.getByText("0 children, 1 mentions")).toBeTruthy();
    fireEvent.click(screen.getByText("Undo child"));
    expect(screen.getByText("1 children, 2 mentions")).toBeTruthy();
    await act(async () => check.resolve(Response.json({ running: [] })));
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "honors Undo during submission, including a rejected archive (success=%s)",
    async (succeeds) => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(Response.json({ running: [] })),
      );
      const commit =
        createDeferredPromise<
          Awaited<ReturnType<typeof sdk.threads.archiveAll>>
        >();
      vi.mocked(sdk.threads.archiveAll).mockReturnValueOnce(commit.promise);
      renderProvider(<ArchiveButton thread={cloud} />);
      clickArchive();
      await vi.waitFor(() => expect(sdk.threads.archiveAll).toHaveBeenCalled());
      undo();
      await act(async () =>
        succeeds
          ? commit.resolve({ ok: true, archivedThreadIds: ["actual-child"] })
          : commit.reject(new Error("failed")),
      );
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(succeeds ? 1 : 0);
      if (succeeds)
        expect(sdk.threads.unarchive).toHaveBeenCalledWith({
          threadId: "actual-child",
          keepParent: true,
        });
      expect(appToast.success).not.toHaveBeenCalled();
      expect(appToast.error).not.toHaveBeenCalled();
    },
  );
});
