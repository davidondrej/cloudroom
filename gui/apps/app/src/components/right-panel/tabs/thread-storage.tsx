import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ThreadOpenFile, WorkspaceFile } from "@cloudroom/server-contract";
import { createFilePreviewLineRange } from "@cloudroom/client-core";
import { Button } from "@cloudroom/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { EmptyState } from "@cloudroom/shared-ui/empty-state";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type { FixedPanelTab } from "@/components/right-panel/store/tab-model";
import type { OpenSecondaryPanelTabRequest } from "@/components/right-panel/store/use-panel-tabs";
import { useThreadStorageFiles } from "@/hooks/queries/thread-queries";
import {
  describeLifecycleError,
  formatLifecycleErrorDescription,
} from "@/lib/lifecycle-errors";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { createRetryingModuleLoader } from "@/lib/plugin-frontend-lazy";
import { sdk } from "@/lib/sdk";
import { DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS } from "@/lib/thread-storage-files";
import { wsManager } from "@/lib/ws";
import type { ThreadStorageTreeModel } from "./ThreadStorageFileTree";

const EMPTY_FILES: readonly WorkspaceFile[] = [];

type FileTreeModule = typeof import("./ThreadStorageFileTree");

const loadFileTreeModule = createRetryingModuleLoader<FileTreeModule>(
  () => import("./ThreadStorageFileTree"),
);

const LazyFileTreeChunk = lazy(() =>
  loadFileTreeModule().then(({ ThreadStorageFileTree }) => ({
    default: ThreadStorageFileTree,
  })),
);

export type ThreadStoragePathSelectHandler = (path: string) => void;

export interface ThreadStorageBrowserController {
  closeSearch: () => void;
  filteredFiles: readonly WorkspaceFile[];
  isSearchOpen: boolean;
  loadedFiles: readonly WorkspaceFile[];
  model: ThreadStorageTreeModel | null;
  openSearch: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

function collectParentDirectories(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix += `${parts[i]}/`;
      dirs.add(prefix);
    }
  }
  return Array.from(dirs);
}

export function useThreadStorageBrowser({
  files,
  onSelectPath,
  selectedPath,
}: {
  files: readonly WorkspaceFile[] | undefined;
  onSelectPath: ThreadStoragePathSelectHandler;
  selectedPath: string | null;
}): ThreadStorageBrowserController {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [model, setModel] = useState<ThreadStorageTreeModel | null>(null);

  const loadedFiles = files ?? EMPTY_FILES;
  const trimmedQuery = searchQuery.trim().toLowerCase();

  const filteredFiles = useMemo(
    () =>
      trimmedQuery
        ? loadedFiles.filter((f) => f.path.toLowerCase().includes(trimmedQuery))
        : loadedFiles,
    [loadedFiles, trimmedQuery],
  );

  const filePaths = useMemo(
    () => filteredFiles.map((f) => f.path),
    [filteredFiles],
  );
  const filePathSet = useMemo(() => new Set(filePaths), [filePaths]);

  const pathSetRef = useRef<ReadonlySet<string>>(filePathSet);
  const onSelectRef = useRef(onSelectPath);
  const syncingSelectionRef = useRef(false);

  useLayoutEffect(() => {
    pathSetRef.current = filePathSet;
    onSelectRef.current = onSelectPath;
  });

  const onTreeSelect = useCallback((selected: readonly string[]) => {
    if (syncingSelectionRef.current) return;
    const next = selected[0];
    if (next && pathSetRef.current.has(next)) {
      onSelectRef.current(next);
    }
  }, []);

  const hasFiles = loadedFiles.length > 0;
  useEffect(() => {
    if (!hasFiles) return;
    let disposed = false;
    let instance: ThreadStorageTreeModel | null = null;

    void loadFileTreeModule().then(
      ({ createThreadStorageTreeModel }) => {
        if (disposed) return;
        instance = createThreadStorageTreeModel(onTreeSelect);
        setModel(instance);
      },
      (err: unknown) => {
        if (disposed) return;
        console.warn(
          `thread storage tree load failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );

    return () => {
      disposed = true;
      instance?.cleanUp();
      setModel(null);
    };
  }, [hasFiles, onTreeSelect]);

  const expandedDirs = useMemo(
    () => (trimmedQuery ? collectParentDirectories(filePaths) : []),
    [filePaths, trimmedQuery],
  );

  useEffect(() => {
    model?.resetPaths(filePaths, { initialExpandedPaths: expandedDirs });
  }, [expandedDirs, filePaths, model]);

  useEffect(() => {
    if (!model) return;
    const current = model.getSelectedPaths();
    const visible = selectedPath !== null && filePathSet.has(selectedPath);

    if (
      visible
        ? current.length === 1 && current[0] === selectedPath
        : current.length === 0
    ) {
      return;
    }

    syncingSelectionRef.current = true;
    try {
      for (const path of current) {
        if (visible && path === selectedPath) continue;
        model.getItem(path)?.deselect();
      }
      if (visible) model.getItem(selectedPath)?.select();
    } finally {
      syncingSelectionRef.current = false;
    }
  }, [filePathSet, model, selectedPath]);

  const openSearch = useCallback(() => setIsSearchOpen(true), []);
  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
  }, []);

  return {
    closeSearch,
    filteredFiles,
    isSearchOpen,
    loadedFiles,
    model,
    openSearch,
    searchQuery,
    setSearchQuery,
  };
}

export function ThreadStorageBrowser({
  controller,
  filesError,
  isFilesLoading,
}: {
  controller: ThreadStorageBrowserController;
  filesError?: Error | null;
  isFilesLoading: boolean;
}) {
  const {
    closeSearch,
    filteredFiles,
    isSearchOpen,
    loadedFiles,
    model,
    searchQuery,
    setSearchQuery,
  } = controller;
  const inputRef = useRef<HTMLInputElement>(null);
  const isCoarse = usePointerCoarse();

  useEffect(() => {
    if (isSearchOpen && !isCoarse) inputRef.current?.focus();
  }, [isCoarse, isSearchOpen]);

  const loadingState = (
    <EmptyState
      icon="Spinner"
      message="Loading files..."
      iconClassName="animate-spin"
    />
  );

  let body: ReactNode;
  if (filesError) {
    const lifecycle = describeLifecycleError({
      error: filesError,
      operation: "load_thread_storage",
    });
    const message =
      (lifecycle ? formatLifecycleErrorDescription(lifecycle) : null) ??
      getMutationErrorMessage({
        error: filesError,
        fallbackMessage: "Failed to load thread storage",
        lifecycleOperation: "load_thread_storage",
      });
    body = <EmptyState message={message} messageClassName="text-destructive" />;
  } else if (isFilesLoading && loadedFiles.length === 0) {
    body = loadingState;
  } else if (loadedFiles.length === 0) {
    body = <EmptyState message="No files yet." />;
  } else if (filteredFiles.length === 0) {
    body = <EmptyState message="No files match search." />;
  } else if (model === null) {
    body = loadingState;
  } else {
    body = (
      <Suspense fallback={loadingState}>
        <LazyFileTreeChunk model={model} />
      </Suspense>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      {isSearchOpen ? (
        <div className="flex h-7 shrink-0 items-center gap-2 max-md:pointer-coarse:h-10">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="Search"
              className={cn(
                "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground",
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
              )}
            />
            <Input
              ref={inputRef}
              aria-label="Search files"
              className={cn(
                "h-7 pl-7 pr-2 focus-visible:ring-0 max-md:pointer-coarse:h-10",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
              placeholder="Search files"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
              "shrink-0 text-muted-foreground",
            )}
            aria-label="Close search"
            onClick={closeSearch}
          >
            <Icon name="X" />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

export function shouldLoadThreadStorageFileList({
  hasThread,
  isSecondaryPanelOpen,
  secondaryTabs,
}: {
  hasThread: boolean;
  isSecondaryPanelOpen: boolean;
  secondaryTabs: readonly Pick<FixedPanelTab, "kind">[];
}): boolean {
  if (!hasThread) return false;
  return (
    isSecondaryPanelOpen ||
    secondaryTabs.some((tab) => tab.kind === "thread-storage-file-preview")
  );
}

export function useThreadStorageViewer({
  fileListEnabled = true,
  threadId,
}: {
  fileListEnabled?: boolean;
  threadId?: string;
}) {
  const {
    data: threadStorageFiles,
    isLoading: isThreadStorageFilesLoading,
    error: threadStorageFilesError,
    refetch: refetchThreadStorageFiles,
  } = useThreadStorageFiles(
    threadId ?? "",
    DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
    { enabled: Boolean(threadId) && fileListEnabled },
  );

  const checkThreadStorageFileExists = useCallback(
    async (path: string): Promise<boolean> => {
      if (!threadId) return false;
      const result = await sdk.threads.storageFiles({
        limit: "1",
        query: path,
        threadId,
      });
      return result.files.some((file) => file.path === path);
    },
    [threadId],
  );

  return {
    checkThreadStorageFileExists,
    isThreadStorageFilesLoading,
    threadStorageFilesError,
    threadStorageFiles,
    threadStorageRootPath: threadStorageFiles?.storageRootPath ?? null,
    refetchThreadStorageFiles,
  };
}

function openSignalToTabRequest(
  file: ThreadOpenFile,
): OpenSecondaryPanelTabRequest {
  const lineRange =
    file.lineNumber === null
      ? null
      : createFilePreviewLineRange({
          startLineNumber: file.lineNumber,
          endLineNumber: file.lineNumber,
        });

  if (file.source === "workspace") {
    return {
      kind: "workspace-file-preview",
      tab: {
        lineRange,
        path: file.path,
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    };
  }

  return {
    kind: "thread-storage-file-preview",
    tab: { lineRange, path: file.path },
  };
}

export function useThreadOpenFileSignal({
  threadId,
  environmentId,
  openTab,
}: {
  threadId: string | null | undefined;
  environmentId: string | null | undefined;
  openTab: (request: OpenSecondaryPanelTabRequest) => void;
}): void {
  useEffect(() => {
    if (threadId == null || environmentId === undefined) return;
    const drain = () => {
      const pending = wsManager.consumePendingOpenFile(threadId);
      if (pending) openTab(openSignalToTabRequest(pending));
    };
    drain();
    return wsManager.onThreadOpen((signal) => {
      if (signal.threadId === threadId) drain();
    });
  }, [environmentId, openTab, threadId]);
}
